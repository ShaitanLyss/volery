<script lang="ts">
  /* One file, drawn — whichever of the viewer's readings it turns out to be.
   *
   * This used to live inside `Spyglass.svelte`, which was fine while the finder
   * was the only thing that opened a file. It is not any more: an agent can
   * attach a file to a question (`ask.rs::attach_files`), and the gallery draws
   * it beside the designs in the same call. Two renderers would have been two
   * answers to "what does a `.docx` look like here", and the whole argument of
   * `finding.ts::READINGS` is that there is one table and one answer.
   *
   * So the dispatch is here and nothing else is. The *wrapper* stays with each
   * caller, because the two want different boxes — the finder's scrolls and is
   * what its dog-ear measures a reading out of, and the gallery's is a fixed
   * stage with a magnifier over it. What is shared is the part that knows a
   * `Sheet` from a `Doc` from a line of source.
   *
   * The order of the arms is load-bearing and is the order it was learned in:
   * media before `binary`, because "not a text file — nothing to read here" is
   * the right sentence for an `.exe` and was the whole of sink 28409145 when it
   * was said over a screenshot; `docFault` before `binary` too, since a
   * document that could not be made sense of is a file rather a lot can be said
   * about. */

  import type { Sheet } from "./finder.svelte";
  import { hasDocumentReading, viewLines } from "./finding";
  import { parseMarkdown } from "./markdown";
  import Folio from "./Folio.svelte";
  import Markdown from "./Markdown.svelte";

  let {
    sheet,
    rendered = null,
    line = null,
    outsideKey = null,
    onlink,
  }: {
    sheet: Sheet;
    /** Whether to draw the document reading or the source. `null` takes it
     *  from the file, which is what a caller with no toggle wants and is the
     *  only safe default — see `hasDocumentReading`, where a plain `true`
     *  drew a YAML file through the markdown parser. The finder passes its own,
     *  because it has a switch and the user's answer beats the file's. */
    rendered?: boolean | null;
    /** A line to mark, for a file opened at a grep hit. */
    line?: number | null;
    /** The key that opens this file outside, for a file the viewer cannot
     *  draw. The *key* rather than the sentence, so the sentence stays here
     *  with the `<kbd>` around it — the extraction passed a plain string for a
     *  moment and the markup was quietly lost. Null says nothing at all, which
     *  is right for a caller that offers no such gesture: a panel naming a key
     *  that does nothing is worse than one that stays quiet. */
    outsideKey?: string | null;
    onlink?: (href: string) => void;
  } = $props();

  /** The reading, with the caller's answer preferred over the file's. */
  const asDoc = $derived(rendered ?? hasDocumentReading(sheet));

  /* Both derived rather than computed in the markup, so a redraw that changes
     neither — a hover, a resize — does not re-split two megabytes of text.
     And `blocks` is gated on the reading rather than on nothing: a source file
     drawn as lines has no business paying for a markdown parse of itself. */
  const rows = $derived.by(() =>
    !sheet.binary && !asDoc ? viewLines(sheet.text) : [],
  );
  const blocks = $derived.by(() => (asDoc ? parseMarkdown(sheet.text) : []));

  const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
</script>

{#if sheet.media}
  <!-- A file the viewer draws rather than reads. The bytes come through
       `find::read_media` on a `data:` URL rather than through Tauri's asset
       protocol, because that protocol is scoped to `$APPDATA/references/**` and
       widening it to reach a project would route around `safe_join` — see the
       note on `MEDIA_CAP`.

       A video gets `controls` and nothing else: no autoplay, no loop, no
       muted-autoplay trick. Opening a file in a viewer is a reading gesture,
       and a film that starts playing because you looked at it is the panel
       doing something you did not ask for. -->
  {#if sheet.media.tooLarge}
    <p class="empty">
      {mb(sheet.bytes)} MB — too large to draw here.{#if outsideKey}
        press <kbd>{outsideKey}</kbd> to open it outside.{/if}
    </p>
  {:else if sheet.media.kind === "video"}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class="media" src={sheet.media.dataUrl} controls></video>
  {:else}
    <img class="media" src={sheet.media.dataUrl} alt={sheet.path} />
  {/if}
{:else if sheet.docFault}
  <!-- A document that could not be made sense of, and it says which — a `.docx`
       that is really a renamed zip, a workbook past the cap, a `.pdf` whose
       first bytes are not `%PDF-`. -->
  <p class="empty">
    {sheet.docFault}{#if outsideKey} — press <kbd>{outsideKey}</kbd> to open it
      outside.{/if}
  </p>
{:else if asDoc && sheet.doc}
  <!-- Parsed in `office.ts` on the way in and drawn by `Folio.svelte`; nothing
       about a format reaches this file. -->
  <Folio doc={sheet.doc} path={sheet.path} bytes={sheet.bytes} {onlink} />
{:else if sheet.binary}
  <p class="empty">not a text file — nothing to read here</p>
{:else if asDoc}
  <!-- The repo's own renderer, so a rule reads here exactly as an agent's
       answer reads in the transcript. `nav` off: that flag is about the
       transcript's rail listing a paragraph, and there is no rail here. -->
  <Markdown {blocks} nav={false} {onlink} />
{:else}
  {#each rows as l (l.no)}
    <div class="ln" class:hit={l.no === line} data-no={l.no}>
      <span class="no">{l.no}</span><span class="src">{l.text}</span>
    </div>
  {/each}
{/if}
{#if sheet.truncated}
  <p class="empty">— only the first two megabytes are shown —</p>
{/if}

<style>
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

  .empty {
    margin: 0.35rem 0.75rem;
    font-family: var(--util);
    font-size: 0.7rem;
    color: var(--paper-faint);
  }

  /* A picture or a film. Undressed, for the reason the transcript's own `.shot`
     is: whatever this is has its own frame, and the panel dressing it would be
     competing with the thing it was opened to show. `max-width: 100%` and
     `height: auto` so a 4K capture sits inside without ever scrolling
     sideways, and `--edge` underneath because a pale image on pale paper has no
     boundary at all otherwise. */
  .media {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 0 auto;
    background: var(--edge);
    outline: 1px solid var(--edge);
    outline-offset: -1px;
  }
</style>
