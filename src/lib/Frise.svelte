<script lang="ts">
  /* One timeline, drawn as a frise. The same plate on the glass and in the
   * archive — `archive` only changes which controls it offers, so the two can
   * never disagree about how a plan looks.
   *
   * Everything about where a mark goes is `timeline.ts::frise`, which is pure
   * and tested; this file is the drawing and the three gestures: a step or a
   * sub-step clicked carries you to the call that wrote it, the plate's own
   * archive button, and (in the archive) picking a left one back up. Pressing
   * anywhere else on the plate is the parent's — it drags, and a press that
   * does not travel selects the card that drew it. */

  import type { Tier } from "./classify";
  import {
    effective,
    frise,
    projectOf,
    railWidth,
    roman,
    stepRev,
    subRev,
    subsOf,
    whereabouts,
    type Step,
    type Timeline,
  } from "./timeline";

  let {
    t,
    tier = "rest",
    handle,
    archive = false,
    width,
    canJump = false,
    onjump,
    onarchive,
    onresume,
  }: {
    t: Timeline;
    /** The owning card's status — the one colour the plate is allowed, and
     *  only on its live markers. `rest` for a card that is not on the wall. */
    tier?: Tier;
    handle: string;
    archive?: boolean;
    /** The line's width, when the plate is set into something with a width of
     *  its own — the archive's column. Otherwise it is sized off the plan. */
    width?: number;
    /** Whether the owner is on the wall, so a step can be found in its
     *  transcript. An archived timeline whose card was closed cannot. */
    canJump?: boolean;
    onjump?: (rev: number) => void;
    onarchive?: () => void;
    onresume?: () => void;
  } = $props();

  const rail = $derived(width ?? railWidth(t.plan.steps.length));
  const fr = $derived(frise(t.plan, rail));
  const words = $derived(whereabouts(t));
  /** Labels sit under the line; the hover card under the labels. */
  const labelTop = $derived(fr.height + 4);
  const railH = $derived(fr.height + 22);

  let hovered = $state<number | null>(null);

  const HC_W = 272;
  /** The card's left edge relative to its span, kept inside the plate. */
  function cardLeft(x0: number): number {
    const want = Math.min(Math.max(x0 - 14, -18), rail - HC_W + 18);
    return want - x0;
  }

  function counts(step: Step): string {
    const subs = subsOf(step);
    if (!subs.length) return effective(step) === "done" ? "done" : effective(step);
    const done = subs.filter((s) => s.state === "done").length;
    return `${done} of ${subs.length} done`;
  }

  function jump(rev: number | null, e: MouseEvent) {
    e.stopPropagation();
    /* The first click of a double-click only, so the gesture that puts a moved
       plate back does not also carry the transcript somewhere twice. */
    if (e.detail > 1) return;
    if (rev !== null && canJump) onjump?.(rev);
  }
</script>

<div
  class="plate"
  class:archive
  class:complete={t.state === "complete"}
  data-timeline={t.id}
  data-st={tier}
  style:width="{archive ? rail : rail + 60}px"
  role="group"
  aria-label="timeline: {t.title}"
>
  <div class="head">
    <div class="who">
      <div class="eyebrow">{projectOf(t)}<span class="dot">·</span>{handle}</div>
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
          onpointerdown={(e) => e.stopPropagation()}
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
    </div>
  </div>

  <div class="rail" style:height="{railH}px">
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
    </svg>

    {#each fr.spans as s (s.index)}
      {@const step = t.plan.steps[s.index]}
      <div
        class="span"
        style:left="{s.x0}px"
        style:width="{s.x1 - s.x0}px"
        onpointerenter={() => (hovered = s.index)}
        onpointerleave={() => (hovered = hovered === s.index ? null : hovered)}
        role="presentation"
      >
        <button
          class="lab {s.state}"
          class:jumps={canJump}
          style:top="{labelTop}px"
          style:max-width="{Math.max(24, s.x1 - s.x0 - 10)}px"
          onclick={(e) => jump(stepRev(step), e)}
          onpointerdown={(e) => canJump && e.stopPropagation()}
          ondblclick={(e) => canJump && e.stopPropagation()}
        >{s.title}</button>

        {#if hovered === s.index}
          <!-- Its presses are its own: reading the card is not a press on the
               plate, so it neither lands on the card nor starts a drag. -->
          <div
            class="hc"
            onpointerdown={(e) => e.stopPropagation()}
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
                    <button
                      class:jumps={canJump}
                      onclick={(e) => jump(subRev(sub), e)}
                    >{sub.title}</button>
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
      </div>
    {/each}
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

  .plate {
    position: relative;
    padding: 14px 30px 10px;
    /* Opaque, as everything standing on the wall must be — the backdrop draws
       behind all of it. */
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: var(--ch-radius, 4px);
    /* Static, rastered once — not the animated `box-shadow` motion.md priced. */
    box-shadow: 0 18px 34px -16px rgba(0, 0, 0, 0.85);
    color: var(--paper);
    user-select: none;
  }
  /* A plate being read rides over the one below it, so its hover card is not
     drawn underneath the next timeline in the stack. */
  .plate:hover {
    z-index: 2;
  }
  .plate.archive {
    box-shadow: none;
    border: 0;
    border-radius: 0;
    padding: 18px 0 8px;
    background: transparent;
  }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 1rem;
    margin-bottom: 12px;
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
  .plate:hover .act,
  .act.standing,
  .act:focus-visible {
    opacity: 1;
  }
  .act:hover {
    color: var(--paper);
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

  /* A step's whole span is its hover target, so the card opens wherever along
     the step the pointer is — and stays open while the pointer travels down
     into it, since the card is inside the span. */
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
    box-shadow: 0 18px 34px -12px rgba(0, 0, 0, 0.9);
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
