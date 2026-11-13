<script lang="ts">
  /* The plate in the left strip while this wall is flying solo.
   *
   * The strip where the other walls' sections normally stand holds this rather
   * than an empty gap, because a gap reads as a failure and the one thing that
   * is true here is a choice. It is a note about the flyway's absence, not a
   * card: dotted border like another wall's region, no drop shadow, no focus,
   * no pick, no carry, no menu, no glass, nothing in the Tab cycle. Its two
   * gestures are the button and the chord. See `.claude/rules/solo.md`. */

  import type { Solo } from "./solo.svelte";
  import { PLATE_SAYS, SOLO_CHORD, openedElsewhere, soloButton } from "./solo";

  let { solo, opened }: { solo: Solo; opened: number } = $props();

  const said = $derived(openedElsewhere(opened));
</script>

<div class="plate" data-plate="solo" role="note" aria-label="flying solo">
  <h3>flying solo</h3>
  <p class="since">{solo.reading}</p>
  <p class="says">{PLATE_SAYS}</p>
  {#if said}
    <p class="opened">{said}</p>
  {/if}
  <div class="act">
    <button onclick={() => void solo.set(false)} disabled={!solo.known} title="{soloButton(true)} (space then i s)">
      fly with the others
    </button>
    <span class="chord">{SOLO_CHORD}</span>
  </div>
</div>

<style>
  .plate {
    /* One column wide comes from the wrapper Canvas places; the plate just
       fills it. Dotted, like another wall's region, and no shadow: it is not
       standing on the wall the way a card does. */
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    box-sizing: border-box;
    padding: 0.55rem 0.6rem 0.6rem;
    border: 1px dotted var(--edge);
    border-radius: 4px;
    background: var(--surface);
    color: var(--paper-mute);
  }
  h3 {
    margin: 0;
    font-family: var(--util);
    font-size: 0.64rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-weight: 400;
    color: var(--paper-faint);
  }
  .since {
    margin: 0;
    font-family: var(--mono);
    font-size: 0.66rem;
    color: var(--paper-mute);
  }
  .says {
    margin: 0;
    font-size: 0.7rem;
    line-height: 1.5;
    color: var(--paper-faint);
  }
  .opened {
    margin: 0;
    font-size: 0.68rem;
    line-height: 1.45;
    color: var(--paper-mute);
  }
  .act {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    flex-wrap: wrap;
    margin-top: 0.15rem;
  }
  button {
    font-family: var(--util);
    font-size: 0.7rem;
    background: none;
    border: 1px solid var(--paper-faint);
    border-radius: 3px;
    color: var(--paper);
    padding: 0.25rem 0.55rem;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    border-color: var(--rule);
  }
  button:disabled {
    color: var(--paper-faint);
    cursor: default;
  }
  .chord {
    font-family: var(--mono);
    font-size: 0.62rem;
    color: var(--paper-faint);
  }
</style>
