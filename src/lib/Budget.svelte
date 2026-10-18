<script lang="ts">
  /* The allowance, above the message box (`docs/chat-mode.md` §5.7).

     - **Running low**: one quiet line, *this session's allowance is 85% used ·
       it comes back at 15:40*. Achromatic, like the wall's.
     - **Run out everywhere**: the waterfall is holding what you send
       (`holding.ts`), so a banner says when it comes back, that sending still
       works, and that nothing is lost — with *use another account* and *see
       usage*, and *take it back*, which returns the whole hold to the message
       box (there is no per-message take-back; `#dropHold`).

     Run out with another account able to take it draws nothing: the waterfall
     moves the card and nothing else needs to happen (`accounts.md`). The words
     are `allowance.ts`'s. */
  import { clock } from "./conversation.svelte";
  import type { CardHandle } from "./cards.svelte";
  import type { Window } from "./limits";
  import { lowOf, outOf } from "./allowance";

  let {
    card,
    windows,
    onaccounts,
    onusage,
  }: {
    card: CardHandle;
    /** The windows of the allowance this conversation spends, or null. */
    windows: readonly Window[] | null;
    onaccounts: () => void;
    onusage: () => void;
  } = $props();

  const held = $derived(card.conv?.held ?? null);
  const out = $derived(outOf(held, clock.t, windows));
  const low = $derived(out ? null : lowOf(windows, clock.t));
</script>

{#if out}
  <section class="out" aria-live="polite" aria-label="allowance">
    <p><b>{out.head}</b> {out.body}</p>
    <div class="acts">
      <button type="button" class="btn" onclick={onaccounts}>use another account</button>
      <button type="button" class="link" onclick={onusage}>see usage</button>
      {#if held?.queue.length}
        <button
          type="button"
          class="link"
          title="the waiting messages come back to the message box (esc)"
          onclick={() => void card.do("stop")}>take it back</button
        >
      {/if}
    </div>
  </section>
{:else if low}
  <p class="low" aria-live="polite">{low}</p>
{/if}

<style>
  .low {
    width: min(calc(var(--cv-measure, 44rem) + 2rem), calc(100% - 48px));
    margin: 0 auto 8px;
    text-align: center;
    font-family: var(--cv-ui, var(--util));
    font-size: 12px;
    color: var(--cv-note, var(--paper-mute));
  }
  .out {
    width: min(calc(var(--cv-measure, 44rem) + 2rem), calc(100% - 48px));
    margin: 0 auto 10px;
    padding: 12px 14px;
    border-radius: var(--cv-r-m, 12px);
    border: 1px solid var(--cv-hair, var(--edge));
    background: linear-gradient(
      180deg,
      color-mix(in oklab, var(--surface) 80%, transparent),
      color-mix(in oklab, var(--surface) 55%, transparent)
    );
    font-family: var(--cv-ui, var(--util));
    font-size: 13px;
    line-height: 1.5;
    color: var(--paper-mute);
    animation: arrive var(--dur-step, 240ms) var(--ease-out, ease-out) both;
  }
  @keyframes arrive {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
  :global(html[data-motion="still"]) .out {
    animation: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .out {
      animation: none;
    }
  }
  .out p {
    margin: 0 0 9px;
  }
  .out b {
    font-weight: 500;
    color: var(--paper);
  }
  .acts {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  button {
    font: inherit;
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
  }
  .btn {
    height: 28px;
    padding: 0 11px;
    border-radius: 8px;
    font-size: 12.5px;
    color: var(--paper);
    border: 1px solid var(--cv-hair, var(--edge));
    background: color-mix(in oklab, var(--raised) 70%, transparent);
  }
  .link {
    font-size: 12.5px;
    color: var(--paper-dim);
  }
  .link:hover,
  .btn:hover {
    color: var(--paper);
  }
</style>
