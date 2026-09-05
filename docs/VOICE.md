# Three designs for talking to the wall

Design work done 2026-09-05 by card `28e9a1f1`, from the request: *voice, both to talk to a
card and to navigate the app* — with five examples, which turn out to matter more than the
request's prose because between them they name every kind of thing a spoken sentence has to be
able to point at:

```text
open a card in project caravan
send the following messages to cards A and B: halt work
select card A
record a new sink item for volery: I noticed an issue where …
open image.png in caravan            ← find it in caravan's folder, show it in the file viewer
```

**Nothing here is built and nothing here is measured.** Every latency, every CPU figure and
every claim about what WebView2 or Windows' own recogniser will do is marked as an unknown with
the probe that would answer it — see *Unknowns* at the end. The pattern is
`docs/TOOL-SURFACE.md`: three shapes, their costs, and a recommendation that is a
recommendation and not a default.

The three are genuinely different in *where the understanding happens*, which is the axis that
decides everything else — the dependency graph, whether it spends money, whether it can be
tested in Bun, and what happens when it mishears:

| | understanding | acts by | offline | costs per utterance | testable |
|---|---|---|---|---|---|
| **1. The spoken draft** | a closed grammar, in a pure module | filling the draft | yes | nothing | Bun |
| **2. The steward** | an agent turn holding the wall's verbs | proposing a plan | no | a request | no |
| **3. The wall listens** | either of the above, underneath | addressing by name | yes | nothing | partly |

Design 3 composes with 1 or 2 — it is a design about the *channel* rather than about the
parsing. They are presented as three because choosing between them is three different bets
about what voice is for, and the cheapest one to build is not obviously the wrong one.

---

## What was decided, 2026-09-05

**Design 3 is the channel and Design 2 is the interpreter. The grammar stays, as a fast path
rather than as the product.** In the user's own terms: *"I don't think 1 will be good enough, I
want to be able to speak quite naturally, possibly do several commands in one — however I think
it's worth exploring 1 rather than jumping straight to agent call. I also want 3, the wall
listens."*

Two things in that reply change what is written below, and both are corrections rather than
additions.

**The cost of Design 2 was mispriced.** This file argued it in money. It is a subscription, so
the cost is *allowance* — and that is not a softer version of the same objection, it is a
different objection, because **the wall already measures allowance and money it never
measured.** `limits.ts` reads the account's own windows off `/api/oauth/usage` and already
answers `binding()`, `tierOf()`, `resetIn()` and `why()`; the horizon and the title-bar figure
already draw it. So the steward's cost lands in an instrument that is on the wall today, and
the degradation writes itself: **when the binding window goes `urgent`, the ladder stops
escalating and the grammar becomes the whole of it**, with the wall saying so rather than going
quiet. That is a feature, and it needs no new measurement. (It must read the same waterfall
`accounts.rs` does — with several subscriptions signed in, a spent window is often a swap
rather than a wall, and a voice layer that gave up on the first `urgent` would be giving up
early.)

**"Several commands in one" makes the unit a plan, not an op.** Everything below that talks
about *an op* being confirmed or run is wrong by one level. The unit is an ordered list.

### The ladder, and the rule that decides the rung

```text
audio ──▶ address matched offline ──▶ grammar ──▶ accounted for the whole utterance?
                                                   ├─ yes ─▶ plan, now, free
                                                   └─ no  ─▶ steward ─▶ plan
                                                                        │
                                        ┌───────────────────────────────┘
                                        ▼
                        every op only changes how you look?
                          ├─ yes ─▶ run it
                          └─ no  ─▶ speak the plan back, confirm, then run
```

**The escalation rule is that the grammar answers only when it can account for the entire
utterance.** Leftover words escalate. This is not a new rule either — it is
`resolveCommand`'s *exact-and-whole* clause from `commands.md`, one layer up, and it exists
there for the identical reason:

> The exact-and-whole rule is there because reading `/clear` out of `/clear the deck` would
> throw away the rest of what was typed.

A grammar that matched *"select card A"* out of *"select card A and open image.png in
caravan"* would do exactly that, and silently. So a partial match is not a match. That single
rule is what makes the two rungs safe to stack: the grammar cannot half-understand, so
anything it does answer is complete, and everything else is the steward's. It is also why the
grammar being rigid stops mattering — rigidity is only a cost when there is nothing underneath.

What the grammar is *for*, under this arrangement, is narrower and much more defensible than
being the product: **the utterances that must not cost a round trip.** *"select card A"*,
*"stop"*, *"fit the wall"*, *"open image dot png in caravan"* — gestures whose whole value is
being instant, where a two-second parse would make voice worse than the mouse it replaces. It
should be small on purpose. Ten or fifteen entries, not fifty.

### A plan is the unit, and it is one gesture

```ts
type Plan = {
  /** In order. A plan is ordered even when the ops commute — you said them in an order. */
  steps: { op: string; args: Record<string, unknown>; said: string }[];
  /** The whole plan in one sentence, for speaking back. Built from `said`, never by a model. */
  reads: string;
  /** The strictest disposition among the steps. One confirm for the plan, never one per step. */
  needs: "nothing" | "confirmation";
};
```

Four rules, and each of them is a decision this file is making rather than reporting:

- **One confirm for the plan, and the strictest step decides it.** *"Select card A and tell
  caravan to halt"* is one confirm, not a free op followed by a question. Confirming twice for
  one sentence is how a person learns to stop using a feature.
- **No half-execution, ever.** If step three of five fails, the wall stops there and says which
  step and why. The alternative — carrying on down the list — produces a wall in a state
  nobody asked for, and the only thing worse than a misheard command is half of one.
- **A plan is one entry in whatever remembers gestures**, the way a drag is one press
  (`undo.md`). Note this is mostly moot, given the boundary above: the steps a plan may run
  without asking are precisely the ones the undo stack refuses. Which is the point — there is
  nothing to take back because nothing was changed.
- **`reads` is templated from the plan's own data, never composed by a model.** *"send 'halt
  work' to caravan and the auth work — yes?"* is a template over structured fields. It is free,
  instant, deterministic, and identical every time, and a confirmation you have heard the same
  way fifty times is one you can act on without listening hard. Only *answers to questions*
  (*"what is card three doing?"*) need a model to write prose, and those are the case where
  spending a turn on the wording is the whole point.

### What the parse costs, and which model should do it

The steward's job is not reasoning. It is **natural language to an ordered list of ops with
resolved referents against a known wall** — structured extraction with a closed schema, which
is the task class small models are best at. So: **Haiku 4.5 (`claude-haiku-4-5-20251001`)
first**, for latency as much as for allowance, with Sonnet as the fallback if compound
utterances or ambiguous referents parse badly. That ordering is a guess about parse quality and
should be measured before it is believed — the probe is at the end.

This also settles the shape question left open under Design 2 below. A fork of the addressed
card (`aside.rs`'s mechanism) inherits that card's model, which for a wall of Opus cards is the
wrong one for this job by a wide margin. So the steward wants to be **its own spawn with its own
`--model`**, not a fork — which costs the `/btw` machinery but buys the model choice, and the
model choice is worth more.

### Latency, and what is drawn across it

Design 3's address is matched offline and is therefore instant; the parse is not. So the gap
between *"caravan,"* and anything happening is the one thing that will decide whether this feels
good, and it has to be drawn:

1. **The address lands immediately** — the card lights the moment its name is heard, before a
   single word of payload. This is free, and it is most of the perceived responsiveness.
2. **The partial transcript draws as it arrives**, under the addressed card. `glass.ts` already
   sticks a thing to a pane in screen space without moving where it is.
3. **The parse is `busy`-shaped, not `working`-shaped.** `turns.md` already separates these —
   *"`busy` is a second question, not a widening of `working`"* — and a steward parse is work
   running with no turn open, which is `busy` exactly.
4. **Then the plan is spoken and drawn together**, because a confirmation you can only hear is
   no use at the wall and one you can only see is no use across the room.

### What is now unresolved, and was not before

- **Barge-in.** With an always-on channel *and* a wall that speaks, the recogniser will hear
  the wall. It must not act on its own voice, and it must stop talking when you start. Neither
  is hard; both are easy to forget until they happen.
- **Ducking librespot.** The wall plays music through the same device (`spotify.md`). Speaking
  over it needs a duck, and the volume control is already there.
- **Whether a misparse is worth a correction turn.** *"No, the other caravan"* is a second
  round trip to fix a first one. The cheap answer is that a rejected confirmation drops the
  plan and says nothing further, and you say it again. Worth trying that before building
  anything cleverer.

---

## The five examples are one shape, and it is not a grammar of sentences

The instinct is to read the examples as five sentence patterns and start writing a grammar.
They are not. Every one of them is

```text
verb + referent(s) + optional payload
```

and the verbs are the easy half — they are a closed list of about twenty, they already exist as
ops, and no two of them are confusable by ear. **The whole difficulty is in the referents**, and
the five examples between them name four kinds:

| kind | in the examples | how it is resolved today |
|---|---|---|
| **a card** | *card A*, *cards A and B* | `#card()` — id, exact title, substring of title, substring of project, or 1-based index |
| **a territory** | *project caravan*, *for volery* | `Region { project, cwd }` in `layout.ts` — folder name → root |
| **a file inside a territory** | *image.png in caravan* | `finding.ts::rank()` over the project's file list, then `finder.lookAt(cwd, path)` |
| **prose, taken verbatim** | *halt work*, *I noticed an issue where …* | nothing resolves it; the whole point is that it is not matched against anything |

So the right factoring for the pure module is **one resolver per referent kind plus a small
verb table** — not a sentence grammar. That matters for three reasons: each resolver is
independently testable against a fixed wall; three of the four already exist and are already
tested; and the fourth kind (prose) is defined by *not* being resolved, which is the safety
property everything below is built on.

It also reframes what the designs disagree about. They do not disagree about verbs. They
disagree about **who decides where the referents stop and the prose begins** — a marker in the
language, a model, or a pause.

---

## What is already here, which is most of it

This is the part that changes the shape of the problem, and it was not obvious before reading.

### The wall already has a verb bus, and it already resolves names the way a voice would

`src/lib/control.svelte.ts` holds a table of **~90 ops** covering nearly every gesture on the
wall: `open`, `chat`, `send`, `broadcast`, `stop`, `select`, `pick`, `focus`, `deselect`,
`type`, `submit`, `rename`, `clear`, `close`, `aside`, `rouse`, `answer`, `post`, `unpost`,
`viewport`, `fit`, `glass`, `place`, `timer.set`, `widget.add`, `find`, `shell`, `action`,
`undo`, `redo`. Every example in the request is an op that exists, except one (below).

And `#card(op)` — the resolver every card-taking op goes through — already answers *by id, by
exact title, by substring of title, by substring of project, or by 1-based index on the wall*.
Its own comment says why it exists: `Tests read better as {"card": "caravan"} than as a pasted
uuid.` That is the same sentence a voice layer would write. Territories resolve just as
cheaply: `Region { project, cwd }` in `layout.ts` names a territory by its folder name and
carries its root, so *"project caravan"* → `cwd` needs nothing new.

**But a voice layer must not be a client of the control surface**, and this is worth stating
before anybody reaches for the obvious shortcut. That surface is off unless `SKEIN_CONTROL=1`,
binds loopback, writes a token file into `%APPDATA%`, and lights a chip in the title bar
announcing that the app is being driven from outside. It is test plumbing, deliberately, and
arming it in every install to give voice somewhere to POST would be a new listening socket
nobody asked for. What voice should take is the **shape** of that table and its `ControlHost`
interface — the same in-process seam, reached directly. `control.md`'s first rule is the one
that transfers: *drive the app's own seams, not its internals*, and never build a parallel
path.

The `ControlHost` type is, almost exactly, the interface a voice layer wants: `setFocused`,
`deselect`, `draft`/`setDraft`, `targets`, `submit`, `openIn`, `openChat`, `flags`/`setFlag`,
`shellCwd`, plus handles on `skein`, `studio`, `board`, `widgets`, `undo`, `finder`, `shell`.
It was written to be *"the handles a pair of hands would have"*. A voice is a pair of hands.

### The file viewer is already reachable by name, and its scorer already expects spoken input

The fifth example looked like the one that would need the most new machinery. It needs none.

- **`find look-at` already takes exactly the arguments the sentence carries.**
  `finder.lookAt(cwd, path, line)` opens a file in the viewer against a named root, and the op
  is in the table. *"open image.png in caravan"* is `lookAt(caravansCwd, "…/image.png", null)`.
- **The viewer draws images.** `finding.ts::IMAGES` covers png, jpg, jpeg, gif, webp, bmp, ico,
  avif, and `find.rs::read_media` hands them over as data URLs. So *show it in the file viewer*
  is the existing behaviour, not a request for a new one.
- **The candidate list is already in the front end.** `finding.md`: *a file list fetched once
  and scored here*. So matching a spoken filename costs no round trip and can happen inside the
  pure module.
- **And `score()` already treats the query the way a mouth produces one.** This is the lucky
  part. Its own comment:

  > A space in the query is a separator between terms rather than something to find — nobody is
  > looking for a path with a space in it by typing the space.

  A spoken path has precisely that shape. Speech-to-text renders `src/assets/image.png` as
  something like `image png` or `assets image png`, with the separators gone and spaces in
  their place — and `score("src/assets/image.png", "image png")` matches as a subsequence with
  the space skipped, with the basename bonus doing the rest. **The scorer built for typed
  queries is already the right scorer for spoken ones**, and it is pure and tested.

  The one thing needed on top is about ten lines of normalisation in `voice.ts`, because an
  engine will sometimes give you the separators as *words*: `dot` → `.`, `dash`/`hyphen` → `-`,
  `underscore` → `_`, `slash` → `/`, and spelled-out extensions (`P N G`) collapsed. Left
  unnormalised, `"image dot png"` still often matches — `d`, `o`, `t` are a subsequence of most
  paths — but it misranks, which is worse than failing.

### One gap, and it is the fourth example

There is **no `sink` op**. `sink.svelte.ts` has `add(title, body, kind, paths, projectId)` and
`Basin.svelte` has a compose draft, so *"record a new sink item"* has a real target — it simply
has no entry in the verb table. Adding one is the same one-line-plus-one-arm shape that
`commands.md` describes for adding a slash command. Worth knowing that the request's fourth
example is the one that needs new surface, and that it needs very little.

### The law voice should obey is already argued, for slash commands

`commands.md`:

> **Skein reads only its own names, and this is a safety property rather than a
> simplification.** […] An unknown name therefore matches nothing, opens no palette, and is
> sent as the prompt it is.

That is the correct law for voice, already reasoned out in this codebase for the identical
situation: a channel that both *commands the app* and *carries prose to an agent* must fall
through to prose on anything it does not certainly recognise. Swallowing a misheard sentence
is worse than not understanding it, because the failure is silent and the words are gone.

### The confirm surface exists, and so does the taking-back

`Ask.svelte` + `asking.ts` park a question against a card with options, several questions in
one call, and design previews. `undo.ts` takes back four realms of gesture with one shape. Any
design below that needs *"did you mean…"* or *"that was not what I said"* has both already.

### The destructive gesture is already priced, and voice is the least precise input on the wall

Project cards spawn with `--dangerously-skip-permissions`. The dock therefore charges
Ctrl+Enter for a broadcast and warns when targets share a working tree. A misheard broadcast
is the worst outcome available in this application, and every design below has to answer for
it. They answer differently, and that difference is most of what separates them.

### Capture belongs in Rust, and it is nearly free

**`cpal 0.16.0` is already in `Cargo.lock`**, pulled in by `librespot-playback`'s rodio
backend. WASAPI *input* is the same crate as the output already being used, so microphone
capture costs no new dependency and — critically — **no C toolchain**, which `build.md` says
is the constraint that decides whether this repo can still be built on a machine without MSVC.

The alternative, `getUserMedia` in the webview, is worse on three counts: WebView2's permission
behaviour inside a wry window is unverified here and its failure mode is a silently rejected
promise; the recognition half of the Web Speech API (`webkitSpeechRecognition`) is a
Chrome-branded feature that reaches Google's servers and is very likely absent from WebView2
entirely; and audio arriving in the front end would have to be shipped back down to Rust
anyway for any local engine. **Capture in Rust, in every design.** The webview's *output* half
(`speechSynthesis`) is a different question with a different likely answer — see *Unknowns*.

### And the key it is held down with has a ladder to join

`App.svelte`'s `onGlobalKey` is a documented ordering, and Alt+I's comment sets the bar for a
binding that fires *while you are typing*: `Alt+letter is not a text gesture Chromium binds,
and this window has no menu bar for it to collide with`. A voice key must clear the same bar.

But note the sharper problem: **a binding inside this window only works when this window has
focus**, and the whole point of a wall you can talk to is running it while your hands are in
Houdini on the other monitor. That wants a system-wide hotkey — `tauri-plugin-global-shortcut`,
not currently a dependency — or, in Design 3, no key at all.

---

## Design 1 — The spoken draft

> Voice never acts. It types.

Hold a key, speak, and what you said lands in the dock's draft. A small **closed grammar** is
read off the *front* of the utterance and nothing else; anything it does not recognise stays
prose, exactly as an unknown `/name` does today. The draft is the staging area, so you see what
it heard before anything happens, and Enter is still Enter.

### The parts

- **`src/lib/voice.ts`, pure**, per the purity boundary, with `test/voice.test.ts` added to the
  `test` script. One function is the whole of it:

  ```ts
  hear(utterance: string, wall: WallFacts): Heard
  // { kind: "prose", text }
  // { kind: "op", op: string, args: Record<string, unknown>, tail?: string }
  ```

  `WallFacts` is the names it may match against — card titles, territory names, widget kinds —
  passed in rather than imported, so the module stays pure and the resolution is testable
  against a fixed wall.

- **The resolver is lifted out of `#card()` into `voice.ts` and shared.** It is already the
  right function; today it is a private method on the control surface with no test of its own.
  Both callers get better: the op table stops owning name resolution, and the resolution grows
  a suite.

- **Ordinals and places, because a generated title is a bad spoken handle.** Card titles come
  from Claude Code (`#adoptAiTitle`), are up to 42 characters of arbitrary prose, and *change
  under you* when a turn settles. Speech-to-text will mishear them. So the grammar takes
  `"card three"` and `"the third card"` (the index resolution `#card` already has) alongside
  names, and `/rename` — which exists, and whose `named_by_hand` column already stops the
  transcript taking a name back — is how a card gets a handle you can actually say.

- **The payload boundary is marked, and this is the one genuinely hard part.** Speech-to-text
  hands over a flat string: *"record a new sink item for volery I noticed an issue where the
  ring pegs at a hundred percent"* has no colon in it. The grammar therefore ends the command
  at an explicit spoken separator — `saying`, `telling them`, `colon`, `quote` — and everything
  after it is the tail, taken verbatim and never matched against anything:

  ```text
  send to caravan and the auth work saying halt work
    → { op: "broadcast", args: { cards: ["caravan", "the auth work"] }, tail: "halt work" }

  record a sink item for volery saying the ring pegs at a hundred percent
    → { op: "sink.add", args: { project: "volery" }, tail: "the ring pegs at …" }

  open a card in project caravan
    → { op: "open", args: { dir: "<caravan's cwd>" } }

  select card A
    → { op: "select", args: { cards: ["A"] } }

  open image dot png in caravan
    → { op: "find", args: { do: "look-at", cwd: "<caravan's cwd>",
                            path: "src/assets/image.png" } }
    // resolved by rank() over caravan's file list — see the scorer note above.
    // Ambiguity here is *not* an error: two candidates open the finder with the
    // query already typed, which is the panel's own job and one keystroke from done.

  the ring pegs at a hundred percent and I cannot see why
    → { kind: "prose" }        // no name matched — it is a thing to say to an agent
  ```

  If the engine reports pause boundaries, a long pause is a second separator. Unmarked
  utterances with no recognised head are prose, always.

- **Nothing executes on the strength of an utterance.** A recognised op becomes a **staged
  line in the dock**, drawn as the sentence it will carry out, with the cards it will touch lit
  on the wall behind it. Enter runs it; Escape drops the staging and *keeps the words as prose*
  — the same bargain the command palette already strikes, for the same reason. Destructive ops
  keep their existing modifier: a spoken broadcast is still Ctrl+Enter.

- **Speech-to-text, and the grammar makes the cheap engine viable.** Two candidates, and this
  design can use *both*, chosen by which half of the utterance it is in:
  - **Windows' own `SpeechRecognizer` with a list/grammar constraint** is on-device, needs no
    model file, and is reached through a feature flag on the `windows` crate already in the
    tree. It is good at exactly one task: matching against a closed set. That is the command
    half.
  - **Local Whisper** for the prose half, where a closed set is precisely what you do not
    have. Two routes, and they differ on the constraint that matters here: `whisper-rs` wraps
    whisper.cpp and needs cmake and a C++ compiler, which breaks the no-MSVC gnu path
    `build.md` documents; a `candle`-based Whisper is pure Rust on CPU and does not, at the
    cost of a large dependency tree and a model file to ship or fetch.

  Free dictation through Windows' recogniser is *not* the answer for the prose half: its topic
  constraint requires the "Online speech recognition" privacy setting and sends audio to
  Microsoft. See *Unknowns*.

### What it buys

Deterministic, offline, free, and it **cannot spend money by mishearing** — the strongest
property on this list, given what a project card is spawned with. It has a Bun suite. It reads
like the rest of the app, because it is the argument `commands.ts` already makes with a
microphone in front of it. And it is the cheapest of the three to build by a wide margin.

### What it costs

You have to learn the phrasings. The grammar will feel rigid the first time you say something
reasonable and get prose back. It cannot answer a question — *"what is card three doing?"* is
not a sentence this design has any way to respond to. And the separator words (`saying`,
`colon`) are a small unnatural thing you must remember mid-sentence, which is exactly the kind
of friction that gets skipped under load.

**Best if** you want voice as a faster keyboard and you want to trust it completely.

---

## Design 2 — The steward

> The wall already knows how to be operated by an agent. It has never been asked to operate
> itself.

Free speech in, ops out, with an agent turn doing the understanding. The striking part is how
little of it is new.

### Most of the tool surface already exists

The wall's MCP roster (`ask.rs::roster`, ~30 tools across two tiers) already contains the three
examples:

| the request | the tool that already does it |
|---|---|
| *open a card in project caravan* | `mcp__skein__spawn`, whose `project` takes *"one the user has already opened here, named as `list` names it"* |
| *send the following to cards A and B: halt work* | `mcp__skein__send`, whose `to` takes a handle, a title, an array of either, or `project`/`skein` |
| *record a sink item for volery: …* | `mcp__skein__drop`, with `title`, `body`, `kind`, `paths`, `scope` |
| *select card A* | — nothing |
| *open image.png in caravan* | — nothing |

What is missing is everything about **where you are looking**: `select`, `focus`, `viewport`,
`fit`, the transcript panel, and — the fifth example — the file viewer. There is no MCP tool
that opens a file in the reading panel; `mcp__skein__pin` puts a *reference image on the wall
beside a card*, which is a different act and would be the wrong answer to *"open image.png"*.
So the steward needs a new tier of tools whose subject is the window rather than the work.
`spawn.md`'s argument about *"the three bounds that are switched off and what is watching
instead"* applies again and should be re-read before granting it.

That gap is worth noticing for what it says about the design: **the tools the wall hands its
agents are all about doing work, and none of them are about looking at it** — which is correct
for a card and is exactly half of what a voice needs.

### The two shapes, which is the real sub-decision

- **(a) A standing steward card.** Always on the wall, holding context across utterances — so
  *"and now send the same to caravan"* works, and it can answer questions about the wall from
  `list`, `recall` and `touched`. Costs a live `claude` child at rest (`processes.md` has the
  figure for what that is) and a context that grows all day and eventually compacts.
- **(b) A fork per utterance**, which is exactly `/btw`'s shape and mechanism: `--fork-session`,
  `--tools <wall tier>`, ephemeral, nothing persisted. `aside.rs` is already written —
  including the job object, the finite wait, the hard failure when the account is not signed
  in, and the one-at-a-time generation guard that drops a superseded answer rather than
  delivering it late.

**Recommend (b)**, with the last few utterances and their outcomes passed in the prompt. That
buys pronouns without a permanent process, and it inherits a subsystem that has already had its
edge cases found.

### It must not act directly, and the line is a table rather than a judgement

A model in the loop of this app's own controls, with cards running permissions-bypassed, is not
something to hand a broadcast to. So:

- **Ops that only change how you look run immediately** — `focus`, `select`, `deselect`,
  `viewport`, `fit`, `find look-at`, `widget.add`, `rename`. Asking about them would make voice
  slower than the mouse, which is the whole reason not to use voice. **The line is already
  drawn, and not by this feature**: it is `undo.md`'s boundary, verbatim —

  > Nothing that left this machine is on the stack — no prompt, no broadcast, no `!` line, no
  > `actions` run, no relay message, no board notice, nothing git. […] **The viewport is not on
  > it either.** Panning and zooming are how you *look* at this wall, not changes to it.
  > Selection is out for the same reason.

  Read the two halves together and the undo stack turns out to be a *complement* of the confirm
  list: everything undo refuses because it left the machine is exactly what voice must confirm,
  and everything undo refuses because it is only looking is exactly what voice may do at once.
  Nothing has to be classified twice, and a new op's disposition is decided by a question the
  repo already had an answer to. (An earlier draft of this file said these ops were safe
  because *"`undo.ts` can take them back"*. It cannot — that is precisely the boundary above,
  and the real argument is the better one.)
- **Everything else proposes.** The steward returns a plan; the plan comes up through the
  existing `ask_user` panel with the affected cards lit on the wall behind it. One press
  accepts. This is not new surface: it is the app's own confirm gesture, being used for the
  first time by the app itself. (`askSnapshot`'s `ours` field already distinguishes a question
  Skein put up from one an agent asked, and already has exactly one user — `close` wanting
  approval. This would be the second.)
- **Which side an op falls on is a table in a pure module**, not something the model decides
  per utterance. A model that gets to classify its own actions as safe has no classification.

### What it buys

Any phrasing. Compound requests in one breath — *"send the following to cards A and B"* is a
single utterance with two addressees and a payload, and this is the only design that gets that
for free. Questions about the wall, answered. And it grows on its own: every tool the wall
gains is a thing you can then ask for out loud, with nothing added to a grammar.

### What it costs

**Allowance and latency per utterance** — see the correction under *What was decided*: this
section originally said *money*, which overstated it, and the difference matters because the
wall already has an instrument for allowance and never had one for money. What survives the
correction is the latency: a request is seconds rather than milliseconds, and *"select card A"*
becoming a round trip is a strange trade for a gesture the mouse does instantly. That is the
whole argument for keeping the grammar as a fast path underneath.

Non-determinism where Design 1 has a Bun suite. A new tool tier whose subject is the window.
And the honest one, which no correction touches: it puts a language model between you and the
controls of the thing you use to supervise language models.

**Best if** you want to *talk* to the wall rather than learn to command it, and you would
rather pay per sentence than memorise a grammar.

---

## Design 3 — The wall listens

> The point is running the wall while your hands are somewhere else — and today *both* halves
> of that are missing, not just the input.

No key. A continuous on-device recogniser, gated by a **spoken address**: a card's handle, a
territory's name, or the wall's own name. Everything before an address is discarded; everything
after it, until a pause, is the utterance. **Addressing is what a push-to-talk key is for,
moved into the language** — which is also what makes it the only design where the same sentence
can name its target and its payload without a modifier or a mouse.

```text
caravan, halt work
volery, open a card in the skein territory
the auth work and caravan, halt work
volery, drop a sink item: the ring pegs at a hundred percent
caravan, show me image dot png
```

Note what the address does to the fifth example: *"caravan, show me image dot png"* has already
named the territory before the filename arrives, so the file list to score against is settled
by the time there is a query — which is the one case where addressing first is not merely a
gate but a genuine narrowing.

### It forces the naming problem to be solved, and then benefits from it

Design 1 works around generated titles with ordinals. This design cannot — you will not say
*"card three"* to a wall from across the room and expect to have counted right. So a card gets
a **short spoken handle**, and the machinery is already there: `/rename` sets it and
`named_by_hand` stops the next settling turn taking it back. *"Call this one caravan"* is
already a sentence the wall can carry out and remember.

And the handles then make the recognition tractable, which is the part that turns a liability
into the design's best property: **the wake half is matching against a closed set** — every
handle on the wall, plus the wall's own name — which is the one task an offline
grammar-constrained recogniser is genuinely good at. Only the payload needs open dictation, and
only after an address has already been matched. So the always-on half can be the cheap engine
and the expensive engine runs only when someone has actually spoken to something.

### The half neither other design has: it answers

This is the reason to build it, and it is an output feature rather than an input one.

- **It shows what it is hearing, as it hears it.** A partial transcript under the addressed
  card, or on the backdrop. `glass.ts` already sticks a thing to a pane in screen space without
  moving where it is, which is exactly the primitive.
- **It speaks.** A fourth rung on `attention.svelte.ts`'s ladder — taskbar flash → peek →
  chime → *spoken* — carrying what the chime can only gesture at: *"caravan is asking you
  something"*, *"the auth work finished"*. The argument is already written in that file, for
  the alarm that sounds whether or not you are looking:

  > an alarm you only hear if you had wandered off is not an alarm

  A chime tells you *that* something happened. Across a room, with your hands in a viewport, a
  chime means getting up. This is that ladder taken one rung further, and it is the only rung
  that works when you are not looking at the screen at all.

### The confirm rule is strictest here, and for a specific reason

An ambient channel is the most likely of the three to mishear, and **a panel is not a
confirmation to someone who is not looking at the screen.** So anything that spends money or
reaches a card is spoken back and confirmed out loud — *"send 'halt work' to caravan and the
auth work — yes?"* — and cheap ops act silently, with the partial transcript as their only
receipt.

### Is an always-on recogniser a fourth poller?

It has to be asked, because `CLAUDE.md` names exactly three places that go and look and says
anything proposing to be the fourth owes one of their shapes.

**It is not a poller, and the distinction is real rather than a technicality.** A poller asks a
question on a clock because the thing it watches emits nothing. A microphone stream *is* an
emitter: this is the supervisor's own shape — a reader thread on a stream, folding what arrives
into `$state`, with no clock anywhere in it. What it does cost is a thread and continuous CPU,
which is a different objection and answered by measuring rather than by arguing. `motion.md`'s
lesson applies to the measurement: the term that matters is usually not the one you would
reach for first.

### What it buys

Genuinely hands-free. The only design that makes a twenty-card wall workable from across the
room, and the only one where the wall can tell you something unprompted. No key, so no
focus-follows-window problem and no global hotkey dependency.

### What it costs

An always-on microphone, which is a privacy fact and not a feature flag: it needs a visible
indication that is on whenever the stream is, and it forces **local** speech-to-text, because
audio from a room leaving this machine is not a thing to ship. Continuous CPU, unmeasured.
False addresses, which get worse the more cards are on the wall and the shorter their handles
are. And a real audio wrinkle nothing else here has: **librespot is also playing music through
the same device** (`spotify.md`), so ducking while it speaks and barge-in while it is speaking
are both problems this design owns and the others do not.

**Best if** the wall is a room you work in rather than a window you visit.

---

## What all three need regardless

Worth separating, because it is buildable before the choice is made and none of it is wasted
whichever way the choice goes.

1. **Capture in Rust through `cpal`** — already in the lock, no new C toolchain. A `voice.rs`
   holding one input stream, a job-object-free concern since nothing is spawned, emitting audio
   frames or transcripts as events the front end folds. Push-to-talk and always-on are the same
   module with a different gate.
2. **`src/lib/voice.ts`, pure**, added to the `test` script — the verb table, the four
   referent resolvers, the payload boundary, and the spoken-path normalisation. Even Design 2
   wants it: something has to hold the cheap-versus-proposes table, and a model must not be the
   thing that holds it.
3. **The card resolver lifted out of `#card()`** and shared with the control surface, which
   gains a suite it does not have today. The other three resolvers need nothing lifted —
   `Region` and `rank()` are already where they should be.
4. **A `sink.add` op**, the request's fourth example and the one gap in the verb table.
5. **The destructive-op table** — which verbs may fire on a heard sentence and which must be
   confirmed. This is the single most important artifact in the whole feature and it is fifteen
   lines of pure data.
6. **A visible listening indication** that is driven by the stream's actual state rather than
   by the switch that asked for it, for the reason `meter.sampling` and `attention.sounded`
   both exist: *permitted* and *happening* are two facts, and from outside they look identical.

## Unknowns, and the probes that answer them

In this repo's own style — one variable each, and say what it returned.

| unknown | probe |
|---|---|
| Does `getUserMedia` work in this wry/WebView2 window, and if it fails, how? | a `tools/probe-mic.ts` page loaded in a dev build; expect either a permission event nobody handles or a silent rejection |
| Does `window.speechSynthesis` work in WebView2, and which voices? | same page. If yes, Design 3's output half costs nothing at all |
| Is `webkitSpeechRecognition` present? | same page. Expected absent — it is Chrome-branded and reaches Google |
| Does Windows' `SpeechRecognizer` with a **list constraint** run fully offline, and what does it cost to construct? | a scratch crate per `build.md`'s variant 3, with the `windows` crate and the speech feature — *not* an `examples/` probe, which cannot run on the gnu toolchain |
| Does its **topic** (dictation) constraint really require the online privacy setting? | the same crate, with the setting off. This decides whether Design 1 needs Whisper at all |
| What does a local Whisper cost here — latency for a five-second utterance, model size, and does `candle` build without a C toolchain? | a scratch crate each for `whisper-rs` and `candle`. The toolchain half is the one that decides between them |
| What does an always-on stream cost in CPU, and does it show up in the meter? | `perf.ts` and the process meter already exist; run it for an hour |
| Do card handles survive being spoken? | the cheapest probe of all: read twenty real card titles off this wall aloud into whichever engine wins, and count |
| Can Haiku 4.5 parse a compound utterance into an ordered plan with referents resolved, and how fast? | needs no audio and no app: a `tools/probe-steward.ts` feeding thirty written utterances — compound, ambiguous, and deliberately malformed — to the tool schema against a fixture wall, and scoring the plans by hand. **This is the probe that decides whether the decided shape is the right one**, and it is runnable today |
| Does the recogniser hear the wall's own voice? | play the read-back through the speakers with the stream live and see whether a plan comes back addressed to nobody |
| Does `rank()` actually find a file from a spoken filename, and how much normalisation does it need? | no app and no microphone required — feed real transcript strings (`image png`, `image dot png`, `assets image P N G`) into the existing scorer against this repo's own file list and look at the top three. A `test/voice.test.ts` case from the start, since the answer is a fixture rather than a measurement |

## A recommendation, which is a recommendation

**Superseded by the decision at the top of this file** — kept because two thirds of it held and
the third that did not is instructive. It recommended 1 → 3 with 2 last, on the strength of 2's
cost. The cost was mispriced (money, not allowance) and the recommendation leaned on it, so 2
moved from *last* to *the interpreter the whole thing routes through*. What held: that 1 is
nearly all shared work and is not thrown away, that 3 is the reason, and that 2 is much smaller
and safer built as a fall-through from 1 than on its own. That last point is now the
architecture rather than a suggestion.

The original text follows.

**Build 1, then 3, and treat 2 as an addition to either rather than an alternative.**

Design 1 is the floor and it is nearly all shared work: capture, the pure module, the resolver,
the op table's missing entry, the confirm table. None of it is thrown away by later choosing
something else, and it ships something that cannot mishear its way into spending money.

Design 3 is the *reason* — the request describes running the wall while doing something else,
and a push-to-talk key inside an unfocused window does not do that. Its output half is the
single best thing in this document and is the cheapest part of it if the `speechSynthesis`
probe comes back green.

Design 2 is the one to be slowest about, not because it is bad but because it is the only one
whose failure mode is expensive, and because it gets cheaper to build the longer it waits:
every tool the wall gains is a verb the steward gets for nothing. Once 1 exists, 2 is a
fall-through — *what the grammar did not recognise, ask the steward about* — which is a much
smaller and much safer thing to build than 2 on its own, and it turns Design 1's rigidity from
a permanent cost into a first pass.

The decision that is not this file's: whether a language model belongs between you and the
controls of the wall at all. Designs 1 and 3 say no and pay for it in phrasing. Design 2 says
yes and pays for it in money, latency and trust.
