<script lang="ts">
  /* Designs, side by side, over the wall.
   *
   * The CLI can only ever *describe* a layout, so an agent with three of them
   * to offer writes three paragraphs and you choose by imagining. There is a
   * webview here, so the option can carry the thing itself.
   *
   * Why this is not in the dock: `.ask` is `max-height: min(52vh, 30rem)` and
   * grows upward into the wall, and three mockups there is the dock eating the
   * studio — the same argument that made the questions be asked one at a time.
   * It is also the opposite job. Questions are answered one at a time because a
   * decision read alone is decided alone; *options within one* question are
   * already all shown at once, and comparison is the entire reason a design
   * preview is worth having. So they get a surface, and the surface is over
   * everything, because while you are looking at it there is nothing else to do.
   *
   * The frame is the security boundary and it has two halves. `sandbox` here,
   * with `allow-scripts` and deliberately **no** `allow-same-origin`: an opaque
   * origin, so no parent DOM, no `window.__TAURI__` through `window.parent`, no
   * storage, no navigation, no modals. And the CSP inside the document
   * (`previewDoc`), which is what closes network egress, since `tauri.conf.json`
   * has `"csp": null` and nothing else would.
   */

  import { onMount, untrack } from "svelte";
  import {
    PREVIEW_VIEWPORT,
    isScriptBuilt,
    previewDoc,
    type PreviewPanel,
  } from "./asking";
  import {
    STEP,
    canPan,
    centreOf,
    clampView,
    fitView,
    isActual,
    isFit,
    panBy,
    readout,
    wheelFactor,
    zoomBy,
    zoomTo,
    type View,
  } from "./zoom";

  let {
    panels,
    header,
    scripts,
    onchoose,
    onclose,
  }: {
    panels: PreviewPanel[];
    /** What is being decided, for the one line at the top. */
    header: string;
    /** Whether a preview from this card may run script at all — decided by what
     *  kind of card asked, never by the payload. See below. */
    scripts: boolean;
    onchoose: (label: string) => void;
    onclose: () => void;
  } = $props();

  /** Skein's own custom properties, so a mockup is judged on the decision
   *  rather than on whether the agent guessed the greys.
   *
   *  Read off the live `:root` rules rather than listed here: a token added to
   *  `tokens.css` tomorrow reaches previews without anybody remembering this
   *  file. Wrapped, because `cssRules` throws on a stylesheet the document does
   *  not own, and a preview with no palette is a smaller loss than a gallery
   *  that fails to open. */
  let tokens = $state("");
  /** Nothing is framed until the palette has been collected. One tick, and it
   *  buys every preview a single load rather than one without the tokens and a
   *  second with them — which on a design with a transition is a mockup you
   *  watch play twice before you can read it. */
  let ready = $state(false);
  onMount(() => {
    const decls: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSStyleRule) || rule.selectorText !== ":root") {
          continue;
        }
        for (const name of Array.from(rule.style)) {
          if (name.startsWith("--")) {
            decls.push(`${name}:${rule.style.getPropertyValue(name)}`);
          }
        }
      }
    }
    tokens = decls.length ? `:root{${decls.join(";")}}` : "";
    ready = true;
  });

  /** Which panels have been asked to run their script.
   *
   *  Static by default even on a card that is allowed scripts, and this is the
   *  one mitigation that exists for the risk the sandbox cannot touch: a srcdoc
   *  frame on an opaque origin shares the renderer with its parent, so
   *  `while(true){}` in a mockup freezes the studio, every transcript and the
   *  dock — and there is nothing left to kill it with, because the thread that
   *  would do the killing is the one that is blocked. No sandbox flag helps.
   *
   *  What helps is that hover, focus and transition are all pure CSS, so the
   *  static rendering is already most of what a design decision turns on.
   *  Script buys a dropdown that opens and a stepper that advances, and it
   *  costs one deliberate click per panel — which is the whole of the defence,
   *  and is said out loud on the button rather than hidden. */
  /* By index rather than a sized array: the component is built fresh each time
     the gallery opens, so there is nothing to keep in step, and a map starts
     empty without having to read `panels` to do it. */
  let live = $state<Record<number, boolean>>({});

  /** Measured per panel, because the scale is the frame's width over the fixed
   *  composing width. A frame cannot report its own height and asking it would
   *  mean a `postMessage` channel back out of the sandbox — a hole in the wall
   *  this whole thing stands on, for a layout convenience. */
  let widths = $state<number[]>([]);

  const scaleOf = (i: number) =>
    Math.max(0.05, (widths[i] || PREVIEW_VIEWPORT.w) / PREVIEW_VIEWPORT.w);

  const docs = $derived(
    panels.map((p, i) =>
      previewDoc(p.preview, { scripts: scripts && !!live[i], tokens }),
    ),
  );

  /* ── Looking closer ──────────────────────────────────────────────────────
   *
   * Fit is the right reading for the gallery and the wrong one for a detail.
   * Three panels across a laptop draw a 12px caption at four, so a design gets
   * judged on whether it could be read rather than on what it says — and the
   * fixed composing viewport, which is what makes the three comparable, is
   * exactly what guarantees that.
   *
   * So looking closer is a *second* surface rather than a knob on the first
   * one. Zooming a panel in place would break the one thing the gallery is
   * for: same size composed, same size judged. Here one design is magnified
   * over the rest, floating and inset rather than filling the screen, because
   * the gallery behind it is the context you came from and a real fullscreen
   * would throw it away to no purpose.
   */
  let big = $state<number | null>(null);
  /** Measured, and both axes this time — fit is `contain`, so it needs the
   *  height the gallery's panels never had to ask about. */
  let stage = $state({ w: 0, h: 0 });
  let view = $state<View>({ scale: 0, x: 0, y: 0 });
  /** Which panel the current `view` was fitted for, so a stage that merely
   *  *resized* re-clamps instead of throwing away where you had got to. */
  let fitted = $state<number | null>(null);

  const openBig = (i: number) => {
    fitted = null;
    big = i;
  };
  const closeBig = () => {
    big = null;
    fitted = null;
  };

  /* The stage is measured after mount, so the first pass through here is a
     0×0 box — and fitting to that gives a scale of 1 on a stage that cannot
     hold it. Nothing happens until there is something to fit into. */
  $effect(() => {
    const w = stage.w;
    const h = stage.h;
    const i = big;
    if (i === null || !w || !h) return;
    untrack(() => {
      if (fitted !== i) {
        fitted = i;
        view = fitView({ w, h }, PREVIEW_VIEWPORT);
      } else {
        view = clampView(view, { w, h }, PREVIEW_VIEWPORT);
      }
    });
  });

  /** How far an arrow key moves it. A quarter of the stage: small enough to
   *  land somewhere deliberate, big enough that crossing a design is not a
   *  drum solo. */
  const panStep = () => Math.max(40, Math.round(stage.w / 4));

  /* ── The glass ───────────────────────────────────────────────────────────
   *
   * A pointer over an iframe belongs to the iframe. There is no listener this
   * document can add that sees a wheel or a drag inside a cross-origin frame,
   * and there is no asking the frame to forward them — that would be a
   * `postMessage` channel out of a sandbox whose whole value is that it has
   * none. So the only way to pan a preview is a transparent sheet in front of
   * it, and the cost of that sheet is the frame's own hover.
   *
   * That cost is why the sheet is here and not on the gallery's panels: hover,
   * focus and transitions are pure CSS and are most of what a static preview
   * has to show, and covering them to buy a gesture nobody needs at fit would
   * be a bad trade. Magnified, it is the opposite trade — you came here to
   * look closely, and there is somewhere to pan to.
   *
   * The one exception is a design you have set *running*. Operating a mockup
   * and inspecting one are different acts, and a stepper you cannot click is
   * not worth a drag you can do with the arrow keys. So the glass lifts when
   * the script is live, and the buttons and keys keep working either way. */
  /* Pulled out rather than indexed in the markup: `big` is nullable and every
     use of it there would otherwise carry its own narrowing, and a stale index
     — a gallery re-opened on a shorter set of panels — resolves to nothing
     here instead of to `undefined` three lines into a template. */
  const bigPanel = $derived(big === null ? null : (panels[big] ?? null));
  const bigDoc = $derived(big === null ? "" : (docs[big] ?? ""));
  const bigLive = $derived(big !== null && !!live[big]);

  const glassed = $derived(bigPanel !== null && !(scripts && bigLive));

  let dragging = $state(false);
  let travelled = false;
  let last = { x: 0, y: 0 };

  function boxPoint(e: PointerEvent | WheelEvent, el: HTMLElement) {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function glassDown(e: PointerEvent) {
    if (e.button !== 0 || !canPan(view, stage, PREVIEW_VIEWPORT)) return;
    dragging = true;
    travelled = false;
    last = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function glassMove(e: PointerEvent) {
    if (!dragging) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    /* The same 4px the wall uses everywhere: a press is a click until it has
       travelled, so a hand that shakes on the way to a double-click does not
       nudge the design out from under it. */
    if (!travelled && Math.abs(dx) + Math.abs(dy) < 4) return;
    travelled = true;
    last = { x: e.clientX, y: e.clientY };
    view = panBy(view, dx, dy, stage, PREVIEW_VIEWPORT);
  }

  function glassUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }

  function glassWheel(e: WheelEvent) {
    e.preventDefault();
    const at = boxPoint(e, e.currentTarget as HTMLElement);
    view = zoomBy(
      view,
      wheelFactor(e.deltaY, e.deltaMode),
      at,
      stage,
      PREVIEW_VIEWPORT,
    );
  }

  /** Double-click toggles between the whole design and its composed size —
   *  the two readings worth having, and the only two with names. */
  function glassDouble(e: MouseEvent) {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const at = { x: e.clientX - r.left, y: e.clientY - r.top };
    view = isFit(view, stage, PREVIEW_VIEWPORT)
      ? zoomTo(view, 1, at, stage, PREVIEW_VIEWPORT)
      : fitView(stage, PREVIEW_VIEWPORT);
  }

  const step = (by: number) =>
    (view = zoomBy(view, by, centreOf(stage), stage, PREVIEW_VIEWPORT));

  /* Escape belongs to whatever is innermost, and while this is open that is
     this. Captured on the window so it lands before `App.svelte`'s ladder,
     which is a bubble-phase listener and would otherwise stop the focused
     card's turn instead of closing what you are looking at. The menu and the
     import panel are named in that ladder by hand; a capture listener needs
     nothing to know about it.

     The magnifier is one more rung on the same ladder and takes Escape first,
     for the reason the ladder exists: it is the innermost thing there is, and
     closing the whole gallery because you had opened a design to look at it
     would throw away the comparison you were in the middle of.

     Everything below Escape is read at call time rather than during setup, so
     this listener is registered once rather than re-registered on every frame
     of a drag. */
  $effect(() => {
    const onkey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        if (big !== null) closeBig();
        else onclose();
        return;
      }
      if (big === null || e.ctrlKey || e.metaKey || e.altKey) return;
      const at = centreOf(stage);
      const p = panStep();
      let next: View | null = null;
      switch (e.key) {
        case "+":
        case "=":
          next = zoomBy(view, STEP, at, stage, PREVIEW_VIEWPORT);
          break;
        case "-":
        case "_":
          next = zoomBy(view, 1 / STEP, at, stage, PREVIEW_VIEWPORT);
          break;
        case "0":
          next = fitView(stage, PREVIEW_VIEWPORT);
          break;
        case "1":
          next = zoomTo(view, 1, at, stage, PREVIEW_VIEWPORT);
          break;
        case "ArrowLeft":
          next = panBy(view, p, 0, stage, PREVIEW_VIEWPORT);
          break;
        case "ArrowRight":
          next = panBy(view, -p, 0, stage, PREVIEW_VIEWPORT);
          break;
        case "ArrowUp":
          next = panBy(view, 0, p, stage, PREVIEW_VIEWPORT);
          break;
        case "ArrowDown":
          next = panBy(view, 0, -p, stage, PREVIEW_VIEWPORT);
          break;
      }
      if (!next) return;
      e.stopPropagation();
      e.preventDefault();
      view = next;
    };
    window.addEventListener("keydown", onkey, true);
    return () => window.removeEventListener("keydown", onkey, true);
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="scrim" onclick={onclose}>
  <!-- The strip stops the click: dismissing on the backdrop is worth having,
       and dismissing because you clicked a design you were reading is not. -->
  <div class="strip" onclick={(e) => e.stopPropagation()}>
    <div class="bar">
      <span class="mark">Looking at</span>
      <span class="what">{header}</span>
      <span class="grow"></span>
      <span class="hint">
        {panels.length === 1 ? "one design" : `${panels.length} designs`} · composed at
        {PREVIEW_VIEWPORT.w}×{PREVIEW_VIEWPORT.h}
      </span>
      <button class="x" onclick={onclose} title="Close (Escape)">close</button>
    </div>

    <div class="panels" style:--n={panels.length}>
      {#each panels as p, i (i)}
        <div class="panel">
          <div class="stage" bind:clientWidth={widths[i]}>
            <!-- `allow-scripts` and nothing else. Adding `allow-same-origin`
                 beside it would hand the frame this document's origin back and
                 undo the whole arrangement — they are not two independent
                 permissions. -->
            {#if ready}
              <!-- Keyed on the document, so asking a panel to run its script
                   replaces the frame rather than mutating a `srcdoc` the
                   already-loaded document has moved on from. -->
              {#key docs[i]}
                <iframe
                  title={p.label ?? header}
                  sandbox="allow-scripts"
                  srcdoc={docs[i]}
                  style:width="{PREVIEW_VIEWPORT.w}px"
                  style:height="{PREVIEW_VIEWPORT.h}px"
                  style:transform="scale({scaleOf(i)})"
                ></iframe>
              {/key}
            {/if}

            <!-- A design whose markup is a skeleton its `js` fills in draws
                 nothing at all until the script runs, and every preview renders
                 static first — so what the user got was an empty frame with no
                 hint that anything was being withheld, which reads as the
                 feature being broken rather than as a design waiting on a
                 click. Sink 51863e1e.

                 A plate rather than a cover, because `isScriptBuilt` cannot see
                 a skeleton drawn entirely in CSS: whatever *is* there stays
                 visible around this, and running the script takes it away. -->
            {#if isScriptBuilt(p.preview) && !(scripts && live[i])}
              <div class="waiting">
                <span class="line">this design is built by its script</span>
                <span class="sub">
                  {scripts
                    ? "nothing is drawn until you run it — the button below"
                    : "and a chat card may not run one, so it cannot be drawn here"}
                </span>
              </div>
            {/if}

            <!-- Drawn on hover, but in the tab order always: an affordance that
                 only exists once a pointer is over it is one a keyboard can
                 never reach, and `:focus-within` on the panel is what makes
                 tabbing to it show it rather than move focus to something
                 invisible. It sits over the frame, which is the only place it
                 can sit — there is no room in the foot, and a design is the
                 thing you want to click to look closer at. -->
            <button
              class="magnify"
              onclick={() => openBig(i)}
              title="Look closer — zoom and pan this design on its own"
            >
              look closer
            </button>
          </div>

          <div class="foot">
            <div class="says">
              {#if p.label}<span class="lbl">{p.label}</span>{/if}
              {#if p.detail}<span class="det">{p.detail}</span>{/if}
            </div>
            <div class="acts">
              {#if p.preview.js}
                {#if !scripts}
                  <!-- A chat card spawns with `--tools WebSearch,WebFetch` and
                       no bypass, so it can reach nothing on this machine; a
                       running script would be the first executable surface it
                       has ever had. Said rather than silently dropped, or the
                       design looks broken. -->
                  <span class="det quiet">script not run — chat card</span>
                {:else if live[i]}
                  <button class="act" onclick={() => (live[i] = false)}>
                    make it still
                  </button>
                {:else}
                  <button
                    class="act"
                    onclick={() => (live[i] = true)}
                    title="Runs the design's own script. A script that never returns takes the window with it."
                  >
                    run its script
                  </button>
                {/if}
              {/if}
              {#if p.label}
                <button class="act pick" onclick={() => onchoose(p.label!)}>
                  choose this
                </button>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
  </div>
</div>

<!-- One design, over the rest of them. Floating and inset rather than filling
     the screen: the gallery behind it is the context you came from, and a real
     fullscreen would throw that away for nothing. Its own scrim, so clicking
     off it goes back to the comparison rather than out of the question. -->
{#if bigPanel}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="scrim closer" onclick={closeBig}>
    <div class="sheet" onclick={(e) => e.stopPropagation()}>
      <div class="bar">
        <span class="mark">Looking closer</span>
        <span class="what">{bigPanel.label ?? header}</span>
        <span class="grow"></span>

        <div class="zoom">
          <button
            class="z"
            onclick={() => step(1 / STEP)}
            disabled={isFit(view, stage, PREVIEW_VIEWPORT)}
            title="Zoom out (−)">−</button
          >
          <!-- Against the composed viewport, not against fit: 100% is one
               composed pixel to one screen pixel, which is the size the agent
               was told to design for. A percentage of fit would change meaning
               with the window. -->
          <span class="pc">{readout(view.scale)}</span>
          <button class="z" onclick={() => step(STEP)} title="Zoom in (+)">+</button>
          <button
            class="z wide"
            class:on={isFit(view, stage, PREVIEW_VIEWPORT)}
            onclick={() => (view = fitView(stage, PREVIEW_VIEWPORT))}
            title="The whole design (0)">fit</button
          >
          <button
            class="z wide"
            class:on={isActual(view)}
            onclick={() =>
              (view = zoomTo(view, 1, centreOf(stage), stage, PREVIEW_VIEWPORT))}
            title="Composed size, 1:1 (1)">100%</button
          >
        </div>

        <button class="x" onclick={closeBig} title="Back to the gallery (Escape)">
          back
        </button>
      </div>

      <div class="stage" bind:clientWidth={stage.w} bind:clientHeight={stage.h}>
        {#if ready}
          {#key bigDoc}
            <iframe
              title={bigPanel.label ?? header}
              sandbox="allow-scripts"
              srcdoc={bigDoc}
              style:width="{PREVIEW_VIEWPORT.w}px"
              style:height="{PREVIEW_VIEWPORT.h}px"
              style:transform="translate({view.x}px, {view.y}px) scale({view.scale})"
            ></iframe>
          {/key}
        {/if}

        {#if isScriptBuilt(bigPanel.preview) && !(scripts && bigLive)}
          <div class="waiting">
            <span class="line">this design is built by its script</span>
            <span class="sub">
              {scripts
                ? "nothing is drawn until you run it — the button below"
                : "and a chat card may not run one, so it cannot be drawn here"}
            </span>
          </div>
        {/if}

        <!-- See `glassed`. A pointer over an iframe belongs to the iframe, so
             this sheet is the only way to pan one — and it lifts entirely once
             the design is running its own script, because operating a mockup
             and inspecting one are different acts. -->
        {#if glassed}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
            class="glass"
            class:grab={canPan(view, stage, PREVIEW_VIEWPORT)}
            class:held={dragging}
            onpointerdown={glassDown}
            onpointermove={glassMove}
            onpointerup={glassUp}
            onpointercancel={glassUp}
            onwheel={glassWheel}
            ondblclick={glassDouble}
          ></div>
        {/if}
      </div>

      <div class="foot">
        <div class="says">
          {#if bigPanel.detail}<span class="det">{bigPanel.detail}</span>{/if}
          <span class="det quiet keys">
            {glassed
              ? "scroll to zoom · drag to pan · double-click for 100%"
              : "running its script, so the pointer is the design's"} · arrows,
            +, −, 0 and 1 work either way
          </span>
        </div>
        <div class="acts">
          {#if bigPanel.preview.js}
            {#if !scripts}
              <span class="det quiet">script not run — chat card</span>
            {:else if bigLive}
              <button class="act" onclick={() => big !== null && (live[big] = false)}>
                make it still
              </button>
            {:else}
              <button
                class="act"
                onclick={() => big !== null && (live[big] = true)}
                title="Runs the design's own script. A script that never returns takes the window with it."
              >
                run its script
              </button>
            {/if}
          {/if}
          {#if bigPanel.label}
            <!-- Choosing from here answers the question, exactly as choosing
                 from the gallery does. Having to close this, find the panel
                 again and press the other button would be deciding twice. -->
            <button class="act pick" onclick={() => onchoose(bigPanel.label!)}>
              choose this
            </button>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.4rem;
    /* Opaque enough that the wall behind is context rather than competition —
       the backdrop is alive and a leaf drifting through a design being judged
       is exactly the wrong kind of movement. */
    background: color-mix(in srgb, var(--well) 88%, transparent);
    backdrop-filter: blur(3px);
  }

  .strip {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    width: 100%;
    height: 100%;
    max-width: 120rem;
  }

  .bar {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    font-family: var(--util);
    font-size: 0.68rem;
  }
  .mark {
    font-size: 0.61rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--st-ask);
  }
  .what {
    color: var(--paper);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 60ch;
  }
  .grow {
    flex: 1 1 auto;
  }
  .hint {
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }
  .x {
    background: none;
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper-mute);
    font-family: var(--util);
    font-size: 0.66rem;
    padding: 0.1rem 0.5rem;
    cursor: pointer;
  }
  .x:hover {
    color: var(--paper);
    border-color: var(--rule);
  }

  .panels {
    flex: 1 1 auto;
    display: grid;
    grid-template-columns: repeat(var(--n), minmax(0, 1fr));
    gap: 0.9rem;
    min-height: 0;
  }
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    min-width: 0;
    min-height: 0;
  }

  .stage {
    flex: 1 1 auto;
    position: relative;
    overflow: hidden;
    border: 1px solid var(--edge);
    border-radius: 4px;
    /* Nothing standing on the wall may be transparent, and a frame still
       painting is a hole through to the backdrop. */
    background: var(--ink);
    min-height: 0;
  }
  .stage iframe {
    position: absolute;
    top: 0;
    left: 0;
    border: 0;
    /* Scaled from the corner, so the composed viewport and the box it is drawn
       in share an origin and the design cannot drift out of its own frame. */
    transform-origin: 0 0;
  }

  /* Centred and small, over the frame rather than instead of it — see the
     markup for why this must not cover. Nothing standing on the wall may be
     transparent, and this is standing on an opaque `.stage` rather than on the
     backdrop, so a plate that lets the frame through around its edges is the
     honest drawing rather than an exception to that. */
  .waiting {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
    max-width: 88%;
    padding: 0.5rem 0.9rem;
    border: 1px solid var(--edge);
    border-radius: 4px;
    background: var(--surface);
    font-family: var(--util);
    text-align: center;
    pointer-events: none;
  }
  .waiting .line {
    font-size: 0.72rem;
    color: var(--paper-mute);
  }
  .waiting .sub {
    font-size: 0.64rem;
    color: var(--paper-faint);
  }

  .foot {
    display: flex;
    align-items: flex-end;
    gap: 0.6rem;
    flex: 0 0 auto;
  }
  .says {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
    flex: 1 1 auto;
  }
  .lbl {
    font-family: var(--util);
    font-size: 0.82rem;
    color: var(--paper);
  }
  .det {
    font-family: var(--util);
    font-size: 0.68rem;
    line-height: 1.35;
    color: var(--paper-mute);
  }
  .det.quiet {
    color: var(--paper-faint);
    align-self: center;
  }
  .acts {
    display: flex;
    gap: 0.35rem;
    flex: 0 0 auto;
  }
  .act {
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper-mute);
    font-family: var(--util);
    font-size: 0.7rem;
    padding: 0.25rem 0.6rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .act:hover {
    color: var(--paper);
    background: var(--raised);
    border-color: var(--rule);
  }
  /* Amber, because choosing here is answering the parked question — the same
     act the dock's buttons perform, and the only colour on this surface. */
  .act.pick {
    color: var(--paper);
    border-color: color-mix(in srgb, var(--st-ask) 55%, var(--edge));
  }
  .act.pick:hover {
    border-color: var(--st-ask);
  }

  /* ── Looking closer ───────────────────────────────────────────────────── */

  /* Over the frame, because that is the only place there is room and because a
     design is the thing you want to click to look closer at. Revealed on
     hover, but kept in the tab order and shown on focus — an affordance that
     exists only under a pointer is one a keyboard can never reach. */
  .magnify {
    position: absolute;
    top: 0.4rem;
    right: 0.4rem;
    z-index: 2;
    opacity: 0;
    transition: opacity 120ms ease;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper-mute);
    font-family: var(--util);
    font-size: 0.66rem;
    padding: 0.18rem 0.5rem;
    cursor: zoom-in;
  }
  .panel:hover .magnify,
  .panel:focus-within .magnify,
  .magnify:focus-visible {
    opacity: 1;
  }
  .magnify:hover {
    color: var(--paper);
    border-color: var(--rule);
  }

  /* One rung further in than the gallery, and Escape unwinds it in that order. */
  .scrim.closer {
    z-index: 61;
    background: color-mix(in srgb, var(--well) 82%, transparent);
  }

  /* Inset rather than filling the screen: the gallery behind is the context
     you came from. Opaque, like everything standing on the wall. */
  .sheet {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    width: min(94vw, 116rem);
    height: min(92vh, 76rem);
    padding: 0.8rem;
    border: 1px solid var(--rule);
    border-radius: 6px;
    background: var(--surface);
    box-shadow: 0 20px 56px rgb(0 0 0 / 0.5);
  }

  .zoom {
    display: flex;
    align-items: center;
    gap: 0.2rem;
  }
  .z {
    background: none;
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper-mute);
    font-family: var(--util);
    font-size: 0.66rem;
    line-height: 1.5;
    padding: 0.1rem 0.4rem;
    min-width: 1.5rem;
    cursor: pointer;
  }
  .z.wide {
    min-width: 2.7rem;
  }
  .z:hover:not(:disabled) {
    color: var(--paper);
    border-color: var(--rule);
  }
  .z:disabled {
    opacity: 0.4;
    cursor: default;
  }
  /* Drawn pressed rather than offered: a button that does nothing when you use
     it teaches you to stop trusting the row it is in. */
  .z.on {
    color: var(--paper);
    background: var(--raised);
    border-color: var(--rule);
  }
  .pc {
    font-family: var(--util);
    font-size: 0.66rem;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
    min-width: 3.4rem;
    text-align: center;
  }

  /* The transparent sheet that makes a frame pannable at all — see `glassed`.
     It has no paint of its own and is not an exception to "nothing standing on
     the wall may be transparent": it stands on an opaque `.stage`, exactly as
     `.waiting` does, and the thing it is over is the thing it is for. */
  .glass {
    position: absolute;
    inset: 0;
    z-index: 1;
    cursor: zoom-in;
  }
  .glass.grab {
    cursor: grab;
  }
  .glass.held {
    cursor: grabbing;
  }

  .keys {
    align-self: flex-start;
  }
</style>
