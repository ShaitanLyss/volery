<script lang="ts">
  /* The sidebar foot's popover (`docs/chat-mode.md` §5.7): each window of the
     allowance in front of you with its reset, today's spend, and *manage
     accounts* — the full panel, one click further. A reading, not a control:
     everything it says is `limits.ts`'s and the ledger's. */
  import { onMount } from "svelte";
  import { clock } from "./conversation.svelte";
  import { ordered, pct, said, type Window } from "./limits";
  import { clockOf } from "./allowance";

  let {
    name,
    windows,
    spend,
    onmanage,
    onclose,
  }: {
    name: string;
    windows: readonly Window[] | null;
    /** Dollars spent today on this machine (`Skein.spend`). */
    spend: number;
    onmanage: () => void;
    onclose: () => void;
  } = $props();

  let el: HTMLDivElement | undefined = $state();
  const rows = $derived(windows ? ordered([...windows]) : []);

  onMount(() => {
    el?.querySelector<HTMLButtonElement>("button")?.focus();
    const away = (e: PointerEvent) => {
      if (el && !el.contains(e.target as Node)) onclose();
    };
    const t = requestAnimationFrame(() => window.addEventListener("pointerdown", away, true));
    return () => {
      cancelAnimationFrame(t);
      window.removeEventListener("pointerdown", away, true);
    };
  });
</script>

<div
  class="pop"
  role="dialog"
  aria-label="allowance"
  tabindex="-1"
  bind:this={el}
  onkeydown={(e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onclose();
    }
  }}
>
  <h2>{name}</h2>
  {#if rows.length}
    <ul>
      {#each rows as w (w.kind + (w.scope ?? ""))}
        <li>
          <span class="what">{said(w)}</span>
          <span class="bar" aria-hidden="true"><i style:width="{Math.min(100, Math.max(0, w.used))}%"></i></span>
          <span class="pct">{pct(w.used)}</span>
          {#if w.resetsAt}<span class="back">comes back at {clockOf(w.resetsAt, clock.t)}</span>{/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p class="none">no reading of the allowance yet</p>
  {/if}
  <p class="spend">${spend.toFixed(2)} spent today</p>
  <button type="button" onclick={onmanage}>manage accounts</button>
</div>

<style>
  .pop {
    position: absolute;
    left: 10px;
    bottom: 58px;
    z-index: 8;
    width: 244px;
    padding: 12px 12px 10px;
    border-radius: var(--cv-r-m, 12px);
    border: 1px solid color-mix(in oklab, var(--edge) 70%, var(--paper) 9%);
    background: color-mix(in oklab, var(--raised) 97%, transparent);
    box-shadow: 0 24px 50px -20px color-mix(in srgb, var(--shade) 95%, transparent);
    font-family: var(--cv-ui, var(--util));
    font-size: 12.5px;
    color: var(--paper-dim);
    outline: none;
    animation: rise var(--dur-quick, 160ms) var(--ease-out, ease-out) both;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
  }
  :global(html[data-motion="still"]) .pop {
    animation: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .pop {
      animation: none;
    }
  }
  h2 {
    margin: 0 0 8px;
    font: 500 13px var(--cv-ui, var(--util));
    color: var(--paper);
  }
  ul {
    list-style: none;
    margin: 0 0 8px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  li {
    display: grid;
    grid-template-columns: 1fr auto;
    row-gap: 3px;
  }
  .bar {
    grid-column: 1 / -1;
    grid-row: 2;
    height: 4px;
    border-radius: 2px;
    background: color-mix(in oklab, var(--edge) 90%, transparent);
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    background: var(--paper-dim);
  }
  .pct {
    color: var(--paper);
  }
  .back {
    grid-column: 1 / -1;
    font-size: 11.5px;
    color: var(--cv-note, var(--paper-mute));
  }
  .none,
  .spend {
    margin: 0 0 8px;
    color: var(--cv-note, var(--paper-mute));
  }
  button {
    width: 100%;
    height: 28px;
    border-radius: 8px;
    border: 1px solid var(--cv-hair, var(--edge));
    background: color-mix(in oklab, var(--surface) 60%, transparent);
    font: inherit;
    color: var(--paper);
    cursor: pointer;
  }
</style>
