<script lang="ts">
  /* The archive: every timeline that has left the glass, newest first, each
   * drawn in full by the same plate the glass uses — so a plan reads the same
   * on the day it finished and a month later.
   *
   * A timeline left unfinished, because its card was closed, keeps a muted
   * marker where it stopped and offers to be picked back up — which adopts the
   * session that drew it as a new card and hands it the timeline. That offer is
   * on the plate's hover only, so a long archive does not read as a list of
   * buttons. */

  import type { Tier } from "./classify";
  import Frise from "./Frise.svelte";
  import type { Timeline } from "./timeline";

  let {
    timelines,
    ownerOf,
    onjump,
    onresume,
    onclose,
  }: {
    timelines: Timeline[];
    ownerOf: (id: string) => { tier: Tier; handle: string } | null;
    onjump: (ownerId: string, timelineId: string, rev: number) => void;
    onresume: (t: Timeline) => void;
    onclose: () => void;
  } = $props();

  const finished = $derived(timelines.filter((t) => t.state === "complete").length);
  const left = $derived(timelines.length - finished);
  /** The column's width, so every plate in it runs edge to edge rather than
   *  each being as wide as its own plan — a ragged archive reads as a list of
   *  different things. */
  let listW = $state(0);
  const rail = $derived(Math.max(320, listW - 100));
</script>

<!-- Escape closes it, which is what puts `showAnnals` in App's Escape guard. -->
<svelte:window onkeydown={(e) => e.key === "Escape" && onclose()} />

<!-- mousedown rather than click on the scrim, the shell every panel here uses:
     letting go of a drag that started inside must not dismiss it. -->
<div class="scrim" onmousedown={onclose} role="presentation">
  <div
    class="annals"
    onmousedown={(e) => e.stopPropagation()}
    role="dialog"
    aria-label="archived timelines"
    tabindex="-1"
  >
    <header>
      <div>
        <div class="eyebrow">volery</div>
        <h2>archived timelines</h2>
      </div>
      <div class="tally">
        {finished} finished{#if left}<span class="sep">·</span>{left} left unfinished{/if}
      </div>
      <button class="x" onclick={onclose} aria-label="Close">&times;</button>
    </header>

    <div class="list" data-scroll bind:clientWidth={listW}>
      {#each timelines as t (t.id)}
        {@const owner = ownerOf(t.ownerId)}
        <div class="entry">
          <Frise
            {t}
            archive
            width={rail}
            tier="rest"
            handle={owner?.handle ?? t.ownerId.slice(0, 8)}
            canJump={!!owner}
            onjump={(rev) => onjump(t.ownerId, t.id, rev)}
            onresume={() => onresume(t)}
          />
        </div>
      {:else}
        <p class="empty">nothing archived yet — a finished timeline lands here when you archive it</p>
      {/each}
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 7cqh;
    background: color-mix(in srgb, var(--ink) 78%, transparent);
  }

  .annals {
    display: flex;
    flex-direction: column;
    width: min(900px, 92cqw);
    max-height: 84cqh;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 6px;
    box-shadow: 0 30px 60px -20px rgba(0, 0, 0, 0.9);
    outline: none;
  }

  header {
    display: flex;
    align-items: flex-end;
    gap: 1.2rem;
    padding: 20px 26px 16px 50px;
    border-bottom: 1px solid var(--edge);
  }
  header > div:first-child {
    flex: 1 1 auto;
  }
  .eyebrow {
    font-family: var(--util);
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  h2 {
    margin: 2px 0 0;
    font-family: var(--display);
    font-size: 1.3rem;
    font-weight: 400;
    color: var(--paper);
  }
  .tally {
    font-family: var(--mono);
    font-size: 0.7rem;
    color: var(--paper-mute);
    white-space: nowrap;
  }
  .sep {
    margin: 0 7px;
    color: var(--paper-faint);
  }
  .x {
    align-self: flex-start;
    background: none;
    border: 0;
    color: var(--paper-mute);
    font-size: 1.1rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 0.2rem;
  }
  .x:hover {
    color: var(--paper);
  }

  .list {
    overflow-y: auto;
    padding: 4px 50px 22px;
  }
  .entry {
    display: flex;
    justify-content: center;
    border-bottom: 1px solid var(--edge);
  }
  .entry:last-child {
    border-bottom: 0;
  }
  .empty {
    margin: 2rem 0;
    text-align: center;
    font-size: 0.8rem;
    color: var(--paper-faint);
  }
</style>
