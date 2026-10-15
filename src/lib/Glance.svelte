<script lang="ts">
  /* A glance: a card's last message, read in the notice's own reader over
     whatever you were doing, without moving the ring, the selection or the
     panel. Opened from a question in the dock (what prompted it), from a card's
     button, or from the keyboard (`space c r`, `space d r`, alt+R in a
     question). One at a time, mounted once at the root.

     Fixed at client coordinates, so it owes `--span-*` (CLAUDE.md): while the
     studio is spread over several screens the root is the containing block for
     anything fixed, and a box placed at a `getBoundingClientRect` would land
     offset by the home screen's origin.

     Escape closes it and goes no further — on this wall Escape stops a card's
     turn, and dismissing a reading must not interrupt an agent (`Bump.svelte`'s
     rule). A press anywhere else, or a wheel turned anywhere else, closes it
     too: the wall moving under a glance would leave it pointing at nothing. */
  import Said from "./Said.svelte";
  import { glance } from "./glancing.svelte";
  import { lastMessage, placeGlance } from "./glance";
  import { nameBesideProject } from "./naming";
  import { scopeFiles } from "./paths.svelte";

  const card = $derived(glance.card);
  const text = $derived(card ? lastMessage(card.face) : "");
  const name = $derived(card ? nameBesideProject(card.face.title) : "");

  /* A path in the message counts from the card's own directory, never from
     the focused card's — the dock's rule, for its reason. A card on another
     wall has no directory here, so its paths stay words. */
  scopeFiles(() => (card?.conv?.kind === "project" ? card.conv.cwd : null) ?? null);

  let box = $state<HTMLElement | null>(null);
  let reader = $state<HTMLElement | null>(null);
  let w = $state(0);
  let h = $state(0);
  let vw = $state(window.innerWidth);
  let vh = $state(window.innerHeight);
  const at = $derived(placeGlance(glance.anchor, { width: w, height: h }, { width: vw, height: vh }));

  /* A card that closes under an open glance takes the glance with it, and so
     does one that has stopped having anything to say (cleared). */
  $effect(() => {
    if (glance.id && !text) glance.close();
  });

  /* Opened from the keyboard, the reading takes the focus, so the keys that
     scroll it are the ones you already have in your hands. */
  $effect(() => {
    if (glance.keyed && reader) reader.focus();
  });

  const SCROLL: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, j: 1, k: -1 };
  const PAGE: Record<string, number> = { PageDown: 1, PageUp: -1, " ": 1 };

  function scroll(by: "line" | "page" | "end", dir: number) {
    if (!reader) return;
    if (by === "end") reader.scrollTop = dir > 0 ? reader.scrollHeight : 0;
    else reader.scrollBy({ top: dir * (by === "line" ? 40 : reader.clientHeight * 0.9) });
  }

  $effect(() => {
    if (!glance.id) return;
    const inside = (t: EventTarget | null) => !!box && t instanceof Node && box.contains(t);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        glance.close();
        return;
      }
      /* Ctrl with an arrow or a page key scrolls the panel from anywhere,
         field included (`App.svelte`). With a glance up it is the glance that
         is on top, so it takes those — the same keys reaching the reading
         that is in front of you. */
      const ctl = (e.ctrlKey || e.metaKey) && !e.altKey;
      const bare = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (ctl) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") scroll("line", SCROLL[e.key]!);
        else if (e.key === "PageDown" || e.key === "PageUp") scroll("page", PAGE[e.key]!);
        else return;
      } else if (bare && inside(document.activeElement)) {
        /* Focused, the reading answers the keys a pager does — `j`/`k` too,
           which would otherwise go on to the wall and into a card's draft. */
        if (e.key in SCROLL) scroll("line", SCROLL[e.key]!);
        else if (e.key in PAGE) scroll("page", e.key === " " && e.shiftKey ? -1 : PAGE[e.key]!);
        else if (e.key === "Home" || e.key === "End") scroll("end", e.key === "End" ? 1 : -1);
        else return;
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    const away = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (inside(t) || t?.closest?.("[data-glance]")) return;
      glance.close();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("wheel", away, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("wheel", away, true);
    };
  });
</script>

<svelte:window bind:innerWidth={vw} bind:innerHeight={vh} />

{#if card && text}
  <div
    class="glance"
    bind:this={box}
    bind:offsetWidth={w}
    bind:offsetHeight={h}
    class:placed={h > 0}
    style:left="calc({at.left}px - var(--span-x, 0px))"
    style:top="calc({at.top}px - var(--span-y, 0px))"
    role="dialog"
    aria-label="what {card.face.project} last said"
  >
    <div class="head">
      <span class="mark">last said</span>
      <span class="who">{card.where}{name ? ` · ${name}` : ""}</span>
      <span class="grow"></span>
      {#if card.face.working}<span class="note">still working</span>{/if}
      <button class="x" onclick={() => glance.close()} title="Close (esc)" aria-label="Close"
        ><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2L2 8" /></svg></button
      >
    </div>
    <Said {text} bind:el={reader} />
  </div>
{/if}

<style>
  .glance {
    position: fixed;
    z-index: 55;
    width: min(34rem, calc(100cqw - 16px));
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    padding: 0.55rem 0.65rem 0.65rem;
    border: 1px solid var(--edge);
    border-radius: 4px;
    /* Opaque: it stands over the wall, and the backdrop draws behind
       everything (ambience.md). */
    background: var(--surface);
    box-shadow: 0 10px 28px rgb(0 0 0 / 0.35);
    visibility: hidden;
  }
  /* Drawn once it has been measured, so it never shows a frame at the spot
     it would have taken had it been empty. */
  .glance.placed {
    visibility: visible;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-family: var(--util);
    font-size: 0.66rem;
  }
  .mark {
    font-size: 0.61rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--paper-mute);
  }
  .who {
    color: var(--paper-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 40ch;
  }
  .grow {
    flex: 1 1 auto;
  }
  .note {
    color: var(--paper-faint);
    font-style: italic;
  }
  .x {
    align-self: center;
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    background: none;
    border: 0;
    padding: 0;
    border-radius: 3px;
    cursor: pointer;
    color: var(--paper-faint);
  }
  .x svg {
    width: 8px;
    height: 8px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.3;
    stroke-linecap: round;
  }
  .x:hover,
  .x:focus-visible {
    color: var(--paper);
    background: var(--rule);
  }
</style>
