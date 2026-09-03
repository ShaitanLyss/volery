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

  import { onMount } from "svelte";
  import {
    PREVIEW_VIEWPORT,
    isScriptBuilt,
    previewDoc,
    type PreviewPanel,
  } from "./asking";

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

  /* Escape belongs to whatever is innermost, and while this is open that is
     this. Captured on the window so it lands before `App.svelte`'s ladder,
     which is a bubble-phase listener and would otherwise stop the focused
     card's turn instead of closing what you are looking at. The menu and the
     import panel are named in that ladder by hand; a capture listener needs
     nothing to know about it. */
  $effect(() => {
    const onkey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      onclose();
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
</style>
