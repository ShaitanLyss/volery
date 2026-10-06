---
paths:
  - "src-tauri/src/ask.rs"
  - "src/lib/asking.ts"
  - "src/lib/Ask.svelte"
  - "src/lib/Gallery.svelte"
  - "src/lib/zoom.ts"
  # Half of "a question can show you a file" lives in the shared viewer; the
  # other half of it is finding.md's.
  - "src/lib/Leaf.svelte"
---

# The ask_user MCP server, and several questions in one call

### The `ask_user` MCP server (`src-tauri/src/ask.rs`)

`AskUserQuestion` and `ExitPlanMode` do not exist in headless mode, so Skein hosts its own
tool over a loopback HTTP MCP endpoint and injects it into every spawn via `--mcp-config`.
The URL carries the conversation id (`/mcp/<id>`), so a call arrives already addressed to a
card with no correlation logic. A `tools/call` **parks the HTTP request** until the UI
answers (10 min timeout), which is what makes the agent genuinely stopped rather than idle,
and what lets the turn resume in place. One thread per request, or one waiting card would
stall every other card's MCP traffic.

**Parking is worth nothing unless the client is still listening**, and by default it is not.
Probed 2026-08-14 against claude 2.1.232 with `tools/probe-ask.ts`, which parks a call and
answers it late: the CLI **aborts the HTTP request at 60.02s** and hands the model
`is_error: true, "The operation timed out."`. So the whole feature failed exactly where it
was meant to work — the question was drawn, an option was clicked well inside the ten
minutes, and the answer went to a request nobody was reading while the agent had already
given up and moved on. It looked like a lost answer and was a lost *listener*.
`supervisor.rs` therefore spawns with `MCP_TOOL_TIMEOUT` set from
`ask::client_timeout_ms()`; the same probe with it set parked 90s, was never aborted, and
resumed the turn in place.

**And then it died at five minutes anyway, because there are two watchdogs and the variable
moves one.** Reported 2026-08-19 and read straight out of the 2.1.232 binary rather than
probed, since six minutes of parking per attempt is a slow way to ask: every `tools/call`
arms a hard deadline — the one `MCP_TOOL_TIMEOUT` sets — *and* an idle deadline that fires
when a call has gone that long with neither a response nor a progress notification. The idle
default is chosen by transport: 1800s for `stdio`, **300s for `http`**, which is what this
server is. It is polled on a 30s interval, so the question was abandoned at the first tick
past five minutes with `"sent no response or progress for 300s; aborting"` — on a card whose
own clock had another five minutes left to run, which is exactly what it looked like from
the outside and looked nothing like a second timeout.

A progress notification resets it, and at the time there was nothing here to send one down:
this server answered POSTs and never opened a stream, which was most of why it was as small as
it is. So the fix was the per-server `timeout` field the CLI's own message names, and `ask::mcp_config`
is now the one place the `--mcp-config` is built so the number cannot be set in one of the two
places and not the other. It raises **both** deadlines — the idle one is
`max(transport default, timeout)` clamped to the hard one — which is why one number covers it.
The env var is kept as well; it costs nothing and is what an older build reads.

**And then it died at just under five minutes anyway, because the third clock is not the
CLI's.** Reported 2026-08-20: a question drawn, an option clicked, and the agent reading
`is_error: true, "The operation timed out."` — with both numbers above already set to eleven
minutes. The transcript put the abort 286s after the call, which is not 60s and not 300s, and
so matched nothing this file knew about.

That sentence is not in the CLI's JavaScript. `claude.exe` is a **Bun** single-file
executable, and "The operation timed out." is what *Bun's own* `fetch` says when its default
timeout fires. `tools/probe-park.ts` parks two requests and speaks on only one of them, and it
is the cheapest probe in the repo — no API turn, no `claude` at all:

```text
300.57s client /silent   THREW — TimeoutError: The operation timed out.
700.03s client /streamed DONE  — after 34 feeds, 20s apart
```

Five minutes, reproducible to the centisecond, and **nothing the CLI parses reaches it** —
not `MCP_TOOL_TIMEOUT`, not the per-server `timeout` field, not a flag. The number lives
inside the interpreter the client is compiled into. The 286s in the report is the same 300s
seen from the transcript, whose assistant timestamp is stamped before the message finished
streaming; the question was a long one, and that fourteen seconds is the whole discrepancy.

The second line is the fix. Bun's clock is reset by bytes rather than fixed to the request, so
a parked `tools/call` is now answered as `text/event-stream` — headers at once, a keep-alive
every 25s, the result as the last event — and MCP allows exactly that: the client's own POST
carries `Accept: application/json, text/event-stream`. Proved end to end with
`bun tools/probe-ask.ts 420 660000 --sse`: a real agent parked seven minutes across sixteen
keep-alives, was never aborted, and took the answer in place.

- **A keep-alive that is not on the wire is not a keep-alive.** The stream is written by hand
  onto `Request::into_writer` rather than handed to `Response::new` with an unknown length.
  tiny_http would stream it — `io::copy` into a `chunked_transfer::Encoder` — but the socket
  under it is a `BufWriter::with_capacity(1024, …)` and the encoder is built without
  `with_flush_after_write`, so a 90-byte keep-alive would sit in that buffer waiting for a
  tenth of a kilobyte of company while the clock it exists to reset ran out.
- **The keep-alive is a real `notifications/progress` when the client gives us a token to
  address it to**, which it always does — the SDK mints one whenever it registers an
  `onprogress`, probed as `progressToken: 2`. That matters because a progress notification
  resets the CLI's *idle* watchdog as well as feeding the socket, so one gesture answers two
  of the three clocks. Without a token it can only be an SSE comment, which every parser is
  required to ignore; the bytes are worth having alone, and inventing a token to carry them
  is not.
- **`_meta` is read here where `arguments` are not.** A progress token is transport, not
  vocabulary, so reading it in `dispatch` does not breach the bargain that Rust knows nothing
  about what a question *is*.
- **The abort is no longer invisible.** The blocking park could not tell a listener from a
  dropped connection, so past its own timeout a card went on showing a question the agent had
  abandoned. A failed write is now that fact, within 25s of it becoming true, and the question
  comes down.

The general shape, and it is the third time this file has learned it: **a deadline you have
moved is not the only deadline.** Something that stops early after you fixed it stopping
early is usually a second clock, not the first one misbehaving — and the third time, it was
not even a clock belonging to the program whose deadlines those were. Worth checking what your
client is *built* out of before concluding it is configured wrong: everything above about
`MCP_TOOL_TIMEOUT` and `timeout` is true, was necessary, and was not sufficient, because the
process reading our answer is a Bun runtime with opinions of its own.

- **The deadline scales with what is being asked**, and for most of this feature's life it did
  not. A flat ten minutes is generous for one yes/no and tight for a real review: a call
  carrying five questions, each with three or four options plus context and pros and cons,
  expired **with the user still reading it** — *"ah it timed out, ask again, I was almost
  done"* — and they answered all five immediately when re-asked, which is the evidence the
  clock was the only thing wrong (sink `d2adbf74`). One number that means two different things
  depending on the payload is a number that is wrong for one of them.

  `answer_window` is `ANSWER_BASE` (10m, what one bare question still gets) plus
  `ANSWER_PER_QUESTION` (3m) for each question past the first, plus `ANSWER_PER_OPTION` (20s)
  for every option drawn — **the options are in there because the reading is in them.** One
  decision between eight described alternatives is a longer read than four plain yes/nos, and
  `option_schema` asks for a `detail` line on each precisely so they are worth reading. The
  reported call comes out at 27 minutes; a three-way at 11, which is the point — nothing that
  was already long enough got longer.

  **`ANSWER_MAX` exists for a reason that is not patience.** `client_timeout_ms` is written
  into the card's `--mcp-config` and `MCP_TOOL_TIMEOUT` **at spawn**, so the client's deadline
  cannot scale with a call it has not received yet; it is set from the ceiling and every call
  has to fit under it, or the client gives up first and writes its own sentence instead of
  ours. Raising the client's number costs nothing on its own — a request nobody is feeding is
  already killed by Bun's 300s clock at `FEED_EVERY`.

  **And the timeout sentence now names its own duration, which is why `TIMED_OUT` is a
  function.** `asking.ts::UNANSWERED` matches a reply back off disk on the *opening* alone
  (`TIMED_OUT_OPENING`), so everything after it is free to vary; the wording it had while the
  deadline was ten minutes is kept over there beside the new one, because a transcript already
  on this disk carries it and will go on being folded.

  **The arithmetic is written twice, on purpose, and both copies are tested against the same
  table.** `Ask.svelte` draws a live countdown and it is real information rather than
  decoration — it is what tells you whether to keep reading or answer now — so the number it
  counts down to has to be the number the parking thread gives up on. Neither side can be
  handed the other's answer without a field on `ask:opened` and a matching read in
  `skein.svelte.ts`: the panel holds the *normalized* questions and `ask.rs` holds the raw
  arguments. So `asking.ts::answerWindow` and `ask::answer_window` share the constants and the
  counting rules, and `test/asking.test.ts` and `ask.rs`'s two window tests assert the same
  payloads. One suite going red alone is the mirror saying it has drifted.

  **What is still lost is the tail rather than the whole call, and it is not fixed here.**
  A deadline that expires takes every answer already given with it. Two things have since
  taken most of the weight off that — the deadline no longer runs down while you are typing,
  and expiring now *queues* the question rather than telling the agent to decide for itself
  (both below) — so what is left is narrower than it was: the question comes back whole, and
  the three answers already given have to be given again. Preserving the partial still needs
  the panel to push each answer to Rust as it is given — a new command, a call site in
  `skein.svelte.ts`, and a decision about what "three of five" reads as to an agent — which
  is a second piece of work rather than the other half of this one. Filed as its own sink
  item.
- **Ten minutes is also the floor when nobody is there**, and that is the answer
  rather than a bug. Reported 2026-08-20 by a card driven non-interactively: `ask_user` timed
  out on it twice, with no human anywhere near the wall. Both fired correctly. A tool whose
  whole purpose is to stop until a person decides has nothing better to do when there is no
  person, and guessing that there isn't one — because no window is focused, because the card
  is off screen — would answer for somebody who had merely gone to make coffee, which is the
  one wrong answer here. What it costs is the agent's window, which is the price of the
  question being real — and note that a headless card asking five questions now waits nearly
  half an hour for nobody, which is the one place the scaling is a cost rather than a fix.
  **The exception, and it is unfixed:** `ask:opened` is a fire-and-forget `emit`, so an ask
  raised before the front end has subscribed reaches nothing, cannot be drawn, and cannot be
  answered — ten minutes lost with certainty rather than by bad luck. Nothing holds a pending
  ask for a listener that arrives late. The window is small (`window::settle` shows `main`
  before any card can spawn) and a card roused at launch is the case to suspect.
- **The client is told to wait a minute longer than we do**, deliberately. Whichever side
  gives up first writes what the model reads, and ours is the sentence worth having — it
  says how long it waited and what to do next, where the client's says only that something
  timed out. `answer_window` stays the real deadline, and the minute of headroom is measured
  against `ANSWER_MAX` so it holds for the longest call anything can make.
- **The heartbeats are not a way out.** The CLI streams `tool_progress` events every 30s for
  a call in flight, but they do not extend either of its deadlines — the abort landed on the
  same tick as the 60s heartbeat, and what the idle watchdog wants is a notification coming
  the *other* way, from the server, which needs an SSE stream this one does not open.
- **Both numbers come from `client_timeout_ms`.** The env var and the config field are one
  value written twice, and a test in `ask.rs` asserts the config carries it — the failure it
  guards is silent, since a card with only the hard deadline raised looks completely correct
  for four and a half minutes.
- **The abort used to be invisible to the server, and now it is the thing that closes the
  question.** tiny_http's parked thread could not notice a dropped connection while it was
  doing nothing but wait; a thread that writes every 25s finds out by failing to.

Consequence for `classify.ts`: the `asked` ending is currently unreachable via tools, so
amber means *has been waiting too long* — urgency decays with neglect against a single
one-second `clock` rune shared by all cards.

#### Parking a call that is not a question (`Settle`, `ours`)

`ask_user` needed the parking, but nothing about the parking is specific to a question, and
`close` turned out to want it — a card naming a card it did not open now asks the user instead
of refusing (`.claude/rules/spawn.md`). Rather than a second listener with a second timeout and
a second set of keep-alive arithmetic, `park_and_stream` gained one parameter.

- **`settle` is what the answer *means*, and it is the caller's business rather than the
  transport's.** `ask_user` passes `None`: the reply to the agent is the answer, word for word,
  because the agent wrote the question and the words are the whole of what it wanted. `close`
  passes a closure — Skein composed that question, so the answer is a *decision*, and something
  has to turn it into the sentence the tool call returns **and do the closing on the way**. The
  boundary drawn is the same one this file draws everywhere else: `ask.rs` stays the transport
  and decides nothing about what any tool means.
- **It runs on the parking thread, after the answer and before the reply.** That is what makes
  a deferred close genuinely deferred rather than merely delayed, and it is also the last moment
  at which the wall is still current — see `spawn.md` for why `close` re-reads everything there
  rather than trusting what it saw ten minutes earlier.
- **Unanswered is passed as `None`, not as the sentence.** The timeout and the dismissal each
  have prose of their own (`timed_out`, `DISMISSED`), and a settle that had to match on Skein's
  own wording to find out whether a person decided anything would be the same duplicated-string
  bargain `answerNote` strikes with the CLI — worth it there, where there is no alternative, and
  gratuitous here, where a boolean crosses the same call.
- **The routing is in the dispatch arm, not in the roster chain.** `spawn::handle` deliberately
  no longer knows `CLOSE_TOOL`: the chain below has already committed to answering on the spot,
  so a tool that *might* park has to be reached before it. And the decision must be taken once —
  two readings of the same wall are two things to keep in step.

**`AskOpened::ours` is the other half, and it is about the transcript rather than the panel.**
The panel draws a Skein-composed question exactly as it draws an agent's; nothing there needs to
know. What needs to know is the fold. An agent's `ask_user` is half of an exchange — the call is
in the transcript, your reply is drawn under it, and `foldTranscript` finds both again off disk
because the call's tool name is `SKEIN_ASK_TOOL` (`history.ts`, the `asked` set). A question
Skein put up has no such call to hang off: what the agent's transcript holds is a `close` tool
call and its result, and the result is composed *from* the answer rather than being it. So
`answerAsk` pushing your click as a line of speech would draw a line on a live card that
vanishes the moment it is restored — precisely the seam `history.ts` exists to avoid, and the
reason `conversation.svelte.ts`'s `PendingAsk` carries the flag rather than the panel doing.
The same goes for the `NO_ANSWER_NOTE` on an ask that closed unanswered: the tool result says
"nobody answered, so it stays" in more useful words, and unlike the note it says them somewhere
a restart can reproduce.

The flag defaults to false on anything that does not set it, which is what keeps the control
surface's synthetic `ask:opened` (`control.svelte.ts`) meaning what it always meant.

#### A call whose text swallowed one of its own arguments

The client composes a `tools/call` by writing tagged parameters and parsing them back out,
and **a tag written without its namespace prefix is not a tag — it is more of the parameter
above it.** Reported 2026-09-02 (sink `b6a278c1`): an `ask_user` whose `options` was written
as a bare `<parameter name="options">` arrived with the whole literal
`</question> <parameter name="options">[{…}]` concatenated onto the end of `question`, and no
`options` at all. Three clickable buttons were drawn as a wall of raw JSON and XML.

Nothing at either end said so, and that is the part worth fixing rather than the mis-write
itself. The call succeeded, the question was answered, the turn resumed — so the agent had no
way to know it had degraded a click into a paragraph, and the user's only clue was that the
panel looked mad. It also leaks the client's own call syntax onto the wall.

`ask::swallowed` is the check and it is a **refusal**, which the signature earns: a text
declaring an argument that *is* on this tool's schema and *is not* in this call is not prose
about the syntax, it is the argument in the wrong place. Both halves carry weight — the first
keeps somebody else's XML out of it (`<parameter name="stroke-width">` is not ours), and the
second is the escape hatch, since a card genuinely writing *about* `<parameter name="paths">`
need only pass `paths` for the call to go through. The refusal names what was lost, where it
went, and says first that nothing happened, because that is the part that decides what to do
next.

- **It runs before every arm, because every arm is too late.** The two that park put the
  mangled text in front of a person; the whole roster chain below has already done its write
  by the time it returns a string to say so. One check, at the top of `Dispatch::Call`.
- **This is the one thing Rust reads out of `arguments`, and it is not a breach of the
  bargain.** `asking.ts::normalizeAsk` still owns what a question *is*. This reads no field by
  name and knows no vocabulary: it asks only whether the encoding survived the wire, which is
  the same question `dispatch` already answers about `_meta`'s progress token. The argument
  names come from the tool's own advertised schema, so there is nothing here to keep in step.
- **The cheap half runs first.** `swallowed_by` scans the strings for one literal before
  building `roster()`, which is two dozen schemas — and the literal is absent from every
  well-formed call ever made. That matters because this is on the path of every call the
  server answers, including the arms that are already the slow ones.
- **`tools/lift-ask.ts` actually runs it**, which is the rule `build.md` states: `swallowed`
  decides whether a call is refused and neither direction of it is visible to a typecheck, and
  `declarations` walks a string by hand on a thread holding somebody's turn open. The one
  assertion that reads the live roster stays behind `cargo test`, and it is the one that would
  go quiet on its own — every other assertion supplies its own list of argument names, so a
  renamed `options` would leave them all green over a check that had stopped matching.

#### A choice with nothing to choose by

The second refusal on this server, and it rests on the same observation as the first: the
cost of a bad `ask_user` lands on a *person*, the moment the question is drawn, so anything
returned afterwards is a note about an interruption that already happened.

**The evidence is 178 of Lyss's answers, Aug 24 to Oct 1 2026, of which about 30 send the
question straight back** (sink `b260f62a`):

```text
no trade-offs      "give me pros and cons for each option so that my judgment is aware"
                   "what are the stakes"
no context         "i don't have the context you have, what's the matter"
overload           "that's overwhelming i have no idea"   "trop verbeux, je suis perdu"
no recommendation  "i trust you to pick the right fix"    "i'm tired, which is most sound?"
```

Each is a round trip: her turn to ask what the options mean, the card's turn to answer, and
the decision still not made. **The model has the context and she does not** — that asymmetry
is the entire reason this tool exists, and a call that spends none of it has moved the work
rather than done it.

`undescribed` is the check and `undescribed_note` is the refusal.

- **The trigger is as narrow as it can be while still catching the complaint**: two or more
  options, and *not one of them* carries a non-empty `detail`. One option is not a choice. A
  call where some options are described and some are not is a judgement about which needed
  describing, and that judgement is the model's to make. What is left is the shape actually
  complained about — a row of bare words with no way in.
- **A refusal rather than an aside, and that was the live argument.** The softer option was
  `previewAside`'s shape: let the call through and tell the agent afterwards. It was rejected
  because the signal would be *lagging* — Lyss has already paid the round trip by the time the
  agent reads it — and the round trip is the entire cost being removed. The refusal returns in
  milliseconds, costs her nothing, and the agent re-asks within the same turn.
- **Which is only safe because the escape hatches are named in the note and actually work.**
  An agent that reads the refusal and complies must get through, or a refusal becomes an agent
  that stops asking — the one outcome this tool cannot survive. Three of the six tests are
  that direction alone, and they are *lifted* rather than merely compiled: on a machine with
  no MSVC `cargo test` does not run, and a false positive here is invisible to a typecheck.
- **The note says where the trade-offs go, and that sentence is load-bearing.** `detail` is
  drawn on a button and is one line by design — the panel lives in the dock and grows upward,
  so pros and cons under four buttons is the "dock that has eaten the studio" the one-at-a-time
  stepper already exists to prevent. The question body is markdown and it scrolls, so that is
  where a table belongs. An agent told only *"add detail"* writes four paragraphs onto four
  buttons and the panel cannot draw them.
- **It asks for a recommendation and cannot check for one.** Nothing marks an option as
  recommended — the schema has said "most recommended first" for its whole life and nothing
  has ever verified it — so this half lives in the description and in the refusal's wording
  rather than in the check. That is honest about what is enforceable: an unenforceable rule
  stated in the schema is still read by the model composing the call, which is the one moment
  it can act on it.
- **Both question forms are read.** Neither may be `required`, so a check that looked at only
  the short form would be the gap rather than the guard — and the long form is where a review
  puts its twelve decisions, which is exactly where bare labels pile up.

The schema descriptions carry the rest, and they are the half that shapes a call *before* it
is made rather than refusing it after. `options` now says the recommendation goes first and
that bare labels are refused; `detail` says it is the cost or the risk rather than a
restatement of the label; the tool description says to ask it the way you would want it asked
of you. Those bytes are in the **loaded** tier and therefore paid on every spawn of every
card, which is the usual trade — they are affordable here because the ceiling had ~2KB of
slack and because `option_schema`'s own comment already warns that it is emitted twice.

#### A tool the agent can see, under a name it can call

Two failures, found together on 2026-08-19 from one symptom — agents barely touching the
billboard — and they compound: the reasoning was withheld, and the pointer to it was wrong.

**Withheld.** Tool search is on by default in the CLI and is *not* threshold-gated when
`ENABLE_TOOL_SEARCH` is unset (read out of 2.1.235; unset and `auto` are different modes and
only `auto` weighs the definitions against 10% of the context window). So every MCP tool
arrives at a card as a bare name behind a `ToolSearch` step with its schema withheld — which
costs this server more than most, because everything that makes the billboard work is *in*
the descriptions: that reading it is free where a `send` costs the other agent a turn, that a
notice wants `paths`, that `unpost` is the half nobody else can do for you. `mcp_config` set
**`alwaysLoad`**, which exempts the whole server whatever `ENABLE_TOOL_SEARCH` says and does
not count toward `auto`'s threshold either, so skein did not compete for budget with
whatever else the machine has configured. ~9KB of schema per spawn, and the CLI's own
documentation names this case: a small number of tools wanted on every turn.

That last clause is the one that expired. It was six tools; it became twenty-two, and the
flag is per-tool now — see **Two tiers** below, which is what `alwaysLoad` grew into and why
the server-level field is gone.

**Wrong.** The `--append-system-prompt` said `ask_user`, `board`, `post`, `list`, `send` —
and not one of those is a name a card can call, since the CLI prefixes every MCP tool with
its server (`mcp__skein__board`). The one paragraph guaranteed to be in front of every agent
spent its length naming five identifiers that resolve to nothing. Nothing errored: the tools
were there and described, and the card was pointed at names for them that were not. An agent
that never calls a tool it cannot find looks exactly like one choosing not to, which is why
this survived as long as it did — and why `supervisor.rs` now asks `ask::dispatch` what is
advertised rather than keeping a list, so a renamed tool breaks a test instead of stranding a
sentence.

The two are coupled in one direction worth knowing before touching either:
`supervisor::append_prompt` is *short because of* `alwaysLoad`. The descriptions carry the
reasoning, so the paragraph need not, and re-stating it there would be the same words paid
for twice in the copy that can drift out of step with the schema. **Take `alwaysLoad` off and
that paragraph becomes the whole of what a card knows about the board**, at which point it
has to grow back. Both comments say so, from both ends.

The general shape, and it is a different one from this file's other lesson: **a capability an
agent cannot see is indistinguishable from one it declined to use.** Neither half of this
produced an error, a log line, or a failed call — only a wall whose billboard stayed empty.

#### Two tiers, because the flag above stopped being affordable

`alwaysLoad` was a good bargain at six tools and ~9KB. On 2026-08-27 it was **22 tools and
38,598 bytes, on every spawn of every card**, with 1,402 bytes left under the test's ceiling
and a queue of tools waiting behind it. The test is the reason this is written down rather
than discovered later: it was authored with the instruction that tripping it is a
conversation and not a bump, and that is exactly what happened.

**The flag has a per-tool half.** `_meta["anthropic/alwaysLoad"]` on a `tools/list` entry
exempts that tool alone. Read out of the 2.1.241 binary as
`alwaysLoad: e.config.alwaysLoad===!0 || M._meta?.["anthropic/alwaysLoad"]===!0` and then
confirmed live by `tools/probe-tiers.ts`. Note the **union**: a server-level `alwaysLoad`
wins over every per-tool decision under it, so `mcp_config`'s field is *absent* rather than
`false`, and `the_server_claims_no_tier_of_its_own` keeps it that way. Putting it back would
silently restore the old cost with every tier still declared and every other test still green.

**What a deferred tool costs is its name.** `formatDeferredToolLine` is
`function iFa(e){ return e.name }`, and the listing the model receives is one bare name per
line — no description, no parameters. ~25 bytes against a roster average of ~1,750. That
ratio is the whole argument; nothing else about tiering would be worth the complexity.

**Who is loaded is a rule, not a taste.** Every tool `supervisor::append_prompt` names must
be loaded, or the one paragraph every card pays for points at identifiers whose schemas were
withheld — which is the *first* failure in the section above wearing a new face, and
`the_prompt_names_only_tools_the_server_advertises` guards the names but not their contents.
That fixes `ask_user`, `list` and `send`.

**And then the rule ran out, which is the thing to read before deferring anything.** It used
to fix `board`, `post`, `unpost` and `drop` as well, because the prompt named all four. Sink
`4dabbb75` found that those paragraphs were *restating* the descriptions they were justifying
— word for word, in the copy no schema keeps honest — and cut them (2,188 B → 1,350 B on a
project card). So the tools stayed and their reason went, and **the argument for loading them
is now the opposite one and is stronger**: the description is no longer a second statement of
the instruction, it is the only one. Defer `board` and nothing in front of an agent says to
read the billboard before working in a shared repository; defer `drop` and nothing says a
finding can outlive the turn. `sink` is loaded on the same footing — reading the pile is the
other half of `drop`, and a card told to file findings and not told it can read them files
duplicates.

Read the two together as one rule with two clauses: **a loaded description is either the
prompt's referent or the prompt's replacement, and a tool that is neither can be deferred.**
Nothing that is either may be, and no test can tell you which — the prompt naming a tool is
checkable and a description being the last copy of an instruction is not.

Then four on a different argument, and it is the one `append_prompt` used to make for
`drop`: **a description is only read by an agent that has thought to look for a tool.** `pin`,
`wake_me`, `allowance` and `servers` exist to replace something an agent does wrongly by
*default* — writing a path into the transcript, sleeping inside a turn, guessing at the
budget, and shelling out `pnpm dev` in a territory whose dev servers the wall is already
running. Nothing in a schema reaches a reflex and nothing in `ToolSearch` reaches one either,
because the failure is not searching at all. Everything else is a capability a card knows it
wants from the prompt it was given, and is deferred.

`servers` is the newest and the one with a measured failure behind it rather than a worry: a
card launched two dev servers by hand with both already defined, autostarted and *up*, then
probed the wedged one over HTTP three times onto a queue the user was already waiting on, and
found the tools only when told (sink `11365b64`). Its hint names `pnpm dev` in as many words
and would have ranked first — which is the evidence, not the counter-argument. **Only the free
read was promoted**: `server_log` and `server` stay deferred and are named by `servers`' own
*answer*, which is a tool result and costs nothing per turn. `servers.md` has the arithmetic
and the rule that follows from it — when a whole subsystem's tools are undiscoverable, promote
the one that is free to call and let its answer carry the rest.

Note where that argument does *not* reach, because it was misapplied for a while: it is an
argument about a **deferred** tool, and it was being used to justify a paragraph about
`drop`, which is loaded. A loaded description is in front of the agent whether it looked or
not, so "an agent has to go looking" is simply false for it. The argument belongs to the
tiering decision and nowhere else.

**A deferred tool without a search hint is one nobody finds**, and this is the failure the
tiering introduces. It is silent in the worst way: the tool registers, dispatches, passes
every test, and is never reached. `_meta["anthropic/searchHint"]` is *not* rendered into the
listing — it costs nothing per turn — and it decides the ranking. Probed as a controlled
pair, one query, the hint the only difference: with it the tool ranked **first** for a query
sharing no token with its name; without it, it did not place in the top five.
`every_deferred_tool_can_be_found` refuses one without.

**Write the hint as the words of the problem, not the name of the solution.** The case that
taught this is the forge tools in `smith.rs`: a card reaching for one has usually just failed
with `az`, so it is searching for `certificate error` or `az repos pr create` — the thing in
its hand — and nobody thinks *"pipelines"*, they think *"did my build pass"*. A skein tool's
name is a single ordinary word (`touched`, `recall`, `take`) chosen to read well in a
sentence rather than to be searched for, so the hint is carrying the entire load. The
corollary is that hints **collide**, and only whoever can see the whole list can tell:
`server_log`'s "build error" and a CI tool's "build failed" are the same query and different
machines, and a card sent to the wrong one gets a confident answer about the wrong build.

Two consequences worth stating because both were nearly got wrong:

- **The assertion had to move with the thing it measures.** Counting the `tools/list` payload
  was right only while the payload *was* the standing cost. With tiering it counts schema
  nobody is charged for, and would go red over tools that are free.
  `the_loaded_tier_is_what_every_turn_pays_for` counts the loaded tier instead. A budget has
  to be levied on the thing being spent.
- **Only the server-level flag put a config in the CLI's blocking-connect bucket**
  (`Vk(t,(f)=>f.alwaysLoad===!0)` → `L_u(!1, …)`), so on paper this trades away the guarantee
  that the tools are present when the turn-1 prompt is built. It does not, and it was checked
  rather than assumed: stalling `tools/list` for 6s and then 25s — five times the 5s connect
  cap — left the loaded tier in the turn-1 prompt every time, and `MCP_CONNECTION_NONBLOCKING=0`
  changed nothing observable. The wait was free here for the same reason it was pointless:
  this is a loopback listener `Asks::port` has already answered for before anything spawns.

The trade to weigh when moving a tool out of the loaded tier is the one both comments state
from either end: **bytes taken off the roster may have to be paid back in `append_prompt`,
which is charged on the same turns** — and paid there in a copy that can drift out of step
with the schema. It is only worth making for a tool that paragraph does not name, and after
`4dabbb75` that is nearly all of them, so the question is now the one above instead: is this
description the only place the instruction is stated?

**And the roster is where the weight is, which is worth knowing before optimising the
visible half.** Measured 2026-09-05: the loaded tier is 20,751 bytes against this test's
24,000, and `append_prompt` is 1,873 on a project card and 2,937 on a spawned one (re-measured
2026-09-08) — 9% and 14% of the loaded tier standing beside it, before a card has read a word
of its own prompt. `drop_schema` and `post_schema` are each larger than the whole system
prompt.

#### A third case, where the hint loses to something already in the prompt

The tiering rests on one claim about the deferred tier: a card that *goes looking* will find
the tool, so the only failure a hint cannot fix is not searching — sink `11365b64`, and the
argument that promoted `servers`. There is a second kind of not-searching, it was met on
2026-09-08, and it is worse: **the question had already been answered.**

The client lists every claude.ai connector needing authorization and instructs the card to
tell the user the capability is unavailable until it is. A card asked about an Asana board
opened by reporting the official connector unauthenticated and stopped — on a wall holding a
verified Asana token, three widgets drawn off it, and `docket`'s three tools, whose hints are
written as carefully as any here and would have matched. They never ran. Nothing in
`ToolSearch` reaches a card that is not uncertain.

So the case is distinguishable and the remedy is different. Non-searching is fixed by
*loading* a description, which is what the reflex-shaped tier is for. A **contradiction** is
fixed only where the contradiction is, and only the system prompt is charged on the same
turns as the notice it has to answer. `supervisor::append_prompt` carries it (521 bytes,
project cards only) and the whole argument is in the comment above it — including why it
names the *search* rather than the tools, which is not a way around
`the_prompt_names_only_tools_whose_schemas_are_loaded` but the division of labour that guard
protects: the prompt supplies the reflex, the hint supplies the match, the schema supplies
the reasoning, and no sentence is paid for twice.

**Loading `tasks` instead would not have fitted, and the arithmetic is the useful part.**
`tasks_schema` is ~2.4KB against this tier's ~2KB of slack, so the choice was never between
two affordable options — and the sentence is a fifth of the cost for the half of the job that
was actually missing. The general shape, for whatever meets this next: **before promoting a
tool, ask whether the card failed to look or was told not to bother.** A hint answers the
first; only a paragraph answers the second.

#### Several questions in one call

The tool began as one question with a flat list of options, which is the right shape for
most asks and the wrong one for the ask that matters. An agent about to build something
rarely has one decision outstanding; it has two or three, on independent axes. With one
question to put them in it *fuses* them, and the options it then writes are a
cross-product:

```text
two widgets, and yes to attention
two widgets, but keep it silent
one widget with three variants (attention: yes)
three widgets (attention: yes)
```

Four of the eight combinations, presented as though they were the whole set — so "three
widgets, keep it silent" was not merely awkward to pick, it was **not there**. That is
worse than a long question: it is a list that looks complete and is not. The length is a
symptom of the same fusing, since every option then has to spell out both halves, which is
what turns four choices into four paragraphs.

So a call carries `questions[]` and the panel walks you through them one at a time.

- **The parking is one request and therefore one reply**, however many questions it asked.
  That is not a limitation to design around later — it is the whole feature (`ask.rs`'s
  parked `tools/call`), so nothing is sent until the last question is answered and
  `composeAnswer` puts the sheet back together. Everything else about the panel follows
  from it: `answerAsk` takes no text in the normal path, the stepper's "back" is free, and
  a half-answered ask is a card still legitimately `ask`.
- **One question composes to the bare answer and nothing else.** Several compose to a
  numbered list carrying each question's `header`. Load-bearing: the bare form is what every
  ask sent before this, and a single question suddenly arriving numbered and headed would
  change the reply's shape for every agent already written against the tool. Skipped
  questions are sent as `skipped` rather than omitted, because a gap in a numbered list
  invites the model to re-align the rest onto the wrong questions.
- **Asked one at a time, not laid out at once.** Two reasons, and the second is the one that
  matters: the panel lives in the dock and grows *upward* into the wall, so three questions
  with four options each is a dock that has eaten the studio — and a decision read on its own
  is answered on its own, where decisions shown together get read together, which is the very
  habit that made the agent fuse them in the first place. `.ask` also carries a `max-height`
  and `overflow-y` as the floor under that.
- **Rust reads nothing out of the arguments.** `AskOpened` carries the tool call's `args`
  whole and `asking.ts::normalizeAsk` owns the vocabulary — the same bargain
  `widget.config_json` and `ambience_profile.layers_json` strike, and it has already paid:
  `questions` was added without the struct changing. Normalizing degrades rather than
  refuses (a missing field, a string where an array belongs, a call with neither form), for
  one reason: the payload is whatever a model composed, and a card parked with nothing on
  screen to unpark it with is the one outcome that cannot be allowed.
- **Neither form may be `required` in the schema**, or a call using the other one is refused
  by the client before it reaches us — and a refused ask is an agent that stops asking. The
  guidance lives in the description instead, which is also where the model is told *not* to
  fuse decisions and why.
- **The step is derived from the sheet, never held** (`stepAt` = the first unanswered).
  Going back to revise an earlier answer and giving it again lands on the next open question
  rather than stranding a cursor on one already answered. `at` only ever *shows* an answered
  question and is cleared the moment one is given.
- **A sheet with several questions ends at a review, not at a send.** This is the whole point
  of asking them together: reading the third is often what changes your mind about the first,
  and sending on the last answer put that revision one gesture out of reach — you could go
  back freely right up until the moment it stopped being possible. So the answered sheet is
  drawn as pairs, every one a way back into its question, and the send is its own act. One
  question still sends on the click: there is nothing to step to and nothing to review, and
  making a single decision cost two gestures would be a worse panel than the one this
  replaced.
- **There is no order to enforce, and enforcing one was a bug.** Any question is reachable at
  any time, answered or not — the spine, `←`/`→`, and the op's `at`. An earlier cut walled off
  everything past the first unanswered question, on the belief that a sheet filled out of order
  composed a reply the agent would read against the wrong decisions. It does not:
  `composeAnswer` keys each answer to its own question by *index* and always emits them in the
  order they were asked, so the reply is byte-identical however the sheet was filled (this is a
  test, not a claim). What the rule actually cost was the ability to look ahead at what else is
  being asked before deciding where to start — and since the questions in one call are usually
  independent, which is the entire reason they arrive together, that is the normal case rather
  than an edge one.
- **The answers live on the ask, not in `Ask.svelte`.** The dock draws whichever card is
  blocked, so the component survives the card changing under it — held locally, switching to
  another blocked card and back would throw away everything already answered. The same fact
  is why `at` is reset on `askId`: a "back" from the last card's sheet would otherwise point
  into a different set of questions.
- **The panel says which card it is about, and now offers to go there** (`askShown`, and
  `.goto` in the head). Which card the dock draws is the focused one when it is among the
  blocked, and otherwise the first that asked — so answering follows the ring rather than
  fighting it, but a question arriving while you are reading a different card draws *that*
  card's question above *this* card's transcript, with the name in the head the only thing
  saying so. Everything in the panel then belongs to a conversation you cannot see, which is
  how an answer gets given against the wrong context. `select it` puts the asking card in the
  ring, its transcript in the panel and the gathering on it — `focusCard`, exactly what
  clicking it does. **Nothing dismisses it: it goes because it stops being true.** Landing on
  the card makes `askShown` return the focused one, the two stop differing, and the offer has
  answered itself — no flag to clear, and nothing to get wrong when the card changes under the
  component. The choice is pure and tested because that invariant is the whole of the feature.
- **The question is rendered, not printed.** It used to be a bare `{ask.question}` while the
  transcript six inches away rendered the same prose properly, so an agent's backticks and
  hashes arrived as themselves. `Markdown.svelte` is renderable outside the panel (`--read`
  defaults to 1) so this costs an import, with `nav={false}` — a question in the dock is not a
  place in the transcript for the rails to travel to.
- **There is no cap on how many questions a call may carry, and there was one.** Five, on the
  argument that a longer call is a survey rather than a question — with the excess drawn as a
  note under the panel, since an agent that asked six things and got five answers will act on
  the sixth regardless. Both halves were wrong. The note was drawn where only the *user* could
  see it, so the reply the agent read was five answers that looked like the whole of it: a card
  sent twelve questions after a round of worker reports, Lyss answered, and the card had to
  notice its own missing answers (sink `4b076830`). **A cap the other side of the wire cannot
  see is not a cap, it is data loss** — and batching decisions is the good use of one park, not
  the abuse of it. Nothing in the panel needed the cap either: questions are stepped through one
  at a time, the spine wraps, the panel scrolls. What a long call costs is reading time, and
  that is bounded at `ANSWER_MAX`, which is a real constraint rather than a taste — the client's
  own deadline is written into `--mcp-config` once at spawn, so a call that asked for longer
  would be abandoned by the client with its own sentence. A twelve-question review saturates
  there at forty-five minutes rather than being cut down to fit.
- **The peek is named by headers, never by a truncated body** (`askHeadline`). That line is
  `white-space: nowrap` with an ellipsis, so a question body put there is a cut-off paragraph
  naming nothing — and a call carrying several would name only the first.

#### A skip is not a yes, and a deadline is not an answer

Two bugs with one shape, and the shape is worth naming before either: **Skein kept answering
a question on the user's behalf with a sentence that read as delegation.** Both were cheap to
write and both published something.

**The skip.** `NO_PREFERENCE` — `no preference — your call` — was what the skip button sent,
what `composeAnswer` filled an unanswered slot with, and what the control surface's
`rest: true` wrote. On 2026-10-01 a card asked how some drafts should land, offering "land
all", "I'll read them first" and "skein only for now". Lyss skipped it. The card read
`landing: no preference — your call` as delegation and pushed to two repositories — skein
`1a1a93a` on main and nova `a57617f2` on a shared feature branch (sink `662b2900`). *"it was
not really land all, that was a skip."*

Two different answers were wearing one sentence: **I don't mind, you pick**, which hands the
decision over, and **not now**, which withholds it. For a question gating an outward-facing
act the cost is asymmetric in exactly the direction that matters — a wrong *wait* costs a
turn, a wrong *go* pushes, deploys or deletes.

So they are two sentences and two gestures. `skip` sends `SKIPPED`; `you decide` is its own
button and is the only way to reach `NO_PREFERENCE`. The review sheet greys both (`isUnsaid`)
because neither is a thing the user said, but only one of them authorises anything.

- **The directive is said once, not once per slot.** The first cut put the whole forty-word
  instruction in the slot, and the call this was filed about carried 42 questions of which 25
  were skipped. That is the same paragraph twenty-five times in one reply — a few hundred
  tokens of repetition, and a model reading one instruction twenty-five times is being told
  something about its weight that nobody meant to say. The slot carries the word (`skipped`)
  and `SKIPPED_ASIDE` carries the meaning, which is also the right division: *skipped* is what
  happened to that question, and the directive is a fact about the call.
- **It rides `ASIDE`**, for the reason `previewAside` does — read back off disk it is a
  `tool_result` like any other, and drawn as an answer it would put Skein instructing an agent
  into the user's mouth under a one-word decision. **The asides are gathered and emitted under
  one marker**, because `answerNote` cuts at the *last* one: two markers in a reply would
  leave the first drawn in the transcript as a line the user typed, which is the whole thing
  the marker exists to prevent.

**The deadline, which is the same bug arriving by a different route.** `timed_out` told the
agent to *"proceed using your best judgement"*, and it did. But the user not getting to a
question in forty-five minutes says nothing whatever about what she would have decided — and
the call that motivated the countdown work below was answered by Lyss skipping every
remaining question *because the clock was running*, which turned a pacing problem into
twenty-five unintended delegations (sink `7264177f`). Her instruction: *"when the timer
expires on a question, it shouldn't mean 'no answer in time, do it according to your best
judgement', it should mean deferred, same as if I were away"*.

So `expired` **queues** it, into the same pile away mode uses. The question survives, the
answer reaches the card as a message, and `presence::Queued` carries the one thing that
differs — the opening sentence, because `DEFERRED_OPENING` says "Volery is in away mode" and
that is simply false when the user is standing at the wall. Everything after the opening is
shared, deliberately: what happened to the question is the same thing, so the four things the
note has to say are the same four.

- **Two cases keep the old timeout, and the boundary is the one `defer_parked` already
  draws.** A question carrying a `Settle` — `close`, `unpost`, the `remove` hand-off — cannot
  be moved into the pile at all, because the settle lives on the parked thread and is the only
  thing that can perform it; its unanswered behaviour is `decide(app, None)`, which is the
  right answer to a deadline anyway, since nothing happens. A question carrying an `act` but
  no settle is `smith` and `docket` — writes to somebody else's service, where re-entry after
  an unattended forty-five minutes is a decision this function cannot make. Which leaves
  `ask_user`, the whole of what was meant and the only kind of question that is purely
  information flowing back to an agent.
- **It has to make a noise, which away mode does not.** Coming back from away *opens* the
  pile, so a question queued then is read within seconds of there being anybody to read it. A
  question queued while the user is right here has no such moment: it was amber in the dock,
  it vanishes, and all that is left is a count appearing in the bar — quieter than what it
  replaced, on the one wall where the user is actually present. Answering "the agent decided
  without me" with "the question went away" is a different failure and not obviously a smaller
  one. So `expired` writes a chronicle row when the wall is not away — the wall's existing
  answer to *something happened that you were not looking at*, read as a wisp when it lands
  and as a row for ever after. **Not** the attention ladder: the flash and the peek are for a
  card that is *blocked*, and this card is not blocked any more.
- **`MAX_PER_CARD` is the backstop and is unchanged.** Past eight queued questions one card
  still gets `pile_full`, which tells it to decide for itself — so the old behaviour is still
  reachable and a card cannot block on a person indefinitely. What changed is that it is
  reached after eight real attempts to ask rather than on the first deadline.
- **What this costs, stated plainly, because it is a trade and not a tidy-up.** A timeout used
  to leave a card *carrying on*; it now leaves a card *waiting*. On a wall running ten agents
  that converts work the agents would have guessed at into work queued against one person's
  attention. It is the right trade here — the guessing failure is the one that pushed to two
  repositories — but the pile has to be read like an inbox for it to be, and a headless card
  with nobody at the wall now stops where it used to proceed.
- **Nothing in TS knew about a deferral, and that was already a bug.** The live path hears
  `ask:closed` with `deferred: true` and writes nothing, so a deferred question left no mark
  and nobody noticed the *folded* form had one: off disk there is no flag, only a tool result
  beginning "Volery is in away mode.", and with nothing to recognise it `answerNote` drew
  Skein's own sentence as a line the user had typed. The precise seam `UNANSWERED` exists to
  close, one case short since away mode shipped. `QUEUED` is the list and `QUEUED_NOTE` is
  what the panel says — a separate note from `NO_ANSWER_NOTE` because it says the opposite
  thing: that one reports a loss, this one reports that nothing was lost.

#### The countdown does not run down while you are typing into it

*"we need to improve the ask tool to not decrease time when i'm litterally active and typing
in it, it's stressful and work losing for no reason"* — and then every remaining question was
skipped, which under the old meaning of a skip was the dangerous outcome as well as the
rushed one. Sink `7264177f`.

**The panel cannot pause its own clock, and that is the whole design.** The countdown is not
decoration: it mirrors the deadline `park_and_stream` gives up on, and a display frozen over a
thread that is still counting would be an instrument lying in the one direction that loses
work. So the *deadline itself* moves. `ANSWER_HOLD` (5 minutes) is what a touch buys from the
moment of the touch, `held_window` / `heldWindow` is the rule, and both sides apply it to the
same event — the panel moves its own countdown immediately and tells Rust through `stir_ask`.

- **Five minutes, and it is under `ANSWER_BASE` on purpose.** It has to outlast reading the
  next question rather than merely the keystroke; shorter and a pause to think reads as
  inactivity. Being under the floor is what makes the never-touched case need no special arm —
  `max(base, 0 + hold)` is `base`.
- **Still clamped to `ANSWER_MAX`**, which is not patience: it is the client's own deadline,
  written into `--mcp-config` once at spawn. Typing past it buys nothing, and the honest thing
  is for the countdown to say so.
- **The stir is throttled to once a minute, and the two sides may drift.** An invoke per
  character is an IPC round trip for a number that moves in minutes. They drift by at most
  `STIR_EVERY`, always with the panel showing *less* time than there is — the safe direction
  for an instrument whose job is to say whether to hurry.
- **It listens on the panel root, capturing, for pointers as well as keys.** Active is not
  only typing: reading four options before deciding anything is the longest kind of decision
  and precisely the one a keyboard-only hold would run out on.
- **`park_and_wait` grew the same tick loop.** It is the Volery-composed path and had one flat
  `recv_timeout(window)`, which is this bug on a second surface — exactly the "written three
  times to three standards" failure `follow.ts` was cut out of.

The one thing still lost is the tail: a sheet three answers into five, when the clock runs
out, goes to the pile as the whole question again. Better than before, where it went nowhere
at all — but the partial answers are still not preserved, and that remains its own piece of
work.

#### Designs that are looked at rather than described

Claude Code in a terminal can only ever *describe* a layout, so an agent with three of them
to offer writes three paragraphs and you choose by imagining. Every one of those paragraphs
is a worse version of the thing itself, and the choice is being made from memory. There is a
webview here. So an option can carry a `preview` — plain `html`, optional `css`, optional
`js` — and Skein draws it (`Gallery.svelte`).

This is the one question this app is straightforwardly better placed to ask than the CLI is,
and it changes nothing about the parking: the reply is still the option's label, composed by
`composeAnswer` exactly as before. A preview is about *seeing*, never about answering.

- **The gallery is its own surface, not part of the dock.** `.ask` is
  `max-height: min(52vh, 30rem)` and grows upward into the wall; three mockups in it is the
  studio gone, which is the same argument that made the questions be asked one at a time.
  But it is also the opposite job. Questions are stepped through because a decision read
  alone is decided alone — *options within one question* are already all shown at once, and
  comparison is the entire reason a design preview is worth having. So the panels are laid
  out side by side, full size, over everything.
- **It hangs off an option for a comparison and off the question for an approval.** One
  design and a yes/no is not two previews; duplicating the same mockup onto both buttons
  would say it was two things. `panelsOf` flattens the two into the one list the gallery
  draws, and a question's own preview chooses nothing (`label: null`).
- **The frame is contained by two things and only one of them is guaranteed.** The `sandbox`
  attribute is spec: `allow-scripts` with deliberately **no** `allow-same-origin` puts the
  document on an opaque origin — no parent DOM, no `window.__TAURI__` through
  `window.parent`, no storage, no navigation, no modals. Those two are not independent
  permissions and adding the second hands the frame this document's origin back. The other
  half is a `<meta>` CSP inside the document (`previewDoc`), which is what closes network
  egress, since `tauri.conf.json` has `"csp": null` and nothing else would. **That half is
  reasoned about rather than probed** — a meta CSP applies to its own document by spec and
  srcdoc inherits its parent's, but nobody has run `tools/probe-*.ts` against WebView2 to
  watch a `fetch` fail. It is good enough for designs and is not yet evidence for anything
  else.
- **The threat this defends against is not a hostile agent.** A project card already spawns
  with `--dangerously-skip-permissions` and can delete the repo; that was decided at spawn
  and no iframe attribute revisits it. What the sandbox is actually for is the **chat** card,
  which spawns `--tools WebSearch,WebFetch` with no bypass and can reach nothing on this
  machine — and which is precisely the card most likely to be handed a design copied out of a
  web search. A running script there would be the first executable surface that card kind has
  ever had.
- **So scripts are gated by what kind of card asked, never by the payload** — the same rule
  `spawn_conversation` follows when it reads `kind_of` off the store rather than taking a
  capability as an argument. `Ask.svelte` passes `scripts={conv.kind !== "chat"}`, and the
  gate is the CSP's `script-src` rather than dropping the `js` field, so a `<script>` typed
  into `html` instead is refused by the same line. A chat card says so on the panel rather
  than silently rendering a design that looks broken.
- **The risk no sandbox closes is that a spin takes the window.** A srcdoc frame on an opaque
  origin shares the renderer with its parent, so `while(true){}` in a mockup freezes the wall,
  every transcript and the dock — and nothing can kill it, because the thread that would is
  the one that is blocked. The mitigation is that hover, focus and transition are all pure
  CSS, so **every preview renders static first** even on a card that is allowed scripts, and
  running one costs a deliberate click per panel with the cost written on the button. That is
  the whole of the defence and it is honest about being partial.
- **A fixed composing viewport, scaled down** (`PREVIEW_VIEWPORT`, 1280×800). A frame cannot
  report the height it wants and asking it would mean a `postMessage` channel back out of the
  sandbox — a hole in the only wall this stands on, opened for a layout convenience. It is
  also what makes three designs comparable: same size composed, same size judged, which is
  `CARD_BOX`'s bargain one surface over.
- **The app's own tokens are injected**, read off the live `:root` rules at mount rather than
  listed in the component, so a token added to `tokens.css` reaches previews with nobody
  remembering this file. A design composed in Skein's palette is being judged on the decision
  rather than on whether the agent guessed the greys.
- **Choosing from the gallery answers the question.** Reading the designs is how the decision
  gets made; closing the gallery and then hunting for the matching button in the dock would be
  answering it twice. It goes through `give`, so the single-question send comes with it.
- **Escape is captured on the window.** While the gallery is open it is the innermost thing
  there is, and `App.svelte`'s ladder is a bubble-phase listener that would otherwise stop the
  focused card's turn. The menu and the import panel are named in that ladder by hand; a
  capture listener needs nothing to know about it.
- **A design built by its `js` renders blank, and for a while nothing said so.** Reported
  2026-09-01 (sink `51863e1e`): a preview whose `html` was `<div id="rows">` and whose `js`
  filled it in from a JSON block drew an empty frame — no rows, no error, nothing. **The
  renderer was right**, and the schema says so in as many words; every preview renders static
  first, for the spin-takes-the-window reason above. What was missing is that the behaviour
  was invisible from both sides. The user read a blank frame as a broken feature. The agent
  got no signal at all — the call succeeded and came back with an answer — so the next call
  composed the same skeleton. The workaround that did work, writing an `.svg` and pinning it,
  is a person routing around a feature that was working.
  So it is said twice, from the two sides, off one pure predicate (`isScriptBuilt`).
  `Gallery.svelte` draws a plate in the frame — *a plate rather than a cover*, because the
  predicate cannot see a skeleton drawn entirely in CSS, so whatever is really there stays
  visible around it and running the script takes it away. And `composeAnswer` appends
  `previewAside`, which is the only channel to the model there is: the reply to a parked call.
  It is additive and only in the failing case, so the reply *shape* every agent is written
  against — the bare answer, the numbered list — is unchanged for the calls that were fine.
  **The aside carries a marker at both ends** (`ASIDE`, written by `composeAnswer` and taken
  off by `answerNote`), for the reason `UNANSWERED` exists one paragraph up: read back off
  disk it is a `tool_result` like any other, and drawn as an answer it would put a paragraph
  of Skein lecturing an agent about `js` into your mouth, under a one-word decision.
- **The schema's `preview` description is doing real work.** The model has spent its whole
  life describing layouts in prose to a terminal and will keep doing it beside an empty field,
  so `ask.rs` says what the frame can and cannot reach (no network, no imports, no
  frameworks), that the tokens are already defined, and what size to compose at. `preview` is
  required nowhere, for the same reason neither question form is: almost every ask is a
  sentence and some buttons, and a mandatory field would refuse all of them at the client.

#### Files that already exist, which is the other half of the same gap

A design is composed here because it does not exist yet. A screenshot, a render,
a PDF, a spreadsheet, a page of notes — those already do, and an agent holding
one had the same problem from the other side: describe it in prose, or `pin` it
to the wall and ask a question that points at it sideways. So an option or a
question can carry a `file` as well as a `preview`, and the gallery draws both.

- **Nothing in this feature knows what a file format is, and that is the whole
  arrangement.** `finding.ts::READINGS` is already the one table that decides
  which of the viewer's five readings a path gets, `Leaf.svelte` is already what
  draws each of them, and `find.rs`'s three commands are already how bytes get
  here. A question's attachment goes down that path and no other. The *gain* is
  the point: the day the viewer learns a sixth format, a question can show you
  one without this file being touched. `ask.rs`'s test asserts the negative
  directly — the schema may not spell an extension anywhere, because a list
  there would be a second place to be wrong about a format, which is the hazard
  `find::read_doc` already writes down about the `media_type`/`IMAGES` pair.
- **So `Leaf.svelte` exists, and the wrapper deliberately does not move with
  it.** The dispatch — media before `binary`, `docFault` before `binary`,
  rendered-markdown before source — was inside `Spyglass.svelte` while the
  finder was the only thing that opened a file, and two copies of it would have
  been two answers to *what does a `.docx` look like here*. What stays with each
  caller is the box: the finder's scrolls and is what its dog-ear measures a
  reading out of, and the gallery's is a fixed stage with a magnifier over it.
  `readSheet` is the same lift one layer down — the finder's own `#fetch`, at
  module level, because a `Finder` owns a current root and a cache and a
  question owns neither.
- **Rust resolves and never copies.** The whole of `attach_files` is: the path
  names a file, and here it is as the `(root, path)` pair every read in
  `find.rs` goes through. It was briefly going to copy into
  `$APPDATA/references/asked/`, which is what pinning does — that was right for
  the asset protocol and wrong for everything else, since the viewer does not
  use the asset protocol at all. It reads through `safe_join`, which is a
  stronger boundary than a scope, and it costs no disk and no sweep.
- **Each file is rooted at its own parent directory, not at the card's working
  tree.** `safe_join` refuses a path that climbs out of its root, so a root of
  the project would refuse the screenshot in `%TEMP%` — which is the commonest
  thing an agent actually has to show. Rooting one named file at its own parent
  keeps the containment exactly as strong (one file, reached by its own name)
  and costs the agent nothing.
- **The resolution happens before the away branch, because the away branch
  stores the arguments.** A deferred question is read in the morning, and a
  relative path is one whose meaning depends on a working directory nobody will
  remember by then. What the pile cannot promise is that the file is still
  *there* — nothing is copied, so a render deleted overnight draws the viewer's
  own "could not read" sentence. That is the honest failure and it is cheaper
  than a copy with a sweep and a claim rule behind it.
- **A path that names no file refuses the whole call.** `pin`'s bargain rather
  than `preview`'s, and the difference is worth stating: a design built by its
  `js` is still a question worth asking with a note attached (`previewAside`),
  where a question whose file is missing is a question about nothing. The agent
  learns what is wrong in a second instead of ten minutes later, and the panel
  never needs a broken-attachment state at all.
  **And the idempotence is derived rather than asserted**, which is the second
  cut: the first one returned early on an object already carrying `root`, on
  the stated belief that `root` was "a key nothing but this function writes".
  Nothing in a `tools/call` is a key only we write — `slot` is a subtree of the
  agent's own arguments, and `attach_at` deliberately accepts `{"path": ...}`
  too, so one more key beside it is no reach. The early return skipped both the
  existence check and the counter, so a forged pair defeated the refusal
  promise above *and* made `MAX_FILES` unbounded. Now a pair is joined back up
  and re-checked like anything else; a pair we wrote resolves to the same file
  and comes out the same pair. The general shape, which is `#adoptModel`'s one
  file over: **a guard keyed on something its own subject can write is not a
  guard.**
- **One panel is one thing**, so a site carrying both a file and a design yields
  two panels under one label. That reads as what it is: here is what it looks
  like now, here is what it would look like. `panelsOf` puts the file first for
  the same reason — the thing that exists before the proposal about it.
- **The magnifier on a file is honestly just more room.** No zoom chrome, no
  glass, no composed viewport: 100% means one composed pixel against a design
  that was told what size to compose at, and means nothing at all against a PDF.
  A document brings its own reading and its own scroll, and the glass exists
  because a pointer over an *iframe* belongs to the iframe — a file is drawn by
  this document's own elements, which hear a wheel without being asked. The
  stage is focusable and takes focus when it opens, which is the half that was
  missing: the zoom ladder returns early for a file, so without it a forty-page
  PDF was reachable by wheel alone, and the keyboard reaching everything is a
  standing requirement here rather than a preference.
- **The gallery grew the question's own options**, and that is the shape the
  user asked for first: one picture, several answers about it. Nothing on those
  panels chooses — the picture is the question, not an option — so without the
  row you read the picture, closed the gallery and went hunting for the matching
  button in the dock. Deciding twice, which is exactly what `onchoose` already
  exists to prevent for the panels that *do* choose. It is the **difference** —
  every option no panel carries — rather than an either/or, and the first cut
  had a hole exactly in the middle of that: a question with a screenshot *and*
  one option carrying a render had a panel to choose from, so the row was
  suppressed, so the plain options were reachable from nowhere.
- **A chat card may not attach one.** Decided by what kind of card asked and
  never by the payload — the rule `spawn_conversation` follows, and the one
  `Ask.svelte` already follows for whether a design may run its script. The
  argument is not exfiltration: the file's content never reaches the model,
  since a parked call comes back carrying only your answer. It is that a chat
  card spawns with no Read, no Write and no Bash, so it cannot *make* a file to
  show you, and the only paths it could name are ones it did not write. That is
  a capability with no honest use and one dishonest one, and closing it costs
  nothing. `has_file` is the walk the gate asks, and its test is about the
  fourth site — an option inside `questions[]`, which is the form the schema
  pushes callers toward and the one a three-site walk would miss.
- **`Leaf`'s `rendered` takes its default from the file, not from `true`.**
  `Finder.rendered` means *this is markdown and the raw toggle is off*, and
  hoisting it to a component whose other caller has no toggle quietly widened
  it to *this is any text at all*: a `.yml` or a `.py` attached to a question
  went through `parseMarkdown`, losing the indentation that is its meaning and
  promoting its `#` comments to headings. Caught in review before it shipped.
  `hasDocumentReading` is that predicate with the toggle taken out, and it is
  in `finding.ts` beside `drawnAs` rather than next to either caller, because
  it is the same question those readings answer and because there it is pure
  and tested. **A flag named after a reading must be derived from the file**;
  a default of `true` on one is a claim about every file a caller will ever
  pass.
- **The gallery's answers row is keyed by position.** `optionsFrom` drops a
  blank label and dedupes nothing, so two options reading "Other" are two
  entries — and a keyed `each` throws `each_key_duplicate` in production as
  well as in dev, which would take the whole gallery down on a payload the
  dock's own unkeyed list draws without complaint. The list is fixed for the
  life of the component, so a key bought nothing to weigh against that.
- **A top-level `file` with `questions[]` hangs on the first question.** The
  single-question sugar only runs when `question` is a string, so a call
  sending both had its file resolved by `ask.rs` — which can refuse the whole
  call over it — and then dropped without a word: the user never saw it and
  the agent could not find out. `preview` had the same hole for its whole life
  and gets the same fix. The first question is the only answer that is not a
  guess, since the attachment was put at the level that addresses the *call*.
- **A picture is a description, which `thin_options` had to be told.** The
  bare-labels refusal landed the same week (sink `b260f62a`) and fires on two or
  more options where not one carries a `detail` — which is precisely three
  options labelled A, B and C with a render apiece and no prose, because the
  prose would be describing what is already on the screen at full size. That is
  the flagship use of both `preview` and `file`, so the check would have aimed
  itself at the calls spending the *most* of the model's context on the user.
  `undescribed_note`'s own comment says a false positive here is worse than one
  in `swallowed` — "a refusal becomes an agent that stops asking" — and this
  is what one would have looked like. Found by rebasing rather than by either
  change on its own, which is the argument for running the other half's tests
  and not only your own.
- **`lookLabel` names a single file outright** — "look at shot-after.png" is a
  button you can decide about before pressing, where "look at the file" is one
  more gesture to find out what is behind it. Several of anything is a count,
  because the names would not fit and the count is the fact that matters. Both
  it and `galleryHint` are pure and tested, which is why they are in `asking.ts`
  rather than interpolated into two components.
- **The loaded tier's budget is what shaped the schema**, and it is worth
  reading as the guard working rather than as an obstacle:
  `the_loaded_tier_is_what_every_turn_pays_for` caps what every card pays on
  every spawn, and a second way to show something put it over — `file` costs
  1,096 bytes, ~275 tokens on every spawn and every wake, measured rather than
  counted.
  The reclamation came out of what `preview` and `file` were *both* saying —
  "shown side by side, full size, instead of described" is one sentence about
  the gallery, and it now sits in the tool's own description where it is said
  once. What is left on each field is only what is true of it and of nothing
  else. The lesson for the next field that wants a paragraph: **when two
  options are two answers to one question, the shared half belongs to the
  question.**
  The first pass at fitting went too far and took two things with it, both in
  the copy that is paid *three* times: the enumeration of what is over at the
  top level — which `preview_schema`'s own comment argues for in as many words,
  since a reader told where the constraints are goes and gets them, where one
  given half of them does not know a half is missing — and "only where the
  decision turns on interaction" on `js`, which is the sentence sink `51863e1e`
  exists to have said. Both were bought back — 478 bytes, ~120 tokens, the
  best-value spend in the whole block — and the ceiling went to 32,000 with
  room rather than to the millimetre, because a bound a few hundred bytes above
  the tier does not catch a tool being added quietly, it catches the next
  paragraph anybody writes. The tier is 26,559 on the base this landed on. **A byte budget is a reason to say a thing once, not a reason
  to say less of it**, and the difference between those two is the whole of
  what this paragraph is for. The general form is in CLAUDE.md, where every
  session reads it.
- **`snapshot.cards[].pendingAsk` reports `files` beside `previews`.** Two
  numbers rather than one, because the two reach the panel by different routes
  and fail differently: a design is in the payload and a file is a read that can
  come back empty, so a test that could not tell them apart could not assert the
  one it meant. `previews` keeps its name and its meaning — panels in the
  gallery — so nothing outside had to be rewritten.

#### Looking closer at one of them

Fit is the right reading for the gallery and the wrong one for a detail, and the *same*
fact causes both: the composing viewport is fixed at 1280×800 so that three designs are
comparable, which means three panels across a laptop draw a 12px caption at four. A design
was being judged on whether it could be read.

**So looking closer is a second surface rather than a knob on the first one.** Zooming a
panel in place would break the one thing the gallery is for — same size composed, same size
judged, `CARD_BOX`'s bargain one surface over. One design is magnified over the rest,
floating and *inset* rather than filling the screen, because the gallery behind it is the
context you came from and a real fullscreen would throw that away to no purpose.

- **A pointer over an iframe belongs to the iframe.** There is no listener this document can
  add that sees a wheel or a drag inside a cross-origin frame, and there is no asking the
  frame to forward them — that would be a `postMessage` channel out of a sandbox whose whole
  value is that it has none, which is the same hole the fixed viewport exists to avoid
  opening. So the only way to pan a preview is a transparent sheet in front of it, and **the
  cost of that sheet is the frame's own hover**.
- **That cost is why the glass is not on the gallery's panels.** Hover, focus and transitions
  are pure CSS and are most of what a static preview has to show — the same sentence that
  justifies rendering static first. Covering them to buy a gesture that does nothing at fit
  would be a bad trade. Magnified it is the opposite trade: you came to look closely, and
  there is somewhere to pan to.
- **The glass lifts entirely when the design is running its script.** Operating a mockup and
  inspecting one are different acts, and a stepper you cannot click is not worth a drag the
  arrow keys already do. The buttons and keys work either way, so nothing is lost.
- **Fit is the floor.** There is no reading below it — the design is already wholly visible —
  and having a floor is what lets `0` always mean "back to the picture you started from".
- **Content smaller than the box is *centred*, not clamped**, and that is the half that was
  easy to miss: it is what makes fit look composed rather than pinned to a corner, and it
  means one rule serves both the zoomed-in and zoomed-out cases with no branch anywhere else.
- **Zoom is anchored at the pointer**, which is the entire difference between a magnifier and
  a slider with a picture attached. The clamp still wins near an edge, and that is correct —
  honouring the anchor there would mean honouring it into a view showing the backdrop.
- **The readout is against the composed viewport, never against fit.** 100% is one composed
  pixel to one screen pixel, which is the size the agent was told to design for. A percentage
  of fit would change meaning with the window.
- **Escape gained a rung rather than a branch.** The magnifier takes it first, for the reason
  the ladder exists at all: it is the innermost thing there is, and closing the whole gallery
  because you had opened one design would throw away the comparison you were in the middle of.
- **Choosing from the magnifier answers the question**, exactly as choosing from the gallery
  does. Closing it to find the panel again and press the other button would be deciding twice.

The arithmetic is in `zoom.ts` and is pure and tested — `fitScale`, `clampView`, `zoomTo` and
the wheel's `deltaMode` handling, which is there because a mouse reports lines and a trackpad
reports pixels, and treating 3 lines as 3 pixels makes a real wheel do nothing at all.

`snapshot.cards[].pendingAsk.previews` is a count per question, for the reason the stepper's
fields are reported: a question whose three options carry three mockups and one whose options
carry none are the same question, the same card and the same tier from outside.

#### What the transcript keeps of it

The question lived in the dock, was answered there, and went — so the panel carried the tool
call and then, some seconds later, an agent acting on a decision recorded nowhere. Reading a
card back, *yours* was the half of that exchange missing. So the reply is kept in the
transcript under the call that asked, as a line kind of its own (`answer`).

- **It is not a `you` line.** That register is a prompt, and the rails list every one of them
  as a place in the conversation to travel back to; an answer to a question you were asked is
  not one. It is drawn small and set under the call — the footnote to the tool line above,
  not a new thing said — and achromatic, because the amber was the card *waiting* and it is
  not waiting any more.
- **Both folds go through `answerNote`**, which is why it is in `asking.ts` rather than at
  either call site. Live it takes what `answerAsk` sent; off disk `foldTranscript` takes the
  `tool_result` the CLI recorded against the call, and the two produce the same line — the
  seam `history.ts` exists to avoid. The `Answering each in turn:` preamble is dropped: it is
  addressed to the model, and the numbered pairs under it are the whole of what you decided.
- **This is the one tool result history draws**, and it is the exception for the reason the
  rule exists: every other one is machinery, and this is the only thing a *person* said that
  arrives on the wire as a tool result. A result carries no tool *name*, only the id of the
  call it answers, so the fold remembers which `tool_use` ids were `SKEIN_ASK_TOOL`.
- **What `ask.rs` sends when nobody answers is not something you said.** The ten-minute
  timeout and the dismissal are Skein's own sentences, and read off disk they are a
  `tool_result` like any other — drawn as an answer they put those words in your mouth,
  exactly the `isStopNote` hazard one layer over. `answerNote` returns them as `meta`, and
  the live path writes the same note off `ask:closed`'s `answered: false`, so a question that
  expired says so on the page instead of simply vanishing.
- **`SKEIN_ASK_TOOL` is in `classify.ts` and deliberately not in `ASK_TOOLS`** — that set
  decides the `asked` ending, which is for a turn that *stopped* on a question, and this one
  resumes in place the moment you reply. A card whose question you answered would settle
  amber and stay there. Naming it there does mean the call finally reads `asked you a
  question` rather than the raw `mcp__skein__ask_user` it drew for its whole life.

`snapshot.cards[].pendingAsk` keeps `question` and `options` under their old names, meaning
the question *currently* being asked, and adds `step`, `count`, `headers`, `answers`,
`dropped` and `complete` — a call parked on three decisions with two answered otherwise looks
from outside exactly like one parked on three with none. The `answer` op fills in the current
question and steps on (`answers` for several at once, `at` to answer or revise any nominated
one, `rest: true` to leave the remainder to the agent). It reports `sent: false` until the
sheet is complete, then `reviewing: true` until `send: true` — mirroring the panel, because an
op that sent straight through would be testing a path no hand can take.


#### Not built: `flag`, and the decision it is waiting on

Proposed 2026-08-20 and deliberately left unbuilt, because the only hard part is a choice
about somebody's attention and that is not a choice this file gets to make.

The gap is real. `ask_user` **parks** — it stops the turn and demands an answer — and below
it there is nothing at all: a line of transcript, seen only if the panel happens to be open
on that card. "Migration landed, carrying on into the tests" wants the taskbar flash and the
peek and does not want a question. So an agent with something worth saying has to either
block on a decision nobody needs to make, or say it where nobody will read it.

`attention.svelte.ts` already escalates flash → peek → optional chime, so the tool itself is a
doorbell on machinery that exists. **The design question is who decides an interruption was
warranted**, and the three answers are genuinely different products:

1. **The agent decides**, with a rate limit. Simplest, and it has the failure this whole
   codebase keeps writing down: agents flag routinely, the peek stops meaning anything, and
   the escalation dies the way an uncleared billboard dies — quietly, by being learned to be
   ignorable. `board.md`'s first paragraph is the same lesson about notices.
2. **The wall decides**, off what is already on screen. A flag raises attention only when the
   flagging card is not the focused one and the panel is not open on it. Cheap, and it makes a
   flag from the card you are already watching cost nothing — which is right, because it *is*
   nothing: you can see it.
3. **You decide, per card.** Every flag lands in a quiet list, and escalating to the peek is a
   setting on the card. The most honest and the most machinery, and it puts a knob in front of
   a person for a thing they would rather not have to think about.

The recommendation was **(2) with (1)'s rate limit on top**, and the wall drawing the *count*
so an over-flagger is visible rather than merely tiresome — which is `sink_item.voices`'
argument in a different key: a bound that silently drops work reads from outside as a system
that missed one, so the number is shown.

What stops it being decided here: the peek is the user's window and the chime is their room.
Every other tool on this server spends tokens or disk; this one spends attention, and there is
no measurement that settles how much of that an agent should be allowed to take.
