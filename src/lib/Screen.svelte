<script lang="ts">
  /* A machine's monitor, live: the one tile every surface draws a screen with
   * — the `screen` widget on the wall, chat view's sheet, and each cell of the
   * grid of every screen. One component rather than three, because the three
   * differ only in where they stand and whether a click drives or opens.
   *
   * The picture is two canvases this component makes and immediately gives
   * away — `transferControlToOffscreen` hands them to the session's worker
   * (`cast.worker.ts`), which decodes and paints there. Nothing on this thread
   * ever holds a frame; what this file draws is the header, and what it hears
   * is a state word and a stats line twice a second (`casts.showing`).
   *
   * Driving is the browser widget's arrangement (`Browser.svelte`), one step
   * further: the stage is `data-live` so the wall's gestures leave it alone,
   * the wheel is stopped before the wall zooms on it, and keys are swallowed
   * while it has focus so neither `onGlobalKey` nor the leader ever sees them.
   * **Escape goes to the machine too** — a remote desktop whose Escape belonged
   * to the wall is one you cannot close a dialog on — and *holding* it is the
   * way out (`cast.ts::EscapeHold`, Lyss's pick), as it is out of the
   * immersive overlay. **The first click into a tile that does not have focus
   * only takes focus**: on a wall you drag things across, a press that landed
   * on somebody's desktop because it started a few pixels too far right is a
   * click nobody meant.
   *
   * The event-to-bytes half is `castinput.ts` (the input lane's); this file
   * owns the listeners, the letterbox and the focus, and hands bytes to the
   * holder, which hands them to the worker, which sends them on the same
   * socket the frames arrive on.
   *
   * Paints no background of its own: on the wall `WidgetNode` is the only
   * thing that fills. The stage's black is the letterbox, as the browser's is. */

  import { untrack, type Snippet } from "svelte";
  import { casts, useEscapeHold, type Room } from "./cast.svelte";
  import { fitIn, monitorLabel, parseScreen, stateWords, statsLine, PRIMARY } from "./cast";
  import { keyInput, pointerInput, releaseAll, wheelAccumulator } from "./castinput";

  let {
    sid,
    screen: key,
    scale = 1,
    interactive = true,
    room = "wall",
    calm = false,
    onopen,
    actions,
  }: {
    /** The session's id: a widget's own, or `chat:`/`grid:` and the key. */
    sid: string;
    /** Which screen, as `cast.ts::screenKey` writes it. */
    screen: string;
    /** The wall's zoom, for a tile drawn on it. */
    scale?: number;
    /** Whether clicks and keys reach the machine. */
    interactive?: boolean;
    room?: Room;
    /** The widget's `calm` reading — a frame a second while only watched. */
    calm?: boolean;
    /** A tile that opens rather than drives — a cell in the grid. When set, a
     *  click is this and nothing reaches the machine. */
    onopen?: () => void;
    /** More buttons for the header, before `immersive` — chat view's sheet
     *  offers "float" there. */
    actions?: Snippet;
  } = $props();

  const showing = $derived(casts.showing[sid] ?? null);
  const monitor = $derived(casts.monitorOf(key));
  const isFocused = $derived(casts.focused === sid);
  const drivable = $derived(interactive && !onopen);

  /* The header's two halves: what this is, then how it is going. */
  const name = $derived.by(() => {
    const where = casts.machineOf(key);
    const far = parseScreen(key).host;
    if (monitor) return { where, what: monitorLabel(monitor, far ? [monitor] : casts.monitors) };
    return { where, what: parseScreen(key).monitor === PRIMARY ? "main screen" : "a screen not plugged in" };
  });
  const note = $derived(showing ? stateWords(showing.state, showing.why) : "connecting…");
  const line = $derived(showing ? statsLine(showing.stats, showing.path) : "");

  /* ── the surface ─────────────────────────────────────────────────────── */

  let stage = $state<HTMLDivElement | null>(null);

  /** Make the two canvases and give them to a worker. Runs once per stage
   *  element: a canvas can be transferred once, and a second attach over the
   *  same one would throw inside an effect. The screen it shows is read
   *  untracked, and a change of knob retargets the live session below rather
   *  than tearing the surface down. */
  function surface(el: HTMLDivElement) {
    const video = document.createElement("canvas");
    const overlay = document.createElement("canvas");
    video.className = "video";
    overlay.className = "cursor";
    el.append(video, overlay);
    /* All of it untracked, not only the arguments: `attach` reads the
       holder's state (the monitor list, to resolve the role) and writes it
       (the session's first reading), and an attachment that tracked the read
       re-ran on its own write — the loop a lab found as
       `effect_update_depth_exceeded` and a tile stuck on "connecting". */
    const { id, off, unobserve } = untrack(() => {
      const id = sid;
      const off = casts.attach(id, key, video, overlay, room);
      return { id, off, unobserve: casts.observe(id, el) };
    });
    const ro = new ResizeObserver(() => {
      /* Layout size, which a CSS transform does not change: wall units. The
         zoom is applied in `casts.size` from the prop. */
      casts.size(id, el.clientWidth, el.clientHeight, untrack(() => scale));
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      unobserve();
      off();
      video.remove();
      overlay.remove();
    };
  }

  /* Each of these tracks only its own props: the holder reads its own state
     to decide what to ask the host, and that is not a reason to run again. */
  $effect(() => {
    const [id, k] = [sid, key];
    untrack(() => casts.retarget(id, k));
  });

  $effect(() => {
    const [id, c] = [sid, calm];
    untrack(() => casts.setCalm(id, c));
  });

  $effect(() => {
    const s = scale;
    const el = stage;
    if (el) untrack(() => casts.size(sid, el.clientWidth, el.clientHeight, s));
  });

  /* ── driving ─────────────────────────────────────────────────────────── */

  let driving = $state(false);
  const wheel = wheelAccumulator();
  const live = $derived(drivable && showing?.state === "live");

  /** Where the picture is in client pixels, for `castinput` to normalise a
   *  pointer against. The source's shape decides the letterbox; before any
   *  config there is no picture to point at. */
  function fitNow(): { x: number; y: number; w: number; h: number } | null {
    if (!stage) return null;
    const cfg = showing?.config;
    const src = monitor ? { w: monitor.w, h: monitor.h } : cfg ? { w: cfg.w, h: cfg.h } : null;
    if (!src) return null;
    const r = stage.getBoundingClientRect();
    const f = fitIn(src, { w: r.width, h: r.height });
    return { x: r.left + f.x, y: r.top + f.y, w: f.w, h: f.h };
  }

  function begin() {
    if (driving || !live) return;
    driving = true;
    casts.drive(sid, true);
  }

  function end() {
    escape.cancel();
    if (!driving) return;
    driving = false;
    casts.input(sid, releaseAll());
    casts.drive(sid, false);
  }

  /* Holding Escape lets go of the tile, the way it leaves the immersive
     overlay; a tap is the machine's. */
  const escape = useEscapeHold(
    () => sid,
    () => stage?.blur(),
  );

  function onDown(e: PointerEvent) {
    const el = e.currentTarget as HTMLElement;
    if (onopen) {
      if (e.button === 0) onopen();
      return;
    }
    if (!live) return;
    if (document.activeElement !== el) {
      /* Focus only: see the note at the top. */
      el.focus();
      e.preventDefault();
      return;
    }
    const fit = fitNow();
    if (!fit) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    casts.input(sid, pointerInput(e, fit, "down"));
  }

  function onUp(e: PointerEvent) {
    if (!driving) return;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    const fit = fitNow();
    if (!fit) return;
    casts.input(sid, pointerInput(e, fit, "up"));
  }

  function onMove(e: PointerEvent) {
    if (!driving) return;
    const fit = fitNow();
    if (!fit) return;
    casts.input(sid, pointerInput(e, fit, "move"));
  }

  /** Taken off the wall, which zooms on every wheel it hears — the browser
   *  widget's `onWheel` and its reasoning. Only while driving: a tile you are
   *  watching is a thing on the wall, and the wall should zoom past it. */
  function onWheel(e: WheelEvent) {
    if (!driving) return;
    e.preventDefault();
    e.stopPropagation();
    casts.input(sid, wheel(e));
  }

  function onKey(e: KeyboardEvent) {
    if (!driving) return;
    /* Swallowed whether or not it maps: a key this tile cannot send still
       must not fall through to the wall's ladder while you are typing into a
       machine — a stray letter would land in a card's draft. */
    e.preventDefault();
    e.stopPropagation();
    if (e.code === "Escape" || e.key === "Escape") {
      if (e.type === "keydown") escape.down();
      else escape.up();
      return;
    }
    casts.input(sid, keyInput(e));
  }

  /* Leaving with something held lifts it on the far side — a key-up that never
     arrives is a key held down for ever. */
  $effect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") end();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  });

  /* A tile that stops being drivable mid-drive lets go. */
  $effect(() => {
    if (!live) untrack(end);
  });
</script>

<div class="screen" class:driving class:opens={!!onopen}>
  <header>
    <span class="dot" data-state={showing?.state ?? "connecting"}></span>
    <span class="name" title={`${name.where} · ${name.what}`}>
      <span class="where">{name.where}</span>
      <span class="what">{name.what}</span>
    </span>
    <span class="stats">{line}</span>
    {#if showing?.state === "ended" || showing?.state === "refused"}
      <button class="act" title="dial it again" onclick={() => casts.reconnect(sid)}>again</button>
    {/if}
    {@render actions?.()}
    {#if !onopen}
      <button
        class="act"
        title="immersive — the screen fills the window; hold esc to come back (space then r f)"
        disabled={!showing || showing.state !== "live"}
        onclick={() => casts.focus(sid)}>immersive</button
      >
    {/if}
  </header>

  <!-- `data-live`: the wall's gestures leave it alone, as they do the browser
       widget's page. `role="application"` for that widget's reason — its keys
       belong to something else — and the same two ignores, stated. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="stage"
    bind:this={stage}
    data-live={drivable ? "" : undefined}
    data-screen={sid}
    role="application"
    tabindex={drivable ? 0 : -1}
    aria-label={onopen
      ? `${name.where} · ${name.what} — click to open it`
      : "a screen — click to take the keyboard, then click and type to drive it; hold esc to let go"}
    style:cursor={onopen ? "pointer" : driving ? (showing?.cursor ?? "default") : "default"}
    {@attach surface}
    onfocus={begin}
    onblur={end}
    onpointerdown={onDown}
    onpointerup={onUp}
    onpointermove={onMove}
    onwheel={onWheel}
    onkeydown={onKey}
    onkeyup={onKey}
    oncontextmenu={(e) => {
      if (driving) {
        e.preventDefault();
        e.stopPropagation();
      }
    }}
  >
    {#if isFocused}
      <p class="note">immersive — hold esc there to come back</p>
    {:else if note}
      <p class="note">{note}</p>
    {/if}
    {#if escape.holding}
      <span class="hold" aria-hidden="true"></span>
    {/if}
  </div>
</div>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    font-size: 11px;
    color: var(--paper-dim);
  }

  header {
    display: flex;
    align-items: center;
    gap: 0.5em;
    height: 22px;
    flex: none;
    padding: 0 0.5em;
    white-space: nowrap;
    overflow: hidden;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex: none;
    background: var(--paper-faint);
  }
  /* Colour is status: celadon while frames are arriving, amber when the far
     machine is locked (it wants somebody at it), rust when it ended or
     refused. Connecting and paused are the absence of news. */
  .dot[data-state="live"] {
    background: var(--st-work);
  }
  .dot[data-state="locked"] {
    background: var(--st-ask);
  }
  .dot[data-state="ended"],
  .dot[data-state="refused"] {
    background: var(--st-fail);
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .where {
    color: var(--paper);
  }
  .what {
    color: var(--paper-faint);
  }
  .stats {
    margin-left: auto;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }
  .act {
    font: inherit;
    color: var(--paper-dim);
    background: var(--raised);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0 0.35em;
    cursor: pointer;
  }
  .act:hover:not(:disabled) {
    color: var(--paper);
  }
  .act:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    /* The letterbox, black on every skin — the browser widget's reasoning. */
    background: #000;
  }
  .stage:focus-visible,
  .driving .stage {
    /* Focus decides whether your keys go to the machine or to the wall, so it
       is drawn rather than suppressed. */
    outline: 1px solid var(--st-work);
    outline-offset: -1px;
  }
  .opens .stage:hover {
    outline: 1px solid var(--paper-faint);
    outline-offset: -1px;
  }

  .stage :global(canvas) {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
  /* The bitmap painter's canvas takes the frame's own size; CSS letterboxes. */
  .stage :global(canvas.video) {
    object-fit: contain;
  }

  .note {
    position: absolute;
    inset: auto 0 0 0;
    margin: 0;
    padding: 0.4em 0.6em;
    color: var(--paper-dim);
    font-size: 11px;
    text-align: center;
    pointer-events: none;
    /* Over the canvases, which the attachment appends after it. */
    z-index: 1;
  }

  /* The hold filling, a ring at the top centre: what you are doing is said
     while you do it, so leaving is never a surprise. */
  .hold {
    position: absolute;
    top: 8px;
    left: 50%;
    width: 18px;
    height: 18px;
    margin-left: -9px;
    border-radius: 50%;
    z-index: 2;
    background: conic-gradient(var(--paper) var(--hold-at, 0%), var(--paper-faint) 0);
    -webkit-mask: radial-gradient(circle, transparent 5px, #000 6px);
    mask: radial-gradient(circle, transparent 5px, #000 6px);
    animation: cast-hold 500ms linear forwards;
  }
  @property --hold-at {
    syntax: "<percentage>";
    inherits: false;
    initial-value: 0%;
  }
  @keyframes cast-hold {
    to {
      --hold-at: 100%;
    }
  }
</style>
