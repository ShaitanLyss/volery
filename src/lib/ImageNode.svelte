<script lang="ts">
  import type { RefImage } from "./images.svelte";

  let {
    img,
    src,
    selected,
    scale,
    toCanvas,
    onupdate,
    onremove,
  }: {
    img: RefImage;
    src: string;
    selected: boolean;
    /** Canvas zoom, so handles stay a constant size on screen. */
    scale: number;
    toCanvas: (clientX: number, clientY: number) => { x: number; y: number };
    onupdate: (patch: Partial<RefImage>) => void;
    onremove: () => void;
  } = $props();

  /* Moving one is not in here any more, and the two gestures that are left is
     the whole of what this file still owns.
     A reference can be selected alongside a card, a widget and a project now, and
     dragging any member of a selection moves all of it — so the move has to be
     the wall's rather than each thing moving only itself. `Canvas` hears the
     press through one capture-phase handler on the surface (`handleOf` finds
     this node by its `data-image`) and applies one delta to everything held.
     Scaling and rotating stay here, because they are about this image and no
     amount of selection makes them mean anything else. Their grips are marked
     `data-grip`, which is what tells `handleOf` to leave a press on one alone —
     being a `button` is not enough and must not be, since a card's whole body is
     one. */

  /** Handles are drawn in canvas units but should feel the same size at every
   *  zoom level, so they shrink as the world grows. */
  const hs = $derived(11 / scale);

  type Gesture =
    | { kind: "scale"; w0: number; h0: number; cx: number; cy: number; d0: number }
    | { kind: "rotate"; r0: number; a0: number; cx: number; cy: number };

  let gesture: Gesture | null = null;

  const centre = () => ({ x: img.x + img.w / 2, y: img.y + img.h / 2 });

  function begin(e: PointerEvent, kind: Gesture["kind"]) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = toCanvas(e.clientX, e.clientY);
    const c = centre();

    if (kind === "scale") {
      gesture = {
        kind,
        w0: img.w,
        h0: img.h,
        cx: c.x,
        cy: c.y,
        d0: Math.max(1, Math.hypot(p.x - c.x, p.y - c.y)),
      };
    } else {
      gesture = {
        kind,
        r0: img.rotation,
        a0: Math.atan2(p.y - c.y, p.x - c.x),
        cx: c.x,
        cy: c.y,
      };
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function move(e: PointerEvent) {
    if (!gesture) return;
    e.stopPropagation();
    const p = toCanvas(e.clientX, e.clientY);

    if (gesture.kind === "scale") {
      /* Distance from the centre, so scaling behaves the same whatever angle
         the image is sitting at. Aspect ratio is preserved — a reference is
         wrong if it is stretched. */
      const d = Math.hypot(p.x - gesture.cx, p.y - gesture.cy);
      const f = Math.max(0.05, d / gesture.d0);
      const w = Math.max(24, gesture.w0 * f);
      const h = Math.max(24, gesture.h0 * f);
      onupdate({ w, h, x: gesture.cx - w / 2, y: gesture.cy - h / 2 });
    } else {
      const a = Math.atan2(p.y - gesture.cy, p.x - gesture.cx);
      let deg = gesture.r0 + ((a - gesture.a0) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      onupdate({ rotation: deg });
    }
  }

  function end(e: PointerEvent) {
    if (!gesture) return;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    gesture = null;
  }
</script>

<div
  class="ref"
  data-image={img.id}
  class:selected
  style:left="{img.x}px"
  style:top="{img.y}px"
  style:width="{img.w}px"
  style:height="{img.h}px"
  style:transform="rotate({img.rotation}deg)"
  style:z-index={img.z}
  role="presentation"
>
  <img {src} alt="" draggable="false" />

  {#if selected}
    <!-- Handles live outside the image so they stay grabbable on a dark photo. -->
    <!-- `data-grip` is how `Canvas.handleOf` knows to leave a press here alone.
         These three run gestures of their own, and the wall's own drag is on an
         ancestor in the capture phase — so `e.stopPropagation()` here cannot
         stop it and the marker has to be in the DOM for it to read. -->
    <button
      data-grip
      class="grip rotate"
      style:width="{hs}px"
      style:height="{hs}px"
      style:top="{-hs * 2.4}px"
      style:margin-left="{-hs / 2}px"
      onpointerdown={(e) => begin(e, "rotate")}
      onpointermove={move}
      onpointerup={end}
      aria-label="Rotate (hold shift to snap)"
    ></button>
    <span class="stem" style:height="{hs * 2.4}px"></span>

    <button
      data-grip
      class="grip size"
      style:width="{hs}px"
      style:height="{hs}px"
      style:right="{-hs / 2}px"
      style:bottom="{-hs / 2}px"
      onpointerdown={(e) => begin(e, "scale")}
      onpointermove={move}
      onpointerup={end}
      aria-label="Resize"
    ></button>

    <button
      data-grip
      class="grip shut"
      style:width="{hs}px"
      style:height="{hs}px"
      style:right="{-hs / 2}px"
      style:top="{-hs / 2}px"
      onclick={onremove}
      aria-label="Remove image"
    ></button>
  {/if}
</div>

<style>
  .ref {
    position: absolute;
    transform-origin: center;
    cursor: grab;
    /* No border by default: a reference board should show the reference, not
       a gallery of frames. Selection is what earns chrome. */
    outline: 1px solid transparent;
    transition: outline-color 0.15s ease;
  }
  .ref:active {
    cursor: grabbing;
  }
  .ref:hover {
    outline-color: var(--edge);
  }
  .ref.selected {
    outline-color: var(--paper-faint);
  }

  .ref img {
    width: 100%;
    height: 100%;
    display: block;
    object-fit: fill;
    user-select: none;
    -webkit-user-drag: none;
  }

  .grip {
    position: absolute;
    padding: 0;
    border: 1px solid var(--ink);
    background: var(--paper-dim);
    border-radius: 50%;
    cursor: pointer;
    z-index: 2;
  }
  .grip:hover {
    background: var(--paper);
  }
  .grip.rotate {
    left: 50%;
  }
  .grip.size {
    border-radius: 2px;
    cursor: nwse-resize;
  }
  .grip.shut {
    background: var(--st-fail);
  }
  .grip.shut:hover {
    background: color-mix(in srgb, var(--st-fail) 70%, var(--paper));
  }

  /* The little stalk that says "this handle spins the thing". */
  .stem {
    position: absolute;
    left: 50%;
    top: 0;
    width: 1px;
    transform: translate(-50%, -100%);
    background: var(--paper-faint);
    pointer-events: none;
  }
</style>
