<script lang="ts">
  /* Every screen on the flyway at once: this machine's monitors, then each
   * other wall's that announces any — which a wall does only while it takes
   * work from other walls, so every cell here is one that would open.
   *
   * Lyss, 2026-10-31: *"how do I access the view where I see all the screens
   * of the flyway at the same time?"* One component, two places: chat view's
   * sheet (the sidebar's "all screens") and an overlay over the wall
   * (`space r a`). A cell is a `Screen` that opens rather than drives — a
   * thumbnail asks for 15 fps of a small picture (`cast.ts::want`), and
   * clicking it is what `onopen` says, which the mounter decides. */

  import { onMount } from "svelte";
  import { casts, type Room } from "./cast.svelte";
  import { monitorLabel } from "./cast";
  import Screen from "./Screen.svelte";

  let {
    onopen,
    onclose,
    room = "any",
  }: {
    /** What clicking a cell does, given its key. */
    onopen: (key: string) => void;
    /** Drawn over the wall rather than in chat view's sheet: a backdrop, a
     *  way out, and Escape — which here is the wall's, since nothing in the
     *  grid is being driven. */
    onclose?: () => void;
    room?: Room;
  } = $props();

  function focusOnMount(el: HTMLElement) {
    if (onclose) el.focus();
  }

  onMount(() => {
    void casts.loadMonitors(true);
  });

  const cells = $derived(casts.every);
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="grid-wrap"
  class:over={!!onclose}
  role={onclose ? "dialog" : undefined}
  aria-label="every screen on the flyway"
  tabindex={onclose ? -1 : undefined}
  {@attach focusOnMount}
  onkeydown={(e) => {
    if (onclose && e.key === "Escape" && !casts.focused) {
      e.preventDefault();
      e.stopPropagation();
      onclose();
    }
  }}
>
  <h2>
    every screen on the flyway
    <span>· click one to open it{onclose ? " · esc to close" : ""}</span>
    {#if onclose}
      <button class="shut" type="button" title="close (esc)" onclick={onclose}>close</button>
    {/if}
  </h2>
  {#if cells.length === 0}
    <p class="none">
      no screens to show yet — this machine's appear once screens are in this build, and another wall's
      while it takes work from other walls
    </p>
  {:else}
    <div class="grid">
      {#each cells as c (c.key)}
        <div class="cell" title={`${c.machine} · ${monitorLabel(c.monitor, c.all)}`}>
          <Screen sid={`grid:${c.key}`} screen={c.key} {room} onopen={() => onopen(c.key)} />
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .grid-wrap {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    padding: 1.4rem 1.8rem;
    box-sizing: border-box;
    overflow: auto;
  }
  /* Over the wall: the whole window, opaque — a grid of pictures over a wall
     of cards would be two walls at once. The home screen while spread, as
     the lightbox is. */
  .grid-wrap.over {
    position: fixed;
    inset: 0;
    z-index: 70;
    background: var(--ink);
    outline: none;
  }
  .shut {
    float: right;
    font: inherit;
    font-size: 0.8rem;
    color: var(--paper-dim);
    background: var(--raised);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.1em 0.6em;
    cursor: pointer;
  }
  .shut:hover {
    color: var(--paper);
  }
  h2 {
    margin: 0 0 1rem;
    font-family: var(--util);
    font-size: 0.95rem;
    font-weight: normal;
    color: var(--paper);
  }
  h2 span {
    color: var(--paper-faint);
  }
  .none {
    color: var(--paper-faint);
    font-size: 0.85rem;
    max-width: 36em;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1.2rem;
  }
  .cell {
    aspect-ratio: 16 / 10.5;
    border: 1px solid var(--edge);
    border-radius: 3px;
    overflow: hidden;
    background: var(--ink);
  }
</style>
