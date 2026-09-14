---
paths:
  - "src/lib/voice.ts"
  - "src/lib/voicing.svelte.ts"
  - "src/lib/steward.ts"
  - "src/lib/Hearing.svelte"
  - "src-tauri/src/voice.rs"
  - "src-tauri/src/steward.rs"
  - "tools/probe-steward.ts"
  - "test/voice.test.ts"
  - "test/steward.test.ts"
---

# Speaking to the wall

`docs/VOICE.md` is the design and is long: three shapes, what each costs, what
was decided on 2026-09-05 and why. **It is the thing to read before changing the
shape.** This file is the shorter question — what the pieces are, which one owns
what, and the handful of decisions that will bite somebody who only opens one of
them.

## The ladder, and the one rule that makes it safe

```text
audio ─▶ one utterance ─▶ addressed? ─▶ grammar ─▶ accounted for all of it?
                              │                     ├─ yes ─▶ plan, now, free
                              └─ no ─▶ forgotten    └─ no  ─▶ a message, or the steward
                                                                      │
                                        every op only changes how you look?
                                          ├─ yes ─▶ run it
                                          └─ no  ─▶ speak it back, wait for a yes
```

**The grammar answers only when it can account for the entire utterance.** That
is `resolveCommand`'s *exact-and-whole* clause from `commands.md` one layer up,
and it is what makes two rungs safe to stack: a partial match is not a match, so
everything the grammar does answer is complete and everything else escalates. A
grammar that could half-understand would need somewhere to put the half.

Four rungs answer, and they cost four different things:

| rung | where | costs | when |
|---|---|---|---|
| the address gate | `voice.ts::addressIn` | nothing | every utterance off the open ear |
| the grammar | `voice.ts::hear` | nothing | eight verbs, complete utterances |
| the addressed message | `voice.ts::messageTo` | nothing | a card was named and the grammar declined |
| the steward | `steward.ts` + `steward.rs` | one request, ~9s | everything else |

## Who owns what

- **`voice.rs`** is audio → text and nothing else. sherpa-onnx in this process:
  Silero VAD bounds the utterance, moonshine-base-en transcribes what it bounded,
  no audio leaves the machine. One loop (`hear_loop`) serves both the one-shot
  key and the open ear, because two that must stay in step are one and a bug.
- **`voice.ts`** is pure and is the whole of the thinking: resolving referents
  against a `Wall` it is handed, the grammar, the address gate, and carrying a
  plan out against a `Hands`. No runes, no Tauri, direct Bun tests.
- **`steward.ts`** is pure too: the prompt, the vocabulary, the tolerant read of
  the reply, and `understand`'s re-check of every referent, path and payload.
- **`steward.rs`** spawns one `claude --print` and hands the reply back
  **unread**. It is deliberately the boring half.
- **`voicing.svelte.ts`** is the only file that knows Tauri exists. It builds the
  `Wall` and the `Hands` out of the running app, holds the ear's subscriptions,
  and is where the four fields the bar draws live.
- **`Hearing.svelte`** draws them. One bar, and the rule it exists for is that
  **a voice layer that mishears and then goes quiet is indistinguishable from one
  that did not hear you**.

## Things that were got wrong once

- **Silence is not a transcript.** An empty result leaves `voice.rs` as an error
  and never as a `Heard`. The guard was added the day the first real recognition
  came back with `Text: ""`, lost when the engine was replaced, and re-added with
  a test — `outcome` is its own function *because* a microphone cannot be one.
  Without it `hear("")` finds no verb and the wall answers "not understood" to
  something nobody said, and the steward is spent on it.
- **The prompt must be narrowed or it does not fit.** `stewardPrompt` lists every
  file of every named territory, which is right for a fixture and impossible for
  a repository — `find.rs` caps a listing at 40,000. `narrow` cuts each list to
  what the sentence could be about, **and the same narrowed wall must go to
  `understand`**: showing the model one list and validating against another
  refuses good replies for a reason nothing can report.
- **`spelt(spoken(…))`, in that order.** `spoken` turns "markdown dot ts" into
  `markdown.ts`; `spelt` turns a said "source" into `src`. Using one where both
  were meant fails quietly, because the words are scored individually and
  "markdown" still finds the file — what is lost is the precision that told two
  files apart.
- **The address gate is exact, at the head, and longest-match.** A loose gate on
  a channel that hears the whole room is the wall acting on something nobody said
  to it. Ties between names of the same length go cards first, then the wall's
  own names, then territories — which had to be settled at all because this
  wall's own territory is *called* volery, and "volery, fit the wall" has to mean
  the wall.
- **Several addressed cards skip the grammar.** `hear` resolves a missing
  referent to the *focused* card, so "the ring and the auth work, stop" would
  build a plan about whatever was in front. With two or more names it is a
  message to all of them, which is the reading that cannot be wrong about who.
- **A late answer checks a generation, and the check is inside `#answer`.** A
  steward parse outlives the gesture that started it by up to a minute, and
  `pending` is armed by Enter from anywhere — so an answer that lands after an
  Escape must not quietly become a plan again. Guarding only the *report* is
  half of it: the plan still ran, and the invariant is about the wall moving
  rather than about what is drawn. `#gen` in `voicing.svelte.ts`, same shape as
  `aside.rs`'s. **An unaddressed utterance claims no generation** — room chatter
  that superseded the sentence you actually spoke would leave its answer with
  nowhere to land, which is the going-quiet failure arriving by the back door.
- **A plan does not outlive the utterance it was about.** Every answer except a
  `confirm` clears `pending`, because a plan is a question about the sentence you
  just said. Leaving one armed had three faces at once: the bar asking about an
  utterance two ago, `App.svelte`'s ladder giving Enter and Escape to that plan
  for as long as it stood, and an ambient "sure" ten minutes later firing it.
- **A spoken yes is bounded; a pressed one is not.** Enter is an act — you are at
  the keyboard, looking at the bar. A word is not: the ear hears the room, "sure"
  and "ok" and "go on" are all a yes, and the thing on the other side is a prompt
  delivered to an agent. `SPOKEN_YES_MS` is twenty seconds. A spoken **no** is
  deliberately unbounded, because cancelling is never the dangerous direction.
- **One device, one claim, and Rust decides it.** `Ear` holds both the open ear's
  flag and the one-shot's, under one lock, because two `hear_loop`s on one
  microphone is not an error on Windows — WASAPI shared mode grants both, and
  what you get is two recognisers, two transcripts of one room, and a bar
  flickering between them. A failure that succeeds is the worse kind.
- **The ear's closing is announced by its own thread, and the guard is three-way
  rather than two.** A close-then-open leaves the old thread coming down with a
  flush still to transcribe; an unguarded `open: false` from it tells the wall it
  has stopped listening while the new ear holds an open microphone — the privacy
  indication reading the exact opposite of the truth. So the emit is guarded as
  well as the slot. But `voice_close` empties the slot *before* it sets the flag,
  so a plain `Arc::ptr_eq(…).unwrap_or(false)` is false on **every deliberate
  close** — and that version shipped for one commit: nothing emitted, `voicing.open`
  latched true over a dead microphone, the privacy dot stayed lit, and both Alt+V
  and Alt+Shift+V went dead because the front end believed an ear was already
  open. Only a window reload recovered it. The three cases are *mine* (clear and
  announce), *nobody's* (the ordinary close — announce), and *somebody else's*
  (superseded — silent). The general shape: **a guard written for one case has to
  be read against every state its subject can actually be in**, and "the slot is
  empty" was a state nobody checked the guard against.
- **If you captured a generation before an await, pass it.** `say`'s `gen`
  defaults to *now*, which is right for the control surface and wrong for anything
  that took one earlier: the default is evaluated after the await, silently
  adopting whatever superseded it. `listen()` omitted it and `#answer`'s check
  therefore passed while `listen`'s own suppressed the report — the wall moving
  and saying nothing, which is the same bug the generation exists to prevent.
- **`send` and `broadcast` are wired and are outside `IMMEDIATE`.** Project cards
  spawn with `--dangerously-skip-permissions`, so a misheard message is the most
  destructive thing this application can do. Both are spoken back and held for a
  yes, and the yes may be spoken — exact and whole, so "yes and tell the others"
  is not one.

## What a change here owes

- **`bun test test/voice.test.ts test/steward.test.ts`** — the two rungs that
  can be tested without audio or money, which is both of the pure ones.
- **`bun run test:wall`** if you touched the seam: `voice.hear` parses and runs
  nothing, `voice.say` runs the key's path, and `voice.heard` is the open ear's
  path minus its microphone. All three drive the real wall with text.
- **`tools/probe-steward.ts`** if you reworded the prompt. It scores the prompt
  the app actually sends — 28/30 on Haiku, and rules 2 and 5 were worth five
  cases between them. A reworded rule with no re-run is an unmeasured change to
  the only number this rung has.
- **`cargo run --example voice-probe -- listen`** for anything about the
  recogniser. The microphone is the one thing here no test can reach.

## What is still unbuilt, and is not an oversight

- **The wall does not speak.** Design 3's fourth rung on the attention ladder —
  taskbar flash → peek → chime → *spoken* — is the half that works when you are
  not looking at the screen, and none of it is here. A confirmation you can only
  see is no use across a room, which is why the yes can at least be *said*.
- **Barge-in and ducking**, which only matter once it speaks.
- **A question about the wall is answered by saying it cannot be.** `understand`
  distinguishes a question from a remark, and nothing on this path can answer
  one: it would need the addressed card's transcript rather than the wall in a
  prompt.
