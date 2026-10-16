<script lang="ts">
  /* A closed ```mermaid fence, drawn as the diagram it describes — and, until
     it is drawn, or if it cannot be, the fence itself, exactly as any other.

     Only a *closed* fence comes here: `Markdown.svelte` sends an open one (the
     ordinary state of a fence mid-stream) down the code block path it always
     took, so a half-written diagram is a dashed code block growing a line at a
     time and never a broken drawing flickering. A closed fence's text cannot
     change again, which is what lets the drawing be cached on it — see
     `drawing.svelte.ts`.

     The drawing is an `<img>` over a `data:` URL through `InlinePicture`, like
     every other picture in the panel: its box is the diagram's own size the
     moment the frame answers, it is drawn only near the view, Enter opens it
     full size (sharp at any zoom — it is vector), and a selection across it
     copies the fence it was drawn from. */
  import InlinePicture, { scrollRootOf } from "./InlinePicture.svelte";
  import Markdown from "./Markdown.svelte";
  import { diagrams } from "./drawing.svelte";
  import { fenceMarkdown, type Drawn } from "./diagram";
  import type { Block } from "./markdown";

  let { block }: { block: Extract<Block, { t: "code" }> } = $props();

  diagrams.begin();

  const md = $derived(fenceMarkdown(block.text));
  /** What kind of diagram, off its first word — `flowchart`, `sequenceDiagram`
   *  — for the picture's name to a screen reader and in the full-size view. */
  const kind = $derived(/^\s*(?:%%[^\n]*\n\s*)*([A-Za-z-]+)/.exec(block.text)?.[1] ?? "diagram");
  const alt = $derived(`${kind.replace(/Diagram$/, "")} diagram`.replace(/^diagram diagram$/, "diagram"));

  /** The drawing for the current ink, if made. */
  let drawn = $state<Drawn | undefined>(undefined);
  /** The last drawing that was a picture — kept on screen while a change of
   *  theme is drawn again, rather than dropping back to the source between. */
  let last = $state<Extract<Drawn, { picture: unknown }> | undefined>(undefined);
  /** You asked to read the source rather than the drawing. */
  let source = $state(false);
  let near = $state(false);

  $effect.pre(() => {
    void diagrams.ink;
    const got = diagrams.known(block.text);
    drawn = got;
    if (got && "picture" in got) last = got;
  });

  $effect(() => {
    const text = block.text;
    const ink = diagrams.ink;
    if (!near || drawn) return;
    let live = true;
    void diagrams.draw(text).then((got) => {
      if (!live || diagrams.ink !== ink || block.text !== text) return;
      drawn = got;
      if ("picture" in got) last = got;
    });
    return () => {
      live = false;
    };
  });

  /** Drawn only when near the view — the first diagram is the one that loads
   *  the renderer, and a transcript scrolled past should not be what pays. */
  function watch(el: HTMLElement) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) near = true;
      },
      { root: scrollRootOf(el), rootMargin: "150% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }

  const shown = $derived(drawn && "picture" in drawn ? drawn : last);
  const error = $derived(drawn && "error" in drawn ? drawn.error : null);
</script>

<!-- `data-md` only while the drawing stands: a selection across a picture has
     nothing to read back but the fence it came from, while a selection inside
     the source is a selection of code like any other, and copies as itself. -->
<div class="diagram" data-md={shown && !source ? md : null} {@attach watch}>
  {#if shown && !source}
    <InlinePicture
      source={{ kind: "data", url: shown.picture.url }}
      {alt}
      {md}
      size={shown.w && shown.h ? { w: shown.w, h: shown.h } : undefined}
      paper={false}
    />
  {:else}
    <Markdown blocks={[block]} nav={false} diagrams={false} />
  {/if}
  {#if shown || error}
    <!-- Furniture, not speech: never copied. -->
    <div class="under" data-md="">
      {#if error && !shown}<span class="why">not drawn — mermaid could not read it: {error}</span>{/if}
      {#if shown}<button
          type="button"
          class="flip"
          aria-pressed={source}
          title={source ? "draw it as the diagram" : "read the mermaid it was drawn from"}
          onclick={() => (source = !source)}>{source ? "diagram" : "source"}</button
        >{/if}
    </div>
  {/if}
</div>

<style>
  .diagram {
    margin: 0.6em 0;
  }
  /* The drawing sits as close to its bar as the fence would to its edge. */
  .diagram :global(.pic) {
    margin-bottom: 0.2em;
  }
  .under {
    display: flex;
    align-items: baseline;
    gap: 0.6em;
    font-family: var(--util);
    font-size: 0.74em;
    color: var(--paper-mute);
    user-select: none;
  }
  .why {
    overflow-wrap: anywhere;
  }
  .flip {
    margin-left: auto;
    font: inherit;
    color: var(--paper-mute);
    background: none;
    border: 0;
    padding: 0;
    text-decoration: underline dotted;
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .flip:hover,
  .flip:focus-visible {
    color: var(--paper);
  }
</style>
