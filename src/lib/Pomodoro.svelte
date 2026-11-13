<script lang="ts">
  /* A view onto the studio's one cycle — never a cycle of its own.
   *
   * Hang two of these up and they are two readings of one afternoon, which is
   * why every piece of state here comes off the shared `Cycle` and the
   * widget's own config holds nothing but which reading this is. The three are
   * genuinely different questions: the ring asks how long is left of the phase
   * in hand, the beads ask how far through the cycle you are, and the digits ask
   * only for the number.
   *
   * Nothing here decides when a break happens or what it does — that is
   * `timing.ts::step`, driven from the studio. This draws the cycle and offers
   * the two gestures it has. */

  import type { Cycle } from "./cycle.svelte";
  import { clock } from "./conversation.svelte";
  import { arcPath } from "./clock";
  import { beads, completed, phraseFor, progress, runOfCycle, span } from "./timing";
  import { variantOf, type Widget } from "./widgets";

  let { widget, pomodoro }: { widget: Widget; pomodoro: Cycle } = $props();

  /* The same one-second rune every other instrument reads. The shared cycle is
     driven from it too (`Cycle.tick`), so reading it here rather than calling
     `Date.now()` is what keeps the ring and the digits from disagreeing by a
     frame. */
  const now = $derived(clock.t);

  const variant = $derived(variantOf(widget));
  const cycle = $derived(pomodoro.cycle);
  const phase = $derived(pomodoro.phase);
  const posture = $derived(pomodoro.posture);

  const left = $derived(pomodoro.left);
  const fraction = $derived(
    cycle.on ? progress(runOfCycle(cycle), phase.seconds, now) : 0,
  );

  const row = $derived(beads(cycle.done, cycle.per));
  const total = $derived(completed(cycle.done));

  const line = $derived.by(() => {
    if (!cycle.on) return "no cycle running";
    if (cycle.paused) return "paused";
    if (posture === "pushed") return `break in ${span(pomodoro.returning)}`;
    if (posture === "resting") return "resting";
    return phraseFor(phase);
  });

  const C = 100;
  const R = 86;
</script>

<div class="pom" data-variant={variant} data-posture={posture} data-kind={phase.kind}>
  {#if variant === "ring"}
    <svg viewBox="0 0 200 200" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <circle cx={C} cy={C} r={R} class="track" />
      {#if cycle.on}
        <path d={arcPath(C, C, R, fraction * 360)} class="fill" />
      {/if}
      <text x={C} y={C - 8} class="inner">{cycle.on ? span(left) : ""}</text>
      <text x={C} y={C + 34} class="under">{cycle.on ? phase.number : ""}</text>
    </svg>
  {:else if variant === "beads"}
    <!-- How far through the cycle, which is the question a pomodoro is actually
         kept for. The row shows the cycle in hand and starts again rather than
         growing without limit; the count beside it is what the row forgets. -->
    <div class="beads" aria-hidden="true">
      {#each row as bead, i (i)}
        <span class="bead" data-bead={bead}></span>
      {/each}
    </div>
    <div class="beads-time">{cycle.on ? span(left) : ""}</div>
    <div class="tally">{total === 1 ? "one done" : `${total} done`}</div>
  {:else}
    <div class="digits">{cycle.on ? span(left) : ""}</div>
  {/if}

  <div class="foot">
    <span class="line">{line}</span>
    <span class="acts">
      {#if !cycle.on}
        <button class="act" onclick={() => pomodoro.begin()}>begin</button>
      {:else if cycle.paused}
        <button class="act" onclick={() => pomodoro.resume()}>carry on</button>
        <button class="act" onclick={() => pomodoro.finish()}>end</button>
      {:else}
        <button class="act" onclick={() => pomodoro.pause()}>pause</button>
        <button class="act" onclick={() => pomodoro.finish()}>end</button>
      {/if}
    </span>
  </div>
</div>

<style>
  .pom {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    justify-content: center;
    gap: 0.3rem;
    padding: 0.45rem 0.55rem;
    overflow: hidden;
    /* Deliberately paints no background of its own — the wrapper fills, which
       is what lets the `frame` knob's `bare` reach this face. See the ambience
       note for why the wall's furniture is opaque by default. */
  }

  svg {
    flex: 1;
    min-height: 0;
    width: 100%;
    display: block;
  }

  .track {
    fill: none;
    stroke: var(--surface);
    stroke-width: 9;
  }
  .fill {
    fill: none;
    stroke: var(--paper-dim);
    stroke-width: 9;
    stroke-linecap: round;
  }
  .inner {
    text-anchor: middle;
    dominant-baseline: central;
    font-family: var(--mono);
    font-size: 42px;
    font-variant-numeric: tabular-nums;
    fill: var(--paper);
  }
  .under {
    text-anchor: middle;
    dominant-baseline: central;
    font-family: var(--util);
    font-size: 20px;
    fill: var(--paper-faint);
  }

  .digits {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: min(30cqw, 50cqh);
    line-height: 1;
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    color: var(--paper);
  }

  /* ── beads ──────────────────────────────────────────── */
  .beads {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: min(3cqw, 7px);
    padding: 0.2rem 0;
  }
  .bead {
    width: min(9cqw, 16px);
    height: min(9cqw, 16px);
    border-radius: 50%;
    border: 1.5px solid var(--rule);
  }
  .bead[data-bead="done"] {
    background: var(--paper-dim);
    border-color: var(--paper-dim);
  }
  /* The one in hand is an outline that is heavier, not a colour: which pomodoro
     you are on is not a status of the work. */
  .bead[data-bead="now"] {
    border-color: var(--paper);
    border-width: 2.5px;
  }
  .beads-time {
    text-align: center;
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: min(22cqw, 30cqh);
    line-height: 1;
    color: var(--paper);
  }
  .tally {
    text-align: center;
    font-family: var(--util);
    font-size: min(6cqw, 12cqh);
    color: var(--paper-faint);
  }

  /* ── the foot ───────────────────────────────────────── */
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
  }
  .line {
    font-family: var(--util);
    font-size: min(6cqw, 12cqh);
    color: var(--paper-faint);
    letter-spacing: 0.04em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .acts {
    display: flex;
    gap: 0.25rem;
    flex: 0 0 auto;
  }
  .act {
    font-family: var(--util);
    font-size: min(6cqw, 12cqh);
    color: var(--paper-mute);
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.1rem 0.35rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .act:hover {
    color: var(--paper);
    background: var(--raised);
    border-color: var(--rule);
  }

  /* A break pushed back is the one thing here that has to catch the eye from
     across the wall — it is time you owe, and amber is what that means. */
  .pom[data-posture="pushed"] .line {
    color: var(--st-ask);
  }
</style>
