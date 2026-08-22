<script lang="ts" module>
  /* What the button below costs the bar, kept beside the `.more` rule that
   * makes it true: 16px of dots, 0.4rem of padding either side, a pixel of
   * border either side. Exported rather than measured because the fold has to
   * reserve room for a button that is not drawn yet — nothing folds until
   * something does not fit, and the thing that does not fit is only known once
   * the button has been paid for. A reservation, in other words, and the fold
   * arithmetic is a gap pessimistic besides, so a pixel or two either way here
   * decides nothing. */
  export const MORE_WIDTH = 32;
</script>

<script lang="ts">
  /* The rest of the header, when the header no longer fits across the window.
   *
   * Its own component because it is its own vocabulary of class names, and a
   * component is the only CSS scope this codebase has — `.panel` and `.rest`
   * beside App.svelte's chrome rules would be two more selectors in a
   * stylesheet that has already had a `.ghost` collision cut out of it.
   *
   * The panel is `position: fixed` rather than absolutely placed inside the
   * bar, and that is not cosmetic: the foldable clusters in the bar clip their
   * own overflow — that is the floor that keeps the window controls reachable
   * whatever the measurement says — and a panel drawn inside one would be
   * clipped along with them. Fixed also means the panel is measured against the
   * window, so it cannot open off the right edge, which is the whole failure
   * this button exists to fix.
   *
   * What is inside it is App.svelte's business. This owns the button, the
   * placement, and the two ways a panel like this gets closed. */

  import type { Snippet } from "svelte";

  let {
    count,
    children,
  }: {
    /** How many items are folded away. Zero means this is not drawn at all —
     *  a button that opens an empty panel is worse than no button. */
    count: number;
    children: Snippet;
  } = $props();

  let open = $state(false);
  let btn: HTMLButtonElement | undefined = $state();
  let panel: HTMLDivElement | undefined = $state();

  /** Where the button ended up, read when the panel opens. */
  let anchor = $state({ right: 0, bottom: 0 });
  let width = $state(0);

  $effect(() => {
    if (!open || !btn) return;
    const r = btn.getBoundingClientRect();
    anchor = { right: window.innerWidth - r.right, bottom: r.bottom };
  });

  $effect(() => {
    if (!open || !panel) return;
    width = panel.getBoundingClientRect().width;
  });

  /* Nudged back inside the window the way the context menu is. The button is
     near the right edge by construction, so the overhang to guard against is
     the left one — a panel wider than the room between the button and the
     window edge. */
  const PAD = 6;
  const right = $derived(
    Math.max(PAD, Math.min(anchor.right, window.innerWidth - width - PAD)),
  );

  /* Folding is what happens as the window narrows, so what is folded changes
     under the panel while it is open. Nothing about that is wrong — the panel
     redraws — but a press aimed at a row that has just moved is not the press
     you made, so the panel closes rather than shuffling under the pointer. */
  $effect(() => {
    if (open && count === 0) open = false;
  });
</script>

<svelte:window onkeydown={(e) => open && e.key === "Escape" && (open = false)} />

{#if count > 0}
  <button
    class="ghost more"
    class:on={open}
    bind:this={btn}
    data-overflow
    onclick={() => (open = !open)}
    aria-expanded={open}
    aria-label="{count} more in the header"
    title="{count} more &mdash; the window is too narrow to draw them across the bar"
  >
    <svg viewBox="0 0 16 4" aria-hidden="true">
      <circle cx="2" cy="2" r="1.35" />
      <circle cx="8" cy="2" r="1.35" />
      <circle cx="14" cy="2" r="1.35" />
    </svg>
  </button>
{/if}

{#if open && count > 0}
  <!-- The catcher takes the next press anywhere, which is what closes the
       panel. `pointerdown`, so it is gone before whatever is underneath decides
       what that press meant — and it does not cover the bar's drag region, so
       the window can still be moved with the panel up. -->
  <div class="catch" onpointerdown={() => (open = false)} role="presentation"></div>
  <div
    class="panel"
    bind:this={panel}
    style:right="{right}px"
    style:top="{anchor.bottom + 4}px"
    onpointerdown={(e) => e.stopPropagation()}
    role="group"
    aria-label="the rest of the header"
  >
    {@render children()}
  </div>
{/if}

<style>
  /* Same ghost as the bar's other chrome buttons — this one is a peer of the
     buttons it is standing in for, not a control of a different order. Its own
     copy because a component is its own scope; keep the two in step. */
  .more {
    font-family: var(--util);
    font-size: 0.7rem;
    background: none;
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper-mute);
    padding: 0.22rem 0.4rem;
    cursor: pointer;
    display: grid;
    place-items: center;
    flex: 0 0 auto;
  }
  .more:hover {
    color: var(--paper);
    border-color: var(--rule);
  }
  .more.on {
    color: var(--paper);
    border-color: var(--paper-faint);
  }
  .more svg {
    width: 16px;
    height: 4px;
    fill: currentColor;
  }

  .catch {
    position: fixed;
    inset: 0;
    z-index: 60;
  }

  .panel {
    position: fixed;
    z-index: 61;
    max-width: min(22rem, calc(100vw - 12px));
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 0.45rem;
    padding: 0.5rem 0.55rem;
    border: 1px solid var(--edge);
    border-radius: 4px;
    /* Opaque, and the same surface every other panel in the app is drawn on.
       Nothing here floats over the wall — the wall is what the backdrop draws
       and this is chrome standing in front of it. */
    background: var(--surface);
    box-shadow: 0 18px 44px -22px rgba(0, 0, 0, 0.9);
  }
</style>
