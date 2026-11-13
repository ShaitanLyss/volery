<script lang="ts">
  /* One floating rail beside the transcript: a list of places, one of them lit,
     and a click that goes there.
     Both rails are this component — the contents of an answer and the list of
     what you said differ only in what is collected and how deep an entry sits.
     See outline.ts for why the marks come off the DOM. */
  import type { Mark } from "./outline";
  import { tipOf } from "./tipped.svelte";

  let {
    label,
    marks,
    active,
    onpick,
  }: {
    label: string;
    marks: Mark[];
    /** Index into `marks`, or -1 for "above the first one" — see `readingAt`. */
    active: number;
    onpick: (i: number) => void;
  } = $props();

  let list: HTMLOListElement | undefined = $state();

  /* Keep the lit entry in view. A rail taller than its box is ordinary on a
     long answer, and a table of contents whose highlight has scrolled off the
     bottom is worse than no highlight at all.
     By arithmetic rather than `scrollIntoView`, which is free to scroll every
     ancestor as well: this box floats over the wall, and the wall would go with
     it. */
  $effect(() => {
    void active;
    /* The list itself, too: the contents rail swaps whole when you scroll from
       one round into the next, and a box left where the last list was scrolled
       to would open the new one halfway down. */
    void marks;
    const box = list;
    if (!box) return;
    const on = box.querySelector<HTMLElement>(".on");
    /* Nothing lit means the reader has not reached any of these — above the
       first mark, or back in the working part of a round whose summing-up is
       what this lists. Either way the top is where to be. */
    if (!on) {
      box.scrollTop = 0;
      return;
    }
    const top = on.offsetTop;
    const bottom = top + on.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (bottom > box.scrollTop + box.clientHeight)
      box.scrollTop = bottom - box.clientHeight;
  });
</script>

<!-- Nothing to list is nothing to draw: an empty box floating over the wall
     would be furniture standing in front of the work. -->
{#if marks.length}
  <nav class="rail" aria-label={label}>
    <span class="cap">{label}</span>
    <ol bind:this={list}>
      {#each marks as m, i (i)}
        <li>
          <button
            class:on={i === active}
            data-kind={m.kind}
            aria-current={i === active ? "true" : undefined}
            style:--depth={m.level}
            onclick={() => onpick(i)}
            {@attach tipOf(() => (m.full))}>{m.label}</button
          >
        </li>
      {/each}
    </ol>
  </nav>
{/if}

<style>
  /* Floating: it sits over the wall rather than in the panel, because the
     transcript's own column is the thing being read and must not be narrowed by
     furniture that only exists to jump about in it. Slightly lifted off the
     ground so what is behind it stays legible as wall. */
  .rail {
    pointer-events: auto;
    /* Shrink rather than squash the rail above: each scrolls inside itself once
       there is more of it than there is room for. */
    flex: 0 1 auto;
    /* Enough to stay a list. A long contents rail shrinks the one above it —
       shrink is weighted by size, so the tall one gives up the most — but
       neither may be squeezed down to its cap and a sliver. */
    min-height: 4.2rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.45rem 0.1rem 0.5rem 0.55rem;
    border: 1px solid var(--edge);
    border-radius: 4px;
    background: color-mix(in srgb, var(--surface) 88%, transparent);
    backdrop-filter: blur(6px);
  }

  .cap {
    font-family: var(--util);
    font-size: 0.6rem;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--paper-faint);
    flex: 0 0 auto;
  }

  ol {
    /* `offsetTop` above is measured against this. */
    position: relative;
    margin: 0;
    padding: 0 0.25rem 0 0;
    list-style: none;
    overflow-y: auto;
    min-height: 0;
  }

  button {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    /* The spine: a hairline the whole list shares, and the lit entry brightens
       its own segment of it. Achromatic — where you are reading is not a
       status. */
    border-left: 2px solid var(--edge);
    padding: 0.09rem 0.2rem 0.09rem calc(0.4rem + var(--depth, 0) * 0.55rem);
    font-family: var(--util);
    font-size: 0.7rem;
    line-height: 1.35;
    color: var(--paper-mute);
    cursor: pointer;
    /* One entry is one line: a rail is read by scanning down it. */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* The hierarchy is the paper ramp and the indent, nothing else — colour on
     this wall is status, and where you are in an answer is not one. A heading
     is a label over what follows it and reads as one; a list item is one line
     of many and sits back. */
  button[data-kind="h"],
  /* A heading written in bold at the head of its paragraph is a heading, and
     reads as one here: which mark it came off is the panel's business. */
  button[data-kind="lead"] {
    color: var(--paper-dim);
  }
  button[data-kind="li"] {
    color: var(--paper-faint);
  }
  button:hover {
    color: var(--paper-dim);
    border-left-color: var(--rule);
  }
  /* Last, and all of one specificity with the two above it, so where you are
     beats what kind of thing it is and beats the hover. */
  button.on {
    color: var(--paper);
    border-left-color: var(--paper-faint);
  }
</style>
