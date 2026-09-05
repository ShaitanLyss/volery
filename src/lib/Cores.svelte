<script lang="ts">
  /* Every core of this machine, on the wall it belongs to.
   *
   * The performance meter beside it answers *what is costing me this*; this
   * answers *is the machine busy, and is it busy everywhere or in one place* —
   * which is the question a single CPU percentage cannot be asked. A build
   * pinned to one core and a build using twelve are the same number and two
   * different afternoons.
   *
   * The arithmetic, the reflow and the geometry are `cores.ts` and tested; the
   * samples come off the one shared `Meter`, which is the same poller the
   * performance widget already runs at the same tick. Nothing here opens a
   * second one, and a wall with neither widget up asks nothing at all.
   *
   * ── the art direction, which is the part with a rule against it ──────────
   *
   * Task Manager is the reference and what is taken from it is its information
   * design: one small graph per core, a grid that reflows as the box changes,
   * one shared vertical scale so the lanes are comparable at a glance, and the
   * newest sample at the right. What is deliberately *not* taken is its look.
   * That is saturated green on a printed grid, and on this wall **colour is
   * reserved for status** — celadon working, amber asking, rust failed. A core
   * at 96% is not a failure and drawing it in rust would say it was; a core at
   * 4% is not a card working away and celadon would say that. So a lane is ink,
   * the fill under it is the same ink at low opacity, and the only thing that
   * varies across sixteen cells is *how much* of it there is. That reads as one
   * instrument, which is what the meter next to it already does. */

  import { Meter } from "./meter.svelte";
  import {
    area,
    busiest,
    coreCount,
    currentOf,
    fits,
    gridOf,
    laneOf,
    meanLaneOf,
    mean,
    peakLaneOf,
    polyline,
    say,
    spanOf,
  } from "./cores";
  import { clock } from "./conversation.svelte";
  import { onOf, textOf, variantOf, type Widget } from "./widgets";

  let { widget, meter }: { widget: Widget; meter: Meter } = $props();

  const variant = $derived(variantOf(widget));
  const span = $derived(spanOf(textOf(widget, "span", "minute")));
  const numbers = $derived(onOf(widget, "numbers", false));

  /* Asking is what makes the sampler run at all, and the scope is the studio's
     because this reading does not use the process list: the cores are the
     machine's whichever scope the sample was taken at, and asking for the wider
     one would enumerate several hundred processes nothing here draws. `limit: 1`
     for the same reason — the rows are somebody else's reading.

     Two effects rather than one, the arrangement every widget that attaches to a
     holder uses: a tracking effect's cleanup fires on every change, so a single
     one would detach and re-attach each time the span knob moved. */
  $effect(() => {
    meter.attach(widget.id, { scope: "skein", limit: 1 });
  });
  $effect(() => () => meter.detach(widget.id));

  /* The wall's own second. The lanes are drawn against `now` rather than against
     the newest sample, so between two ticks the whole picture slides left
     instead of standing still and then jumping — which is the same reason the
     burn widget takes this tick for its window's far edge. */
  const now = $derived(clock.t);

  const history = $derived(meter.cores);
  const load = $derived(currentOf(history));
  const n = $derived(coreCount(history));
  const overall = $derived(mean(load));
  const hot = $derived(busiest(load));

  /* The box the lanes are drawn into, in the same canvas units the catalogue's
     `box` and `min` are written in — the header and the padding come off the
     top, the way `rowsFor` and `linesFor` account for their own chrome. */
  const HEAD = 22;
  const PAD = 10;
  const inner = $derived({
    w: Math.max(1, widget.w - PAD),
    h: Math.max(1, widget.h - HEAD - PAD),
  });
  const grid = $derived(gridOf(Math.max(1, n), inner.w, inner.h));
  /* A grid that will not fit is said rather than shrunk: cells past the floor
     are sixteen grey smudges, and the bars reading answers the same question at
     a fraction of the size. Falling back to it is the honest degrade — the same
     call the log widgets make when a filter empties the pane. */
  const cramped = $derived(variant === "grid" && n > 0 && !fits(n, inner.w, inner.h));
  const showing = $derived(cramped ? "bars" : variant);

  const lanes = $derived(
    showing === "grid"
      ? Array.from({ length: n }, (_, i) => ({
          core: i,
          at: load[i] ?? 0,
          points: laneOf(history, i, span, now),
        }))
      : [],
  );
  const meanLane = $derived(showing === "spread" ? meanLaneOf(history, span, now) : []);
  const peakLane = $derived(showing === "spread" ? peakLaneOf(history, span, now) : []);
</script>

<div class="cores" data-variant={showing}>
  <header>
    <span class="what">{n ? `${n} cores` : "cores"}</span>
    {#if hot !== null}
      <span class="hot" title="the core doing most of the work">#{hot}</span>
    {/if}
    <span class="tot">{say(overall)}</span>
  </header>

  {#if meter.fault}
    <!-- On its own face rather than the studio's fault bar: a meter that cannot
         read the machine is a broken instrument, not a broken conversation —
         the same call `Perf.svelte` makes. -->
    <p class="fault">{meter.fault}</p>
  {:else if !n}
    <p class="quiet">taking a reading&hellip;</p>
  {:else if showing === "grid"}
    <div class="grid" style:--cols={grid.cols} style:--rows={grid.rows}>
      {#each lanes as lane (lane.core)}
        <div class="cell" title="core {lane.core} — {say(lane.at)}">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <!-- Half scale, so a lane has something to be tall against. One
                 rule and not a printed grid: sixteen of these are already
                 sixteen boxes, and ruling each of them four times would be more
                 lines than reading. -->
            <line x1="0" x2="100" y1="50" y2="50" class="half" vector-effect="non-scaling-stroke" />
            {#if lane.points.length > 1}
              <polygon points={area(lane.points)} class="under" />
              <polyline
                points={polyline(lane.points)}
                class="line"
                vector-effect="non-scaling-stroke"
              />
            {/if}
          </svg>
          {#if numbers}<span class="num">{lane.core}</span>{/if}
        </div>
      {/each}
    </div>
  {:else if showing === "bars"}
    <!-- One bar per core, right now, no history. What survives at the smallest
         the widget may be dragged, and what the grid falls back to rather than
         drawing cells nobody can read. -->
    <div class="bars">
      {#each load as v, i (i)}
        <span class="bar" style:--v={Math.min(1, v / 100)} title="core {i} — {say(v)}">
          <span class="fill"></span>
        </span>
      {/each}
    </div>
    {#if numbers}
      <div class="ends"><span>0</span><span>{n - 1}</span></div>
    {/if}
  {:else}
    <!-- The machine and its busiest core on one pair of axes. The gap between
         the two lines is the whole reading: together means the work is spread,
         far apart means one core is carrying it and the other fifteen are
         waiting. -->
    <div class="spread">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" x2="100" y1="50" y2="50" class="half" vector-effect="non-scaling-stroke" />
        {#if peakLane.length > 1}
          <polygon points={area(peakLane)} class="under" />
          <polyline
            points={polyline(peakLane)}
            class="peak"
            vector-effect="non-scaling-stroke"
          />
        {/if}
        {#if meanLane.length > 1}
          <polyline
            points={polyline(meanLane)}
            class="line"
            vector-effect="non-scaling-stroke"
          />
        {/if}
      </svg>
      <div class="ends">
        <span>{textOf(widget, "span", "minute") === "long" ? "5 min" : "1 min"} ago</span>
        <span class="key">busiest {hot === null ? "—" : say(Math.max(...load))}</span>
        <span>now</span>
      </div>
    </div>
  {/if}
</div>

<style>
  .cores {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0.34rem 0.4rem 0.4rem;
    /* Paints no background of its own — the wrapper fills, and leaving it there
       is what lets the `frame` knob's `bare` reach this face. */
    font-family: var(--util);
  }

  /* Deliberately the performance meter's header, line for line: the two are one
     family in the catalogue and two instruments about one machine, so a reading
     of the cores that captioned itself differently would read as a third thing
     from somewhere else. */
  header {
    display: flex;
    align-items: baseline;
    gap: 0.5ch;
    padding: 0 0.2rem 0.26rem;
    border-bottom: 1px solid var(--edge);
    font-size: 0.66rem;
    color: var(--paper-mute);
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .what {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hot {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    color: var(--paper-faint);
  }
  .tot {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    color: var(--paper-dim);
  }

  /* ── a graph per core ─────────────────────────────────────────────────── */

  .grid {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: repeat(var(--cols), 1fr);
    grid-template-rows: repeat(var(--rows), 1fr);
    gap: 2px;
    padding-top: 0.2rem;
  }
  .cell {
    position: relative;
    min-width: 0;
    min-height: 0;
    /* The cell's own ground, one step off the wall rather than a box drawn
       around it. Sixteen outlines is a table; sixteen faint panels is an
       instrument. */
    background: var(--surface);
    border-radius: 1px;
    overflow: hidden;
  }
  .cell svg {
    display: block;
    width: 100%;
    height: 100%;
  }

  /* ── the machine and its busiest core ─────────────────────────────────── */

  .spread {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.18rem;
    padding-top: 0.2rem;
  }
  .spread svg {
    display: block;
    flex: 1;
    min-height: 0;
    width: 100%;
    background: var(--surface);
    border-radius: 1px;
  }

  /* ── the marks themselves ─────────────────────────────────────────────── */

  .half {
    stroke: var(--rule);
    stroke-width: 1;
    stroke-dasharray: 3 3;
  }
  /* Ink at low opacity, never a colour — see the note at the head of this file.
     The fill is what makes sixteen small graphs readable at a glance: the eye
     compares areas long before it compares the shapes of lines. */
  .under {
    fill: var(--paper-faint);
    opacity: 0.3;
  }
  .line {
    fill: none;
    stroke: var(--paper);
    stroke-width: 1.2;
    stroke-linejoin: round;
  }
  /* The busiest core sits *behind* the machine's own line and reads as the
     envelope it is, so the two are told apart by weight rather than by hue. */
  .peak {
    fill: none;
    stroke: var(--paper-faint);
    stroke-width: 1;
    stroke-linejoin: round;
  }

  .num {
    position: absolute;
    top: 1px;
    left: 2px;
    font-family: var(--mono);
    font-size: 8px;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    color: var(--paper-faint);
    pointer-events: none;
  }

  /* ── a bar per core ───────────────────────────────────────────────────── */

  .bars {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding-top: 0.24rem;
  }
  .bar {
    position: relative;
    flex: 1;
    min-width: 1px;
    background: var(--surface);
    border-radius: 1px;
    overflow: hidden;
  }
  .fill {
    position: absolute;
    inset: auto 0 0 0;
    height: calc(var(--v) * 100%);
    background: var(--paper-dim);
    /* Slower than the two-second beat that feeds it, so a step arrives as a
       movement rather than as a jump. Not a smoothing of the data: the reading
       genuinely changes in steps and nothing intermediate is being invented. */
    transition: height 0.5s cubic-bezier(0.3, 0, 0.2, 1);
  }

  .ends {
    display: flex;
    justify-content: space-between;
    gap: 0.8ch;
    padding: 0 0.1rem;
    font-size: 0.56rem;
    color: var(--paper-faint);
    white-space: nowrap;
    overflow: hidden;
  }
  .key {
    font-variant-numeric: tabular-nums;
  }

  .quiet,
  .fault {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 0.3rem 0.2rem 0;
    font-size: 0.66rem;
    color: var(--paper-faint);
    overflow: hidden;
  }
  .fault {
    color: var(--paper-mute);
  }
</style>
