<script lang="ts">
  import type { MenuItem } from "./menu";

  let {
    x,
    y,
    items,
    onpick,
    onclose,
  }: {
    /** Where the click was, in viewport coordinates. */
    x: number;
    y: number;
    items: MenuItem[];
    /** `mod` is ctrl (or cmd) held at the moment of the click — a second thing
     *  a row can mean, for the one menu that needs one. Optional, and every
     *  other call site simply takes the id and ignores it. */
    onpick: (id: string, mod?: boolean) => void;
    onclose: () => void;
  } = $props();

  let el: HTMLDivElement | undefined = $state();
  /** Measured after mount, so the menu can be nudged back inside the window
   *  rather than opening half off the edge near the bottom of the wall. */
  let box = $state({ w: 0, h: 0 });

  $effect(() => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    box = { w: r.width, h: r.height };
  });

  const PAD = 6;
  const left = $derived(
    Math.max(PAD, Math.min(x, window.innerWidth - box.w - PAD)),
  );
  const top = $derived(
    Math.max(PAD, Math.min(y, window.innerHeight - box.h - PAD)),
  );
</script>

<svelte:window
  onkeydown={(e) => e.key === "Escape" && onclose()}
  onresize={onclose}
/>

<!-- The catcher takes the next press anywhere, which is what closes the menu.
     `pointerdown` rather than `click`, so the menu is gone before the thing
     underneath decides what that press meant. -->
<div class="catch" onpointerdown={onclose} oncontextmenu={onclose} role="presentation">
  <div
    class="menu"
    bind:this={el}
    style:left="{left}px"
    style:top="{top}px"
    onpointerdown={(e) => e.stopPropagation()}
    role="menu"
    tabindex="-1"
  >
    {#each items as it, i (i)}
      {#if it.kind === "sep"}
        <div class="sep"></div>
      {:else if it.kind === "hint"}
        <!-- Not a button. A greyed-out row invites the click it will not
             answer; this reads as a caption, which is what it is. -->
        <div class="hint">{it.text}</div>
      {:else}
        <button
          class="row"
          class:danger={it.danger}
          class:pick={it.on !== undefined}
          class:on={it.on}
          data-menu={it.id}
          role={it.on === undefined ? "menuitem" : "menuitemradio"}
          aria-checked={it.on}
          onclick={(e) => onpick(it.id, e.ctrlKey || e.metaKey)}
        >
          {it.label}
          <!-- What the row costs, where the label is what it is for. Right of
               the label and dimmer, so a menu of five reads as a list of
               choices with a price column rather than five sentences. -->
          {#if it.note}<span class="note">{it.note}</span>{/if}
        </button>
      {/if}
    {/each}
  </div>
</div>

<style>
  .catch {
    position: fixed;
    inset: 0;
    z-index: 60;
  }

  .hint {
    padding: 0.2rem 0.5rem 0.1rem;
    font-size: 0.68rem;
    color: var(--paper-faint);
    white-space: nowrap;
    /* Not selectable and not a click target: it is a caption on the menu, and a
       press that lands here should close it like any press outside a row. */
    pointer-events: none;
    user-select: none;
  }

  .menu {
    position: fixed;
    min-width: 15ch;
    padding: 0.22rem;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--edge);
    border-radius: 4px;
    background: var(--surface);
    box-shadow: 0 18px 44px -22px rgba(0, 0, 0, 0.9);
  }

  .row {
    text-align: left;
    background: none;
    border: none;
    border-radius: 3px;
    color: var(--paper);
    font-family: var(--util);
    font-size: 0.74rem;
    padding: 0.3rem 0.7rem 0.32rem 0.55rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .row:hover {
    background: var(--raised);
  }
  /* Pushed to the right edge of the row rather than trailing the label, so the
     notes line up as a column and the pairs can be compared down the menu.
     `.row` is `nowrap`, so the gap is what keeps the two halves apart at the
     widest label. */
  .row:has(.note) {
    display: flex;
    justify-content: space-between;
    gap: 1.6rem;
  }
  .note {
    color: var(--paper-faint);
    font-size: 0.68rem;
    font-family: var(--mono);
  }
  /* Colour is status, so the one warm thing here is the one that destroys
     something — and only on hover, where the intent is already formed. */
  .row.danger:hover {
    color: var(--st-fail);
  }

  /* Which of several is in force. The mark is drawn in CSS rather than typed:
     a "✓" falls through to Segoe UI Emoji here and comes out blue, the same
     trap the ambience panel's layer-order buttons and the dock's stop button
     avoid. The gutter is reserved on every item of the group so the labels
     stay on one edge whichever one is marked. */
  .row.pick {
    padding-left: 1.5rem;
    position: relative;
  }
  .row.pick.on::before {
    content: "";
    position: absolute;
    left: 0.62rem;
    top: 50%;
    width: 5px;
    height: 5px;
    margin-top: -2.5px;
    border-radius: 50%;
    background: var(--paper-dim);
  }
  .row.pick.on {
    color: var(--paper);
  }

  .sep {
    height: 1px;
    margin: 0.22rem 0.3rem;
    background: var(--edge);
  }
</style>
