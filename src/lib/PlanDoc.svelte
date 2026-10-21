<script lang="ts">
  /* A finished plan, as a document card at the end of its thread
     (`docs/chat-mode.md` §4, the table's *a finished plan*): what a planning
     turn leaves instead of a diff (`gears.md`), with the three things to do
     about it — read it, build it here, or hand it to a fresh conversation.

     The wall offers the same through a card's plan mark and its right-click;
     this is that reading drawn where chat view's reader already is. Opening
     goes through the ambient opener, rooted at the plan's own folder, which is
     the arrangement `gears.ts::planRoot` exists for: the viewer will not climb
     out of a root, and a plan lives under `~/.claude/plans`, not the project. */
  import { planTitle } from "./gears";
  import { useOpener } from "./paths.svelte";

  let {
    path,
    busy = false,
    onhere,
    onfresh,
  }: {
    path: string;
    /** The conversation is working: building is not offered mid-turn. */
    busy?: boolean;
    onhere: () => void;
    onfresh: () => void;
  } = $props();

  const opener = useOpener();
  const open = $derived(opener());
</script>

<div class="doc" role="group" aria-label="the plan it wrote">
  <svg class="i" viewBox="0 0 16 16" aria-hidden="true"
    ><path d="M4 2.5h5.5L12 5v8.5H4z" /><path d="M9.5 2.5V5H12M6 8h4M6 10.5h4" /></svg
  >
  <span class="who">
    <span class="t">{planTitle(path)}</span>
    <span class="sub">a plan, written and waiting — nothing has been changed yet</span>
  </span>
  <span class="acts">
    {#if open}
      <button type="button" onclick={() => open(path, "open")} title="read the plan">open</button>
    {/if}
    <button type="button" disabled={busy} onclick={onhere} title="leave plan first and build it in this conversation"
      >build it here</button
    >
    <button
      type="button"
      class="lead"
      disabled={busy}
      onclick={onfresh}
      title="hand the plan to a new conversation, which starts with only the plan — cheaper than this one's whole context"
      >build it in a fresh conversation</button
    >
  </span>
</div>

<style>
  .doc {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 10px 12px;
    align-items: center;
    padding: 12px 14px;
    border-radius: var(--cv-r-m, 12px);
    border: 1px solid var(--cv-hair, var(--edge));
    background: color-mix(in oklab, var(--surface) 60%, transparent);
    font-family: var(--cv-ui, var(--util));
    font-size: 13px;
    animation: arrive var(--dur-step, 240ms) var(--ease-out, ease-out) both;
  }
  @keyframes arrive {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .doc {
      animation: none;
    }
  }
  .i {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: var(--paper-mute);
    stroke-width: 1.3;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .t {
    color: var(--paper);
    font-weight: 500;
  }
  .sub {
    font-size: 12px;
    color: var(--paper-mute);
  }
  .acts {
    grid-column: 2;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  button {
    height: 28px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid var(--cv-hair, var(--edge));
    background: none;
    font: inherit;
    font-size: 12.5px;
    color: var(--paper-dim);
    cursor: pointer;
  }
  button:hover:not(:disabled),
  button:focus-visible {
    color: var(--paper);
    border-color: var(--edge);
  }
  button.lead {
    color: var(--paper);
    background: color-mix(in oklab, var(--surface) 80%, transparent);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
