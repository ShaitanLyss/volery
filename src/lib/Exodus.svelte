<script lang="ts">
  /* Asking before every card of a grouping moves to another machine.
   *
   * One card's move is asked for by picking it from that card's menu and needs
   * no question: it refuses a card it could lose and keeps the card here until
   * the other wall has confirmed it. A whole grouping is many of those, each
   * holding a card still and costing a turn on the other machine, so it asks
   * first with the count — `Unfinished.svelte`'s plate, one gesture larger.
   * The sentences are `moveall.ts`'s.
   *
   * `keep them here` takes the focus, so a reflexive Enter is the harmless
   * answer, and Escape means the same thing. */

  let {
    count,
    name,
    host,
    lines,
    onkeep,
    ongo,
  }: {
    /** How many cards stand in the grouping. */
    count: number;
    /** The grouping, as its handle reads. */
    name: string;
    host: string;
    /** What will happen, from `moveall.ts::departure`. */
    lines: string[];
    onkeep: () => void;
    ongo: () => void;
  } = $props();

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

<div class="scrim" role="dialog" aria-modal="true" aria-label="move {name} to {host}">
  <div class="plate">
    <h1>move {count === 1 ? "the card" : `all ${count} cards`} in {name} to {host}?</h1>
    {#each lines as l}
      <p>{l}</p>
    {/each}
    <div class="acts">
      <button class="act" bind:this={keepBtn} onclick={onkeep}>keep them here</button>
      <button class="act" onclick={ongo}>move them</button>
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
    box-shadow: 0 30px 60px -20px color-mix(in srgb, var(--shade) 90%, transparent);
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
  .acts {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 0.2rem;
  }
  /* `Unfinished.svelte`'s buttons; moving is not destructive — a card that
     cannot go stays — so neither is marked danger. */
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
</style>
