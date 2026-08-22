<script lang="ts">
  /* How fast this wall is burning tokens.
   *
   * The derivative of the widget standing next to it: `usage` says how much has
   * gone, this says how fast it is going. Everything drawn here comes off the
   * same shared `Ledger` — the one transcript reader behind however many usage
   * widgets are up — so a rate widget adds no reader, no request and no poll.
   * A wall with either of them pays once; a wall with neither pays nothing.
   *
   * The arithmetic and the words are `rate.ts`, pure and tested, including the
   * two judgements worth arguing about: **per minute**, because a request
   * carries a median 163k tokens and lands every six seconds and only a fifth
   * of the clock has anything in it at all; and **ten minutes**, because the
   * buckets underneath are five wide and anything shorter reads bucket edges.
   * Both are measured against this machine's own transcripts and the numbers
   * are at the top of that file. Nothing here decides anything.
   *
   * ── colour ────────────────────────────────────────────────────────────────
   *
   * There is none, and that is a decision rather than an omission. Colour on
   * this wall is status — celadon working, amber asking, rust failed — and
   * going faster than usual is none of the three: nothing has failed and
   * nothing is waiting on you. The one reading here that would genuinely earn a
   * redline is burning the allowance faster than the window refills it, and it
   * cannot be had from this side: the account reports a percentage and the
   * transcripts report tokens, and nothing anywhere converts between them. So
   * the over-range is a mark that lights rather than a colour that appears, and
   * the needle is `--paper` like every other instrument on this wall. A red
   * needle would be the one decorative colour in the app. */

  import { clock } from "./conversation.svelte";
  import { arcPath, onFace } from "./clock";
  import type { Ledger } from "./ledger.svelte";
  import { count, readings } from "./usage";
  import {
    SWEEP_DEG,
    START_DEG,
    WINDOW_MS,
    angleFor,
    fracOf,
    fullScale,
    idleFor,
    over,
    perOf,
    rateAt,
    sayIdle,
    sayRate,
    sayTick,
    shortUnit,
    ticksOf,
    trace,
  } from "./rate";
  import { onOf, textOf, variantOf, type Widget } from "./widgets";

  let { widget, ledger }: { widget: Widget; ledger: Ledger } = $props();

  /* The one-second tick the wall already runs on, taken directly the way
     `Clock` and `Usage` take it — the reason none of the three adds a second
     wake-up per second to an otherwise idle machine. It matters more here than
     on either of them: the window's far edge slides with `now`, so this is what
     makes the needle fall smoothly through a lull instead of stepping every
     time a bucket drops out of the back. */
  const now = $derived(clock.t);
  const variant = $derived(variantOf(widget));
  const per = $derived(perOf(textOf(widget, "per", "minute")));
  const wantOdometer = $derived(onOf(widget, "odometer", true));

  /* Asking is what makes the reader run at all — with nothing on the wall
     watching, no transcript is walked. Two effects rather than one, for the
     reason `Usage.svelte` and `Perf.svelte` both give: a tracking effect's
     cleanup fires on every change, and a single one would detach on every
     re-read. `spend` and not `allowance`: this is a reading of the
     transcripts, and the account's percentages have no rate in them. */
  $effect(() => {
    ledger.attach(widget.id, "spend");
  });
  $effect(() => () => ledger.detach(widget.id));

  const slices = $derived(ledger.slices);
  const value = $derived(rateAt(slices, now, per));
  const scale = $derived(fullScale(slices, now, per));
  const frac = $derived(fracOf(value, scale));
  const past = $derived(over(value, scale));
  const unit = $derived(shortUnit(per));

  /** How long the wall has been quiet, once it has been quiet long enough to be
   *  worth saying. A dial reading zero is a correct dial, but "0" and "0, and
   *  nothing since lunch" are different mornings — and below the window there
   *  is nothing to say, since a rate of zero over ten minutes *is* the reading
   *  rather than an absence. */
  const quiet = $derived.by(() => {
    const ms = idleFor(slices, now);
    if (ms === null) return ledger.ready ? "nothing yet" : null;
    return ms > WINDOW_MS ? `quiet ${sayIdle(ms)}` : null;
  });

  /** The odometer: what these five hours have burned. The same figure the
   *  `usage` widget's block reading carries, deliberately — a speed and a
   *  distance on one face is the whole idiom, and two instruments disagreeing
   *  about the trip would be worse than one repeating it. */
  const odometer = $derived(
    wantOdometer ? readings(slices, now, "tokens").block.totals.tokens : 0,
  );

  /* ── the dial ─────────────────────────────────────────────────────────── */

  /* A fixed viewBox with the aspect handled by the SVG, the arrangement
     `Clock.svelte` uses: the box you drag is yours, and a dial drawn into an
     oval is a broken instrument.

     The dial holds the dial and nothing else, and the reading goes *underneath*
     it in ordinary markup. That was tried the other way round first — a digital
     readout low inside the face, which is where a car puts it — and rendered:
     with a 250° sweep the free cone below the hub is ±55°, so at the height a
     readout wants to sit the clear width is under fifty units and `3.37M` is
     seventy. It landed on the `0` and the top-of-scale numeral at once, and the
     needle at full scale went straight through it. A needle crossing the
     *numerals* is what every dial does and is fine; a needle crossing the
     figure you are trying to read is not. */
  const CX = 108;
  const CY = 92;
  const R = 76;

  const deg = $derived(angleFor(frac));
  const tip = $derived(onFace(CX, CY, R * 0.7, deg));
  const tail = $derived(onFace(CX, CY, 12, deg + 180));
  const track = arcPath(CX, CY, R, START_DEG + SWEEP_DEG, START_DEG);
  const swept = $derived(arcPath(CX, CY, R, deg, START_DEG));
  const marks = $derived(ticksOf(scale));

  /** The redline: the last stretch of the arc, heavier, and lit once the
   *  reading has reached it.
   *
   * A car's redline is a band on the scale rather than a mark beside it, and
   * drawn that way it needs no room outside the sweep — which the first attempt
   * did, and which rendered as a second tick nobody could tell from the arc's
   * own terminus. What it *means* here is the top of the dial, which is this
   * wall's own busy pace: lit says you are working at or past the rate you
   * reach in your busiest tenth. Ink, never colour — see the note at the top. */
  const redline = arcPath(
    CX,
    CY,
    R,
    START_DEG + SWEEP_DEG,
    START_DEG + SWEEP_DEG - 15,
  );

  /* ── the trace ────────────────────────────────────────────────────────── */

  const TRACE_N = 56;
  /** The past hour of the same reading, drawn where it was. Guarded on the
   *  variant so the other three faces never pay for fifty-six folds a second —
   *  `$derived` is lazy, but a template that reads it in one branch is not
   *  obviously so to somebody editing this later. */
  const history = $derived(variant === "trace" ? trace(slices, now, per, TRACE_N) : []);
  /** The trace's own ceiling: the dial's scale unless the hour went past it, in
   *  which case the line would be clipped flat and the shape — which is the
   *  whole reading — would be lost. */
  const ceiling = $derived(Math.max(scale, ...history));
  /** How far the line is held off the top and bottom of its box, in the same
   *  hundred units. The stroke has width and the box clips, so a flat hour
   *  drawn at exactly 100 loses its lower half and reads as a hairline that has
   *  been cut — which looks like a rendering fault rather than like a quiet
   *  hour. Seen at 216x196, not reasoned about. */
  const INSET = 2;
  const line = $derived(
    history
      .map((v, i) => {
        const x = (i / Math.max(1, TRACE_N - 1)) * 100;
        const k = ceiling > 0 ? Math.min(1, v / ceiling) : 0;
        return `${x.toFixed(2)},${(100 - INSET - k * (100 - 2 * INSET)).toFixed(2)}`;
      })
      .join(" "),
  );
  /** The same points closed down to the baseline, so the area beneath can be
   *  filled — a rate is a quantity per time and the area under it is the
   *  quantity, which is the one thing a bare line does not say. */
  const area = $derived(line ? `0,${100 - INSET} ${line} 100,${100 - INSET}` : "");

  /** Where the dial's own full scale falls on the trace, in the same inset
   *  hundred the line is drawn in — so the rule and the line agree about what
   *  height means. */
  const markY = $derived(
    ceiling > 0 ? 100 - INSET - (scale / ceiling) * (100 - 2 * INSET) : 0,
  );
</script>

<div class="burn" data-variant={variant} data-over={past ? "yes" : "no"}>
  {#if variant === "dial"}
    <svg viewBox="0 0 216 142" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <path d={track} class="track" />
      <path d={swept} class="swept" />

      {#each marks as m (m.frac)}
        {@const a = onFace(CX, CY, R - (m.major ? 13 : 7), m.deg)}
        {@const b = onFace(CX, CY, R - 1, m.deg)}
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} class="tick" class:major={m.major} />
      {/each}

      {#each marks.filter((m) => m.major) as m (m.frac)}
        {@const p = onFace(CX, CY, R - 26, m.deg)}
        <text x={p.x} y={p.y} class="numeral">{sayTick(m.at)}</text>
      {/each}

      <!-- The redline. Faint until the reading reaches the top of the dial,
           then full ink — a mark that lights, never a colour that appears. -->
      <path d={redline} class="peg" />

      <line x1={tail.x} y1={tail.y} x2={tip.x} y2={tip.y} class="needle" />
      <circle cx={CX} cy={CY} r="4.4" class="hub" />
    </svg>
    <div class="readout">
      <span class="big">{sayRate(value)}</span><span class="suffix">{unit}</span>
    </div>
    <div class="foot">
      {#if wantOdometer}<span class="trip">{count(odometer)} these five hours</span>{/if}
      {#if quiet}<span class="rest">{quiet}</span>{/if}
    </div>

  {:else if variant === "bar"}
    <!-- The one that survives at the smallest the widget may be dragged: a
         position on a track, and the number beside it. -->
    <div class="linear">
      <div class="figure">
        <span class="big">{sayRate(value)}</span><span class="suffix">{unit}</span>
      </div>
      <div class="rail" style:--v={frac}>
        <div class="fill"></div>
        {#each marks.filter((m) => m.major) as m (m.frac)}
          <span class="notch" style:left="{m.frac * 100}%"></span>
        {/each}
      </div>
      <div class="ends">
        <span>0</span>
        {#if quiet}<span class="rest">{quiet}</span>
        {:else if wantOdometer}<span class="trip">{count(odometer)} this block</span>{/if}
        <span>{sayTick(scale)}</span>
      </div>
    </div>

  {:else if variant === "trace"}
    <!-- The past hour of the same reading. A different question from the other
         three — not "how fast" but "how has it been going" — which is what
         makes it a face rather than a skin. -->
    <div class="linear">
      <div class="figure">
        <span class="big">{sayRate(value)}</span><span class="suffix">{unit}</span>
      </div>
      <svg class="graph" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {#if area}
          <polygon points={area} class="under" />
          <polyline points={line} class="line" vector-effect="non-scaling-stroke" />
        {/if}
        <!-- Where the dial's own full scale sits, so the line has something to
             be tall against. Absent when the hour never reached it. -->
        {#if ceiling > 0 && scale <= ceiling}
          <line
            x1="0"
            x2="100"
            y1={markY}
            y2={markY}
            class="mark"
            vector-effect="non-scaling-stroke"
          />
        {/if}
      </svg>
      <div class="ends">
        <span>an hour ago</span>
        {#if quiet}<span class="rest">{quiet}</span>
        {:else if wantOdometer}<span class="trip">{count(odometer)} this block</span>{/if}
        <span>now</span>
      </div>
    </div>

  {:else}
    <!-- Just the number. For a wall where this is one reading among many and
         the instrument would be the noisy part. -->
    <div class="plain">
      <span class="huge">{sayRate(value)}</span>
      <span class="under-unit">tokens {unit}</span>
      {#if quiet}
        <span class="rest">{quiet}</span>
      {:else if wantOdometer}
        <span class="trip">{count(odometer)} these five hours</span>
      {/if}
    </div>
  {/if}

  {#if ledger.fault && !ledger.ready}
    <!-- A ledger that cannot read the transcripts is a broken instrument, not a
         broken conversation, so it says so on its own face — the same call
         `Usage.svelte` and `Perf.svelte` make. -->
    <span class="fault">cannot read the transcripts</span>
  {/if}
</div>

<style>
  .burn {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    padding: 0.3rem 0.4rem;
    /* Paints no background of its own. The wrapper is opaque already, so this
       is the same fill either way — and leaving it there is what lets the
       `frame` knob's `bare` reach this face rather than being covered over by
       it. See the note in `WidgetNode.svelte`. */
    font-family: var(--util);
    color: var(--paper-dim);
  }

  svg {
    width: 100%;
    min-height: 0;
    flex: 1;
    overflow: visible;
  }

  /* ── the dial ─────────────────────────────────────────────────────────── */

  .track {
    fill: none;
    stroke: var(--edge);
    stroke-width: 2;
    stroke-linecap: round;
  }
  /* Where the needle has swept to. Thicker than the track it sits on, because
     at two units against `--edge` the two shades are a hairline apart and the
     sweep simply did not read — seen in the render, not reasoned about. Still
     faint, though: it is the same reading the needle gives and must not compete
     with it. */
  .swept {
    fill: none;
    stroke: var(--paper-faint);
    stroke-width: 3.4;
    stroke-linecap: round;
  }

  .tick {
    stroke: var(--rule);
    stroke-width: 1.3;
  }
  .tick.major {
    stroke: var(--paper-mute);
    stroke-width: 2.2;
  }

  .numeral {
    fill: var(--paper-mute);
    font-family: var(--util);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    text-anchor: middle;
    dominant-baseline: middle;
  }

  .peg {
    fill: none;
    stroke: var(--paper-faint);
    stroke-width: 4.6;
    stroke-linecap: butt;
    transition: stroke 0.25s ease;
  }
  .burn[data-over="yes"] .peg {
    stroke: var(--paper);
  }

  .needle {
    stroke: var(--paper);
    stroke-width: 2.6;
    stroke-linecap: round;
    /* Slower than the beat that feeds it, so a twenty-second step arrives as a
       swing rather than as a jump. Not a sweep: the reading genuinely changes
       in steps and a needle that glided between them would be inventing
       intermediate values it was never given. This is the length of the
       movement, not a smoothing of the data. */
    transition: all 0.6s cubic-bezier(0.3, 0, 0.2, 1);
  }
  .hub {
    fill: var(--paper);
    stroke: var(--ink);
    stroke-width: 1.2;
  }

  /* The reading, under the dial rather than inside it — see the note by `CX`
     for the render that settled that. Sized off the widget's own box so a dial
     dragged large is a large reading, which is also what it could not be while
     it lived in the SVG at a fixed number of user units. */
  .readout {
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 0.35ch;
    line-height: 1;
    padding-top: 0.1rem;
  }

  .foot {
    display: flex;
    gap: 0.8ch;
    align-items: baseline;
    max-width: 100%;
    padding-top: 0.1rem;
    font-size: min(6cqw, 0.58rem);
    white-space: nowrap;
    overflow: hidden;
  }

  /* ── the bar and the trace ────────────────────────────────────────────── */

  .linear {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.34rem;
    min-height: 0;
  }

  .figure {
    display: flex;
    align-items: baseline;
    gap: 0.4ch;
    line-height: 1;
  }

  /* The figure and its unit, shared by the dial's readout and the two linear
     faces — one definition, so the three cannot drift apart in what a rate
     looks like. */
  .big {
    font-family: var(--display);
    /* Sized off the widget's own box, so one dragged large is a large reading
       rather than a small one in a large frame — the `cqw`/`cqh` bargain the
       clock's faces already strike against `container-type: size`. */
    font-size: min(17cqw, 26cqh);
    font-variant-numeric: tabular-nums;
    color: var(--paper);
    line-height: 1;
  }
  .suffix {
    font-size: min(6.5cqw, 10cqh);
    color: var(--paper-mute);
  }
  /* Smaller under the dial, where the instrument above it is most of the face
     and the figure is the caption to it rather than the reading itself. */
  .readout .big {
    font-size: min(13cqw, 17cqh);
  }
  .readout .suffix {
    font-size: min(5.5cqw, 7cqh);
  }

  .rail {
    position: relative;
    height: 5px;
    flex: none;
    background: var(--edge);
    border-radius: 2px;
    overflow: hidden;
  }
  .fill {
    position: absolute;
    inset: 0 auto 0 0;
    width: calc(var(--v) * 100%);
    background: var(--paper-faint);
    transition: width 0.6s cubic-bezier(0.3, 0, 0.2, 1);
  }
  /* Pinned at the top edge, so the fill runs under them and the scale stays
     readable at every position rather than only where the bar is empty. */
  .notch {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--ink);
    opacity: 0.55;
  }
  .burn[data-over="yes"] .rail {
    /* Off the end: the rail itself takes the mark, since there is no room past
       full for a peg. Ink rather than colour, the same as the dial's. */
    box-shadow: inset -2.5px 0 0 var(--paper);
  }

  .graph {
    flex: 1;
    min-height: 0;
    width: 100%;
    overflow: hidden;
  }
  .under {
    fill: var(--paper-faint);
    opacity: 0.22;
  }
  .line {
    fill: none;
    stroke: var(--paper);
    stroke-width: 1.4;
    stroke-linejoin: round;
  }
  .mark {
    stroke: var(--rule);
    stroke-width: 1;
    stroke-dasharray: 3 3;
  }

  .ends {
    display: flex;
    justify-content: space-between;
    gap: 0.8ch;
    font-size: min(6cqw, 0.56rem);
    color: var(--paper-faint);
    white-space: nowrap;
    overflow: hidden;
  }

  /* ── the numerals ─────────────────────────────────────────────────────── */

  .plain {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.1rem;
    line-height: 1.05;
    max-width: 100%;
    /* The base for whatever this face carries besides the two sized below —
       the odometer and the resting line, which have no size of their own and
       inherited the document's 15px here. At the smallest this widget may be
       dragged that was two wrapped lines of footnote spilling out of the box,
       which is what a face with a `cqw` headline and a `rem` footnote does.
       Seen at 140x90, not reasoned about. */
    font-size: min(6.5cqw, 9cqh);
  }
  .huge {
    font-family: var(--display);
    font-size: min(28cqw, 40cqh);
    font-variant-numeric: tabular-nums;
    color: var(--paper);
  }
  .under-unit {
    font-size: min(8cqw, 11cqh);
    color: var(--paper-mute);
  }

  /* ── what is said beside the reading ──────────────────────────────────── */

  .trip {
    font-variant-numeric: tabular-nums;
    color: var(--paper-faint);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rest {
    color: var(--paper-faint);
    font-style: italic;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .fault {
    font-size: min(6cqw, 0.56rem);
    color: var(--paper-mute);
    padding-top: 0.15rem;
  }
</style>
