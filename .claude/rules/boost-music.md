---
paths:
  - "src/lib/boostmusic.ts"
  - "src/lib/boostscore.svelte.ts"
  - "test/boostmusic.test.ts"
---

# Boost's score

Boost mode (`accounts.md`, *Credits and boost mode*) is the wall spending the organisation's
reserve after the subscriptions have run out. Lyss asked for it to feel like a Final Fantasy last
battle, *"now this is the real deal, this is our last battle to save the world"*, with *"dynamic
music (when chime is enabled)"*. This file is the music. The light is `boost.md`'s.

## What was picked, and by ear

On 2026-10-24 Lyss heard three sketches (`.scratch-6d918b75/boost/music.js`): a 16-bit last
battle, an orchestral storm and a synth boss. She picked the first: *"16 bit last battle, the
intensity variations are good, however the moments sucks, they play with no regards for the
current beat or music state so they're barely audible or don't sound well. I like the music
though."*

So the split in this file is exact, and it is the whole brief:

- **The loop is a port, not a revision.** Same harmony (A minor, i VI VII V i VI iv V, with the
  natural seventh for VII and the raised one for V), the same theme note for note, the same
  instruments and the same four layers. 0 is the pad and a kick heartbeat, 1 adds the pulse
  bass, 2 the drums and stabs, 3 the theme. `test/boostmusic.test.ts` asserts every layer's
  voices and every theme note against the sketch, so a "small improvement" to a note shows up
  as a red test rather than as Lyss noticing her music changed. The one sound change is the pad,
  which was a two-saw retrigger: it is three saws now, with a filter that blooms over the attack
  and a longer release. The bar line breathes instead of re-striking, on the same notes at the
  same level.
- **The moments are rebuilt as part of the score.** The sketch's fired the instant they were
  called, in their own voicing and key, at a level the loop masked. Every one of those faults
  has a mechanism here, and the next section is them.

Nothing quotes a Final Fantasy theme. The victory fanfare is an arpeggio, not that fanfare's
repeated-note triplet figure, and the theme is the sketch's own.

## A moment is a plan on the score's own clock

`boostmusic.ts` is pure: a `Conductor` walks the score one sixteenth at a time and the runtime
asks it for a step when the lookahead reaches it, never twice. A moment is not *played*, it is
**placed** (`place`): it gets a first step, a bar line it lands on, and a bar line it hands back
at. Everything audible follows from that.

- **Quantized.** Every landing and every hand-back is a bar line, asserted for every kind on
  every step of the loop. The bar (16 steps at 168 bpm) is 1.43 s.
  - *Limit break* is a fill into a downbeat. It needs room to be a fill: under two beats it is a
    flam. So if at least half a bar is left, the fill starts on the next beat and lands on the
    coming bar line. Otherwise it takes the whole next bar. That keeps the wait between 0.7 and
    2.1 s and never makes the fill shorter than two beats. Always waiting a whole extra bar
    would have put up to three seconds between a card going onto credits and the sound of it.
  - *Victory* lands on the next bar line: a fanfare does not need a run-up, and a bar is short
    enough to wait.
  - *Ignite* is the entrance. A bar of riser lands on the first downbeat, so the score starts
    on V resolving to i instead of starting cold.
- **Harmonic.** The fill climbs the chord sounding *under* it, not the chord it lands on. The
  brief suggested the coming chord, and walking every bar line showed why not: the bass is
  still on the current chord, and at three of the eight bar lines the coming chord clashes
  with it. G major over F puts a B against the F; E major over G puts a G# against the G. The
  hit on the downbeat is that bar's chord. The victory is a deliberate excursion that resolves
  back: two borrowed bars, the dominant and then a Picardy A major. The loop's own pad and bass
  play those chords, so the fanfare is harmonised by the score rather than laid over it. Then
  the progression restarts at bar 0, which brings the minor back and the theme in from its
  top. Tested: every pitched note of every moment belongs to its bar's chord, and no stinger
  makes a tritone with the bass on any downbeat it lands on.
- **Audible.** Three buses. `music` (pad, bass, stabs, lead) goes down `DUCK_DB` (8 dB) under a
  moment. `moment` is the moment itself. `drums` is never ducked, because the beat carrying on
  is what tells the ear that the moment belongs to the score. Each bus is two nodes, dry and
  reverb send, both ducked: a reverb return the duck did not reach would be the ducked loop
  still washing under the moment.
- **Resolved.** The duck comes back over the moment's last beat, so the loop is whole again
  exactly on the bar line it takes over at.

### Bursts

Cards arrive in bursts. A whole wall's subscription runs out together, or four cards are
spawned onto credits within ten seconds, and each one marks a limit. Lyss asked about exactly
this when she approved the preview. Overlap cannot happen by construction, because a moment
waits for the last one to hand back. What has to be decided is how many of a burst you hear:

- a moment of a kind that has not handed back yet (waiting, filling or still ringing) absorbs
  another of that kind, because it is already saying it;
- after a limit break the loop gets `REST_STEPS` (one turn of the eight bars, ~11 s) to itself,
  and a limit inside that is absorbed too. *Deferring* it would land it seconds after the card
  it was about, which is the sketch's fault the other way round;
- and at most two moments wait at once.

So a burst is one limit break, and a trickle is at most one every ten bars or so. Victory is
rationed before it gets here (`boost.ts::VICTORY_GAP_MS`, one in ninety seconds).

## When it plays

The gate is `boost.on && attention.chime && !presence.away`. The chime is Lyss's own condition.
Away is `away.md`'s rule that being away mutes the whole notification ladder, and a score is
the loudest thing on it. Both are instances `App.svelte` builds, so they are injected into
`attach` rather than imported. The lab's `isDriven` silence is *not* applied: that rule exists
because the peek is an always-on-top window over the user's own screen, and a lab's chime is off
by default anyway, so a lab plays the score only when a test turns it on.

- **The gate fades** over `FADE_S` either way, from wherever the gain is. The gain is pinned
  before every ramp: `toys.md`'s first Web Audio trap, where a ramp without a pin starts from
  the last *scheduled* value and the jump to it is a click. The duck pins at the level its last
  ramp aimed at, since it holds still between its own ramps and the value it pins is in the
  future.
- **Opened again inside its fade-out**, it ramps back up and carries on where it was. Opened
  from silence, it starts a fresh conductor. If an ignite was heard within `IGNITE_FRESH_MS`,
  the start is that entrance; otherwise it is a fade-in. The ignite is marked synchronously
  from `purse.whenOn` before the effect sees `boost.on`, which is why recency works, and a chime
  switched on later fades in rather than playing an entrance nobody asked for.
- **Intensity is taken at the bar line.** `want` only records it; the next bar decides.
- **One `AudioContext`**, made on first need and closed `CLOSE_AFTER_MS` after the gate shut, so
  a wall that turned boost off an hour ago is not holding the audio device. Spotify is a
  separate WASAPI client and is never ducked (`spotify.md`).
- **Autoplay.** A context made without a gesture behind it can start suspended. The switch is
  usually a click, but a wall launched with boost already on is not, so `attach` resumes on the
  next pointer or key press. While suspended, `currentTime` does not advance and the scheduler
  commits nothing. When it resumes, steps the scheduler reached late are skipped rather than
  played in a heap, and that skip also covers a throttled window.

## Proving it

`boostScore.reading` is in the control surface's `boost` snapshot, because a sound has no DOM.
It gives the context state, the clock, `t0`, every placed moment's times, and a peak per tick for
the whole mix and for the moment bus. The `boost` op takes `working`, `onCredits` and `mark` as
stand-ins for the wall's own readings, so a lab can drive the score without a card going onto
credits.

What a landing looks like, measured in a browser on 2026-10-24: the moment bus sat at ~0.05
through the fill and read 0.76 on the first tick 17 ms after the computed bar-line time. A
victory read 0 before and 0.67 at +11 ms. The tick is 25 ms, so that is as close as the meter
can see.
