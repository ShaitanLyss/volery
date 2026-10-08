<script lang="ts">
  /* Asking before closing a card that is doing something: mid-turn, with
   * background work running (`closing.ts`), or with a timeline in flight.
   *
   * Closing a card is not undoable. A card with a timeline has a plan on the
   * glass that somebody has been watching; the close still happens if you say so
   * — the timeline goes to the archive as left unfinished and can be picked back
   * up from there — so this is a sentence, not a gate, in `Quit.svelte`'s sense.
   * The same plate asks about a card on another wall (`where`), whose own wall
   * then closes it the way its ✕ would.
   *
   * `keep it` takes the focus, so a reflexive Enter is the harmless answer, and
   * Escape means the same thing. */

  import { roman, current, fraction, type Timeline } from "./timeline";

  let {
    card,
    t = null,
    warnings = [],
    where: wall = null,
    onkeep,
    onclose,
  }: {
    card: string;
    t?: Timeline | null;
    /** What a close would cut off, from `closeWarnings`. */
    warnings?: string[];
    /** The wall the card is on, when it is not this one. */
    where?: string | null;
    onkeep: () => void;
    onclose: () => void;
  } = $props();

  const where = $derived.by(() => {
    if (!t) return "";
    const at = current(t.plan);
    return at === -1
      ? "with every step done but not completed"
      : `at step ${roman(at + 1)} of ${roman(t.plan.steps.length)}, ${Math.round(fraction(t.plan) * 100)}% of the way`;
  });

  let keepBtn = $state<HTMLButtonElement | null>(null);
  $effect(() => {
    keepBtn?.focus();
  });

  function onkey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onkeep();
    }
  }
</script>

<svelte:window onkeydown={onkey} />

<div class="scrim" role="dialog" aria-modal="true" aria-label="close {card}">
  <div class="plate">
    <h1>close {card}{wall ? ` on ${wall}` : ""}?</h1>
    {#each warnings as w}
      <p>{w}</p>
    {/each}
    {#if t}
      <p>
        Its timeline <em>{t.title}</em> is still in flight, {where}. Closing the card moves it to
        the archive as left unfinished — you can pick it back up from there, which adopts this
        conversation again.
      </p>
    {/if}
    <div class="acts">
      <button class="act" bind:this={keepBtn} onclick={onkeep}>keep it open</button>
      <button class="act danger" onclick={onclose}>close it</button>
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--well) 78%, transparent);
    animation: settle 0.16s ease-out both;
  }
  @keyframes settle {
    from {
      opacity: 0;
    }
  }
  .plate {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    max-width: 30rem;
    padding: 1.5rem 1.7rem 1.2rem;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 6px;
    box-shadow: 0 30px 60px -20px rgba(0, 0, 0, 0.9);
  }
  h1 {
    margin: 0;
    font-family: var(--display);
    font-size: 1.15rem;
    font-weight: 400;
    color: var(--paper);
  }
  p {
    margin: 0;
    font-size: 0.84rem;
    line-height: 1.55;
    color: var(--paper-dim);
  }
  em {
    font-family: var(--display);
    color: var(--paper);
  }
  .acts {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 0.2rem;
  }
  /* `Quit.svelte`'s buttons, because this is the same act one card smaller. */
  .act {
    font-family: var(--util);
    font-size: 0.78rem;
    letter-spacing: 0.03em;
    color: var(--paper-mute);
    background: transparent;
    border: 1px solid var(--edge);
    border-radius: 4px;
    padding: 0.42rem 0.9rem;
    cursor: pointer;
    transition:
      color 0.18s ease,
      border-color 0.18s ease;
  }
  .act:hover,
  .act:focus-visible {
    color: var(--paper);
    border-color: var(--rule);
  }
  .act.danger:hover,
  .act.danger:focus-visible {
    color: var(--st-fail);
    border-color: var(--st-fail);
  }
</style>
