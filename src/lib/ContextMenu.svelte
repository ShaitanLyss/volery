<script lang="ts">
  /* The right-click, drawn.
   *
   * `menu.ts` decides what appears; this turns ids into calls and never decides
   * what is offered. The one thing it owns outright is *where* — a menu near the
   * bottom of the wall is nudged back inside the window rather than opening half
   * off the edge.
   *
   * ## The submenu
   *
   * A `more` row opens a list beside it instead of doing something. It arrived
   * when the widget menu passed nineteen rows — a browser widget and an Asana
   * board landed on the same afternoon — and one level is all there is: a
   * submenu inside a submenu is a gesture you have to hold still for twice.
   * `menu.ts`'s `offerItems` cannot produce one and `menu.test.ts` asserts that,
   * which is why the nested `{#each}` below handles only leaves.
   *
   * **It is measured before it is shown, not corrected afterwards.** Same
   * argument `window::settle` makes about the main window: a panel that appears
   * off the edge and then jumps back inside is a jump you watch, where one that
   * was placed correctly in the first place is simply where you expected it. So
   * the submenu renders transparent for one frame, its size is read, and then it
   * is placed — flipped to the left of its row if the window's right edge is
   * closer than its width, lifted if its bottom would be.
   *
   * **There is no gap between a row and its submenu**, which is the whole of why
   * this needs no timers. The classic submenu bug is a dead zone you have to
   * cross diagonally before the thing closes; with the list flush against the
   * row, moving into it never leaves the pair, and moving onto any other row
   * closes it because that row says so. */

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
    onpick: (id: string) => void;
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

  /* ── the submenu ─────────────────────────────────────────────────────────*/

  /** Which `more` row is open, if any. One at a time: they are all at the same
   *  level, so two open lists would overlap each other. */
  let open = $state<string | null>(null);
  let subEl = $state<HTMLDivElement>();
  /** The open row's own box, taken when it opens — what the placement is
   *  relative to. */
  let rowBox = $state({ x: 0, y: 0, w: 0 });
  /** And the submenu's, taken after it has rendered once. Zero means "not
   *  measured yet", which is what keeps it invisible for that frame. */
  let subBox = $state({ w: 0, h: 0 });

  $effect(() => {
    if (!subEl) {
      subBox = { w: 0, h: 0 };
      return;
    }
    const r = subEl.getBoundingClientRect();
    /* Read off the element as rendered rather than from a guess about its
       content: the labels are arbitrary and `min-width` is a floor, not the
       width. */
    subBox = { w: r.width, h: r.height };
  });

  const placed = $derived(subBox.w > 0);
  /** To the left of its row instead of the right, where the window's edge is
   *  nearer than the list is wide. */
  const flip = $derived(placed && rowBox.x + rowBox.w + subBox.w + PAD > window.innerWidth);
  /** And how far up, where the list would otherwise run off the bottom. Zero in
   *  the ordinary case, so a submenu near the top of the wall lines up with its
   *  row exactly. */
  const lift = $derived(
    placed ? Math.max(0, rowBox.y + subBox.h + PAD - window.innerHeight) : 0,
  );

  function reveal(id: string, row: HTMLElement) {
    const r = row.getBoundingClientRect();
    rowBox = { x: r.x, y: r.y, w: r.width };
    /* Cleared rather than kept, so the next submenu is placed from its own
       measurement instead of inheriting the last one's — which would be wrong
       for a row at a different height and, worse, would be wrong *visibly*,
       since `placed` would already be true. */
    subBox = { w: 0, h: 0 };
    open = id;
  }

  function keyOn(e: KeyboardEvent, it: MenuItem, row: HTMLElement) {
    if (it.kind !== "more") return;
    if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      reveal(it.id, row);
    } else if (e.key === "ArrowLeft") {
      open = null;
    }
  }
</script>

<!-- Escape closes the submenu first where one is open, and the menu otherwise.
     The wall's standing contract for the key — whatever is on top owns it — and
     without the first half, backing out of a family would take the whole menu
     with it. -->
<svelte:window
  onkeydown={(e) => {
    if (e.key !== "Escape") return;
    if (open) open = null;
    else onclose();
  }}
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
      {:else if it.kind === "more"}
        <!-- `position: relative`, so the list beside it is placed off the row
             rather than off the menu — which is what makes it flush, and what
             makes the flush adjacency that removes the need for a close
             timer. -->
        <div class="nest">
          <button
            class="row more"
            class:open={open === it.id}
            data-menu={it.id}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === it.id}
            onpointerenter={(e) => reveal(it.id, e.currentTarget)}
            onfocus={(e) => reveal(it.id, e.currentTarget)}
            onclick={(e) => reveal(it.id, e.currentTarget)}
            onkeydown={(e) => keyOn(e, it, e.currentTarget)}
          >
            {it.label}
            <!-- Drawn in CSS rather than typed, the same trap the check mark
                 below avoids: a "▸" falls through to Segoe UI Emoji here and
                 comes out blue. -->
            <span class="chev" aria-hidden="true"></span>
          </button>
          {#if open === it.id}
            <div
              class="menu sub"
              class:placed
              class:flip
              style:--lift="{lift}px"
              bind:this={subEl}
              role="menu"
            >
              <!-- Leaves only. `menu.ts`'s `offerItems` produces one level and
                   `menu.test.ts` holds it, which is why there is no recursion
                   here and no arm for a nested `more`. -->
              {#each it.items as sub, j (j)}
                {#if sub.kind === "item"}
                  <button
                    class="row"
                    class:danger={sub.danger}
                    data-menu={sub.id}
                    role="menuitem"
                    onclick={() => onpick(sub.id)}
                  >
                    {sub.label}
                  </button>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <button
          class="row"
          class:danger={it.danger}
          class:pick={it.on !== undefined}
          class:on={it.on}
          data-menu={it.id}
          role={it.on === undefined ? "menuitem" : "menuitemradio"}
          aria-checked={it.on}
          onpointerenter={() => (open = null)}
          onclick={() => onpick(it.id)}
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

  /* ── a family, and the list beside it ──────────────────────────────────*/

  .nest {
    position: relative;
    display: flex;
    flex-direction: column;
  }

  .more {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.2rem;
    width: 100%;
  }
  /* Held lit while its list is open, so the pair reads as one thing rather than
     as a menu that has grown a second menu. */
  .more.open {
    background: var(--raised);
  }

  /* The mark that says there is more. A triangle out of borders rather than a
     glyph: "▸" falls through to Segoe UI Emoji on this machine and comes out
     blue, the same trap the check mark below and the ambience panel's
     layer-order buttons avoid. */
  .chev {
    flex: 0 0 auto;
    width: 0;
    height: 0;
    border-top: 3.5px solid transparent;
    border-bottom: 3.5px solid transparent;
    border-left: 4.5px solid var(--paper-faint);
  }
  .more:hover .chev,
  .more.open .chev {
    border-left-color: var(--paper);
  }

  /* Flush against the row on purpose — no gap means no dead zone to cross, and
     no dead zone means no timer to keep the list open while you cross it. The
     negative offset is the parent's own padding, so the list's first row lines
     up with the row that opened it. */
  .sub {
    position: absolute;
    left: 100%;
    top: calc(-0.22rem - var(--lift, 0px));
    margin-left: 1px;
    /* Invisible until it has been measured, so it is *placed* rather than
       corrected — see the note at the top of this file. `visibility` rather
       than `display`, because it has to be laid out to be measured at all. */
    visibility: hidden;
  }
  .sub.placed {
    visibility: visible;
  }
  .sub.flip {
    left: auto;
    right: 100%;
    margin-left: 0;
    margin-right: 1px;
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
