<script lang="ts">
  /* This machine over the room's span (§6, §11).
   *
   * One row per measure, a sparkline of the minute rows the wall recorded, the
   * latest reading and the span's extreme. **A measure this build cannot read
   * says so** rather than disappearing: a GPU counter a machine does not
   * publish is a fact about the reading, and a block that silently omitted the
   * row would look like a machine with no GPU.
   *
   * Ink throughout. A machine at 98% CPU is not a failure and rust would say it
   * was; a machine at 4% is not a card working and celadon would say that.
   * Colour on this wall is status, and this block is an instrument.
   */

  import { fold, MACHINE_ROWS } from "./machinefacts";
  import type { MachineRead } from "./machineread.svelte";
  import { sparkPoints } from "./analyticsroom";
  import { tipOf } from "./tipped.svelte";

  let {
    read,
    span,
  }: {
    /** The read, or null while it has not answered. */
    read: MachineRead | null;
    /** The span the rows cover, in the surface's own words. */
    span: string;
  } = $props();

  /** What the rows are, in words: the record, or the average the span was
   *  folded to. A coarse reading that did not say so would be a chart claiming
   *  a detail it does not have. */
  function grainSaid(grain: number): string {
    const minutes = Math.round(grain / 60_000);
    return minutes <= 1 ? "one a minute" : `${minutes}-minute averages`;
  }
</script>

{#if read !== null && (read.rows === null || read.rows.length > 0)}
  <div class="mh" aria-label="this machine over the span">
    <div
      class="mh-head"
      {@attach tipOf("what this machine was doing across the span, from the wall's own minute row. a measure this build cannot read says so rather than drawing a zero, because a machine series is read as history and a run of zeros looks like an idle machine.")}
    >
      <span class="mh-what">this machine</span>
      <span class="mh-dim">
        {read.rows === null ? `could not be read: ${read.fault}` : `${read.rows.length} readings · ${grainSaid(read.grain)}`}
      </span>
      <span class="mh-grow"></span>
      <span class="mh-dim">{span}</span>
    </div>
    {#if read.rows !== null}
      {#each MACHINE_ROWS as row (row.key)}
        {@const f = fold(read.rows, row.pick)}
        <div class="mh-row">
          <span class="mh-label">{row.label}</span>
          {#if f.last !== null}
            <span class="mh-now">{row.said(f.last)}</span>
            <span class="mh-dim">
              {row.least ? "least" : "peak"} {row.said((row.least ? f.low : f.peak)!)}
            </span>
          {:else}
            <span class="mh-dim">not read</span>
          {/if}
          <span class="mh-grow"></span>
          {#if f.points.length > 1}
            <svg class="mh-spark" viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden="true">
              <polyline points={sparkPoints(f.points)} vector-effect="non-scaling-stroke" />
            </svg>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
{/if}

<style>
  .mh {
    display: flex;
    flex-direction: column;
    gap: 0.12rem;
    margin: 0.1rem 0 0.35rem;
  }
  .mh-head {
    display: flex;
    align-items: baseline;
    gap: 1.2ch;
    font-size: 0.68rem;
    color: var(--paper-mute);
  }
  .mh-what {
    text-transform: lowercase;
    letter-spacing: 0.04em;
    color: var(--paper-dim);
  }
  .mh-grow {
    flex: 1;
  }
  .mh-row {
    display: flex;
    align-items: baseline;
    gap: 1.2ch;
    font-family: var(--util);
    font-size: 0.68rem;
    color: var(--paper-mute);
    font-variant-numeric: tabular-nums;
  }
  .mh-label {
    width: 10ch;
    color: var(--paper-dim);
  }
  .mh-now {
    min-width: 8ch;
    color: var(--paper);
  }
  .mh-dim {
    color: var(--paper-faint);
    font-size: 0.62rem;
  }
  .mh-spark {
    width: 22ch;
    height: 1.3em;
    overflow: visible;
    align-self: center;
  }
  .mh-spark polyline {
    fill: none;
    stroke: var(--paper-faint);
    stroke-width: 1.1;
    stroke-linejoin: round;
  }
</style>
