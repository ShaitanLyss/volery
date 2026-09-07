<!-- What the wall heard, and what it wants doing about it.

  One bar, four states, and it is drawn at all for a reason `voicing.svelte.ts`
  states more fully: **a voice layer that mishears and then goes quiet is
  indistinguishable from one that did not hear you**, and the second is the
  failure people give up over. So the transcript is shown whatever came of it —
  including when the answer was simply "done", where the wall moving is the
  acknowledgement and this is only the receipt.

  Its own component because it has its own vocabulary of class names, which is
  the whole of what `CLAUDE.md` says about when a subsystem earns a file: a
  component is the only CSS scope this codebase has.

  In normal flow between the wall and the dock rather than floating over either.
  The dock is `position: relative` in `.studio`'s column, so a viewport-anchored
  bar would mean guessing the dock's height in a number that goes wrong the first
  time it grows a row.
-->
<script lang="ts">
  import type { Voicing } from "./voicing.svelte";

  let { voicing }: { voicing: Voicing } = $props();
</script>

{#if voicing.showing}
  <!-- `aria-live` because the whole point of this bar is that something which
       happened without your hands is announced. -->
  <div class="hearing" role="status" aria-live="polite">
    {#if voicing.listening}
      <span class="ear" aria-hidden="true"></span>
      <span class="what">listening…</span>
    {:else}
      {#if voicing.said}
        <!-- Quoted, so a transcript that is itself a sentence about the wall
             cannot be misread as the wall talking. -->
        <span class="heard">“{voicing.said}”</span>
      {/if}

      {#if voicing.pending}
        <span class="reads">{voicing.pending.reads}?</span>
        <!-- Enter and Escape do these two from anywhere, and the buttons exist
             because a gesture that has no visible target is one you have to
             remember. `onGlobalKey` is the same pair. -->
        <button class="yes" onclick={() => void voicing.confirm()}>yes</button>
        <button class="no" onclick={() => voicing.dismiss()}>no</button>
      {:else if voicing.says}
        <span class="says">{voicing.says}</span>
        <button class="no" onclick={() => voicing.dismiss()}>dismiss</button>
      {:else}
        <button class="no" onclick={() => voicing.dismiss()}>dismiss</button>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .hearing {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    /* `align-self`, not `margin: 0 auto`. `.studio` is a flex column, so a
       plain auto margin does nothing to a stretched item — and `flex: 0 0 auto`
       because the wall above takes the free space and would otherwise squeeze
       this to nothing. */
    align-self: center;
    flex: 0 0 auto;
    margin-bottom: 0.4rem;
    max-width: min(52rem, calc(100vw - 3rem));
    padding: 0.4rem 0.7rem;
    border: 1px solid var(--edge);
    border-radius: 0.4rem;
    /* Not transparent, per `ambience.md`: the backdrop draws behind everything,
       so anything standing on the wall is the only thing occluding it. */
    background: var(--raised);
    /* Utility chrome, so the sans stack rather than the reading serif. */
    font-family: var(--util);
    font-size: 0.8rem;
    line-height: 1.35;
  }

  /* The one moving thing here, and it animates `opacity` rather than a shadow
     or a filter — `motion.md`'s finding is that the *present rate* is the term
     that matters, and a compositor-only property is the cheap one. One element,
     and only while a microphone is genuinely open. */
  .ear {
    width: 0.45rem;
    height: 0.45rem;
    flex: 0 0 auto;
    border-radius: 50%;
    /* Celadon — the wall's own word for "alive", which is exactly what an open
       microphone is. Colour is reserved for status here, and this is one. */
    background: var(--st-work);
    animation: pulse 1.4s ease-in-out infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.3;
    }
    50% {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ear {
      animation: none;
      opacity: 0.85;
    }
  }

  .what,
  .says {
    color: var(--paper-dim);
  }

  .heard {
    color: var(--paper-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* What is about to be done, which is the one thing here worth reading
     carefully — so it is the one thing at full strength. */
  .reads {
    color: var(--paper);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  button {
    flex: 0 0 auto;
    padding: 0.12rem 0.5rem;
    border: 1px solid var(--edge);
    border-radius: 0.25rem;
    background: transparent;
    color: var(--paper-dim);
    font: inherit;
    cursor: pointer;
  }

  button:hover {
    color: var(--paper);
    border-color: var(--rule);
  }

  /* The button that changes the wall, sitting beside one that does not. */
  .yes {
    color: var(--paper);
    border-color: var(--rule);
  }
</style>
