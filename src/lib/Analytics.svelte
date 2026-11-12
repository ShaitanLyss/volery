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
   * spend window is read here once, folded into series here once, and the same
   * `RoomSeries[]` is handed to whichever face is in front — which is what
   * makes the numbers agree across the swap by construction (§11.15). The work
   * tab reads its own window (three commands, `analyticsworkread.svelte.ts`)
   * and is folded into one `WorkModel` here, for the same reason.
   *
   * **It reads, it does not poll.** One read on open, one whenever the span
   * changes, one more after the collector's minute has gone by (a single
   * one-shot timer, not an interval), and one if you ask with `r`. The work
   * tab adds one read per entry to it, and nothing while it is not in front.
   * On close the component unmounts, which clears the timer; a read still in
   * flight lands on a dead component and is dropped by the generation counter
   * rather than writing into the next opening. The filter does not cost a read:
   * it cuts the rows already here, which is the cheaper and the more honest of
   * the two (a re-read would answer the same window with the same rows).
   *
   * Keyboard: `v` swaps the presentation, `[` `]` step the span, `f` goes to
   * the controls, `r` reads again, `s` saves a view, `l` opens the library,
   * `p` hangs what is on screen on the wall as a widget,
   * `1` `2` `3` choose a tab, Escape leaves. The spend tab adds `m` for the
   * measure and `g` for the split; the work tab adds `x` for its scatter
   * measure. The room's own keys (`t` for its table, the arrows or `j`/`k` to
   * walk buckets, Home and End) are handed to it, because they are about that
   * drawing; the page's arrows scroll the document. The keys left to the
   * surface are the surface's in both drawings, so a span changes the same way
   * in either.
   */
  import { onMount, tick, untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import AnalyticsRoom from "./AnalyticsRoom.svelte";
  import AnalyticsPage from "./AnalyticsPage.svelte";
  import AnalyticsPrompts from "./AnalyticsPrompts.svelte";
  import AnalyticsWork from "./AnalyticsWork.svelte";
  import AnalyticsWorkPage from "./AnalyticsWorkPage.svelte";
  import AnalyticsViews from "./AnalyticsViews.svelte";
  import FilterRail from "./FilterRail.svelte";
  import { readAnalyticsWindow } from "./analyticsread.svelte";
  import { loadSavedViews, savedViews } from "./analyticslibrary.svelte";
  import { dropWatch, readWatches, readWorkWindow } from "./analyticsworkread.svelte";
  import type { SpendWatch } from "./spend";
  import { prompts as realPrompts } from "./promptsread.svelte";
  import {
    presentation,
    openPresentation,
    setPresentation,
    surface,
    swapPresentation,
    adoptSurface,
    tab,
    openTab,
    setTab,
  } from "./analyticsview.svelte";
  import {
    ROOM_MEASURES,
    ROOM_SPLITS,
    SPANS,
    emptinessOf,
    roomBucket,
    tierSaid,
    windowRequest,
    windowTier,
    type AnalyticsWindow,
    type SlotBook,
    type RoomSplit,
    type WindowReader,
  } from "./analyticsroom";
  import {
    pageModel,
    surfaceOfView,
    surfaceRows,
    viewMatches,
    viewOfSurface,
    type HostMode,
    type Presentation,
  } from "./analyticpage";
  import {
    SCATTER_MEASURES,
    WORK_SPANS,
    scatterMeasureFor,
    workModelOf,
    workSpanFor,
    type ScatterMeasure,
    type WorkBundle,
    type WorkModel,
    type WorkReader,
  } from "./analyticswork";
  import { spanMsOf, type ViewSpec } from "./analytics";
  import type { PromptReader, SurfaceTab } from "./analyticstrace";
  import { count } from "./usage";
  import { view } from "./view.svelte";

  let {
    read,
    prompts,
    work,
    names,
    onclose,
    onpin,
    mode = view.current,
    as,
    asTab,
    watches = readWatches,
    unwatch = dropWatch,
  }: {
    /** The command, or a fixture. Absent means the real one. */
    read?: WindowReader;
    /** The prompt trace's reader, or a fixture. Absent means the commands. */
    prompts?: PromptReader;
    /** The work read, or a fixture. Absent means the three commands. */
    work?: WorkReader;
    /** The watches one card set on itself, or a fixture. Absent means the
     *  command; the browser preview has no wall to ask. */
    watches?: (card: string) => Promise<SpendWatch[]>;
    unwatch?: (card: string, id: number) => Promise<boolean>;
    /** Conversation id → what the wall calls it, for the work tab's rows. A
     *  card that has since closed keeps its short id, which is all the store
     *  still has. */
    names?: ReadonlyMap<string, string>;
    onclose: () => void;
    /** Which host is underneath: it only picks the *default* presentation,
     *  and never changes when `v` swaps them (§11.15). */
    mode?: HostMode;
    /** An explicit presentation asked for as it opened — `space b d` is the
     *  room, `space n n` the page. Absent means the remembered one for the
     *  mode, which is what the sidebar row and a plain open mean. */
    as?: Presentation;
    /** An explicit tab asked for as it opened: `space n t` is the trace.
     *  Absent means the remembered tab. */
    asTab?: SurfaceTab;
    /** Hang this question on the wall as a widget (§12). The overlay hands the
     *  spec and, where the surface is showing exactly a saved view, that view's
     *  id — a widget pointing at one is a *reading* that every edit to the view
     *  moves, and one carrying a copy is its own. */
    onpin?: (what: { spec: ViewSpec; shared: string | null }) => void;
  } = $props();

  /* The remembered choices, read once, before the first frame — an effect would
     paint the room and then flip to the page. An explicit request is a choice
     too, so it is remembered. */
  untrack(() => {
    openPresentation(mode);
    if (as) setPresentation(as);
    openTab(asTab);
  });

  const tabNow = $derived(tab.current);

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
  let rail = $state<ReturnType<typeof FilterRail>>();
  let room = $state<ReturnType<typeof AnalyticsRoom> | undefined>();
  let page = $state<ReturnType<typeof AnalyticsPage> | undefined>();
  let promptsTab = $state<ReturnType<typeof AnalyticsPrompts> | undefined>();
  let workTab = $state<ReturnType<typeof AnalyticsWork> | undefined>();
  let workPage = $state<ReturnType<typeof AnalyticsWorkPage> | undefined>();

  /* The work tab's own read. It is asked for only while that tab is in front:
     the spend window is cheap enough to keep warm, three more queries over a
     week of work facts are not, and a tab nobody is looking at owes nothing. */
  let workLoaded = $state<WorkBundle | null>(null);
  let workFailed = $state<string | null>(null);
  let workBusy = $state(false);
  let workReadAt = $state<number | null>(null);
  let workFrom = $state(0);
  let workTo = $state(0);
  let workGen = 0;
  let workMeasure = $state<ScatterMeasure>("merged");

  /* A closure rather than the prop itself: a prop read outside one captures
     its initial value, which is exactly the bug a fixture that swapped its
     reader at runtime would be impossible to see. */
  const reader: WindowReader = (span, now) => (read ?? readAnalyticsWindow)(span, now);
  const workReader: WorkReader = (from, to) => (work ?? readWorkWindow)(from, to);

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

  async function readWork() {
    const mine = ++workGen;
    workBusy = true;
    /* The work tab asks the longest window the fine tier can answer, never the
       spend tab's year: `usage_fact` and `work_fact` stop at ninety days, and
       a year of commits against ninety days of dollars is not a pair (§3.6). */
    const req = windowRequest(workSpan, Date.now());
    try {
      const next = await workReader(req.since, req.until);
      if (mine !== workGen) return;
      workLoaded = next;
      workFrom = req.since;
      workTo = req.until;
      workReadAt = Date.now();
      workFailed = null;
    } catch (e) {
      if (mine !== workGen) return;
      workFailed = e instanceof Error ? e.message : String(e);
      workLoaded = null;
    } finally {
      if (mine === workGen) workBusy = false;
    }
  }

  /* One read on open and one per span change. Nothing else re-reads, and the
     effect has no other dependency because the reader's own arguments are the
     span alone. The selection a presentation holds is its own: the room clears
     its own when the span changes, because the bucket it remembers is not in
     the new axis, and this effect does not touch it so the 65-second refresh
     cannot drop your place.
     The tab is read untracked: switching tabs must not re-read the spend
     window, but a span change while the work tab is up must refresh it too. */
  $effect(() => {
    void span;
    void readNow();
    if (untrack(() => tab.current) === "work") void readWork();
  });

  /* Entering the work tab is its own read, because it was not loaded while the
     money was in front. This is one read per entry, not a subscription. The
     starting value is read untracked: a surface opened straight onto `space n w`
     is already on the tab, and the span effect above has done that first read.
     A span the work facts cannot answer (the spend tab's year) is narrowed
     here, visibly, and the span effect performs the one read. */
  let wasWork = untrack(() => tab.current === "work");
  $effect(() => {
    const on = tab.current === "work";
    if (on && !wasWork) {
      if (workSpan !== span) surface.span = workSpan;
      else void readWork();
    }
    wasWork = on;
  });

  /* The collector writes once a minute, so an untouched surface goes stale by
     at most that much. This is one refresh, not a poll, and `onMount` is how
     that is structural rather than argued: a mount hook runs exactly once and
     never again, where an effect is a thing that may re-run. `onMount`'s
     cleanup runs when the surface closes, so one left before the minute costs
     nothing and one left open costs one read. */
  onMount(() => {
    const t = setTimeout(() => {
      void readNow();
      if (tab.current === "prompts") void promptsTab?.reload();
      if (tab.current === "work") void readWork();
    }, 65_000);
    return () => clearTimeout(t);
  });

  /* ── what it means, once ─────────────────────────────────────────────── */

  const spanMs = $derived(spanMsOf(span) ?? 7 * 24 * 3_600_000);
  const tier = $derived(windowTier(spanMs));
  const bucket = $derived(roomBucket(spanMs, tier));
  /* The work tab's own window: the same shared span while it is answerable,
     and the longest one that is when it is not. */
  const workSpan = $derived(workSpanFor(span, spanMs));
  const spanChoices = $derived(tabNow === "work" ? WORK_SPANS : SPANS);

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

  /* A filter can select nothing, and that is a different reading from a window
     with nothing recorded in it (`emptinessOf` only ever looks at the window).
     Said here rather than drawn as an empty axis with zeroed tiles, which would
     read as a quiet week rather than as a question nobody answers (§11.9's
     honesty rules). */
  const matched = $derived(loaded ? surfaceRows(loaded, surface.filter).length : 0);
  const narrowed = $derived(loaded !== null && loaded.rows.length > 0 && matched === 0);

  /* The work tab reads its own window and folds it once, here, so both skins
     are handed the same value (§11.15). The "nothing recorded" state is the
     spend read's own knowledge; without it the work tab still draws, it just
     cannot tell a first minute from a quiet week. */
  const workModel = $derived.by<WorkModel | null>(() => {
    if (!workLoaded) return null;
    return workModelOf({
      rows: workLoaded.rows,
      series: workLoaded.series,
      overlaps: workLoaded.overlaps,
      invalidations: workLoaded.invalidations,
      overlapsUnread: workLoaded.overlapsUnread,
      invalidationsUnread: workLoaded.invalidationsUnread,
      names,
      measure: workMeasure,
      from: workFrom,
      to: workTo,
      span: workSpan,
      scratch: {
        /* `first` and `recorded` are only computed for an empty spend window;
           on any other window they mean "not asked", not "nothing there". */
        outsideKnown: loaded !== null && loaded.rows.length === 0,
        never: loaded !== null && loaded.rows.length === 0 && loaded.first === null,
        recorded: loaded !== null && loaded.rows.length === 0 ? loaded.recorded : 0,
        first: loaded?.first ?? null,
      },
    });
  });

  const spanSaid = $derived(SPANS.find((s) => s.span === span)?.said ?? span);
  const workSpanSaid = $derived(WORK_SPANS.find((s) => s.span === workSpan)?.said ?? workSpan);
  const measureSaid = $derived(ROOM_MEASURES.find((m) => m.key === measure)?.said ?? measure);
  const splitSaid = $derived(split ? `by ${split}` : "no split");

  /* ── the library (§11.6) ─────────────────────────────────────────────── */

  let views = $state<"save" | "list" | null>(null);
  /* The library row the surface was last opened from, so a pin binds to *that*
     view. Two saved views can ask the same question, and a search by equality
     would pick whichever the list happens to order first — a widget titled with
     a view you were not looking at, whose edits move it and whose twin's do
     not. Cleared whenever the question changes away from it. */
  let openedId = $state<string | null>(null);

  function openView(spec: ViewSpec, id?: string) {
    adoptSurface(surfaceOfView(spec));
    openedId = id ?? null;
    views = null;
    void tick().then(() => root?.focus());
  }

  /* What is on screen, hung on the wall — the gesture that makes a reading a
     thing rather than a place you go (§12). It shares when the surface is
     asking exactly a saved view's question, so pinning a view you opened from
     the library does not quietly make a second copy of it; anything else is a
     copy of its own, which is the honest record of a question nobody saved. */
  async function pinCurrent() {
    if (!onpin) return;
    const name = `${spanSaid} · ${measureSaid}${split ? ` by ${split}` : ""}`;
    let spec = viewOfSurface(surface, name);
    let shared: string | null = null;
    try {
      const list = savedViews.ready ? savedViews.list : await loadSavedViews();
      /* The view this question was opened from wins, if it still asks it. */
      const from = openedId ? list.find((v) => v.id === openedId) : undefined;
      const one = from && viewMatches(from.view, surface) ? from : list.find((v) => viewMatches(v.view, surface));
      if (one) {
        shared = one.id;
        spec = one.view;
      }
    } catch {
      /* The library is a convenience here rather than the point: a copy is
         still a correct answer when it cannot be asked. */
    }
    onpin({ spec, shared });
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
    void tab.current;
    holdFocus();
  });

  $effect(() => () => cameFrom?.focus?.());

  /* ── verbs ───────────────────────────────────────────────────────────── */

  function stepSpan(delta: number) {
    const list = tab.current === "work" ? WORK_SPANS : SPANS;
    const i = list.findIndex((s) => s.span === span);
    const next = list[Math.min(list.length - 1, Math.max(0, (i === -1 ? 0 : i) + delta))];
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
    /* The prompts tab wants several of the same letters, and it decides about
       them before the surface does: Escape closes a detail or a confirmation
       before it closes the surface, a field blurs rather than taking the whole
       tab away. It answers `true` only for a key it actually used. */
    if (tabNow === "prompts" && promptsTab?.key(e)) return;
    /* The work tab's episode detail is closed by Escape before the surface is,
       the same order the trace keeps. */
    if (tabNow === "work" && workTab?.key(e)) return;

    const target = e.target as HTMLElement | null;
    if (target?.closest("input, textarea, select, [contenteditable='true']")) return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onclose();
      return;
    }
    /* Everything else is the surface's while it is up, including the letters
       the wall would otherwise take into the composer. */
    e.stopPropagation();
    /* The tabs are on `1`, `2` and `3`, and are the surface's in either
       drawing. */
    if (e.key === "1") {
      e.preventDefault();
      setTab("spend");
      return;
    }
    if (e.key === "2") {
      e.preventDefault();
      setTab("prompts");
      return;
    }
    if (e.key === "3") {
      e.preventDefault();
      setTab("work");
      return;
    }
    if (e.key === "v") {
      e.preventDefault();
      swap();
      return;
    }
    /* The prompts tab's own verbs are its own. `r` is the one the shell still
       owes it, because the read is the surface's refresh rule. */
    if (tabNow === "prompts") {
      if (e.key === "r") {
        e.preventDefault();
        void promptsTab?.reload();
      }
      return;
    }
    /* The work tab keeps the span and the read, changes its scatter measure on
       `x`, and walks its document with the arrows. Its measure and split are
       the money tab's question, so `m` and `g` mean nothing here. */
    if (tabNow === "work") {
      const workDoc = showing === "room" ? workTab : workPage;
      if (e.key === "[") {
        e.preventDefault();
        stepSpan(-1);
      } else if (e.key === "]") {
        e.preventDefault();
        stepSpan(1);
      } else if (e.key === "x") {
        e.preventDefault();
        workMeasure = workMeasure === "merged" ? "net" : "merged";
      } else if (e.key === "r") {
        e.preventDefault();
        void readWork();
      } else if (e.key === "f") {
        e.preventDefault();
        controls?.querySelector<HTMLButtonElement>("button")?.focus();
      } else if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        workDoc?.scrollBy(64);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        workDoc?.scrollBy(-64);
      } else if (e.key === "PageDown") {
        e.preventDefault();
        workDoc?.turnPage(1);
      } else if (e.key === "PageUp") {
        e.preventDefault();
        workDoc?.turnPage(-1);
      } else if (e.key === "Home") {
        e.preventDefault();
        workDoc?.goTo("top");
      } else if (e.key === "End") {
        e.preventDefault();
        workDoc?.goTo("bottom");
      }
      return;
    }
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
    } else if (e.key === "r") {
      e.preventDefault();
      void readNow();
    } else if (e.key === "f") {
      /* §11.5: `f` is the filter row. The rail is that row now; the span,
         measure and split controls keep their own arrow keys and Tab, so
         nothing became mouse-only by the key moving. */
      e.preventDefault();
      if (rail && tabNow === "spend") rail.focus();
      else controls?.querySelector<HTMLButtonElement>("button")?.focus();
    } else if (e.key === "s") {
      e.preventDefault();
      views = "save";
    } else if (e.key === "l") {
      e.preventDefault();
      views = "list";
    } else if (e.key === "p" && tabNow === "spend") {
      /* The pin hangs the *spend* question, so it is the spend tab's key. On
         the prompts or work tab there is no view to pin and pinning the money
         would be a widget about a tab you are not looking at. */
      e.preventDefault();
      void pinCurrent();
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
          {#if tabNow === "prompts"}
            prompt trace · form only · bodies sealed under the vault
          {:else if tabNow === "work"}
            {workSpanSaid} · artifacts and what they cost
            {#if workLoaded && workLoaded.rows.length > 0}· {count(workLoaded.rows.length)} facts{/if}
          {:else}
            {spanSaid} · {tierSaid(loaded?.tier ?? tier)}
            {#if loaded && loaded.rows.length > 0}· {count(loaded.rows.length)} rows{/if}
          {/if}
        </p>
      </div>
      <!-- One surface, three tabs (§11.11, §11.14): the money, the words, and
           cost against output. The tab is a choice of the surface's own and
           survives a presentation swap, which draws the same tab in the other
           skin. -->
      <div
        class="an-tabs"
        role="tablist"
        tabindex="-1"
        aria-label="which reading"
        onkeydown={(e) =>
          radioKeys(
            e,
            3,
            tabNow === "spend" ? 0 : tabNow === "prompts" ? 1 : 2,
            (i) => setTab(i === 0 ? "spend" : i === 1 ? "prompts" : "work"),
          )}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tabNow === "spend"}
          class:on={tabNow === "spend"}
          title="the money (1)"
          onclick={() => setTab("spend")}>spend <kbd>1</kbd></button
        >
        <button
          type="button"
          role="tab"
          aria-selected={tabNow === "prompts"}
          class:on={tabNow === "prompts"}
          title="the prompt trace and the hall (2, or space n t)"
          onclick={() => setTab("prompts")}>prompts <kbd>2</kbd></button
        >
        <button
          type="button"
          role="tab"
          aria-selected={tabNow === "work"}
          class:on={tabNow === "work"}
          title="cost against output (3, or space n w)"
          onclick={() => setTab("work")}>work <kbd>3</kbd></button
        >
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
      <span class="an-keys">{tabNow === "prompts" ? "space n t" : tabNow === "work" ? "space n w" : "space b d"}</span>
      {#if tabNow === "spend"}
        <button type="button" class="an-btn" title="saved views (s saves one, l opens the library)" onclick={() => (views = "list")}>
          <Icon name="pin" small />views
        </button>
        {#if onpin}
          <button
            type="button"
            class="an-btn"
            title="hang this on the wall (p)"
            onclick={() => void pinCurrent()}
          >
            <Icon name="pin" small />on the wall
          </button>
        {/if}
      {/if}
      <button type="button" class="an-btn an-close" title="close (esc)" aria-label="close" onclick={onclose}>
        <Icon name="x" small />
      </button>
    </header>

    {#if tabNow === "spend" || tabNow === "work"}
    <div class="an-filters" bind:this={controls} role="group" aria-label="what to read">
      <span class="an-label">span</span>
      <div
        class="an-seg"
        role="radiogroup"
        tabindex="-1"
        aria-label="span"
        onkeydown={(e) => radioKeys(e, spanChoices.length, spanChoices.findIndex((s) => s.span === span), (i) => (surface.span = spanChoices[i].span))}
      >
        {#each spanChoices as s (s.span)}
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

      {#if tabNow === "spend"}
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
      {:else}
        <span class="an-label">against cost</span>
        <div
          class="an-seg"
          role="radiogroup"
          tabindex="-1"
          aria-label="what the scatter plots against cost"
          onkeydown={(e) =>
            radioKeys(e, SCATTER_MEASURES.length, SCATTER_MEASURES.findIndex((m) => m.key === workMeasure), (i) => (workMeasure = SCATTER_MEASURES[i].key))}
        >
          {#each SCATTER_MEASURES as m (m.key)}
            <button
              type="button"
              role="radio"
              aria-checked={workMeasure === m.key}
              class:on={workMeasure === m.key}
              title={`${m.said} (x switches it)`}
              onclick={() => (workMeasure = scatterMeasureFor(m.key))}>{m.label}</button
            >
          {/each}
        </div>
      {/if}

      <span class="an-grow"></span>

      <button
        type="button"
        class="an-btn"
        title="read the window again (r)"
        onclick={() => void (tabNow === "work" ? readWork() : readNow())}
      >
        <Icon name="clock" small />read again
      </button>
    </div>
    {/if}

    <!-- The rail is the spend tab's: the work and prompts tabs read different
         fact tables, whose dimensions are not these and whose filters would be
         a vocabulary that lies. -->
    {#if tabNow === "spend"}
      <FilterRail
        bind:this={rail}
        filter={surface.filter}
        rows={loaded?.rows ?? []}
        onchange={(next) => (surface.filter = next)}
      />
      {#if narrowed}
        <p class="an-narrowed">
          no rows in this window match these filters.
          <button type="button" onclick={() => (surface.filter = {})}>clear them</button>
        </p>
      {/if}
    {/if}

    {#if tabNow === "prompts"}
      <AnalyticsPrompts bind:this={promptsTab} reader={prompts ?? realPrompts} presentation={showing} />
    {:else if tabNow === "work"}
      {#if workFailed}
        <div class="an-body an-message">
          <p class="an-fail">could not read the work facts</p>
          <p class="an-note">{workFailed}</p>
        </div>
      {:else if !workLoaded || !workModel}
        <div class="an-body an-message">
          <p class="an-note">{workBusy ? "reading…" : "no answer yet"}</p>
        </div>
      {:else if showing === "room"}
        <div class="an-page">
          <AnalyticsWork
            bind:this={workTab}
            model={workModel}
            from={workFrom}
            to={workTo}
            spanSaid={workSpanSaid}
            measure={workMeasure}
            onmeasure={(m) => (workMeasure = m)}
            {watches}
            {unwatch}
          />
        </div>
      {:else}
        <div class="an-page">
          <AnalyticsWorkPage
            bind:this={workPage}
            model={workModel}
            from={workFrom}
            to={workTo}
            spanSaid={workSpanSaid}
            measure={workMeasure}
          />
        </div>
      {/if}
    {:else if failed}
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

    {#if tabNow === "work"}
      {#if workReadAt && workModel && !workModel.empty}
        <p class="an-read">read at {new Date(workReadAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</p>
      {/if}
    {:else if readAt && !empty && tabNow === "spend"}
      <p class="an-read">read at {new Date(readAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</p>
    {/if}

    {#if views}
      <AnalyticsViews
        mode={views}
        surface={surface}
        onclose={closeViews}
        onopen={openView}
        onhang={onpin ? (row) => onpin?.({ spec: row.view, shared: row.id }) : undefined}
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
  /* The tabs are a choice of the surface's own, so they sit beside the
     title rather than in the filter row: they change what the whole overlay is
     about, not what one chart is asking. */
  .an-tabs {
    display: inline-flex;
    align-items: stretch;
    gap: 2px;
    margin-left: 6px;
    align-self: stretch;
  }
  .an-tabs button {
    border: 0;
    border-bottom: 1px solid transparent;
    background: transparent;
    color: var(--paper-mute);
    font: 11.5px var(--cv-ui, var(--util));
    padding: 2px 10px 1px;
    cursor: pointer;
  }
  .an-tabs button:hover {
    color: var(--paper);
  }
  .an-tabs button.on {
    color: var(--paper);
    border-bottom-color: color-mix(in oklab, var(--paper) 62%, transparent);
  }
  .an-tabs button kbd {
    font-family: var(--mono);
    font-size: 9px;
    color: var(--paper-faint);
    border: 1px solid var(--edge);
    border-radius: 4px;
    padding: 0 3px;
    margin-left: 3px;
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
  /* A filter that selects nothing. It stands above the room rather than inside
     it, because the room would draw an empty axis and a strip of zeroes, which
     reads as a quiet window rather than as a question with no answer. */
  .an-narrowed {
    flex: none;
    margin: 0;
    padding: 8px 16px;
    font-size: 12px;
    color: var(--paper-mute);
    border-bottom: 1px solid var(--cv-hair, var(--edge));
  }
  .an-narrowed button {
    border: 0;
    background: transparent;
    color: var(--paper);
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
    padding: 0 2px;
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
