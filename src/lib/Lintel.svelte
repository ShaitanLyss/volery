<script lang="ts">
  /* The timelines on the glass: a stack at the top centre for every plate
   * nobody has moved, and each moved one where it was put. Named for the beam
   * across the top of a window, which is where the stack hangs — and not
   * `Timelines`, which is `timelines.svelte.ts` to a case-insensitive
   * filesystem (`Carry.svelte` has the same note about `Portage`).
   *
   * On the glass rather than on the wall because a timeline is a reading you
   * want in front of you wherever you have panned to — the glass's whole
   * argument (`.claude/rules/glass.md`). 1:1, unzoomed, over the transcript and
   * never over the dock, all of which the pane gives for free.
   *
   * The stack is a flex column and nothing more: a plate that has not been
   * moved has no position of its own, so a new one arriving pushes the others
   * down rather than landing on top of them, and archiving one closes the gap.
   * Dragging one takes it out of the stack at the spot it was drawn, and
   * double-clicking a moved one puts it back.
   *
   * The press is a click until it has travelled — the wall's rule, with the
   * wall's slop (`layout.md`). A click selects the card that drew it. */

  import type { Tier } from "./classify";
  import Frise from "./Frise.svelte";
  import { Z_TOP } from "./layout";
  import type { Timeline } from "./timeline";

  let {
    timelines,
    pane,
    ownerOf,
    onpick,
    onjump,
    onarchive,
    onplace,
  }: {
    timelines: Timeline[];
    /** The part of the glass plates live in. `x`/`y` are its offset inside the
     *  glass, non-zero only while the studio is spread over every screen —
     *  the layer is placed over it, so everything below stays relative. */
    pane: { x?: number; y?: number; w: number; h: number };
    /** The owning card's reading, or null when it is not on the wall. */
    ownerOf: (id: string) => { tier: Tier; handle: string } | null;
    onpick: (ownerId: string) => void;
    onjump: (t: Timeline, rev: number) => void;
    onarchive: (id: string) => void;
    onplace: (id: string, x: number | null, y: number | null) => void;
  } = $props();

  /** The wall's slop — `Canvas.svelte`'s `DRAG_SLOP`, the same four pixels
   *  everything else on this wall waits for before a press becomes a drag. */
  const DRAG_SLOP = 4;

  const stacked = $derived(timelines.filter((t) => t.glassX === null || t.glassY === null));
  const placed = $derived(timelines.filter((t) => t.glassX !== null && t.glassY !== null));

  /** Which plate has a hover card open, if any.
   *
   *  The layer sits under the front band on purpose — a widget brought forward
   *  should cover a plate that is merely standing there — and it isolates, so
   *  `.hc`'s z-index cannot reach past it. The consequence was a hover card
   *  drawn *behind* a raised widget, which is the one moment the plate is not
   *  merely standing there: you are reading it. So while a card is open the
   *  whole layer rides over the front band and goes back the moment it closes.
   *  Bounded by the pointer, which is the same bargain `.plate:hover` strikes
   *  one level in. */
  let reading = $state<string | null>(null);
  /** Guarded against a plate that went away while it was being read — a lifted
   *  layer with nothing open in it would quietly cover every widget. */
  const lifted = $derived(reading !== null && timelines.some((t) => t.id === reading));

  let layer = $state<HTMLDivElement | null>(null);
  /** Measured sizes, for keeping a moved plate fully on the pane. */
  let dims = $state<Record<string, { w: number; h: number }>>({});

  function measure(id: string) {
    return (el: HTMLElement) => {
      const ro = new ResizeObserver(() => {
        dims[id] = { w: el.offsetWidth, h: el.offsetHeight };
      });
      ro.observe(el);
      return () => ro.disconnect();
    };
  }

  /** Fully inside the pane, clamped where it is drawn rather than where it is
   *  stored — `glass.ts::glassAt`'s bargain: a narrower window borrows it back
   *  from the edge and a wider one gives it straight back. An unmeasured pane
   *  clamps nothing. */
  function spot(t: Timeline, x: number, y: number): { x: number; y: number } {
    const d = dims[t.id];
    if (!pane.w || !pane.h || !d) return { x, y };
    return {
      x: Math.max(0, Math.min(x, pane.w - d.w)),
      y: Math.max(0, Math.min(y, pane.h - d.h)),
    };
  }

  let held = $state<{
    id: string;
    ownerId: string;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    moved: boolean;
    el: HTMLElement;
    pointer: number;
  } | null>(null);
  let drag = $state<{ id: string; x: number; y: number } | null>(null);

  function down(t: Timeline, e: PointerEvent) {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    held = {
      id: t.id,
      ownerId: t.ownerId,
      sx: e.clientX,
      sy: e.clientY,
      ox: 0,
      oy: 0,
      moved: false,
      el,
      pointer: e.pointerId,
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function move(e: PointerEvent) {
    const h = held;
    if (!h) return;
    if (!h.moved) {
      if (Math.hypot(e.clientX - h.sx, e.clientY - h.sy) < DRAG_SLOP) return;
      h.moved = true;
      /* Taken from where it is drawn, stacked or not — so lifting a plate out
         of the stack leaves it exactly under the pointer rather than jumping. */
      const box = h.el.getBoundingClientRect();
      const origin = layer?.getBoundingClientRect();
      h.ox = box.left - (origin?.left ?? 0);
      h.oy = box.top - (origin?.top ?? 0);
      h.el.setPointerCapture?.(h.pointer);
    }
    const t = timelines.find((x) => x.id === h.id);
    if (!t) return;
    drag = { id: h.id, ...spot(t, h.ox + e.clientX - h.sx, h.oy + e.clientY - h.sy) };
  }

  function up() {
    const h = held;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    held = null;
    if (!h) return;
    if (h.el.hasPointerCapture?.(h.pointer)) h.el.releasePointerCapture(h.pointer);
    if (h.moved && drag) {
      onplace(h.id, Math.round(drag.x), Math.round(drag.y));
      /* The click this release is about to produce is the drag's, not a
         press on the plate. */
      dragged = true;
    }
    drag = null;
  }

  /** Whether the click now arriving ends a drag rather than being one. */
  let dragged = false;

  /** A press that did not travel lands on the card that drew the plate — on
   *  the *click*, and only the first of a double-click's two, so putting a
   *  moved plate back with a double-click is not also two landings. */
  function click(t: Timeline, e: MouseEvent) {
    if (dragged) {
      dragged = false;
      return;
    }
    if (e.detail > 1) return;
    onpick(t.ownerId);
  }

  $effect(() => () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
  });
</script>

{#snippet plate(t: Timeline)}
  {@const owner = ownerOf(t.ownerId)}
  <Frise
    {t}
    tier={owner?.tier ?? "rest"}
    handle={owner?.handle ?? t.ownerId.slice(0, 8)}
    canJump={!!owner}
    onjump={(rev) => onjump(t, rev)}
    onarchive={() => onarchive(t.id)}
    onreading={(open) => (reading = open ? t.id : reading === t.id ? null : reading)}
  />
{/snippet}

<div
  class="timelines"
  bind:this={layer}
  style:z-index={lifted ? Z_TOP : undefined}
  style:left={pane.x ? `${pane.x}px` : undefined}
  style:top={pane.y ? `${pane.y}px` : undefined}
  style:width={pane.x || pane.y ? `${pane.w}px` : undefined}
  style:height={pane.x || pane.y ? `${pane.h}px` : undefined}
>
  <div class="stack">
    {#each stacked as t (t.id)}
      {#if drag?.id !== t.id}
        <div
          class="hold"
          onpointerdown={(e) => down(t, e)}
          onclick={(e) => click(t, e)}
          role="presentation"
          {@attach measure(t.id)}
        >
          {@render plate(t)}
        </div>
      {/if}
    {/each}
  </div>

  {#each timelines as t (t.id)}
    {@const p = drag?.id === t.id ? drag : t.glassX !== null && t.glassY !== null ? spot(t, t.glassX, t.glassY) : null}
    {#if p && (drag?.id === t.id || placed.includes(t))}
      <div
        class="hold placed"
        class:dragging={drag?.id === t.id}
        style:left="{p.x}px"
        style:top="{p.y}px"
        onpointerdown={(e) => down(t, e)}
        onclick={(e) => click(t, e)}
        ondblclick={() => onplace(t.id, null, null)}
        role="presentation"
        title="double-click to put it back in the stack"
        {@attach measure(t.id)}
      >
        {@render plate(t)}
      </div>
    {/if}
  {/each}
</div>

<style>
  /* Inert, and each plate takes that back — the pane's own bargain, so an empty
     stretch of the stack does not swallow a pan or a scroll in the transcript. */
  .timelines {
    position: absolute;
    inset: 0;
    pointer-events: none;
    /* Over the cards and chips stuck to the glass (`Z_CARD`, `Z_CHIP` in
       `layout.ts`) and under the front band (`Z_FRONT`): a plan is read across
       the whole pane, and a card stuck at the top centre would otherwise sit
       on it and take its clicks. Its own stacking context, so a plate's hover
       z-index orders plates among themselves and nothing else. */
    z-index: 1500;
    isolation: isolate;
  }
  .stack {
    position: absolute;
    top: 14px;
    left: 0;
    right: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }
  .hold {
    position: relative;
    pointer-events: auto;
    cursor: default;
  }
  .hold:hover {
    z-index: 2;
  }
  .placed {
    position: absolute;
  }
  .dragging {
    z-index: 3;
    cursor: grabbing;
  }
</style>
