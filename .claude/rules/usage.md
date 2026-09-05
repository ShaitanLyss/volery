---
paths:
  - "src/lib/usage.ts"
  - "src/lib/limits.ts"
  - "src/lib/ledger.svelte.ts"
  - "src/lib/Usage.svelte"
  - "src-tauri/src/usage.rs"
  - "src-tauri/src/limits.rs"
  - "tools/probe-usage.ts"
  - "src-tauri/examples/limits-probe.rs"
---

# What is left, and what it has cost

The other meter, and the one that reads a clock rather than a machine. It draws **two
readings of two different things**, and the knob picks which:

- **the allowance** — how much of the five-hour window and of the week is gone, and when each
  comes back. The account's own figures, off the endpoint the CLI's `/usage` reads.
  `limits.rs` asks, `limits.ts` decides, and it is the **default**.
- **what it has cost** — dollars or tokens over a five-hour block and the past week, inferred
  from the transcripts on this machine. `usage.rs` reads, `usage.ts` decides.

`Usage.svelte` draws both, and `ledger.svelte.ts` holds the one reader behind however many of
these are up (named for the class, since `usage.svelte.ts` beside the pure `usage.ts` is one
import specifier with two answers — the same trap `meter.svelte.ts` and `cycle.svelte.ts` are
named around).

They are two readings on one widget rather than two widgets, which is the opposite of the call
`azdo.md` makes for pipelines and reviews — and for the reason stated there. Runs and pull
requests are wanted on the wall *at the same time*; these two answer the same question at
different resolutions ("how am I doing against the limits"), and nobody wants both up at once.
So the variant rule holds: a different reading of the same subject is a knob.

#### What is left of the allowance

**This section is a reversal, and the thing it reversed is written down below rather than
deleted.** For most of this app's life the file said, in bold, that no percentage of an
allowance could be drawn anywhere, because no limit was knowable from this machine. That was
true about *transcripts* and false about the *account*: `rateLimits` really is null on every
record it appears on, and the endpoint Claude Code's own `/usage` reads was simply never
looked for. It was found by pulling the strings out of `claude.exe` — `/api/oauth/usage`,
alongside `api/claude_code/policy_limits` and the rest — and then called.

Probed 2026-08-17 against claude 2.1.229, a `team` plan at `default_claude_max_5x`, twice five
minutes apart; the five-hour figure moved 8% → 27% between the two, so it is live rather than
a daily rollup:

```text
GET https://api.anthropic.com/api/oauth/usage        Authorization: Bearer <the CLI's token>
five_hour  { utilization: 27, resets_at: "2026-08-17T11:39:59.968762+00:00" }
seven_day  { utilization: 10, resets_at: "2026-08-23T04:59:59.968782+00:00" }
limits: [ { kind: "session",       group: "session", percent: 27, severity: "normal", is_active: true  },
          { kind: "weekly_all",    group: "weekly",  percent: 10, severity: "normal", is_active: false },
          { kind: "weekly_scoped", group: "weekly",  percent: 0,  severity: "normal", is_active: false,
            scope: { model: { display_name: "Fable" } } } ]
```

- **`limits[]` is the shape to read, not the named keys.** The same response carried
  `seven_day_opus`, `seven_day_sonnet`, `seven_day_cowork`, `nimbus_quill`, `tangelo`,
  `iguana_necktie`, `amber_ladder`, `cinder_cove` and `omelette_promotional` — codenames for
  windows that mostly do not exist yet, all but one of them null. A reader keyed on names would
  show nothing for whichever one the account is eventually given, and `nimbus_quill` was
  non-null *and* absent from `limits[]`, so the two disagree already. `limits[]` is the
  projection the CLI's own readout maps over, it carries `scope.model.display_name` for the
  scoped rows, and a window added next month arrives in it already labelled. The named keys are
  kept only as a fallback for the two that have always been there — losing the scoped windows
  to an older server is acceptable, losing the five-hour one is not.
- **`cargo run --example limits-probe` is how any of this is re-checked**, and is the
  convention `tools/probe-context.ts` sets: when the question is "what does this service
  really do", drive it with the app's exact client. It prints `limits[]` beside the named keys,
  so the argument above can be tested against the account rather than believed. Two things only
  it can answer. **The TLS one** — this network signs certificates with a Netskope CA that is in
  the Windows store and in no bundled root set (`azdo.md` has the whole of it), so a client
  built the obvious way fails here and works perfectly at home; curl or PowerShell proving the
  endpoint works proves nothing, since those go through schannel. The probe is what shows
  `ureq` with `native-certs` reaches `api.anthropic.com` and not merely `dev.azure.com`.
  **The shape one** — the codenames move, and a null placeholder becoming real is a change
  nothing in the type system will announce.
- **The token is read and never refreshed**, and that is a correctness rule rather than
  laziness. `~/.claude/.credentials.json` holds an access token *and* a refresh token, and
  spending the refresh token rotates it — so a Skein that refreshed would race the CLI for the
  one credential both of them sign in with, and the loser is signed out. Skein is a reader
  here: an expired token is reported as expired and picked up on a later pass, which costs
  nothing, because anything that makes this wall interesting also makes the CLI refresh within
  the hour. The file is re-read on every call, so the recovery is automatic and needs no event.
- **Nothing about the credential leaves `limits.rs`.** Not into a fault string, not into the
  snapshot, not into a log. `source` says *where* the token was found and never a fragment of
  it — the rule `azdo.md` states, for the reason it states it: a snapshot gets written to a
  file.
- **An account with no OAuth sign-in has no windows of this kind at all** — Bedrock, Vertex, a
  bare API key — and that is not a fault. It is why the cost reading stays rather than being
  replaced: it is the only one of the three available on such an account, and a widget drawing
  a confident 0% would be worse than one saying it cannot see.
- **`is_active` is not "the one that will stop you".** It marks the window the server considers
  binding *right now*, which on a quiet account is the five-hour one at 8% while the week sits
  at 94%. A single account's header counts down whichever window is **fullest** (`binding`),
  since that is the one that runs out first and the question the widget is hung up to answer.
  The per-account rows do not — see `speaksWith` below, which is the same argument reaching a
  different answer because the question changes with several subscriptions on one face.
- **Our thresholds and the server's `severity`, whichever is worse.** Amber from three
  quarters, rust from nine tenths, because `severity` reads `normal` right up until the server
  decides otherwise and a window at 89% is worth a colour before anybody official says so. The
  server's word is taken when it is *worse*, because it knows things this does not — an
  org-level restriction, a spend limit, a rejection already issued. Taking the worse of the two
  is the only combination where neither source can talk the other into drawing something calm
  that is not.
- **This is the one place colour is spent on a number.** Colour on this wall is status, and an
  allowance running out is status in the strictest sense — the same amber and rust a card
  wears, meaning the same thing. Calm takes no colour at all, which is what keeps the other two
  worth noticing.
- **A percentage is floored, never rounded to nearest**, so nothing ever reads `100%` while
  there is allowance left to spend. Whole numbers throughout: the server reports a decimal and
  a widget redrawing `27.4%` → `27.5%` would be drawing attention to nothing.
- **`until` is not `left`.** A weekly window is five days out, and `usage.ts::left` would print
  `142h 12m`. Days are the unit above a day; below one the two are worded identically, because
  they sit on the same face and must not disagree about what four hours is called.
- **The two halves are watched apart, and paid for apart.** `Ledger.attach` takes *which*
  reading a widget wants, so a wall showing the allowance never walks a week of transcripts —
  208 MB on the first pass — for a number nothing on screen is looking at. Turning the knob
  re-attaches and `#retime` starts or stops only the half that changed. The last widget to stop
  asking calls `release_limits`, the way `release_azdo` works: a wall with nothing watching
  holds no token.
- **A failed ask leaves the last reading standing and says `stale`.** A percentage does not
  become wrong because the network went away for a minute, and blanking the one number this
  widget exists to show — over a blip, or over a sign-in the CLI is about to refresh by itself
  — is the worse answer. What must not happen is a stale figure passed off as current, so the
  fault is drawn beside it.
- **Three minutes, and a floor of one in Rust besides.** The cadence is what one *printed*
  percent costs: a five-hour window fills in three hundred minutes, so it moves a percent in
  three of them, and the face floors to whole numbers — anything quicker spends a request to
  redraw the same numeral. It was a minute, and that was arithmetic done wrong (a minute is a
  third of a percent, not one) until the endpoint said so out loud. The floor is in
  `limits.rs` so that however many widgets, the poll and the control surface's forced read all
  collapse to one request a minute at worst — and it is set *before* the call, so a request
  that takes ten seconds to time out cannot then go again immediately.
- **The endpoint counts asks, not answers, and `429` is what it says about it.** Seen
  2026-08-17 on a wall polling every minute. A rate limit is the one refusal that asking again
  makes worse, so it is not merely reported: `limits.rs` starts a *hush* — `Retry-After` if the
  server named one, otherwise a minute doubling per refusal to a cap of thirty — and while it
  lasts nothing goes near the network, whether or not a reading is in hand. An answer clears
  it, so an unrelated refusal a fortnight later does not start at half an hour. A 5xx hushes
  the same way and for the same reason: a server saying it is overloaded is saying the same
  thing, and a five-minute outage polled at the usual cadence is a hundred requests that could
  not have been answered.
- **The hush survives `release_limits`, and that is the whole of what makes it a hush.** What
  a detach could clear, a widget's knob could clear — turning the usage knob to the cost
  reading and back is exactly the gesture somebody makes on seeing the allowance stuck, and it
  would have reset the backoff and re-asked, every time. So the reading is dropped on release
  and the endpoint's bookkeeping is kept: when it was last asked, how long the hush is, and
  the sentence it refused with. None of it is a credential. The floor is kept for the same
  reason and closes the same hole from the other side — inside it with no reading held, the
  answer is a fault, not a request.
- **A hush is reported as a fault even though it is the healthy state.** It reaches the face
  as `stale` beside the last reading, with the wait in the tooltip ("rate limiting this poll —
  asking again in 8m"), because the alternative is handing back a held reading as though it
  were current, which is the one thing this half must never do. The front end goes on beating
  its three minutes into the hush and every beat is answered locally.
- **The reset stamp is not the transcripts' stamp.** Transcripts write milliseconds and `Z`;
  this endpoint writes microseconds and `+00:00`. `usage.rs::epoch_ms` is shared rather than
  copied — two date parsers is two places for a leap year to be wrong — and now reads a
  trailing `±HH:MM` properly. The offset is zero today and reading it anyway is the only thing
  standing between "harmless" and a countdown wrong by a timezone, which is precisely the
  failure this widget exists to prevent.
- **What it still cannot know is another machine** — but far less than before. The cost reading
  can only see turns taken here; the allowance is the *account's*, so a turn taken on a laptop
  counts against the percentages this draws. That is the single biggest thing the reversal
  bought.

#### Which account it is a reading of

A second knob, `account`, once the wall has any registered (`.claude/rules/accounts.md`).
`every account` is the default and leads, because with a waterfall the question is usually
about the wall rather than about one subscription — and because it is the only setting that
stays right when the account you were watching stops being the one being spent.

- **The wide face draws one line per account, not one per window.** Three subscriptions with
  three windows each is nine rows, and nine rows bury the thing being asked: which one is
  being spent, and how much is behind it. The footer names the account the next turn would go
  to, straight off the same `choose` the wall uses, so the two cannot disagree.
- **And each account speaks with its five-hour window, not its fullest.** It was `binding` —
  the fullest, whatever clock it runs on — which is right on a single account's header, the
  question `binding` was written for. It is wrong per account, and only shows up once there
  are several: the week fills over days while the five hours refill four times a day, so from
  about Wednesday the max *is* the weekly figure on every row, and the column reads the same at
  nine in the morning as at five in the afternoon. A number that does not move is a number
  nobody looks at, and what the max was hiding is exactly what the face is for — how much of
  this session each account has left. So `accounts.ts::speaksWith` sends the five hours, and
  the week speaks only when it has something the five hours cannot say: that the account is
  finished for the week whatever its session window reads.
- **A week that has run out is rust, whether it was the server's ceiling or yours**, and that
  is the one place this face colours a number `tierOf` would call calm. `speaksWith` asks
  `blockersFor` rather than re-deciding, so a face saying the week is spent and a wall holding
  work back cannot come to disagree — and that is what carries *your* cap, which the server's
  figures cannot show at all. A cap of 60 stops the account at 60%, and 60% in rust with no
  word about a cap is a face that looks broken, so the blocker travels to the tooltip and
  `sayCeiling` says which ceiling it was. Not `sayBlocked`: that one names the window, and the
  tooltip has already opened with it.
- **The header's countdown changes meaning on the wide face** and is the *first account to
  come back* rather than one account's fullest window — the same "first door to open" a hold
  counts down to in `skein.svelte.ts`. On a single account it is exactly what it was.
- **The knob is only on the allowance, and that is a limitation rather than a preference.**
  The allowance is the account's own figure and arrives per account off `/api/oauth/usage`,
  so scoping it is exact. Cost and tokens are inferred from the transcripts, and **a
  transcript does not record which subscription paid for a turn** — nothing in a record names
  a token. So an account knob on those two would be a filter that could not filter, and it is
  hidden by its `only` guard rather than offered and ignored, which is the rule `widgets.ts`
  already states about knobs that would do nothing. The `turn` table *could* answer it for
  Skein's own cards, and that is deliberately not offered: it would be a different question
  wearing the same numerals, which is the call this file already makes about scoping the
  widget to the studio.
- **The catalogue names a source rather than listing the accounts**, because it cannot know
  them — `WidgetParam.from` is a `Source`, resolved by the menu, the same bargain `only`
  strikes by being a declaration rather than a predicate. Two consequences worth keeping:
  `optionsOf` takes the resolved options as an argument so `widgets.ts` stays pure, and
  `normalizeParam` **does not clamp a sourced knob to its literal options** — an account
  registered after the widget was placed is not in that list, and clamping would read the
  value back as `every account` on the next launch, silently, with the face still claiming to
  show it. An unknown value is left standing and the face says the account is not in the
  order any more, which is the recoverable failure of the two.
- **With no accounts registered this widget is exactly what it was**: one reading of whoever
  Claude Code is signed in as, off `Ledger`. Once there are accounts, the allowance comes from
  `waterfall` — which the wall already polls — and `Ledger` is detached for that half, so the
  widget stops spending a request a minute on a signed-in account nothing is drawing.

#### What it has cost

- **It reads the transcripts, not Skein's own `turn` table**, and that is the whole design
  rather than a shortcut. The limits are per *account* and count every turn taken on this
  machine, terminal sessions included — and Skein's cards and a terminal's write to the same
  `~/.claude/projects/<slug>/*.jsonl` files, so one read covers both. The `turn` table knows
  only what this wall did, which is the wrong denominator for "am I about to be cut off", and
  carries zeros for in/out on every row written before `migrate_v7`. There is deliberately no
  `scope` knob like the process meter's: scoping to the studio would answer a different
  question with the same numerals, and `skein.spend` and the burn horizon already answer that
  one — off the `turn` table, over the local day, which is a third window again. See the last
  section here.
- **One API response is several records, all carrying the same `usage`.** A turn with a
  thinking block and a text block writes *two* `assistant` lines, and both repeat
  `message.usage` verbatim — the same numbers, not halves. Summed naively a reasoning turn
  counts two to five times over, so a line is folded in once per `message.id` + `requestId`,
  which is the pair identifying one request. Probed 2026-08-14 against claude 2.1.229's own
  transcripts, where the two blocks of one message differ in `uuid` alone. Measured over this
  machine's past eight days: **46% of all `assistant` records are duplicates** — 19,169 records
  for 10,323 requests — so without the dedup every figure here would read about 1.85x high.
- **Nothing may match on a bare field name**, because `usage.iterations[]` repeats
  `input_tokens` and friends per iteration. The record is parsed and read by path. The cheap
  gate before the parse is `"type":"assistant"`, which is most of what a pass costs — prompts,
  tool calls and Claude Code's own bookkeeping records carry no usage at all.
- **Cache writes are two prices and the file says which.**
  `cache_creation.ephemeral_5m_input_tokens` is 1.25x input and `…_1h_…` is 2x — a factor of
  1.6 between two numbers it would be easy to add together, which is the split `migrate_v7`
  had to make one level up. A record with no breakdown is charged at the cheaper rate rather
  than dropped: under-reporting is a smaller lie than losing the tokens.
- **`rateFor` guesses by tier rather than returning nothing.** A model released after the build
  shipped would otherwise price at zero, and a ledger silently reading zero for the model you
  are actually using is the one failure this widget must not have. Tiers have held their rate
  across every release so far, so guessing by tier is a much smaller error. A model matching no
  tier is counted as `unpriced` and said out loud on the face.
- **All five kinds of token are priced, and cache is most of the bill.** Input at the model's
  rate, output at its output rate, a cache read at 0.1x input, a five-minute cache write at
  1.25x and an hour one at 2x. Measured over this machine's past seven days on 2026-08-14:
  cache is **89% of the spend** — $852 of cache reads and $270 of hour-TTL writes against $132
  of output and $1.12 of input. A cost reading that ignored cache would not be slightly low, it
  would be out by a factor of nine. `tools/probe-usage.ts` prints that split, and it is the
  thing to re-run if the number ever looks wrong.
- **Cost leads tokens, and not for tidiness.** It is the only reading that weights those five
  against each other. The same seven days are 1.7B cache-read tokens against 5.3M of output, so
  a raw token total is 99.7% cache reads and says almost nothing about how hard the wall has
  been worked — which is why `tokens` is still offered but labelled `tokens processed` rather
  than anything about a limit. Cost was the widget's default until the allowance existed to
  take that place; it stays ahead of `tokens` in the menu, and it is the only one of the three
  an account with no OAuth sign-in can draw at all.
- **The two windows are not the same kind of thing.** The five-hour one is a *block*: it opens
  on the hour the first turn after a lull landed in and closes five hours later, which is why
  it has a reset worth printing. The weekly one is *rolling* — seven days back from now —
  because the real weekly window resets on a schedule tied to the account and nothing on this
  machine knows it. Inventing one would put a countdown on the wall wrong by up to a week. So
  the week says `past 7 days` and offers no reset, and `blocks()` needs no gap rule: a turn
  five hours after the last one is necessarily outside whatever block that one was in.
- **No percentage of an allowance is drawn from *this* reading**, and it used to be the whole
  file's rule rather than this section's. The argument was that no limit is knowable from here
  — `rateLimits` appears in the transcripts only on error records and is `null` on every one of
  them, and `stats-cache.json` is daily, stale, and maintained by nobody. Every clause of that
  is still true, and the conclusion was still wrong: it surveyed the *files* and stopped, and
  the account knew all along. See the section above. What survives is the narrower rule, which
  is the one that was doing the work: **a fraction is only ever drawn against something real**.
  This reading has no limit in it, so its bars go against the wall's own recent history — the
  block against the busiest *other* block of the past week, the week against the week before.
  Each says what it is measured against, and the measure reaches the reference too, or a bar in
  tokens would be drawn against a peak in dollars.

  Worth carrying past this file: the note was confident, detailed, correct in every particular,
  and load-bearing for a whole widget — and it had never been tested against the one question
  it was answering, which was "what does the CLI do when *it* prints this". `tools/probe-usage.ts`
  is the pattern for that question about a *file*; `strings` on the binary is the pattern for it
  about a *service*, and it took about a minute.
- **What it cannot know is another machine.** Turns taken elsewhere count against the same
  limits and leave nothing here to read. That was once the reason the widget reported what had
  been spent rather than what was left; it is now the reason this *half* of it does, and the
  allowance above has no such blind spot — those percentages are the account's, wherever the
  work was done.
- **A subagent's turns are in a different directory, and two levels is the wrong walk.** Every
  Task-tool agent gets its own transcript at `<slug>/<session>/subagents/agent-*.jsonl`, one
  level below the session that spawned it — 194 files out of 507 on this machine, 2026-08-14.
  They spend real tokens against the same limits, and the first cut of this widget missed all
  of them: the walk stopped at the session file, and the reading it produced still looked like a
  perfectly plausible number. Adding the recursion moved the eight-day cost from $1.8k to $2.0k
  and the five-minute cache writes from *zero* to 8.5M — so it was also hiding one of the two
  cache-write TTLs entirely. Recursing costs nothing where the two overlap, and they barely
  do: measured across every transcript on this machine, 24,158 unique requests appear in session
  files and 4,386 in subagent files, with **2** in both — and dedup is by request rather than by
  file, so those two are still counted once. `tools/probe-usage.ts` is what found the missing
  directory, and is the thing to re-run if these numbers ever look small.
- **Reading is incremental, and asked for.** Rust holds a byte offset per transcript, so the
  first pass reads whatever a week of work amounts to (~208 MB across 108 files here on
  2026-08-14) and every pass after it reads only what was appended. A file never opened whose
  mtime predates the window is skipped without being opened at all, which is what keeps that
  first pass to the week rather than to every session ever recorded — 476 MB across 507 files
  on this machine, 399 of them skipped. A partial last line is left unconsumed: the offset
  advances only over bytes that ended in a newline, or a write still in flight would be lost for
  good. And none of it happens until a widget attaches, the rule the process sampler already has.
- **Polling is the same deliberate exception the sampler is.** A turn taken in a terminal emits
  no event this app can hear — it appends to a file — and counting those turns is the whole
  point of reading files rather than the `turn` table. Twenty seconds, which moves a five-hour
  reading by a third of a percent.
- **The countdown runs on the wall's own one-second tick** (`clock` in
  `conversation.svelte.ts`), and `left()` changes about once a minute rather than ticking —
  the argument `Rest.svelte`'s `said` makes. A countdown you can watch is one you do watch.
- **`money` compares before it rounds.** Rounding first is what turns $999,999 into `$1000k`,
  six characters in a row of tabular numerals that must not reflow as the number grows.

The control surface has a `usage` op (`read: true` forces a reading rather than waiting out the
beat — the same `#tick` and `#askAllowance` the timers drive, and both obey the same rule of
reading nothing while nobody is watching), and `snapshot.ledger` reports both windows at *both*
measures, plus `watchers`, `ready`, `resting` and `unpriced`. Both measures because which one a
widget happens to be drawing is a property of that widget: a test that had to turn the `measure`
knob to read the other number would be testing the menu.

It reports the allowance beside them, as `allowance` — every window with its `kind`, `used`,
`tier`, `resetsAt` and `resetsIn`, plus `plan`, `source` and whether overage is on — and
`allowanceFault` apart from `fault`, because the two halves genuinely fail apart: a signed-out
account must not make the cost reading look broken. `allowance` is **null** rather than an
empty shape when nothing has answered yet, so "not asked" and "asked, and this account has no
such windows" stay distinguishable. No token and no fragment of one, ever; `source` says only
where the credential was found.

`scanning` and `asking` are reported apart from each other and from `watchers`, for the reason
`meter.sampling` is apart from the widget count — with the measure now part of the ask, a
widget set to the allowance runs no transcript pass at all and one set to cost makes no
request, so "something is watching" no longer implies either reader is running. A usage widget
with a stopped reader goes on drawing whatever it last saw and looks identical from outside.


## What a card may ask about the bill

`allowance`, on `ask.rs`'s server, and the one tool on it no other harness could offer:
nobody else holds the account. An agent deciding whether to fan out ten subagents or make one
careful pass is otherwise deciding blind, and finds out which it should have been by being cut
off in the middle of it.

- **It is a read, and free in the sense the billboard is free** — it costs the wall nothing and
  costs no other card a turn. Cheap to call as well: `report_with` is behind `FLOOR_MS` and the
  hush, so a card asking on every turn collapses into the same one request a minute the widgets
  already share.
- **The instruction is the point, not the number.** `advice_for` is a four-step ladder from
  *plenty* to *do the smallest correct thing and say the allowance is why*. A percentage with no
  advice attached gets read, agreed with, and then ignored — the agent does exactly what it was
  going to do, because nothing told it what a different number would have meant. It is pure so
  the ladder is tested.
- **And there are two ladders, because the reading is one account and the advice was about the
  wall.** The scoping above is right; the *prose around it* was not. "this is the binding one",
  "almost nothing is left", "do not fan out" are all claims about a wall, derived from one
  member of it, and on 2026-09-04 a card on a spent `personal` account believed them: it told
  the user to hold four and a half hours of work and declined to start anything, with two
  untouched subscriptions sitting behind it in the order (sink `0b4ba579`). The failure is worth
  naming precisely, because it is not a wrong number — every figure in that answer was correct.
  **A reading with no scope stated is read at the widest scope available**, and the widest scope
  an agent has in mind is the wall.

  So three things say the scope now, and none of them reads another account, which would undo
  the scoping. `scope_line` opens the answer with whose figures these are and how many usable
  accounts it passed over (`accounts::usable_labels`, the Rust mirror of `accounts.ts::usable`),
  and the same suffix is attached to the *failure* arm — "could not be read" is more likely to
  stop an agent than a high percentage is, and it was equally silent. `is_active` reads "the
  binding one **on this account**", three words that stop a window binding a card from reading
  as a window binding the wall. And `advice_for` takes the count: alone, the strict ladder is
  the one that was always right; with another account usable, every rung says *expect a swap*
  and none of them may say anything an agent would down tools over — which is asserted directly,
  against the four phrases that actually did it. The tool's own description lost its definite
  article for the same reason; it is where an agent forms its expectation of what the number
  covers.
- **A rolling day, not "today".** `spend_since`'s cutoff comes from the front end because the
  timezone lives there; nothing in Rust knows where midnight is, and a guessed one is wrong
  twice a year and every morning before breakfast. `store::spend_over` takes the window instead
  — which is the more useful reading here anyway, since an agent wants to know what this wall
  has been costing lately rather than what a calendar says.
- **It reports the asking card's own account, and for a long time it did not.** `do_allowance`
  passed `""` to `report_with` — the label meaning *the CLI's own sign-in* — for every caller,
  so a card spawned on a registered account was handed a reading of a subscription it was not
  spending. `limits::handle` was the one handler on `ask.rs`'s chain not taking a
  `conversation_id`, which is what made the wrong answer the only answer available; every
  sibling — `relay`, `board`, `sink`, `later`, `pin`, `spawn` — already took it.
  `store::account_of` is the lookup, and a card with no account of its own still resolves to
  `""`, because that is what `account_label = NULL` means and what `token` already reads it as.
  **The reading now names the account it is a reading of** (`report.source`), which it never did
  — unmissed only while there was one possible answer.
- **An account with no subscription windows is told so, and the cause is handed over as the
  cause.** Bedrock, Vertex, a bare API key: there is no window to run out of, and answering
  "0% used" would have the agent spend against an allowance that does not exist. But that arm
  used to *assert* per-token billing as the explanation for any failure to read, and combined
  with the account bug it produced the confident wrong answer this whole entry exists for: a
  card on a named account asked what it could afford, was told its plan did not exist and that
  this was "normal for an account billed per token", and reported that to the user as a fact
  about their billing. It was a fact about a label. Per-token is now offered as one reading
  beside the other one — an expired or absent sign-in looks identical from here — and the tool
  says not to report per-token billing on the strength of that line alone. Same distinction
  `accounts.ts::standingOf` draws and for the same reason: "full" and "could not be asked" are
  answered completely differently, and collapsing them answers the wrong question.
- **Overage inverts the reading and has to be said.** A window pinned at 100% with past-plan
  usage enabled is not a stop, it is a bill. An agent told only the percentage reports to the
  user that it has been cut off while the work is in fact going through and being charged for.
- **Blocking on the request's own thread, with no `off_main`.** `ask::start` gives every MCP
  request a thread of its own — the parked question needed that — so the network call here is
  nobody's main thread. The `#[tauri::command]` beside it still needs `off_main`, and the note
  there says why; the two arms of the same reading want opposite treatment and that is worth
  knowing before moving either.
- **It says not to call it every turn.** A tool that is cheap and interesting is one an agent
  will reach for out of habit, and this one answers a question about a *plan* — which does not
  change between one edit and the next.

## The other figure: the day, and the horizon

The title bar's `$12.34` and the warmth in the ground (`--burn`, `.studio::after`) are a
different reading with the same units, and `usage.ts::dayStart` is the only part of it that
lives here — the rest is `Skein.spend` and `store.rs::spend_since`. Three ways it differs
from the widget above: it is **this studio's** turns rather than the account's, it comes off
the `turn` table rather than the transcripts, and its window is the **local day**.

- **It was the session, and that made it a reading of how long Skein had been open.** The
  figure was a sum of `costUsd` over the cards currently on the wall, so a restart put the
  ground back to cold and the number back to nothing — the horizon exists to say "today is
  getting expensive", and it was being reset by the gesture most likely to follow a heavy
  morning. Closing a card took its spend off the wall too. Reading `turn` instead fixes all
  three at once, since every settled turn has always written what it cost.
- **Local, so it cannot be `now - (now % DAY)`.** That is midnight UTC, which is the middle
  of the afternoon here. Nor `now - offset`: that asks the offset in force *now* and applies
  it to a moment before a changeover may have happened, which lands an hour out on the two
  days a year a timezone moves. `Date.setHours(0,0,0,0)` resolves it against the calendar.
- **The cutoff is an argument to Rust, not a decision it makes.** The timezone is front-end
  knowledge, and a wall left open overnight has to roll over anyway — so the boundary is a
  moving argument either way. `Skein.dayTick` notices, off the wall's existing one-second
  tick rather than a timer of its own.
- **The table is the only source.** A settled turn moves the figure by being *recorded* —
  `#persistConv` chains the re-read onto `record_turn` rather than adding the amount here as
  well, or the two would drift and only one of them would survive a launch. A failed read
  leaves the last figure up: a day that could not be read is not a day that cost nothing,
  and the ground going cold would say it was.
- **A row that is not a turn says so, and says it in a column rather than a table.** A
  `result` can carry a cost step and no turn behind it: the CLI answers `/compact`, `/model`
  and `/effort` itself, reporting `num_turns: 0` and an all-zero `usage`. The cost is honest —
  `total_cost_usd` is a running total of the *process*, so the step is whatever accumulated
  since the last `result` that had a turn of its own — but the row written for it said a turn
  had cost $13.52 and processed nothing. Measured over the 696 rows written here since
  `migrate_v7` began recording tokens at all: **101 carry no tokens, 14 of them carry real
  money, $148.08 between them.** Schema v25 adds `turn.kind`; `usage.ts::turnRowKind` decides,
  and `#persistConv` reads it, since that method already holds both the folded counts and the
  raw `result`.

  Three decisions, and the distribution of that money is what settles all of them.

  - **`num_turns` is the discriminator, and it is exact rather than a heuristic.** It counts
    round trips to a model, so zero means none was reached — which means no tokens were spent
    *in this turn*, and the cost step is therefore money from earlier. Same field
    `classify.ts::localAnswer` already trusts, and the tokens are consulted only ever to
    override it *towards* `turn`: a row with real tokens filed as "no turn happened" destroys
    information, where the arm it guards merely mislabels. Anything other than a literal zero
    — `undefined` included — is a turn, so a CLI that stops sending the field falls back
    exactly to the behaviour this replaced. Note what is deliberately not narrowed: a turn
    that reached a model and *then* failed reports `num_turns >= 1` and its own tokens, so it
    stays a turn row, which is what `turns.md`'s "the failed attempt is still a turn"
    requires.
  - **A column on `turn`, not a table of its own — and the tidier shape is the wrong one.**
    A separate table reads better and puts the hazard the wrong way round: forgetting to
    filter costs a slightly noisy reading, forgetting to UNION loses a day's money silently.
    On 2026-08-22 this wall's table holds exactly two no-token rows, $71.31 and $38.64, and
    **they are the whole of that day's figure** — $109.95 out of $109.95. So `spend_row` goes
    on summing every kind, needs no change to do it, and *cannot be forgotten*; a
    `WHERE kind = 'turn'` there would have reported that day as free. The general shape:
    **when one of two mistakes is silent and expensive, pick the arrangement where the
    forgetful path is the cheap one.**
  - **The default is `'unknown'`, and there is no backfill.** `'turn'` is what almost every
    existing row is and it would *assert* that, for 101 rows some of which are exactly the
    ones the column exists to distinguish. Worse, the symptom is not the cause:
    `in_tokens = 0 AND …` also matches every row written before `migrate_v7`, which carries
    zeros because nothing wrote the columns yet and *was* an ordinary turn. `num_turns` is
    recorded nowhere, so for a row already on disk the cause is genuinely unknowable, and
    inferring it would replace a readable lie with an unreadable one. `migrate_v2` could
    backfill because it had the `turn` table to recover *from*; this has nothing. Historical
    rows stay exactly as readable as they were, which costs nothing.

- **The row is still written for a locally-answered result, and `roster`'s `MAX(ended_at)`
  still counts it.** Skipping the row is the obvious economy — 87 of those 101 carry no money
  either, pure noise from slash commands — and it would change something else by the back
  door. `last_turn_at` feeds `relay.rs`'s `idle_seconds`, which an agent reads as *how long
  since this card did anything*; a card that answered `/compact` a minute ago is demonstrably
  alive, and filtering would report it idle for however long the compaction ran. What a row
  *cost* and whether the card was *awake* are two questions, and only the first is what
  `kind` answers.

- **The label costs a label and never a row.** `record_turn` takes `kind` as an `Option` and
  falls to `'unknown'`. Tauri drops a key it does not recognise — the `lastTier` bug — and a
  required `String` would then fail the whole command, whose caller swallows errors: no row,
  and the money gone from the day's figure that this table is the only source of. Same shape
  as `chat.md`'s "unknown falls to `project`": both directions are wrong, and this is the one
  whose symptom is visible in the data rather than absent from it.

- **No index on `turn.ended_at`.** One row per settled turn, summed as a turn settles and
  once when the day rolls; an index would cost a migration to save a fraction of a
  millisecond.
- **`snapshot.spendSince` is reported beside `spend`**, because a day's total and a session's
  are the same lone number from outside and only the cutoff says which window this one is.
