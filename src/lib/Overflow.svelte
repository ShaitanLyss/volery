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
   * Fixed escapes the cluster's clip but not the bar's stacking context, which
   * is why the panel and its catcher are lifted to the studio root as well —
   * see `layer.ts` for the press it cost.
   *
   * What is inside it is App.svelte's business. This owns the button, the
   * placement, and the two ways a panel like this gets closed. */

  import type { Snippet } from "svelte";
  import { toStudio } from "./layer";
  import { tipOf } from "./tipped.svelte";

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

  /* Opened from the keyboard, the first item takes the focus — the panel is
     lifted to the end of the studio (`layer.ts`), so Tab from the button would
     otherwise walk the rest of the bar and then the whole app before it
     reached a single folded item. A press leaves the focus alone, the way the
     context menu does. `detail` is zero for a click the keyboard made. */
  let keyed = false;
  $effect(() => {
    if (!open || !panel || !keyed) return;
    items()[0]?.focus();
  });

  const items = () =>
    panel ? [...panel.querySelectorAll<HTMLElement>("button:not(:disabled)")] : [];

  /** Shut, and give the focus back to the button if it was in the panel. */
  function shut() {
    const inside = !!panel && panel.contains(document.activeElement);
    open = false;
    if (inside) btn?.focus();
  }

  /* Arrows or `j`/`k` move between the items, Tab past either end leaves the
     panel the way it came in, and Escape is the window handler below. */
  function panelKey(e: KeyboardEvent) {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const by =
      e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "j"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "k"
          ? -1
          : 0;
    if (by && all.length) {
      e.preventDefault();
      e.stopPropagation();
      all[(at + by + all.length) % all.length].focus();
    } else if (e.key === "Tab" && (e.shiftKey ? at <= 0 : at === all.length - 1)) {
      e.preventDefault();
      shut();
    }
  }
</script>

<svelte:window onkeydown={(e) => open && e.key === "Escape" && shut()} />

{#if count > 0}
  <button
    class="ghost more"
    class:on={open}
    bind:this={btn}
    data-overflow
    onclick={(e) => {
      keyed = e.detail === 0;
      open = !open;
    }}
    aria-expanded={open}
    aria-label="{count} more in the header"
    {@attach tipOf(() => `${count} more &mdash; the window is too narrow to draw them across the bar`)}
  >
    <svg viewBox="0 0 16 4" aria-hidden="true">
      <circle cx="2" cy="2" r="1.35" />
      <circle cx="8" cy="2" r="1.35" />
      <circle cx="14" cy="2" r="1.35" />
    </svg>
  </button>
{/if}

{#if open && count > 0}
  <!-- The catcher takes the next press anywhere — the title bar and the
       window buttons included — which is what closes the panel. `pointerdown`,
       so it is gone before whatever is underneath decides what that press
       meant. -->
  <!-- Both are lifted to the studio root (`layer.ts`): the bar is a stacking
       context at the wall's own level, so drawn inside it the panel was
       painted under the band and the wall wherever it hung below the bar —
       visible, and deaf to every press on its second row. The wrapper stays
       where Svelte put it, because a block's top-level node may not move.

       Out of the bar, it is also out of the bar's `onmousedown`, which is what
       declines Tauri's window drag while the studio is spread — and the
       folded `tag` carries `data-tauri-drag-region`. Tauri listens for
       `mousedown` on `document`, so the panel stops it here: dragging the
       window by something inside a popover is never the gesture meant.

       Using an item shuts the panel. It sits above the studio's dialogs now
       (z 61 against their 40–55), so a dialog an item opens would otherwise
       come up under it, with the catcher eating the first press inside. -->
  <div class="slot">
  <div class="lifted" {@attach toStudio}>
  <div class="catch" onpointerdown={() => (open = false)} role="presentation"></div>
  <!-- A group of buttons, not a control: its handlers only route what the
       buttons inside it already do (the arrows, the shut on use). -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="panel"
    bind:this={panel}
    style:right="calc({right}px - var(--span-r, 0px))"
    style:top="calc({anchor.bottom + 4}px - var(--span-y, 0px))"
    onpointerdown={(e) => e.stopPropagation()}
    onmousedown={(e) => e.stopPropagation()}
    onclick={(e) => (e.target as Element).closest("button") && shut()}
    onkeydown={panelKey}
    role="group"
    aria-label="the rest of the header"
  >
    {@render children()}
  </div>
  </div>
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

  /* Neither wrapper is a box: the slot is an empty marker in the bar and the
     lifted span is only a handle on the two fixed layers inside it. */
  .slot,
  .lifted {
    display: contents;
  }

  /* The whole window rather than `inset: 0`, which while the studio is spread
     over every screen would be the home screen only — the studio root is then
     the containing block for anything fixed inside it (`span.ts`), and a press
     on another screen has to close this too. The two are the same box when
     nothing is spread, since the offsets are then zero. */
  .catch {
    position: fixed;
    left: calc(-1 * var(--span-x, 0px));
    top: calc(-1 * var(--span-y, 0px));
    width: 100vw;
    height: 100vh;
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
    box-shadow: 0 18px 44px -22px color-mix(in srgb, var(--shade) 90%, transparent);
  }
</style>
