<script lang="ts">
  /* One timeline, drawn as a frise. The same plate on the wall, on the glass
   * and in the archive — `archive` only changes which controls it offers and
   * `compact` only how much of the line is in view, so none of them can
   * disagree about how a plan looks.
   *
   * Everything about where a mark goes is `timeline.ts::frise`, which is pure
   * and tested; this file is the drawing and the plate's own gestures: a step
   * or a sub-step clicked carries you to the call that wrote it, the card's
   * handle (or a double-click anywhere) lands on the card that drew it, the
   * plate's archive button, and in the archive picking a left one back up or
   * hanging a finished one back up. Pressing anywhere else is the wall's — the
   * plate is a widget (`plates.ts`), so a press selects it and a drag carries
   * it, with everything else standing on the wall.
   *
   * **The frame is not here.** The fill, the edge and the shadow a plate has
   * always worn are painted by `WidgetNode`, which is the only thing on the wall
   * that fills a widget — so the frame knob reaches a plate the way it reaches
   * a clock. The archive's plates wear none, as before.
   *
   * **Compact is a window of the line.** The same frise at the same pitch,
   * inside a strip you scroll along, kept on wherever the work is
   * (`follow.ts::stickToMark`) until a hand moves it. The hover card cannot be
   * inside that strip — a box that scrolls sideways clips downwards too — so it
   * is drawn beside it, under the step it is about. */

  import { untrack } from "svelte";
  import type { Tier } from "./classify";
  import { stickToMark } from "./follow";
  import { stride } from "./wheel";
  import {
    compactRail,
    effective,
    frise,
    projectOf,
    railWidth,
    roman,
    stepRev,
    subRev,
    subsOf,
    whereabouts,
    windowAt,
    workAt,
    type Mark,
    type Step,
    type Timeline,
  } from "./timeline";

  let {
    t,
    tier = "rest",
    handle,
    archive = false,
    compact = false,
    width,
    canJump = false,
    onjump,
    onarchive,
    onresume,
    onrestore,
    onpick,
    onreading,
    onhover,
  }: {
    t: Timeline;
    /** The owning card's status — the one colour the plate is allowed, and
     *  only on its live markers. `rest` for a card that is not on the wall. */
    tier?: Tier;
    handle: string;
    archive?: boolean;
    /** A window of the line rather than the whole of it — the plate's default
     *  variant. The window is as wide as whatever the plate is set into. */
    compact?: boolean;
    /** The line's width, when the plate is set into something with a width of
     *  its own — the archive's column. Otherwise it is sized off the plan. */
    width?: number;
    /** Whether the owner is on the wall, so a step can be found in its
     *  transcript. An archived timeline whose card was closed cannot. */
    canJump?: boolean;
    onjump?: (rev: number) => void;
    onarchive?: () => void;
    onresume?: () => void;
    /** Hang a finished one back up out of the archive. */
    onrestore?: () => void;
    /** Land on the card that drew it. */
    onpick?: () => void;
    /** Whether a hover card is open, for whoever holds the box this plate is
     *  drawn in. A card being read has to ride over everything standing on the
     *  wall, and only the box that stacks can lift it — `.hc`'s own z-index
     *  orders it among its siblings and nowhere else. */
    onreading?: (open: boolean) => void;
    /** Whether the pointer is over the plate — attention, for the clock that
     *  takes a finished one to the archive by itself. */
    onhover?: (on: boolean) => void;
  } = $props();

  /** The strip's own inset, so a milestone or a halo at either end of the line
   *  is not cut in half by the edge of the window. The plate's side padding is
   *  less by the same amount, so the line starts where the wide plate's does. */
  const INSET = 12;

  /** The window's width, measured — compact only. */
  let viewW = $state(0);
  const rail = $derived(
    compact
      ? compactRail(t.plan.steps.length, Math.max(0, viewW - INSET * 2))
      : (width ?? railWidth(t.plan.steps.length)),
  );
  const fr = $derived(frise(t.plan, rail));
  const words = $derived(whereabouts(t));
  /** Labels sit under the line; the hover card under the labels. */
  const labelTop = $derived(fr.height + 4);
  const railH = $derived(fr.height + 22);

  /* ── following the work, compact only ─────────────────────────────────── */

  /** Where the window should be for the work to be in it. */
  const aim = $derived(compact ? windowAt(workAt(t.plan, fr), viewW, rail, INSET) : 0);
  /** Where the window is, for the hover card drawn beside it. */
  let scroll = $state(0);
  let follower: { reaim: () => void; stop: () => void } | null = null;

  /** The strip's attachment: kept on the work, and a bare wheel carries it
   *  sideways (`wheel.ts::stride`). Untracked, or the attachment would be torn
   *  down and rebuilt every time the work moved — and with it whether you had
   *  scrolled away, which is the one thing it must remember. */
  function strip(el: HTMLDivElement) {
    const f = untrack(() => stickToMark(el, () => aim));
    follower = f;
    const onWheel = (e: WheelEvent) => {
      const d = stride(e, {
        x: { container: true, beyond: el.scrollWidth - el.clientWidth },
        y: { container: false, beyond: 0 },
      });
      if (d === null) return;
      /* The wall's wheel listener is an ancestor's, on the bubble phase: this
         turn is the strip's, and the zoom must not also hear it. */
      e.preventDefault();
      e.stopPropagation();
      el.scrollLeft += d;
    };
    const onScroll = () => (scroll = el.scrollLeft);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      f.stop();
      follower = null;
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", onScroll);
    };
  }
  /* The work moved, or the window was resized into a different line: aim the
     follow again. Whether it moves is still the follow's to decide. */
  $effect(() => {
    void aim;
    untrack(() => follower?.reaim());
  });
  /** Which ends of the strip have more beyond them, for the fade that says so. */
  const more = $derived({
    left: compact && scroll > 1,
    right: compact && scroll + viewW < rail + INSET * 2 - 1,
  });

  /* ── the hover card ───────────────────────────────────────────────────── */

  let hovered = $state<number | null>(null);
  let hcEl = $state<HTMLDivElement | null>(null);
  let plateEl = $state<HTMLDivElement | null>(null);
  $effect(() => {
    const open = hovered !== null;
    onreading?.(open);
    /* Unmounting while hovered would otherwise leave the box lifted with
       nothing in it to read. */
    return () => open && onreading?.(false);
  });

  const HC_W = 272;
  /** The card's left edge in the track's own units: under the step, kept
   *  inside the plate. The wide plate's arithmetic exactly, with the window's
   *  offset taken off for a compact one. */
  function cardLeft(x0: number): number {
    const lead = compact ? INSET - scroll : 0;
    const across = compact ? viewW : rail;
    return Math.min(Math.max(x0 + lead - 14, -18), across - HC_W + 18);
  }

  /** Leaving a step for its own card, or the card for its own step, is not
   *  leaving — the card is drawn beside the step rather than inside it now. */
  function leaveSpan(i: number, e: PointerEvent) {
    const to = e.relatedTarget as Node | null;
    if (to && hcEl?.contains(to)) return;
    if (hovered === i) hovered = null;
  }
  function leaveCard(e: PointerEvent) {
    const to = e.relatedTarget as HTMLElement | null;
    const span = to?.closest?.("[data-span]") as HTMLElement | null;
    /* This plate's own step only. A card hangs over the plate below it in the
       stack, and that plate has a step of the same number right there — leaving
       onto it is leaving (found in review). */
    if (span && plateEl?.contains(span) && Number(span.dataset.span) === hovered) return;
    hovered = null;
  }

  function counts(step: Step): string {
    const subs = subsOf(step);
    if (!subs.length) return effective(step) === "done" ? "done" : effective(step);
    const done = subs.filter((s) => s.state === "done").length;
    return `${done} of ${subs.length} done`;
  }

  function jump(rev: number | null, e: MouseEvent) {
    e.stopPropagation();
    /* The first click of a double-click only, so the gesture that lands on
       the card does not also carry the transcript somewhere twice. */
    if (e.detail > 1) return;
    if (rev !== null && canJump) onjump?.(rev);
  }

  /* ── the completion flourish ──────────────────────────────────────────── *
   *
   * The colour leaving, and nothing arriving. Colour on this plate is status,
   * on the live markers only, so finishing already means the colour goes; this
   * animates that going, once: a pulse in the owner's own colour travels the
   * line a step at a time — through every strand of a fork together — the end
   * of the line takes it and lets it go, and the last live markers drain to
   * nothing. No new hue (there is no success-green on this wall), no confetti,
   * and it ends: `motion.md` priced the glow that never stopped at eight per
   * cent of the GPU per card. Played only on a plan finishing while it is drawn
   * — a plate that comes up already finished, at launch or out of the archive,
   * is simply finished. */

  const SWEEP_MS = 650;
  const FLOURISH_MS = 1000;
  let flourish = $state<{ lives: Mark[] } | null>(null);
  /** The live markers as they last stood, so there is something to drain. */
  let lastLives: Mark[] = [];
  let was: Timeline["state"] | null = null;
  let done: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const s = t.state;
    const lives = fr.lives;
    untrack(() => {
      if (was === "live" && s === "complete") {
        flourish = {
          lives: lastLives.filter((m) => !lives.some((l) => l.x === m.x && l.y === m.y)),
        };
        clearTimeout(done);
        done = setTimeout(() => (flourish = null), FLOURISH_MS);
      }
      was = s;
      if (lives.length) lastLives = lives;
    });
  });
  $effect(() => () => clearTimeout(done));
  const pace = $derived(SWEEP_MS / Math.max(1, t.plan.steps.length));
  const end = $derived(fr.ticks[fr.ticks.length - 1]);
</script>

{#snippet line()}
  <div class="rail" style:width={compact ? `${rail}px` : undefined} style:height="{railH}px">
    <svg width={rail} height={fr.height} viewBox="0 0 {rail} {fr.height}" aria-hidden="true">
      {#each fr.track as d}
        <path {d} class="track" />
      {/each}
      {#each fr.fill as d}
        <path {d} class="fill" />
      {/each}
      {#each fr.ticks as k}
        <line x1={k.x} y1={k.y1} x2={k.x} y2={k.y2} class="tick" class:done={k.done} />
      {/each}
      {#each fr.nodes as n}
        <circle cx={n.x} cy={n.y} r="5.5" class="node {n.state}" />
      {/each}
      {#each fr.lives as m}
        <circle cx={m.x} cy={m.y} r="8" class="halo" />
        <circle cx={m.x} cy={m.y} r="3.6" class="live" />
      {/each}
      {#if flourish}
        <g class="flourish">
          {#each fr.track as d, i}
            <path
              {d}
              class="pulse"
              pathLength="1"
              style:animation-delay="{(fr.trackStep[i] ?? 0) * pace}ms"
              style:animation-duration="{pace}ms"
            />
          {/each}
          {#if end}
            <line
              x1={end.x}
              y1={end.y1}
              x2={end.x}
              y2={end.y2}
              class="settle"
              style:animation-duration="{FLOURISH_MS}ms"
            />
          {/if}
          {#each flourish.lives as m}
            <circle cx={m.x} cy={m.y} r="8" class="drain halo" />
            <circle cx={m.x} cy={m.y} r="3.6" class="drain live" />
          {/each}
        </g>
      {/if}
    </svg>

    {#each fr.spans as s (s.index)}
      {@const step = t.plan.steps[s.index]}
      <div
        class="span"
        data-span={s.index}
        style:left="{s.x0}px"
        style:width="{s.x1 - s.x0}px"
        onpointerenter={() => (hovered = s.index)}
        onpointerleave={(e) => leaveSpan(s.index, e)}
        role="presentation"
      >
        <button
          class="lab {s.state}"
          class:jumps={canJump}
          style:top="{labelTop}px"
          style:max-width="{Math.max(24, s.x1 - s.x0 - 10)}px"
          onclick={(e) => jump(stepRev(step), e)}
          ondblclick={(e) => canJump && e.stopPropagation()}
        >{s.title}</button>
      </div>
    {/each}
  </div>
{/snippet}

<div
  class="plate"
  bind:this={plateEl}
  class:archive
  class:compact
  class:complete={t.state === "complete"}
  data-timeline={t.id}
  data-st={tier}
  style:width={compact ? undefined : `${archive ? rail : rail + 60}px`}
  role="group"
  aria-label="timeline: {t.title}"
  onpointerenter={() => onhover?.(true)}
  onpointerleave={() => onhover?.(false)}
  ondblclick={(e) => {
    if (e.detail === 2) onpick?.();
  }}
>
  <div class="head">
    <div class="who">
      <div class="eyebrow">
        {projectOf(t)}<span class="dot">·</span>{#if onpick}<button
            class="handle"
            title="go to the card that drew it (or double-click the plate)"
            onclick={(e) => {
              e.stopPropagation();
              onpick?.();
            }}>{handle}</button
          >{:else}{handle}{/if}
      </div>
      <div class="title">{t.title}</div>
    </div>
    <div class="where">
      {#each words as w, i}
        {#if i}<span class="sep">·</span>{/if}<span class:now={i === 0}>{w}</span>
      {/each}
      {#if !archive && onarchive}
        <button
          class="act"
          class:standing={t.state === "complete"}
          onclick={(e) => {
            e.stopPropagation();
            onarchive?.();
          }}
          title={t.state === "complete" ? "move it to the archive" : "archive it unfinished"}
        >archive</button>
      {/if}
      {#if archive && t.state === "left" && onresume}
        <button
          class="act"
          onclick={(e) => {
            e.stopPropagation();
            onresume?.();
          }}
          title="adopt the session that drew it, and carry on from where it stopped"
        >pick it back up</button>
      {/if}
      {#if archive && t.state === "complete" && onrestore}
        <button
          class="act"
          onclick={(e) => {
            e.stopPropagation();
            onrestore?.();
          }}
          title="put it back on the glass, in the stack"
        >hang it back up</button>
      {/if}
    </div>
  </div>

  <div class="hang">
    {#if compact}
      <!-- `data-scroll`: the wall's wheel asks what is under it before it
           zooms (`layout.md`), and this is a strip the wheel can move. -->
      <div
        class="view strip"
        class:more-left={more.left}
        class:more-right={more.right}
        data-scroll
        bind:clientWidth={viewW}
        {@attach strip}
      >
        {@render line()}
      </div>
    {:else}
      <div class="view">{@render line()}</div>
    {/if}

    {#if hovered !== null}
      {@const s = fr.spans[hovered]}
      {@const step = t.plan.steps[hovered]}
      {#if s && step}
        <!-- Drawn beside the strip rather than inside the step, because a box
             that scrolls sideways clips downwards too. Its presses are its own
             (`data-grip`): reading the card is not a press on the plate, so it
             neither starts a drag nor lands on the card. -->
        <div
          class="hc"
          data-grip
          bind:this={hcEl}
          onpointerleave={leaveCard}
          onclick={(e) => e.stopPropagation()}
          ondblclick={(e) => e.stopPropagation()}
          role="presentation"
          style:top="{railH - 2}px"
          style:left="{cardLeft(s.x0)}px"
          style:width="{HC_W}px"
        >
          <div class="hx">step {roman(s.index + 1)} · {counts(step)}</div>
          <div class="hn">{step.title}</div>
          {#if step.about}<p>{step.about}</p>{/if}
          {#each step.strands as k, ki (ki)}
            {#if k.name}
              <div class="lane">{k.name}{k.background ? " · background" : ""}</div>
            {/if}
            <ul>
              {#each k.subs as sub, si (si)}
                <li class={sub.state}>
                  <button class:jumps={canJump} onclick={(e) => jump(subRev(sub), e)}
                    >{sub.title}</button
                  >
                </li>
              {/each}
            </ul>
          {/each}
          {#if canJump}
            <div class="foot">
              click to find where it was {effective(step) === "done" ? "finished" : "added"}
            </div>
          {/if}
        </div>
      {/if}
    {/if}
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

  /* No fill, edge or shadow of its own: the widget it is set into paints those
     (`WidgetNode`), so the frame knob reaches it, and the archive wants none. */
  .plate {
    position: relative;
    padding: 14px 30px 10px;
    color: var(--paper);
    user-select: none;
  }
  .plate.compact {
    width: 100%;
    padding: 14px 18px 10px;
  }
  .plate.archive {
    padding: 18px 0 8px;
  }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 1rem;
    margin-bottom: 12px;
  }
  /* A narrow plate cannot set where it is beside what it is, so the reading
     goes under the title — the same words, one line lower. */
  .compact .head {
    flex-direction: column;
    align-items: stretch;
    gap: 3px;
    padding: 0 12px;
  }
  .who {
    min-width: 0;
  }
  .eyebrow {
    font-family: var(--util);
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--paper-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dot {
    margin: 0 0.45em;
  }
  /* The card's handle, which is the way to it — set as the words it always
     was, and only the pointer says it can be pressed. */
  .handle {
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    color: inherit;
    cursor: pointer;
  }
  .handle:hover,
  .handle:focus-visible {
    color: var(--paper);
  }
  .title {
    margin-top: 2px;
    font-family: var(--display);
    font-size: 1rem;
    line-height: 1.22;
    color: var(--paper);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .archive .title {
    color: var(--paper-dim);
  }
  .where {
    flex: none;
    display: flex;
    align-items: baseline;
    font-family: var(--mono);
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
    color: var(--paper-mute);
    white-space: nowrap;
  }
  .compact .where {
    min-width: 0;
    overflow: hidden;
  }
  .compact .where > span.now {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .now {
    color: var(--paper);
  }
  .sep {
    margin: 0 7px;
    color: var(--paper-faint);
  }

  /* The plate's own verbs, set like its eyebrow: quiet words, never a button
     shape. On a live plate it only shows while the plate is being looked at;
     on a finished one it stands, because archiving is what it is waiting for. */
  .act {
    margin-left: 14px;
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
  .compact .act {
    margin-left: auto;
    padding-left: 14px;
  }
  .plate:hover .act,
  .act.standing,
  .act:focus-visible {
    opacity: 1;
  }
  .act:hover {
    color: var(--paper);
  }

  /* Where the hover card hangs from — outside the strip, so nothing clips it. */
  .hang {
    position: relative;
  }
  /* The compact window: scrolls sideways, kept on the work, and says which
     ends have more beyond them with a fade rather than a scrollbar — a bar
     would be a second thing a press on the plate could mean. */
  .strip {
    overflow-x: auto;
    overflow-y: hidden;
    padding: 0 12px;
    scrollbar-width: none;
  }
  .strip::-webkit-scrollbar {
    display: none;
  }
  .strip.more-left {
    mask-image: linear-gradient(to right, transparent 0, #000 28px);
  }
  .strip.more-right {
    mask-image: linear-gradient(to left, transparent 0, #000 28px);
  }
  .strip.more-left.more-right {
    mask-image: linear-gradient(
      to right,
      transparent 0,
      #000 28px,
      #000 calc(100% - 28px),
      transparent 100%
    );
  }

  .rail {
    position: relative;
  }
  svg {
    display: block;
    overflow: visible;
  }
  .track {
    fill: none;
    stroke: var(--rule);
    stroke-width: 1;
  }
  .fill {
    fill: none;
    stroke: var(--paper-dim);
    stroke-width: 1;
    transition: d 0.45s var(--ch-ease, ease);
  }
  .tick {
    stroke: var(--rule);
    stroke-width: 1;
  }
  .tick.done {
    stroke: var(--paper-mute);
  }
  .node {
    stroke-width: 1;
  }
  .node.done {
    fill: var(--paper-dim);
    stroke: var(--paper-dim);
  }
  .node.active {
    fill: var(--surface);
    stroke: var(--paper);
    stroke-width: 1.5;
  }
  .node.todo {
    fill: var(--surface);
    stroke: var(--paper-faint);
  }
  .live {
    fill: var(--st);
    transition:
      cx 0.45s var(--ch-ease, ease),
      cy 0.45s var(--ch-ease, ease);
  }
  .halo {
    fill: var(--st);
    opacity: 0.16;
    transition:
      cx 0.45s var(--ch-ease, ease),
      cy 0.45s var(--ch-ease, ease);
  }
  :global(html[data-motion="still"]) .fill,
  :global(html[data-motion="still"]) .live,
  :global(html[data-motion="still"]) .halo {
    transition: none;
  }

  /* The flourish: once, then gone from the document. */
  .pulse {
    fill: none;
    stroke: var(--st);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-dasharray: 0.16 2;
    stroke-dashoffset: 0.16;
    animation-name: travel;
    animation-timing-function: linear;
    animation-fill-mode: both;
  }
  @keyframes travel {
    from {
      stroke-dashoffset: 0.16;
    }
    to {
      stroke-dashoffset: -1;
    }
  }
  .settle {
    stroke-width: 1;
    stroke: var(--paper-mute);
    animation-name: settle;
    animation-timing-function: ease-out;
    animation-fill-mode: both;
  }
  @keyframes settle {
    0%,
    55% {
      stroke: var(--paper-mute);
      stroke-width: 1;
    }
    68% {
      stroke: var(--st);
      stroke-width: 2;
    }
    100% {
      stroke: var(--paper-mute);
      stroke-width: 1;
    }
  }
  .drain {
    animation: drain 0.9s ease-in both;
  }
  .drain.halo {
    animation-name: drain-halo;
  }
  @keyframes drain {
    from {
      opacity: 1;
    }
    to {
      opacity: 0;
    }
  }
  @keyframes drain-halo {
    from {
      opacity: 0.16;
    }
    to {
      opacity: 0;
    }
  }
  /* Reduced motion keeps the part that carries meaning — the colour going —
     and drops the travel. Still keeps neither: nothing on the wall moves. */
  @media (prefers-reduced-motion: reduce) {
    .pulse,
    .settle {
      display: none;
    }
  }
  :global(html[data-motion="still"]) .flourish {
    display: none;
  }

  /* A step's whole span is its hover target, so the card opens wherever along
     the step the pointer is. */
  .span {
    position: absolute;
    top: 0;
    bottom: 0;
  }
  .lab {
    position: absolute;
    left: -6px;
    padding: 0;
    border: 0;
    background: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--util);
    font-size: 0.72rem;
    letter-spacing: 0.04em;
    color: var(--paper-faint);
    cursor: inherit;
  }
  .lab.done {
    color: var(--paper-mute);
  }
  .lab.active {
    color: var(--paper);
  }
  .lab.jumps {
    cursor: pointer;
  }
  .lab.jumps:hover {
    color: var(--paper);
  }

  .hc {
    position: absolute;
    z-index: 5;
    padding: 11px 14px 10px;
    background: var(--raised);
    border: 1px solid var(--rule);
    border-radius: var(--ch-radius, 4px);
    box-shadow: 0 18px 34px -12px color-mix(in srgb, var(--shade) 90%, transparent);
    cursor: default;
    animation: open 0.14s ease-out both;
  }
  @keyframes open {
    from {
      opacity: 0;
      transform: translateY(-3px);
    }
  }
  :global(html[data-motion="still"]) .hc {
    animation: none;
  }
  .hx,
  .lane {
    font-family: var(--util);
    font-size: 0.58rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  .lane {
    margin-top: 2px;
    padding-top: 8px;
    border-top: 1px solid var(--edge);
  }
  .hn {
    margin-top: 3px;
    font-family: var(--display);
    font-size: 0.98rem;
    color: var(--paper);
  }
  .hc p {
    margin: 5px 0 8px;
    font-size: 0.8rem;
    line-height: 1.5;
    color: var(--paper-dim);
  }
  .hc ul {
    list-style: none;
    margin: 0;
    padding: 4px 0 6px;
  }
  .hc li {
    position: relative;
    padding: 2px 0 2px 16px;
  }
  .hc li::before {
    content: "";
    position: absolute;
    left: 2px;
    top: 50%;
    width: 6px;
    height: 6px;
    margin-top: -3px;
    border-radius: 50%;
    border: 1px solid var(--paper-faint);
  }
  .hc li.done::before {
    background: var(--paper-dim);
    border-color: var(--paper-dim);
  }
  .hc li.active::before {
    background: var(--st);
    border-color: var(--st);
  }
  .hc li button {
    padding: 0;
    border: 0;
    background: none;
    text-align: left;
    font-family: var(--util);
    font-size: 0.74rem;
    color: var(--paper-faint);
    cursor: inherit;
  }
  .hc li.done button {
    color: var(--paper-mute);
  }
  .hc li.active button {
    color: var(--paper);
  }
  .hc li button.jumps {
    cursor: pointer;
  }
  .hc li button.jumps:hover {
    color: var(--paper);
  }
  .foot {
    padding-top: 6px;
    border-top: 1px solid var(--edge);
    font-family: var(--util);
    font-size: 0.66rem;
    color: var(--paper-note, var(--paper-faint));
  }
</style>
