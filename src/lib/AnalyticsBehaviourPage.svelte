<script lang="ts">
  /* The behaviour tab as a document: the second presentation of the same
   * reading (§11.15).
   *
   * The room is for the glance and this is for the month, so it asks the same
   * questions in prose with small multiples rather than drawing one dense
   * dashboard. Every number here is handed in already folded: `bundle` is what
   * the shell read and `habits` is what it counted, so the two skins cannot
   * disagree.
   *
   * A lede generated from the numbers by a template (`habitSaid`), never by a
   * model, the way the work page's is. The provenance paragraph is in full
   * rather than as a footnote, because a document is where a reader has the
   * time for it.
   */
  import AnalyticsBehaviourTable from "./AnalyticsBehaviourTable.svelte";
  import { niceAxis } from "./analyticsroom";
  import { seriesColor } from "./analytics";
  import {
    ATTRIBUTION_GAP,
    bytesSaid,
    habitSaid,
    latencySaid,
    msSaid,
    rateSaid,
    shareSaid,
    serverPoints,
    toolKpis,
    toolLines,
  } from "./analyticsbehaviour";
  import type { BehaviourBundle } from "./analyticsbehaviourread.svelte";
  import type { HabitModel } from "./analyticsbehaviour";
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

  let scroller = $state<HTMLElement>();
  let figW = $state(640);

  function sized(el: HTMLElement) {
    figW = el.clientWidth;
    const ro = new ResizeObserver(() => (figW = el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }

  const kpis = $derived(toolKpis(bundle.tools));
  const toolList = $derived(toolLines(bundle.tools, "tools"));
  const serverList = $derived(toolLines(bundle.tools, "servers"));
  const skillList = $derived(toolLines(bundle.tools, "skills"));
  const agentList = $derived(toolLines(bundle.tools, "agents"));

  const lede = $derived(
    `In ${spanSaid} the wall made ${count(kpis.calls)} tool ${kpis.calls === 1 ? "call" : "calls"} across ` +
      `${count(kpis.tools)} ${kpis.tools === 1 ? "tool" : "tools"} and ${count(kpis.servers)} mcp ` +
      `${kpis.servers === 1 ? "server" : "servers"}. ${habitSaid(habits)}.`,
  );

  const figures = $derived([
    { label: "calls", value: count(kpis.calls), note: "every tool, built-in and mcp" },
    {
      label: "failed",
      value: rateSaid(kpis.errorRate),
      note: kpis.errors > 0 ? `${count(kpis.errors)} calls returned an error` : "nothing failed",
    },
    { label: "p50", value: latencySaid(kpis.p50), note: "half of the completed calls were faster" },
    { label: "p95", value: latencySaid(kpis.p95), note: "the tail a card waits on" },
    { label: "results", value: bytesSaid(kpis.bytes), note: "returned to the agents" },
    { label: "apportioned cost", value: money(kpis.cost), note: "from the turns that made the calls" },
  ]);

  /* ── the scatter, drawn larger than the room's ─────────────────────────── */

  const PAD = { l: 50, t: 12, b: 40, r: 16 };
  const PLOT_H = 230;

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
    const xAxis = niceAxis(maxMs, 4);
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
        r: 6 + Math.sqrt(p.calls / maxCalls) * 14,
        fill: seriesColor(p.slot),
        named: p.slot >= 0,
      })),
      xTicks: xAxis.ticks.map((v) => ({ v, x: xOf(v), text: msSaid(v) })),
      yTicks: [0, top / 2, top].map((v) => ({ v, y: yOf(v), text: rateSaid(v) })),
    };
  });

  /* ── what the habits add up to, as sentences ──────────────────────────── */

  const sliceSaid = (slices: HabitModel["byProject"], empty: string) =>
    slices.length === 0
      ? empty
      : slices
          .slice(0, 4)
          .map((s) => `${s.label || "unknown"} ${count(s.value)} (${shareSaid(s.share)})`)
          .join(", ");

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

<div class="bhp-scroll" bind:this={scroller}>
  <article class="bhp-doc">
    <p class="bhp-lede">{lede}</p>

    <div class="bhp-figures">
      {#each figures as figure (figure.label)}
        <div class="bhp-figure">
          <span class="bhp-flabel">{figure.label}</span>
          <span class="bhp-fvalue">{figure.value}</span>
          <span class="bhp-fnote">{figure.note}</span>
        </div>
      {/each}
    </div>

    <section class="bhp-section">
      <h2>the tools</h2>
      <p>
        Built-ins and mcp tools in one table. A built-in carries no server, and the column says nothing
        rather than naming the project it was called from.
      </p>
      <AnalyticsBehaviourTable lines={toolList} view="tools" compact />
      {#if toolList.length > 0}
        <p class="bhp-small">
          The biggest is {toolList[0].name} at {count(toolList[0].calls)}
          {toolList[0].calls === 1 ? "call" : "calls"}.
          {#if toolList[0].cost > 0}
            Its share of the turn cost is {money(toolList[0].cost)}, apportioned by call count.
          {/if}
        </p>
      {:else}
        <p class="bhp-nothing">No tool was called in this window.</p>
      {/if}
    </section>

    <section class="bhp-section">
      <h2>the mcp servers</h2>
      <p>
        A server whose error rate is high and whose p95 is long is a tax on every card that reaches for it.
        This is the one drawing that makes that trade-off visible at a glance.
      </p>
      {#if scatter.dots.length === 0}
        <p class="bhp-nothing">
          {scatter.unplaced > 0
            ? "No server has a completed call in this window."
            : "No mcp server was called in this window."}
        </p>
      {:else}
        <div class="bhp-plate" {@attach sized}>
          <svg
            width={figW}
            height={PAD.t + PLOT_H + PAD.b}
            viewBox={`0 0 ${figW} ${PAD.t + PLOT_H + PAD.b}`}
            role="img"
            aria-label="mcp server latency against error rate"
          >
            {#each scatter.yTicks as tick (tick.v)}
              <line x1={PAD.l} x2={PAD.l + scatter.plotW} y1={tick.y} y2={tick.y} class="bhp-grid" />
              <text x={PAD.l - 8} y={tick.y + 3} class="bhp-tick" text-anchor="end">{tick.text}</text>
            {/each}
            {#each scatter.xTicks as tick (tick.v)}
              <text x={tick.x} y={PAD.t + PLOT_H + 17} class="bhp-tick" text-anchor="middle">{tick.text}</text>
            {/each}
            <text x={PAD.l + scatter.plotW / 2} y={PAD.t + PLOT_H + 38} class="bhp-axis" text-anchor="middle">
              p95 latency
            </text>
            {#each scatter.dots as dot (dot.server)}
              <circle cx={dot.x} cy={dot.y} r={dot.r} fill={dot.fill} class="bhp-dot">
                <title>
                  {dot.server} · {count(dot.calls)} {dot.calls === 1 ? "call" : "calls"} · p95 {msSaid(dot.p95 ?? 0)} ·
                  {rateSaid(dot.errorRate)} failed
                </title>
              </circle>
              {#if dot.named}
                <text x={dot.x} y={dot.y - dot.r - 8} class="bhp-label" text-anchor="middle">{dot.server}</text>
              {/if}
            {/each}
          </svg>
        </div>
        <p class="bhp-small">
          Bubble size is calls, and the vertical axis is the share of calls that failed. The three loudest
          servers are named and the rest fold to one tone; each dot's hover names its own numbers.
          {#if scatter.unplaced > 0}
            {scatter.unplaced} {scatter.unplaced === 1 ? "server has" : "servers have"} no completed call and
            {scatter.unplaced === 1 ? "is" : "are"} in the table only.
          {/if}
        </p>
      {/if}
      {#if serverList.length > 0}
        <AnalyticsBehaviourTable lines={serverList} view="servers" compact />
      {/if}
    </section>

    <section class="bhp-section">
      <h2>skills and agents</h2>
      <p>
        What was invoked, by name. The two are different questions from what a turn cost, and they are kept
        apart from the spending tables for the same reason.
      </p>
      <div class="bhp-pair">
        <div>
          <h3>skills</h3>
          {#if skillList.length > 0}
            <AnalyticsBehaviourTable lines={skillList} view="skills" compact />
          {:else}
            <p class="bhp-nothing">No skill was invoked in this window.</p>
          {/if}
        </div>
        <div>
          <h3>agents</h3>
          {#if agentList.length > 0}
            <AnalyticsBehaviourTable lines={agentList} view="agents" compact />
          {:else}
            <p class="bhp-nothing">No subagent was started in this window.</p>
          {/if}
        </div>
      </div>
      <p class="bhp-small">
        {ATTRIBUTION_GAP}, so this is the invoked half only. Adding it to what the kit attributed would
        answer neither question.
      </p>
    </section>

    <section class="bhp-section">
      <h2>how the wall is worked</h2>
      <p>{habitSaid(habits)}.</p>
      <dl class="bhp-list">
        <dt>opened by</dt>
        <dd>{sliceSaid(habits.byOpener, "nothing was opened")}</dd>
        <dt>project</dt>
        <dd>{sliceSaid(habits.byProject, "nothing was opened")}</dd>
        <dt>funded by</dt>
        <dd>{sliceSaid(habits.byProvider, "nothing was opened")}</dd>
        <dt>at once</dt>
        <dd>
          {habits.peakConcurrent} at most, {habits.meanConcurrent === null ? "no average to take" : `${habits.meanConcurrent.toFixed(1)} on average`}
        </dd>
        <dt>fan-out</dt>
        <dd>
          {habits.agentCalls} agent {habits.agentCalls === 1 ? "call" : "calls"}
          {habits.fanOut === null ? "" : `, ${habits.fanOut.toFixed(1)} a card`}
        </dd>
        <dt>moves</dt>
        <dd>
          {bundle.changesUnread
            ? "the recorded moves could not be read, so the count is missing rather than zero"
            : `${count(habits.swaps)} between fundings, across ${count(habits.swapCards)} ${habits.swapCards === 1 ? "card" : "cards"}`}
        </dd>
      </dl>
      {#if habits.days.length > 0}
        <p class="bhp-small">
          The quietest day in this window opened
          {count(habits.days.reduce((min, d) => (d.total < min ? d.total : min), habits.days[0].total))}
          {habits.days.reduce((min, d) => (d.total < min ? d.total : min), habits.days[0].total) === 1
            ? "card"
            : "cards"};
          the busiest, {count(habits.days.reduce((max, d) => (d.total > max ? d.total : max), 0))}, on
          {dayLabel(
            habits.days.reduce((best, d) => (d.total > best.total ? d : best), habits.days[0]).day,
            to,
          )}.
        </p>
      {/if}
    </section>

    <section class="bhp-section">
      <h2>what these figures are</h2>
      <p>
        Calls, failures and result sizes are measured from the hourly rollup, which is kept while the
        per-call facts are pruned at ninety days. That is also why a percentile is an estimate: the rollup
        keeps five latency bands rather than a sample per call, so p95 is interpolated inside whichever band
        it lands in and a tail past five seconds is said as "at least", never given an invented ceiling.
      </p>
      <p>
        The cost column is the turn's cost apportioned across its calls, by the same divisor the fold used,
        so a sum over this window is what those turns spent. It is not a per-call meter, and a call no turn
        claimed carries no cost at all rather than a zero that would read as free.
      </p>
      <p>
        The habits count sessions the wall itself opened, so a renewal is another session and counts again.
        A session was opened by a person or by an agent, and one with no lineage record is counted as
        unknown rather than folded into either.
      </p>
    </section>
  </article>
</div>

<style>
  .bhp-scroll {
    position: absolute;
    inset: 0;
    overflow: auto;
    scrollbar-width: thin;
  }
  .bhp-doc {
    padding: 20px 26px 44px;
    max-width: 112ch;
    display: flex;
    flex-direction: column;
    gap: 22px;
    color: var(--paper-dim);
  }
  .bhp-lede {
    margin: 0;
    max-width: 78ch;
    font-family: var(--body);
    font-size: 14.5px;
    line-height: 1.6;
    color: var(--paper);
  }
  .bhp-figures {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 14px;
    border-top: 1px solid color-mix(in oklab, var(--edge) 45%, transparent);
    border-bottom: 1px solid color-mix(in oklab, var(--edge) 45%, transparent);
    padding: 12px 0;
  }
  .bhp-figure {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .bhp-flabel {
    font-family: var(--cv-ui, var(--util));
    font-size: 9.5px;
    letter-spacing: 0.05em;
    text-transform: lowercase;
    color: var(--paper-faint);
  }
  .bhp-fvalue {
    font-family: var(--cv-ui, var(--util));
    font-size: 20px;
    color: var(--paper);
    font-variant-numeric: tabular-nums;
  }
  .bhp-fnote {
    font-family: var(--body);
    font-size: 10.5px;
    line-height: 1.4;
    color: var(--paper-faint);
  }

  .bhp-section {
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .bhp-section h2 {
    margin: 0;
    font-family: var(--cv-ui, var(--util));
    font-size: 10.5px;
    font-weight: 400;
    letter-spacing: 0.06em;
    text-transform: lowercase;
    color: var(--paper-faint);
  }
  .bhp-section h3 {
    margin: 0 0 5px;
    font-family: var(--cv-ui, var(--util));
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0.05em;
    text-transform: lowercase;
    color: var(--paper-faint);
  }
  .bhp-section p {
    margin: 0;
    max-width: 84ch;
    font-family: var(--body);
    font-size: 13px;
    line-height: 1.6;
    color: var(--paper-dim);
  }
  .bhp-section p.bhp-small {
    font-size: 11.5px;
    line-height: 1.55;
    color: var(--paper-faint);
    max-width: 88ch;
  }
  .bhp-nothing {
    font-family: var(--body);
    font-style: italic;
    font-size: 11.5px;
    color: var(--paper-faint);
  }
  /* Stacked rather than beside each other: two half-width tables scroll
     sideways to show the columns this page exists to compare, and a document
     that scrolls inside itself is a document that hides its own figures. */
  .bhp-pair {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .bhp-plate {
    border: 1px solid var(--cv-hair, var(--edge));
    border-radius: 10px;
    background: color-mix(in oklab, var(--raised) 60%, transparent);
    overflow: hidden;
  }
  .bhp-grid {
    stroke: color-mix(in oklab, var(--edge) 55%, transparent);
    stroke-width: 1;
  }
  .bhp-tick {
    fill: var(--paper-faint);
    font-family: var(--cv-ui, var(--util));
    font-size: 9px;
  }
  .bhp-axis {
    fill: var(--paper-faint);
    font-family: var(--cv-ui, var(--util));
    font-size: 9px;
    letter-spacing: 0.04em;
  }
  .bhp-dot {
    opacity: 0.85;
    transition: opacity 140ms ease;
  }
  .bhp-dot:hover {
    opacity: 1;
  }
  .bhp-label {
    fill: var(--paper-mute);
    font-family: var(--cv-ui, var(--util));
    font-size: 10px;
  }
  .bhp-list {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 4px 18px;
    margin: 0;
    font-family: var(--body);
    font-size: 12.5px;
    line-height: 1.55;
  }
  .bhp-list dt {
    color: var(--paper-faint);
    font-family: var(--cv-ui, var(--util));
    font-size: 10.5px;
    padding-top: 2px;
  }
  .bhp-list dd {
    margin: 0;
    color: var(--paper-dim);
  }

  @media (max-width: 1080px) {
    .bhp-figures {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .bhp-pair {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
