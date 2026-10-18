<script lang="ts">
  /* The plan, as a strip above the message box (`docs/chat-mode.md` §4.4,
     working.html): a segment per step — done, the one being worked, still to
     come — the step it is on and how far along. The wall draws the same plan
     as a plate (`Plate.svelte`); this is the same `timeline.ts` read another
     way, and it decides nothing about a plan.

     When the plan completes, the strip's segments fill and it leaves — one
     flourish, under 650ms (`timeline.md`, `motion.md`: anything celebratory
     ends and leaves the document) — and nothing about it idles. */
  import { effective, current, subsOf, type Timeline } from "./timeline";

  let { timeline }: { timeline: Timeline | null } = $props();

  /** What the strip drew last, kept so a plan that has just completed — and
   *  so stopped being live — can flourish rather than vanish. */
  let shown = $state<Timeline | null>(null);
  let leaving = $state(false);

  /** The flourish's length, inside `timeline.md`'s 650ms. */
  const FLOURISH_MS = 600;

  $effect(() => {
    const t = timeline;
    if (t) {
      shown = t;
      leaving = false;
      return;
    }
    if (!shown) return;
    /* Gone. If its last reading was every step done, it completed: fill and
       leave. Otherwise it was put away, and the strip simply goes. */
    const was = shown;
    const finished = was.plan.steps.length > 0 && was.plan.steps.every((s) => effective(s) === "done");
    const still =
      document.documentElement.dataset.motion === "still" ||
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!finished || still) {
      shown = null;
      return;
    }
    leaving = true;
    const off = setTimeout(() => {
      shown = null;
      leaving = false;
    }, FLOURISH_MS);
    return () => clearTimeout(off);
  });

  const steps = $derived(shown?.plan.steps ?? []);
  const at = $derived(shown ? current(shown.plan) : -1);
  const step = $derived(at >= 0 ? steps[at] : null);
  const sub = $derived(step ? (subsOf(step).find((x) => x.state === "active")?.title ?? null) : null);
</script>

{#if shown && steps.length}
  <div class="strip" class:leaving role="status" aria-label="the plan: step {Math.max(1, at + 1)} of {steps.length}">
    <svg class="i" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.2 4.5h6.8M6.2 8h6.8M6.2 11.5h6.8" />
      <circle cx="3.4" cy="4.5" r=".5" /><circle cx="3.4" cy="8" r=".5" /><circle cx="3.4" cy="11.5" r=".5" />
    </svg>
    <span class="lbl">plan</span>
    <span class="segs" aria-hidden="true">
      {#each steps as s, i (i)}
        {@const st = leaving ? "done" : effective(s)}
        <i class:d={st === "done"} class:a={st === "active" || (st !== "done" && i === at)}></i>
      {/each}
    </span>
    {#if leaving}
      <b>done</b>
    {:else if step}
      <b>{step.title}</b>{#if sub}<span class="sub">· {sub}</span>{/if}
      <span class="of">{at + 1} of {steps.length}</span>
    {/if}
  </div>
{/if}

<style>
  .strip {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    max-width: 100%;
    height: 30px;
    padding: 0 12px 0 10px;
    border-radius: 999px;
    font-family: var(--cv-ui, var(--util));
    font-size: 12.5px;
    color: var(--paper-dim);
    border: 1px solid var(--cv-hair, var(--edge));
    background: color-mix(in oklab, var(--surface) 75%, transparent);
    white-space: nowrap;
    overflow: hidden;
  }
  .i {
    width: 14px;
    height: 14px;
    flex: none;
    stroke: var(--paper-mute);
    fill: none;
    stroke-width: 1.5;
    stroke-linecap: round;
  }
  .segs {
    display: inline-flex;
    gap: 3px;
  }
  .segs i {
    width: 16px;
    height: 4px;
    border-radius: 2px;
    background: var(--edge);
    transition: background var(--dur-quick, 160ms) var(--ease-out, ease-out);
  }
  .segs i.d {
    background: var(--paper-mute);
  }
  .segs i.a {
    background: var(--st-work);
  }
  b {
    font-weight: 500;
    color: var(--paper);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sub {
    color: var(--paper-mute);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .of {
    color: var(--cv-note, var(--paper-mute));
    flex: none;
  }
  /* Narrow (§6.8): the strip shrinks to its current step. */
  @media (max-width: 899px) {
    .lbl,
    .sub,
    .of {
      display: none;
    }
  }
  /* The flourish: every segment fills (the class above), and the strip fades
     and lifts away once — opacity and transform, then it is gone. */
  .strip.leaving {
    animation: leave 600ms var(--ease-move, ease-in-out) forwards;
  }
  @keyframes leave {
    0%,
    45% {
      opacity: 1;
      transform: none;
    }
    100% {
      opacity: 0;
      transform: translateY(-4px);
    }
  }
</style>
