<script lang="ts">
  /* The analytics page: the document presentation (§11.8), the other drawing of
   * the surface's question, under `Analytics.svelte`'s shell.
   *
   * Editorial rather than instrumental: a hero sentence generated from the
   * numbers (`analyticpage.ts::storyOf`, never a model), one large annotated
   * figure over the same series the room draws, the same figures as table rows,
   * and the prose sections the room has no space for. The numbers and their
   * units are the query layer's; only the skin is the page's — the book's face
   * for prose, the room's UI sans for axes, and `--cv-ground` with the grain and
   * the lamp (§11.8).
   *
   * **It owns no fact.** `series`, `figure` and `story` arrive built by the
   * shell, from the same `splitSeries` call the room is handed, which is what
   * makes the two presentations unable to disagree.
   *
   * Motion is tied to reading, not to a clock: the sheet arrives on a soft
   * diagonal wipe, the hero's rule draws once, and each section's opacity and
   * offset follow its position in the viewport through CSS scroll timelines —
   * no rAF, no timer, and nothing left moving once it is in sight. Every one of
   * them ends, so every one of them answers reduced motion and none answers the
   * wall's `still`: a one-shot that finishes costs nothing once it has, which is
   * `motion.md`'s rule and `test/styles.test.ts`'s.
   */
  import {
    bucketLabel,
    measureText,
    niceAxis,
    readingsOf,
    runsOfTimes,
    shareText,
    spreadLabels,
    tickLabel,
    timesOf,
    type RoomSeries,
    type RoomMeasure,
    type RoomSplit,
  } from "./analyticsroom";
  import { bucketOf, pct } from "./analytics";
  import type { Bucket } from "./analytics";
  import type { PageFigure, Story } from "./analyticpage";
  import { count } from "./usage";

  let {
    window: win,
    series,
    measure,
    split,
    spanSaid,
    bucket,
    figure,
    story,
  }: {
    window: { since: number; until: number; tier: "fine" | "hourly" };
    series: RoomSeries[];
    measure: RoomMeasure;
    split: RoomSplit;
    spanSaid: string;
    bucket: Bucket;
    figure: PageFigure;
    story: Story;
  } = $props();

  let plate = $state<HTMLElement>();
  let box = $state({ w: 760, h: 320 });

  const list = $derived(series);
  const times = $derived(timesOf(list));
  const readings = $derived(readingsOf(list));
  const from = $derived(win.since ?? 0);
  const to = $derived(win.until ?? 1);
  const width = $derived(Math.max(1, to - from));

  const PAD = { l: 46, t: 18, b: 28 };
  const labelled = $derived(list.length >= 2);
  const padR = $derived(labelled ? 96 : 12);
  const plotW = $derived(Math.max(20, box.w - PAD.l - padR));
  const plotH = $derived(Math.max(20, box.h - PAD.t - PAD.b));

  const highest = $derived.by(() => {
    let top = 0;
    for (const r of readings.values()) if (r.total > top) top = r.total;
    return top;
  });
  const axis = $derived(niceAxis(highest, 3));

  const xOf = (at: number) => PAD.l + ((at - from) / width) * plotW;
  const yOf = (v: number) => (axis.top > 0 ? PAD.t + plotH - (v / axis.top) * plotH : PAD.t + plotH);

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

  const timeRuns = $derived(runsOfTimes(times, bucket));

  /* The same bands the room draws, filled with a gradient rather than a flat
     wash: the page's one change to the mark, and still the same values (§11.8). */
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
        return {
          key: s.slot === null ? "fold" : `s${s.slot}`,
          color: s.color,
          gradient: s.slot === null ? null : `ap-grad-${s.slot}`,
          area: run.length > 1 ? area : "",
          line: run.length > 1 ? line : "",
          dot: run.length === 1 ? { x: xs[0], y: top[0] } : null,
        };
      }),
    })),
  );

  /* Direct labels only when there is more than one band, and pushed apart by
     the same rule the room uses — a legend on a page is a table by another
     name, and the table is below. */
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
    return spreadLabels(wanted, 14, PAD.t + 6, PAD.t + plotH - 2);
  });

  /* The one annotation the page adds: where the figure is heaviest, in the
     book's italic and drawn against the peak's own bucket. */
  const peak = $derived(figure.peak ? { ...figure.peak, x: xOf(figure.peak.at), y: yOf(figure.peak.value) } : null);

  const xTicks = $derived.by(() => {
    const n = 4;
    const out: { x: number; text: string }[] = [];
    for (let i = 0; i < n; i += 1) {
      const at = bucketOf(from + ((to - from) * i) / (n - 1), bucket);
      out.push({ x: Math.min(PAD.l + plotW, Math.max(PAD.l, xOf(at))), text: tickLabel(at, bucket) });
    }
    return out;
  });

  function seriesKey(s: RoomSeries): string {
    return s.slot === null ? "fold" : `s${s.slot}`;
  }

  function measured(el: HTMLElement) {
    const ro = new ResizeObserver(() => (box = { w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }

  /* ── the keys the shell delegates, so the document is read from the root ── */

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
</script>

<div class="ap-stage">
<div class="ap-ground" aria-hidden="true"></div>
<div class="ap-veil" aria-hidden="true"></div>
<div class="ap-scroll" bind:this={scroller}>
  <article class="ap-sheet">
    <p class="ap-kicker">
      <span>{measure === "usd_modeled" ? "spend" : "tokens"}</span>
      <span class="ap-sep">·</span>
      <span>{spanSaid}</span>
      {#if split}
        <span class="ap-sep">·</span>
        <span>by {split}</span>
      {/if}
    </p>

    <h3 class="ap-lede">{story.lede}</h3>
    <div class="ap-rule" aria-hidden="true"></div>

    {#if figure.total !== null && times.length > 0}
      <figure class="ap-figure">
        <div class="ap-plate" {@attach measured} bind:this={plate}>
          <svg class="ap-svg" viewBox={`0 0 ${box.w} ${box.h}`} width={box.w} height={box.h} role="img"
            aria-label={`${spanSaid}: ${measureText(measure, figure.total)} over ${count(times.length)} recorded buckets`}>
            <defs>
              {#each list as s (seriesKey(s))}
                {#if s.slot !== null}
                  <linearGradient id={`ap-grad-${s.slot}`} x1="0" y1={yOf(axis.top)} x2="0" y2={yOf(0)} gradientUnits="userSpaceOnUse">
                    <stop offset="0" stop-color={s.color} stop-opacity="0.34" />
                    <stop offset="0.7" stop-color={s.color} stop-opacity="0.1" />
                    <stop offset="1" stop-color={s.color} stop-opacity="0.02" />
                  </linearGradient>
                {/if}
              {/each}
            </defs>

            {#each axis.ticks as v (v)}
              <line class="ap-grid" x1={PAD.l} x2={PAD.l + plotW} y1={yOf(v)} y2={yOf(v)} />
              {#if v !== 0}
                <text class="ap-axis" x={PAD.l - 8} y={yOf(v) + 3.5} text-anchor="end">
                  {measure === "usd_modeled" ? measureText(measure, v) : count(v)}
                </text>
              {/if}
            {/each}

            {#each bands as band (band.run[0])}
              {#each band.series as s (s.key)}
                {#if s.area}
                  <path d={s.area} fill={s.gradient === null ? s.color : `url(#${s.gradient})`} fill-opacity={s.gradient === null ? 0.14 : 1} stroke="none" />
                  <path d={s.line} fill="none" stroke={s.color} stroke-width="1.5" stroke-linejoin="round" />
                {:else if s.dot}
                  <circle cx={s.dot.x} cy={s.dot.y} r="2.6" fill={s.color} />
                {/if}
              {/each}
            {/each}

            {#each xTicks as tick, i (i)}
              <text class="ap-axis" x={tick.x} y={PAD.t + plotH + 18} text-anchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}>
                {tick.text}
              </text>
            {/each}

            {#if peak}
              <line class="ap-peak-line" x1={peak.x} x2={peak.x} y1={peak.y - 6} y2={PAD.t + plotH} />
              <circle cx={peak.x} cy={peak.y} r="3.2" fill="var(--paper)" stroke="var(--cv-ground, var(--well))" stroke-width="1.5" />
              <text class="ap-anno" x={Math.min(peak.x + 8, PAD.l + plotW - 6)} y={Math.max(PAD.t + 8, peak.y - 12)}
                text-anchor={peak.x > PAD.l + plotW * 0.7 ? "end" : "start"}>
                {peak.label} · {measureText(measure, peak.value)}
              </text>
            {/if}

            {#each labels as l, i (i)}
              <circle cx={PAD.l + plotW + 9} cy={l.y} r="3" fill={l.color} />
              <text class="ap-direct" x={PAD.l + plotW + 16} y={l.y + 3.5}>{l.label}</text>
            {/each}
          </svg>
        </div>
        <figcaption class="ap-cap">
          {#if figure.peak}
            the heaviest bucket was {figure.peak.label}{#if figure.peak.share !== null}, at {pct(figure.peak.share)} of the window{/if}.
          {/if}
          {#if figure.gaps > 0}
            {figure.gaps === 1 ? "one stretch between readings was" : `${figure.gaps} stretches between readings were`} not recorded, and the line breaks there rather than falling to zero.
          {/if}
          {#if figure.unpriced > 0}
            {count(figure.unpriced)} rows carry no price and are left out.
          {/if}
        </figcaption>
      </figure>
    {:else}
      <p class="ap-nothing">no bucket in this window carries a value to draw.</p>
    {/if}

    {#each story.sections as sec (sec.id)}
      <section class="ap-sec">
        <h4>{sec.title}</h4>
        <p>{sec.body}</p>
      </section>
    {/each}

    <section class="ap-sec ap-table-sec">
      <h4>the numbers</h4>
      <details class="ap-details">
        <summary>every bucket, as the figure draws it</summary>
        <div class="ap-table-wrap">
          <table class="ap-table">
            <thead>
              <tr>
                <th scope="col">bucket</th>
                {#each list as s (seriesKey(s))}
                  <th scope="col" class="ap-num">{s.label || "value"}</th>
                {/each}
                <th scope="col" class="ap-num">total</th>
              </tr>
            </thead>
            <tbody>
              {#each times as t (t)}
                {@const reading = readings.get(t)}
                <tr>
                  <th scope="row">{bucketLabel(t, bucket)}</th>
                  {#each list as s, si (seriesKey(s))}
                    <td class="ap-num">{measureText(measure, valueAt[si]?.get(t) ?? null)}</td>
                  {/each}
                  <td class="ap-num">{measureText(measure, reading?.total ?? null)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </details>
      <p class="ap-shares">
        {#each list as s, i (seriesKey(s))}
          {#if i > 0}<span class="ap-sep">·</span>{/if}
          <span class="ap-share"><span class="ap-dot" style:background={s.color}></span>{s.label || "unnamed"}&nbsp;
            {measureText(measure, s.points.length ? s.total : null)}
            <span class="ap-share-pct">{shareText(figure.total && figure.total > 0 && s.points.length ? (s.total / figure.total) * 100 : null)}</span>
          </span>
        {/each}
      </p>
    </section>
  </article>
</div>
</div>

<style>
  .ap-stage {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }

  /* ── the ground (§11.8: `--cv-ground`, the grain and the lamp) ─────────── */

  .ap-ground {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
      radial-gradient(120% 80% at 18% -10%, var(--cv-lamp, transparent) 0%, transparent 60%),
      var(--cv-ground, var(--well));
  }
  .ap-ground::after {
    content: "";
    position: absolute;
    inset: 0;
    background-image: var(--cv-grain, none);
    opacity: 0.5;
    mix-blend-mode: soft-light;
  }

  .ap-scroll {
    position: absolute;
    inset: 0;
    overflow: auto;
    scrollbar-width: thin;
  }

  .ap-sheet {
    max-width: 64rem;
    margin: 0 auto;
    padding: 34px 40px 78px;
    color: var(--paper-dim);
    font-family: var(--body);
  }

  /* The arrival: a soft diagonal wipe.
   *
   * A veil of the page's own ground — same colour, same grain, so at rest it is
   * not there — slides off the content along the diagonal, and its one edge is
   * a wide gradient rather than a line, so the page is revealed through a soft
   * band instead of being switched on. No `clip-path` and no opacity ramp: the
   * content is drawn the whole way, under something leaving. It ends, so it
   * answers reduced motion and the `still` setting, and under either the veil is
   * simply absent. */
  .ap-veil {
    position: absolute;
    inset: -25%;
    z-index: 2;
    pointer-events: none;
    background:
      linear-gradient(128deg, transparent 0%, transparent 40%, var(--cv-ground, var(--well)) 62%, var(--cv-ground, var(--well)) 100%);
    animation: ap-wipe 1.9s var(--ease-out, ease-out) both;
  }
  @keyframes ap-wipe {
    from {
      transform: translate3d(0, 0, 0);
    }
    to {
      transform: translate3d(85%, 85%, 0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ap-veil {
      display: none;
    }
  }

  .ap-kicker {
    margin: 0 0 14px;
    font-family: var(--cv-ui, var(--util));
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: lowercase;
    color: var(--cv-note, var(--paper-mute));
  }
  .ap-sep {
    margin: 0 0.5em;
    opacity: 0.5;
  }

  .ap-lede {
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
  .ap-rule {
    width: 84px;
    height: 2px;
    margin: 18px 0 4px;
    background: var(--paper-mute);
    transform-origin: left center;
    animation: ap-draw 950ms var(--ease-out, ease-out) 1.15s both;
  }
  @keyframes ap-draw {
    from {
      transform: scaleX(0);
    }
    to {
      transform: scaleX(1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ap-rule {
      animation: none;
    }
  }

  /* ── the plate is wider than the measure, and that is the ask ────────── */

  .ap-figure {
    margin: 26px 0 8px;
  }
  .ap-plate {
    position: relative;
    width: min(100%, 64rem);
    height: clamp(240px, 34vw, 360px);
  }
  .ap-svg {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .ap-grid {
    stroke: color-mix(in oklab, var(--edge) 70%, transparent);
    stroke-width: 1;
  }
  .ap-axis {
    fill: var(--cv-note, var(--paper-mute));
    font-family: var(--cv-ui, var(--util));
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }
  .ap-direct {
    fill: var(--paper-dim);
    font-family: var(--cv-ui, var(--util));
    font-size: 10.5px;
  }
  .ap-peak-line {
    stroke: var(--paper-mute);
    stroke-width: 1;
    stroke-dasharray: 2 4;
    opacity: 0.7;
  }
  /* The marginal annotations are the book's italic, never the UI face. */
  .ap-anno {
    fill: var(--paper-mute);
    font-family: var(--body);
    font-style: italic;
    font-size: 11.5px;
  }
  .ap-cap {
    margin: 10px 0 0;
    max-width: 44rem;
    font-family: var(--body);
    font-style: italic;
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--paper-mute);
  }
  .ap-nothing {
    margin: 30px 0;
    max-width: 44rem;
    font-style: italic;
    color: var(--paper-mute);
  }

  /* ── the sections, tied to the scroll rather than to a timer ─────────── */

  .ap-sec {
    max-width: 44rem;
    margin: 34px 0 0;
    opacity: 1;
  }
  .ap-sec h4 {
    margin: 0 0 8px;
    font-family: var(--cv-ui, var(--util));
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0.07em;
    text-transform: lowercase;
    color: var(--paper-mute);
  }
  .ap-sec p {
    margin: 0;
    font-family: var(--body);
    font-size: 15px;
    line-height: 1.66;
    color: var(--paper-dim);
    text-wrap: pretty;
  }
  @supports (animation-timeline: view()) {
    .ap-sec {
      animation: ap-lit linear both;
      animation-timeline: view();
      /* from 0.45 to 1 with a 30px settle, spread over two thirds of a
         viewport — the change the design asks for, and it never finishes
         below the fold because the range is the element's own entry. */
      animation-range: entry 12% cover 62%;
    }
    @keyframes ap-lit {
      from {
        opacity: 0.45;
        transform: translateY(30px);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .ap-sec {
        animation: none;
      }
    }
  }

  .ap-nothing,
  .ap-cap,
  .ap-kicker,
  .ap-lede {
    max-width: 44rem;
  }

  /* ── the honest table ────────────────────────────────────────────────── */

  .ap-table-sec {
    max-width: 64rem;
  }
  .ap-details {
    margin: 4px 0 0;
  }
  .ap-details summary {
    cursor: pointer;
    font-family: var(--cv-ui, var(--util));
    font-size: 12px;
    color: var(--paper-mute);
    padding: 5px 0;
  }
  .ap-details summary:hover {
    color: var(--paper);
  }
  .ap-table-wrap {
    max-height: 340px;
    overflow: auto;
    margin-top: 6px;
    border: 1px solid var(--cv-hair, var(--edge));
    border-radius: 8px;
    background: color-mix(in oklab, var(--cv-ground, var(--well)) 70%, transparent);
  }
  .ap-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--cv-ui, var(--util));
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }
  .ap-table th,
  .ap-table td {
    padding: 5px 10px;
    text-align: left;
    border-bottom: 1px solid var(--cv-hair, var(--edge));
    white-space: nowrap;
  }
  .ap-table thead th {
    position: sticky;
    top: 0;
    background: var(--cv-ground, var(--well));
    color: var(--paper-mute);
    font-weight: 500;
    font-size: 10.5px;
  }
  .ap-table tbody th {
    font-weight: 400;
    color: var(--paper-dim);
  }
  .ap-table .ap-num {
    text-align: right;
    color: var(--paper);
  }

  .ap-shares {
    margin: 14px 0 0;
    font-family: var(--cv-ui, var(--util));
    font-size: 11.5px;
    color: var(--paper-mute);
    line-height: 2;
  }
  .ap-share {
    white-space: nowrap;
  }
  .ap-share-pct {
    margin-left: 5px;
    color: var(--paper-mute);
    font-variant-numeric: tabular-nums;
  }
  .ap-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 2px;
    margin-right: 5px;
    background: currentColor;
  }
</style>
