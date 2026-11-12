<script lang="ts">
  /* The analytics room: the instrument (§11). One of two presentations of the
   * surface's question, drawn under `Analytics.svelte`'s shell.
   *
   * Everything it *decides* is in `analyticsroom.ts` and tested there: where the
   * gaps are, what a bucket is called, what a null prints, how labels are
   * pushed apart. This file is geometry, pointer and paint. The keyboard is the
   * shell's, because the keys that change the question (span, measure, split)
   * belong to both presentations and a key handler per drawing would be two
   * handlers arguing over one press.
   *
   * **The series come in, rather than being built here.** The shell builds them
   * once from the window and hands the same array to whichever presentation is
   * in front, which is what makes "the numbers must agree across the swap"
   * true by construction rather than by two call sites staying in step (§11.15).
   *
   * **Colour is identity and it comes from the query layer.** Every series
   * colour is `analytics.ts::seriesColor`, handed out in its fixed order; the
   * chrome stays achromatic and the fold past the fifth is a text token.
   */
  import { tick, untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import {
    bucketLabel,
    measureText,
    nearestAt,
    niceAxis,
    readingsOf,
    shareText,
    sparkPoints,
    runsOfTimes,
    spreadLabels,
    stepAt,
    tickLabel,
    tickText,
    timesOf,
    tierSaid,
    type RoomSeries,
    type RoomMeasure,
    type RoomSplit,
  } from "./analyticsroom";
  import { bucketOf } from "./analytics";
  import { count } from "./usage";
  import type { Bucket } from "./analytics";
  import AnalyticsCardLife from "./AnalyticsCardLife.svelte";
  import AnalyticsFundings from "./AnalyticsFundings.svelte";
  import type { CardLife } from "./analyticslife";
  import type { StripTile } from "./analyticstiles";
  import type { Exchange, FundingReading } from "./fundings";

  let {
    window: win,
    series,
    measure,
    split,
    span,
    title,
    bucket,
    strip,
    funding,
    card,
  }: {
    /** The window that came back. Its bounds are the axis; its rows are not
     *  read here, since the series are already built from them. */
    window: { since: number; until: number; tier: "fine" | "hourly"; rows: unknown[] };
    /** Built once by the shell and shared with the page. */
    series: RoomSeries[];
    measure: RoomMeasure;
    split: RoomSplit;
    /** The span the axis was asked for. Read only to notice that it changed:
     *  a selection is a bucket in an axis a new span will not have. */
    span: string;
    /** The chart's own title: the span, the measure and the split, composed by
     *  the shell so the two presentations say the same words. */
    title: string;
    bucket: Bucket;
    /** The live strip's tiles (§11.1), folded by the shell from the window, the
     *  allowance samples, the flyway's readings and the gesture collector. */
    strip: readonly StripTile[];
    /** The day split by who paid (§21): the title bar's figure, the account's
     *  windows, and the exchange between them. `readings` is null when that read
     *  failed, which the block says in words. */
    funding: { readings: readonly FundingReading[] | null; exchange: readonly Exchange[] };
    /** A card opened from its own row or `<space> n a` (§11.10). It is the
     *  inspector's first block, above the bucket, because the room has exactly
     *  one column on the right and two panels called inspector is one too
     *  many. */
    card?: { life: CardLife | null; failed: string | null; busy: boolean; onclose: () => void };
  } = $props();

  const list = $derived(series);

  let table = $state(false);
  let selected = $state<number | null>(null);
  let hovered = $state<number | null>(null);

  /* **A new span is a new axis, so the selection goes with the old one.** The
     selected instant is a bucket of the axis it was chosen on; carried to a
     different span it is an instant the axis does not contain, and the
     crosshair is drawn at a position no bucket has. The room owns this because
     the selection is this drawing's (the shell's read effect deliberately does
     not touch it): the 65-second refresh leaves it alone, which is the
     difference between a room you left reading a bucket and one that drops
     your place under you, and a span change does not. */
  let axisSpan = untrack(() => span);
  $effect(() => {
    if (span === axisSpan) return;
    axisSpan = span;
    selected = null;
    hovered = null;
  });

  let canvas = $state<HTMLElement>();
  let scroller = $state<HTMLElement>();
  let box = $state({ w: 860, h: 300 });

  /* ── what it means ───────────────────────────────────────────────────── */

  const times = $derived(timesOf(list));
  const readings = $derived(readingsOf(list));

  /* ── geometry ────────────────────────────────────────────────────────── */

  const PAD = { l: 58, t: 14, b: 26 };
  const labelled = $derived(list.length >= 4 && !table);
  const padR = $derived(labelled ? 122 : 16);
  const plotW = $derived(Math.max(20, box.w - PAD.l - padR));
  const plotH = $derived(Math.max(20, box.h - PAD.t - PAD.b));
  const from = $derived(win.since ?? 0);
  const to = $derived(win.until ?? 1);
  const width = $derived(Math.max(1, to - from));

  const highest = $derived.by(() => {
    let top = 0;
    for (const r of readings.values()) if (r.total > top) top = r.total;
    return top;
  });
  const axis = $derived(niceAxis(highest));

  const xOf = (at: number) => PAD.l + ((at - from) / width) * plotW;
  const yOf = (v: number) => (axis.top > 0 ? PAD.t + plotH - (v / axis.top) * plotH : PAD.t + plotH);

  /* The value each series carries at each axis instant, and the running total
     up to and including it. One table for the bands, the tooltip and the
     inspector, so a stack cannot disagree with its own legend. */
  const valueAt = $derived.by(() => list.map((s) => new Map(s.points.map((p) => [p.at, p.value]))));
  const cum = $derived.by(() => {
    const out: Map<number, number>[] = [];
    let below = new Map<number, number>();
    for (let si = 0; si < list.length; si += 1) {
      const here = new Map<number, number>();
      for (const t of times) here.set(t, (below.get(t) ?? 0) + (valueAt[si].get(t) ?? 0));
      out.push(here);
      below = here;
    }
    return out;
  });

  /* A run is a stretch of adjacent recorded buckets. The break is where the
     line stops, which is what makes a quiet hour a gap rather than a dip. The
     rule itself is `analyticsroom.ts::runsOfTimes`, tested there. */
  const timeRuns = $derived(runsOfTimes(times, bucket));

  const bands = $derived.by(() =>
    timeRuns.map((run) => ({
      run,
      series: list.map((s, si) => {
        const top = run.map((t) => yOf(cum[si].get(t) ?? 0));
        const bottom = run.map((t) => (si === 0 ? yOf(0) : yOf(cum[si - 1].get(t) ?? 0)));
        const xs = run.map((t) => xOf(t));
        let area = `M ${xs[0].toFixed(1)} ${top[0].toFixed(1)}`;
        for (let i = 1; i < run.length; i += 1) area += ` L ${xs[i].toFixed(1)} ${top[i].toFixed(1)}`;
        for (let i = run.length - 1; i >= 0; i -= 1) area += ` L ${xs[i].toFixed(1)} ${bottom[i].toFixed(1)}`;
        area += " Z";
        let line = `M ${xs[0].toFixed(1)} ${top[0].toFixed(1)}`;
        for (let i = 1; i < run.length; i += 1) line += ` L ${xs[i].toFixed(1)} ${top[i].toFixed(1)}`;
        return { color: s.color, area: run.length > 1 ? area : "", line: run.length > 1 ? line : "", dot: run.length === 1 ? { x: xs[0], y: top[0] } : null };
      }),
    })),
  );

  /* Direct labels live in a right-hand gutter, one per series, at the height
     its band reaches when that series was last recorded. §10.3 makes them
     mandatory at four series, which is where the palette starts to sit close
     enough together that a legend alone asks you to match colours. */
  const labels = $derived.by(() => {
    if (!labelled) return [];
    const wanted: { label: string; color: string; y: number }[] = [];
    list.forEach((s, si) => {
      const last = s.points[s.points.length - 1];
      if (!last) return;
      const top = yOf(cum[si].get(last.at) ?? 0);
      const bottom = si === 0 ? yOf(0) : yOf(cum[si - 1].get(last.at) ?? 0);
      wanted.push({ label: s.label, color: s.color, y: (top + bottom) / 2 });
    });
    return spreadLabels(wanted, 13, PAD.t + 5, PAD.t + plotH - 2);
  });

  const active = $derived(hovered ?? selected);
  const activeReading = $derived(active !== null ? (readings.get(active) ?? null) : null);

  /* The tooltip is HTML rather than SVG text so its prose wraps and its colours
     are tokens. It is kept inside the box it belongs to rather than following
     the pointer, which would make it flicker under the hand. */
  const tip = $derived.by(() => {
    if (table || hovered === null) return null;
    const reading = readings.get(hovered);
    if (!reading) return null;
    const wide = 232;
    return {
      left: Math.min(Math.max(6, xOf(hovered) + 12), Math.max(6, box.w - wide - 6)),
      reading,
      label: bucketLabel(hovered, bucket),
    };
  });

  /* Five labels, snapped to the rung they name. An evenly spaced instant lands
     at 20:23 because the window starts when it is opened; a bucket boundary is
     the reading, and it is what the point above the label was drawn from. */
  const xTicks = $derived.by(() => {
    const n = 5;
    const out: { x: number; text: string }[] = [];
    for (let i = 0; i < n; i += 1) {
      const at = bucketOf(from + ((to - from) * i) / (n - 1), bucket);
      out.push({ x: Math.min(PAD.l + plotW, Math.max(PAD.l, xOf(at))), text: tickLabel(at, bucket) });
    }
    return out;
  });

  /* Svelte keys an `each` by identity and throws on a duplicate in production as
     well as in development. A series' own `key` is its split value, and that is
     not unique in two reaches: a dimension value can literally be named `other`
     beside the fold, and two distinct values can both render as `unnamed`. The
     slot is unique by construction — five of them plus the fold — so that is
     what the markup keys on. */
  function seriesKey(s: RoomSeries): string {
    return s.slot === null ? "fold" : `s${s.slot}`;
  }

  /* ── the verbs the shell reaches for ─────────────────────────────────── */

  export function toggleTable() {
    table = !table;
    /* `t` takes away the plot the pointer button lives in, and a removed
       focused element hands focus to `body` with no event of its own. The
       canvas is the stable thing beside it, so it takes the focus back after
       the DOM has caught up — and a tab from there still lands inside the
       overlay's focus trap. */
    void tick().then(() => canvas?.focus());
  }

  export function move(delta: number) {
    selected = stepAt(times, hovered ?? selected, delta);
    hovered = null;
  }

  export function toEnd(last: boolean) {
    selected = times.length ? times[last ? times.length - 1 : 0] : null;
    hovered = null;
  }

  function measured(el: HTMLElement) {
    const ro = new ResizeObserver(() => (box = { w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }

  /* Walk the table with the selection, so the row you are reading is the row
     you can see. */
  $effect(() => {
    if (!table || selected === null) return;
    void times;
    scroller?.querySelector('.an-tr.on')?.scrollIntoView({ block: "nearest" });
  });

  function pick(at: number | null) {
    selected = at;
    hovered = null;
  }
</script>

<div class="an-body">
  <div class="an-strip" aria-label="the live strip">
    {#each strip as tile (tile.key)}
      <div class="an-tile" class:off={tile.off} title={tile.title}>
        <span class="an-tile-label">{tile.label}</span>
        <span class="an-tile-value">{tile.value}</span>
        <span class="an-tile-note">{tile.note}</span>
        {#if tile.points && tile.points.length > 1 && !tile.off}
          <svg class="an-spark" viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden="true">
            <polyline points={sparkPoints(tile.points)} vector-effect="non-scaling-stroke" />
          </svg>
        {/if}
      </div>
    {/each}
  </div>

  <AnalyticsFundings readings={funding.readings} exchange={funding.exchange} />

  <div class="an-main" class:with-card={!!card}>
<section class="an-canvas" aria-label={table ? "the window as a table" : "the window over time"} tabindex="-1" bind:this={canvas}>
  <div class="an-chart-head">
    <span class="an-title">{title}</span>
    <span class="an-grow"></span>
    {#if list.length >= 2}
      <span class="an-legend">
        {#each list as s (seriesKey(s))}
          <span class="an-key">
            <span class="an-dot" style:background={s.color}></span>
            {s.label}{#if labelled}&nbsp;{/if}
            <!-- A group whose rows the measure could not answer has no
                 points and no total: a dash, never the $0 that would
                 read as free. -->
            <span class="an-key-value">{measureText(measure, s.points.length ? s.total : null)}</span>
          </span>
        {/each}
      </span>
    {/if}
    <button
      type="button"
      class="an-btn"
      class:on={table}
      aria-pressed={table}
      title="the same numbers as a table (t)"
      onclick={toggleTable}
      ><Icon name={table ? "wave" : "list"} small />{table ? "chart" : "table"}</button
    >
  </div>

  {#if table}
    <div class="an-table-wrap" bind:this={scroller}>
      <table class="an-table">
        <thead>
          <tr>
            <th scope="col">bucket</th>
            {#each list as s (seriesKey(s))}
              <th scope="col" class="an-num">{s.label || "value"}</th>
            {/each}
            <th scope="col" class="an-num">total</th>
          </tr>
        </thead>
        <tbody>
          {#each times as t (t)}
            {@const reading = readings.get(t)}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <tr class="an-tr" class:on={active === t} onpointerenter={() => (hovered = t)} onpointerdown={() => pick(t)}>
              <th scope="row">{bucketLabel(t, bucket)}</th>
              {#each list as s, si (seriesKey(s))}
                <td class="an-num">{measureText(measure, valueAt[si]?.get(t) ?? null)}</td>
              {/each}
              <td class="an-num">{measureText(measure, reading?.total ?? null)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="an-plot" {@attach measured}>
      <svg class="an-svg" viewBox={`0 0 ${box.w} ${box.h}`} width={box.w} height={box.h} role="presentation">
        {#each axis.ticks as v (v)}
          <line class="an-grid" x1={PAD.l} x2={PAD.l + plotW} y1={yOf(v)} y2={yOf(v)} />
          {#if v !== 0}
            <!-- The gridline at zero stays; its *number* does not. An area
                 chart's baseline is the axis line it is filled to, so the
                 figure is the one label an axis can do without — and it is the
                 one that lands in the bottom left corner, where `$0` and
                 `12 oct` at 10px read as a single broken label. -->
            <text class="an-axis" x={PAD.l - 8} y={yOf(v) + 3.5} text-anchor="end">{tickText(measure, v)}</text>
          {/if}
        {/each}

        {#each bands as band (band.run[0])}
          {#each band.series as s, si (si)}
            {#if s.area}
              <path d={s.area} fill={s.color} fill-opacity="0.2" stroke="none" />
              <path d={s.line} fill="none" stroke={s.color} stroke-width="1.6" stroke-linejoin="round" />
            {:else if s.dot}
              <circle cx={s.dot.x} cy={s.dot.y} r="2.6" fill={s.color} />
            {/if}
          {/each}
        {/each}

        {#each xTicks as tick, i (i)}
          <text class="an-axis" x={tick.x} y={PAD.t + plotH + 17} text-anchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}>
            {tick.text}
          </text>
        {/each}

        {#if active !== null}
          <line class="an-cross" x1={xOf(active)} x2={xOf(active)} y1={PAD.t} y2={PAD.t + plotH} />
          {#each list as s, si (seriesKey(s))}
            {@const reading = readings.get(active)}
            {#if reading?.parts.some((p) => p.key === s.key)}
              <circle cx={xOf(active)} cy={yOf(cum[si].get(active) ?? 0)} r="3.4" fill={s.color} stroke="var(--surface)" stroke-width="1.5" />
            {/if}
          {/each}
        {/if}

        {#each labels as l, i (i)}
          <circle cx={PAD.l + plotW + 9} cy={l.y} r="3" fill={l.color} />
          <text class="an-direct" x={PAD.l + plotW + 17} y={l.y + 3.5}>{l.label}</text>
        {/each}
      </svg>

      {#if tip}
        <div class="an-tip" style:left={`${tip.left}px`}>
          <p class="an-tip-when">{tip.label}</p>
          <p class="an-tip-value">{measureText(measure, tip.reading.total)}</p>
          {#if tip.reading.parts.length > 1}
            <table class="an-tip-parts">
              <tbody>
                {#each tip.reading.parts as part, i (i)}
                  <tr>
                    <td><span class="an-dot" style:background={part.color}></span>{part.label}</td>
                    <td class="an-num">{measureText(measure, part.value)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>
      {/if}

      <button
        type="button"
        class="an-hit"
        aria-label="walk the buckets"
        onpointermove={(e) => {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const t = from + ((e.clientX - rect.left - PAD.l) / Math.max(1, plotW)) * width;
          hovered = nearestAt(times, t);
        }}
        onpointerleave={() => (hovered = null)}
        onpointerdown={() => (selected = hovered)}
        onfocus={() => (hovered = hovered ?? selected ?? times[times.length - 1] ?? null)}
      ></button>
    </div>
  {/if}
</section>

<aside class="an-inspect" aria-label={card ? "this card, and the selected bucket" : "the selected bucket"}>
  {#if card}
    <div class="an-inspect-card">
      {#if card.failed}
        <p class="an-inspect-fail">could not read this card</p>
        <p class="an-note">{card.failed}</p>
      {:else if !card.life}
        <p class="an-note">{card.busy ? "reading this card…" : "no answer yet"}</p>
      {:else}
        <AnalyticsCardLife life={card.life} onclose={card.onclose} />
      {/if}
    </div>
    <h3>bucket</h3>
  {:else}
    <h3>inspector</h3>
  {/if}
  {#if activeReading && active !== null}
    <p class="an-inspect-when">{bucketLabel(active, bucket)}</p>
    <p class="an-inspect-value">{measureText(measure, activeReading.total)}</p>
    {#if activeReading.parts.length > 1}
      <ul class="an-inspect-parts">
        {#each activeReading.parts as part, i (i)}
          <li>
            <span class="an-dot" style:background={part.color}></span>
            <span class="an-inspect-name">{part.label}</span>
            <span class="an-num">{measureText(measure, part.value)}</span>
            <span class="an-inspect-share">{shareText(activeReading.total > 0 ? (part.value / activeReading.total) * 100 : null)}</span>
          </li>
        {/each}
      </ul>
    {/if}
    <dl class="an-prov">
      <dt>measure</dt>
      <dd>{measure === "usd_modeled" ? "modeled spend" : "every token kind"}</dd>
      <dt>source</dt>
      <dd>{tierSaid(win.tier)}</dd>
      <dt>bucket</dt>
      <dd>{bucket} · {count(times.length)} recorded</dd>
      {#if split}
        <dt>split</dt>
        <dd>by {split}</dd>
      {/if}
    </dl>
  {:else}
    <p class="an-note">hover or click a bucket to read it here</p>
  {/if}
</aside>
  </div>
</div>

<style>
  .an-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .an-main {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 252px;
  }

  /* ── the strip ────────────────────────────────────────────────────────── */

  .an-strip {
    flex: none;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(126px, 1fr));
    gap: 1px;
    background: var(--cv-hair, var(--edge));
    border-bottom: 1px solid var(--cv-hair, var(--edge));
  }
  .an-tile {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 9px 12px 10px;
    background: var(--raised);
    min-width: 0;
  }
  .an-tile-label {
    font-size: 10px;
    text-transform: lowercase;
    color: var(--paper-faint);
  }
  .an-tile-value {
    font-size: 17px;
    font-weight: 600;
    color: var(--paper);
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .an-tile-note {
    font-size: 10.5px;
    color: var(--paper-mute);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* A tile that cannot be measured says so rather than showing a zero. */
  .an-tile.off .an-tile-value {
    font-size: 12px;
    font-weight: 500;
    color: var(--paper-faint);
  }
  /* The history, as a shape. One pixel whatever the tile's width, and recessive
     enough that the tile's numeral stays the reading and this stays the cue. */
  .an-spark {
    display: block;
    width: 100%;
    height: 18px;
    margin-top: 2px;
    opacity: 0.7;
  }
  .an-spark polyline {
    fill: none;
    stroke: color-mix(in oklab, var(--paper) 55%, transparent);
    stroke-width: 1;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  .an-grow {
    flex: 1;
  }
  .an-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid var(--edge);
    background: transparent;
    color: var(--paper-dim);
    font: 11.5px var(--cv-ui, var(--util));
    padding: 4px 9px;
    border-radius: 7px;
    cursor: pointer;
  }
  .an-btn:hover,
  .an-btn.on {
    color: var(--paper);
    background: color-mix(in oklab, var(--paper) 7%, transparent);
  }

  .an-canvas {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 10px 12px 6px;
    outline: none;
  }
  .an-chart-head {
    flex: none;
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
    padding: 0 4px 6px;
  }
  .an-title {
    font-size: 12px;
    color: var(--paper-dim);
  }
  .an-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    font-size: 11px;
    color: var(--paper-mute);
  }
  .an-key {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }
  .an-key-value {
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }
  .an-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 2px;
    flex: none;
  }

  .an-plot {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .an-svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .an-grid {
    stroke: var(--edge);
    stroke-width: 1;
  }
  .an-axis {
    fill: var(--paper-faint);
    font-size: 10px;
    font-family: var(--cv-ui, var(--util));
    font-variant-numeric: tabular-nums;
  }
  .an-direct {
    fill: var(--paper-dim);
    font-size: 10px;
    font-family: var(--cv-ui, var(--util));
  }
  .an-cross {
    stroke: var(--paper-mute);
    stroke-width: 1;
    stroke-dasharray: 3 3;
    pointer-events: none;
  }
  /* The pointer target is one button over the plot so the whole area is
     reachable, and so it can take focus for the keyboard path. */
  .an-hit {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
    background: transparent;
    cursor: crosshair;
    outline: none;
  }
  .an-hit:focus-visible {
    outline: 1px solid var(--paper-mute);
    outline-offset: -1px;
    border-radius: 6px;
  }

  .an-tip {
    position: absolute;
    top: 8px;
    min-width: 150px;
    max-width: 232px;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--edge);
    background: var(--surface);
    box-shadow: 0 12px 28px -18px var(--shade);
    pointer-events: none;
  }
  .an-tip-when {
    margin: 0;
    font-size: 10.5px;
    color: var(--paper-faint);
  }
  .an-tip-value {
    margin: 1px 0 4px;
    font-size: 14px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .an-tip-parts {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
    color: var(--paper-dim);
  }
  .an-tip-parts td {
    padding: 1px 0;
  }
  .an-tip-parts td:first-child {
    display: flex;
    align-items: center;
    gap: 5px;
    padding-right: 12px;
  }
  .an-tip-parts .an-num {
    text-align: right;
  }

  /* ── the table, which is the chart's honest twin ──────────────────────── */

  .an-table-wrap {
    flex: 1;
    min-height: 0;
    overflow: auto;
    border: 1px solid var(--cv-hair, var(--edge));
    border-radius: 8px;
  }
  .an-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }
  .an-table th,
  .an-table td {
    padding: 5px 10px;
    text-align: left;
    border-bottom: 1px solid var(--cv-hair, var(--edge));
    white-space: nowrap;
  }
  .an-table thead th {
    position: sticky;
    top: 0;
    background: var(--raised);
    color: var(--paper-faint);
    font-weight: 500;
    font-size: 10.5px;
    z-index: 1;
  }
  .an-table tbody th {
    font-weight: 400;
    color: var(--paper-dim);
  }
  .an-table .an-num {
    text-align: right;
    color: var(--paper);
  }
  .an-tr.on {
    background: color-mix(in oklab, var(--paper) 7%, transparent);
  }

  /* ── the inspector ────────────────────────────────────────────────────── */

  /* A card's page is wider than a bucket's reading, so the column widens with
     one and the chart gives it up. 340px is where the change timeline's date
     and sentence stop fighting for the same line. */
  .an-main.with-card {
    grid-template-columns: minmax(0, 1fr) 340px;
  }
  /* The card brings its own padding; the aside's would double it, so the card
     is pulled out to the column's edges and rules itself off from the bucket. */
  .an-inspect-card {
    margin: -12px -14px 0;
    border-bottom: 1px solid var(--cv-hair, var(--edge));
  }
  .an-inspect-card .an-note {
    padding: 12px 14px;
  }
  .an-inspect-fail {
    margin: 0;
    padding: 12px 14px 0;
    font-size: 12.5px;
    color: var(--st-fail);
  }
  .an-inspect-card + h3 {
    margin-top: 12px;
  }
  .an-inspect {
    min-height: 0;
    overflow: auto;
    padding: 12px 14px;
    border-left: 1px solid var(--cv-hair, var(--edge));
    background: color-mix(in oklab, var(--paper) 2%, transparent);
  }
  .an-inspect h3 {
    margin: 0 0 8px;
    font-size: 10px;
    font-weight: 500;
    text-transform: lowercase;
    letter-spacing: 0.04em;
    color: var(--paper-faint);
  }
  .an-inspect-when {
    margin: 0;
    font-size: 11px;
    color: var(--paper-mute);
  }
  .an-inspect-value {
    margin: 2px 0 10px;
    font-size: 22px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .an-inspect-parts {
    list-style: none;
    margin: 0 0 12px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 11.5px;
  }
  .an-inspect-parts li {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .an-inspect-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--paper-dim);
  }
  .an-inspect-share {
    width: 38px;
    text-align: right;
    color: var(--paper-faint);
  }
  .an-prov {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 3px 10px;
    margin: 0;
    font-size: 10.5px;
  }
  .an-prov dt {
    color: var(--paper-faint);
  }
  .an-prov dd {
    margin: 0;
    color: var(--paper-mute);
  }
  .an-note {
    margin: 0;
    font-size: 12px;
    color: var(--paper-mute);
    max-width: 46ch;
  }
</style>
