<script lang="ts">
  /* A document, drawn — the viewer's fifth reading.
     A spreadsheet as a grid, a Word file or a deck as prose, a PDF as itself,
     and a pre-2007 file as a plate that names it and points outside.

     Elements and nothing else, the same rule `Spyglass.svelte` keeps: every
     piece of parsing is in `office.ts`, where it is pure and tested, and every
     piece of prose goes through the repo's own `Markdown.svelte` so a Word
     document reads at the theme's reading size inside the same measure a rule
     is read at.

     Drawn at two sizes. `peek` is the preview beside the results list — a glance
     taken while your hand is on the arrow keys — and it is not merely the same
     thing smaller: it draws fewer rows, fewer blocks, and **no PDF frame at
     all**. See the note there. */
  import Markdown from "./Markdown.svelte";
  import { GRID_COLS, type Doc, type Grid } from "./office";

  let {
    doc,
    path,
    bytes,
    peek = false,
    onlink,
  }: {
    doc: Doc;
    path: string;
    bytes: number;
    peek?: boolean;
    onlink?: (href: string) => void;
  } = $props();

  /** How much of a document the preview draws. Both are about the *glance*: a
   *  preview that took as long to build as the viewer would make holding Down
   *  through a list of spreadsheets a thing you wait for. */
  const PEEK_ROWS = 40;
  const PEEK_BLOCKS = 24;

  /** Which sheet of a workbook is showing.
   *
   *  Local, and deliberately not on the dog-ear. A tab remembers a *reading* —
   *  where the scroller was and what was selected — and which sheet was in front
   *  is a fourth thing that would have to be added to that shape, to `keyOf`, and
   *  to the control surface's report of it. Worth doing the day somebody notices;
   *  not worth doing before, since a workbook opens on the sheet Excel would
   *  open it on, which is the first one. */
  let at = $state(0);

  /* Back to the first sheet when the file changes. Keyed on `path` rather than
     on `doc`, because the same workbook re-read from the cache is the same
     object and switching sheets should not be undone by a redraw. */
  $effect(() => {
    void path;
    at = 0;
  });

  const sheets = $derived(doc.kind === "sheet" ? doc.sheets : []);
  const grid = $derived<Grid | null>(sheets[Math.min(at, sheets.length - 1)] ?? null);

  /** The rows actually drawn, and how wide the widest of them is.
   *
   *  Width is measured over the drawn rows rather than taken from `GRID_COLS`,
   *  because a sheet with three columns in it should have three column headings
   *  and not two hundred and fifty-six. */
  const shown = $derived.by(() => {
    if (!grid) return { rows: [], cols: 0 };
    const rows = peek ? grid.rows.slice(0, PEEK_ROWS) : grid.rows;
    let cols = 0;
    for (const r of rows) cols = Math.max(cols, r.length);
    return { rows, cols: Math.min(cols, GRID_COLS) };
  });

  const blocks = $derived(
    doc.kind === "prose" ? (peek ? doc.blocks.slice(0, PEEK_BLOCKS) : doc.blocks) : [],
  );

  /** A spreadsheet column's name, the way the spreadsheet names it. */
  function columnName(n: number): string {
    let out = "";
    for (let i = n + 1; i > 0; i = Math.floor((i - 1) / 26)) {
      out = String.fromCharCode(65 + ((i - 1) % 26)) + out;
    }
    return out;
  }

  /* ── the pdf ────────────────────────────────────────────────────────────── */

  /** Whether this webview will draw a PDF inline.
   *
   *  A feature test rather than an assumption, and it is the whole reason there
   *  is no blank rectangle to explain: `navigator.pdfViewerEnabled` is the
   *  standard answer to "would you render `application/pdf` yourself", and where
   *  it says no the plate below offers `e` instead. A viewer that drew an empty
   *  frame and left you to work out why would be worse than one that says it
   *  cannot. */
  const canDraw = typeof navigator !== "undefined" && navigator.pdfViewerEnabled === true;

  /** The PDF, as a blob URL for the webview's own viewer.
   *
   *  **The webview draws it, and that is the decision worth arguing.** The
   *  alternatives were a JS renderer in this page (`pdf.js`) or a native one
   *  behind the IPC, and the frame wins on the three things a *reader* is judged
   *  on. Rendering: this is the same engine, so type, forms and annotations come
   *  out as they do everywhere else on the machine, rather than as a canvas
   *  approximation. Performance: pages are rasterised incrementally in a separate
   *  process, so a three-hundred-page report scrolls, and the memory it costs is
   *  not this window's. And it arrives with the things a document viewer needs
   *  and nobody wants to write — a page number, zoom, rotate, find-in-document,
   *  print — where the other two routes start from a bitmap and a scrollbar.
   *
   *  It also happens to be the stronger containment story, which is worth stating
   *  because PDF is an active format. A PDF's own script runs inside the viewer's
   *  sandboxed renderer, in another process, with no handle on this page — so it
   *  cannot reach `window.__TAURI_INTERNALS__`, which is the thing that matters in
   *  an app whose `csp` is null. A JS renderer would instead be parsing an
   *  untrusted document *in this origin*, which is safe only for as long as it is
   *  bug-free. Confining the execution beats trusting a parser with it.
   *
   *  Two costs, said plainly. The frame is foreign, so it carries none of the
   *  wall's chrome and a dog-ear cannot capture a reading inside it — a PDF tab
   *  remembers the file and not the page. And a link inside the document
   *  navigates the frame if pressed, which reaches the network; the frame is
   *  rebuilt from the bytes every time the file is opened, so nothing it does
   *  outlives the reading, and `e` is there for anyone who would rather open it
   *  in a real reader.
   *
   *  A blob rather than a `data:` URL: Chromium stopped routing `data:` URLs to
   *  the PDF viewer, so the same bytes on the other kind of URL are a download
   *  prompt. Revoked on the way out, since a blob URL is a reference the document
   *  holds until the page is gone. */
  let pdf = $state<string | null>(null);

  /* Made in an effect and not in a `$derived`, which is the correction worth
     recording: `createObjectURL` is a side effect, and a derived may be
     re-evaluated whenever something invalidates it — so a derived that minted
     one would leak a blob for every re-run that the effect below did not happen
     to pair with. An effect runs once per change and has the cleanup, which is
     the half a blob URL genuinely needs: it is a reference the document holds
     until the page goes away. */
  $effect(() => {
    if (doc.kind !== "pdf" || peek || !canDraw) {
      pdf = null;
      return;
    }
    const url = URL.createObjectURL(new Blob([doc.bytes], { type: "application/pdf" }));
    pdf = url;
    return () => {
      URL.revokeObjectURL(url);
      pdf = null;
    };
  });

  const kB = $derived(`${(bytes / 1024).toFixed(1)} kB`);
</script>

{#if doc.kind === "legacy"}
  <!-- A plate rather than an attempt. An OLE compound file is a different format
       in every respect — records in a little filesystem rather than a zip of XML
       — and a reader that opened one badly would be worse than one that names it
       and gets out of the way. -->
  <p class="plate">
    {doc.what} — this reader opens the newer formats. press <kbd>e</kbd> to open it
    outside.
  </p>
{:else if doc.kind === "pdf"}
  {#if peek}
    <!-- No frame in the preview, on purpose. A PDF viewer per arrow press would
         be a process spawned per selection, and it would take the keyboard away
         from the list you are still moving down. -->
    <p class="plate">pdf · {kB} — enter to read it</p>
  {:else if !canDraw || !pdf}
    <p class="plate">
      this webview will not draw a pdf inline — press <kbd>e</kbd> to open it outside.
    </p>
  {:else}
    <iframe class="pdf" src={pdf} title={path}></iframe>
  {/if}
{:else if doc.kind === "prose"}
  {#if !blocks.length}
    <p class="plate">
      {doc.what === "deck" ? "no text on any slide" : "no text in this document"}
    </p>
  {:else}
    <div class="prose" class:peek>
      <Markdown {blocks} nav={false} {onlink} />
    </div>
  {/if}
{:else if !grid}
  <p class="plate">no sheets in this workbook</p>
{:else}
  <div class="book">
    <!-- The tabs, where Excel puts them: along the bottom of the sheet rather
         than above it. Only when there is more than one, since a row of one tab
         is chrome saying nothing. Hidden in the preview, which is a glance at
         the sheet in front and not a thing to navigate. -->
    <div class="cells">
      <table>
        <thead>
          <tr>
            <th class="corner"></th>
            {#each { length: shown.cols } as _, c}
              <th>{columnName(c)}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each shown.rows as row, r}
            <tr>
              <th class="no">{r + 1}</th>
              {#each { length: shown.cols } as _, c}
                {@const cell = row[c]}
                <td class:num={cell?.num}>{cell?.v ?? ""}</td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
      {#if grid.capped}
        <p class="plate">— this sheet is larger than the viewer holds —</p>
      {/if}
    </div>

    {#if !peek && sheets.length > 1}
      <div class="tabs">
        {#each sheets as s, i (s.name + i)}
          <button class="tab" class:on={i === Math.min(at, sheets.length - 1)} onclick={() => (at = i)}
            >{s.name}</button
          >
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Every sentence this component says instead of drawing something. The
     viewer's own `.empty` in one word — but its own, since a component is the
     only CSS scope this codebase has. */
  .plate {
    margin: 0.35rem 0.75rem;
    font-family: var(--util);
    font-size: 0.7rem;
    color: var(--paper-faint);
  }
  .plate kbd {
    font-family: var(--mono);
    color: var(--paper);
  }

  /* The webview's viewer, given the whole pane. No border: it draws its own
     chrome and framing it would be two frames. */
  .pdf {
    display: block;
    width: 100%;
    height: 100%;
    border: none;
    background: var(--ink);
  }

  /* A document wants a measure and margins, the same reading `.sheet.prose` in
     `Spyglass.svelte` sets up — and the fallbacks carry each knob's own base
     value, which is the bargain every theme knob strikes here: a bare `var()`
     resolving to nothing makes the declaration invalid at computed-value time.
     See `test/theme.test.ts`. */
  .prose {
    padding: 1.2rem 1.8rem 3rem;
    font-family: var(--body);
    font-size: var(--tx-size, 0.86rem);
    line-height: var(--tx-leading, 1.55);
    color: var(--tx-prose, var(--paper-dim));
  }
  .prose :global(> *) {
    max-width: 78ch;
  }
  /* The preview pane is a third the width, so the document's margins have to go
     or there is no document left between them. */
  .prose.peek {
    padding: 0.5rem 0.7rem 1rem;
    font-size: 0.72rem;
  }

  /* ── a spreadsheet ───────────────────────────────────────────────────────── */

  .book {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .cells {
    flex: 1 1 auto;
    overflow: auto;
    min-height: 0;
  }

  table {
    border-collapse: separate;
    border-spacing: 0;
    font-family: var(--mono);
    font-size: 0.68rem;
    line-height: 1.6;
  }

  /* The headings stay put, which is most of what makes a grid readable at all:
     scroll forty rows down a sheet with no header row and every column is a
     guess. `sticky` in both directions, so the corner has to hold the higher
     stacking or the row numbers slide over the column letters. */
  thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--raised);
  }
  .corner {
    position: sticky;
    left: 0;
    top: 0;
    z-index: 2;
    background: var(--raised);
  }

  th {
    font-family: var(--util);
    font-size: 0.61rem;
    font-weight: 400;
    color: var(--paper-faint);
    text-align: center;
    padding: 0.05rem 0.4rem;
    border-right: 1px solid var(--edge);
    border-bottom: 1px solid var(--edge);
    user-select: none;
    white-space: nowrap;
  }
  /* The row-number gutter: sticky sideways, so scrolling right down a wide
     sheet keeps the row you are reading identified. One rule rather than two —
     `test/styles.test.ts` is what caught it being two, which is the whole point
     of that test: a bare class defined twice in one stylesheet is a second
     author not knowing about the first. */
  .no {
    position: sticky;
    left: 0;
    background: var(--raised);
    text-align: right;
    min-width: 4ch;
  }

  td {
    padding: 0.05rem 0.45rem;
    border-right: 1px solid var(--edge);
    border-bottom: 1px solid var(--edge);
    color: var(--paper-dim);
    /* A cell is one line however much is in it — a spreadsheet with a paragraph
       in B4 would otherwise draw a row eight lines tall and lose the shape of
       everything around it. The overflow is visible on hover through `title`
       nowhere: it is a viewer, and the honest reading of a long cell is that it
       is long. */
    white-space: pre;
    max-width: 48ch;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Right, because that is where a number belongs and because it is the only
     thing about a cell the text itself cannot say. Achromatic like everything
     else — `tokens.css` reserves colour for status. */
  .num {
    text-align: right;
    color: var(--paper);
  }
  tbody tr:hover td {
    background: var(--surface);
  }

  /* Along the bottom, where a workbook's tabs are. */
  .tabs {
    flex: 0 0 auto;
    display: flex;
    gap: 0.15rem;
    overflow-x: auto;
    padding: 0.2rem 0.4rem;
    border-top: 1px solid var(--edge);
    background: var(--surface);
  }
  .tab {
    flex: 0 0 auto;
    font-family: var(--util);
    font-size: 0.66rem;
    background: none;
    border: 1px solid transparent;
    border-radius: 3px;
    color: var(--paper-faint);
    padding: 0.1rem 0.45rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .tab:hover {
    color: var(--paper-mute);
  }
  .tab.on {
    color: var(--paper);
    border-color: var(--edge);
    background: var(--raised);
  }
</style>
