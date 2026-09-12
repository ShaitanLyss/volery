---
paths:
  - "src/lib/synth.ts"
  - "src/lib/synth.svelte.ts"
  - "src/lib/synth.worker.ts"
  - "src/lib/Plume.svelte"
  - "src/lib/leader.ts"
  - "src/lib/leader.svelte.ts"
  - "src/lib/Which.svelte"
---

# The toy shelf, and the first thing on it

`<space>t` is somewhere to put things to do with your hands while an agent is working.
`<space>ts` is the one that exists: a keyboard-driven audiovisual synthesiser, drawn over the
whole wall.

It is a toy and it is built like everything else here, which is the only thing about it worth
defending up front. A toy that crashes the app, leaks an audio device or silently costs 8% of
the GPU forever is not a toy; it is a bug you invited.

### Why it is an overlay and not the wall's weather

The first design had it driving `ambience.ts`, which already owns a canvas, a frame loop, a
layer stack and an editor for its knobs — an enormous amount of machinery for free. That was
wrong, and the reason is worth keeping because it decides everything else:

**ambience is the ground.** It is drawn behind everything, in *screen* space, deliberately
hueless, and its whole argument is that it is the light in the room rather than something
pinned up. A refresher is the opposite: it interrupts, it covers, and you should be somewhere
else while it is up. Sharing a renderer between "the room you are working in" and "the thing
you do instead of working" would have made both of them worse, and the first change either of
them wanted would have been a flag.

So it gets its own canvas, its own frame loop, and its own colour.

### Colour, which is the one house rule it breaks on purpose

The wall reserves colour for status — celadon working, amber asking, rust failed. `ambience.ts`
states this as a constraint and draws every effect in one tone mixed between two of the theme's
own greys.

The toy is full of hue, and that is a decision rather than an oversight. It is confined two
ways so the rule it breaks stays intact everywhere else:

- **Nothing touches `tokens.css`.** Hues are named in `synth.ts`'s palette table and in
  `Plume.svelte`'s stylesheet, and nothing else imports either.
- **The toy occludes the wall outright**, so at no moment is a status colour and a decorative
  one on screen together.

The upshot is that the exception enforces itself: the moment you see colour that is not status,
you know you are somewhere else.

### The five things that make it fun, none of which are taste

Each of these came out of looking at what the good ones do, and each is the sort of thing that
looks optional and is not.

1. **Pentatonic, always.** Five notes with no tritone between any pair, so no two keys pressed
   together are dissonant. This is why Patatap works and why Orff tuned classroom percussion
   this way. For something you open for ninety seconds without warming up it is the whole
   difference between fun and noise you close — so there is deliberately no chromatic option,
   and `test/synth.test.ts` asserts the *interval* rather than the note count.

   That assertion earned its place immediately: the third palette was hirajoshi, which is
   pentatonic, is the obvious choice for "one that sounds different", and **contains a
   tritone** between its second and fifth degrees. It would have shipped as a claim in a
   comment. `yo` is the same tradition without one.

2. **The picture is made of the sound.** The standing complaint about digital instruments in
   the literature is that they decouple the gesture from the output, so the connection stops
   being perceptible. So the scope is a real Lissajous figure — left channel on X, right on Y,
   which is what an oscilloscope in XY mode draws — fed from two `AnalyserNode`s on the bus
   after everything, delay tail included. Voices pan by where they were played. The figure is
   a picture of what your hands did, not an animation triggered beside it.

3. **Tap and hold are observed, not predicted.** Nothing can know at keydown which you meant,
   and a toy that waited `HOLD_MS` to find out would have 180ms of latency. So every note opens
   the same envelope and the *release* differs: let go inside `HOLD_MS` and it is a pluck with
   a short release; held past it and it rings out. The visual runs the same `envelopeAt` the
   audio's automation was built from, so the bloom fades exactly as the note does — by
   construction, not by two pieces of code being kept in step.

   The visual half of holding is `rings`: one emitted every `RING_MS` for as long as the key is
   down. One ring that merely *lasted* longer would read as a slow animation rather than as
   something you are doing.

4. **A palette is a matched set**, cycled with one key mid-play — scale, root, waveform,
   envelope, filter and hue move together. Patatap's actual mechanic, and better than a
   settings panel: the toy has moods rather than knobs, and the gesture is one you can make
   with both hands still on the keyboard.

5. **Feedback is most of how it looks.** The rendered frame, redrawn slightly larger and
   slightly turned at just under full opacity, is the trails, the echoes and the recursive zoom
   in three lines. It needs a sink — a breath of the ground colour over each frame — or the
   loop saturates to white within seconds of playing.

### Where the threads are, and which of them is not one

Somebody will propose moving the audio to a worker or into Rust. Both are wrong, for reasons
that are facts about the platform rather than preferences:

- **Rust is out.** Key-to-sound has to be under about 15ms or it stops feeling like an
  instrument. Tauri IPC is not that path, and getting PCM back out of Rust into the page is a
  bigger problem than the one it solves.
- **The audio is already off the main thread.** The Web Audio graph is rendered by the browser
  on its own real-time thread; the main thread only *schedules*, and `AudioParam` automation is
  sample-accurate and booked ahead. A worker would buy nothing. Custom DSP would be a different
  question and the answer to it would be an `AudioWorklet` — also a real-time thread — not a
  `Worker`.
- **The drawing was the part on the main thread**, and it is what went to a worker, via
  `OffscreenCanvas`. Be precise about what that buys: `motion.md`'s measurement says the
  dominant GPU term is the *present rate*, not the painted area, so this is **not** cheaper. It
  is that the main thread stays free — the one that also drains the Tauri event queue — so
  cards go on ingesting and painting behind the toy.
- **The frame loop stayed on main**, which looks like the inconsistency and is the one thing
  that could not move: `AnalyserNode` lives on this side. A worker with its own
  `requestAnimationFrame` would still need a message per frame to get the samples, and would
  then be drawing whatever arrived last rather than what was read for that frame.

And the wall's own ambience is passed `null` while the toy is up. It is a full-screen canvas on
a frame loop, fully occluded — frames paid for and impossible to see.

### Spotify keeps playing, and it is free rather than lucky

`spotify.rs` runs librespot in-process and pushes PCM at WASAPI itself. This is a WebAudio graph
inside the webview, which is a separate WASAPI client. Windows mixes them in shared mode, so the
two coexist with no ducking, no pausing and no code at all.

Worth knowing *why* rather than assuming: anything that ever moved this app's audio into the
same output stream as librespot would have to answer the question properly, and "it worked
before" would not be an answer.

### The two Web Audio traps

Both are the reason a browser synth usually sounds cheap, and both are one line.

- **A gain cut to zero from anywhere above it is a step discontinuity, which is what a click
  is.** So `#stop` pins the curve first — `cancelScheduledValues`, then
  `setValueAtTime(gain.value, t)`, then the ramp. Without the pin, a note released mid-attack
  jumps to full and falls from there. `envelopeAt`'s release does the same arithmetic for the
  picture and `test/synth.test.ts` asserts it, because it is the same bug in two places.
- **A held key auto-repeats.** Without `e.repeat` and the `#down` set, one finger opens thirty
  voices a second until the allocator has spent the whole board on one letter.

### Escape

The toy swallows the entire keyboard while it is up, first in `onGlobalKey` — above even Alt+I.
Thirty keys are the instrument and the rest are its controls, so there is nothing left for the
wall to be given.

**Escape is the key that branch exists for.** Further down the same ladder it stops a turn,
which is an expensive gesture and precisely the one you would rather not make by reaching for
the way out of a toy. `onblur` is the case the keyboard cannot see at all: Alt+Tab away
mid-chord and a held note never gets its keyup, so it would sustain forever with nothing left
able to stop it.

### The leader is the wall's now, not the finder's

`<space>ff` and `<space>fw` were the only chords for as long as the finder was the only thing a
chord could open, so the machine lived in `finding.ts` and answered with a `FindMode`. That is a
machine which can only ever reach one panel.

Adding a second client was the moment to hoist it, and the shape of the move is the reusable
part: **the table's value became a verb**. `leader.ts` is the pure machine and the chord table,
`leader.svelte.ts` is the stopwatch and the pending sequence, `Which.svelte` is the hint, and
`App.svelte` holds the one function that turns a verb into an action. A new chord reaching a new
subsystem costs a row in `CHORDS` and an arm in that function; the machine learns nothing.

Two things the table is asserted on, both cheap and both the sort of thing a hand-edited table
gets wrong: **every chord carries a label** (the hint used to switch on the find mode, a shape
with nowhere for a third chord to go — `<space>ts` would have been drawn as "grep"), and **no
chord is a prefix of another** (`chord` checks for a hit before a prefix, so the longer one
would be unreachable).

`Which.svelte` is its own component because **a component is the only CSS scope this codebase
has** — the same reason the dock was cut out of `App.svelte`. It lived in `Spyglass.svelte`
until the leader stopped being the finder's, at which point the hint for the toy shelf was a
caption drawn by the file finder: true of the code and nonsense as an arrangement.

### Adding a second toy

One row in `leader.ts`'s `CHORDS` with a `{ kind: "toy" }` verb, a member in `ToyId`, an arm in
`App.svelte`'s dispatch, and a component. If the shelf ever carries more than about half a
dozen, `offers` is the one function that changes — it returns whole remainders today, which
reads perfectly at this size and becomes a wall of them at thirty.

Resist a second toy that is nearly this one. One instrument you actually reach for beats a
folder of things nobody opens, and the test is reachability: if you cannot get to it in the
thirty seconds you actually have, it is decoration.
