<script lang="ts">
  /* One run, opened — which job, and which step of it.
   *
   * The answer to the second half of what the pipelines widget is for. The list
   * says a build went red; this says *where*, which is the thing you used to
   * open a browser tab to find out.
   *
   * **A row is still a link and nothing else, and this panel keeps that floor.**
   * No re-run, no cancel, no approve — the argument in `azdo.md` has not
   * weakened by the reading getting deeper, and it gets stronger the closer you
   * are to the machinery: this wall spawns agents with
   * `--dangerously-skip-permissions`, and a "re-run failed jobs" button sitting
   * beside a job list read at a glance would be the most consequential thing in
   * the app. Looking costs nothing and can be taken back.
   *
   * Its own component for the reason `Keyring` and `Carry` are: a subsystem with
   * its own vocabulary of class names wants its own file, because a component is
   * the only CSS scope this codebase has.
   *
   * Everything it knows is `azdo.ts` and tested — `stageTierOf`, `stageSaid`,
   * `stageTook`, `worthOpening`, `detailSaid`. Nothing here decides anything. */

  import { clock } from "./conversation.svelte";
  import type { DevOps } from "./devops.svelte";
  import {
    detailSaid,
    elapsed,
    runSaid,
    running,
    shortName,
    shortRef,
    stageSaid,
    stageTierOf,
    stageTook,
    tierOf,
    took,
    worthOpening,
    type Run,
    type Stage,
  } from "./azdo";

  let {
    run,
    devops,
    onopen,
    onclose,
  }: {
    run: Run;
    devops: DevOps;
    /** Out to the browser — the one gesture that leaves the app, routed the way
     *  every link in the transcript is. */
    onopen: (url: string) => void;
    onclose: () => void;
  } = $props();

  const now = $derived(clock.t);

  /* Asking is what makes the detail poller run at all, and the cleanup is what
     stops it — the same bargain the widgets strike with `attachRuns`. Two
     effects rather than one, for the reason `Pipelines` gives: a tracking
     effect's cleanup fires on every change, so a single one would close and
     reopen the run every time the clock ticked. */
  $effect(() => {
    devops.openRun(run.id);
  });
  $effect(() => () => devops.closeRun());

  const opened = $derived(devops.opened);
  /* Only when it is *this* run's. A panel switched from one run to another has
     the previous one's stages in hand for a beat, and drawing them under the new
     title would be the panel lying rather than waiting. */
  const detail = $derived(opened.id === run.id ? opened.detail : null);
  const stages = $derived(detail?.stages ?? []);
  const said = $derived(detailSaid(detail, run));

  /* Which stage is unfolded. Undefined means "nobody has chosen", which is not
     the same as "none" — the first is answered by `worthOpening` and the second
     is somebody having closed the one it chose. */
  let chosen = $state<string | undefined>(undefined);
  const suggested = $derived(detail ? (worthOpening(detail)?.name ?? null) : null);
  const open = $derived(chosen === undefined ? suggested : chosen);

  function toggle(s: Stage) {
    chosen = open === s.name ? "" : s.name;
  }

  const tier = $derived(tierOf(run));
  const title = $derived(
    `${run.pipeline}${run.number ? ` #${run.number}` : ""}`,
  );
</script>

<!-- The same shell `Keyring`, `Themes` and `Carry` are drawn in: a scrim that
     dismisses, and a sheet over it. Escape closes, because every panel on this
     wall does and a panel that did not would be the one you get stuck in. -->
<div
  class="scrim"
  role="button"
  tabindex="-1"
  aria-label="close"
  onclick={onclose}
  onkeydown={(e) => e.key === "Escape" && onclose()}
></div>

<div class="sheet" role="dialog" aria-label={title}>
  <header>
    <span class="mark" data-tier={tier} class:going={running(run)}></span>
    <span class="title">{title}</span>
    <!-- The external link, which is the half of the sink item that says the
         browser must stay reachable rather than be replaced. An icon button, so
         it costs almost no width on a header that is mostly the run's name, and
         deliberately *not* the whole header — the header is a label, and making
         a panel's title bar navigate away is a click nobody meant. -->
    <button
      class="out"
      title="open on {run.forge === 'github' ? 'github' : 'azure devops'}"
      aria-label="open in the browser"
      onclick={() => onopen(run.url)}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M6 3h7v7" />
        <path d="M13 3 7 9" />
        <path d="M11 10.5V13H3V5h2.5" />
      </svg>
    </button>
    <button class="shut" title="close" aria-label="close" onclick={onclose}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    </button>
  </header>

  <!-- One line of provenance, which is what a panel has room for that a row does
       not: where it ran, off what, who asked, and how long it has been. -->
  <p class="about">
    <span>{run.project}</span>
    <span class="dot">·</span>
    <span>{shortRef(run.branch)}</span>
    {#if run.by}
      <span class="dot">·</span>
      <span>{shortName(run.by)}</span>
    {/if}
    <span class="when" data-tier={tier}>
      {runSaid(run)}{running(run) ? ` for ${took(elapsed(run, now))}` : ` in ${took(elapsed(run, now))}`}
    </span>
  </p>

  {#if said}
    <p class="quiet" class:fault={!!detail?.fault}>{said}</p>
  {:else}
    <ul class="stages">
      {#each stages as s (s.name)}
        {@const st = stageTierOf(s, run.forge)}
        {@const word = stageSaid(s, run.forge)}
        <li>
          <button
            class="stage"
            data-tier={st}
            aria-expanded={open === s.name}
            onclick={() => toggle(s)}
          >
            <span class="mark" data-tier={st} class:going={s.status !== "completed" && !!s.startedAt}
            ></span>
            <span class="name">{s.name}</span>
            {#if word}<span class="said">{word}</span>{/if}
            {#if stageTook(s, now)}<span class="took">{took(stageTook(s, now))}</span>{/if}
            <span class="caret" class:down={open === s.name}>›</span>
          </button>

          {#if open === s.name}
            <!-- Steps are folded by default and one stage is unfolded for you,
                 which is `worthOpening`: the first that failed, or the first
                 still going. A release pipeline is a dozen stages of which
                 eleven are skipped, so unfolding all of them would bury the
                 one row you opened the panel for. -->
            <ul class="steps">
              {#each s.steps as step, i (`${step.name}-${i}`)}
                {@const stepTier = stageTierOf(step, run.forge)}
                {@const stepWord = stageSaid(step, run.forge)}
                <li class="step" data-tier={stepTier}>
                  <span
                    class="mark"
                    data-tier={stepTier}
                    class:going={step.status !== "completed" && !!step.startedAt}
                  ></span>
                  <span class="name">{step.name}</span>
                  {#if stepWord}<span class="said">{stepWord}</span>{/if}
                  {#if stageTook(step, now)}
                    <span class="took">{took(stageTook(step, now))}</span>
                  {/if}
                </li>
              {:else}
                <li class="step none">no steps recorded</li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <!-- Said only while it is still going, because that is the only time it is
       news. A finished run's panel has stopped asking anything at all, and a
       line claiming otherwise would be furniture that lies. -->
  {#if detail?.live}
    <footer>refreshing while it runs</footer>
  {/if}
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: var(--scrim, rgba(0, 0, 0, 0.38));
    border: 0;
    cursor: default;
  }

  .sheet {
    position: fixed;
    z-index: 61;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(38rem, calc(100vw - 3rem));
    max-height: min(34rem, calc(100vh - 5rem));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0.7rem 0.8rem 0.6rem;
    border: 1px solid var(--edge);
    border-radius: 4px;
    /* Opaque, like everything else standing on this wall — the backdrop draws
       behind everything and a panel you can see leaves through is a panel with
       drifting leaves in the middle of a job list. */
    background: var(--surface);
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
    font-family: var(--util);
  }

  header {
    display: flex;
    align-items: center;
    gap: 0.7ch;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--edge);
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.82rem;
    color: var(--paper);
  }

  .out,
  .shut {
    flex: none;
    display: grid;
    place-items: center;
    width: 1.4rem;
    height: 1.4rem;
    padding: 0;
    border: 0;
    border-radius: 3px;
    background: none;
    color: var(--paper-mute);
    cursor: pointer;
  }
  .out:hover,
  .shut:hover {
    background: var(--raised);
    color: var(--paper);
  }
  .out svg,
  .shut svg {
    width: 0.85rem;
    height: 0.85rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .about {
    display: flex;
    align-items: baseline;
    gap: 0.6ch;
    margin: 0;
    padding: 0.34rem 0.1rem 0.4rem;
    font-size: 0.66rem;
    color: var(--paper-mute);
    white-space: nowrap;
    overflow: hidden;
  }
  .dot {
    color: var(--paper-faint);
  }
  .when {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    color: var(--paper-dim);
  }
  /* The only colour on this face, and it is the wall's own four. */
  .when[data-tier="work"] {
    color: var(--st-work);
  }
  .when[data-tier="fail"] {
    color: var(--st-fail);
  }
  .when[data-tier="ask"],
  .when[data-tier="soft"] {
    color: var(--st-ask);
  }

  .stages {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 0.2rem 0 0;
    list-style: none;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .stage {
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: 0.7ch;
    padding: 0.2rem 0.24rem;
    border: 0;
    border-radius: 2px;
    background: none;
    color: var(--paper-dim);
    font-family: inherit;
    font-size: 0.72rem;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }
  .stage:hover {
    background: var(--raised);
    color: var(--paper);
  }
  .stage[data-tier="fail"] .name {
    color: var(--paper);
  }

  .steps {
    margin: 0 0 0.2rem;
    padding: 0 0 0 1.6ch;
    list-style: none;
    /* A hairline down the left of the unfolded steps, so the nesting reads
       without indentation doing all the work at this size. */
    border-left: 1px solid var(--edge);
    margin-left: 0.9ch;
  }
  .step {
    display: flex;
    align-items: baseline;
    gap: 0.7ch;
    padding: 0.1rem 0.24rem;
    font-size: 0.66rem;
    color: var(--paper-mute);
    white-space: nowrap;
  }
  .step.none {
    color: var(--paper-faint);
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .said {
    flex: none;
    font-size: 0.62rem;
    color: var(--paper-mute);
  }
  .took {
    flex: none;
    min-width: 4ch;
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-size: 0.62rem;
    color: var(--paper-faint);
  }
  .caret {
    flex: none;
    width: 1ch;
    color: var(--paper-faint);
    transition: transform 120ms ease;
  }
  .caret.down {
    transform: rotate(90deg);
  }

  /* The same status stripe the list rows draw, so a stage and a run row read as
     the same instrument at two depths. */
  .mark {
    flex: none;
    align-self: center;
    width: 2px;
    height: 0.72em;
    border-radius: 1px;
    background: var(--st-rest);
  }
  .mark[data-tier="work"] {
    background: var(--st-work);
  }
  .mark[data-tier="ask"],
  .mark[data-tier="soft"] {
    background: var(--st-ask);
  }
  .mark[data-tier="soft"] {
    opacity: 0.55;
  }
  .mark[data-tier="fail"] {
    background: var(--st-fail);
  }
  /* A ring around what is still going. Deliberately not an animation, for the
     reason the pipelines dots are not: nothing else on this wall pulses. */
  .mark.going {
    box-shadow: 0 0 0 1px var(--st-work);
  }

  .quiet {
    flex: 1;
    margin: 0;
    padding: 1.2rem 0.3rem;
    font-size: 0.7rem;
    color: var(--paper-mute);
    text-align: center;
  }
  .quiet.fault {
    color: var(--st-fail);
    text-align: left;
  }

  footer {
    padding: 0.34rem 0.24rem 0;
    border-top: 1px solid var(--edge);
    font-size: 0.62rem;
    color: var(--paper-faint);
  }
</style>
