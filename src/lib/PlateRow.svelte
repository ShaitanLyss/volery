<script lang="ts">
  /* One plan, standing on the wall: a card's anatomy, a card's type.
   *
   * The stack used to draw every plan as a frise, and the condensed form it
   * became was the frise's head with control chrome bolted on — a dot pager, a
   * chevron, a progress bar along the foot. All three were vocabulary this wall
   * does not otherwise have, which is what Lyss meant by *jarring* (2026-11-09).
   * So a plan standing on the wall is drawn the way a card is (eyebrow, serif
   * title, one reading) and says everything else in words: the count is in the
   * eyebrow, turning is the wheel, the column folds on a word that appears under
   * the pointer, and how far along it has got is a ring — the shape every card
   * already wears for the same question.
   *
   * **It is not the default and it is not where a plan lives.** A card draws its
   * plan's current step on itself (`Card.svelte`); this plaque is for seeing a
   * plan *beside* the cards, which is a want and not a given (`Timelines.auto`,
   * default off). A plan dragged out of the stack onto the glass is still
   * `Frise.svelte` — the full line, by an explicit gesture.
   *
   * Hovering anywhere on it opens the current step's card (`StepCard.svelte`),
   * the same one the frise draws, so the sentence and the sub-steps are never
   * more than a pointer away. */

  import { current, fraction, projectOf, roman, type Timeline } from "./timeline";
  import { turnBy } from "./wheel";
  import StepCard from "./StepCard.svelte";
  import type { Tier } from "./classify";
  import type { Timelines } from "./timelines.svelte";

  let {
    t,
    tier = "rest",
    timelines,
    canJump = false,
    onjump,
    onpick,
    onhover,
    onreading,
  }: {
    t: Timeline;
    /** The owning card's status. The row keeps it for the state word only: the
     *  ring is progress, which is not a status, so nothing here is tinted. */
    tier?: Tier;
    timelines: Timelines;
    canJump?: boolean;
    onjump?: (rev: number) => void;
    /** Land on the card that drew it, as a double-click does on a plate. */
    onpick?: () => void;
    /** The pointer is over it — attention, for the clock that takes a finished
     *  plan to the archive by itself (`timelines.svelte.ts::sweep`). */
    onhover?: (on: boolean) => void;
    /** A step's card is open, so the box must ride over everything. */
    onreading?: (open: boolean) => void;
  } = $props();

  const at = $derived(current(t.plan));
  const n = $derived(t.plan.steps.length);
  const fill = $derived(Math.max(0, Math.min(1, fraction(t.plan))));

  /** What the work is on, or how it ended — the card's own words. */
  const now = $derived(
    t.state === "left"
      ? at === -1
        ? "left with every step done"
        : `left at ${roman(at + 1)}`
      : t.state === "complete"
        ? "complete"
        : at === -1
          ? "every step done"
          : t.plan.steps[at].title,
  );
  const which = $derived(at === -1 ? "" : `${roman(at + 1)} of ${roman(n)}`);

  const count = $derived(timelines.order.length);
  const index = $derived(timelines.order.indexOf(t.id));
  /** The wheel turns a page only while there is another to turn to. */
  const turns = $derived(count > 1 && !timelines.expanded);

  /* Travel, not events: a mouse reports a notch and a trackpad a stream of
     twos, so the travel is carried and spent one plan at a time
     (`wheel.ts::turnBy`). The accumulator is state because the row is drawn
     from it — the plan leans against the way you turned and lets go. */
  let acc = $state(0);
  const pull = $derived(Math.max(-10, Math.min(10, acc * 0.25)));
  let release: ReturnType<typeof setTimeout> | undefined;
  const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** The wheel, bound by hand and non-passive — `onwheel` as an attribute is
   *  attached passive, and this one has to be able to `preventDefault`, the
   *  same reason `Frise.svelte`'s strip binds its own. */
  function turning(el: HTMLElement) {
    const onturn = (e: WheelEvent) => {
      if (!turns) return;
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

  /* ── the step's card, on hover ────────────────────────────────────────── */

  let hovered = $state(false);
  let box: HTMLElement | null = $state(null);

  function enter() {
    hovered = true;
    onhover?.(true);
    onreading?.(true);
  }
  function leave(e: PointerEvent) {
    const to = e.relatedTarget as Node | null;
    if (to && box?.contains(to)) return;
    hovered = false;
    onhover?.(false);
    onreading?.(false);
  }
  function leaveBox(e: PointerEvent) {
    const to = e.relatedTarget as Node | null;
    if (to && box?.contains(to)) return;
    hovered = false;
    onreading?.(false);
  }

  const CIRC = 2 * Math.PI * 11;
</script>

<div
  class="row"
  data-st={tier}
  role="group"
  aria-label="plan: {t.title} — {now}{which ? `, ${which}` : ''}"
  style:--from="{timelines.lastStep * 16}px"
  onpointerenter={enter}
  onpointerleave={leave}
  ondblclick={(e) => {
    if (e.detail === 2) onpick?.();
  }}
  {@attach turning}
>
  <div class="slip" style:--pull="{pull}px">
    <svg class="ring" viewBox="0 0 26 26" aria-hidden="true">
      <circle class="track" cx="13" cy="13" r="11" />
      <circle
        class="fill"
        cx="13"
        cy="13"
        r="11"
        style:stroke-dasharray={CIRC}
        style:stroke-dashoffset={CIRC * (1 - fill)}
      />
    </svg>

    <span class="eb">{projectOf(t)}{#if count > 1}<i>·</i>{index + 1} of {count}{/if}</span>
    <span class="title">{t.title}</span>

    <span class="now">{now}{#if which}<i>·</i>{which}{/if}</span>

    {#if count > 1}
      <!-- A word, not a chevron: the plate's own verbs are quiet uppercase words
           that appear while it is being looked at, and this is one of those. -->
      <button
        class="fold"
        onclick={(e) => {
          e.stopPropagation();
          timelines.toggleStack();
        }}
        title={timelines.expanded
          ? "back to one plan at a time (space then l e)"
          : "every plan on the wall, one row each (space then l e)"}
        >{timelines.expanded ? "one" : "all"}</button
      >
    {/if}
  </div>

  {#if hovered && at >= 0}
    <div
      class="hcbox"
      data-grip
      bind:this={box}
      onpointerleave={leaveBox}
      role="presentation"
      style:top="{44}px"
    >
      <StepCard {t} index={at} {canJump} {onjump} />
    </div>
  {/if}
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

  /* A card's box at a card's type: the same padding, the same eyebrow, the same
     serif title. The one addition is the ring, which is the card's own. */
  .row {
    position: relative;
    height: 44px;
    overflow: hidden;
    color: var(--paper);
    cursor: inherit;
    animation: arrive 180ms cubic-bezier(0.2, 0.7, 0.3, 1) both;
  }
  .slip {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 100%;
    padding: 0 12px;
    transform: translateX(var(--pull, 0px));
    transition: transform 140ms ease-out;
  }
  @keyframes arrive {
    from {
      opacity: 0;
      transform: translateX(var(--from, 16px));
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

  /* Progress, achromatic: how far a plan has got is not a status, and the card's
     context ring — which does warm — is a different question. */
  .ring {
    flex: none;
    width: 26px;
    height: 26px;
    transform: rotate(-90deg);
  }
  .ring circle {
    fill: none;
    stroke-width: 2.5;
  }
  .ring .track {
    stroke: var(--edge);
  }
  .ring .fill {
    stroke: var(--paper-dim);
    stroke-linecap: round;
    transition: stroke-dashoffset 0.45s var(--ch-ease, ease);
  }

  .eb {
    flex: none;
    font-family: var(--util);
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--paper-faint);
    white-space: nowrap;
  }
  .eb i,
  .now i {
    font-style: normal;
    margin: 0 0.45em;
    color: var(--paper-faint);
  }
  .title {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--display);
    font-size: 0.95rem;
    line-height: 1.22;
    letter-spacing: -0.004em;
    color: var(--paper);
    white-space: nowrap;
  }
  .now {
    /* The reading keeps its room and the title gives its own up: which step a
       plan is on is the news, and a long plan name is a name — a card truncates
       its title for the same reason. */
    flex: 0 0 auto;
    max-width: 46%;
    margin-left: auto;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--util);
    font-size: 0.75rem;
    color: var(--paper-dim);
    white-space: nowrap;
  }

  .fold {
    flex: none;
    padding: 0;
    border: 0;
    background: none;
    font-family: var(--util);
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--paper-mute);
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s ease, color 0.15s ease;
  }
  .row:hover .fold,
  .fold:focus-visible {
    opacity: 1;
  }
  .fold:hover,
  .fold:focus-visible {
    color: var(--paper);
  }

  /* Where the step's card hangs, under the row. The box is `StepCard`'s. */
  .hcbox {
    position: absolute;
    z-index: 5;
    left: 12px;
    width: 272px;
  }
</style>
