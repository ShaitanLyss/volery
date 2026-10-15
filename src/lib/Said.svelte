<script lang="ts">
  /* What a card said, as the transcript would render it, in a scroller with a
     ceiling — so a long message scrolls here rather than pushing whatever
     stands beside it (the reply field, under a notice) off the bottom of the
     window.

     One component for every surface that reads a card's last message: the
     notice in the dock and the away pile, and the glance a question or a card
     opens (`Glance.svelte`). It was the notice's own markup until a second
     surface wanted it, and two copies of a reading are two places for it to
     drift — `Ask.svelte`'s argument for being drawn by both the dock and the
     pile, one component over.

     Parsed here, so it is parsed only where one is mounted: a glance is mounted
     while it is open and not before, and nothing on a card face pays for a
     message nobody opened. */
  import Markdown from "./Markdown.svelte";
  import { parseMarkdown } from "./markdown";

  let {
    text,
    empty = "nothing said yet",
    el = $bindable(null),
  }: {
    text: string;
    /** What stands in for a message when there is none. */
    empty?: string;
    /** The scroller, for a surface that scrolls it from the keyboard. */
    el?: HTMLElement | null;
  } = $props();

  const blocks = $derived(parseMarkdown(text));
</script>

<!-- tabindex: a region that scrolls has to be reachable by a key that scrolls
     it, or a long message is mouse-only. `data-scroll` is the wall's wheel
     marker (layout.md, "The wheel, and the fourth marker"): inert everywhere
     but on the wall, where a widget can carry this reader. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="said" bind:this={el} tabindex="0" data-scroll>
  {#if text.trim()}
    <Markdown {blocks} nav={false} />
  {:else}
    <span class="none">{empty}</span>
  {/if}
</div>

<style>
  /* The ceiling is a variable so a surface with a box of its own — a widget
     sized by hand — can lift it (`--said-ceiling: none`) and let its box be
     the bound instead. The notice and the glance keep the default. */
  .said {
    max-height: var(--said-ceiling, 16rem);
    flex: 0 1 auto;
    min-height: 3.2rem;
    overflow-y: auto;
    border: 1px solid var(--edge);
    border-radius: 3px;
    background: var(--well);
    padding: 0.45rem 0.6rem;
    font-size: 0.86rem;
    line-height: 1.55;
    color: var(--paper-dim);
  }
  .said:focus {
    outline: none;
  }
  .said:focus-visible {
    border-color: var(--paper-faint);
  }
  .none {
    font-style: italic;
    color: var(--paper-faint);
  }
  .said :global(p) {
    margin: 0;
  }
  .said :global(p + p),
  .said :global(ul),
  .said :global(ol) {
    margin-top: 0.4em;
  }
</style>
