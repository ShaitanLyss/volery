<script lang="ts">
  /* The behaviour tab as an instrument (§9.7, §11.9).
   *
   * What the wall spends its time on rather than its money: the tools and MCP
   * servers it calls, the skills and agents it invokes, and the shape of the
   * habits around them. It draws the window the shell read and decides nothing
   * about which window that is.
   *
   * Three rules the drawing keeps:
   *
   *  - **A built-in's server column is empty, never guessed.** The name carries
   *    no server, so the row says nothing rather than the territory's name.
   *  - **A percentile is an estimate and says so.** The rollup keeps five
   *    latency bands rather than a sample per call, so the figure is computed
   *    from bands and the row's title names the basis.
   *  - **A dash is not a zero.** Nothing completed, nothing failed, nothing
   *    attributed: each is said as a dash with its reason, which is what stops
   *    a fast tool reading as free and a quiet one as broken.
   *
   * Off the keyboard: `x` cycles the table's grouping, and the heads are real
   * buttons so sorting is reachable without a pointer. The shell hands the
   * arrows here while this tab is in front.
   */
  import AnalyticsBehaviourTable from "./AnalyticsBehaviourTable.svelte";
  import { niceAxis } from "./analyticsroom";
  import { seriesColor } from "./analytics";
  import {
    ATTRIBUTION_GAP,
    TOOL_VIEWS,
    bytesSaid,
    habitSaid,
    latencySaid,
    msSaid,
    rateSaid,
    shareSaid,
    toolKpis,
    toolLines,
    serverPoints,
    type HabitModel,
    type ToolView,
  } from "./analyticsbehaviour";
  import type { BehaviourBundle } from "./analyticsbehaviourread.svelte";
  import { dayLabel } from "./analyticstrace";
  import { count, money } from "./usage";

  let {
    bundle,
    to,
    spanSaid,
    habits,
  }: {
    bundle: BehaviourBundle;
    to: number;
    spanSaid: string;
    habits: HabitModel;
  } = $props();

  let view = $state<ToolView>("tools");
  let scroller = $state<HTMLElement>();
  let figW = $state(360);

  function sized(el: HTMLElement) {
    figW = el.clientWidth;
    const ro = new ResizeObserver(() => (figW = el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }

  const lines = $derived(toolLines(bundle.tools, view));
  const kpis = $derived(toolKpis(bundle.tools));

  /* The count beside each view's name, so a tab is not a guess about whether
     anything is in it. Four passes over a few thousand rows is cheaper than a
     second read and cannot disagree with the table it labels. */
  const counts = $derived.by<Record<ToolView, number>>(() => ({
    tools: toolLines(bundle.tools, "tools").length,
    servers: toolLines(bundle.tools, "servers").length,
    skills: toolLines(bundle.tools, "skills").length,
    agents: toolLines(bundle.tools, "agents").length,
  }));

  const tiles = $derived([
    {
      label: "calls",
      value: count(kpis.calls),
      note: `${count(kpis.tools)} ${kpis.tools === 1 ? "tool" : "tools"} · ${spanSaid}`,
    },
    {
      label: "failed",
      value: kpis.errors > 0 ? count(kpis.errors) : "—",
      note: `error rate ${rateSaid(kpis.errorRate)}`,
    },
    {
      label: "p50",
      value: latencySaid(kpis.p50),
      note: !kpis.p50 ? "no call completed" : kpis.p50.basis === "buckets" ? "estimated from bands" : "over completed calls",
    },
    {
      label: "p95",
      value: latencySaid(kpis.p95),
      note: !kpis.p95 ? "no call completed" : kpis.p95.basis === "buckets" ? "estimated from bands" : "over completed calls",
    },
    {
      label: "results",
      value: bytesSaid(kpis.bytes),
      note: "returned to the agent",
    },
    {
      label: "apportioned",
      value: money(kpis.cost),
      note: "from the turns these calls paid for",
    },
  ]);

  /* ── the scatter: latency against failures, one dot per server ────────── */

  const PAD = { l: 46, t: 10, b: 26, r: 12 };
  const PLOT_H = 148;

  const scatter = $derived.by(() => {
    const { points, unplaced } = serverPoints(bundle.tools);
    const plotW = Math.max(20, figW - PAD.l - PAD.r);
    let maxMs = 1;
    let maxRate = 0;
    let maxCalls = 1;
    for (const p of points) {
      if (p.p95 !== null && p.p95 > maxMs) maxMs = p.p95;
      const rate = p.errorRate ?? 0;
      if (rate > maxRate) maxRate = rate;
      if (p.calls > maxCalls) maxCalls = p.calls;
    }
    const xAxis = niceAxis(maxMs, 3);
    /* A y axis always reaches at least a few percent, so one failing server on
       a quiet week is not drawn flat against the top of its own scale. */
    const top = Math.min(1, Math.max(0.05, maxRate * 1.15));
    const xOf = (v: number) => PAD.l + (v / Math.max(1, xAxis.top)) * plotW;
    const yOf = (v: number) => PAD.t + PLOT_H - (v / top) * PLOT_H;
    return {
      plotW,
      plotH: PLOT_H,
      unplaced,
      dots: points.map((p) => ({
        ...p,
        x: xOf(p.p95 ?? 0),
        y: yOf(p.errorRate ?? 0),
        r: 5 + Math.sqrt(p.calls / maxCalls) * 10,
        fill: seriesColor(p.slot),
        /* The three loudest are named on the plot; everything else folds to one
           tone and is read off its hover, which is the doc's cap on categorical
           colour rather than a ninth invented hue. */
        named: p.slot >= 0,
      })),
      xTicks: xAxis.ticks.map((v) => ({ v, x: xOf(v), text: msSaid(v) })),
      yTicks: [0, top / 2, top].map((v) => ({ v, y: yOf(v), text: rateSaid(v) })),
    };
  });

  /* ── the habits ────────────────────────────────────────────────────────── */

  const dayMax = $derived.by(() => {
    let max = 0;
    for (const day of habits.days) if (day.total > max) max = day.total;
    return max;
  });

  const dayHeight = (n: number) => (dayMax > 0 ? Math.round((n / dayMax) * 46) : 0);

  function sliceRows(slices: HabitModel["byProject"]) {
    return slices.slice(0, 4);
  }

  /* ── the shell's keyboard, and the document's ─────────────────────────── */

  export function key(e: KeyboardEvent): boolean {
    if (e.key === "x") {
      e.preventDefault();
      const at = TOOL_VIEWS.findIndex((v) => v.key === view);
      view = TOOL_VIEWS[(at + 1) % TOOL_VIEWS.length].key;
      return true;
    }
    return false;
  }

  export function scrollBy(dy: number): void {
    scroller?.scrollBy({ top: dy, behavior: "smooth" });
  }

  export function turnPage(dir: number): void {
    if (!scroller) return;
    scroller.scrollBy({ top: dir * Math.max(80, scroller.clientHeight * 0.85), behavior: "smooth" });
  }

  export function goTo(where: "top" | "bottom"): void {
    if (!scroller) return;
    scroller.scrollTo({ top: where === "top" ? 0 : scroller.scrollHeight, behavior: "smooth" });
  }
</script>

<div class="bh-scroll" bind:this={scroller}>
  <div class="bh-body">
    <div class="bh-kpis">
      {#each tiles as tile (tile.label)}
        <div class="bh-kpi">
          <span class="bh-klabel">{tile.label}</span>
          <span class="bh-kvalue">{tile.value}</span>
          <span class="bh-knote">{tile.note}</span>
        </div>
      {/each}
    </div>

    <div class="bh-views" role="tablist" aria-label="what to group by">
      {#each TOOL_VIEWS as one (one.key)}
        <button
          type="button"
          role="tab"
          aria-selected={view === one.key}
          class:on={view === one.key}
          title={one.said}
          onclick={() => (view = one.key)}
        >
          {one.label}
          <span class="bh-count">{count(counts[one.key])}</span>
        </button>
      {/each}
      <span class="bh-grow"></span>
      <span class="bh-hint">x cycles · a head sorts</span>
    </div>

    <div class="bh-cols">
      <div class="bh-main">
        <AnalyticsBehaviourTable {lines} {view} />
        {#if view === "skills"}
          <p class="bh-gap">
            {ATTRIBUTION_GAP}, so this is what was invoked and never what the kit attributed. The two answer
            different questions and adding them would answer neither.
          </p>
        {:else if view === "agents"}
          <p class="bh-gap">
            {ATTRIBUTION_GAP}. A background agent's result returns before its work does, which is why the
            receipt count is beside the calls.
          </p>
        {/if}
      </div>

      <aside class="bh-side">
        <figure class="bh-fig">
          <figcaption>servers · latency against failures</figcaption>
          <div class="bh-plate" {@attach sized}>
            {#if scatter.dots.length === 0}
              <p class="bh-nothing">
                {scatter.unplaced > 0
                  ? "no server has a completed call in this window"
                  : "no mcp server was called in this window"}
              </p>
            {:else}
              <svg
                width={figW}
                height={PAD.t + PLOT_H + PAD.b}
                viewBox={`0 0 ${figW} ${PAD.t + PLOT_H + PAD.b}`}
                role="img"
                aria-label="mcp server latency against error rate"
              >
                {#each scatter.yTicks as tick (tick.v)}
                  <line
                    x1={PAD.l}
                    x2={PAD.l + scatter.plotW}
                    y1={tick.y}
                    y2={tick.y}
                    class="bh-grid"
                  />
                  <text x={PAD.l - 7} y={tick.y + 3} class="bh-tick" text-anchor="end">{tick.text}</text>
                {/each}
                {#each scatter.xTicks as tick (tick.v)}
                  <text x={tick.x} y={PAD.t + PLOT_H + 16} class="bh-tick" text-anchor="middle">{tick.text}</text>
                {/each}
                {#each scatter.dots as dot (dot.server)}
                  <circle cx={dot.x} cy={dot.y} r={dot.r} fill={dot.fill} class="bh-dot">
                    <title>
                      {dot.server} · {count(dot.calls)} {dot.calls === 1 ? "call" : "calls"} · p95 {msSaid(dot.p95 ?? 0)} · {rateSaid(dot.errorRate)} failed
                    </title>
                  </circle>
                  {#if dot.named}
                    <text x={dot.x} y={dot.y - dot.r - 7} class="bh-label" text-anchor="middle">{dot.server}</text>
                  {/if}
                {/each}
              </svg>
            {/if}
          </div>
          <p class="bh-note">
            bubble size is calls; the three loudest servers are named and the rest fold to one tone.
            {#if scatter.unplaced > 0}
              {scatter.unplaced} {scatter.unplaced === 1 ? "server has" : "servers have"} no completed call and
              {scatter.unplaced === 1 ? "is" : "are"} in the table only.
            {/if}
          </p>
        </figure>

        <section class="bh-habits">
          <h3>how the wall is worked</h3>
          <p class="bh-said">{habitSaid(habits)}</p>

          <div class="bh-days" role="img" aria-label="cards opened a day, by who opened them">
            {#each habits.days as day, i (day.day)}
              <div
                class="bh-day"
                title={`${dayLabel(day.day, to)} · ${day.total} ${day.total === 1 ? "card" : "cards"} opened · ${day.person} by a person, ${day.agent} by an agent, ${day.unknown} unknown`}
              >
                <!-- Bottom-up: the person's share sits on the baseline and the
                     agent's and nobody's stack above it, which is the order the
                     legend reads. -->
                <div class="bh-stack">
                  {#if day.person > 0}
                    <i class="bh-seg" style:height={`${dayHeight(day.person)}px`} style:background={seriesColor(0)}></i>
                  {/if}
                  {#if day.agent > 0}
                    <i class="bh-seg" style:height={`${dayHeight(day.agent)}px`} style:background={seriesColor(1)}></i>
                  {/if}
                  {#if day.unknown > 0}
                    <i class="bh-seg" style:height={`${dayHeight(day.unknown)}px`} style:background={seriesColor(2)}></i>
                  {/if}
                </div>
                {#if i === 0 || i === habits.days.length - 1 || i % 7 === 0}
                  <span class="bh-dlabel">{dayLabel(day.day, to).replace(/^\w/, (c) => c.toUpperCase())}</span>
                {:else}
                  <span class="bh-dlabel" aria-hidden="true"></span>
                {/if}
              </div>
            {/each}
          </div>
          {#if dayMax === 0}
            <p class="bh-nothing">no card was opened in this window</p>
          {:else}
            <p class="bh-legend">
              <span><i style:background={seriesColor(0)}></i>a person</span>
              <span><i style:background={seriesColor(1)}></i>an agent</span>
              <span><i style:background={seriesColor(2)}></i>unknown</span>
            </p>
          {/if}

          <div class="bh-slices">
            <div class="bh-slice-block">
              <h4>opened by</h4>
              {#each habits.byOpener as slice (slice.label)}
                <p class="bh-slice">
                  <span class="bh-slabel">{slice.label}</span>
                  <span class="bh-sbar"><i style:width={`${Math.floor((slice.share ?? 0) * 100)}%`}></i></span>
                  <span class="bh-svalue">{count(slice.value)} · {shareSaid(slice.share)}</span>
                </p>
              {:else}
                <p class="bh-nothing">nothing opened</p>
              {/each}
            </div>
            <div class="bh-slice-block">
              <h4>project</h4>
              {#each sliceRows(habits.byProject) as slice (slice.label)}
                <p class="bh-slice">
                  <span class="bh-slabel" title={slice.label}>{slice.label || "unknown"}</span>
                  <span class="bh-sbar"><i style:width={`${Math.floor((slice.share ?? 0) * 100)}%`}></i></span>
                  <span class="bh-svalue">{count(slice.value)} · {shareSaid(slice.share)}</span>
                </p>
              {:else}
                <p class="bh-nothing">nothing opened</p>
              {/each}
            </div>
            <div class="bh-slice-block">
              <h4>funded by</h4>
              {#each sliceRows(habits.byProvider) as slice (slice.label)}
                <p class="bh-slice">
                  <span class="bh-slabel">{slice.label}</span>
                  <span class="bh-sbar"><i style:width={`${Math.floor((slice.share ?? 0) * 100)}%`}></i></span>
                  <span class="bh-svalue">{count(slice.value)} · {shareSaid(slice.share)}</span>
                </p>
              {:else}
                <p class="bh-nothing">nothing opened</p>
              {/each}
            </div>
          </div>

          <div class="bh-figures">
            <p><span>at once, at most</span><b>{habits.peakConcurrent}</b></p>
            <p>
              <span>at once, on average</span><b>{habits.meanConcurrent === null ? "—" : habits.meanConcurrent.toFixed(1)}</b>
            </p>
            <p>
              <span>agent calls a card</span><b>{habits.fanOut === null ? "—" : habits.fanOut.toFixed(1)}</b>
            </p>
            <p>
              <span>moves between fundings</span><b>{bundle.changesUnread ? "—" : count(habits.swaps)}</b>
            </p>
          </div>
          {#if bundle.changesUnread}
            <p class="bh-nothing">the recorded moves could not be read, so the count is missing rather than zero</p>
          {/if}
        </section>
      </aside>
    </div>

    <p class="bh-provenance">
      Calls, failures and result sizes are measured. A percentile is estimated from five latency bands in
      the hourly rollup, which is what lets a window past ninety days answer at all. The cost column is the
      turn's cost apportioned across its calls, so a sum over the window is what those turns spent and not a
      second meter. Cards opened a day counts sessions the wall itself opened, so a renewal counts again.
    </p>
  </div>
</div>

<style>
  .bh-scroll {
    position: absolute;
    inset: 0;
    overflow: auto;
    scrollbar-width: thin;
  }
  .bh-body {
    padding: 14px 16px 30px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    color: var(--paper-dim);
  }

  /* ── the strip ─────────────────────────────────────────────────────────── */

  .bh-kpis {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 1px;
    border: 1px solid var(--cv-hair, var(--edge));
    border-radius: 10px;
    overflow: hidden;
    background: var(--cv-hair, var(--edge));
  }
  .bh-kpi {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 9px 11px;
    background: color-mix(in oklab, var(--raised) 82%, var(--paper) 3%);
    min-width: 0;
  }
  .bh-klabel {
    font-family: var(--cv-ui, var(--util));
    font-size: 9.5px;
    letter-spacing: 0.05em;
    text-transform: lowercase;
    color: var(--paper-faint);
  }
  .bh-kvalue {
    font-family: var(--cv-ui, var(--util));
    font-size: 16px;
    color: var(--paper);
    font-variant-numeric: tabular-nums;
  }
  .bh-knote {
    font-family: var(--body);
    font-size: 10.5px;
    color: var(--paper-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ── which grouping ────────────────────────────────────────────────────── */

  .bh-views {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .bh-views button {
    display: inline-flex;
    align-items: baseline;
    gap: 5px;
    padding: 4px 9px;
    border: 1px solid transparent;
    border-radius: 7px;
    background: none;
    color: var(--paper-faint);
    font-family: var(--cv-ui, var(--util));
    font-size: 11px;
    cursor: pointer;
    transition:
      color 140ms ease,
      background-color 140ms ease;
  }
  .bh-views button:hover {
    color: var(--paper);
    background: color-mix(in oklab, var(--raised) 70%, transparent);
  }
  .bh-views button.on {
    color: var(--paper);
    border-color: var(--cv-hair, var(--edge));
    background: color-mix(in oklab, var(--raised) 86%, var(--paper) 2%);
  }
  .bh-count {
    font-size: 9.5px;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }
  .bh-grow {
    flex: 1;
  }
  .bh-hint {
    font-family: var(--body);
    font-size: 10.5px;
    color: var(--paper-faint);
  }

  /* ── the two columns ───────────────────────────────────────────────────── */

  .bh-cols {
    display: grid;
    grid-template-columns: minmax(0, 1.55fr) minmax(280px, 1fr);
    gap: 16px;
    align-items: start;
  }
  .bh-main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .bh-side {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  }
  .bh-gap {
    margin: 0;
    max-width: 74ch;
    font-family: var(--body);
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--paper-faint);
  }

  /* ── the scatter ───────────────────────────────────────────────────────── */

  .bh-fig {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .bh-fig figcaption {
    font-family: var(--cv-ui, var(--util));
    font-size: 10px;
    letter-spacing: 0.05em;
    text-transform: lowercase;
    color: var(--paper-faint);
  }
  .bh-plate {
    min-height: 184px;
    border: 1px solid var(--cv-hair, var(--edge));
    border-radius: 10px;
    background: color-mix(in oklab, var(--raised) 60%, transparent);
    overflow: hidden;
  }
  .bh-grid {
    stroke: color-mix(in oklab, var(--edge) 55%, transparent);
    stroke-width: 1;
  }
  .bh-tick {
    fill: var(--paper-faint);
    font-family: var(--cv-ui, var(--util));
    font-size: 9px;
  }
  .bh-dot {
    opacity: 0.85;
    transition: opacity 140ms ease;
  }
  .bh-dot:hover {
    opacity: 1;
  }
  .bh-label {
    fill: var(--paper-mute);
    font-family: var(--cv-ui, var(--util));
    font-size: 9.5px;
  }
  .bh-note {
    margin: 0;
    font-family: var(--body);
    font-size: 10.5px;
    line-height: 1.45;
    color: var(--paper-faint);
  }
  .bh-nothing {
    margin: 0;
    padding: 14px 12px;
    font-family: var(--body);
    font-style: italic;
    font-size: 11px;
    color: var(--paper-faint);
  }

  /* ── the habits ────────────────────────────────────────────────────────── */

  .bh-habits {
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding: 12px 13px;
    border: 1px solid var(--cv-hair, var(--edge));
    border-radius: 10px;
    background: color-mix(in oklab, var(--raised) 60%, transparent);
  }
  .bh-habits h3 {
    margin: 0;
    font-family: var(--cv-ui, var(--util));
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0.05em;
    text-transform: lowercase;
    color: var(--paper-faint);
  }
  .bh-said {
    margin: 0;
    font-family: var(--body);
    font-size: 12px;
    line-height: 1.5;
    color: var(--paper-dim);
  }

  .bh-days {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 60px;
    padding-top: 2px;
  }
  .bh-day {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    gap: 3px;
    height: 100%;
  }
  /* Thin marks rather than a wall of colour: a bar of a whole column at full
     saturation reads as a heatmap of nothing, and the wall's charts are drawn
     with air in them (§10). */
  .bh-stack {
    display: flex;
    flex-direction: column-reverse;
    justify-content: flex-start;
    gap: 2px;
    width: 100%;
    max-width: 22px;
    margin: 0 auto;
  }
  .bh-seg {
    display: block;
    width: 100%;
    border-radius: 2px;
    opacity: 0.85;
  }
  .bh-dlabel {
    font-family: var(--cv-ui, var(--util));
    font-size: 8px;
    color: var(--paper-faint);
    white-space: nowrap;
    overflow: hidden;
    text-align: center;
  }
  .bh-day:first-child .bh-dlabel {
    text-align: left;
  }
  .bh-day:last-child .bh-dlabel {
    text-align: right;
  }
  .bh-legend {
    display: flex;
    gap: 12px;
    margin: 0;
    font-family: var(--body);
    font-size: 10px;
    color: var(--paper-faint);
  }
  .bh-legend span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .bh-legend i {
    width: 7px;
    height: 7px;
    border-radius: 2px;
  }

  .bh-slices {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .bh-slice-block h4 {
    margin: 0 0 3px;
    font-family: var(--cv-ui, var(--util));
    font-size: 9.5px;
    font-weight: 400;
    letter-spacing: 0.04em;
    text-transform: lowercase;
    color: var(--paper-faint);
  }
  .bh-slice {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr) auto;
    align-items: center;
    gap: 7px;
    margin: 0 0 2px;
    font-family: var(--cv-ui, var(--util));
    font-size: 10.5px;
  }
  .bh-slabel {
    color: var(--paper-mute);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bh-sbar {
    height: 4px;
    border-radius: 2px;
    background: color-mix(in oklab, var(--edge) 50%, transparent);
    overflow: hidden;
  }
  .bh-sbar i {
    display: block;
    height: 100%;
    background: var(--paper-faint);
    border-radius: 2px;
  }
  .bh-svalue {
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .bh-figures {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px 12px;
    border-top: 1px solid color-mix(in oklab, var(--edge) 45%, transparent);
    padding-top: 8px;
  }
  .bh-figures p {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin: 0;
    font-family: var(--cv-ui, var(--util));
    font-size: 10.5px;
  }
  .bh-figures span {
    color: var(--paper-faint);
  }
  .bh-figures b {
    font-weight: 400;
    color: var(--paper);
    font-variant-numeric: tabular-nums;
  }

  .bh-provenance {
    margin: 2px 0 0;
    max-width: 96ch;
    font-family: var(--body);
    font-size: 10.5px;
    line-height: 1.55;
    color: var(--paper-faint);
  }

  @media (max-width: 1080px) {
    .bh-kpis {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .bh-cols {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
