<script lang="ts">
  /* The models tab: what the wall can spawn, measured, and what it costs.
   *
   * It is drawn inside the accounts panel because that is where a provider is
   * decided, and it is one dataset read three ways — the **frontier** first,
   * because the choice is a balance rather than a winner; the ranked table
   * second; the catalogue third, one benchmark at a time.
   *
   * Everything numeric here comes from `benchmarks.rs` (the ranking, the
   * efficiency, the coverage). What this file decides is the drawing, and the
   * one rule it must not break: **a ranking is a view.** A dominated entry is
   * shown dimmed and named with what beat it rather than hidden, every row
   * opens to its components with their sources and dates, and an entry with no
   * reading says so instead of scoring zero.
   */
  import { onMount } from "svelte";
  import {
    PROFILES,
    effortLabel,
    frontierSaid,
    missingNames,
    reportedNote,
    sayAsOf,
    sayProvenance,
    sayPrice,
    scored,
    sourceLabel,
    tierLabel,
    tiers,
    type Entry,
    type Profile,
  } from "./benchmarks";
  import { standings } from "./standings.svelte";

  type Pane = "frontier" | "ranked" | "catalogue";

  /** How many ranked entries the panel draws. It is a glance beside the
   *  accounts, not a catalogue to scroll: 666 rows inside a dialog is a scroll
   *  container 35,000px tall, and the tail of a ranking is not what anybody
   *  opens it for. The tool takes a `limit` for the rest. */
  const SHOWN = 20;

  let pane = $state<Pane>("frontier");
  let open = $state<string | null>(null);
  let benchmark = $state<string | null>(null);

  onMount(() => {
    void standings.load();
  });

  const rows = $derived(standings.rows);
  const profile = $derived(standings.profile);
  const asOfLine = $derived(sayAsOf(standings.sources));

  /** The curve. Price is compressed logarithmically — a frontier that puts a
   *  $0.20 model and a $30 one on a linear axis is four points in the left
   *  margin — and quality keeps its own scale, because that is the axis the
   *  decision is read against. */
  /** The tier the curve is drawn from: the best-covered one that has a price.
   *  `benchmarks.rs` decides which that is, and only its entries are efficient. */
  const frontierTier = $derived(standings.view?.frontierTier ?? 0);

  /** Entries left off the curve because they were measured on fewer members.
   *  Counted so the sentence under the chart can say they exist rather than
   *  leaving a reader to wonder where a model went. */
  const thinner = $derived(
    rows.filter((r) => r.quality !== null && r.price !== null && r.present < frontierTier).length,
  );

  const chart = $derived.by(() => {
    const placed = rows.filter(
      (r) => r.quality !== null && r.price !== null && r.price > 0 && r.present === frontierTier,
    );
    if (placed.length === 0) return null;
    const W = 340;
    const H = 190;
    const pad = { l: 34, r: 10, t: 10, b: 24 };
    const prices = placed.map((r) => Math.log10(r.price!));
    const qs = placed.map((r) => r.quality!);
    const minP = Math.min(...prices);
    const maxP = Math.max(...prices);
    const minQ = Math.max(0, Math.min(...qs) - 5);
    const maxQ = Math.min(100, Math.max(...qs) + 5);
    const x = (p: number) => {
      const t = maxP === minP ? 0.5 : (Math.log10(p) - minP) / (maxP - minP);
      return pad.l + t * (W - pad.l - pad.r);
    };
    const y = (q: number) => {
      const t = maxQ === minQ ? 0.5 : (q - minQ) / (maxQ - minQ);
      return H - pad.b - t * (H - pad.t - pad.b);
    };
    const points = placed.map((r) => ({ row: r, x: x(r.price!), y: y(r.quality!) }));
    const frontier = points
      .filter((p) => p.row.efficient)
      .sort((a, b) => a.x - b.x)
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(" ");
    return { W, H, pad, points, frontier, minP, maxP, minQ, maxQ, x, y };
  });

  /** Which benchmark the catalogue is showing. With nothing picked it opens on
   *  the one with the most readings rather than on whichever name sorts first —
   *  a tab that opens on "1 readings" reads as a broken panel rather than as a
   *  benchmark only one model was run on. */
  const active = $derived.by(() => {
    const cat = standings.catalogue;
    if (!cat) return null;
    if (benchmark) return benchmark;
    const counts = new Map<string, number>();
    for (const r of cat.readings) {
      if (r.score !== null) counts.set(r.benchmark, (counts.get(r.benchmark) ?? 0) + 1);
    }
    let best: string | null = null;
    let most = -1;
    for (const [key, n] of counts) {
      if (n > most) {
        best = key;
        most = n;
      }
    }
    return best;
  });

  const catalogueRows = $derived.by(() => {
    const cat = standings.catalogue;
    if (!cat) return [];
    const wanted = active;
    return cat.readings
      .filter((r) => r.benchmark === wanted && r.score !== null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 60)
      .map((r) => ({ ...r, name: cat.models.find((m) => m.key === r.model)?.name ?? r.model }));
  });

  function choose(id: string) {
    open = null;
    void standings.load(id);
  }

  function onCatalogue() {
    pane = "catalogue";
    if (!standings.catalogue) void standings.readCatalogue(benchmark);
  }

  function pickBenchmark(e: Event) {
    benchmark = (e.currentTarget as HTMLSelectElement).value || null;
    void standings.readCatalogue(benchmark);
  }

  /** A row's second line: what it is, and what it is not. */
  function under(r: Entry): string {
    const bits: string[] = [];
    if (r.creator) bits.push(r.creator);
    bits.push(effortLabel(r.effort));
    if (r.contextWindow) bits.push(`${Math.round(r.contextWindow / 1000)}k context`);
    if (r.components.some((c) => c.score !== null)) {
      bits.push(`${Math.round(r.coverage * 100)}% of the profile`);
    }
    /* Whose numbers the score is made of. A row that is half the developer's own
       reports must not read like one that is all measured. */
    const reported = reportedNote(r);
    if (reported) bits.push(reported);
    if (r.evidence) bits.push(`${r.evidence} evidence`);
    return bits.join(" · ");
  }

  function dominatedLine(key: string): string | null {
    const d = standings.view?.dominated?.find((x) => x.key === key);
    return d ? `beaten by ${d.by}` : null;
  }
</script>

<div class="models">
  <div class="rail" role="tablist" aria-label="workflow">
    {#each PROFILES as p (p.id)}
      <button
        type="button"
        role="tab"
        aria-selected={p.id === profile.id}
        class:on={p.id === profile.id}
        onclick={() => choose(p.id)}
      >{p.label}</button>
    {/each}
  </div>

  <div class="views">
    <button type="button" class:on={pane === "frontier"} onclick={() => (pane = "frontier")}>frontier</button>
    <button type="button" class:on={pane === "ranked"} onclick={() => (pane = "ranked")}>ranked</button>
    <button type="button" class:on={pane === "catalogue"} onclick={onCatalogue}>catalogue</button>
    <span class="grow"></span>
    <button type="button" class="refresh" disabled={standings.refreshing} onclick={() => void standings.refresh()}>
      {standings.refreshing ? "reading…" : "refresh"}
    </button>
  </div>

  <p class="note">{profile.note}</p>

  {#if standings.error}
    <p class="fault">{standings.error}</p>
  {/if}

  {#if pane === "frontier"}
    {#if chart}
      <p class="said">{frontierSaid(chart?.points.map((p) => p.row) ?? [])}</p>
      <svg class="curve" viewBox={`0 0 ${chart.W} ${chart.H}`} role="img" aria-label="quality against price">
        <line class="axis" x1={chart.pad.l} y1={chart.H - chart.pad.b} x2={chart.W - chart.pad.r} y2={chart.H - chart.pad.b} />
        <line class="axis" x1={chart.pad.l} y1={chart.pad.t} x2={chart.pad.l} y2={chart.H - chart.pad.b} />
        <text class="tick" x={chart.pad.l - 4} y={chart.pad.t + 8} text-anchor="end">{chart.maxQ.toFixed(0)}</text>
        <text class="tick" x={chart.pad.l - 4} y={chart.H - chart.pad.b} text-anchor="end">{chart.minQ.toFixed(0)}</text>
        <text class="tick" x={chart.pad.l} y={chart.H - 8}>{`$${Math.pow(10, chart.minP).toFixed(2)}`}</text>
        <text class="tick" x={chart.W - chart.pad.r} y={chart.H - 8} text-anchor="end">{`$${Math.pow(10, chart.maxP).toFixed(2)}`}</text>
        <text class="tick" x={chart.W / 2} y={chart.H - 8} text-anchor="middle">price per 1M blended 3:1 →</text>
        {#if chart.frontier}
          <polyline class="front" points={chart.frontier} />
        {/if}
        {#each chart.points as p (p.row.key)}
          <circle
            class="dot"
            class:on={p.row.efficient}
            cx={p.x}
            cy={p.y}
            r={p.row.efficient ? 4 : 3}
          >
            <title>{`${p.row.name} · ${p.row.quality?.toFixed(1)} · ${sayPrice(p.row.price, p.row.priceBasis)}${p.row.efficient ? "" : " · dominated"}`}</title>
          </circle>
        {/each}
      </svg>
      <p class="foot">
        the line joins the efficient entries, and every dim point is still in the ranked table
        with what beat it. all of these were scored over {frontierTier} of
        {standings.view?.memberCount ?? 0} members — one tier, one comparison.
        {#if thinner > 0}
          {thinner} more {thinner === 1 ? "entry has" : "entries have"} a thinner reading and
          {thinner === 1 ? "is" : "are"} in the table under their own heading, not on this curve.
        {/if}
      </p>
    {:else}
      <p class="empty">{standings.loading ? "asking the sources…" : "no entry has both a score and a price, so there is no curve to draw."}</p>
    {/if}
  {:else if pane === "ranked"}
    {#if rows.length === 0}
      <p class="empty">{standings.loading ? "asking the sources…" : "nothing has been read yet."}</p>
    {:else}
      <p class="said">
        {scored(rows)} entries have a score on {profile.label}. they are ranked inside a
        coverage tier and never across one: an entry measured on four members and one measured
        on two answered different questions, and the numbers are not comparable.
      </p>
      {#each tiers(rows).scored as t (t.present)}
        <h4 class="tier">{tierLabel(t)}</h4>
        <ol class="ranked">
          {#each t.rows.slice(0, SHOWN) as r (r.key)}
            {@const beaten = dominatedLine(r.key)}
            <li class:dim={!r.efficient} class:open={open === r.key}>
              <button
                type="button"
                class="entry"
                aria-expanded={open === r.key}
                onclick={() => (open = open === r.key ? null : r.key)}
              >
                <span class="rank">{r.rank ?? "—"}</span>
                <span class="who">
                  <span class="name">{r.name}{#if r.efficient}<span class="mark" title="on the frontier">●</span>{/if}</span>
                  <small>{under(r)}</small>
                </span>
                <span class="q">{r.quality === null ? "no score" : r.quality.toFixed(1)}</span>
                <span class="p">{sayPrice(r.price, r.priceBasis)}</span>
              </button>
              {#if beaten}
                <p class="beaten">{beaten}</p>
              {/if}
              {#if open === r.key}
                <div class="parts">
                  {#each r.components as c (c.benchmark)}
                    <span class="part">
                      <b>{c.name}</b>
                      <span class="weight">{Math.round(c.weight * 100)}%</span>
                      <span class="score">{c.score === null ? "no reading" : `${c.score.toFixed(1)} ${c.unit}`}</span>
                      {#if c.source}
                        <span class="from" class:reported={c.vendor}>
                          {sourceLabel(c.source)} · {sayProvenance(c)}{c.published ? ` · ${c.published.slice(0, 10)}` : ""}
                        </span>
                      {/if}
                    </span>
                  {/each}
                  {#if r.missing.length > 0}
                    <p class="miss">no reading for {missingNames(r).join(", ")} — those members are not in the score</p>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ol>
      {/each}
      {#if tiers(rows).unscored.length > 0}
        <h4 class="tier">not enough readings to score</h4>
        <ul class="ranked thin">
          {#each tiers(rows).unscored.slice(0, SHOWN) as r (r.key)}
            <li>
              <div class="entry">
                <span class="rank">—</span>
                <span class="who">
                  <span class="name">{r.name}</span>
                  <small>
                    {r.present} of {r.members} members — missing {missingNames(r).join(", ")}{#if r.reported > 0}; the present
                    {r.reported === 1 ? "one is" : "ones are"} provider-reported{/if}{#if r.evidence}; {r.evidence} evidence{/if}
                  </small>
                </span>
                <span class="q">no score</span>
                <span class="p">{sayPrice(r.price, r.priceBasis)}</span>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  {:else}
    <div class="catbar">
      <select onchange={pickBenchmark} aria-label="benchmark">
        {#each standings.catalogue?.benchmarks ?? [] as b (b.key)}
          <option value={b.key} selected={b.key === active}>{b.name} · {b.category}</option>
        {/each}
      </select>
      <span class="grow"></span>
      <span class="tick">{catalogueRows.length} readings</span>
    </div>
    <table class="cat">
      <tbody>
        {#each catalogueRows as r (r.model)}
          <tr>
            <td class="n">{r.name}</td>
            <td class="v">{r.score?.toFixed(1)}</td>
            <td class="u">{r.unit}</td>
            <td class="s">{sourceLabel(r.source)}</td>
            <td class="d">{r.published ? r.published.slice(0, 10) : "—"}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <div class="sources">
    <p class="asof">{asOfLine}</p>
    {#each standings.sources as s (s.id)}
      <p class="src" class:bad={s.status === "failed"}>
        <b>{s.label}</b>
        {#if !s.on}
          off — {s.said ?? "no key"}
        {:else if s.status === "failed"}
          could not be read — {s.said ?? "no reason given"}
        {:else if s.status === "never"}
          not read yet
        {:else}
          {s.rows} readings{s.at ? ` · read ${s.at.slice(0, 10)}` : ""} · {s.attribution}
        {/if}
      </p>
    {/each}
    <p class="foot">
      a profile is one view of the readings rather than a truth about them. a model a source did
      not measure says so; it did not score zero.
    </p>
  </div>
</div>

<style>
  .models {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-height: 0;
    overflow-y: auto;
  }
  .rail,
  .views {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
  }
  .rail button,
  .views button {
    border: 1px solid var(--edge);
    background: transparent;
    color: var(--paper-mute);
    padding: 0.12rem 0.45rem;
    border-radius: 3px;
    font: inherit;
    font-size: 0.86em;
    cursor: pointer;
  }
  .rail button.on,
  .views button.on {
    color: var(--paper);
    border-color: var(--paper);
  }
  .views {
    border-top: 1px solid var(--edge);
    padding-top: 0.45rem;
  }
  .views .refresh {
    color: var(--paper-mute);
  }
  .grow {
    flex: 1;
  }
  .note,
  .said,
  .foot,
  .empty,
  .miss,
  .beaten,
  .asof,
  .src {
    margin: 0;
    color: var(--paper-mute);
    font-size: 0.88em;
  }
  .said {
    color: var(--paper);
  }
  .fault {
    margin: 0;
    color: var(--st-fail);
    font-size: 0.88em;
  }
  .curve {
    width: 100%;
    max-width: 34rem;
    align-self: center;
  }
  .axis {
    stroke: var(--edge);
    stroke-width: 1;
  }
  .tick {
    fill: var(--paper-faint);
    font-size: 8px;
  }
  .front {
    fill: none;
    stroke: var(--paper-dim);
    stroke-width: 1.2;
    opacity: 0.8;
  }
  .dot {
    fill: var(--paper-faint);
    opacity: 0.45;
  }
  .dot.on {
    fill: var(--paper);
    opacity: 1;
  }
  .tier {
    margin: 0.55rem 0 0.1rem;
    font-size: 0.78em;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--paper-mute);
    border-bottom: 1px solid var(--edge);
    padding-bottom: 0.12rem;
  }
  .thin .entry {
    cursor: default;
  }
  .ranked {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .entry {
    display: grid;
    grid-template-columns: 1.6rem 1fr auto auto;
    gap: 0.5rem;
    align-items: baseline;
    width: 100%;
    text-align: left;
    border: none;
    background: transparent;
    color: var(--paper);
    font: inherit;
    padding: 0.22rem 0.1rem;
    border-radius: 3px;
    cursor: pointer;
  }
  .entry:hover,
  .entry:focus-visible {
    background: color-mix(in srgb, var(--paper) 7%, transparent);
  }
  .dim .entry {
    color: var(--paper-mute);
  }
  .name {
    font-size: 0.94em;
  }
  .mark {
    color: var(--st-work);
    margin-left: 0.35rem;
    font-size: 0.7em;
  }
  .who small {
    display: block;
    color: var(--paper-mute);
    font-size: 0.82em;
  }
  .q {
    font-variant-numeric: tabular-nums;
    min-width: 3.2rem;
    text-align: right;
  }
  .p {
    font-variant-numeric: tabular-nums;
    color: var(--paper-mute);
    font-size: 0.86em;
    min-width: 9rem;
    text-align: right;
  }
  .beaten {
    margin: 0 0 0.25rem 2.1rem;
    font-style: italic;
  }
  .parts {
    margin: 0.1rem 0 0.5rem 2.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.12rem;
    border-left: 1px solid var(--edge);
    padding-left: 0.6rem;
  }
  .part {
    display: grid;
    grid-template-columns: 1fr 3rem 8.5rem 9rem;
    gap: 0.4rem;
    font-size: 0.84em;
  }
  .part b {
    font-weight: 500;
  }
  .weight,
  .from {
    color: var(--paper-mute);
  }
  /* The developer's own numbers, marked in the ramp rather than in a status
     colour: it is a qualifier on a reading, not a fault. */
  .from.reported {
    color: var(--paper-dim);
    font-style: italic;
  }
  .score {
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
  }
  .catbar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .catbar select {
    background: var(--surface);
    color: var(--paper);
    border: 1px solid var(--edge);
    border-radius: 3px;
    font: inherit;
    font-size: 0.86em;
    padding: 0.12rem 0.3rem;
    max-width: 70%;
  }
  .cat {
    border-collapse: collapse;
    font-size: 0.86em;
    width: 100%;
  }
  .cat td {
    padding: 0.14rem 0.3rem;
    border-bottom: 1px solid color-mix(in srgb, var(--edge) 55%, transparent);
  }
  .cat .v {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .cat .u,
  .cat .s,
  .cat .d {
    color: var(--paper-mute);
    white-space: nowrap;
  }
  .sources {
    border-top: 1px solid var(--edge);
    padding-top: 0.4rem;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .src.bad {
    color: var(--st-fail);
  }
</style>
