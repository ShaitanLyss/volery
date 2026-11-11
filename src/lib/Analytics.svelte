<script lang="ts">
  /* The analytics surface: one shell over two presentations (§11, §11.8,
   * §11.15).
   *
   * A full-screen overlay rather than a panel: a KPI row, a chart and an
   * inspector do not fit a conversation's column, and the wall has nowhere to
   * put a document. It opens from `<space>bd` (the room), `<space>nn` (the
   * page), chat view's sidebar row, and the palette, and it stays over
   * whichever view is in front.
   *
   * **The shell owns the question and the read; the presentations own only the
   * drawing.** Span, measure, split and filter live in `analyticsview.svelte.ts`
   * so both presentations read them and swapping carries them across. The
   * window is read here once, folded into series here once, and the same
   * `RoomSeries[]` is handed to whichever face is in front — which is what
   * makes the numbers agree across the swap by construction (§11.15).
   *
   * **It reads, it does not poll.** One read on open, one whenever the span
   * changes, one more after the collector's minute has gone by (a single
   * one-shot timer, not an interval), and one if you ask with `r`. On close the
   * component unmounts, which clears the timer; a read still in flight lands on
   * a dead component and is dropped by the generation counter rather than
   * writing into the next opening. The filter does not cost a read: it cuts the
   * rows already here, which is the cheaper and the more honest of the two
   * (a re-read would answer the same window with the same rows).
   *
   * Keyboard: `v` swaps the presentation, `[` `]` step the span, `m` the
   * measure, `g` the split, `f` goes to the controls, `r` reads again, `s`
   * saves a view, `l` opens the library, Escape leaves. The room's own keys —
   * `t` for its table, the arrows or `j`/`k` to walk buckets, Home and End —
   * are handed to it, because they are about that drawing; the page's arrows
   * scroll the document. The keys left to the surface are the surface's in
   * both drawings, so a span changes the same way in either.
   */
  import { onMount, tick, untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import AnalyticsRoom from "./AnalyticsRoom.svelte";
  import AnalyticsPage from "./AnalyticsPage.svelte";
  import AnalyticsViews from "./AnalyticsViews.svelte";
  import { readAnalyticsWindow } from "./analyticsread.svelte";
  import {
    presentation,
    openPresentation,
    setPresentation,
    surface,
    swapPresentation,
    adoptSurface,
  } from "./analyticsview.svelte";
  import {
    ROOM_MEASURES,
    ROOM_SPLITS,
    SPANS,
    emptinessOf,
    roomBucket,
    tierSaid,
    windowTier,
    type AnalyticsWindow,
    type SlotBook,
    type RoomSplit,
    type WindowReader,
  } from "./analyticsroom";
  import { pageModel, surfaceOfView, type HostMode, type Presentation } from "./analyticpage";
  import { spanMsOf, type ViewSpec } from "./analytics";
  import { count } from "./usage";
  import { view } from "./view.svelte";

  let {
    read,
    onclose,
    mode = view.current,
    as,
  }: {
    /** The command, or a fixture. Absent means the real one. */
    read?: WindowReader;
    onclose: () => void;
    /** Which host is underneath: it only picks the *default* presentation,
     *  and never changes when `v` swaps them (§11.15). */
    mode?: HostMode;
    /** An explicit presentation asked for as it opened — `space b d` is the
     *  room, `space n n` the page. Absent means the remembered one for the
     *  mode, which is what the sidebar row and a plain open mean. */
    as?: Presentation;
  } = $props();

  /* The remembered choice, read once, before the first frame — an effect would
     paint the room and then flip to the page. An explicit request is a choice
     too, so it is remembered against the mode it was made in. */
  untrack(() => {
    openPresentation(mode);
    if (as) setPresentation(as);
  });

  /* ── what is being asked ─────────────────────────────────────────────── */

  const span = $derived(surface.span);
  const measure = $derived(surface.measure);
  const split = $derived(surface.split);
  const showing = $derived(presentation.current);

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

  let root = $state<HTMLElement>();
  let controls = $state<HTMLElement>();
  let room = $state<ReturnType<typeof AnalyticsRoom> | undefined>();
  let page = $state<ReturnType<typeof AnalyticsPage> | undefined>();

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
     span alone. The selection a presentation holds is its own: the room clears
     its own when the span changes, because the bucket it remembers is not in
     the new axis, and this effect does not touch it so the 65-second refresh
     cannot drop your place. */
  $effect(() => {
    void span;
    void readNow();
  });

  /* The collector writes once a minute, so an untouched surface goes stale by
     at most that much. This is one refresh, not a poll, and `onMount` is how
     that is structural rather than argued: a mount hook runs exactly once and
     never again, where an effect is a thing that may re-run. `onMount`'s
     cleanup runs when the surface closes, so one left before the minute costs
     nothing and one left open costs one read. */
  onMount(() => {
    const t = setTimeout(() => void readNow(), 65_000);
    return () => clearTimeout(t);
  });

  /* ── what it means, once ─────────────────────────────────────────────── */

  const spanMs = $derived(spanMsOf(span) ?? 7 * 24 * 3_600_000);
  const tier = $derived(windowTier(spanMs));
  const bucket = $derived(roomBucket(spanMs, tier));

  const model = $derived.by(() => {
    if (!loaded) return null;
    if (bookFor !== split) {
      book = new Map();
      bookFor = split;
    }
    return pageModel({
      window: loaded,
      filter: surface.filter,
      measure,
      split,
      bucket,
      span,
      book,
    });
  });

  const empty = $derived(loaded ? emptinessOf(loaded) : null);

  const spanSaid = $derived(SPANS.find((s) => s.span === span)?.said ?? span);
  const measureSaid = $derived(ROOM_MEASURES.find((m) => m.key === measure)?.said ?? measure);
  const splitSaid = $derived(split ? `by ${split}` : "no split");

  /* ── the library (§11.6) ─────────────────────────────────────────────── */

  let views = $state<"save" | "list" | null>(null);

  function openView(spec: ViewSpec) {
    adoptSurface(surfaceOfView(spec));
    views = null;
    void tick().then(() => root?.focus());
  }

  function closeViews() {
    views = null;
    void tick().then(() => root?.focus());
  }

  /* ── focus ───────────────────────────────────────────────────────────── */

  /* Focus comes in on open, stays in while the surface is up, and goes back
     where it was on close.
     **Staying in is not tidiness.** The surface is `aria-modal`, and the wall
     and the dock behind it are still in the tab order — `inert` covers the wall
     but the dock is a component of its own. A tab that reached the draft would
     let a letter be typed into a field behind an opaque overlay, which is
     invisible and survives closing. So a focus that lands outside is pulled
     back, and the flag keeps the pull-back from fighting the restore on the way
     out. */
  const cameFrom = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
  let closing = false;

  function holdFocus() {
    if (closing || !root) return;
    if (!root.contains(document.activeElement)) root.focus();
  }

  onMount(() => {
    root?.focus();
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
     element hands focus to `body` and Chromium tells nobody. The room answers
     its own table toggle; this is the same rule for anything the shell removes
     under a focused element — the library closing, and the presentation
     swapping out from under a control. */
  $effect(() => {
    void views;
    void showing;
    void loaded;
    holdFocus();
  });

  $effect(() => () => cameFrom?.focus?.());

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

  function swap() {
    swapPresentation();
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

  function key(e: KeyboardEvent) {
    if (e.defaultPrevented) {
      e.stopPropagation();
      return;
    }
    /* A chord with a modifier is not this surface's (alt+I, ctrl+shift+M): it
       goes on to the window, as it does from the reading sheet. */
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    /* The library owns the keys while it is up, including Escape — and a
       field inside it is typing, so letters must reach it rather than being
       taken by the surface behind. */
    if (views) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeViews();
      }
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable='true']")) return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onclose();
      return;
    }
    /* Everything else is the surface's while it is up, including the letters
       the wall would otherwise take into the composer. */
    e.stopPropagation();
    if (e.key === "v") {
      e.preventDefault();
      swap();
    } else if (e.key === "[") {
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
    } else if (e.key === "r") {
      e.preventDefault();
      void readNow();
    } else if (e.key === "f") {
      e.preventDefault();
      controls?.querySelector<HTMLButtonElement>("button")?.focus();
    } else if (e.key === "s") {
      e.preventDefault();
      views = "save";
    } else if (e.key === "l") {
      e.preventDefault();
      views = "list";
    } else if (showing === "room") {
      if (e.key === "t") {
        e.preventDefault();
        room?.toggleTable();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        room?.move(e.key === "ArrowLeft" ? -1 : 1);
      } else if (e.key === "ArrowDown" || e.key === "j" || e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        room?.move(e.key === "ArrowUp" || e.key === "k" ? -1 : 1);
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        room?.toEnd(e.key === "End");
      }
    } else {
      /* The page is read, not walked: the arrows move through the document and
         never through a bucket. */
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        page?.scrollBy(64);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        page?.scrollBy(-64);
      } else if (e.key === "PageDown") {
        e.preventDefault();
        page?.turnPage(1);
      } else if (e.key === "PageUp") {
        e.preventDefault();
        page?.turnPage(-1);
      } else if (e.key === "Home") {
        e.preventDefault();
        page?.goTo("top");
      } else if (e.key === "End") {
        e.preventDefault();
        page?.goTo("bottom");
      }
    }
  }
</script>

<svelte:window
  onkeydown={(e) => {
    /* Focus can fall to the body when a read re-renders a focused control
       away; the surface still owns the keys, as the reading sheet's does. */
    if (!root?.contains(e.target as Node)) key(e);
  }}
/>

<div class="an-scrim" role="presentation" onpointerdown={(e) => e.target === e.currentTarget && onclose()}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="an-room"
    class:reading={showing === "page"}
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
      <!-- The swap, achromatic and small, beside the title: it says where you
           are going rather than where you are, because that is the thing you
           can act on. `v` does the same from anywhere in the surface. -->
      <button
        type="button"
        class="an-btn an-pres"
        title={showing === "room" ? "read it as a document (v)" : "back to the instrument (v)"}
        onclick={swap}
      >
        <Icon name={showing === "room" ? "file" : "wave"} small />
        {showing === "room" ? "page" : "room"}
        <kbd>v</kbd>
      </button>
      <span class="an-grow"></span>
      <span class="an-keys">space b d</span>
      <button type="button" class="an-btn" title="saved views (s saves one, l opens the library)" onclick={() => (views = "list")}>
        <Icon name="pin" small />views
      </button>
      <button type="button" class="an-btn an-close" title="close (esc)" aria-label="close" onclick={onclose}>
        <Icon name="x" small />
      </button>
    </header>

    <div class="an-filters" bind:this={controls} role="group" aria-label="what to read">
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

      <button type="button" class="an-btn" title="read the window again (r)" onclick={() => void readNow()}>
        <Icon name="clock" small />read again
      </button>
    </div>

    {#if failed}
      <div class="an-body an-message">
        <p class="an-fail">could not read the window</p>
        <p class="an-note">{failed}</p>
      </div>
    {:else if !loaded || !model}
      <div class="an-body an-message">
        <p class="an-note">{busy ? "reading…" : "no answer yet"}</p>
      </div>
    {:else if empty}
      <div class="an-body an-message">
        <p class="an-empty">{empty.title}</p>
        <p class="an-note">{empty.note}</p>
      </div>
    {:else if showing === "room"}
      <AnalyticsRoom
        bind:this={room}
        window={loaded}
        series={model.series}
        kpis={model.kpis}
        measure={measure}
        split={split}
        {span}
        title={`${spanSaid} · ${measureSaid}${split ? ` · ${splitSaid}` : ""}`}
        bucket={bucket}
      />
    {:else}
      <div class="an-page">
        <AnalyticsPage
          bind:this={page}
          window={loaded}
          series={model.series}
          measure={measure}
          split={split}
          spanSaid={spanSaid}
          bucket={bucket}
          figure={model.figure}
          story={model.story}
        />
      </div>
    {/if}

    {#if readAt && !empty}
      <p class="an-read">read at {new Date(readAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</p>
    {/if}

    {#if views}
      <AnalyticsViews
        mode={views}
        surface={surface}
        onclose={closeViews}
        onopen={openView}
      />
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
    position: relative;
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
  /* The page's ground replaces the room's panel, and the room's footer note
     goes with it: a document does not have a "read at" line under the fold. */
  .an-room.reading {
    background: var(--cv-ground, var(--well));
    border-color: color-mix(in oklab, var(--edge) 55%, transparent);
  }
  .an-room.reading .an-read {
    display: none;
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
  .an-btn:hover {
    color: var(--paper);
    background: color-mix(in oklab, var(--paper) 7%, transparent);
  }
  .an-btn kbd {
    margin-left: 3px;
    font-family: var(--mono);
    font-size: 9.5px;
    color: var(--paper-faint);
    border: 1px solid var(--edge);
    border-radius: 4px;
    padding: 0 4px;
  }
  .an-pres {
    margin-left: 4px;
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
  .an-page {
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .an-read {
    position: absolute;
    right: 16px;
    bottom: 10px;
    margin: 0;
    font-size: 10px;
    color: var(--paper-faint);
  }
</style>
