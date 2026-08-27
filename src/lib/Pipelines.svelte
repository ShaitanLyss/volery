<script lang="ts">
  /* What is building, across every project at once.
   *
   * The reading Azure DevOps itself will not give you: its builds page belongs
   * to a project, so "is anything red anywhere" is six tabs. On a wall it is one
   * instrument you glance at, which is the whole argument for drawing it here
   * rather than opening a browser.
   *
   * The taxonomy, the ordering and the wording are `azdo.ts` and tested; the
   * polling is one shared `DevOps` for however many of these are up. Nothing
   * here decides anything.
   *
   * **A row is a link and nothing else.** Everything this widget can do is look
   * — no re-run, no cancel, no approve. That is a deliberate floor rather than
   * an unfinished edge: this wall spawns agents with
   * `--dangerously-skip-permissions`, so a button here that started a deployment
   * would be the most consequential thing in the app and would sit one stray
   * click away from a list you are reading at a glance. Going *to* the pipeline
   * is a click that costs nothing and can be taken back.
   *
   * **Where a row goes changed, and the floor did not.** A left click used to
   * leave the app for the browser; it now opens the run *here* — which jobs ran,
   * which step failed — and the browser is an icon button beside it. Both are
   * still looking. The order matters and is the sink item's own reading: the
   * thing you want nine times in ten is which step went red, and that is now the
   * cheap gesture, while the tab you opened to find it out is still one click
   * away for the tenth — a log, a diff, an artifact, anything this panel
   * deliberately does not draw.
   *
   * The `dots` and `lanes` readings get no icon of their own. There is no room
   * for one at that size, and none is needed: a dot opens the panel and the
   * panel carries the link, so the way out exists from every reading without
   * every reading having to draw it. */

  import { clock } from "./conversation.svelte";
  import type { DevOps } from "./devops.svelte";
  import {
    elapsed,
    emptySaid,
    orderRuns,
    runSaid,
    running,
    scopeRuns,
    shortName,
    shortRef,
    tallyRuns,
    tierOf,
    took,
    type Run,
    type RunScope,
  } from "./azdo";
  import { rowsFor, textOf, variantOf, type Widget } from "./widgets";

  let {
    widget,
    devops,
    onopen,
    onrun,
    onkeyring,
  }: {
    widget: Widget;
    devops: DevOps;
    /** Out to the browser — `Skein.openLink`, which is `open.rs`. Passed rather
     *  than invoked here for the reason the process meter's `onreveal` is: where
     *  a click goes is the studio's to decide, not an instrument's. */
    onopen: (url: string) => void;
    /** Open a run's insides over the wall. Routed out rather than drawn here for
     *  the reason `onkeyring` is: which panel is on screen is the studio's
     *  business, and this widget can be dropped to the size of a card, where a
     *  job list would not fit at all. */
    onrun?: (run: Run) => void;
    /** Ask for the token panel. Routed out rather than reached for, the same way
     *  `onopen` is: which panel is on screen is the studio's business, and this
     *  widget can be dropped to the size of a card, where a field would not
     *  fit. */
    onkeyring?: () => void;
  } = $props();

  /* The wall's own one-second tick, taken directly — the same rune `Clock` and
     `Usage` read, and the reason none of them adds a wake-up to an idle
     machine. A running build's elapsed time is the only thing here that changes
     between polls, and `took` only changes its wording once a minute past the
     first one. */
  const now = $derived(clock.t);
  const variant = $derived(variantOf(widget));
  const scope = $derived(textOf(widget, "scope", "live") as RunScope);
  const wanted = $derived(rowsFor(widget.h));

  /* Asking is what makes the poller run at all — with no pipelines widget up,
     nothing asks Azure DevOps about a build. Two effects rather than one, for
     the reason `Perf.svelte` gives: a tracking effect's cleanup fires on every
     change, so a single one would detach and reattach every time the scope was
     switched, and detaching the last watcher drops the credential. */
  $effect(() => {
    devops.attachRuns(widget.id);
  });
  $effect(() => () => devops.detach(widget.id));

  const half = $derived(devops.runs);
  const shown = $derived(orderRuns(scopeRuns(half.rows, scope, now), now));
  const tally = $derived(tallyRuns(half.rows, now));
  const rows = $derived(shown.slice(0, wanted));
  const rest = $derived(shown.length - rows.length);

  /** Projects, in the order their busiest run puts them — so the lane that is
   *  building is at the top rather than wherever the alphabet left it. */
  const lanes = $derived.by(() => {
    const by = new Map<string, Run[]>();
    for (const r of shown) {
      const at = by.get(r.project);
      if (at) at.push(r);
      else by.set(r.project, [r]);
    }
    return [...by.entries()].slice(0, wanted).map(([project, runs]) => ({ project, runs }));
  });

  /** What a click on a run does. The panel when there is somewhere to route it,
   *  and the browser when there is not — so a `Pipelines` mounted without an
   *  `onrun` (a test harness, a future caller) still does the useful thing
   *  rather than nothing at all. */
  function pick(r: Run) {
    if (onrun) onrun(r);
    else onopen(r.url);
  }

  function why(r: Run): string {
    const who = shortName(r.by);
    const when = running(r) ? `${runSaid(r)} for ${took(elapsed(r, now))}` : runSaid(r);
    return `${r.project} · ${r.pipeline} #${r.number}\n${shortRef(r.branch)} — ${when}${
      who ? `, by ${who}` : ""
    }`;
  }
</script>

<div class="pipes" data-variant={variant}>
  <header>
    <!-- One organisation names itself; several are not worth naming one of, and
         "azure devops" stopped being true the moment a GitHub owner could be in
         that list. -->
    <span class="what">{half.orgs.length === 1 ? half.orgs[0] : "pipelines"}</span>
    <!-- Two numbers, and only when they are not zero. A header that always says
         `0 running 0 failed` is a header you stop reading; one that is bare
         until something is happening is one you notice. -->
    {#if tally.live}<span class="tot" data-tier="work">{tally.live} running</span>{/if}
    {#if tally.failed}<span class="tot" data-tier="fail">{tally.failed} failed</span>{/if}
  </header>

  {#if half.fault && !half.rows.length}
    <!-- A refused credential is the one fault here you can actually do something
         about, so it is the one that gets a way in. Pressed rather than
         auto-opened: a panel that appears over the wall because a poll came back
         401 would be a window opening itself every twenty seconds. The fault
         keeps its own `title`, since the button truncates at this size. -->
    {#if onkeyring && /refused|no credential/.test(half.fault)}
      <button class="fault ask" title={half.fault} onclick={() => onkeyring?.()}>
        {half.fault}<span class="more">— store a token</span>
      </button>
    {:else}
      <p class="fault" title={half.fault}>{half.fault}</p>
    {/if}
  {:else if !shown.length}
    <p class="quiet">
      {emptySaid("runs", half.ready, half.orgs, scope !== "all", half.unseen)}
    </p>
  {:else if variant === "dots"}
    <!-- One mark per run and no words at all, for a widget dropped to the size
         of a card. It answers exactly one question — is anything red — which is
         the question you ask from across the room. -->
    <div class="dots">
      {#each shown as r (r.id)}
        <button
          class="dot"
          data-tier={tierOf(r)}
          class:going={running(r)}
          title={why(r)}
          onclick={() => pick(r)}
          aria-label={why(r)}
        ></button>
      {/each}
    </div>
  {:else if variant === "lanes"}
    <ul class="rows lanes">
      {#each lanes as lane (lane.project)}
        <li>
          <span class="lane">
            <span class="label">{lane.project}</span>
            <span class="marks">
              {#each lane.runs.slice(0, 12) as r (r.id)}
                <button
                  class="dot"
                  data-tier={tierOf(r)}
                  class:going={running(r)}
                  title={why(r)}
                  onclick={() => pick(r)}
                  aria-label={why(r)}
                ></button>
              {/each}
            </span>
          </span>
        </li>
      {/each}
    </ul>
  {:else}
    <ul class="rows">
      {#each rows as r (r.id)}
        <!-- The row and the link are siblings rather than nested, because a
             button inside a button is invalid and the browser resolves it by
             swallowing one of them. -->
        <li class="line">
          <button class="row" data-tier={tierOf(r)} title={why(r)} onclick={() => pick(r)}>
            <span class="mark" class:going={running(r)}></span>
            <span class="label">{r.pipeline}</span>
            <span class="ref">{shortRef(r.branch)}</span>
            <span class="when">{took(elapsed(r, now))}</span>
          </button>
          <!-- Drawn only on hover and focus. It is the tenth-time gesture, and a
               column of arrows down a list read at a glance would be nine rows
               of chrome for one row's use — but it must stay reachable from the
               keyboard, so `:focus-visible` shows it too. -->
          <button
            class="out"
            title="open in the browser"
            aria-label="open {r.pipeline} in the browser"
            onclick={() => onopen(r.url)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6 3h7v7" />
              <path d="M13 3 7 9" />
              <path d="M11 10.5V13H3V5h2.5" />
            </svg>
          </button>
        </li>
      {/each}
      {#if rest > 0}
        <!-- Says what is not on screen rather than merely stopping — the same
             tail line the process meter draws, and the reason the row count
             comes off the height. -->
        <li><span class="row more">…and {rest} more</span></li>
      {/if}
    </ul>
  {/if}
</div>

<style>
  .pipes {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0.34rem 0.4rem 0.4rem;
    /* Paints no background of its own — the wrapper fills, and leaving it there
       is what lets the `frame` knob's `bare` reach this face. */
    font-family: var(--util);
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 0.6ch;
    padding: 0 0.2rem 0.26rem;
    border-bottom: 1px solid var(--edge);
    font-size: 0.66rem;
    color: var(--paper-mute);
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .what {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tot {
    font-variant-numeric: tabular-nums;
    color: var(--paper-dim);
  }
  /* The only colour on this face, and it is the wall's own status hues rather
     than Azure DevOps' — celadon working, rust broken. Nothing here introduces
     a tone. */
  .tot[data-tier="work"] {
    color: var(--st-work);
  }
  .tot[data-tier="fail"] {
    color: var(--st-fail);
  }

  .rows {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 0.16rem 0 0;
    list-style: none;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .row,
  .lane {
    width: 100%;
    display: flex;
    align-items: baseline;
    gap: 0.7ch;
    padding: 0.12rem 0.2rem;
    border: none;
    border-radius: 2px;
    background: none;
    color: var(--paper-dim);
    font-family: inherit;
    font-size: 0.68rem;
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }
  .row.more {
    cursor: default;
    color: var(--paper-mute);
  }

  /* The row and its link, side by side. The link takes no width until it is
     wanted, so the row is exactly as wide as it was before this existed. */
  .line {
    display: flex;
    align-items: stretch;
    gap: 0;
  }
  .line .row {
    flex: 1;
    min-width: 0;
  }
  .out {
    flex: none;
    display: grid;
    place-items: center;
    width: 0;
    padding: 0;
    border: 0;
    border-radius: 2px;
    background: none;
    color: var(--paper-faint);
    opacity: 0;
    overflow: hidden;
    cursor: pointer;
  }
  .line:hover .out,
  .out:focus-visible {
    width: 1.15rem;
    opacity: 1;
  }
  .out:hover {
    background: var(--raised);
    color: var(--paper);
  }
  .out svg {
    width: 0.68rem;
    height: 0.68rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  button.row:hover {
    background: var(--raised);
    color: var(--paper);
  }

  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ref {
    max-width: 12ch;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--paper-mute);
  }
  .when {
    min-width: 4ch;
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-size: 0.62rem;
    color: var(--paper-mute);
  }

  /* A bar rather than a disc on a row, so it reads as a status stripe down the
     left edge of the list and the four tiers line up with each other. */
  .mark {
    flex: none;
    align-self: center;
    width: 2px;
    height: 0.72em;
    border-radius: 1px;
    background: var(--st-rest);
  }
  .row[data-tier="work"] .mark {
    background: var(--st-work);
  }
  .row[data-tier="ask"] .mark,
  .row[data-tier="soft"] .mark {
    background: var(--st-ask);
  }
  .row[data-tier="fail"] .mark {
    background: var(--st-fail);
  }
  /* `soft` is the half-bloom the wall already uses for warming — the same amber
     at less weight, never a fifth hue. */
  .row[data-tier="soft"] .mark {
    opacity: 0.55;
  }

  .dots {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-wrap: wrap;
    align-content: flex-start;
    gap: 0.34rem;
    padding: 0.4rem 0.2rem;
    overflow: hidden;
  }
  .marks {
    display: flex;
    flex-wrap: nowrap;
    gap: 0.28rem;
    overflow: hidden;
  }
  .dot {
    flex: none;
    width: 0.56rem;
    height: 0.56rem;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--st-rest);
    cursor: pointer;
  }
  .dot[data-tier="work"] {
    background: var(--st-work);
  }
  .dot[data-tier="ask"],
  .dot[data-tier="soft"] {
    background: var(--st-ask);
  }
  .dot[data-tier="soft"] {
    opacity: 0.55;
  }
  .dot[data-tier="fail"] {
    background: var(--st-fail);
  }
  .dot:hover {
    outline: 1px solid var(--paper-faint);
    outline-offset: 1px;
  }
  /* A ring around what is still going, so a live build reads as live at dot
     size where there is no room for a word. Deliberately not an animation:
     nothing else on this wall pulses, and a widget that moved in the corner of
     your eye would be furniture demanding attention. */
  .dot.going,
  .mark.going {
    box-shadow: 0 0 0 1px var(--st-work);
  }

  .quiet,
  .fault {
    flex: 1;
    margin: 0;
    padding: 0.5rem 0.3rem;
    font-size: 0.66rem;
    color: var(--paper-mute);
    text-align: center;
    overflow: hidden;
  }
  .fault {
    color: var(--st-fail);
    text-align: left;
  }
  /* The same line, pressable. A refinement rather than its own definition, so
     the two cannot drift apart — see `test/styles.test.ts`. */
  .fault.ask {
    display: block;
    width: 100%;
    background: none;
    border: 0;
    font: inherit;
    cursor: pointer;
    text-overflow: ellipsis;
  }
  .fault.ask:hover {
    background: var(--raised);
  }
  /* What pressing it does, in the widget's quietest voice — the fault is the
     message and this is only the affordance. */
  .more {
    display: block;
    color: var(--paper-faint);
  }
</style>
