<script lang="ts">
  /* One plan, as a single line: the stack's own reading of a timeline.
   *
   * The stack used to draw every plan as a plate as tall as its frise, one
   * under another — a form that arrived when a wall had one plan on it and that
   * covers a laptop by the fourth. So a plate standing *in the stack* draws this
   * instead (Lyss, 2026-11-09), and the frise is what a plate you kept is for:
   * dragged out onto the glass or the wall it is `Frise.svelte`, unchanged.
   *
   * It decides nothing about a plan — `timeline.ts` is the reading — and it
   * holds no state of its own but the wheel's travel. The carousel it belongs to
   * is `timelines.svelte.ts`: which plan is in front, whether the column is
   * folded open, and whether plans are on the wall at all. */

  import { current, fraction, projectOf, roman, type Timeline } from "./timeline";
  import type { Tier } from "./classify";
  import type { Timelines } from "./timelines.svelte";
  import { PAGER_DOTS } from "./plates";
  import { turnBy } from "./wheel";

  let {
    t,
    tier = "rest",
    timelines,
    onpick,
    onhover,
  }: {
    t: Timeline;
    /** The owning card's status, which is the one colour the row is allowed —
     *  on where the work is now, as on the frise. */
    tier?: Tier;
    timelines: Timelines;
    /** Land on the card that drew it, as a double-click does on a plate. */
    onpick?: () => void;
    /** The pointer is over it — attention, for the clock that takes a finished
     *  plan to the archive by itself (`timelines.svelte.ts::sweep`). */
    onhover?: (on: boolean) => void;
  } = $props();

  const at = $derived(current(t.plan));
  const n = $derived(t.plan.steps.length);
  const pct = $derived(Math.round(fraction(t.plan) * 100));

  /** The one thing the row says in words besides the plan's name: the step the
   *  work is on, or how it ended. */
  const now = $derived(
    t.state === "left"
      ? at === -1
        ? "left with every step done"
        : `left at step ${roman(at + 1)}`
      : t.state === "complete"
        ? "complete"
        : at === -1
          ? "every step done"
          : t.plan.steps[at].title,
  );

  /** How far along, and which step of how many — the frise's own numbering. */
  const where = $derived(at === -1 ? `${pct}%` : `${roman(at + 1)} of ${roman(n)} · ${pct}%`);

  const count = $derived(timelines.order.length);
  /** The wheel turns a page only while there is another to turn to: one plan,
   *  or the whole column open, and the wheel is the wall's again. */
  const turns = $derived(count > 1 && !timelines.expanded);
  const index = $derived(timelines.order.indexOf(t.id));

  /* Travel, not events: a mouse reports a wheel notch and a trackpad a stream
     of twos, and turning per event would fly through the stack under one and
     never move under the other (`wheel.ts::turnBy`).

     `acc` is state because the row is drawn from it: the travel you have spent
     so far drags the plan sideways under your hand, and it lets go a moment
     after you stop. That is the whole difference between a carousel and a
     slideshow — the thing under the wheel moves *now*, and the page turns when
     you have actually asked for it. */
  let acc = $state(0);
  /** How far the row is dragged, held well short of leaving its frame: the
   *  travel to a turn is `wheel.ts::TURN_PX`, and this is a fraction of it. */
  const pull = $derived(Math.max(-12, Math.min(12, acc * 0.3)));
  /** The nudge lets go if the wheel stops short of a page. */
  let release: ReturnType<typeof setTimeout> | undefined;
  /** Reduced motion only — an entrance and a nudge are not the endless kind
   *  `motion.md` spends its four readings on, and the same file's rule is that
   *  those answer to the system preference alone. */
  const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** The wheel, bound by hand and non-passive — `onwheel` as an attribute is
   *  attached passive, and this one has to be able to `preventDefault`, the
   *  same reason `Frise.svelte`'s strip binds its own (`svelte` marks wheel
   *  passive by default for scroll performance). */
  function turning(el: HTMLElement) {
    const onturn = (e: WheelEvent) => {
      if (!turns) return;
      /* The modifiers stay the wall's wherever the cursor is — ctrl zooms, shift
         pans — the rule the strip and every scroller here already keeps. */
      if (e.ctrlKey || e.metaKey || e.shiftKey || !e.deltaY) return;
      e.preventDefault();
      e.stopPropagation();
      const r = turnBy(acc, e.deltaY);
      if (r.step) {
        acc = 0;
        timelines.turn(r.step);
        return;
      }
      if (!calm()) {
        acc = r.acc;
        /* A wheel that stops short is a hand that changed its mind: let the
           nudge settle rather than leaving the plan leaning against its frame
           until the next gesture. */
        clearTimeout(release);
        release = setTimeout(() => (acc = 0), 160);
      }
    };
    el.addEventListener("wheel", onturn, { passive: false });
    return () => {
      el.removeEventListener("wheel", onturn);
      clearTimeout(release);
    };
  }
</script>

<div
  class="row"
  data-st={tier}
  role="group"
  aria-label="plan: {t.title} — {where}"
  style:--from="{timelines.lastStep * 18}px"
  onpointerenter={() => onhover?.(true)}
  onpointerleave={() => onhover?.(false)}
  ondblclick={(e) => {
    if (e.detail === 2) onpick?.();
  }}
  {@attach turning}
>
  <!-- Everything that is the plan, in one group: the wheel drags this sideways
       and the page that arrives slides in from the side you turned towards. -->
  <div class="slip" style:--pull="{pull}px">
  {#if count > 1}
    {#if timelines.expanded}
      <!-- folding, so nothing says which is which; the column is the list -->
    {:else if count <= PAGER_DOTS}
      <span class="pager" aria-hidden="true">
        {#each timelines.order as id (id)}<i class:on={id === t.id}></i>{/each}
      </span>
    {:else}
      <span class="tally" aria-hidden="true">{index + 1}/{count}</span>
    {/if}
  {/if}

  <span class="proj">{projectOf(t)}</span>
  <span class="title">{t.title}</span>
  <span class="now"><span class="dot">·</span>{now}</span>
  <span class="of">{where}</span>

  {#if count > 1}
    <button
      class="fold"
      onclick={(e) => {
        e.stopPropagation();
        timelines.toggleStack();
      }}
      title={timelines.expanded
        ? "back to one plan at a time (space then l e)"
        : "the whole column of plans (space then l e)"}
      aria-label={timelines.expanded ? "fold the plans back to one row" : "show every plan as a row"}
    >
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <path d={timelines.expanded ? "M2.5 7.5 6 4l3.5 3.5" : "M2.5 4.5 6 8l3.5-3.5"} />
      </svg>
    </button>
  {/if}

  <!-- The progress, along the foot of the row. It grows rather than jumps when
       a mark lands, and the colour at its head is where the work is now — the
       same reading the frise's live marker gives, in the only place this line
       has for it. -->
  <span class="fill" style:width="{pct}%"></span>
  </div>
</div>

<style>
  [data-st="work"] {
    --st: var(--st-work);
  }
  [data-st="ask"] {
    --st: var(--st-ask);
  }
  [data-st="soft"] {
    --st: var(--st-soft);
  }
  [data-st="fail"] {
    --st: var(--st-fail);
  }
  [data-st="rest"] {
    --st: var(--st-rest);
  }

  .row {
    position: relative;
    height: 36px;
    overflow: hidden;
    color: var(--paper);
    cursor: inherit;
    /* The plan that arrives comes in from the side it was turned towards: the
       row is a different plate's, freshly drawn, so a mount *is* the turn
       (`Timelines.lastStep`). */
    animation: arrive 180ms cubic-bezier(0.2, 0.7, 0.3, 1) both;
  }
  .slip {
    position: relative;
    display: flex;
    align-items: center;
    gap: 9px;
    height: 100%;
    padding: 0 12px;
    /* The wheel's travel so far, under your hand — a transform, so the frame
       stays put and only what is inside it moves. It also makes this the
       containing block for the progress hairline, which belongs to the plan
       and travels with it. */
    transform: translateX(var(--pull, 0px));
    transition: transform 140ms ease-out;
  }
  @keyframes arrive {
    from {
      opacity: 0;
      transform: translateX(var(--from, 18px));
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .row {
      animation: none;
    }
    .slip {
      transform: none;
      transition: none;
    }
  }

  .pager {
    display: flex;
    gap: 4px;
    flex: none;
  }
  .pager i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--edge);
    transition: background 0.2s ease;
  }
  .pager i.on {
    background: var(--paper-dim);
  }
  .tally {
    flex: none;
    font-family: var(--mono);
    font-size: 0.6rem;
    color: var(--paper-mute);
  }

  .proj {
    flex: none;
    max-width: 34%;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--util);
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--paper-faint);
    white-space: nowrap;
  }
  .title {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--display);
    font-size: 0.8rem;
    color: var(--paper);
    white-space: nowrap;
  }
  .now {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--util);
    font-size: 0.68rem;
    color: var(--paper-dim);
    white-space: nowrap;
  }
  .dot {
    margin: 0 0.4em;
    color: var(--paper-faint);
  }
  .of {
    flex: none;
    margin-left: auto;
    font-family: var(--mono);
    font-size: 0.6rem;
    font-variant-numeric: tabular-nums;
    color: var(--paper-mute);
    white-space: nowrap;
  }

  /* The fold: a chevron, quiet until the plate is looked at — the plate's own
     verbs are words that stand on a finished plate and appear on a live one
     under the pointer (`Frise.svelte`'s `.act`). */
  .fold {
    flex: none;
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 0;
    border-radius: 3px;
    background: none;
    color: var(--paper-faint);
    cursor: pointer;
    /* Faint rather than invisible: it is the affordance that folds the column
       open, and one that only exists under the pointer is one you find by
       accident. The plate's own verbs hide until hovered because they act on
       the plan; this only says how much of the stack is showing. */
    opacity: 0.4;
    transition: opacity 0.15s ease, color 0.15s ease;
  }
  .row:hover .fold,
  .fold:focus-visible {
    opacity: 1;
  }
  .fold:focus-visible {
    outline: 1px solid var(--rule);
  }
  .fold:hover {
    color: var(--paper);
  }
  .fold svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* No transition under reduced motion — the fill simply arrives where it now
     is. It is the same 450ms the frise's own fill takes, and the frise states
     no `still` arm for its reason: this answers to the motion preference, not
     to how much the wall may animate while nobody is asking it anything. */
  .fill {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 2px;
    background: var(--paper-dim);
    transition: width 0.45s var(--ch-ease, ease);
  }
  .fill::after {
    content: "";
    position: absolute;
    right: -2px;
    top: -1.5px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--st);
  }
  @media (prefers-reduced-motion: reduce) {
    .fill {
      transition: none;
    }
  }
</style>
