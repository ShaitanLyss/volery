<script lang="ts">
  /* The finder, and the viewer it opens into.
     Two states of one panel: a list of results with a preview beside it, and —
     one step in — the file itself.

     Drawn the way `Console.svelte` is drawn, and for the same reasons: fixed in
     the middle of the window rather than standing on the canvas, opaque because
     the backdrop draws behind everything and a leaf through the middle of a
     file listing is the bug a dormant card once had, and no scrim, because the
     reason you are looking for a file is usually the card beside it.

     Every piece of arithmetic in here is in `finding.ts` instead — the spans, the
     window, the line splitting. What is left is elements. */
  import { tick } from "svelte";
  import { invoke } from "@tauri-apps/api/core";

  import Markdown from "./Markdown.svelte";
  import { parseMarkdown } from "./markdown";
  import { type Reading, flatOf, locate } from "./dogears";
  import { offers, pieces, shift, splitPath, viewLines, windowAround } from "./finding";
  import type { Finder } from "./finder.svelte";

  let { finder }: { finder: Finder } = $props();

  let field: HTMLInputElement | undefined = $state();
  let list: HTMLDivElement | undefined = $state();
  let sheet: HTMLDivElement | undefined = $state();
  let pane: HTMLDivElement | undefined = $state();

  /* Whichever of the two is showing takes the keyboard. The panel is a question
     and there is nothing else in the list state to click; the viewer has no
     field at all, so it has to hold focus itself or Escape and ctrl+R would
     land on the window instead — and the window's handler is the one that is
     switched off while this is open. */
  $effect(() => {
    if (!finder.open) return;
    const viewing = !!finder.sheet;
    void tick().then(() => (viewing ? sheet?.focus() : field?.focus()));
  });

  /* Keep the selected row in view without moving the list otherwise. `nearest`
     rather than `center`: holding Down should walk the list a row at a time,
     and centring every step makes the whole list travel under a selection that
     never appears to move. */
  $effect(() => {
    void finder.at;
    void finder.rows.length;
    if (!list) return;
    void tick().then(() =>
      list
        ?.querySelector<HTMLElement>("[data-at='true']")
        ?.scrollIntoView({ block: "nearest" }),
    );
  });

  /* The viewer opens at the line you were looking at, not at the top — a hit on
     line 900 of `store.rs` is the whole reason you pressed Enter. Centred here,
     unlike the list: this is one jump on open rather than a step per keypress.
     A rendered document has no line to scroll to, so it opens at the top, which
     is where a document starts — and that has to be *set* rather than left
     alone, or switching from source to rendered keeps the scroll offset of a
     view that is no longer there.

     Unless a tab is being resumed, which is the one case that overrides all of
     it: coming back to a dog-ear means coming back to where you were, and the
     line the file was first opened at is not that. Taken here rather than in
     the continuation so the reading is claimed by the same effect run the
     resume triggered. */
  $effect(() => {
    const line = finder.sheetLine;
    const rendered = finder.rendered;
    if (!finder.sheet) return;
    const resume = finder.takeResume();
    void tick().then(() => {
      if (resume) {
        putBack(resume);
        return;
      }
      if (rendered || line === null) {
        if (sheet) sheet.scrollTop = 0;
        return;
      }
      sheet
        ?.querySelector<HTMLElement>(`[data-no='${line}']`)
        ?.scrollIntoView({ block: "center" });
    });
  });

  /* How the finder reads where we are — installed, not reached for. See the
     note on `Finder.reader`: this component is the only thing that can see a
     scroller or a `Selection`, and the finder is the only thing that knows when
     the answer is worth having. Cleared on the way out, since a reader holding
     a `bind:this` from a superseded generation answers about a node nothing is
     drawing. */
  $effect(() => {
    finder.reader = reading;
    return () => {
      if (finder.reader === reading) finder.reader = null;
    };
  });

  /** Every text node under an element, in document order.
   *
   *  The one line of this arrangement that cannot be tested — everything it
   *  feeds is in `dogears.ts`. A flat run of text nodes is what makes one
   *  description of a selection work in both readings: the source view is
   *  line-numbered `div`s and a rendered document is arbitrary markup, and a
   *  line/column pair would mean nothing in the second. */
  function textNodes(el: HTMLElement): Text[] {
    const out: Text[] = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) out.push(n as Text);
    return out;
  }

  /** Where the viewer is, for the tab it belongs to. */
  function reading(): Reading | null {
    const el = sheet;
    if (!el) return null;
    let span: { from: number; to: number } | null = null;
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const r = sel.getRangeAt(0);
      /* A selection that started in the transcript and ended here is not this
         file's selection, so both ends have to be inside. */
      if (el.contains(r.startContainer) && el.contains(r.endContainer)) {
        const nodes = textNodes(el);
        const lens = nodes.map((n) => n.data.length);
        const a = nodes.indexOf(r.startContainer as Text);
        const b = nodes.indexOf(r.endContainer as Text);
        /* Not found means an endpoint on an *element* rather than in text,
           which a selection dragged past the end of the last line genuinely
           is. The scroll is still worth keeping, so the selection is what is
           dropped and nothing else. */
        if (a !== -1 && b !== -1) {
          span = {
            from: flatOf(lens, a, r.startOffset),
            to: flatOf(lens, b, r.endOffset),
          };
        }
      }
    }
    return { scroll: el.scrollTop, sel: span };
  }

  /** And back again. */
  function putBack(read: Reading) {
    const el = sheet;
    if (!el) return;
    if (read.sel) {
      const nodes = textNodes(el);
      const lens = nodes.map((n) => n.data.length);
      const a = locate(lens, read.sel.from);
      const b = locate(lens, read.sel.to);
      const na = nodes[a.i];
      const nb = nodes[b.i];
      if (na && nb) {
        const range = document.createRange();
        range.setStart(na, Math.min(a.off, na.data.length));
        range.setEnd(nb, Math.min(b.off, nb.data.length));
        const s = window.getSelection();
        s?.removeAllRanges();
        s?.addRange(range);
      }
    }
    /* Last, and that is the order rather than an accident: putting a selection
       back scrolls to it, and where the scroller actually was is the more
       precise of the two facts. */
    el.scrollTop = read.scroll;
  }

  /** The preview, as the slice of numbered lines around the selected place. */
  const shown = $derived.by(() => {
    const p = finder.preview;
    if (!p || p.binary) return [];
    const lines = viewLines(p.text);
    const w = windowAround(lines.length, finder.row?.line ?? null);
    return lines.slice(w.from, w.to);
  });

  /** The whole file, for the viewer's source reading. */
  const sheetRows = $derived.by(() =>
    finder.sheet && !finder.sheet.binary && !finder.rendered
      ? viewLines(finder.sheet.text)
      : [],
  );

  /** The document, parsed. Only while it is actually being drawn as one — a
   *  markdown parse of a six-thousand-line file is not free, and the source
   *  reading does not want it. */
  const blocks = $derived.by(() =>
    finder.rendered && finder.sheet ? parseMarkdown(finder.sheet.text) : [],
  );

  async function onKey(e: KeyboardEvent) {
    /* The viewer's keys first — it is the innermost thing open, so Escape there
       means "back to the list" and not "put it all away". Two presses to leave,
       which is the same shape Escape has everywhere else on this wall. */
    if (finder.sheet) {
      if (e.key === "Escape") {
        e.preventDefault();
        finder.back();
        return;
      }
      if ((e.key === "r" || e.key === "R") && e.ctrlKey && finder.markdown) {
        e.preventDefault();
        finder.toggleRaw();
      }
      /* Everything else is the scroller's: arrows, page keys, Home and End all
         mean in a file exactly what they mean in a file. */
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      finder.hide();
    } else if (e.key === "Enter") {
      e.preventDefault();
      await finder.look();
    } else if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      /* Ctrl+N and Ctrl+P as well as the arrows, because that is what moving
         down a list is called to a hand that came from a terminal. */
      e.preventDefault();
      finder.step(1);
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      finder.step(-1);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      finder.step(10);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      finder.step(-10);
    } else if ((e.key === "f" || e.key === "F") && e.ctrlKey) {
      /* The other mode, same query — the gesture that makes these one panel
         rather than two. Ctrl+F because it is what "find" is called everywhere,
         and this webview binds nothing to it. */
      e.preventDefault();
      await finder.swap();
    }
  }

  /** A link in a rendered document goes to the desktop, never to this window —
   *  the studio has no address bar and no back button, so navigating it would
   *  be a one-way trip out of the app. The same call the transcript makes. */
  function onlink(href: string) {
    void invoke("open_external", { url: href }).catch(
      (err) => (finder.fault = String(err)),
    );
  }
</script>

<!-- A press outside puts it away, and it is the *tabs* that make that affordable.
     Closing used to cost you the whole search and the whole scroll, so the only
     way out was a deliberate Escape and a stray click could not be allowed to
     mean it; now leaving leaves a pill, and coming back is one click. So the
     panel behaves the way every other dismissible thing on this wall does.

     `pointerdown` rather than `click`, which is `ContextMenu`'s reasoning
     exactly: the panel should be gone before the thing underneath decides what
     that press meant. But **no catcher** — that component can afford an overlay
     and this one cannot, because the whole argument for having no scrim is that
     the reason you are reading a file is usually the card beside it. So this
     listens at the window and swallows nothing: one press both closes the panel
     and reaches the card, which is what clicking a card while a file is open
     should do.

     Two exclusions. The strip, because clicking another tab is switching files
     and not dismissing — and it would otherwise close and immediately reopen.
     And anything but the primary button, since a right-click is asking the wall
     for a menu rather than putting this away. -->
<svelte:window
  onpointerdown={(e) => {
    if (!finder.open || e.button !== 0) return;
    const t = e.target;
    if (!(t instanceof Node) || pane?.contains(t)) return;
    if (t instanceof Element && t.closest(".strip")) return;
    finder.hide();
  }}
/>

{#if !finder.open}
  <!-- Which-key, in one line and without a plugin. A chord half-typed is the
       only gesture on this wall with no affordance at all — every other binding
       is on a button or in a title — and a leader you have half-forgotten is
       otherwise something you read the source to remember. Above the dock
       rather than in the middle: it appears while your hands are moving, and it
       must not land over the card you are looking at.

       `pointer-events: none`, because this is a caption and not a control: the
       next thing you do is press a key, and a rectangle that swallowed a click
       on the wall behind it would be a hint that cost you a gesture. -->
  <div class="hint" aria-live="polite">
    <span class="lead">space</span>
    {#each offers(finder.pending ?? "") as o (o.keys)}
      <span class="offer"
        ><kbd>{o.keys}</kbd>{o.mode === "files" ? "find file" : "grep"}</span
      >
    {/each}
  </div>
{:else}
  <!-- The keydown is on the panel rather than on the field, because the viewer
       one step in has no field — so `tabindex` is what lets the pane itself be
       a place the keyboard can be, and every key below arrives here by bubbling
       from whichever of the two is focused. -->
  <div
    class="pane"
    role="dialog"
    aria-label="finder"
    tabindex="-1"
    bind:this={pane}
    onkeydown={onKey}
  >
  <header>
    <span class="mark">{finder.mode === "files" ? "find file" : "grep"}</span>
    <span class="path" title={finder.root}
      >{splitPath(finder.root).name || finder.root}</span
    >
    {#if finder.busy}<span class="run">working</span>{/if}
    {#if finder.literal}
      <span
        class="note"
        title="ripgrep would not take that as a pattern, so it was searched for literally"
        >literal</span
      >
    {/if}
    {#if finder.filesTruncated}
      <span class="note" title="this project has more files than the finder holds"
        >capped</span
      >
    {/if}
    <span class="grow"></span>
    {#if finder.sheet}
      {#if finder.markdown}
        <button
          class="ghost"
          class:on={!finder.raw}
          onclick={() => finder.toggleRaw()}
          title="Read it as a document or as its source (ctrl+R)"
          >{finder.raw ? "source" : "rendered"}</button
        >
      {/if}
      <!-- What "back" is depends on where the viewer was opened from, so the
           button says which. Opened from a path in a transcript there is no
           list behind it, and offering `results` would be a button promising a
           search nobody ran. -->
      <button
        class="ghost"
        onclick={() => finder.back()}
        title={finder.alone
          ? "Close it and go back to what you were reading (esc)"
          : "Back to the results (esc)"}>{finder.alone ? "close" : "results"}</button
      >
    {/if}
    <button class="x" onclick={() => finder.hide()} title="Put it away (esc)">✕</button>
  </header>

  {#if finder.sheet}
    <!-- One step in: the file itself. -->
    {@const p = splitPath(finder.sheet.path)}
    <div class="sheetbar">
      <span class="dir">{p.dir}</span><span class="name">{p.name}</span>
      {#if finder.sheetLine !== null}<span class="at">:{finder.sheetLine}</span>{/if}
      <span class="grow"></span>
      <span class="note">{(finder.sheet.bytes / 1024).toFixed(1)} kB</span>
    </div>
    <!-- Focusable so it can hold the keyboard with no field on screen, and so
         the arrows scroll the file rather than doing nothing. -->
    <div
      class="sheet"
      class:prose={finder.rendered}
      bind:this={sheet}
      tabindex="-1"
      role="document"
    >
      {#if finder.sheet.binary}
        <p class="empty">not a text file — nothing to read here</p>
      {:else if finder.rendered}
        <!-- The repo's own renderer, so a rule reads here exactly as an agent's
             answer reads in the transcript. `nav` off: that flag is about the
             transcript's rail listing a paragraph, and there is no rail here. -->
        <Markdown {blocks} nav={false} {onlink} />
      {:else}
        {#each sheetRows as l (l.no)}
          <div class="ln" class:hit={l.no === finder.sheetLine} data-no={l.no}>
            <span class="no">{l.no}</span><span class="src">{l.text}</span>
          </div>
        {/each}
      {/if}
      {#if finder.sheet.truncated}
        <p class="empty">— only the first two megabytes are shown —</p>
      {/if}
    </div>
  {:else}
    <div class="body">
      <div class="results" bind:this={list}>
        {#if finder.fault}
          <p class="bad">{finder.fault}</p>
        {/if}
        {#if !finder.rows.length}
          <p class="empty">
            {finder.listing
              ? "asking ripgrep what is here…"
              : finder.mode === "grep" && !finder.query.trim()
                ? "type something to search for"
                : "nothing matches"}
          </p>
        {/if}
        {#each finder.rows as row, i (`${row.path}:${row.line ?? 0}:${i}`)}
          {@const p = splitPath(row.path)}
          <button
            class="row"
            class:sel={i === finder.at}
            data-at={i === finder.at}
            onclick={() => {
              finder.pick(i);
              void finder.look(row);
            }}
          >
            <span class="dir">{p.dir}</span
            >{#if row.marked === "path"}{#each pieces(p.name, shift(row.spans, p.dir.length)) as piece}<span
                  class:mk={piece.hit}>{piece.text}</span
                >{/each}{:else}<span class="name">{p.name}</span>{/if}{#if row.line !== null}<span
                class="at">:{row.line}</span
              >{/if}{#if row.text !== null}<span class="text"
                >{#each pieces(row.text, row.spans) as piece}<span class:mk={piece.hit}
                    >{piece.text}</span
                  >{/each}</span
              >{/if}
          </button>
        {/each}
      </div>

      <div class="preview">
        {#if !finder.preview}
          <p class="empty">nothing selected</p>
        {:else if finder.preview.binary}
          <p class="empty">not a text file</p>
        {:else}
          {#each shown as l (l.no)}
            <div class="ln" class:hit={l.no === finder.row?.line}>
              <span class="no">{l.no}</span><span class="src">{l.text}</span>
            </div>
          {/each}
        {/if}
      </div>
    </div>

    <footer>
      <span class="prompt">{finder.mode === "files" ? "file" : "word"}</span>
      <input
        bind:this={field}
        value={finder.query}
        oninput={(e) => finder.type(e.currentTarget.value)}
        spellcheck="false"
        autocomplete="off"
        placeholder={finder.mode === "files"
          ? "fuzzy — csvl finds conversation.svelte.ts"
          : "a word, or a regex"}
      />
      <span class="note">{finder.rows.length}{finder.hitsTruncated ? "+" : ""}</span>
      <span class="keys"
        >enter open · ctrl+F {finder.mode === "files" ? "grep" : "files"} · esc</span
      >
    </footer>
  {/if}
  </div>
{/if}

<style>
  /* The which-key caption for a chord in progress. Low and centred, above where
     the dock sits, so it appears in the corner of your eye rather than over the
     thing you were reading. */
  .hint {
    position: fixed;
    bottom: 5.2rem;
    left: 50%;
    transform: translateX(-50%);
    z-index: 49;
    display: flex;
    align-items: baseline;
    gap: 0.7rem;
    padding: 0.3rem 0.7rem;
    border: 1px solid var(--edge);
    border-radius: 4px;
    background: var(--raised);
    box-shadow: 0 14px 40px -18px rgba(0, 0, 0, 0.9);
    /* A caption, not a control — see the note in the markup. */
    pointer-events: none;
    font-family: var(--util);
    font-size: 0.66rem;
    color: var(--paper-mute);
  }
  .lead {
    font-size: 0.61rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  .offer {
    display: inline-flex;
    align-items: baseline;
    gap: 0.4ch;
  }
  .hint kbd {
    font-family: var(--mono);
    font-size: 0.68rem;
    color: var(--paper);
  }

  /* Middle of the window, over the wall — the same placement the console has,
     and wider, because a result row is a path *and* a line of source. */
  .pane {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 50;
    display: flex;
    flex-direction: column;
    width: min(150ch, 90vw);
    height: min(74vh, 780px);
    border: 1px solid var(--rule);
    border-radius: 5px;
    /* Opaque, like everything else standing on this wall. */
    background: var(--surface);
    box-shadow: 0 30px 90px -28px rgba(0, 0, 0, 0.95);
    overflow: hidden;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.4rem 0.5rem 0.4rem 0.6rem;
    border-bottom: 1px solid var(--edge);
    background: var(--raised);
    flex: 0 0 auto;
  }
  .mark {
    font-family: var(--util);
    font-size: 0.61rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--paper-mute);
  }
  .path {
    font-family: var(--mono);
    font-size: 0.66rem;
    color: var(--paper-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Celadon, because it is the same fact the cards state in it: working. */
  .run {
    font-family: var(--util);
    font-size: 0.63rem;
    color: var(--st-work);
  }
  /* Achromatic — that a search was capped, or read literally, or that a file is
     4kB, is chrome about the answer and not a status of anything. */
  .note {
    font-family: var(--util);
    font-size: 0.63rem;
    color: var(--paper-faint);
  }
  .grow {
    flex: 1 1 auto;
  }

  .ghost {
    font-family: var(--util);
    font-size: 0.66rem;
    background: none;
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper-mute);
    padding: 0.1rem 0.38rem;
    cursor: pointer;
  }
  .ghost:hover {
    color: var(--paper);
    border-color: var(--rule);
  }
  .ghost.on {
    color: var(--paper);
  }
  .x {
    background: none;
    border: none;
    color: var(--paper-faint);
    cursor: pointer;
    font-size: 0.72rem;
    padding: 0 0.15rem;
  }
  .x:hover {
    color: var(--paper);
  }

  /* The list and the preview, side by side. The list gets less than half: a
     path is shorter than a line of source, and the preview is the half that
     tells you whether the row under the selection is the one you meant. */
  .body {
    flex: 1 1 auto;
    display: grid;
    grid-template-columns: minmax(0, 4fr) minmax(0, 5fr);
    min-height: 0;
  }

  .results {
    overflow-y: auto;
    background: var(--ink);
    padding: 0.3rem 0;
    border-right: 1px solid var(--edge);
    min-height: 0;
  }

  .row {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-left: 2px solid transparent;
    cursor: pointer;
    font-family: var(--mono);
    font-size: 0.7rem;
    line-height: 1.5;
    padding: 0.05rem 0.6rem 0.05rem 0.5rem;
    color: var(--paper-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row:hover {
    background: var(--surface);
  }
  /* The selection is a band and a brighter line, never a colour — colour on
     this wall is status, and which row your hand is on is not a status. */
  .row.sel {
    background: var(--raised);
    border-left-color: var(--paper-mute);
    color: var(--paper);
  }
  .dir {
    color: var(--paper-faint);
  }
  .name {
    color: inherit;
  }
  .at {
    color: var(--paper-faint);
  }
  .text {
    color: var(--paper-mute);
    margin-left: 1ch;
  }
  /* Where the query landed. Brighter and heavier rather than coloured, for the
     reason above — and it is what makes a fuzzy list readable at all: without
     the marks you cannot tell why the third row is above the fourth. */
  .mk {
    color: var(--paper);
    font-weight: 700;
  }

  .preview {
    overflow: auto;
    background: var(--well);
    padding: 0.4rem 0 0.6rem;
    font-family: var(--mono);
    font-size: 0.68rem;
    line-height: 1.5;
    min-height: 0;
  }

  .ln {
    display: flex;
    gap: 0.8ch;
    white-space: pre;
    color: var(--paper-dim);
  }
  /* The line the hit is on. A band rather than coloured text, so the source
     still reads as source. */
  .ln.hit {
    background: var(--raised);
    color: var(--paper);
  }
  .no {
    flex: 0 0 auto;
    width: 5ch;
    text-align: right;
    color: var(--paper-faint);
    user-select: none;
  }
  .src {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .empty,
  .bad {
    margin: 0.35rem 0.75rem;
    font-family: var(--util);
    font-size: 0.7rem;
    color: var(--paper-faint);
  }
  .bad {
    color: var(--st-fail);
  }

  /* ── the viewer ──────────────────────────────────────────────────────── */

  .sheetbar {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    flex: 0 0 auto;
    padding: 0.25rem 0.6rem;
    border-bottom: 1px solid var(--edge);
    font-family: var(--mono);
    font-size: 0.68rem;
    color: var(--paper);
    background: var(--surface);
  }

  .sheet {
    flex: 1 1 auto;
    overflow: auto;
    background: var(--well);
    padding: 0.5rem 0 1.2rem;
    font-family: var(--mono);
    font-size: 0.7rem;
    line-height: 1.55;
    min-height: 0;
    outline: none;
  }
  /* A document rather than a listing: it wants a measure and margins, not a
     line-numbered gutter. The transcript's own reading size and leading,
     because it is the same act of reading — and a measure, because a rule read
     across 150 characters is one you lose your place in. */
  .sheet.prose {
    padding: 1.2rem 1.8rem 3rem;
    font-family: var(--body);
    /* Fallbacks carrying each knob's own base value, which is the bargain every
       theme knob strikes here: a bare `var()` that resolves to nothing makes the
       declaration invalid at computed-value time — an inherited size for
       `font-size`, and black on a dark wall for `color`. `test/theme.test.ts`
       is what noticed. */
    font-size: var(--tx-size, 0.86rem);
    line-height: var(--tx-leading, 1.55);
    color: var(--tx-prose, var(--paper-dim));
  }
  .sheet.prose :global(> *) {
    max-width: 78ch;
  }

  footer {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex: 0 0 auto;
    border-top: 1px solid var(--edge);
    padding: 0.35rem 0.6rem 0.4rem;
    background: var(--surface);
  }
  .prompt {
    font-family: var(--util);
    font-size: 0.61rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--paper-mute);
    white-space: nowrap;
  }
  footer input {
    flex: 1 1 auto;
    background: none;
    border: none;
    outline: none;
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--paper);
    padding: 0;
  }
  footer input::placeholder {
    color: var(--paper-faint);
  }
  .keys {
    font-family: var(--util);
    font-size: 0.61rem;
    color: var(--paper-faint);
    white-space: nowrap;
  }
</style>
