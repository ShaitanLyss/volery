<script lang="ts">
  /* The work tab, as an instrument: cost against output (§11.14).
   *
   * The reading is a pair, never one axis. Cost per hour and artifacts per hour
   * are two panels with their own scales, because §9.5 forbids the dual axis
   * and because the point is to read them side by side. The scatter underneath
   * is the manager's picture: one dot per card, dollars against what landed.
   * The table is the same numbers in the honest form, and the coordination
   * strip is where parallel work fought itself.
   *
   * **It owns no fact.** `model` arrives built once by `analyticswork.ts`, and
   * the page is handed the same value, so the two skins cannot disagree.
   *
   * Colour is `seriesColor` and nothing else; chrome stays achromatic and no
   * word is painted in a series hue. A missing card-hour is a gap with no bar,
   * not a bar at zero. A ratio with no divisor is a dash in the table, never a
   * zero.
   */
  import AnalyticsWorkTable from "./AnalyticsWorkTable.svelte";
  import { niceAxis } from "./analyticsroom";
  import {
    INVALIDATE_ADVICE,
    SCATTER_MEASURES,
    attributeWaitSaid,
    episodeAuthor,
    episodeLabel,
    scatterTicks,
    signed,
    type ConflictEpisode,
    type InvalidateEpisode,
    type ScatterMeasure,
    type WorkModel,
  } from "./analyticswork";
  import { seriesColor } from "./analytics";
  import { count, money } from "./usage";
  import { watchSaid, type SpendWatch } from "./spend";
  import { tipOf } from "./tipped.svelte";

  let {
    model,
    from,
    to,
    spanSaid,
    measure,
    onmeasure,
    watches,
    unwatch,
  }: {
    model: WorkModel;
    from: number;
    to: number;
    spanSaid: string;
    measure: ScatterMeasure;
    onmeasure: (m: ScatterMeasure) => void;
    watches: (card: string) => Promise<SpendWatch[]>;
    unwatch: (card: string, id: number) => Promise<boolean>;
  } = $props();

  const INK = seriesColor(0);
  const width = $derived(Math.max(1, to - from));

  let active = $state<string | null>(null);
  let episode = $state<ConflictEpisode | null>(null);
  let reread = $state<InvalidateEpisode | null>(null);
  let costW = $state(320);
  let artW = $state(320);
  let scatterW = $state(560);
  let stripW = $state(560);

  function sized(set: (n: number) => void) {
    return (el: HTMLElement) => {
      set(el.clientWidth);
      const ro = new ResizeObserver(() => set(el.clientWidth));
      ro.observe(el);
      return () => ro.disconnect();
    };
  }

  const activeCard = $derived(model.cards.find((c) => c.card === active) ?? null);

  /* ── the two panels ────────────────────────────────────────────────────── */

  const PAD = { l: 44, t: 10, b: 22, r: 8 };

  function panel(w: number, points: { at: number; value: number }[], moneyAxis: boolean) {
    const plotW = Math.max(20, w - PAD.l - PAD.r);
    const plotH = 130;
    let top = 0;
    for (const p of points) if (p.value > top) top = p.value;
    const axis = niceAxis(top > 0 ? top : 1, 3);
    const xOf = (at: number) => PAD.l + ((at - from) / width) * plotW;
    const yOf = (v: number) => PAD.t + plotH - (v / axis.top) * plotH;
    const barW = Math.max(1, (plotW * 3_600_000) / width - 1);
    const bars = points.map((p) => ({
      x: xOf(p.at),
      y: yOf(p.value),
      w: barW,
      h: Math.max(1, PAD.t + plotH - yOf(p.value)),
    }));
    const ticks = axis.ticks.map((v) => ({
      v,
      y: yOf(v),
      text: moneyAxis ? money(v) : count(v),
    }));
    const xTicks = [0, 0.5, 1].map((f) => {
      const at = from + width * f;
      return { x: PAD.l + plotW * f, text: tickText(at) };
    });
    return { plotW, plotH, axis, bars, ticks, xTicks };
  }

  function tickText(at: number): string {
    const d = new Date(at);
    if (width > 3 * 86_400_000) {
      return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    }
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  const costPanel = $derived(panel(costW, model.panels.cost, true));
  const artPanel = $derived(panel(artW, model.panels.artifacts, false));

  /* The table under the pair: one row per hour either panel has a reading for.
     `union` rather than two tables, so an hour with cost and no artifact says
     exactly that instead of appearing in one column only. */
  const panelRows = $derived.by(() => {
    const times = new Set<number>();
    for (const p of model.panels.cost) times.add(p.at);
    for (const p of model.panels.artifacts) times.add(p.at);
    const cost = new Map(model.panels.cost.map((p) => [p.at, p.value]));
    const art = new Map(model.panels.artifacts.map((p) => [p.at, p.value]));
    return [...times]
      .sort((a, b) => a - b)
      .map((at) => ({ at, cost: cost.get(at) ?? null, artifacts: art.get(at) ?? null }));
  });

  /* ── the scatter ───────────────────────────────────────────────────────── */

  const SPAD = { l: 44, t: 12, b: 28, r: 14 };

  const scatter = $derived.by(() => {
    const pts = model.scatter.points;
    const plotW = Math.max(20, scatterW - SPAD.l - SPAD.r);
    const plotH = 240;
    let maxCost = 0;
    for (const p of pts) if (p.cost > maxCost) maxCost = p.cost;
    const xAxis = niceAxis(maxCost > 0 ? maxCost : 1, 4);
    let lo = 0;
    let hi = 0;
    for (const p of pts) {
      if (p.y < lo) lo = p.y;
      if (p.y > hi) hi = p.y;
    }
    if (hi === lo) hi = lo + 1;
    const xOf = (v: number) => SPAD.l + (v / xAxis.top) * plotW;
    const yOf = (v: number) => SPAD.t + plotH - ((v - lo) / (hi - lo)) * plotH;
    /* `py` rather than `y`: the dot keeps the measure it was plotted from, so
       a tooltip or an aria-label cannot read the pixel position as the value. */
    const dots = pts.map((p) => ({ ...p, x: xOf(p.cost), py: yOf(p.y) }));
    const xTicks = xAxis.ticks.map((v) => ({ v, x: xOf(v), text: money(v) }));
    const yTicks = scatterTicks(lo, hi, measure).map((v) => ({
      v,
      y: yOf(v),
      text: measure === "net" ? signed(v) : count(v),
    }));
    return { plotW, plotH, xOf, yOf, dots, xTicks, yTicks };
  });

  /** Hover reads a card; a click or Enter **picks** it, and a pick is what the
   *  watches block hangs from. A block hung on the hover would vanish the moment
   *  the pointer left the dot, which is before a delete button on it can be
   *  reached. */
  function activate(card: string | null, pick = false) {
    if (pick) {
      picked = card;
      active = card;
      return;
    }
    /* Once a card is picked, the readout stays on it: a block naming one card
       above a readout naming another is two answers to "which card". */
    active = picked ?? card;
  }

  /* ── the watches the picked card set on itself ─────────────────────────── */

  let picked = $state<string | null>(null);
  let watched = $state<SpendWatch[] | null>(null);
  let watchFault = $state<string | null>(null);

  $effect(() => {
    const card = picked;
    if (!card) {
      watched = null;
      watchFault = null;
      return;
    }
    let live = true;
    watched = null;
    watchFault = null;
    watches(card).then(
      (rows) => {
        if (live) watched = rows;
      },
      (e) => {
        if (live) watchFault = String(e);
      },
    );
    return () => {
      live = false;
    };
  });

  async function removeWatch(id: number) {
    const card = picked;
    if (!card) return;
    try {
      await unwatch(card, id);
      const rows = await watches(card);
      /* Both calls are round trips, and the dot can be re-picked while they are
         in flight. Writing the old card's rows now would label one card's
         watches with another's name. */
      if (picked === card) watched = rows;
    } catch (e) {
      if (picked === card) watchFault = String(e);
    }
  }

  function pointLabel(p: { label: string; cost: number; y: number; noArtifact: boolean }): string {
    const y = measure === "net" ? `${signed(p.y)} net lines` : `${count(p.y)} merged`;
    return `${p.label}: ${money(p.cost)}, ${y}${p.noArtifact ? ", no artifact" : ""}`;
  }

  /* ── the coordination strip ────────────────────────────────────────────── */

  const ROW = 30;

  const barRows = $derived(model.bars);
  const rowIndex = $derived(new Map(barRows.map((b, i) => [b.card, i])));
  /* §11.14's instruction-churn episodes share the strip and the timescale with
     the card bars, on a row of their own underneath them. A whole wall's cards
     are not the thing a `CLAUDE.md` write affects; the tree and the run are. */
  const inv = $derived(model.invalidations);
  const invRow = $derived(barRows.length);
  const stripHeight = $derived(Math.max(ROW, (barRows.length + (inv.episodesCount > 0 ? 1 : 0)) * ROW));

  const invMarks = $derived(
    inv.episodes
      .filter((e) => e.kind === "instructions" || e.kind === "rule")
      .map((e) => ({
        episode: e,
        x: xStrip(e.start),
        w: Math.max(6, xStrip(e.end) - xStrip(e.start)),
        size: Math.max(7, Math.min(16, 6 + e.writes * 2)),
      })),
  );

  function invSaid(e: InvalidateEpisode): string {
    const when = new Date(e.start).toLocaleString("en-GB");
    const payers = e.measured
      ? e.payers.length
        ? `${e.payers.length === 1 ? "one card" : `${e.payers.length} cards`} paid ${money(e.usd ?? 0)}`
        : "measured at nothing"
      : "unmeasured";
    const run = e.writes > 1 ? `${e.writes} writes in the run, ` : "";
    return `${episodeLabel(e)} on ${e.tree || "an unnamed tree"}: ${run}${when}, by ${episodeAuthor(e, nameOf)}; ${payers}`;
  }

  const nameOf = $derived(new Map(model.cards.map((c) => [c.card, c.label])));

  const invSummary = $derived.by(() => {
    if (model.invalidationsUnread) {
      return "the invalidation reading did not answer for this span, so nothing is claimed about re-reading.";
    }
    if (inv.events + inv.switches === 0) {
      return "nothing was recorded in this span: no instruction file was written and no card moved account, provider or model.";
    }
    const dollars =
      inv.usd === null
        ? "the excess is unmeasured"
        : `${money(inv.usd)} of excess re-reading${inv.share !== null ? ` · ${Math.round(inv.share * 100)}% of the span's spend` : ""}`;
    const churn = inv.churnEpisodes > 0 ? ` · ${count(inv.churnWriteCount)} writes in ${count(inv.churnEpisodes)} churn ${inv.churnEpisodes === 1 ? "run" : "runs"}` : "";
    const moves = inv.switches > 0 ? ` · ${count(inv.switches)} ${inv.switches === 1 ? "move" : "moves"}` : "";
    return `${count(inv.events)} ${inv.events === 1 ? "write" : "writes"} to an instruction or rule file in ${count(inv.writeEpisodes)} ${inv.writeEpisodes === 1 ? "episode" : "episodes"}${moves} · ${dollars}${churn}`;
  });

  function xStrip(at: number): number {
    return ((at - from) / width) * Math.max(20, stripW);
  }

  const strips = $derived.by(() => {
    const bands = model.bands
      .map((band) => {
        const a = rowIndex.get(band.left);
        const b = rowIndex.get(band.right);
        if (a === undefined || b === undefined) return null;
        return {
          ...band,
          top: Math.min(a, b) * ROW + ROW / 2,
          height: Math.abs(a - b) * ROW,
          label: `${bandLabel(band.left)} + ${bandLabel(band.right)} touched ${band.files.length === 1 ? "one file" : `${count(band.files.length)} files`} for ${count(band.minutes)} minutes`,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const conflicts = model.episodes
      .map((ep) => {
        const row = rowIndex.get(ep.card);
        if (row === undefined) return null;
        return {
          episode: ep,
          top: row * ROW + 5,
          x: xStrip(ep.start),
          w: Math.max(5, xStrip(ep.end) - xStrip(ep.start)),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return { bands, conflicts };
  });

  function bandLabel(card: string): string {
    return model.cards.find((c) => c.card === card)?.label ?? "no card";
  }

  function episodeUsd(ep: ConflictEpisode): number | null {
    const card = model.cards.find((c) => c.card === ep.card);
    if (!card || card.burnUsdPerHour === null) return null;
    return (ep.minutes / 60) * card.burnUsdPerHour;
  }

  function episodeSaid(ep: ConflictEpisode): string {
    const dollars = episodeUsd(ep);
    const cost = dollars === null ? "no priced burn" : money(dollars);
    return `${count(Math.round(ep.minutes))} minutes on ${ep.branch || "an unnamed branch"}, ${count(ep.files)} conflicted ${ep.files === 1 ? "file" : "files"}, ${cost}`;
  }

  const stripNote = $derived.by(() => {
    const coord = model.coordination;
    const unread = model.overlapsUnread ? " · the pair listing could not be read for this span" : "";
    if (coord.conflictMinutes === 0) return `no conflict was recorded in this window${unread}`;
    const usd = coord.coordinationUsd;
    const head = `${count(Math.round(coord.conflictMinutes))} conflict minutes`;
    if (usd === null) return `${head}, and no card's burn could be priced${unread}`;
    const tail = coord.unpricedMinutes > 0 ? ` · ${count(Math.round(coord.unpricedMinutes))} minutes unpriced` : "";
    return `${head} cost ${money(usd)} of the cards' own burn${tail}${unread}`;
  });

  /* ── the shell's keys, delegated ───────────────────────────────────────── */

  let scroller = $state<HTMLElement>();

  export function scrollBy(delta: number) {
    scroller?.scrollBy({ top: delta, behavior: "instant" as ScrollBehavior });
  }

  export function goTo(where: "top" | "bottom") {
    if (!scroller) return;
    scroller.scrollTo({ top: where === "top" ? 0 : scroller.scrollHeight, behavior: "instant" as ScrollBehavior });
  }

  export function turnPage(delta: number) {
    if (!scroller) return;
    scroller.scrollBy({ top: delta * scroller.clientHeight * 0.9, behavior: "instant" as ScrollBehavior });
  }

  /* Escape closes the episode before it closes the surface, the same order the
     prompts tab keeps. Returns true for a key it used. */
  export function key(e: KeyboardEvent): boolean {
    if (e.key === "Escape" && reread) {
      e.preventDefault();
      e.stopPropagation();
      reread = null;
      return true;
    }
    if (e.key === "Escape" && episode) {
      e.preventDefault();
      e.stopPropagation();
      episode = null;
      return true;
    }
    return false;
  }
</script>

<div class="aw-scroll" bind:this={scroller}>
  <div class="aw-body">
    {#if model.story.state !== "normal"}
      <p class="aw-lede">{model.story.lede}</p>
    {/if}

    <!-- ── the strip ─────────────────────────────────────────────────── -->
    <div class="aw-kpis" role="group" aria-label="what the window bought">
      <div class="aw-kpi">
        <span class="aw-klabel">cost</span>
        <span class="aw-kvalue">{model.kpis.cost === null ? "," : money(model.kpis.cost)}</span>
        <span class="aw-knote">
          {model.kpis.cost === null
            ? model.kpis.unpriced > 0
              ? `${count(model.kpis.unpriced)} card-hours unpriced`
              : "no spend recorded"
            : model.kpis.unpriced > 0
              ? `${count(model.kpis.unpriced)} spend rows unpriced`
              : model.kpis.reported > 0
                ? "modeled and reported"
                : "modeled"}
        </span>
      </div>
      <div class="aw-kpi">
        <span class="aw-klabel">merged</span>
        <span class="aw-kvalue">{count(model.kpis.merged)}</span>
        <span class="aw-knote">
          {model.kpis.mergedFromHistory > 0
            ? `${count(model.kpis.mergedFromHistory)} attributed from history`
            : "merge receipts"}
        </span>
      </div>
      <div class="aw-kpi">
        <span class="aw-klabel">commits</span>
        <span class="aw-kvalue">{count(model.kpis.commits)}</span>
        <span class="aw-knote">
          {model.kpis.attributedCommits > 0
            ? `${count(model.kpis.attributedCommits)} attributed from history`
            : "from receipts"}
        </span>
      </div>
      <div class="aw-kpi">
        <span class="aw-klabel">net lines</span>
        <span class="aw-kvalue">{signed(model.kpis.net)}</span>
        <span class="aw-knote">{count(model.kpis.added)} added, {count(model.kpis.removed)} removed</span>
      </div>
      <div class="aw-kpi">
        <span class="aw-klabel">conflict minutes</span>
        <span class="aw-kvalue">{count(Math.round(model.kpis.conflictMinutes))}</span>
        <span class="aw-knote">
          {model.episodes.length
            ? `${count(model.episodes.length)} episode${model.episodes.length === 1 ? "" : "s"}`
            : "none recorded"}
        </span>
      </div>
      <div class="aw-kpi">
        <span class="aw-klabel">leading project</span>
        <span class="aw-kvalue">{model.kpis.leading?.project ?? ","}</span>
        <span class="aw-knote">
          {model.kpis.leading?.share != null
            ? `${Math.round(model.kpis.leading.share)}% of artifacts`
            : "no artifacts to lead"}
        </span>
      </div>
    </div>

    <!-- ── the pair, never one axis ──────────────────────────────────── -->
    <div class="aw-pair">
      <figure class="aw-panel">
        <figcaption>
          <h4>cost per hour</h4>
          <span class="aw-sub">spend, priced per card-hour, {spanSaid}</span>
        </figcaption>
        {#if model.panels.cost.length === 0}
          <p class="aw-nothing">no hour in this window has a priced reading.</p>
        {:else}
        <div class="aw-plate" style:height="162px" {@attach sized((n) => (costW = n))}>
          <svg width={costW} height="162" role="img" aria-label="modeled cost for each recorded hour">
            {#each costPanel.ticks as t (t.v)}
              <line class="aw-grid" x1={PAD.l} x2={PAD.l + costPanel.plotW} y1={t.y} y2={t.y} />
              {#if t.v !== 0}
                <text class="aw-axis" x={PAD.l - 7} y={t.y + 3.5} text-anchor="end">{t.text}</text>
              {/if}
            {/each}
            {#each costPanel.bars as b, i (i)}
              <rect x={b.x} y={b.y} width={b.w} height={b.h} rx="1" fill={INK} opacity="0.75" />
            {/each}
            {#each costPanel.xTicks as t, i (i)}
              <text class="aw-axis" x={t.x} y={PAD.t + costPanel.plotH + 16} text-anchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}>{t.text}</text>
            {/each}
          </svg>
        </div>
        {/if}
        <p class="aw-hint">
          {model.panels.costUnpriced > 0
            ? `${count(model.panels.costUnpriced)} spend rows carry no price and have no bar.`
            : "only hours with a reading have a bar; an empty hour is a gap."}
        </p>
      </figure>

      <figure class="aw-panel">
        <figcaption>
          <h4>artifacts per hour</h4>
          <span class="aw-sub">commits, pushes and integrations, {spanSaid}</span>
        </figcaption>
        {#if model.panels.artifacts.length === 0}
          <p class="aw-nothing">no artifact in this window has an hour to stand in.</p>
        {:else}
        <div class="aw-plate" style:height="162px" {@attach sized((n) => (artW = n))}>
          <svg width={artW} height="162" role="img" aria-label="artifacts for each recorded hour">
            {#each artPanel.ticks as t (t.v)}
              <line class="aw-grid" x1={PAD.l} x2={PAD.l + artPanel.plotW} y1={t.y} y2={t.y} />
              {#if t.v !== 0}
                <text class="aw-axis" x={PAD.l - 7} y={t.y + 3.5} text-anchor="end">{t.text}</text>
              {/if}
            {/each}
            {#each artPanel.bars as b, i (i)}
              <rect x={b.x} y={b.y} width={b.w} height={b.h} rx="1" fill={INK} opacity="0.75" />
            {/each}
            {#each artPanel.xTicks as t, i (i)}
              <text class="aw-axis" x={t.x} y={PAD.t + artPanel.plotH + 16} text-anchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}>{t.text}</text>
            {/each}
          </svg>
        </div>
        {/if}
        <p class="aw-hint">an empty hour is a gap, not a zero.</p>
      </figure>
    </div>

    <details class="aw-details">
      <summary>every hour, as the two panels draw it</summary>
      <div class="aw-hourwrap">
        <table class="aw-hours">
          <thead>
            <tr><th scope="col">hour</th><th scope="col" class="aw-num">cost</th><th scope="col" class="aw-num">artifacts</th></tr>
          </thead>
          <tbody>
            {#each panelRows as row (row.at)}
              <tr>
                <th scope="row">{new Date(row.at).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</th>
                <td class="aw-num">{row.cost === null ? "," : money(row.cost)}</td>
                <td class="aw-num">{row.artifacts === null ? "," : count(row.artifacts)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </details>

    <!-- ── the scatter: the manager's picture ────────────────────────── -->
    <figure class="aw-scatter">
      <figcaption>
        <div>
          <h4>cost against output</h4>
          <span class="aw-sub">one dot per card, dollars against {measure === "net" ? "net lines" : "merged pull requests and merge commits"}</span>
        </div>
        <div class="aw-seg" role="radiogroup" aria-label="what to plot against cost" tabindex="-1">
          {#each SCATTER_MEASURES as m (m.key)}
            <button
              type="button"
              role="radio"
              aria-checked={measure === m.key}
              class:on={measure === m.key}
              {@attach tipOf(() => (`${m.said} (x switches it)`))}
              onclick={() => onmeasure(m.key)}>{m.label}</button
            >
          {/each}
        </div>
      </figcaption>
      {#if model.scatter.points.length === 0}
        <p class="aw-nothing">
          no card in this window has both a cost and an artifact, so there is nothing to place.
        </p>
      {:else}
      <div class="aw-plate" style:height="280px" {@attach sized((n) => (scatterW = n))}>
        <svg width={scatterW} height="280" role="img" aria-label={`cost against ${measure}`}>
          {#each scatter.yTicks as t (t.v)}
            <line class="aw-grid" x1={SPAD.l} x2={SPAD.l + scatter.plotW} y1={t.y} y2={t.y} />
            <text class="aw-axis" x={SPAD.l - 7} y={t.y + 3.5} text-anchor="end">{t.text}</text>
          {/each}
          {#each scatter.xTicks as t (t.v)}
            <line class="aw-grid" x1={t.x} x2={t.x} y1={SPAD.t} y2={SPAD.t + scatter.plotH} />
            <text class="aw-axis" x={t.x} y={SPAD.t + scatter.plotH + 17} text-anchor="middle">{t.text}</text>
          {/each}
          {#each scatter.dots as d (d.card)}
            <circle
              tabindex="0"
              role="button"
              aria-label={pointLabel(d)}
              class="aw-dot"
              class:on={active === d.card}
              cx={d.x}
              cy={d.py}
              r={active === d.card ? 6 : 4.2}
              fill={d.noArtifact ? "none" : INK}
              stroke={INK}
              stroke-width={d.noArtifact ? 1.5 : 0}
              onfocus={() => activate(d.card)}
              onblur={() => activate(picked)}
              onpointerenter={() => activate(d.card)}
              onpointerleave={() => activate(picked)}
              onclick={() => activate(d.card, true)}
              onkeydown={(e) => {
                /* A `button` role on an SVG element gets no synthetic click, so
                   Enter and Space are wired by hand rather than announced and
                   inert. */
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  activate(d.card, true);
                }
              }}
            />
          {/each}
        </svg>
      </div>
      {/if}
      <p class="aw-readout">
        {#if activeCard}
          <strong>{activeCard.label}</strong>
          {activeCard.cost === null ? "cost ," : money(activeCard.cost)}
          · {count(activeCard.merged)} merged
          · {count(activeCard.commits)} commits
          · {signed(activeCard.net)} net
          {#if activeCard.noArtifact}<span class="aw-none">no artifact</span>{/if}
        {:else}
          hover a dot or walk the table to read a card; click one (or Enter on it) to keep it and
          read the thresholds it set on itself. a hollow dot is a card with no artifact.
        {/if}
      </p>

      <!-- The thresholds the picked card set on itself (§11.13).
           **These are the card's, not the wall's**: the row is per conversation,
           written by the card's own `spend_watch`, and there is deliberately no
           editor here beyond delete, the tool is where a watch is made.
           When the card page §11.10 describes is built it should reuse this
           block rather than draw a second shape for the same row. -->
      {#if picked}
        <div class="aw-watches" role="group" aria-label="watches this card set on itself">
          <div class="aw-watchhead">
            <strong>{nameOf.get(picked) ?? picked}</strong>
            <span class="aw-sub">thresholds it set on itself</span>
            <button
              type="button"
              class="aw-watchclose"
              {@attach tipOf("close (the dot stays selected until another is picked)")}
              aria-label="close the watches"
              onclick={() => {
                picked = null;
                active = null;
              }}>×</button
            >
          </div>
          {#if watchFault}
            <p class="aw-hint">the watches could not be read, {watchFault}</p>
          {:else if watched === null}
            <p class="aw-hint">reading…</p>
          {:else if watched.length === 0}
            <p class="aw-hint">
              no threshold set. a card sets one on itself with <code>spend_watch watch usd 10 session</code>,
              which is the only place it can be made.
            </p>
          {:else}
            <ul class="aw-watchlist">
              {#each watched as w (w.id)}
                <li>
                  <span class="aw-watchsaid">{watchSaid(w, Date.now())}</span>
                  <span class="aw-watchwhen">{w.measure} · {w.period}</span>
                  <button
                    type="button"
                    class="aw-watchdrop"
                    {@attach tipOf(() => `remove this watch (watch #${w.id})`)}
                    onclick={() => removeWatch(w.id)}>delete</button
                  >
                </li>
              {/each}
            </ul>
            <p class="aw-hint">a watch never stops, pauses or slows a turn. it rings once per period.</p>
          {/if}
        </div>
      {/if}
      {#if model.scatter.omitted > 0}
        <p class="aw-hint">
          {count(model.scatter.omitted)} {model.scatter.omitted === 1 ? "card has" : "cards have"} no spend
          attributed, so {model.scatter.omitted === 1 ? "it is" : "they are"} not placed here.
        </p>
      {/if}
    </figure>

    <!-- ── the table ────────────────────────────────────────────────── -->
    <section class="aw-section">
      <h4>per card</h4>
      <AnalyticsWorkTable cards={model.cards} onhover={activate} />
      <p class="aw-hint">
        a dash is a ratio with no divisor: the card did nothing to divide by, or no spend was attributed to it.
      </p>
    </section>

    <!-- ── the coordination strip ───────────────────────────────────── -->
    <section class="aw-section">
      <h4>coordination</h4>
      <p class="aw-stripnote">{stripNote}</p>
      <p class="aw-stripnote">{invSummary}</p>
      <div class="aw-strip" style:height={`${stripHeight}px`}>
        <div class="aw-striplabels">
          {#each barRows as bar, i (bar.card)}
            <div class="aw-rowlabel" style:height={`${ROW}px`} {@attach tipOf(() => (`${bar.project}${bar.burnUsdPerHour === null ? "" : ` · ${money(bar.burnUsdPerHour)} an hour`}`))}>
              <span class="aw-rowname">{bar.label}</span>
              <span class="aw-rowcost">{bar.cost === null ? "unpriced" : money(bar.cost)}</span>
            </div>
          {/each}
          {#if inv.episodesCount > 0}
            <div class="aw-rowlabel" style:height={`${ROW}px`} {@attach tipOf("writes to instruction and rule files, and what the other cards paid to read again")}>
              <span class="aw-rowname">re-reads</span>
              <span class="aw-rowcost">{inv.usd === null ? "unmeasured" : money(inv.usd)}</span>
            </div>
          {/if}
        </div>
        <div class="aw-track" bind:clientWidth={stripW} style:height={`${stripHeight}px`}>
          {#each strips.bands as band (`${band.left}|${band.right}`)}
            {#each band.spans as span, si (`${band.left}-${band.right}-${si}`)}
              <span
                class="aw-band"
                style:left={`${(span[0] - from) / width * stripW}px`}
                style:width={`${Math.max(4, (span[1] - span[0]) / width * stripW)}px`}
                style:top={`${band.top}px`}
                style:height={`${Math.max(2, band.height)}px`}
                {@attach tipOf(() => (band.label))}
              ></span>
            {/each}
          {/each}
          {#each barRows as bar, i (bar.card)}
            <div class="aw-row" style:top={`${i * ROW}px`} style:height={`${ROW}px`}>
              {#each bar.spans as span, si (`${bar.card}-${si}`)}
                <span
                  class="aw-bar"
                  style:left={`${(span[0] - from) / width * stripW}px`}
                  style:width={`${Math.max(2, (span[1] - span[0]) / width * stripW)}px`}
                  {@attach tipOf(() => (`${bar.label}: ${new Date(span[0]).toLocaleString("en-GB")} to ${new Date(span[1]).toLocaleString("en-GB")}`))}
                ></span>
              {/each}
              {#each strips.conflicts as c (`${c.episode.start}|${c.episode.card}`)}
                {#if c.episode.card === bar.card}
                  <button
                    type="button"
                    class="aw-conflict"
                    style:left={`${c.x}px`}
                    style:width={`${c.w}px`}
                    {@attach tipOf(() => (`${episodeSaid(c.episode)} (open it)`))}
                    aria-label={episodeSaid(c.episode)}
                    onclick={() => (episode = c.episode)}
                  ></button>
                {/if}
              {/each}
            </div>
          {/each}
          {#if invMarks.length > 0}
            <div class="aw-row aw-invrow" style:top={`${invRow * ROW}px`} style:height={`${ROW}px`}>
              {#each invMarks as m (`${m.episode.key}`)}
                <button
                  type="button"
                  class="aw-inv"
                  class:rule={m.episode.kind === "rule"}
                  class:churn={m.episode.writes > 1}
                  style:left={`${m.x}px`}
                  style:width={`${m.size}px`}
                  style:height={`${m.size}px`}
                  {@attach tipOf(() => (`${invSaid(m.episode)} (open it)`))}
                  aria-label={invSaid(m.episode)}
                  onclick={() => (reread = m.episode)}
                ></button>
              {/each}
            </div>
          {/if}
          {#each [0, 0.5, 1] as f, i (i)}
            <span class="aw-tick" style:left={`${f * stripW}px`}></span>
            <span class="aw-ticktext" class:end={i === 2} style:left={`${f * stripW}px`}>{tickText(from + width * f)}</span>
          {/each}
        </div>
      </div>
      <p class="aw-hint">
        a bar is a card's session, a band is two cards in the same file, an amber mark is a conflict episode, and a mark on the re-reads row is a write to an instruction file that made other cards read again. a square is an instruction and a diamond is a rule; the bigger it is, the more writes the run swallowed. open a mark for its path, time, author and who paid.
      </p>

      <!-- The strip's honest table, because every chart owes one and a band's
           title is not a table. -->
      <details class="aw-details">
        <summary>the pairs and episodes behind the strip</summary>
        <div class="aw-pairtables">
          <table class="aw-hours">
            <thead>
              <tr><th scope="col">pair</th><th scope="col" class="aw-num">minutes</th><th scope="col" class="aw-num">files</th></tr>
            </thead>
            <tbody>
              {#each model.bands as band (`${band.left}|${band.right}`)}
                <tr>
                  <th scope="row">{bandLabel(band.left)} + {bandLabel(band.right)}</th>
                  <td class="aw-num">{count(band.minutes)}</td>
                  <td class="aw-num">{count(band.files.length)}</td>
                </tr>
              {:else}
                <tr><td colspan="3">{model.overlapsUnread ? "the pair listing could not be read for this span." : "no pair touched a common file in this window."}</td></tr>
              {/each}
            </tbody>
          </table>
          <table class="aw-hours">
            <thead>
              <tr>
                <th scope="col">episode</th>
                <th scope="col">branch</th>
                <th scope="col" class="aw-num">minutes</th>
                <th scope="col">closed by</th>
                <th scope="col" class="aw-num">cost</th>
              </tr>
            </thead>
            <tbody>
              {#each model.episodes as ep (`${ep.start}|${ep.card}`)}
                <tr>
                  <th scope="row">{bandLabel(ep.card)}</th>
                  <td>{ep.branch || "unnamed"}</td>
                  <td class="aw-num">{count(Math.round(ep.minutes))}</td>
                  <td>{ep.closedBy === "cap" ? "the cap" : ep.closedBy.replace("_", " ")}</td>
                  <td class="aw-num">{episodeUsd(ep) === null ? "," : money(episodeUsd(ep) ?? 0)}</td>
                </tr>
              {:else}
                <tr><td colspan="5">no conflict was recorded in this window.</td></tr>
              {/each}
            </tbody>
          </table>

          <!-- The invalidation half's honest table: every episode worth acting
               on, with the cards that paid. -->
          <table class="aw-hours">
            <thead>
              <tr>
                <th scope="col">tree</th>
                <th scope="col">path</th>
                <th scope="col">time</th>
                <th scope="col">run</th>
                <th scope="col" class="aw-num">cards paid</th>
                <th scope="col" class="aw-num">cost</th>
              </tr>
            </thead>
            <tbody>
              {#each inv.episodes as e (`${e.key}`)}
                <tr>
                  <th scope="row">{e.tree || "no tree"}</th>
                  <td>{episodeLabel(e)}</td>
                  <td>{new Date(e.end).toLocaleString("en-GB")}</td>
                  <td>{e.writes > 1 ? `churn, ${count(e.writes)} writes` : "one write"}</td>
                  <td class="aw-num">{e.measured ? count(e.payers.length) : ","}</td>
                  <td class="aw-num">{e.measured ? money(e.usd ?? 0) : "unmeasured"}</td>
                </tr>
              {:else}
                <tr><td colspan="6">{model.invalidationsUnread ? "the invalidation reading did not answer for this span." : "nothing was recorded: no instruction file was written in this window."}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      </details>

      {#if reread}
        <div class="aw-episode" role="group" aria-label="invalidation episode">
          <div class="aw-ephead">
            <strong>{episodeLabel(reread)}</strong>
            <span>{episodeAuthor(reread, nameOf)}</span>
            <button type="button" class="aw-epclose" {@attach tipOf("close (esc)")} aria-label="close episode" onclick={() => (reread = null)}>×</button>
          </div>
          <dl class="aw-epfacts">
            <div><dt>tree</dt><dd>{reread.tree || "no tree"}</dd></div>
            <div><dt>when</dt><dd>{new Date(reread.start).toLocaleString("en-GB")}</dd></div>
            <div><dt>kind</dt><dd>{reread.kind}</dd></div>
            <div><dt>writes in the run</dt><dd>{count(reread.writes)}</dd></div>
            <div>
              <!-- **Two meanings, named apart.** A switch's count is the cards
                   mid-turn when it happened; a write's is the other card
                   sessions in the tree whose interval overlaps the run. One
                   label for both would state the wrong thing about one. -->
              <dt>{reread.kind === "instructions" || reread.kind === "rule" ? "other cards in the tree" : "cards working"}</dt>
              <dd>{count(reread.affected)}</dd>
            </div>
            <div><dt>cost</dt><dd>{reread.measured ? money(reread.usd ?? 0) : "unmeasured"}</dd></div>
          </dl>
          {#if reread.kind === "instructions" || reread.kind === "rule"}
            <p class="aw-hint">
              counted against the card sessions overlapping the ten minutes this run opened. a card that had not started yet is not counted, and a terminal is not a card.
            </p>
          {/if}
          {#if reread.payers.length > 0}
            <p class="aw-hint">
              paid by {#each reread.payers as p, i (p.session)}{i > 0 ? ", " : ""}{bandLabel(p.card)}{p.usd === null ? " (unpriced)" : ` (${money(p.usd)})`}{/each}.
            </p>
          {:else}
            <p class="aw-hint">no card's next request was seen within {attributeWaitSaid()} of the last write, so the excess is unmeasured rather than zero.</p>
          {/if}
          <p class="aw-hint">{INVALIDATE_ADVICE}</p>
        </div>
      {/if}

      {#if episode}
        <div class="aw-episode" role="group" aria-label="conflict episode">
          <div class="aw-ephead">
            <strong>{episode.branch || "unnamed branch"}</strong>
            <span>{bandLabel(episode.card)}</span>
            <button type="button" class="aw-epclose" {@attach tipOf("close (esc)")} aria-label="close episode" onclick={() => (episode = null)}>×</button>
          </div>
          <dl class="aw-epfacts">
            <div><dt>minutes</dt><dd>{count(Math.round(episode.minutes))}</dd></div>
            <div><dt>conflicted files</dt><dd>{count(episode.files)}</dd></div>
            <div><dt>blocked in the command</dt><dd>{count(Math.round(episode.latencyMs / 60_000))}m</dd></div>
            <div><dt>resolution</dt><dd>{episode.closedBy === "cap" ? "none within thirty minutes" : `a ${episode.closedBy.replace("_", " ")}`}</dd></div>
            <div><dt>cost</dt><dd>{episodeUsd(episode) === null ? "no priced burn" : money(episodeUsd(episode) ?? 0)}</dd></div>
          </dl>
          {#if episode.files > 0}
            <p class="aw-hint">tree and file names are not carried by the work fact; only the count is.</p>
          {/if}
        </div>
      {/if}
    </section>

    <p class="aw-caveat">{model.caveat}</p>
  </div>
</div>

<style>
  .aw-scroll {
    position: absolute;
    inset: 0;
    overflow: auto;
    scrollbar-width: thin;
  }
  .aw-body {
    padding: 14px 16px 30px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    color: var(--paper-dim);
  }
  /* The room is an instrument and says no prose, except in the two states that
     need one sentence: nothing recorded, or spend with no artifact. */
  .aw-lede {
    margin: 0;
    max-width: 72ch;
    font-family: var(--body);
    font-size: 13.5px;
    line-height: 1.55;
    color: var(--paper-dim);
  }
  .aw-nothing {
    margin: 18px 0;
    font-family: var(--body);
    font-style: italic;
    font-size: 12px;
    color: var(--paper-faint);
  }

  /* ── the strip ─────────────────────────────────────────────────────────── */

  .aw-kpis {
    display: grid;
    grid-template-columns: repeat(6, minmax(0, 1fr));
    gap: 1px;
    border: 1px solid var(--cv-hair, var(--edge));
    border-radius: 10px;
    overflow: hidden;
    background: var(--cv-hair, var(--edge));
  }
  .aw-kpi {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 9px 11px;
    background: color-mix(in oklab, var(--raised) 82%, var(--paper) 3%);
    min-width: 0;
  }
  .aw-klabel {
    font-family: var(--cv-ui, var(--util));
    font-size: 9.5px;
    letter-spacing: 0.05em;
    text-transform: lowercase;
    color: var(--paper-faint);
  }
  .aw-kvalue {
    font-family: var(--cv-ui, var(--util));
    font-size: 16px;
    font-weight: 500;
    color: var(--paper);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .aw-knote {
    font-family: var(--cv-ui, var(--util));
    font-size: 9.5px;
    color: var(--paper-mute);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ── the pair ──────────────────────────────────────────────────────────── */

  .aw-pair {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 14px;
  }
  .aw-panel {
    margin: 0;
    padding: 10px 12px 8px;
    border: 1px solid var(--cv-hair, var(--edge));
    border-radius: 10px;
    background: color-mix(in oklab, var(--raised) 70%, transparent);
    min-width: 0;
  }
  .aw-panel figcaption,
  .aw-scatter figcaption {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 4px;
  }
  .aw-panel h4,
  .aw-scatter h4,
  .aw-section h4 {
    margin: 0;
    font-family: var(--cv-ui, var(--util));
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--paper);
  }
  .aw-sub {
    font-family: var(--cv-ui, var(--util));
    font-size: 9.5px;
    color: var(--paper-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .aw-plate {
    position: relative;
    width: 100%;
    overflow: hidden;
  }
  .aw-plate svg {
    display: block;
    overflow: visible;
  }
  .aw-grid {
    stroke: color-mix(in oklab, var(--edge) 60%, transparent);
    stroke-width: 1;
  }
  .aw-axis {
    fill: var(--paper-faint);
    font-family: var(--cv-ui, var(--util));
    font-size: 9px;
    font-variant-numeric: tabular-nums;
  }
  .aw-hint {
    margin: 6px 0 0;
    font-family: var(--cv-ui, var(--util));
    font-size: 9.5px;
    line-height: 1.45;
    color: var(--paper-faint);
  }

  .aw-details {
    margin-top: -6px;
  }
  .aw-details summary {
    cursor: pointer;
    font-family: var(--cv-ui, var(--util));
    font-size: 11px;
    color: var(--paper-mute);
    padding: 3px 0;
  }
  .aw-details summary:hover {
    color: var(--paper);
  }
  .aw-hourwrap {
    max-height: 220px;
    overflow: auto;
    margin-top: 5px;
    border: 1px solid var(--cv-hair, var(--edge));
    border-radius: 8px;
  }
  .aw-hours {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--cv-ui, var(--util));
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .aw-hours th,
  .aw-hours td {
    padding: 4px 9px;
    text-align: left;
    border-bottom: 1px solid var(--cv-hair, var(--edge));
    white-space: nowrap;
  }
  .aw-hours thead th {
    position: sticky;
    top: 0;
    background: var(--raised);
    color: var(--paper-mute);
    font-weight: 500;
  }
  .aw-hours tbody th {
    font-weight: 400;
    color: var(--paper-dim);
  }
  .aw-hours .aw-num {
    text-align: right;
    color: var(--paper);
  }

  /* ── the scatter ───────────────────────────────────────────────────────── */

  .aw-scatter {
    margin: 0;
    padding: 10px 12px 8px;
    border: 1px solid var(--cv-hair, var(--edge));
    border-radius: 10px;
    background: color-mix(in oklab, var(--raised) 70%, transparent);
  }
  .aw-seg {
    display: inline-flex;
    padding: 2px;
    border-radius: 7px;
    background: color-mix(in oklab, var(--paper) 5%, transparent);
  }
  .aw-seg button {
    border: 0;
    background: transparent;
    color: var(--paper-dim);
    font: 10.5px var(--cv-ui, var(--util));
    padding: 2px 8px;
    border-radius: 5px;
    cursor: pointer;
  }
  .aw-seg button:hover {
    color: var(--paper);
  }
  .aw-seg button.on {
    background: color-mix(in oklab, var(--paper) 11%, transparent);
    color: var(--paper);
  }
  .aw-dot {
    cursor: pointer;
    outline: none;
    transition: r 120ms var(--ease-out, ease-out);
  }
  .aw-dot.on,
  .aw-dot:focus-visible {
    filter: brightness(1.25);
  }
  .aw-readout {
    margin: 4px 0 0;
    min-height: 16px;
    font-family: var(--cv-ui, var(--util));
    font-size: 10.5px;
    color: var(--paper-mute);
  }
  .aw-readout strong {
    color: var(--paper);
    font-weight: 500;
  }
  .aw-none {
    margin-left: 6px;
    padding: 0 5px;
    border: 1px solid var(--edge);
    border-radius: 999px;
    font-size: 9px;
    color: var(--paper-mute);
  }

  /* ── the picked card's own watches ────────────────────────────────────── */
  /* The one surface a watch is read on. Achromatic, like the rest of this tab:
     the colour a threshold earns is status, and status is the card's tier, not
     a number in a settings list. */
  .aw-watches {
    margin-top: 8px;
    padding: 8px 10px 9px;
    border: 1px solid color-mix(in oklab, var(--edge) 78%, var(--paper) 6%);
    border-radius: var(--cv-r-m, 9px);
    background: color-mix(in oklab, var(--raised) 92%, var(--paper) 3%);
    font-family: var(--cv-ui, var(--util));
    font-size: 10.5px;
    color: var(--paper-mute);
  }
  .aw-watchhead {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .aw-watchhead strong {
    color: var(--paper);
    font-weight: 600;
  }
  .aw-watchhead .aw-sub {
    font-size: 10px;
    color: var(--paper-faint);
  }
  .aw-watchclose {
    margin-left: auto;
    border: 0;
    background: none;
    color: var(--paper-faint);
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    padding: 0 2px;
  }
  .aw-watchclose:hover,
  .aw-watchclose:focus-visible {
    color: var(--paper);
  }
  .aw-watchlist {
    list-style: none;
    margin: 7px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .aw-watchlist li {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .aw-watchsaid {
    color: var(--paper);
    font-variant-numeric: tabular-nums;
  }
  .aw-watchwhen {
    font-size: 9.5px;
    color: var(--paper-faint);
  }
  .aw-watchdrop {
    margin-left: auto;
    padding: 1px 7px;
    border: 1px solid var(--edge);
    border-radius: 999px;
    background: none;
    color: var(--paper-mute);
    font-family: inherit;
    font-size: 9.5px;
    cursor: pointer;
  }
  .aw-watchdrop:hover,
  .aw-watchdrop:focus-visible {
    color: var(--paper);
    border-color: color-mix(in oklab, var(--edge) 60%, var(--paper) 30%);
  }
  .aw-watches code {
    font-family: var(--mono);
    font-size: 9.5px;
    color: var(--paper);
  }

  /* ── the table section ─────────────────────────────────────────────────── */

  .aw-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* ── the coordination strip ────────────────────────────────────────────── */

  .aw-stripnote {
    margin: 0;
    font-family: var(--cv-ui, var(--util));
    font-size: 10.5px;
    color: var(--paper-mute);
  }
  .aw-strip {
    display: grid;
    grid-template-columns: 172px minmax(0, 1fr);
    gap: 8px;
    position: relative;
    padding-bottom: 26px;
  }
  .aw-striplabels {
    display: flex;
    flex-direction: column;
  }
  .aw-rowlabel {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding-right: 4px;
    min-width: 0;
  }
  .aw-rowname {
    font-family: var(--cv-ui, var(--util));
    font-size: 10.5px;
    color: var(--paper-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .aw-rowcost {
    font-family: var(--cv-ui, var(--util));
    font-size: 9.5px;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .aw-track {
    position: relative;
    border-left: 1px solid var(--cv-hair, var(--edge));
  }
  .aw-row {
    position: absolute;
    left: 0;
    right: 0;
  }
  .aw-bar {
    position: absolute;
    top: 10px;
    height: 8px;
    border-radius: 2px;
    background: color-mix(in oklab, var(--paper) 28%, transparent);
  }
  /* The re-reads row: an instruction is a square, a rule a diamond, and a run
     of more than one write is the bigger mark. Colour comes from the status
     palette and says *kind*, never decoration. */
  .aw-inv {
    position: absolute;
    top: 9px;
    border: 0;
    padding: 0;
    border-radius: 2px;
    background: var(--st-ask);
    opacity: 0.72;
    cursor: pointer;
  }
  .aw-inv.rule {
    background: var(--st-soft);
    border-radius: 1px;
    transform: rotate(45deg);
  }
  .aw-inv.churn {
    opacity: 0.95;
  }
  .aw-inv:hover,
  .aw-inv:focus-visible {
    opacity: 1;
    outline: 1px solid var(--paper);
    outline-offset: 1px;
  }
  .aw-band {
    position: absolute;
    border-left: 1px solid color-mix(in oklab, var(--paper-mute) 70%, transparent);
    border-right: 1px solid color-mix(in oklab, var(--paper-mute) 70%, transparent);
    background: color-mix(in oklab, var(--paper) 7%, transparent);
    border-radius: 1px;
  }
  .aw-conflict {
    position: absolute;
    top: 7px;
    height: 14px;
    min-width: 3px;
    border: 0;
    padding: 0;
    border-radius: 3px;
    background: var(--st-fail);
    opacity: 0.72;
    cursor: pointer;
  }
  .aw-conflict:hover,
  .aw-conflict:focus-visible {
    opacity: 1;
    outline: 1px solid var(--paper);
    outline-offset: 1px;
  }
  .aw-tick {
    position: absolute;
    top: 0;
    bottom: 14px;
    width: 1px;
    background: color-mix(in oklab, var(--edge) 55%, transparent);
  }
  .aw-ticktext {
    position: absolute;
    bottom: -16px;
    transform: translateX(-50%);
    font-family: var(--cv-ui, var(--util));
    font-size: 9px;
    color: var(--paper-faint);
    white-space: nowrap;
  }
  .aw-ticktext.end {
    transform: translateX(-100%);
  }
  .aw-pairtables {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 10px;
    margin-top: 6px;
  }
  .aw-pairtables table {
    border: 1px solid var(--cv-hair, var(--edge));
    border-radius: 8px;
    overflow: hidden;
  }
  .aw-episode {
    margin-top: 6px;
    padding: 9px 11px;
    border: 1px solid var(--cv-hair, var(--edge));
    border-left: 2px solid var(--st-fail);
    border-radius: 8px;
    background: color-mix(in oklab, var(--raised) 80%, transparent);
  }
  .aw-ephead {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--cv-ui, var(--util));
    font-size: 11.5px;
  }
  .aw-ephead strong {
    color: var(--paper);
    font-weight: 600;
  }
  .aw-ephead span {
    color: var(--paper-mute);
  }
  .aw-epclose {
    margin-left: auto;
    border: 0;
    background: transparent;
    color: var(--paper-mute);
    font-size: 15px;
    line-height: 1;
    padding: 0 3px;
    cursor: pointer;
  }
  .aw-epclose:hover {
    color: var(--paper);
  }
  .aw-epfacts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 18px;
    margin: 6px 0 0;
  }
  .aw-epfacts div {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .aw-epfacts dt {
    font-family: var(--cv-ui, var(--util));
    font-size: 9px;
    letter-spacing: 0.04em;
    text-transform: lowercase;
    color: var(--paper-faint);
  }
  .aw-epfacts dd {
    margin: 0;
    font-family: var(--cv-ui, var(--util));
    font-size: 11px;
    color: var(--paper);
    font-variant-numeric: tabular-nums;
  }

  .aw-caveat {
    margin: 2px 0 0;
    max-width: 80ch;
    font-family: var(--body);
    font-size: 11.5px;
    font-style: italic;
    line-height: 1.5;
    color: var(--paper-mute);
  }

  /* The room is the wall's instrument, so its six tiles stack on a narrow
     window rather than shrinking the figures past reading. */
  @media (max-width: 1080px) {
    .aw-kpis {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
  /* Five columns beside three need the room; below it they stack rather than
     squeezing the episode headings into each other. */
  @media (max-width: 1180px) {
    .aw-pairtables {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @media (max-width: 860px) {
    .aw-pair {
      grid-template-columns: minmax(0, 1fr);
    }
    .aw-strip {
      grid-template-columns: 132px minmax(0, 1fr);
    }
  }
</style>
