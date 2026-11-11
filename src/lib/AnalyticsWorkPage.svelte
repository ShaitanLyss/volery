<script lang="ts">
  /* The work tab as a document: the second presentation of the same reading
   * (§11.15).
   *
   * A lede generated from the numbers by a template table (`workStoryOf`, never
   * a model), the scatter when there is a picture to draw, the table, and the
   * caveat in full. The room and this page are handed one `model` built once,
   * so the prose cannot disagree with the figure above it or with the room's
   * strip (§11.14).
   *
   * Different skin, same values: fewer marks, no strip, and the caveat said out
   * loud rather than as a footnote.
   */
  import AnalyticsWorkTable from "./AnalyticsWorkTable.svelte";
  import { niceAxis } from "./analyticsroom";
  import { seriesColor } from "./analytics";
  import { episodeLabel, scatterTicks, signed, type ScatterMeasure, type WorkModel } from "./analyticswork";
  import { count, money } from "./usage";

  let {
    model,
    from,
    to,
    spanSaid,
    measure,
  }: {
    model: WorkModel;
    from: number;
    to: number;
    spanSaid: string;
    measure: ScatterMeasure;
  } = $props();

  const INK = seriesColor(0);
  const width = $derived(Math.max(1, to - from));

  let scroller = $state<HTMLElement>();
  let scatterW = $state(640);

  function sized(el: HTMLElement) {
    scatterW = el.clientWidth;
    const ro = new ResizeObserver(() => (scatterW = el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }

  const PAD = { l: 44, t: 12, b: 28, r: 14 };

  const scatter = $derived.by(() => {
    const pts = model.scatter.points;
    const plotW = Math.max(20, scatterW - PAD.l - PAD.r);
    const plotH = 250;
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
    const xOf = (v: number) => PAD.l + (v / xAxis.top) * plotW;
    const yOf = (v: number) => PAD.t + plotH - ((v - lo) / (hi - lo)) * plotH;
    return {
      plotW,
      plotH,
      /* `py` keeps the measure apart from the pixel it is drawn at. */
      dots: pts.map((p) => ({ ...p, x: xOf(p.cost), py: yOf(p.y) })),
      xTicks: xAxis.ticks.map((v) => ({ v, x: xOf(v), text: money(v) })),
      yTicks: scatterTicks(lo, hi, measure).map((v) => ({
        v,
        y: yOf(v),
        text: measure === "net" ? signed(v) : count(v),
      })),
    };
  });

  const oneFigure = $derived.by(() => {
    const placed = model.scatter.points;
    if (placed.length === 1) return placed[0];
    const costly = model.cards.filter((c) => c.cost !== null);
    if (costly.length === 1) {
      return {
        card: costly[0].card,
        label: costly[0].label,
        cost: costly[0].cost ?? 0,
        y: measure === "net" ? costly[0].net : costly[0].merged,
        noArtifact: costly[0].noArtifact,
        project: costly[0].project,
      };
    }
    return null;
  });

  function tickText(at: number): string {
    const d = new Date(at);
    if (width > 3 * 86_400_000) return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  /* ── the keys the shell delegates ──────────────────────────────────────── */

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
</script>

<div class="awk-stage">
  <div class="awk-ground" aria-hidden="true"></div>
  <div class="awk-veil" aria-hidden="true"></div>
  <div class="awk-scroll" bind:this={scroller}>
    <article class="awk-sheet">
      <p class="awk-kicker">
        <span>work</span>
        <span class="awk-sep">·</span>
        <span>{spanSaid}</span>
        <span class="awk-sep">·</span>
        <span>{measure === "net" ? "against net lines" : "against merges"}</span>
      </p>

      <h3 class="awk-lede">{model.story.lede}</h3>
      <div class="awk-rule" aria-hidden="true"></div>

      {#if model.scatter.points.length >= 2}
        <figure class="awk-figure">
          <div class="awk-plate" {@attach sized}>
            <svg width={scatterW} height="290" role="img" aria-label={`cost against ${measure === "net" ? "net lines" : "merges"}`}>
              {#each scatter.yTicks as t (t.v)}
                <line class="awk-grid" x1={PAD.l} x2={PAD.l + scatter.plotW} y1={t.y} y2={t.y} />
                <text class="awk-axis" x={PAD.l - 7} y={t.y + 3.5} text-anchor="end">{t.text}</text>
              {/each}
              {#each scatter.xTicks as t (t.v)}
                <line class="awk-grid" x1={t.x} x2={t.x} y1={PAD.t} y2={PAD.t + scatter.plotH} />
                <text class="awk-axis" x={t.x} y={PAD.t + scatter.plotH + 17} text-anchor="middle">{t.text}</text>
              {/each}
              {#each scatter.dots as d (d.card)}
                <circle
                  cx={d.x}
                  cy={d.py}
                  r={d.noArtifact ? 4 : 4.4}
                  fill={d.noArtifact ? "none" : INK}
                  stroke={INK}
                  stroke-width={d.noArtifact ? 1.5 : 0}
                  opacity="0.9"
                ><title>{`${d.label}: ${money(d.cost)}, ${measure === "net" ? `${signed(d.y)} net lines` : `${count(d.y)} merged`}`}</title></circle>
              {/each}
              <text class="awk-axis" x={PAD.l} y={PAD.t + scatter.plotH + 30} text-anchor="start">cost</text>
              <text class="awk-axis" x={PAD.l} y={PAD.t - 2} text-anchor="start">{measure === "net" ? "net lines" : "merged"}</text>
            </svg>
          </div>
          <figcaption class="awk-cap">
            one dot per card, dollars across and {measure === "net" ? "net lines" : "merges"} up. a hollow dot is a card with no artifact.
            {#if model.scatter.omitted > 0}
              {count(model.scatter.omitted)} {model.scatter.omitted === 1 ? "card has" : "cards have"} no spend attributed and {model.scatter.omitted === 1 ? "is" : "are"} not drawn.
            {/if}
          </figcaption>
        </figure>
      {:else}
        <div class="awk-one">
          {#if oneFigure}
            <span class="awk-onenum">{money(oneFigure.cost)}</span>
            <span class="awk-onelabel">
              {oneFigure.label} · {measure === "net" ? `${signed(oneFigure.y)} net lines` : `${count(oneFigure.y)} merged`}
              {#if oneFigure.noArtifact}<span class="awk-none">no artifact</span>{/if}
            </span>
          {:else}
            <span class="awk-onenum">{count(model.cards.reduce((n, c) => n + c.artifacts, 0))}</span>
            <span class="awk-onelabel">artifacts in this window</span>
          {/if}
          <span class="awk-onecap">
            {#if model.scatter.points.length === 0}
              no card has both a cost and an artifact to place, so the picture is a number rather than a scatter.
            {:else}
              one point is a reading, not a trend; the table below is the same figure in its honest form.
            {/if}
          </span>
        </div>
      {/if}

      {#each model.story.sections as sec (sec.id)}
        {#if sec.id !== "cannot"}
          <section class="awk-sec">
            <h4>{sec.title}</h4>
            <p>{sec.body}</p>
          </section>
        {/if}
      {/each}

      <section class="awk-sec awk-table-sec">
        <h4>per card</h4>
        <AnalyticsWorkTable cards={model.cards} compact />
        <p class="awk-hint">a dash is a ratio with no divisor, never a zero.</p>
      </section>

      {#if model.invalidations.episodesCount > 0 || model.invalidationsUnread}
        <section class="awk-sec awk-table-sec">
          <h4>re-reads, by tree and episode</h4>
          <table class="awk-table">
            <thead>
              <tr>
                <th scope="col">tree</th>
                <th scope="col">path</th>
                <th scope="col">time</th>
                <th scope="col">run</th>
                <th scope="col" class="awk-num">cards paid</th>
                <th scope="col" class="awk-num">cost</th>
              </tr>
            </thead>
            <tbody>
              {#each model.invalidations.episodes as e (`${e.key}`)}
                <tr>
                  <th scope="row">{e.tree || "no tree"}</th>
                  <td>{episodeLabel(e)}</td>
                  <td>{new Date(e.end).toLocaleString("en-GB")}</td>
                  <td>{e.writes > 1 ? `churn, ${count(e.writes)} writes` : "one write"}</td>
                  <td class="awk-num">{e.measured ? count(e.payers.length) : "—"}</td>
                  <td class="awk-num">{e.measured ? money(e.usd ?? 0) : "unmeasured"}</td>
                </tr>
              {:else}
                <tr><td colspan="6">{model.invalidationsUnread ? "the invalidation reading did not answer for this span." : "nothing was recorded: no instruction file was written in this window."}</td></tr>
              {/each}
            </tbody>
          </table>
          <p class="awk-hint">
            unmeasured is not zero: no paying card took a request within thirty minutes of the last write, so there is no excess to divide.
          </p>
        </section>
      {/if}

      <section class="awk-sec">
        <h4>what this cannot see</h4>
        <p>{model.caveat}</p>
      </section>

      <p class="awk-clock">
        {count(model.cards.length)} {model.cards.length === 1 ? "card" : "cards"} ·
        {count(model.episodes.length)} conflict {model.episodes.length === 1 ? "episode" : "episodes"} ·
        from {tickText(from)}
      </p>
    </article>
  </div>
</div>

<style>
  .awk-stage {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }
  .awk-ground {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
      radial-gradient(120% 80% at 18% -10%, var(--cv-lamp, transparent) 0%, transparent 60%),
      var(--cv-ground, var(--well));
  }
  .awk-ground::after {
    content: "";
    position: absolute;
    inset: 0;
    background-image: var(--cv-grain, none);
    opacity: 0.5;
    mix-blend-mode: soft-light;
  }
  .awk-scroll {
    position: absolute;
    inset: 0;
    overflow: auto;
    scrollbar-width: thin;
  }
  .awk-sheet {
    max-width: 64rem;
    margin: 0 auto;
    padding: 34px 40px 78px;
    color: var(--paper-dim);
    font-family: var(--body);
  }

  /* The same soft diagonal wipe the spend page arrives on, for the same reason:
     it ends, so it answers reduced motion without asking the wall's `still`. */
  .awk-veil {
    position: absolute;
    inset: -25%;
    z-index: 2;
    pointer-events: none;
    background: linear-gradient(128deg, transparent 0%, transparent 40%, var(--cv-ground, var(--well)) 62%, var(--cv-ground, var(--well)) 100%);
    animation: awk-wipe 1.9s var(--ease-out, ease-out) both;
  }
  @keyframes awk-wipe {
    from {
      transform: translate3d(0, 0, 0);
    }
    to {
      transform: translate3d(85%, 85%, 0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .awk-veil {
      display: none;
    }
  }

  .awk-kicker {
    margin: 0 0 14px;
    font-family: var(--cv-ui, var(--util));
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: lowercase;
    color: var(--cv-note, var(--paper-mute));
  }
  .awk-sep {
    margin: 0 0.5em;
    opacity: 0.5;
  }
  .awk-lede {
    margin: 0;
    max-width: 44rem;
    font-family: var(--body);
    font-size: clamp(21px, 2.5vw, 29px);
    font-weight: 400;
    line-height: 1.35;
    letter-spacing: -0.005em;
    color: var(--paper);
    text-wrap: pretty;
  }
  .awk-rule {
    width: 84px;
    height: 2px;
    margin: 18px 0 4px;
    background: var(--paper-mute);
    transform-origin: left center;
    animation: awk-draw 950ms var(--ease-out, ease-out) 1.15s both;
  }
  @keyframes awk-draw {
    from {
      transform: scaleX(0);
    }
    to {
      transform: scaleX(1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .awk-rule {
      animation: none;
    }
  }

  .awk-figure {
    margin: 26px 0 6px;
  }
  .awk-plate {
    position: relative;
    width: 100%;
    height: 290px;
  }
  .awk-plate svg {
    display: block;
    overflow: visible;
  }
  .awk-grid {
    stroke: color-mix(in oklab, var(--edge) 66%, transparent);
    stroke-width: 1;
  }
  .awk-axis {
    fill: var(--cv-note, var(--paper-mute));
    font-family: var(--cv-ui, var(--util));
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }
  .awk-cap {
    margin: 10px 0 0;
    max-width: 44rem;
    font-family: var(--body);
    font-style: italic;
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--paper-mute);
  }

  .awk-one {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 30px 0 8px;
    padding: 4px 0 4px 18px;
    border-left: 2px solid var(--paper-mute);
  }
  .awk-onenum {
    font-family: var(--cv-ui, var(--util));
    font-size: clamp(34px, 5vw, 52px);
    line-height: 1.05;
    color: var(--paper);
    font-variant-numeric: tabular-nums;
  }
  .awk-onelabel {
    font-family: var(--cv-ui, var(--util));
    font-size: 12px;
    color: var(--paper-dim);
  }
  .awk-onecap {
    margin-top: 6px;
    max-width: 40rem;
    font-family: var(--body);
    font-style: italic;
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--paper-mute);
  }
  .awk-none {
    margin-left: 7px;
    padding: 1px 5px;
    border: 1px solid var(--edge);
    border-radius: 999px;
    font-style: normal;
    font-size: 9.5px;
    color: var(--paper-mute);
  }

  .awk-sec {
    max-width: 44rem;
    margin: 34px 0 0;
  }
  .awk-sec h4 {
    margin: 0 0 8px;
    font-family: var(--cv-ui, var(--util));
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0.07em;
    text-transform: lowercase;
    color: var(--paper-mute);
  }
  .awk-sec p {
    margin: 0;
    font-family: var(--body);
    font-size: 15px;
    line-height: 1.66;
    color: var(--paper-dim);
    text-wrap: pretty;
  }
  .awk-table-sec {
    max-width: 64rem;
  }
  .awk-hint {
    margin: 8px 0 0;
    font-family: var(--body);
    font-style: italic;
    font-size: 12px;
    color: var(--paper-mute);
  }
  .awk-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--cv-ui, var(--util));
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }
  .awk-table th,
  .awk-table td {
    padding: 5px 8px;
    border-bottom: 1px solid color-mix(in oklab, var(--edge) 60%, transparent);
    text-align: left;
    vertical-align: top;
  }
  .awk-table thead th {
    font-weight: 500;
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: lowercase;
    color: var(--paper-mute);
  }
  .awk-table tbody th {
    font-weight: 400;
    color: var(--paper-dim);
  }
  .awk-table .awk-num {
    text-align: right;
  }
  .awk-clock {
    margin: 34px 0 0;
    font-family: var(--cv-ui, var(--util));
    font-size: 10.5px;
    color: var(--paper-faint);
  }
</style>
