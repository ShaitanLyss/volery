<script lang="ts">
  /* The strip of files kept to hand, above the dock.
     One pill per file the viewer has opened, so coming back to one is a click
     rather than a search and a scroll.

     Where it sits is the whole trick and it needs no arithmetic: absolutely
     placed inside `main.wall`, anchored by `bottom`. The wall ends exactly where
     the dock begins, so the strip sits on the dock's top edge however tall the
     draft field has grown — no measurement, no CSS variable, nothing to keep in
     step. The which-key hint one file over is at a hard-coded `5.2rem` because
     it is `position: fixed`, and this is what that would have wanted.

     `pointer-events` are off on the strip and on again per pill, so the gaps
     between them are still wall: a rectangle across the bottom of the window
     that swallowed a click on a card would be a strip that cost you a gesture.

     Nothing here is a timer. The wall's own one-second tick is what burns the
     fuses down, which is `clock` — see the note in `dogears.ts`. */
  import { clock } from "./conversation.svelte";
  import {
    FUSE_MAX,
    FUSE_MIN,
    KEEP_MAX,
    burn,
    fuses,
    keyOf,
    sayFuse,
    tabLabel,
  } from "./dogears";
  import type { Finder } from "./finder.svelte";

  let { finder }: { finder: Finder } = $props();

  /** The knobs, open or not. Local, because nothing outside this needs to know
   *  a popover is up — and the two numbers themselves live on the finder, where
   *  they are read from and where the control surface can reach them. */
  let knobs = $state(false);

  /** How long each tab has left, or null for the ones that are safe. Folded off
   *  the wall's tick, so the hairlines empty without anything here scheduling a
   *  thing. */
  const left = $derived(fuses(finder.tabs, finder.keep, finder.fuse, clock.t));

  /* And the tick is also what closes them. `reap` answers with the same array
     when nothing has burned down, so a second in which nothing expires is not a
     write and nothing downstream is invalidated. */
  $effect(() => {
    finder.reap(clock.t);
  });

  /* The knobs cannot be reachable only from a strip that the knobs can empty.
     `keep: 0` is a real setting — it is the off switch — and with no tabs and
     no ⋯ there would be no way back to it, which is a setting you can enter and
     not leave. So the strip also stands while the finder is open: if you are
     using the viewer at all, what it remembers is adjustable. */
  const standing = $derived(finder.tabs.length > 0 || finder.open);

  let box: HTMLDivElement | undefined = $state();

  /* The popover takes the keyboard when it opens — the *box*, not the first
     field, which is the difference between Escape landing here and the arrow
     keys silently changing a number the moment it appears. Without this the
     focus is still on the ⋯ outside, so Escape would reach the window's handler
     and deselect the card behind this instead of putting the knobs away. */
  $effect(() => {
    if (knobs) box?.focus();
  });

  function shut(key: string) {
    finder.shut(key);
  }
</script>

<!-- A press anywhere else puts the knobs away, which is what a popover does.
     The ⋯ is deliberately excluded rather than handled: closing on its
     `pointerdown` and re-opening on its `click` would leave it a button that
     could never shut what it opened. -->
<svelte:window
  onpointerdown={(e) => {
    if (!knobs) return;
    const t = e.target;
    if (t instanceof Node && box?.contains(t)) return;
    if (t instanceof Element && t.closest(".more")) return;
    knobs = false;
  }}
/>

{#if standing}
  <div class="strip">
    {#each finder.tabs as tab (keyOf(tab))}
      {@const key = keyOf(tab)}
      {@const p = tabLabel(tab.path)}
      {@const ms = left.get(key) ?? null}
      <div
        class="tab"
        class:on={finder.openKey === key}
        class:risk={ms !== null}
      >
        <button
          class="face"
          onclick={() => void finder.resume(tab)}
          onauxclick={(e) => {
            /* Middle-click closes, which is what it does to a tab everywhere
               else. `auxclick` rather than a `mousedown` guard, since that is
               the event the middle button actually has. */
            if (e.button === 1) {
              e.preventDefault();
              shut(key);
            }
          }}
          title={ms === null
            ? `${tab.root}\n${tab.path}${tab.line === null ? "" : `:${tab.line}`}\n\nback to where you were — middle-click to close`
            : `${tab.root}\n${tab.path}\n\n${sayFuse(ms)}`}
        >
          <span class="dir">{p.dir}</span><span class="name">{p.name}</span
          >{#if tab.line !== null}<span class="at">:{tab.line}</span>{/if}
        </button>
        <button class="x" onclick={() => shut(key)} title="Close this one">✕</button>
        <!-- The fuse, drawn only where there is one. A safe tab has no hairline
             rather than a full one: a line under every pill would read as
             chrome, and this has to read as a thing running out. -->
        {#if ms !== null}
          <i class="fuse" style:--burn={burn(ms, finder.fuse)}></i>
        {/if}
      </div>
    {/each}

    <button
      class="more"
      class:on={knobs}
      onclick={() => (knobs = !knobs)}
      title="How many files are kept to hand, and for how long">⋯</button
    >

    {#if knobs}
      <!-- On the strip rather than in a settings panel, because there is no
           settings panel in this app and inventing one for two numbers puts
           them a panel away from the only thing they are about. -->
      <!-- `role="dialog"` and a `tabindex` for the same reason `Spyglass`'s pane
           carries them: the Escape handler is on the box rather than on each
           field in it, and a plain `div` with a keydown is a non-interactive
           element with a keyboard listener. -->
      <div
        class="knobs"
        role="dialog"
        aria-label="files kept to hand"
        tabindex="-1"
        bind:this={box}
        onkeydown={(e) => {
          if (e.key === "Escape") {
            /* Stopped from bubbling, or the window's handler takes the same
               press and deselects the card behind this. */
            e.preventDefault();
            e.stopPropagation();
            knobs = false;
          }
        }}
      >
        <div class="title">files kept to hand</div>
        <label class="knob">
          <span class="kname">tabs kept</span>
          <input
            class="kin"
            type="number"
            min="0"
            max={KEEP_MAX}
            value={finder.keep}
            onchange={(e) => finder.setKeep(e.currentTarget.value)}
          />
        </label>
        <label class="knob">
          <span class="kname">the rest close after</span>
          <input
            class="kin"
            type="number"
            min={FUSE_MIN}
            max={FUSE_MAX}
            value={finder.fuse}
            onchange={(e) => finder.setFuse(e.currentTarget.value)}
          />
          <span class="unit">min</span>
        </label>
        <p class="why">
          {finder.keep === 0
            ? "nothing is kept — the strip is off. set a count to switch it back on."
            : `past the ${finder.keep === 1 ? "first" : `${finder.keep} most recent`}, a tab you have not come back to closes itself. coming back to one resets its fuse.`}
        </p>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Sat on the dock's top edge, because the wall ends there. Left-aligned and
     never centred: a strip that re-centred itself every time a pill appeared
     would be a row of buttons that are never twice in the same place. */
  .strip {
    position: absolute;
    left: 0.9rem;
    right: 0.9rem;
    bottom: 0.5rem;
    /* Above `Canvas`'s `.glass` (4), which is the highest thing inside the wall
       and is where a stuck widget lives. Said out loud for the reason the glass
       says its own: this is later in the document than the canvas but earlier
       than `.side`, so source order alone would put it behind the transcript.
       And it may cover the transcript's bottom edge when the tabs wrap, which
       is the same bargain the glass strikes — over the panel, never over the
       dock or the header, and that last part is a fact about the DOM rather
       than a number, since the wall ends where the dock begins. */
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.35rem;
    /* The gaps between the pills are still wall — see the note above. */
    pointer-events: none;
  }

  .tab {
    position: relative;
    display: inline-flex;
    align-items: baseline;
    max-width: 34ch;
    border: 1px solid var(--edge);
    border-radius: 999px;
    /* Opaque, like everything else standing on this wall — the backdrop draws
       behind everything and a leaf through the middle of a filename is the bug
       a dormant card once had. */
    background: var(--raised);
    box-shadow: 0 14px 40px -18px rgba(0, 0, 0, 0.9);
    overflow: hidden;
    pointer-events: auto;
  }
  /* The one whose file is on screen. A brighter rule and brighter text, never a
     colour: colour on this wall is status, and which file you are reading is
     not one. */
  .tab.on {
    border-color: var(--rule);
  }
  .tab.on .name {
    color: var(--paper);
  }
  /* Out of the safe count and burning down. Dimmed rather than marked, so the
     strip reads as recent-and-bright shading into about-to-go. */
  .tab.risk {
    opacity: 0.55;
  }
  .tab.risk:hover {
    opacity: 1;
  }

  .face {
    display: inline-flex;
    align-items: baseline;
    gap: 0;
    background: none;
    border: none;
    cursor: pointer;
    font-family: var(--mono);
    font-size: 0.72rem;
    line-height: 1.5;
    padding: 0.16rem 0.2rem 0.18rem 0.62rem;
    color: var(--paper-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .face:hover .name {
    color: var(--paper);
  }
  .dir {
    color: var(--paper-faint);
  }
  .name {
    color: inherit;
  }
  .at {
    color: var(--paper-faint);
  }

  .x {
    flex: 0 0 auto;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--paper-faint);
    font-size: 0.6rem;
    padding: 0.16rem 0.55rem 0.18rem 0.25rem;
  }
  .x:hover {
    color: var(--paper);
  }

  /* A hairline across the foot of the pill, emptying from the right. Under the
     text rather than beside it: this is a quantity, and a number counting down
     is a number you watch. */
  .fuse {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 1px;
    width: calc(100% * var(--burn, 0));
    background: var(--paper-faint);
  }

  .more {
    flex: 0 0 auto;
    pointer-events: auto;
    background: var(--raised);
    border: 1px solid var(--edge);
    border-radius: 999px;
    cursor: pointer;
    color: var(--paper-faint);
    font-family: var(--util);
    font-size: 0.72rem;
    line-height: 1;
    padding: 0.24rem 0.5rem 0.3rem;
    box-shadow: 0 14px 40px -18px rgba(0, 0, 0, 0.9);
  }
  .more:hover,
  .more.on {
    color: var(--paper);
    border-color: var(--rule);
  }

  /* The knobs, over the strip they belong to. */
  .knobs {
    position: absolute;
    left: 0;
    bottom: 100%;
    margin-bottom: 0.45rem;
    width: 20rem;
    pointer-events: auto;
    border: 1px solid var(--rule);
    border-radius: 5px;
    background: var(--surface);
    box-shadow: 0 26px 70px -26px rgba(0, 0, 0, 0.95);
    padding: 0.5rem 0.7rem 0.6rem;
  }
  .title {
    font-family: var(--util);
    font-size: 0.61rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--paper-mute);
    margin-bottom: 0.35rem;
  }
  .knob {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding: 0.2rem 0;
  }
  .kname {
    flex: 1 1 auto;
    font-family: var(--util);
    font-size: 0.76rem;
    color: var(--paper-dim);
  }
  .kin {
    flex: 0 0 auto;
    width: 4.2rem;
    background: var(--well);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper);
    font-family: var(--mono);
    font-size: 0.74rem;
    padding: 0.1rem 0.35rem;
    text-align: right;
  }
  .kin:focus {
    outline: none;
    border-color: var(--rule);
  }
  .unit {
    flex: 0 0 auto;
    font-family: var(--util);
    font-size: 0.7rem;
    color: var(--paper-faint);
  }
  .why {
    margin: 0.45rem 0 0;
    font-family: var(--body);
    font-size: 0.78rem;
    line-height: 1.45;
    color: var(--paper-faint);
  }
</style>
