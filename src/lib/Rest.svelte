<script lang="ts">
  /* The break, taken.
   *
   * This is the one thing in Skein that stops *you* rather than reporting on
   * something. When a focus phase rings, the break falls due and this comes over
   * the whole window — the wall, the panel, the dock, all of it.
   *
   * Three decisions worth knowing, because each is the opposite of the obvious
   * one:
   *
   * - **The work is still there, and still working.** The scrim is translucent,
   *   so the wall carries on behind it: cards stream, dev servers build, the
   *   ambience drifts. Nothing is paused except you. A break screen that blacked
   *   the wall out would be telling you your work had stopped, which is a lie
   *   and an anxious one — and watching six agents get on with it is a far
   *   better argument for stepping away than an empty rectangle is.
   *
   * - **There is no "skip".** The way out is `push it back`, which delays the
   *   break and keeps every second of it owed, or `end the cycle`, which is you
   *   saying you have finished working this way rather than that you are
   *   skipping the rest and carrying on. A button that spent the break would
   *   make the whole feature optional, and the point of it is that it is not.
   *
   * - **It is quiet, and it does not count.** No seconds ticking down, no
   *   progress bar draining — a rest screen you can watch is a rest screen you
   *   *do* watch, and then you have spent your break looking at a timer. One
   *   ring, one sentence, and how long is left said in words that change about
   *   once a minute.
   *
   * The arithmetic and the wording are `timing.ts`; this draws them. */

  import { arcPath } from "./clock";
  import type { Cycle } from "./cycle.svelte";
  import { progress, restNote, restTitle, runOfCycle, said, SNOOZE_S } from "./timing";
  import { clock } from "./conversation.svelte";

  let { pomodoro }: { pomodoro: Cycle } = $props();

  const now = $derived(clock.t);
  const cycle = $derived(pomodoro.cycle);
  const phase = $derived(pomodoro.phase);
  const left = $derived(pomodoro.left);

  const fraction = $derived(progress(runOfCycle(cycle), phase.seconds, now));
  const title = $derived(restTitle(phase));
  const note = $derived(restNote(phase, cycle.done, cycle.pushed));

  const C = 100;
  const R = 88;

  /** Everything the wall's own keys would otherwise do, stopped here.
   *
   *  `App.svelte`'s `onGlobalKey` runs on the window and would happily step the
   *  focus along the wall or open a menu behind the scrim. Swallowing keys at
   *  this layer rather than teaching every binding about the break keeps the
   *  rule in one place — and the two things that must still work, the two
   *  buttons, are reachable by Tab because they are the only focusable elements
   *  under it. */
  function guard(e: KeyboardEvent) {
    if (e.key === "Tab" || e.key === "Enter" || e.key === " ") return;
    e.preventDefault();
    e.stopPropagation();
  }
</script>

<svelte:window onkeydowncapture={guard} />

<div class="rest" role="dialog" aria-modal="true" aria-label={title}>
  <div class="plate">
    <svg viewBox="0 0 200 200" aria-hidden="true">
      <circle cx={C} cy={C} r={R} class="track" />
      <path d={arcPath(C, C, R, fraction * 360)} class="fill" />
    </svg>

    <h1 class="title">{title}</h1>
    <p class="left">{said(left)} left</p>
    <p class="note">{note}</p>

    <div class="acts">
      <button class="act" onclick={() => pomodoro.push()}>
        push it back {Math.round(SNOOZE_S / 60)} minutes
      </button>
      <button class="act quiet" onclick={() => pomodoro.finish()}>
        end the cycle
      </button>
    </div>
  </div>
</div>

<style>
  /* Every screen, but its words on the home one. Spread over every monitor the
     studio root is the containing block for anything fixed (`span.ts`), so
     `inset: 0` would black out the home screen and leave the wall on the
     others free to be worked — a break offered rather than taken. The box is
     sized to the whole window and padded back in to the home screen, which is
     where `place-items: center` then centres the card. All four offsets are
     zero when nothing is spread. */
  .rest {
    position: fixed;
    left: calc(-1 * var(--span-x, 0px));
    top: calc(-1 * var(--span-y, 0px));
    width: 100vw;
    height: 100vh;
    box-sizing: border-box;
    padding: var(--span-y, 0px) var(--span-r, 0px) var(--span-b, 0px) var(--span-x, 0px);
    /* Above everything, the panel and the dock included — this is the one thing
       in the app that is allowed to be. */
    z-index: 9000;
    display: grid;
    place-items: center;
    /* Translucent on purpose: the wall goes on working behind it. Heavy enough
       that nothing behind is legible as work you could pick up, light enough
       that you can see it is all still there and still moving. */
    background: color-mix(in srgb, var(--well) 88%, transparent);
    backdrop-filter: blur(7px) saturate(0.7);
    animation: settle 1.1s cubic-bezier(0.22, 0.68, 0.24, 1) both;
  }

  /* It arrives slowly. A break screen that snapped in would read as an error
     dialog; this is closer to a light going down in a room. */
  @keyframes settle {
    from {
      opacity: 0;
      backdrop-filter: blur(0) saturate(1);
    }
    to {
      opacity: 1;
    }
  }

  .plate {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
    padding: 2rem 2.4rem 1.6rem;
    text-align: center;
    max-width: 30rem;
  }

  svg {
    width: clamp(140px, 22vh, 220px);
    height: clamp(140px, 22vh, 220px);
    margin-bottom: 1.1rem;
  }
  .track {
    fill: none;
    stroke: color-mix(in srgb, var(--paper) 8%, transparent);
    stroke-width: 3;
  }
  /* Achromatic, deliberately. Colour on this wall is status, and a break is not
     a fault — this is the one screen that should feel like nothing is wrong. */
  .fill {
    fill: none;
    stroke: var(--paper-mute);
    stroke-width: 3;
    stroke-linecap: round;
    transition: d 1s linear;
  }

  .title {
    font-family: var(--display);
    font-size: clamp(1.7rem, 4.2vh, 2.6rem);
    font-weight: 400;
    line-height: 1.1;
    color: var(--paper);
    margin: 0;
  }
  .left {
    font-family: var(--body);
    font-size: 1rem;
    color: var(--paper-mute);
    margin: 0.35rem 0 0;
  }
  .note {
    font-family: var(--util);
    font-size: 0.72rem;
    letter-spacing: 0.1em;
    color: var(--paper-faint);
    margin: 0.1rem 0 0;
  }

  .acts {
    display: flex;
    gap: 0.6rem;
    margin-top: 2.2rem;
  }
  .act {
    font-family: var(--util);
    font-size: 0.78rem;
    letter-spacing: 0.03em;
    color: var(--paper-mute);
    background: transparent;
    border: 1px solid var(--edge);
    border-radius: 4px;
    padding: 0.42rem 0.9rem;
    cursor: pointer;
    transition:
      color 0.18s ease,
      border-color 0.18s ease;
  }
  .act:hover {
    color: var(--paper);
    border-color: var(--rule);
  }
  /* Ending the cycle is a bigger thing than pushing a break back, so it is the
     quieter of the two — you should have to mean it, not be warned off it. */
  .act.quiet {
    border-color: transparent;
    color: var(--paper-faint);
  }
  .act.quiet:hover {
    color: var(--paper-mute);
    border-color: var(--edge);
  }

  @media (prefers-reduced-motion: reduce) {
    .rest {
      animation: none;
    }
    .fill {
      transition: none;
    }
  }
</style>
