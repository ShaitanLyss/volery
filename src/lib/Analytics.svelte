<script lang="ts">
  /* The analytics room: the first face on the facts `analytics.rs` records.
   *
   * A full-screen overlay rather than a panel (§11): a KPI row, a chart and an
   * inspector do not fit a conversation's column, and the wall has nowhere to
   * put a document. It opens from `<space>bd`, stays over whichever view is in
   * front, and the wall shows around its edges.
   *
   * Everything it *decides* is in `analyticsroom.ts` and tested there: which
   * tier answers, how a window becomes series, where the gaps are, what a
   * bucket is called, what a null prints. This file is geometry, keyboard and
   * paint.
   *
   * **It reads, it does not poll.** One read on open, one whenever the span
   * changes, one more after the collector's minute has gone by (a single
   * one-shot timer, not an interval), and one if you ask with `r`. On close the
   * component unmounts, which clears the timer; a read still in flight lands on
   * a dead component and is dropped by the generation counter rather than
   * writing into the next opening.
   *
   * **Colour is identity and it comes from the query layer.** Every series
   * colour is `analytics.ts::seriesColor`, handed out in its fixed order; the
   * chrome stays achromatic and the fold past the fifth is a text token.
   *
   * Keyboard: `[` `]` step the span, `m` the measure, `g` the split, `t` the
   * table, `r` reads again, `f` goes to the filters, arrows or `h j k l` walk
   * the buckets, Home and End go to the ends, Escape leaves.
   */
  import { onMount } from "svelte";
  import Icon from "./Icon.svelte";
  import { readAnalyticsWindow } from "./analyticsread.svelte";
  import { surface } from "./analyticsview.svelte";
  import {
    ROOM_MEASURES,
    ROOM_SPLITS,
    SPANS,
    bucketLabel,
    emptinessOf,
    kpisOf,
    measureText,
    nearestAt,
    niceAxis,
    readingsOf,
    roomBucket,
    shareText,
    splitSeries,
    spreadLabels,
    stepAt,
    tickLabel,
    runsOfTimes,
    tickText,
    tierSaid,
    timesOf,
    windowTier,
    type AnalyticsWindow,
    type RoomSeries,
    type RoomSplit,
    type SlotBook,
    type WindowReader,
  } from "./analyticsroom";
  import { bucketOf, spanMsOf } from "./analytics";
  import { count } from "./usage";

  let {
    read,
    onclose,
  }: {
    /** The command, or a fixture. Absent means the real one. */
    read?: WindowReader;
    onclose: () => void;
  } = $props();

  /* ── what is being asked ─────────────────────────────────────────────── */

  /* Span, measure and split are the surface's, not this drawing's (§11.15):
     the page will read the same three, and a swap between presentations carries
     them because this one does not own them. Everything below — the window that
     came back, the selection, the table toggle — is this drawing's alone. */
  const span = $derived(surface.span);
  const measure = $derived(surface.measure);
  const split = $derived(surface.split);
  let table = $state(false);

  /* Colours by identity rather than by rank, so changing the span does not
     repaint the survivors (§10.1). The book is per split dimension: a project's
     slot means nothing in an account chart, so it is emptied when the dimension
     changes. A plain `Map` on purpose — what it remembers is palette history,
     not something to redraw on. */
  let book: SlotBook = new Map();
  let bookFor: RoomSplit | null = null;

  /* ── what came back ──────────────────────────────────────────────────── */

  let loaded = $state<AnalyticsWindow | null>(null);
  let failed = $state<string | null>(null);
  let busy = $state(true);
  let readAt = $state<number | null>(null);

  let selected = $state<number | null>(null);
  let hovered = $state<number | null>(null);

  let root = $state<HTMLElement>();
  let filters = $state<HTMLElement>();
  let scroller = $state<HTMLElement>();
  let box = $state({ w: 860, h: 300 });

  /* A closure rather than the prop itself: a prop read outside one captures
     its initial value, which is exactly the bug a fixture that swapped its
     reader at runtime would be impossible to see. */
  const reader: WindowReader = (span, now) => (read ?? readAnalyticsWindow)(span, now);

  /* The generation counter is what makes a slow read harmless: a span change
     while the last answer is still coming back must not land the old window on
     the new axis. Only the newest read may write. */
  let gen = 0;

  async function readNow() {
    const mine = ++gen;
    busy = true;
    try {
      const next = await reader(span, Date.now());
      if (mine !== gen) return;
      loaded = next;
      readAt = Date.now();
      failed = null;
    } catch (e) {
      if (mine !== gen) return;
      failed = e instanceof Error ? e.message : String(e);
      loaded = null;
    } finally {
      if (mine === gen) busy = false;
    }
  }

  /* One read on open and one per span change. Nothing else re-reads, and the
     effect has no other dependency because the reader's own arguments are the
     span alone.
     The selection is cleared here and only here: a new axis does not have the
     old bucket in it. The once-a-minute refresh does *not* clear it, which is
     the difference between a room you left reading a bucket and one that drops
     your place under you. */
  $effect(() => {
    void span;
    selected = null;
    hovered = null;
    void readNow();
  });

  /* The collector writes once a minute, so an untouched room goes stale by at
     most that much. This is one refresh, not a poll, and `onMount` is how that
     is structural rather than argued: a mount hook runs exactly once and never
     again, where an effect is a thing that may re-run. `onMount`'s cleanup runs
     when the room closes, so a room you left before the minute costs nothing
     and one left open costs one read. */
  onMount(() => {
    const t = setTimeout(() => void readNow(), 65_000);
    return () => clearTimeout(t);
  });

  /* Focus comes in on open, stays in while the room is up, and goes back where
     it was on close.
     **Staying in is not tidiness.** The room is `aria-modal`, and the wall and
     the dock behind it are still in the tab order — `inert` covers the wall but
     the dock is a component of its own. A tab that reached the draft would let
     a letter be typed into a field behind an opaque overlay, which is invisible
     and survives closing. So a focus that lands outside is pulled back, and the
     flag keeps the pull-back from fighting the restore on the way out. */
  const cameFrom = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
  let closing = false;

  function holdFocus() {
    if (closing || !root) return;
    if (!root.contains(document.activeElement)) root.focus();
  }

  onMount(() => {
    root?.focus();
    /* A focus that moves *to* something else fires `focusin`, which is the Tab
       case. */
    const hold = (e: FocusEvent) => {
      if (closing || !root || root.contains(e.target as Node)) return;
      root.focus();
    };
    document.addEventListener("focusin", hold);
    return () => {
      closing = true;
      document.removeEventListener("focusin", hold);
    };
  });

  /* A focus that *disappears* fires no `focusin` at all: removing the focused
     element hands focus to `body` and Chromium tells nobody. That is the path
     that matters here — `t` takes the plot away, and the plot's button is where
     the pointer had just put the focus — so it is answered where the thing that
     removed it is known, after the DOM has caught up. */
  $effect(() => {
    void table;
    void loaded;
    holdFocus();
  });

  $effect(() => () => cameFrom?.focus?.());

  /* ── what it means ───────────────────────────────────────────────────── */

  const spanMs = $derived(spanMsOf(span) ?? 7 * 24 * 3_600_000);
  const tier = $derived(windowTier(spanMs));
  const bucket = $derived(roomBucket(spanMs, tier));
  const rows = $derived(loaded?.rows ?? []);
  const list = $derived.by(() => {
    if (bookFor !== split) {
      book = new Map();
      bookFor = split;
    }
    return splitSeries(rows, measure, bucket, split, book);
  });
  const times = $derived(timesOf(list));
  const readings = $derived(readingsOf(list));
  const kpis = $derived(kpisOf(rows, loaded?.cards ?? 0));
  const empty = $derived(loaded ? emptinessOf(loaded) : null);

  const spanSaid = $derived(SPANS.find((s) => s.span === span)?.said ?? span);
  const measureSaid = $derived(ROOM_MEASURES.find((m) => m.key === measure)?.said ?? measure);
  const splitSaid = $derived(split ? `by ${split}` : "no split");

  /* ── geometry ────────────────────────────────────────────────────────── */

  const PAD = { l: 58, t: 14, b: 26 };
  const labelled = $derived(list.length >= 4 && !table);
  const padR = $derived(labelled ? 122 : 16);
  const plotW = $derived(Math.max(20, box.w - PAD.l - padR));
  const plotH = $derived(Math.max(20, box.h - PAD.t - PAD.b));
  const from = $derived(loaded?.since ?? 0);
  const to = $derived(loaded?.until ?? 1);
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
     rule itself is `analyticsroom.ts::runsOfTimes`, tested there, because it is
     the one the module's header promises and a second copy here would be a rule
     that gets fixed once. */
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
    if (table || hovered === null || !loaded) return null;
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
    if (!loaded) return [] as { x: number; text: string }[];
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

  /* ── verbs ───────────────────────────────────────────────────────────── */

  function stepSpan(delta: number) {
    const i = SPANS.findIndex((s) => s.span === span);
    const next = SPANS[Math.min(SPANS.length - 1, Math.max(0, (i === -1 ? 0 : i) + delta))];
    if (next) surface.span = next.span;
  }

  function cycleMeasure() {
    const i = ROOM_MEASURES.findIndex((m) => m.key === measure);
    surface.measure = ROOM_MEASURES[(i + 1) % ROOM_MEASURES.length].key;
  }

  function cycleSplit() {
    const i = ROOM_SPLITS.findIndex((s) => s.key === split);
    surface.split = ROOM_SPLITS[(i + 1) % ROOM_SPLITS.length].key;
  }

  function move(delta: number) {
    selected = stepAt(times, hovered ?? selected, delta);
    hovered = null;
  }

  function key(e: KeyboardEvent) {
    if (e.defaultPrevented) {
      e.stopPropagation();
      return;
    }
    /* A chord with a modifier is not this room's (alt+I, ctrl+shift+M): it goes
       on to the window, as it does from the reading sheet. */
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onclose();
      return;
    }
    /* Everything else is the room's while it is up, including the letters the
       wall would otherwise take into the composer. */
    e.stopPropagation();
    if (e.key === "[") {
      e.preventDefault();
      stepSpan(-1);
    } else if (e.key === "]") {
      e.preventDefault();
      stepSpan(1);
    } else if (e.key === "m") {
      e.preventDefault();
      cycleMeasure();
    } else if (e.key === "g") {
      e.preventDefault();
      cycleSplit();
    } else if (e.key === "t") {
      e.preventDefault();
      table = !table;
    } else if (e.key === "r") {
      e.preventDefault();
      void readNow();
    } else if (e.key === "f") {
      e.preventDefault();
      filters?.querySelector<HTMLButtonElement>("button")?.focus();
    } else if (e.key === "ArrowLeft" || e.key === "h") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "ArrowRight" || e.key === "l") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      selected = times.length ? times[e.key === "Home" ? 0 : times.length - 1] : null;
      hovered = null;
    }
  }

  /* Arrow keys inside a segmented control move the choice, which is what a
     radiogroup does natively and what a div full of buttons does not. */
  function radioKeys(e: KeyboardEvent, length: number, index: number, pick: (i: number) => void) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const delta = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
    const n = (Math.max(0, index) + delta + length) % length;
    pick(n);
    (e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("button")[n]?.focus();
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

<svelte:window
  onkeydown={(e) => {
    /* Focus can fall to the body when a read re-renders a focused control
       away; the room still owns the keys, as the reading sheet's does. */
    if (!root?.contains(e.target as Node)) key(e);
  }}
/>

<div class="an-scrim" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && onclose()}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="an-room"
    role="dialog"
    aria-modal="true"
    aria-labelledby="an-head"
    tabindex="-1"
    bind:this={root}
    onkeydown={key}
  >
    <header class="an-head">
      <span class="an-mark" aria-hidden="true"><Icon name="wave" /></span>
      <div class="an-what">
        <h2 id="an-head">analytics</h2>
        <p>
          {spanSaid} · {tierSaid(loaded?.tier ?? tier)}
          {#if loaded && loaded.rows.length > 0}· {count(loaded.rows.length)} rows{/if}
        </p>
      </div>
      <span class="an-grow"></span>
      <span class="an-keys">space b d</span>
      <button type="button" class="an-btn an-close" title="close (esc)" aria-label="close" onclick={onclose}>
        <Icon name="x" small />
      </button>
    </header>

    <div class="an-filters" bind:this={filters} role="group" aria-label="what to read">
      <span class="an-label">span</span>
      <div
        class="an-seg"
        role="radiogroup"
        tabindex="-1"
        aria-label="span"
        onkeydown={(e) => radioKeys(e, SPANS.length, SPANS.findIndex((s) => s.span === span), (i) => (surface.span = SPANS[i].span))}
      >
        {#each SPANS as s (s.span)}
          <button
            type="button"
            role="radio"
            aria-checked={span === s.span}
            class:on={span === s.span}
            title={`${s.said} ([ and ] step it)`}
            onclick={() => (surface.span = s.span)}>{s.label}</button
          >
        {/each}
      </div>

      <span class="an-label">measure</span>
      <div
        class="an-seg"
        role="radiogroup"
        tabindex="-1"
        aria-label="measure"
        onkeydown={(e) =>
          radioKeys(e, ROOM_MEASURES.length, ROOM_MEASURES.findIndex((m) => m.key === measure), (i) => (surface.measure = ROOM_MEASURES[i].key))}
      >
        {#each ROOM_MEASURES as m (m.key)}
          <button
            type="button"
            role="radio"
            aria-checked={measure === m.key}
            class:on={measure === m.key}
            title={`${m.said} (m cycles it)`}
            onclick={() => (surface.measure = m.key)}>{m.label}</button
          >
        {/each}
      </div>

      <span class="an-label">split</span>
      <div
        class="an-seg"
        role="radiogroup"
        tabindex="-1"
        aria-label="split"
        onkeydown={(e) =>
          radioKeys(e, ROOM_SPLITS.length, ROOM_SPLITS.findIndex((s) => s.key === split), (i) => (surface.split = ROOM_SPLITS[i].key))}
      >
        {#each ROOM_SPLITS as s (String(s.key))}
          <button
            type="button"
            role="radio"
            aria-checked={split === s.key}
            class:on={split === s.key}
            title={`split by ${s.label} (g cycles it)`}
            onclick={() => (surface.split = s.key)}>{s.label}</button
          >
        {/each}
      </div>

      <span class="an-grow"></span>

      <button
        type="button"
        class="an-btn"
        class:on={table}
        aria-pressed={table}
        title="the same numbers as a table (t)"
        onclick={() => (table = !table)}
        ><Icon name={table ? "wave" : "list"} small />{table ? "chart" : "table"}</button
      >
      <button type="button" class="an-btn" title="read the window again (r)" onclick={() => void readNow()}>
        <Icon name="clock" small />read again
      </button>
    </div>

    {#if failed}
      <div class="an-body an-message">
        <p class="an-fail">could not read the window</p>
        <p class="an-note">{failed}</p>
      </div>
    {:else if !loaded}
      <div class="an-body an-message">
        <p class="an-note">{busy ? "reading…" : "no answer yet"}</p>
      </div>
    {:else if empty}
      <div class="an-body an-message">
        <p class="an-empty">{empty.title}</p>
        <p class="an-note">{empty.note}</p>
      </div>
    {:else}
      <div class="an-strip" aria-label="in this window">
        {#each [
          { key: "spend", label: "spend", value: measureText("usd_modeled", kpis.spend), note: kpis.unpriced > 0 ? `${count(kpis.unpriced)} rows unpriced` : "modeled", off: kpis.spend === null },
          { key: "tokens", label: "tokens", value: kpis.tokens === null ? "—" : count(kpis.tokens), note: "in, out and cache", off: kpis.tokens === null },
          { key: "requests", label: "requests", value: count(kpis.requests), note: "in this window", off: false },
          { key: "cache", label: "cache read", value: shareText(kpis.cacheShare), note: "of all tokens", off: kpis.cacheShare === null },
          { key: "cards", label: "cards", value: count(kpis.cards), note: "active in this window", off: false },
          { key: "project", label: "leading project", value: kpis.leading?.project ?? "—", note: kpis.leading ? `${shareText(kpis.leading.share)} of tokens` : "no project yet", off: !kpis.leading },
          { key: "allowance", label: "allowance", value: "not recorded yet", note: "not in this schema yet", off: true },
        ] as tile (tile.key)}
          <div class="an-tile" class:off={tile.off}>
            <span class="an-tile-label">{tile.label}</span>
            <span class="an-tile-value">{tile.value}</span>
            <span class="an-tile-note">{tile.note}</span>
          </div>
        {/each}
      </div>

      <div class="an-main">
        <section class="an-canvas" aria-label={table ? "the window as a table" : "the window over time"}>
          <div class="an-chart-head">
            <span class="an-title">{spanSaid} · {measureSaid}{split ? ` · ${splitSaid}` : ""}</span>
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
                  <text class="an-axis" x={PAD.l - 8} y={yOf(v) + 3.5} text-anchor="end">{tickText(measure, v)}</text>
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

        <aside class="an-inspect" aria-label="the selected bucket">
          <h3>inspector</h3>
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
              <dd>{measureSaid}</dd>
              <dt>source</dt>
              <dd>{tierSaid(loaded?.tier ?? tier)}</dd>
              <dt>bucket</dt>
              <dd>{bucket} · {count(times.length)} recorded</dd>
            </dl>
          {:else}
            <p class="an-note">hover or click a bucket to read it here</p>
          {/if}
          {#if readAt}
            <p class="an-read">read at {new Date(readAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</p>
          {/if}
        </aside>
      </div>
    {/if}
  </div>
</div>

<style>
  .an-scrim {
    /* Against the studio root, which is the home screen while the window is
       spread, so a centred room lands there, as the accounts panel does. */
    position: fixed;
    inset: 0;
    z-index: 44;
    display: flex;
    justify-content: center;
    align-items: center;
    background: color-mix(in srgb, var(--shade) 34%, transparent);
    animation: an-fade var(--dur-quick, 160ms) var(--ease-out, ease-out) both;
  }
  .an-room {
    width: min(1400px, 92cqw);
    height: min(920px, 92cqh);
    display: flex;
    flex-direction: column;
    border-radius: var(--cv-r-l, 14px);
    border: 1px solid color-mix(in oklab, var(--edge) 70%, var(--paper) 9%);
    background: var(--raised);
    box-shadow: 0 34px 80px -26px color-mix(in srgb, var(--shade) 95%, transparent);
    font-family: var(--cv-ui, var(--util));
    color: var(--paper);
    overflow: hidden;
    outline: none;
    animation: an-rise var(--dur-scene, 360ms) var(--ease-out, ease-out) both;
  }
  @keyframes an-fade {
    from {
      opacity: 0;
    }
  }
  @keyframes an-rise {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.99);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .an-room {
      animation-name: an-fade;
    }
  }

  .an-grow {
    flex: 1;
  }

  /* ── the head ─────────────────────────────────────────────────────────── */

  .an-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px 12px 16px;
    border-bottom: 1px solid var(--cv-hair, var(--edge));
  }
  .an-mark {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    color: var(--paper);
    background: color-mix(in oklab, var(--paper) 8%, transparent);
  }
  .an-what h2 {
    margin: 0;
    font-size: 14.5px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }
  .an-what p {
    margin: 1px 0 0;
    font-size: 11.5px;
    color: var(--paper-mute);
  }
  .an-keys {
    font-family: var(--mono);
    font-size: 10.5px;
    color: var(--paper-faint);
    padding: 2px 7px;
    border: 1px solid var(--edge);
    border-radius: 999px;
  }

  /* ── controls ─────────────────────────────────────────────────────────── */

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
  .an-close {
    border-color: transparent;
    padding: 4px 6px;
  }

  .an-filters {
    flex: none;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 10px;
    padding: 9px 16px;
    border-bottom: 1px solid var(--cv-hair, var(--edge));
  }
  .an-label {
    font-size: 10.5px;
    text-transform: lowercase;
    color: var(--paper-faint);
    letter-spacing: 0.02em;
  }
  .an-seg {
    display: inline-flex;
    padding: 2px;
    border-radius: 8px;
    background: color-mix(in oklab, var(--paper) 5%, transparent);
  }
  .an-seg button {
    border: 0;
    background: transparent;
    color: var(--paper-dim);
    font: 11.5px var(--cv-ui, var(--util));
    padding: 3px 9px;
    border-radius: 6px;
    cursor: pointer;
  }
  .an-seg button:hover {
    color: var(--paper);
  }
  .an-seg button.on {
    background: color-mix(in oklab, var(--paper) 11%, transparent);
    color: var(--paper);
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

  /* ── the body ─────────────────────────────────────────────────────────── */

  .an-body {
    flex: 1;
    min-height: 0;
  }
  .an-message {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 40px;
    text-align: center;
  }
  .an-empty {
    margin: 0;
    font-size: 15px;
    color: var(--paper-dim);
  }
  .an-fail {
    margin: 0;
    font-size: 14px;
    color: var(--st-fail);
  }
  .an-note {
    margin: 0;
    font-size: 12px;
    color: var(--paper-mute);
    max-width: 46ch;
  }

  .an-main {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 252px;
  }

  .an-canvas {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 10px 12px 6px;
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
  .an-read {
    margin: 14px 0 0;
    font-size: 10px;
    color: var(--paper-faint);
  }
</style>
