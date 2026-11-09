<script lang="ts">
  /* One step of a plan, as a card: its number and how far it has got, its
   * sentence, its sub-steps and strands, and the way to the write that put it
   * there. This is the frise's hover card, lifted out of `Frise.svelte` on
   * 2026-11-09 so the two surfaces that now draw a plan's step — the frise and
   *  the line a plan rides on its card (`Card.svelte`) — are one drawing
   *  rather than two that will drift.
   *
   * It holds no position. The caller places it (a box that scrolls sideways
   * clips downwards, which is why it hangs beside the frise's strip rather than
   * inside a step), and gives it `onjump` only where the owning card's
   * transcript is one this wall holds. */

  import { effective, roman, subsOf, subRev, type Step, type Timeline } from "./timeline";

  let {
    t,
    index,
    canJump = false,
    onjump,
  }: {
    t: Timeline;
    /** Which step, 0-based. */
    index: number;
    canJump?: boolean;
    onjump?: (rev: number) => void;
  } = $props();

  const step = $derived<Step | null>(t.plan.steps[index] ?? null);

  function counts(s: Step): string {
    const subs = subsOf(s);
    if (!subs.length) return effective(s) === "done" ? "done" : effective(s);
    const done = subs.filter((x) => x.state === "done").length;
    return `${done} of ${subs.length} done`;
  }

  function jump(rev: number | null, e: MouseEvent) {
    e.stopPropagation();
    /* The first click of a double-click only, so a press that lands on the
       card behind does not also carry the transcript somewhere twice. */
    if (e.detail > 1) return;
    if (rev !== null && canJump) onjump?.(rev);
  }
</script>

{#if step}
  <div class="hc" role="presentation" onclick={(e) => e.stopPropagation()} ondblclick={(e) => e.stopPropagation()}>
    <div class="hx">step {roman(index + 1)} · {counts(step)}</div>
    <div class="hn">{step.title}</div>
    {#if step.about}<p>{step.about}</p>{/if}
    {#each step.strands as k, ki (ki)}
      {#if k.name}
        <div class="lane">{k.name}{k.background ? " · background" : ""}</div>
      {/if}
      <ul>
        {#each k.subs as sub, si (si)}
          <li class={sub.state}>
            <button class:jumps={canJump} onclick={(e) => jump(subRev(sub), e)}>{sub.title}</button>
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

<style>
  /* The box and nothing about where it stands: `position` is the caller's, and
     so is the width. */
  .hc {
    box-sizing: border-box;
    width: 100%;
    padding: 11px 14px 10px;
    background: var(--raised);
    border: 1px solid var(--rule);
    border-radius: var(--ch-radius, 4px);
    box-shadow: 0 18px 34px -12px color-mix(in srgb, var(--shade) 90%, transparent);
    cursor: default;
    text-align: left;
    animation: open 0.14s ease-out both;
  }
  @keyframes open {
    from {
      opacity: 0;
      transform: translateY(-3px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .hc {
      animation: none;
    }
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
