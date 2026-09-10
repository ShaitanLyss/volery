<script lang="ts">
  /* The wisps: the chronicle's newest rows, standing up off the wall.
   *
   * The half of the design that is not a list. An entry in its first six
   * seconds is drawn at the edge of the card that wrote it and drifts toward the
   * register, so **where it came from is its position rather than a label** —
   * you never read "card X said Y", you watch it leave card X. Then it is a row
   * in `Register.svelte`, forever, and it is the same object: nothing here
   * appears and then vanishes, which is why there is no dismiss button anywhere
   * near it. `.claude/rules/chronicle.md` has the argument.
   *
   * Its own component rather than more markup in `Canvas`, per CLAUDE.md: a
   * component is the only CSS scope this codebase has, and `.wisp` / `.trail` /
   * `.tab` is a vocabulary of its own. `Dock.svelte` was cut out of `App` after
   * two different `.ghost` rules turned out to be one selector in a 565-line
   * stylesheet.
   *
   * ### Three things here are the motion budget, not taste
   *
   * `motion.md`'s measurement is that on this GPU the dominant term is the
   * **present rate**, not the painted area — any continuously animating element
   * makes the whole window present at display rate, so an 8px dot costs what a
   * card-sized glow costs. Therefore:
   *
   * - **`transform` and `opacity` only.** No `box-shadow` anywhere in the
   *   animation. Animating `box-shadow` is what cost ~7.98% of the GPU per
   *   working card and is the first thing anybody will reach for when a wisp
   *   wants a glow. The glow here is a static `box-shadow` on a non-animating
   *   property and a pseudo-element carrying the fade.
   * - **`html[data-motion]` gates it in CSS**, the way `Card.svelte` gates the
   *   status glow, so `still` genuinely means nothing moves. The element is
   *   still drawn — it fades in place instead of drifting — because turning
   *   motion off must cost you an animation and never a record.
   * - **Capped at `MAX_FLYING`**, and that cap is for the eye rather than the
   *   GPU: three wisps cost what one costs. Thirty is simply unreadable, so the
   *   rest are a count.
   *
   * ### And the negative animation delay is load-bearing
   *
   * Which entries are in flight is computed from `clock.t`, the wall's
   * one-second tick — deliberately, because a timer per wisp is a timer per
   * wisp, and the tick is the only wake-up an idle machine already has. That
   * means an element can mount up to a second after the entry was written, and
   * a flight starting from zero then would run a second past its own life and
   * be cut off mid-air. `animation-delay: -{age}ms` starts it already partway
   * through, so the flight is exact wherever the tick happened to fall — and it
   * also handles a wall that was in the background and has just come back.
   */

  import { clock } from "./conversation.svelte";
  import { chronicle } from "./chronicle.svelte";
  import { MAX_FLYING, WISP_MS, flying, place, statusOf, type Entry } from "./chronicle";
  import type { Box } from "./layout";

  let {
    boxes,
    target,
    viewport,
  }: {
    /** Conversation id → where that card is, in screen space. `Canvas` derives
     *  this once per view change precisely so nothing measures the DOM per
     *  frame during a pan; this is arithmetic over it and consults no element. */
    boxes: Map<string, Box>;
    /** Where the register is, if one is hung. Null is a wall with no register
     *  on it, and then a wisp rises and fades rather than drifting to nowhere. */
    target: Box | null;
    viewport: { w: number; h: number };
  } = $props();

  const now = $derived(clock.t);

  /* One reader behind however many faces — the register may also be up, and two
     attachments are one subscription. Attached from the wall rather than from
     the widget because wisps are a *wall* feature: they fly whether or not a
     register is hung, which is the whole reason the history lives in the table
     and the widget is only a view of it. */
  $effect(() => {
    chronicle.attach("wall:wisps");
  });
  $effect(() => () => chronicle.detach("wall:wisps"));

  const air = $derived(flying(chronicle.entries, now, MAX_FLYING, WISP_MS));

  type Drawn = { e: Entry; x: number; y: number; dx: number; dy: number; age: number };

  const drawn = $derived.by(() => {
    const out: Drawn[] = [];
    for (const e of air.wisps) {
      const p = place(e.from ? (boxes.get(e.from) ?? null) : null, target, viewport);
      if (p?.at === "card") out.push({ e, x: p.x, y: p.y, dx: p.dx, dy: p.dy, age: now - e.at });
    }
    return out;
  });

  /** One tab per edge, counting the cards out there rather than naming them.
   *
   *  The honest cost of drawing a notification in wall space: a card scrolled
   *  off the viewport has no position to fly from, and a wisp at a clamped
   *  position would claim to come from a card that is not there. So it says
   *  *something happened over there*, in the status colour, and nothing more. */
  const tabs = $derived.by(() => {
    const out = new Map<string, { side: string; along: number; n: number; st: string }>();
    for (const e of air.wisps) {
      const p = place(e.from ? (boxes.get(e.from) ?? null) : null, target, viewport);
      if (p?.at !== "edge") continue;
      const had = out.get(p.side);
      /* The first one's position and the worst one's colour: two wisps off the
         same edge are one tab, and if either of them is a failure that is the
         thing worth colouring it. */
      const st = statusOf(e.level);
      if (had) {
        had.n += 1;
        if (st === "fail" || (st === "ask" && had.st !== "fail")) had.st = st;
      } else {
        out.set(p.side, { side: p.side, along: p.along, n: 1, st });
      }
    }
    return [...out.values()];
  });
</script>

<!-- `aria-hidden`, and it is not an oversight. Every one of these is a row in
     the register a moment later, and the register is a list of buttons a screen
     reader can actually work through. Announcing a thing that is drifting away
     and cannot be clicked would be the worse reading of the same fact. -->
<!-- `--wisp-life` is set from `WISP_MS` rather than written twice: the flight's
     duration and the moment `flying` stops returning the entry are the same
     fact, and a stylesheet holding its own copy is a wisp that either vanishes
     mid-air or lingers invisibly. -->
<div class="wisps" aria-hidden="true" style:--wisp-life="{WISP_MS}ms">
  {#each drawn as w (w.e.id)}
    <div
      class="wisp"
      data-st={statusOf(w.e.level)}
      style:left="{w.x}px"
      style:top="{w.y}px"
      style:--dx="{w.dx}px"
      style:--dy="{w.dy}px"
      style:animation-delay="-{w.age}ms"
    >
      <i class="dot"></i>
      <span class="mark">{w.e.mark}</span>
      {#if w.e.detail}<span class="detail">{w.e.detail}</span>{/if}
    </div>
  {/each}

  {#each tabs as t (t.side)}
    <div class="tab" data-side={t.side} data-st={t.st} style:--along="{t.along}px">
      {t.n > 1 ? t.n : ""}
    </div>
  {/each}

  {#if air.overflow > 0}
    <div class="more">+{air.overflow}</div>
  {/if}
</div>

<style>
  [data-st="work"] {
    --st: var(--st-work);
  }
  [data-st="ask"] {
    --st: var(--st-ask);
  }
  [data-st="fail"] {
    --st: var(--st-fail);
  }
  [data-st="rest"] {
    --st: var(--st-rest);
  }

  /* Screen space, over the wall, and `pointer-events: none` throughout: a wisp
     is drifting and is not a target. The register is where you click a row, and
     it has the same row a moment later. Without this, a wisp crossing the wall
     would eat a click meant for a card underneath it — and it would do it
     intermittently, which is the worst kind. */
  .wisps {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    /* Above the cards, below the panel. */
    z-index: 60;
  }

  .wisp {
    position: absolute;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    max-width: 22rem;
    padding: 0.4rem 0.6rem;
    border-radius: 4px;
    background: var(--raised);
    border: 1px solid var(--rule);
    /* Static, not animated — see the head comment. This is the one property the
       measurement says never to put in an animation. */
    box-shadow:
      inset 2px 0 0 var(--st),
      0 12px 26px -8px rgba(0, 0, 0, 0.8);
    /* Drawn from the card's top edge, centred on it, and rising out of it. */
    transform: translate(-50%, -100%);
    animation: rise var(--wisp-life, 6000ms) cubic-bezier(0.22, 0.61, 0.36, 1) forwards;
    will-change: transform, opacity;
  }

  /* transform and opacity only. `translate3d` so the whole thing is one
     composited layer rather than a re-raster per frame. */
  @keyframes rise {
    0% {
      transform: translate(-50%, -100%) translate3d(0, 6px, 0) scale(0.96);
      opacity: 0;
    }
    9% {
      transform: translate(-50%, -100%) translate3d(0, 0, 0) scale(1);
      opacity: 1;
    }
    62% {
      transform: translate(-50%, -100%) translate3d(calc(var(--dx) * 0.36), calc(var(--dy) * 0.36), 0)
        scale(0.97);
      opacity: 1;
    }
    100% {
      transform: translate(-50%, -100%) translate3d(var(--dx), var(--dy), 0) scale(0.82);
      opacity: 0;
    }
  }

  /* `spare` keeps the reading and drops the travel: it appears, holds, and goes,
     with no continuous motion in between. `steps()` is what made the status glow
     1.3% against 12.2% — the present rate falls because the compositor has
     nothing to interpolate. */
  :global(html[data-motion="spare"]) .wisp {
    animation-name: holdthen;
    animation-timing-function: steps(4, end);
  }

  @keyframes holdthen {
    0% {
      opacity: 0;
    }
    12%,
    78% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }

  /* And `still` means still. The wisp is drawn, does not move, and is gone when
     `flying` stops returning it — you lose the flight, never the record. */
  :global(html[data-motion="still"]) .wisp {
    animation: none;
    opacity: 1;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--st);
    flex: none;
  }

  .mark {
    font-size: 0.82rem;
    color: var(--paper);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .detail {
    font-family: var(--util);
    font-size: 0.68rem;
    color: var(--paper-mute);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: none;
    max-width: 45%;
  }

  /* The edge tab. Small, quiet, and deliberately not a button — see `tabs`. */
  .tab {
    position: absolute;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--util);
    font-size: 0.6rem;
    color: var(--paper-mute);
    background: var(--raised);
    border: 1px solid var(--edge);
    animation: tabfade var(--wisp-life, 6000ms) ease-out forwards;
  }

  .tab[data-side="left"],
  .tab[data-side="right"] {
    top: var(--along);
    width: 18px;
    height: 46px;
    transform: translateY(-50%);
  }

  .tab[data-side="left"] {
    left: 0;
    border-left: none;
    border-radius: 0 4px 4px 0;
    box-shadow: inset 2px 0 0 var(--st);
  }

  .tab[data-side="right"] {
    right: 0;
    border-right: none;
    border-radius: 4px 0 0 4px;
    box-shadow: inset -2px 0 0 var(--st);
  }

  .tab[data-side="top"],
  .tab[data-side="bottom"] {
    left: var(--along);
    width: 46px;
    height: 18px;
    transform: translateX(-50%);
  }

  .tab[data-side="top"] {
    top: 0;
    border-top: none;
    border-radius: 0 0 4px 4px;
    box-shadow: inset 0 2px 0 var(--st);
  }

  .tab[data-side="bottom"] {
    bottom: 0;
    border-bottom: none;
    border-radius: 4px 4px 0 0;
    box-shadow: inset 0 -2px 0 var(--st);
  }

  @keyframes tabfade {
    0%,
    80% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }

  :global(html[data-motion="still"]) .tab {
    animation: none;
  }

  /* What did not fit. A count rather than a fourth box, because the cap is for
     the eye and a fourth box is what the cap is for. */
  .more {
    position: absolute;
    right: 0.6rem;
    bottom: 0.6rem;
    font-family: var(--util);
    font-size: 0.65rem;
    color: var(--paper-mute);
    padding: 0.15rem 0.4rem;
    border-radius: 10px;
    background: var(--surface);
    border: 1px solid var(--edge);
  }
</style>
