<script lang="ts">
  /* One picture, full size, over everything — see `looking.svelte.ts` for why
     it mounts itself into the studio root.

     The looking-closer arithmetic is `zoom.ts`'s, the same the gallery's
     magnifier stands on: fit the box, zoom at the pointer, pan within the
     clamp. One thing differs and it is passed rather than forked: `native`,
     one picture pixel per screen pixel, caps the floor — so a small picture
     opens at the size it is rather than blown up to fill the window, and `1`
     always means "every pixel this picture has, and no more". An svg's size is
     CSS pixels already, so it is sharp at any zoom; a raster past twice its
     pixels is drawn `pixelated`, which is what looking at pixels should look
     like rather than a blur pretending to be detail.

     The keyboard reaches all of it: Enter on a picture opened it, Escape closes
     it, `+` `-` `0` `1` zoom, the arrows pan, Tab walks the bar and stays inside
     the dialog, and focus goes back to the picture you came from. */
  import { untrack } from "svelte";
  import type { Shown } from "./looking.svelte";
  import {
    STEP,
    canPan,
    centreOf,
    fitView,
    isActual,
    isFit,
    panBy,
    readout,
    wheelFactor,
    zoomBy,
    zoomTo,
    type Size,
    type View,
  } from "./zoom";

  let { shown }: { shown: Shown } = $props();

  const lit = $derived(shown.current);
  let stage = $state<HTMLElement | null>(null);
  let box = $state<Size>({ w: 0, h: 0 });
  let view = $state<View>({ scale: 1, x: 0, y: 0 });
  /** Whether you have moved it — until then a resize refits it. */
  let touched = false;
  let dragging = $state<{ x: number; y: number; id: number } | null>(null);

  /* The picture at one of its pixels per screen pixel, in the CSS pixels the
     stage is measured in. An svg's own size is CSS pixels by definition. */
  const vp = $derived<Size>(
    lit
      ? lit.svg
        ? { w: lit.w, h: lit.h }
        : { w: lit.w / (window.devicePixelRatio || 1), h: lit.h / (window.devicePixelRatio || 1) }
      : { w: 1, h: 1 },
  );

  $effect(() => {
    if (!stage) return;
    const ro = new ResizeObserver(() => {
      const r = stage!.getBoundingClientRect();
      box = { w: r.width, h: r.height };
      if (!untrack(() => touched)) view = fitView(box, untrack(() => vp), 1);
      else view = untrack(() => zoomTo(view, view.scale, centreOf(box), box, vp, 1));
    });
    ro.observe(stage);
    return () => ro.disconnect();
  });

  /* A new picture opens fitted, and takes the keyboard. */
  $effect(() => {
    if (!lit) return;
    touched = false;
    untrack(() => {
      if (box.w) view = fitView(box, vp, 1);
    });
    requestAnimationFrame(() => stage?.focus({ preventScroll: true }));
  });

  const set = (next: View) => {
    touched = true;
    view = next;
  };

  /* Escape belongs to whatever is innermost, and while this is open that is
     this — captured on the window so it lands before `App.svelte`'s ladder,
     which would otherwise stop the focused card's turn. The gallery does the
     same, and for the same reason. */
  $effect(() => {
    if (!lit) return;
    const onkey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        shown.close();
        return;
      }
      if (e.key === "Tab") return trap(e);
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      /* A button in the bar keeps its own Enter and Space. */
      const at = centreOf(box);
      const p = Math.max(40, Math.min(box.w, box.h) / 6);
      let next: View | null = null;
      switch (e.key) {
        case "+":
        case "=":
          next = zoomBy(view, STEP, at, box, vp, 1);
          break;
        case "-":
        case "_":
          next = zoomBy(view, 1 / STEP, at, box, vp, 1);
          break;
        case "0":
          next = fitView(box, vp, 1);
          break;
        case "1":
          next = zoomTo(view, 1, at, box, vp, 1);
          break;
        case "ArrowLeft":
          next = panBy(view, p, 0, box, vp, 1);
          break;
        case "ArrowRight":
          next = panBy(view, -p, 0, box, vp, 1);
          break;
        case "ArrowUp":
          next = panBy(view, 0, p, box, vp, 1);
          break;
        case "ArrowDown":
          next = panBy(view, 0, -p, box, vp, 1);
          break;
      }
      /* Every other key is stopped too while this is open, or a printable one
         would reach the wall's ladder and land in the focused card's draft. */
      e.stopPropagation();
      if (!next) return;
      e.preventDefault();
      set(next);
    };
    window.addEventListener("keydown", onkey, true);
    return () => window.removeEventListener("keydown", onkey, true);
  });

  let dialog = $state<HTMLElement | null>(null);

  /** Tab walks the dialog and stays in it. */
  function trap(e: KeyboardEvent) {
    e.stopPropagation();
    if (!dialog) return;
    const stops = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex='0']")];
    if (!stops.length) return;
    const i = stops.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (i <= 0 ? stops.length - 1 : i - 1) : i === -1 || i === stops.length - 1 ? 0 : i + 1;
    e.preventDefault();
    stops[next].focus();
  }

  function local(e: { clientX: number; clientY: number }) {
    const r = stage!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onwheel(e: WheelEvent) {
    e.preventDefault();
    set(zoomBy(view, wheelFactor(e.deltaY, e.deltaMode), local(e), box, vp, 1));
  }

  function ondown(e: PointerEvent) {
    if (e.button !== 0 || !canPan(view, box, vp)) return;
    dragging = { x: e.clientX, y: e.clientY, id: e.pointerId };
    stage?.setPointerCapture(e.pointerId);
  }
  function onmove(e: PointerEvent) {
    if (!dragging || e.pointerId !== dragging.id) return;
    const dx = e.clientX - dragging.x;
    const dy = e.clientY - dragging.y;
    dragging = { ...dragging, x: e.clientX, y: e.clientY };
    set(panBy(view, dx, dy, box, vp, 1));
  }
  function onup(e: PointerEvent) {
    if (dragging?.id === e.pointerId) dragging = null;
  }

  /** Double-click toggles between the whole picture and every pixel of it, at
   *  the place you double-clicked. */
  function ondbl(e: MouseEvent) {
    const fit = isFit(view, box, vp, 1);
    set(fit ? zoomTo(view, isActual(view) ? 2 : 1, local(e), box, vp, 1) : fitView(box, vp, 1));
  }

  /** A click on the dark around the picture puts it away, as a click outside
   *  any dialog here does; a click on the picture itself does not. */
  function onground(e: MouseEvent) {
    if (e.target === e.currentTarget) shown.close();
  }

  const pixels = $derived(!!lit && !lit.svg && view.scale > 2);
</script>

{#if lit}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="light" onclick={onground}>
    <div
      class="sheet"
      role="dialog"
      aria-modal="true"
      aria-label={`${lit.name} — full size`}
      bind:this={dialog}
    >
      <div class="bar">
        <span class="name" title={lit.name}>{lit.name}</span>
        <span class="dims">{lit.w} × {lit.h}</span>
        <span class="readout" title="one picture pixel per screen pixel is 100%">{readout(view.scale)}</span>
        <span class="tools">
          <button
            type="button"
            class:on={isFit(view, box, vp, 1)}
            title="the whole picture (0)"
            onclick={() => set(fitView(box, vp, 1))}>fit</button
          >
          <button
            type="button"
            class:on={isActual(view)}
            title="every pixel it has, one per screen pixel (1)"
            onclick={() => set(zoomTo(view, 1, centreOf(box), box, vp, 1))}>100%</button
          >
          <button
            type="button"
            title="closer (+)"
            aria-label="zoom in"
            onclick={() => set(zoomBy(view, STEP, centreOf(box), box, vp, 1))}>+</button
          >
          <button
            type="button"
            title="further (−)"
            aria-label="zoom out"
            onclick={() => set(zoomBy(view, 1 / STEP, centreOf(box), box, vp, 1))}>−</button
          >
          {#if lit.go}
            <button type="button" title="open it in the file viewer" onclick={() => lit.go?.("open")}
              >open</button
            >
            <button type="button" title="show it in Explorer" onclick={() => lit.go?.("reveal")}
              >explorer</button
            >
          {/if}
          <button type="button" class="shut" title="close (escape)" aria-label="close" onclick={() => shown.close()}
            >×</button
          >
        </span>
      </div>
      <!-- The stage takes the keyboard on open, so the keys above work at once;
           it is the one focusable thing that is not a button. An `application`
           in ARIA's sense — a widget whose keys are its own — which the lint
           does not count as interactive. -->
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div
        class="stage"
        class:pans={canPan(view, box, vp)}
        class:dragging={!!dragging}
        class:paper={lit.paper}
        tabindex="0"
        role="application"
        aria-roledescription="picture viewer"
        aria-label={`${lit.alt || lit.name} — plus and minus zoom, arrows pan, 0 fits, 1 is every pixel`}
        bind:this={stage}
        {onwheel}
        onpointerdown={ondown}
        onpointermove={onmove}
        onpointerup={onup}
        onpointercancel={onup}
        ondblclick={ondbl}
      >
        <img
          src={lit.url}
          alt=""
          draggable="false"
          decoding="async"
          class:pixels
          style:left={`${view.x}px`}
          style:top={`${view.y}px`}
          style:width={`${vp.w * view.scale}px`}
          style:height={`${vp.h * view.scale}px`}
        />
      </div>
      {#if lit.caption}<div class="caption">{lit.caption}</div>{/if}
    </div>
  </div>
{/if}

<style>
  /* Above the gallery (60, 61), since a picture can be opened from inside a
     question it is drawing. Opaque enough that the wall behind is context, not
     competition — the backdrop is alive, and a leaf drifting across a picture
     being read is the wrong kind of movement. */
  .light {
    position: fixed;
    inset: 0;
    z-index: 62;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.4rem;
    background: color-mix(in srgb, var(--well, var(--ink)) 90%, transparent);
    animation: rise 120ms ease-out;
  }
  .sheet {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: min(96cqw, 140rem);
    height: min(94cqh, 100rem);
    padding: 0.6rem;
    border: 1px solid var(--rule, var(--edge));
    border-radius: 6px;
    /* Opaque, like everything standing over the wall. */
    background: var(--surface);
  }
  .bar {
    display: flex;
    align-items: baseline;
    gap: 0.8rem;
    font-family: var(--util);
    font-size: 0.78rem;
    color: var(--paper-mute);
    min-width: 0;
  }
  .name {
    color: var(--paper);
    font-family: var(--mono);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .dims,
  .readout {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .tools {
    margin-left: auto;
    display: flex;
    gap: 0.3rem;
    flex: none;
  }
  .tools button {
    font: inherit;
    padding: 0.1rem 0.5rem;
    color: var(--paper-dim);
    background: var(--ink);
    border: 1px solid var(--edge);
    border-radius: 3px;
    cursor: pointer;
  }
  .tools button:hover,
  .tools button:focus-visible {
    color: var(--paper);
    border-color: var(--paper-faint);
  }
  .tools button.on {
    color: var(--paper);
    border-color: var(--paper-faint);
  }
  .stage {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    border-radius: 4px;
    background: var(--ink);
    outline: none;
    cursor: default;
  }
  .stage:focus-visible {
    box-shadow: inset 0 0 0 1px var(--paper-faint);
  }
  /* A diagram drawn for a white page, as in the column. */
  .stage.paper img {
    background: #fff;
  }
  .stage.pans {
    cursor: grab;
  }
  .stage.dragging {
    cursor: grabbing;
  }
  .stage img {
    position: absolute;
    max-width: none;
    user-select: none;
    -webkit-user-drag: none;
  }
  .stage img.pixels {
    image-rendering: pixelated;
  }
  .caption {
    font-family: var(--util);
    font-size: 0.82rem;
    color: var(--paper-dim);
  }
  @keyframes rise {
    from {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .light {
      animation: none;
    }
  }
  :global(html[data-motion="still"]) .light {
    animation: none;
  }
</style>
