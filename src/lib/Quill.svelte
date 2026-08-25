<script lang="ts">
  /* The editor, drawn — the finder panel's third reading.

     What this component does is small on purpose: nvim says what the screen
     looks like and this draws it. Every piece of arithmetic is in `nvim.ts` —
     the fold, the runs, the attribute translation, the key notation, the cell
     a pointer is over — so what is left here is elements, a measurement, and
     the two event handlers that reach the process.

     **The component is `Quill` and the class is `Editor`**, which is the same
     split `Console`/`Shell` and `Spyglass`/`Finder` already have: a
     `.svelte.ts` module and a `.svelte` component of one name are one module
     path to two files, and TypeScript says so.

     It is drawn on nvim's own background rather than on `--paper`, and that is
     the one place this file argues with `tokens.css`. The rule there is that
     colour is reserved for status and chrome is achromatic — and it holds for
     chrome. This is not chrome: it is a document with somebody's colourscheme
     on it, exactly as the shell and the server logs are output with somebody's
     ANSI colour on it, which `ansi.ts` has rendered faithfully since the first
     day there was a shell. Reading a file in Volery's ink and editing the same
     file in the editor's would be two readings of one file that disagree. */
  import { onMount } from "svelte";

  import type { Editor } from "./nvim.svelte";
  import { attrCss, cursorBox, rowRuns } from "./nvim";

  let { editor }: { editor: Editor } = $props();

  let box: HTMLDivElement | undefined = $state();
  let ruler: HTMLSpanElement | undefined = $state();
  let grid: HTMLDivElement | undefined = $state();

  /** Read on every draw, and the whole of what makes the component reactive:
     the screen itself is plain data, deliberately (see `nvim.svelte.ts`), and
     this number is bumped once per frame in which nvim said it was consistent. */
  const version = $derived(editor.active?.version ?? 0);

  /** The screen, re-read whenever the version says to. `version` is referenced
     rather than used, which is the point — it is the dependency. */
  const screen = $derived.by(() => {
    void version;
    return editor.active?.screen ?? null;
  });

  const cursor = $derived(screen ? cursorBox(screen) : { w: 1, h: 1, bottom: false });

  /* ── measuring a cell ─────────────────────────────────────────────────────

     Every gesture and every resize is in cells, so the panel has to know how
     big one is. Measured from a real span in this component's own font rather
     than assumed, because the font comes from `tokens.css` and the size from
     the reading-size knob — and a cell size that is wrong by a pixel puts the
     cursor a column out at the right-hand end of a long line.

     Fifty characters rather than one, because a single glyph's advance rounds
     to the nearest fraction the layout engine feels like and fifty averages it
     away. */
  function measure() {
    if (!ruler) return;
    const rect = ruler.getBoundingClientRect();
    if (rect.width > 0) editor.cellW = rect.width / 50;
    if (rect.height > 0) editor.cellH = rect.height;
    fit();
  }

  /** Tell nvim what fits. Guarded inside `Editor.resize`, which only speaks
     when the count actually changed — nvim repaints its whole screen for every
     `try_resize`, and a `ResizeObserver` fires on every frame of a drag. */
  function fit() {
    if (!box) return;
    const rect = box.getBoundingClientRect();
    editor.resize(rect.width, rect.height);
  }

  onMount(() => {
    /* Fonts land after the first paint, and a grid measured against the
       fallback is a grid whose every column is a fraction out. */
    void document.fonts?.ready.then(measure);
    measure();

    if (!box) return;
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  });

  /* The panel takes the keyboard the moment it becomes the editor. There is no
     field here — nvim *is* the field — so the container itself has to be where
     the keyboard is, or every keystroke would land on the window. */
  $effect(() => {
    if (editor.on && editor.live) grid?.focus();
  });

  /* ── the keyboard ────────────────────────────────────────────────────────

     Everything goes to nvim, and that is the point: this is somebody's real
     editor and half of what makes it theirs is a mapping this app has never
     heard of. So there is no allow-list here, only the one key kept back.

     **Alt+E is the way out**, and it has to be a chord rather than Escape for
     the obvious reason — Escape is the most-pressed key in nvim, and an editor
     you left every time you finished an insert would be unusable. Alt+E is the
     sibling of the shell's Alt+I, and `<M-e>` is not bound by nvim's defaults.

     `stopPropagation` as well as `preventDefault`: `Spyglass.svelte` reads
     Escape as "back to the results" and ctrl+R as the markdown toggle, and both
     would fire underneath this from a keystroke meant for the buffer. */
  function onkey(e: KeyboardEvent) {
    e.stopPropagation();
    if ((e.key === "e" || e.key === "E") && e.altKey && !e.ctrlKey) {
      e.preventDefault();
      editor.rest();
      return;
    }
    if (editor.key(e)) e.preventDefault();
  }

  /** Paste as an insertion rather than as a key each — mappings and autopairs
     would otherwise turn a pasted function into a staircase. */
  function onpaste(e: ClipboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    const text = e.clipboardData?.getData("text/plain");
    if (text) editor.paste(text);
  }

  /* ── the pointer ─────────────────────────────────────────────────────────

     A window you cannot click into reads as a picture of an editor rather than
     an editor, and you arrived at this panel with the pointer.

     The press is captured so a drag that leaves the grid still selects — the
     same reason `Canvas.svelte` captures, and with the same 4px-slop hazard
     avoided by there being no click here to retarget: nvim is told about the
     press itself, so nothing downstream is waiting on a `click`. */
  let dragging = $state(false);

  function at(e: MouseEvent): [number, number] {
    const rect = grid!.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  function down(e: PointerEvent) {
    if (!grid) return;
    e.preventDefault();
    grid.focus();
    grid.setPointerCapture(e.pointerId);
    dragging = true;
    editor.pointer(e, "press", ...at(e));
  }

  function move(e: PointerEvent) {
    if (!dragging) return;
    editor.pointer(e, "drag", ...at(e));
  }

  function up(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    grid?.releasePointerCapture(e.pointerId);
    editor.pointer(e, "release", ...at(e));
  }
</script>

<div class="quill" bind:this={box}>
  <!-- Off-screen and never read, but laid out in the same font as the grid, so
       what it measures is what the grid draws. -->
  <span class="ruler" bind:this={ruler} aria-hidden="true"
    >00000000000000000000000000000000000000000000000000</span
  >

  {#if editor.fault && !editor.live}
    <p class="bad">{editor.fault}</p>
  {:else if editor.starting}
    <!-- Said plainly, because a real config takes about five seconds and an
         editor that showed nothing for five seconds reads as one that failed. -->
    <p class="wait">starting nvim — your config, your plugins, your language servers</p>
  {/if}

  <!-- `tabindex` because there is no field in here to hold the keyboard, and
       nvim is the thing that wants every key. -->
  <div
    class="grid"
    class:hidden={!editor.live}
    bind:this={grid}
    tabindex="-1"
    role="textbox"
    aria-label="editor"
    aria-multiline="true"
    onkeydown={onkey}
    onpaste={onpaste}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    onwheel={(e) => {
      e.preventDefault();
      if (grid) editor.wheel(e, ...at(e));
    }}
    oncontextmenu={(e) => e.preventDefault()}
    style:background={screen ? `#${(screen.colors.bg & 0xffffff).toString(16).padStart(6, "0")}` : undefined}
  >
    {#if screen}
      {#each screen.cells as row, r (r)}
        <div class="row">
          {#each rowRuns(row) as run, i (i)}<span
              style={attrCss(run.hl, screen.attrs, screen.colors)}>{run.text}</span
            >{/each}
        </div>
      {/each}

      <!-- The cursor is Volery's one addition to what nvim said, and it is not
           an invention: the shape and the size come from the config's own
           `mode_info_set`, so an insert-mode bar being thin is that config's
           decision. Hidden while nvim is busy, which is nvim saying the screen
           it has drawn is not one it is finished with. -->
      {#if !screen.busy}
        <div
          class="caret"
          class:bottom={cursor.bottom}
          style:left="{screen.cursor.col * editor.cellW}px"
          style:top="{screen.cursor.row * editor.cellH}px"
          style:width="{cursor.w * editor.cellW}px"
          style:height="{cursor.h * editor.cellH}px"
        ></div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .quill {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .ruler {
    position: absolute;
    visibility: hidden;
    pointer-events: none;
    white-space: pre;
    font-family: var(--mono);
    font-size: 0.7rem;
    line-height: 1.5;
  }

  .grid {
    position: absolute;
    inset: 0;
    overflow: hidden;
    outline: none;
    /* `pre` and not `pre-wrap`: nvim has already decided where the lines break,
       and a row that wrapped here would push every row below it out of the grid
       nvim thinks it is painting. */
    white-space: pre;
    /* The same face and the same size the viewer sets its source in, so
       switching a file from being read to being edited does not resize the
       text under you. */
    font-family: var(--mono);
    font-size: 0.7rem;
    line-height: 1.5;
    /* A grid is thousands of glyphs redrawn on every keystroke; ligatures and
       kerning would be measured per row and the columns would not line up. */
    font-variant-ligatures: none;
    font-kerning: none;
    cursor: default;
  }

  .grid.hidden {
    visibility: hidden;
  }

  .row {
    height: 1.5em;
  }

  .caret {
    position: absolute;
    /* `difference` rather than a colour: the cursor has to be visible over
       whatever the colourscheme put underneath it, and this app does not get
       to know what that was. It also inverts the glyph it covers, which is what
       a block cursor is supposed to do. */
    mix-blend-mode: difference;
    background: #ffffff;
    pointer-events: none;
  }

  .caret.bottom {
    /* A horizontal cursor sits on the baseline end of the cell, not the top. */
    transform: translateY(calc(1.5em - 100%));
  }

  .wait,
  .bad {
    margin: 0;
    padding: 10px 14px;
    font-family: var(--util);
    font-size: 0.66rem;
    color: var(--paper-mute);
  }

  .bad {
    color: var(--st-fail);
  }
</style>
