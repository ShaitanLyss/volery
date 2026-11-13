<script lang="ts">
  /* An analytics view, drawn small: the third surface of one spec (§12).
   *
   * The same `splitSeries` the room and the page draw, over the same window, so a
   * widget, a sheet and the overlay cannot disagree about a number (§9.1's one
   * reader, one reading). What is *not* shared is the chrome: a widget has no
   * filter rail, no table, no KPI strip and no crosshair, because it is a
   * reading you glance at rather than a room you enter.
   *
   * Three size intents, and they are a knob rather than three kinds, because all
   * three draw one spec:
   *
   *  - **`stat`** is one measure, a figure, how it compares with the window
   *    before it, and a sparkline. The second window is the one reading here
   *    that costs a second read, and it is asked for only by this arm
   *    (`analyticsholder.svelte.ts`).
   *  - **`chart`** is one panel: the lines, a legend, and nothing else. Sans the
   *    rail because a widget has no room for one, and the view it reads already
   *    carries its filter.
   *  - **`board`** stacks that chart over the split as bars, or over the
   *    window's counts when the spec asks for no split.
   *
   * **A shared widget writes back what it drew**, so the wall survives the view
   * being deleted under it, and says so until somebody chooses to keep the copy.
   * That is `analyticswidget.ts::snapshotOf`, and the write is guarded on a
   * change so a widget cannot update itself on every frame.
   */
  import Icon from "./Icon.svelte";
  import type { Analytics } from "./analyticsholder.svelte";
  import { loadSavedViews, savedViews } from "./analyticslibrary.svelte";
  import {
    boardPanels,
    changeAgainst,
    changeSaid,
    configOf,
    forkedOf,
    pathOf,
    resolveOf,
    seriesPath,
    shareSaid,
    SNAPSHOT,
    snapshotOf,
    spanMsFor,
    statOf,
    type Reading,
  } from "./analyticswidget";
  import { fold, type Point, type ViewSpec } from "./analytics";
  import { pageModel, refusalOf, surfaceOfView, surfaceRows } from "./analyticpage";
  import {
    emptinessOf,
    measureText,
    readingsOf,
    roomBucket,
    timesOf,
    windowTier,
    type AnalyticsWindow,
  } from "./analyticsroom";
  import { count } from "./usage";
  import type { Widget } from "./widgets";

  let {
    widget,
    analytics,
    onupdate,
    onopen,
  }: {
    widget: Widget;
    analytics: Analytics;
    onupdate: (patch: Partial<Widget>, quiet?: boolean) => void;
    /** Open this view in the overlay, where the controls that change it live.
     *  Routed out for the reason every hover on this wall is: which surface is
     *  on screen is the studio's business, not a widget's. */
    onopen?: (view: ViewSpec) => void;
  } = $props();

  const config = $derived(configOf(widget.config));
  /* `ready` and not just the list: a library nobody has read yet is not a
     library with nothing in it, and the difference is the difference between a
     widget drawing quietly and one saying its view was deleted. */
  const reading = $derived(resolveOf(config, savedViews.list, savedViews.ready));
  const span = $derived(reading?.spec.span ?? "7d");

  /* Asking is what makes the reader run at all: with no analytics widget up, no
     facts are scanned. Two effects rather than one, for the reason `Speedo`
     gives — a tracking effect's cleanup fires on every change, and one effect
     would detach on every re-read. */
  $effect(() => {
    /* A widget whose spec cannot be read draws nothing, so it asks for nothing:
       a poller kept alive for a face with no drawing is a query a minute spent
       on nobody's reading. And one that *loses* its spec lets go, rather than
       leaving a subscription behind a face that has stopped asking. */
    if (!reading || refused) {
      analytics.detach(widget.id);
      return;
    }
    analytics.attach(widget.id, span, config.size === "stat");
  });
  $effect(() => () => analytics.detach(widget.id));

  /* The library, read once per wall rather than once per widget. Asked only by
     a widget that points at a saved view, and the read is cached until a write. */
  $effect(() => {
    /* `analytics.at` is the dependency that makes a failed read retryable: the
       pass ticks it, and a library that never answered is asked again rather
       than left empty for the life of the wall. */
    void analytics.at;
    if (reading?.shared && !savedViews.ready) void loadSavedViews().catch(() => {});
  });

  /* What it drew, kept beside the id. `snapshotOf` answers null until there is
     something new to write, so this settles after one write and then does
     nothing — an unguarded write here would be a widget updating itself on
     every frame. */
  $effect(() => {
    const next = reading ? snapshotOf(config, reading) : null;
    if (!next) return;
    /* **Quiet, and it has to be.** This write is bookkeeping rather than a
       gesture: a remembered one can be undone, the next pass writes it back,
       and the stack then has an act on top that cannot be got past, so Ctrl+Z
       stops working for the whole wall. See `widgets.svelte.ts::updateQuiet`. */
    onupdate({ config: { ...widget.config, [SNAPSHOT]: next } }, true);
  });

  /* A spec the query layer refuses to answer is a widget that must say why
     rather than draw a degraded view: §9.1 refuses with the tier named, and a
     default in its place would be a reading nobody asked for. Captured once so
     the sentence does not change under a redraw. */
  const at = Date.now();
  const refused = $derived(reading ? refusalOf(reading.spec, at) : null);

  const win = $derived<AnalyticsWindow | undefined>(analytics.windows[span]);
  const fault = $derived(analytics.faults[span] ?? null);

  const model = $derived.by(() => {
    if (!win || !reading) return null;
    const surface = surfaceOfView(reading.spec);
    const spanMs = spanMsFor(span);
    return pageModel({
      window: win,
      filter: reading.spec.filter,
      measure: surface.measure,
      split: surface.split,
      bucket: roomBucket(spanMs, windowTier(spanMs)),
      span,
    });
  });

  const measure = $derived(reading ? surfaceOfView(reading.spec).measure : "usd_modeled");
  const split = $derived(reading ? surfaceOfView(reading.spec).split : null);

  /* The window's points, one reading a bucket. The sparkline and the chart's
     axis both come off these, so the two drawings cannot scale differently. */
  const points = $derived.by<Point[]>(() => {
    if (!model) return [];
    const at = readingsOf(model.series);
    return timesOf(model.series).map((t) => ({ at: t, value: at.get(t)?.total ?? 0 }));
  });

  const top = $derived(points.reduce((m, p) => (p.value > m ? p.value : m), 0));
  const since = $derived(win?.since ?? 0);
  const until = $derived(win?.until ?? 0);

  const stat = $derived.by(() => {
    if (!win || !reading) return null;
    const before = analytics.priors[span];
    const rows = surfaceRows(win, reading.spec.filter);
    const prior = before ? fold(surfaceRows(before, reading.spec.filter), measure) : null;
    return statOf(fold(rows, measure), prior);
  });

  const empty = $derived(win ? emptinessOf(win) : null);
  const once = $derived(model ? model.series.filter((s) => s.points.length > 0) : []);

  /* The sparkline's box, in the units the path is built in. Drawn into a
     `preserveAspectRatio="none"` viewBox, so the numbers here are the path's and
     have nothing to do with pixels — which is what lets the same path be right
     at every size the widget can be dragged to. */
  const SPARK_W = 100;
  const SPARK_H = 30;

  function keepCopy(current: Reading) {
    onupdate(forkedOf(widget.config, current));
  }

  /* The legend's rows: at most four, because past that the labels are longer
     than the box and the fold (`other`) is already among them. */
  const legend = $derived(once.slice(0, 4));
</script>

<div class="af" data-size={config.size}>
  {#if !reading}
    {#if config.view && !savedViews.ready}
      <!-- Not a deleted view yet: a library nobody has read. Saying "gone"
           before the answer arrives is a false statement about the user's
           data, and this is the second it would be made in. -->
      <p class="said quiet">reading the library…</p>
    {:else}
      <!-- A shared view that was deleted with nothing drawn before it: there is
           no snapshot to stand in, and drawing a default would be inventing a
           reading. The widget says so rather than going blank. -->
      <p class="said">the view this widget read is gone, and nothing was kept of it.</p>
    {/if}
  {:else if refused}
    <p class="said">cannot be answered: {refused}</p>
  {:else if !win && fault}
    <p class="said">could not read the facts. {fault}</p>
  {:else if !win}
    <p class="said quiet">reading…</p>
  {:else if empty}
    <header class="top"><span class="who">{reading.name}</span></header>
    <p class="said">{empty.title}<span class="quiet"> {empty.note}</span></p>
  {:else}
    <header class="top">
      <span class="who" title={`${reading.name} · ${span}`}>{reading.name}</span>
      {#if reading.shared}
        <span class="share" class:gone={reading.gone} title={shareSaid(reading)}
          >{reading.gone ? "kept" : "shared"}</span
        >
      {/if}
      {#if reading.gone}
        <button type="button" class="act" title="keep this as this widget's own view" onclick={() => keepCopy(reading)}
          >keep</button
        >
      {/if}
      {#if onopen}
        <button type="button" class="act open" title="open in analytics" aria-label="open in analytics" onclick={() => onopen?.(reading.spec)}
          ><Icon name="arrow-r" small /></button
        >
      {/if}
    </header>

    {#if config.size === "stat" && stat}
      <div class="fig">
        <span class="n">{measureText(measure, stat.value)}</span>
        {#if stat.change !== null}
          <span class="d">{changeSaid(stat)}{" "}<span class="quiet">{changeAgainst(span)}</span></span>
        {:else if stat.before !== null}
          <span class="d quiet">{measureText(measure, stat.before)} in that span before</span>
        {:else}
          <span class="d quiet">no earlier window to compare it with</span>
        {/if}
      </div>
      <svg class="spark" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true">
        <path d={pathOf(points, SPARK_W, SPARK_H, 1)} />
      </svg>
    {:else if config.size === "board"}
      <div class="board">
        {#each boardPanels(split) as panel (panel.id)}
          <section class="panel">
            <h4>{panel.title}</h4>
            {#if panel.id === "trend"}
              <svg class="chart" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true">
                {#each once as s (s.key)}
                  <path d={seriesPath(s.points, since, until, top, SPARK_W, SPARK_H, 1)} stroke={s.color} />
                {/each}
              </svg>
            {:else if panel.id === "split"}
              <ul class="bars">
                {#each once.slice(0, 4) as s (s.key)}
                  <li>
                    <span class="dot" style={`background:${s.color}`}></span>
                    <span class="lab">{s.label || "unnamed"}</span>
                    <span class="val">{measureText(measure, s.total)}</span>
                  </li>
                {/each}
              </ul>
            {:else}
              <ul class="nums">
                <li><span class="lab">requests</span><span class="val">{count(model?.kpis.requests ?? 0)}</span></li>
                <li><span class="lab">cards</span><span class="val">{count(model?.kpis.cards ?? 0)}</span></li>
                <li><span class="lab">cache</span><span class="val">{model?.kpis.cacheShare === null || model?.kpis.cacheShare === undefined ? "" : `${Math.round(model.kpis.cacheShare)}%`}</span></li>
              </ul>
            {/if}
          </section>
        {/each}
      </div>
    {:else}
      <svg class="chart" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true">
        {#each once as s (s.key)}
          <path d={seriesPath(s.points, since, until, top, SPARK_W, SPARK_H, 1)} stroke={s.color} />
        {/each}
      </svg>
      {#if legend.length > 1}
        <ul class="legend">
          {#each legend as s (s.key)}
            <li title={s.label}><span class="dot" style={`background:${s.color}`}></span>{s.label || "unnamed"}</li>
          {/each}
        </ul>
      {/if}
    {/if}

    {#if fault}
      <p class="stale" title={fault}>· stale</p>
    {/if}
  {/if}
</div>

<style>
  .af {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 2cqh;
    padding: 3cqh 3cqw 3cqh;
    overflow: hidden;
    /* Paints no background of its own: the wrapper is opaque already, and
       leaving it there is what lets the `frame` knob's `bare` reach the face
       rather than being covered by it. */
    font-family: var(--util);
    color: var(--paper-dim);
  }

  .top {
    flex: none;
    display: flex;
    align-items: baseline;
    gap: 1.5cqw;
    min-width: 0;
  }
  .who {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: min(7cqw, 12cqh, 13px);
    color: var(--paper-mute);
    letter-spacing: 0.01em;
  }
  .share {
    flex: none;
    font-size: min(5.5cqw, 9cqh, 11px);
    color: var(--paper-faint);
    text-transform: lowercase;
  }
  .share.gone {
    color: var(--st-ask);
  }
  .act {
    flex: none;
    border: 1px solid var(--edge);
    border-radius: 5px;
    background: transparent;
    color: var(--paper-dim);
    font: inherit;
    font-size: min(5.5cqw, 9cqh, 11px);
    padding: 1px 5px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .act:hover,
  .act:focus-visible {
    color: var(--paper);
    border-color: var(--paper-faint);
  }
  .open {
    padding: 1px 3px;
  }

  .said {
    margin: 0;
    font-size: min(7cqw, 12cqh, 13px);
    color: var(--paper-mute);
    line-height: 1.35;
  }
  .quiet {
    color: var(--paper-faint);
  }

  /* ── the figure ───────────────────────────────────────────────────────── */

  .fig {
    flex: none;
    display: flex;
    flex-direction: column;
    gap: 2cqh;
    min-height: 0;
  }
  .n {
    font-size: min(22cqw, 34cqh, 40px);
    line-height: 1;
    color: var(--paper);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .d {
    font-size: min(7cqw, 12cqh, 13px);
    color: var(--paper-mute);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .spark {
    flex: 1;
    min-height: 0;
    width: 100%;
  }
  .spark path {
    fill: none;
    stroke: var(--paper-mute);
    stroke-width: 1.4;
    stroke-linejoin: round;
    stroke-linecap: round;
    /* A viewBox unit here is a third of a pixel, and the line is stretched with
       the box; without this the stroke thickens as the widget is dragged wider
       and reads as the reading getting heavier. */
    vector-effect: non-scaling-stroke;
  }

  /* ── the chart ────────────────────────────────────────────────────────── */

  .chart {
    flex: 1;
    width: 100%;
    min-height: 0;
  }
  /* **No `stroke` in this rule.** The series' colours arrive as presentation
     attributes on each path, and any CSS rule at all beats a presentation
     attribute — a `stroke` here would paint every series the same colour and
     silently lose the palette. Only the properties the attribute does not carry
     are set. */
  .chart path {
    fill: none;
    stroke-width: 1.4;
    stroke-linejoin: round;
    stroke-linecap: round;
    vector-effect: non-scaling-stroke;
  }
  .legend {
    flex: none;
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 2px 10px;
    font-size: min(5.5cqw, 9cqh, 11px);
    color: var(--paper-mute);
    overflow: hidden;
    max-height: 2.4em;
  }
  .legend li {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 2px;
    flex: none;
  }

  /* ── the board ────────────────────────────────────────────────────────── */

  .board {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 2cqh;
  }
  .panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 1cqh;
  }
  .panel h4 {
    margin: 0;
    flex: none;
    font-size: min(5.5cqw, 9cqh, 11px);
    font-weight: 500;
    color: var(--paper-faint);
    text-transform: lowercase;
    letter-spacing: 0.02em;
  }
  .bars,
  .nums {
    flex: 1;
    min-height: 0;
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: min(5.5cqw, 9cqh, 11px);
    overflow: hidden;
  }
  .bars li,
  .nums li {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--paper-mute);
  }
  .lab {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .val {
    flex: none;
    color: var(--paper);
    font-variant-numeric: tabular-nums;
  }

  .stale {
    margin: 0;
    flex: none;
    font-size: min(5cqw, 8cqh, 10px);
    color: var(--st-ask);
  }
</style>
