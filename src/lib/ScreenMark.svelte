<script lang="ts">
  /* The quiet mark a machine wears while another wall is watching or driving
   * one of its screens (`docs/SCREENS.md`, *Consent*): consent is the "take
   * work from other walls" switch, and this is the half of it the person at
   * the machine can see. Drawn at the window's root so it is there in either
   * view, at the top centre over the title bar, and it never takes a press.
   *
   * Amber when driven, because something is asking for the machine's hands;
   * no colour while only watched, which is not a status anybody has to act
   * on. */

  import { casts } from "./cast.svelte";

  const sessions = $derived(Object.values(casts.watched));
  const driven = $derived(sessions.filter((s) => s.driven));
  const who = (list: { viewer: string | null }[]) =>
    [...new Set(list.map((s) => s.viewer ?? "another wall"))].join(", ");
</script>

{#if sessions.length}
  <div class="mark" class:driven={driven.length > 0} role="status" aria-live="polite">
    <span class="dot" aria-hidden="true"></span>
    {#if driven.length}
      driven from {who(driven)}
    {:else}
      seen from {who(sessions)}
    {/if}
  </div>
{/if}

<style>
  .mark {
    position: fixed;
    top: 6px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 90;
    display: flex;
    align-items: center;
    gap: 0.45em;
    padding: 0.1em 0.7em;
    font-family: var(--util);
    font-size: 11px;
    color: var(--paper-dim);
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 999px;
    pointer-events: none;
    white-space: nowrap;
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--paper-faint);
  }
  .driven .dot {
    background: var(--st-ask);
  }
</style>
