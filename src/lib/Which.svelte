<script lang="ts">
  /* Which-key, in one line and without a plugin.
   *
   * A chord half-typed is the only gesture on this wall with no affordance at
   * all — every other binding is on a button or in a title — and a leader you
   * have half-forgotten is otherwise something you read the source to remember.
   *
   * Its own component rather than markup in `App.svelte`, for the reason the
   * dock was cut out: **a component is the only CSS scope this codebase has**,
   * and a `.hint` in App's stylesheet is exactly how `.ghost` came to mean two
   * things. It lived in `Spyglass.svelte` until the leader stopped being the
   * finder's, which made a hint for the toy shelf a caption drawn by the file
   * finder — true of the code and nonsense as an arrangement.
   */
  import { offers } from "./leader";

  let { open }: { open: string } = $props();
</script>

<!-- Above where the dock sits, so it appears in the corner of your eye rather
     than over the thing you were reading.

     `pointer-events: none`, because this is a caption and not a control: the
     next thing you do is press a key, and a rectangle that swallowed a click on
     the wall behind it would be a hint that cost you a gesture. -->
<div class="hint" aria-live="polite">
  <span class="lead">space{open}</span>
  {#each offers(open) as o (o.keys)}
    <span class="offer"><kbd>{o.keys}</kbd>{o.label}</span>
  {/each}
</div>

<style>
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
</style>
