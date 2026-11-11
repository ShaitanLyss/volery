<script lang="ts">
  /* The tour's wall, as something to touch rather than a picture of one.
   *
   * It borrows the wall's own vocabulary (territories, status colour, the
   * context ring) and none of its machinery: no Conversation, no process, no
   * store read. That is deliberate. A demo that needed a live card would cost
   * allowance and would fail in front of an audience the first time a process
   * did not come up.
   *
   * The one thing that moves is a turn you ask for. Nothing here animates at
   * rest, so the tour costs the GPU nothing while it is open and being read,
   * which is `motion.md`'s rule applied to a surface that covers the wall.
   */
  import CtxRing from "./CtxRing.svelte";
  import {
    PLANE_H,
    PLANE_W,
    SHOW_CARD_H,
    SHOW_CARD_W,
    STATUS_SAID,
    WALL_CARDS,
    WALL_TERRITORIES,
    type Status,
    type WallCard,
  } from "./showcase";

  let viewport = $state<HTMLElement>();
  let vw = $state(0);
  let vh = $state(0);
  let zoom = $state(0.8);
  let panX = $state(0);
  let panY = $state(0);
  let fitted = false;
  let dragging = $state(false);
  /** Whether the press has travelled far enough to be a drag. Until it has,
   *  the pointer is not captured, because capturing on `pointerdown` retargets
   *  the eventual click to the viewport and swallows every card's own click.
   *  That is the bug `Canvas.groundDown` exists to stop, and it bit here. */
  let captured = false;
  let moved = false;
  let fromX = 0;
  let fromY = 0;
  let panFromX = 0;
  let panFromY = 0;

  let selected = $state<string>("migration");
  let only = $state<Status | null>(null);
  /** A card's state while the scripted turn is playing. Cleared by replay. */
  let over = $state<{ id: string; status: Status; said: string } | null>(null);
  let beat = $state(-1);
  let timers: number[] = [];

  const minZoom = $derived(vw && vh ? Math.min(vw / PLANE_W, vh / PLANE_H) : 0.5);

  $effect(() => {
    if (!viewport) return;
    const ro = new ResizeObserver(([e]) => {
      vw = e.contentRect.width;
      vh = e.contentRect.height;
      if (fitted) keepInView();
    });
    ro.observe(viewport);
    return () => ro.disconnect();
  });

  $effect(() => {
    if (!vw || !vh || fitted) return;
    fit();
  });

  $effect(() => {
    return () => timers.forEach(clearTimeout);
  });

  function fit() {
    if (!vw || !vh) return;
    zoom = minZoom;
    panX = (vw - PLANE_W * zoom) / 2;
    panY = (vh - PLANE_H * zoom) / 2;
    fitted = true;
  }

  function clampPan() {
    const w = PLANE_W * zoom;
    const h = PLANE_H * zoom;
    panX = w >= vw ? Math.min(0, Math.max(vw - w, panX)) : Math.min(vw - w, Math.max(0, panX));
    panY = h >= vh ? Math.min(0, Math.max(vh - h, panY)) : Math.min(vh - h, Math.max(0, panY));
  }

  function keepInView() {
    clampPan();
  }

  function wheel(e: WheelEvent) {
    e.preventDefault();
    const box = viewport?.getBoundingClientRect();
    if (!box) return;
    const mx = e.clientX - box.left;
    const my = e.clientY - box.top;
    const top = minZoom * 2.4;
    const next = Math.min(top, Math.max(minZoom * 0.9, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    const k = next / zoom;
    panX = mx - (mx - panX) * k;
    panY = my - (my - panY) * k;
    zoom = next;
    clampPan();
  }

  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    dragging = true;
    captured = false;
    moved = false;
    fromX = e.clientX;
    fromY = e.clientY;
    panFromX = panX;
    panFromY = panY;
  }

  function move(e: PointerEvent) {
    if (!dragging) return;
    const dx = e.clientX - fromX;
    const dy = e.clientY - fromY;
    if (!captured) {
      if (Math.abs(dx) + Math.abs(dy) <= 4) return;
      captured = true;
      moved = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    panX = panFromX + dx;
    panY = panFromY + dy;
    clampPan();
  }

  function up(e: PointerEvent) {
    dragging = false;
    if (!captured) return;
    captured = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* the capture was already gone, which is not a failure */
    }
  }

  /** A status this card is wearing right now, which is the scripted turn's
   *  when it is that card and its own otherwise. */
  function statusOf(c: WallCard): Status {
    return over && over.id === c.id ? over.status : c.status;
  }

  function saidOf(c: WallCard): string {
    return over && over.id === c.id ? over.said : c.said;
  }

  function dim(c: WallCard): boolean {
    return only !== null && statusOf(c) !== only;
  }

  /** One card's turn, in four steps, asked for rather than looping. */
  function play() {
    timers.forEach(clearTimeout);
    timers = [];
    beat = 0;
    const steps: { at: number; status: Status; said: string }[] = [
      { at: 0, status: "work", said: "reading 2 files" },
      { at: 900, status: "work", said: "editing 3 files" },
      { at: 1800, status: "ask", said: "waiting on you: 1 question" },
      { at: 3600, status: "rest", said: "finished just now" },
    ];
    for (const s of steps) {
      timers.push(
        window.setTimeout(() => {
          over = { id: "notes", status: s.status, said: s.said };
          beat = steps.indexOf(s);
          selected = "notes";
        }, s.at),
      );
    }
  }

  const card = $derived(WALL_CARDS.find((c) => c.id === selected) ?? WALL_CARDS[0]);
</script>

<div class="showwall">
  <div class="frame">
    <div class="chalk">
      <span class="who">volery</span>
      <span class="sep">/</span>
      <span>portfolio</span>
      <span class="live"><b></b>{WALL_CARDS.filter((c) => c.status === "work").length} working</span>
    </div>

    <div
      class="viewport"
      bind:this={viewport}
      role="application"
      tabindex="-1"
      data-tour-focus
      aria-label="a demonstration wall. drag to pan, wheel to zoom, click a card."
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={up}
      onwheel={wheel}
    >
      <div
        class="plane"
        style:width={`${PLANE_W}px`}
        style:height={`${PLANE_H}px`}
        style:transform={`translate(${panX}px, ${panY}px) scale(${zoom})`}
        class:grabbing={dragging}
      >
        {#each WALL_TERRITORIES as t (t.name)}
          <div class="terr" style:left={`${t.x}px`} style:top={`${t.y}px`} style:width={`${t.w}px`} style:height={`${t.h}px`}>
            <span>{t.name}</span>
          </div>
        {/each}

        {#each WALL_CARDS as c (c.id)}
          {@const st = statusOf(c)}
          <button
            type="button"
            class="showcard"
            class:pick={selected === c.id}
            class:faded={dim(c)}
            data-st={st}
            style:left={`${c.x}px`}
            style:top={`${c.y}px`}
            style:width={`${SHOW_CARD_W}px`}
            style:height={`${SHOW_CARD_H}px`}
            aria-pressed={selected === c.id}
            onclick={() => {
              if (moved) return;
              selected = c.id;
            }}
          >
            <span class="proj">{c.project}<i>{c.model}</i></span>
            <span class="name">{c.title}</span>
            <span class="foot">
              <span class="pip" aria-hidden="true"></span>
              <span class="said">{saidOf(c)}</span>
              <span class="ring"><CtxRing ctx={c.ctx} dormant={st === "idle"} size={14} /></span>
            </span>
          </button>
        {/each}
      </div>
    </div>

    <div class="legend" role="group" aria-label="filter by state">
      {#each [["work", "working"], ["ask", "asking"], ["rest", "at rest"], ["fail", "failed"], ["idle", "dormant"]] as [s, word] (s)}
        <button
          type="button"
          class="key"
          class:on={only === s}
          onclick={() => (only = only === s ? null : (s as Status))}
          title={STATUS_SAID[s as Status]}
        ><i data-st={s}></i>{word}</button
        >
      {/each}
      <span class="spacer"></span>
      <button type="button" class="act" onclick={play}>{beat < 0 ? "play a turn" : "play it again"}</button>
    </div>
  </div>

  <div class="detail" aria-live="polite">
    <div class="dt">
      <span class="dproj">{card.project}</span>
      <span class="dname">{card.title}</span>
    </div>
    <dl class="dfacts">
      <div><dt>state</dt><dd data-st={statusOf(card)}>{saidOf(card)}</dd></div>
      <div><dt>model</dt><dd>{card.model}</dd></div>
      <div><dt>memory</dt><dd>{Math.round(card.ctx * 100)}% of its window</dd></div>
    </dl>
  </div>
</div>

<style>
  .showwall {
    display: grid;
    gap: 12px;
  }
  .frame {
    border-radius: 15px;
    overflow: hidden;
    border: 1px solid color-mix(in oklab, var(--edge) 82%, transparent);
    background: linear-gradient(180deg, color-mix(in oklab, var(--surface) 100%, var(--paper) 2%), var(--surface));
    box-shadow:
      0 1px 0 color-mix(in oklab, var(--paper) 5%, transparent) inset,
      0 30px 60px -42px var(--shade, #000);
  }
  .chalk {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
    padding: 0 13px;
    border-bottom: 1px solid color-mix(in oklab, var(--edge) 60%, transparent);
    color: var(--paper-mute);
    font-size: 11.5px;
  }
  .who {
    color: var(--paper-dim);
  }
  .sep {
    color: var(--paper-faint);
  }
  .live {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--st-work);
    font-size: 11px;
  }
  .live b {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--st-work);
    box-shadow: 0 0 7px var(--st-work);
  }
  .viewport {
    position: relative;
    height: 380px;
    overflow: hidden;
    cursor: grab;
    touch-action: none;
    background:
      radial-gradient(1px 1px at 10px 10px, color-mix(in oklab, var(--paper) 8%, transparent) 99%, transparent) 0 0 / 24px 24px,
      var(--ink);
  }
  .viewport:active {
    cursor: grabbing;
  }
  /* The shell focuses this so the tour's keys have somewhere to land, and a
     wall-sized amber focus ring is not a control's outline. The keyboard still
     works; the ring goes. */
  .viewport:focus,
  .viewport:focus-visible {
    outline: none;
  }
  .plane {
    position: absolute;
    left: 0;
    top: 0;
    transform-origin: 0 0;
    will-change: transform;
  }
  .plane.grabbing .showcard {
    cursor: grabbing;
  }
  .terr {
    position: absolute;
    border: 1px dashed color-mix(in oklab, var(--rule) 78%, transparent);
    border-radius: 12px;
    pointer-events: none;
  }
  .terr span {
    position: absolute;
    top: -9px;
    left: 12px;
    padding: 0 6px;
    background: var(--ink);
    color: var(--paper-mute);
    font-size: 10px;
    letter-spacing: 0.02em;
  }
  .showcard {
    position: absolute;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 9px;
    text-align: left;
    font: inherit;
    color: var(--paper-dim);
    border-radius: 7px;
    background: var(--surface);
    border: 1px solid var(--edge);
    box-shadow: 0 12px 22px -18px var(--shade, #000);
    cursor: pointer;
    transition:
      opacity var(--dur-quick, 160ms) var(--ease-out, ease-out),
      border-color var(--dur-quick, 160ms) var(--ease-out, ease-out),
      box-shadow var(--dur-quick, 160ms) var(--ease-out, ease-out);
  }
  .showcard:hover,
  .showcard:focus-visible {
    border-color: color-mix(in oklab, var(--edge) 45%, var(--paper) 30%);
    outline: none;
  }
  .showcard.faded {
    opacity: 0.26;
  }
  .showcard[data-st="work"] {
    border-color: color-mix(in oklab, var(--st-work) 52%, var(--edge));
    box-shadow:
      0 0 0 1px color-mix(in oklab, var(--st-work) 30%, transparent),
      0 0 26px -5px color-mix(in oklab, var(--st-work) 55%, transparent);
  }
  .showcard[data-st="ask"] {
    border-color: color-mix(in oklab, var(--st-ask) 62%, var(--edge));
    box-shadow:
      0 0 0 1px color-mix(in oklab, var(--st-ask) 42%, transparent),
      0 0 28px -5px color-mix(in oklab, var(--st-ask) 55%, transparent);
  }
  .showcard[data-st="fail"] {
    border-color: color-mix(in oklab, var(--st-fail) 48%, var(--edge));
  }
  .showcard[data-st="rest"] {
    background: var(--ink);
    border-style: dashed;
    box-shadow: none;
  }
  .showcard[data-st="idle"] {
    background: var(--ink);
    border-color: color-mix(in oklab, var(--edge) 90%, transparent);
  }
  .showcard.pick {
    outline: 2px solid color-mix(in oklab, var(--paper) 62%, transparent);
    outline-offset: 2px;
  }
  .proj {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 8.5px;
    letter-spacing: 0.02em;
    color: var(--paper-faint);
    white-space: nowrap;
    overflow: hidden;
  }
  .proj i {
    font-style: normal;
    margin-left: auto;
    color: var(--paper-faint);
    opacity: 0.8;
  }
  .name {
    font-size: 10.5px;
    line-height: 1.3;
    color: var(--paper-dim);
    height: 27px;
    overflow: hidden;
  }
  .showcard[data-st="rest"] .name,
  .showcard[data-st="idle"] .name {
    color: var(--paper-mute);
  }
  .foot {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: auto;
    font-size: 8.5px;
    color: var(--paper-mute);
    white-space: nowrap;
  }
  .pip {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    flex: none;
    background: var(--paper-faint);
  }
  .showcard[data-st="work"] .pip {
    background: var(--st-work);
    box-shadow: 0 0 7px var(--st-work);
  }
  .showcard[data-st="ask"] .pip {
    background: var(--st-ask);
    box-shadow: 0 0 7px var(--st-ask);
  }
  .showcard[data-st="rest"] .pip {
    background: var(--st-rest);
  }
  .showcard[data-st="fail"] .pip {
    background: var(--st-fail);
  }
  .said {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ring {
    margin-left: auto;
    display: flex;
    flex: none;
  }
  .legend {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 9px 11px;
    border-top: 1px solid color-mix(in oklab, var(--edge) 60%, transparent);
    flex-wrap: wrap;
  }
  .key {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 25px;
    padding: 0 9px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--paper-mute);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .key:hover {
    color: var(--paper-dim);
    background: color-mix(in oklab, var(--raised) 60%, transparent);
  }
  .key.on {
    color: var(--paper);
    border-color: var(--edge);
    background: var(--raised);
  }
  .key i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--paper-faint);
  }
  .key i[data-st="work"] {
    background: var(--st-work);
  }
  .key i[data-st="ask"] {
    background: var(--st-ask);
  }
  .key i[data-st="rest"] {
    background: var(--st-rest);
  }
  .key i[data-st="fail"] {
    background: var(--st-fail);
  }
  .key i[data-st="idle"] {
    background: var(--paper-faint);
  }
  .spacer {
    flex: 1;
  }
  .act {
    height: 27px;
    padding: 0 11px;
    border-radius: 7px;
    border: 1px solid color-mix(in oklab, var(--edge) 70%, var(--paper) 9%);
    background: linear-gradient(180deg, color-mix(in oklab, var(--raised) 100%, var(--paper) 5%), var(--raised));
    color: var(--paper);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }
  .act:hover {
    border-color: color-mix(in oklab, var(--edge) 45%, var(--paper) 25%);
  }
  .detail {
    display: grid;
    gap: 10px;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    padding: 0 2px;
  }
  .dt {
    display: grid;
    gap: 2px;
  }
  .dproj {
    font-size: 10.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  .dname {
    font: 15px/1.35 var(--body);
    color: var(--paper);
  }
  .dfacts {
    display: flex;
    gap: 22px;
    margin: 0;
  }
  .dfacts div {
    display: grid;
    gap: 2px;
  }
  .dfacts dt {
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  .dfacts dd {
    margin: 0;
    font-size: 12px;
    color: var(--paper-dim);
    white-space: nowrap;
  }
  .dfacts dd[data-st="work"] {
    color: var(--st-work);
  }
  .dfacts dd[data-st="ask"] {
    color: var(--st-ask);
  }
  .dfacts dd[data-st="fail"] {
    color: var(--st-fail);
  }
  @media (max-width: 760px) {
    .detail {
      grid-template-columns: 1fr;
    }
    .dfacts {
      flex-wrap: wrap;
      row-gap: 10px;
    }
  }
</style>
