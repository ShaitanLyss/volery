<script lang="ts">
  /* How every project is going, in one glance.
   *
   * The reading Asana will not give you without a portfolio: its own status
   * updates live one project at a time, so "is anything off track anywhere" is
   * a tab each. That is the pipelines widget's argument exactly, one service
   * over, and it is the strongest case in this subsystem for drawing something
   * on a wall rather than opening a browser.
   *
   * The taxonomy is `asana.ts` and tested. Two things it decides that matter
   * more than they look:
   *
   * **Silence is not "on track".** Most projects have never had a status update
   * written on them, and a grid that drew that as green would be the most
   * reassuring possible way to be wrong about a portfolio. `none` is its own
   * state, muted, and it says "nothing said".
   *
   * **A parked project is not a project in trouble.** `on-hold` is muted rather
   * than amber: drawing a decision somebody has already taken as a warning is
   * how a grid learns to cry wolf.
   *
   * This costs one request for every project in the workspace — the list
   * endpoint takes the same `opt_fields` the single-project one does — which is
   * the only reason a status per project is affordable at all. Asked one at a
   * time it would be sixty-four requests a poll. */

  import type { Asana } from "./asana.svelte";
  import {
    healthOf,
    healthSaid,
    healthSaidEmpty,
    healthTally,
    healthTier,
    orderHealth,
    type Project,
  } from "./asana";
  import { rowsFor, textOf, variantOf, type Widget } from "./widgets";

  let {
    widget,
    asana,
    onopen,
    onkeyring,
  }: {
    widget: Widget;
    asana: Asana;
    onopen: (url: string) => void;
    onkeyring?: () => void;
  } = $props();

  const variant = $derived(variantOf(widget));
  const scope = $derived(textOf(widget, "scope", "mine"));
  const wanted = $derived(rowsFor(widget.h));

  /* Asking is what puts the project list on a clock. Without a grid up it is
     asked once, for the board widget's picker, and never polled — a status
     update is a thing somebody writes weekly. */
  $effect(() => {
    asana.attachProjects(widget.id);
  });
  $effect(() => () => asana.detach(widget.id));

  const pool = $derived<Project[]>(scope === "mine" ? asana.mine : asana.projects);
  const shown = $derived(orderHealth(pool));
  const rows = $derived(shown.slice(0, wanted));
  const rest = $derived(shown.length - rows.length);
  const tally = $derived(healthTally(pool));
  const said = $derived(
    healthSaidEmpty(asana.token.held(), asana.projectsReady, pool.length),
  );

  function why(p: Project): string {
    const bits = [healthSaid(healthOf(p.status)), p.owner, p.said].filter(Boolean);
    return `${p.name}\n${bits.join(" · ")}`;
  }
</script>

<div class="health" data-variant={variant}>
  <header>
    <span class="what">project health</span>
    {#if asana.projectsReady}
      <span class="tally">
        {#if tally["off-track"]}<span class="bad">{tally["off-track"]} off track</span> ·
        {/if}{#if tally["at-risk"]}{tally["at-risk"]} at risk · {/if}{pool.length} projects
      </span>
    {/if}
  </header>

  {#if said}
    <div class="empty">
      <p>{said}</p>
      {#if !asana.token.held() && onkeyring}
        <button class="verb" onclick={() => onkeyring?.()}>store one</button>
      {/if}
    </div>
  {:else if variant === "dots"}
    <!-- One dot per project, worst first. The reading that answers "is anything
         wrong anywhere" without you having to read a word — which is what a
         wall is for, and why this is the default. -->
    <ul class="dots" data-text>
      {#each shown as p (p.gid)}
        <li>
          <button
            class="dot"
            data-tier={healthTier(healthOf(p.status))}
            title={why(p)}
            aria-label={p.name}
            onclick={() => onopen(p.url)}
          ></button>
        </li>
      {/each}
    </ul>
  {:else}
    <ul class="rows" data-text>
      {#each rows as p (p.gid)}
        <li>
          <button class="row" title={why(p)} onclick={() => onopen(p.url)}>
            <i class="pip" data-tier={healthTier(healthOf(p.status))} aria-hidden="true"></i>
            <span class="name">{p.name}</span>
            <!-- The heading of the update, which is a sentence somebody wrote
                 about their own project — quoted rather than reworded, the same
                 bargain the pipelines fault line strikes. Falls back to the
                 state's own word where nobody has written one. -->
            <span class="says">{p.said || healthSaid(healthOf(p.status))}</span>
          </button>
        </li>
      {/each}
      {#if rest > 0}
        <li class="more">and {rest} more</li>
      {/if}
    </ul>
  {/if}

  {#if asana.projectsFault}
    <p class="oops">{asana.projectsFault}</p>
  {/if}
</div>

<style>
  .health {
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    overflow: hidden;
    font-size: 0.72rem;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex: 0 0 auto;
  }
  .what {
    font-family: var(--display);
    font-size: 0.84rem;
    color: var(--paper);
    white-space: nowrap;
  }
  .tally {
    font-family: var(--util);
    font-size: 0.62rem;
    color: var(--paper-faint);
    margin-left: auto;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bad {
    color: var(--st-fail);
  }

  .empty {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .empty p {
    margin: 0;
    color: var(--paper-faint);
    line-height: 1.4;
  }
  .verb {
    font-family: var(--util);
    font-size: 0.7rem;
    background: none;
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper-mute);
    padding: 0.22rem 0.45rem;
    cursor: pointer;
    align-self: flex-start;
  }
  .verb:hover {
    color: var(--paper);
    border-color: var(--rule);
  }

  /* ── the grid ──────────────────────────────────────────────────────────*/

  .dots {
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-wrap: wrap;
    align-content: flex-start;
    gap: 0.3rem;
    user-select: text;
  }
  .dot {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 50%;
    border: 1px solid var(--edge);
    background: var(--st-rest);
    padding: 0;
    cursor: pointer;
    display: block;
  }
  .dot:hover {
    border-color: var(--paper);
  }

  /* The wall's four status colours and no others — see `healthTier`. Asana's
     own green/yellow/red/blue are deliberately not reproduced: colour is
     status here, and these are the statuses this wall has. */
  [data-tier="fail"] {
    background: var(--st-fail);
  }
  [data-tier="soft"] {
    background: color-mix(in srgb, var(--st-ask) 50%, var(--st-rest));
  }
  [data-tier="ask"] {
    background: var(--st-ask);
  }
  [data-tier="work"] {
    background: var(--st-work);
  }
  [data-tier="rest"] {
    background: var(--st-rest);
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    user-select: text;
  }
  .row {
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    border-radius: 3px;
    color: inherit;
    font: inherit;
    padding: 0.18rem 0.25rem;
    cursor: pointer;
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
  }
  .row:hover {
    background: var(--raised);
  }
  .pip {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--st-rest);
    /* Nudged up to sit on the text's midline rather than its baseline, which is
       where a round mark beside a word wants to be. */
    transform: translateY(-1px);
  }
  .name {
    color: var(--paper-mute);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 0 1 auto;
  }
  .says {
    font-family: var(--util);
    font-size: 0.6rem;
    color: var(--paper-faint);
    margin-left: auto;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 0 1 auto;
    max-width: 55%;
  }
  .more {
    color: var(--paper-faint);
    font-family: var(--util);
    font-size: 0.6rem;
    padding: 0.1rem 0.25rem;
  }

  .oops {
    flex: 0 0 auto;
    margin: 0;
    font-family: var(--mono);
    font-size: 0.64rem;
    color: var(--st-fail);
    overflow: hidden;
    max-height: 2.4rem;
  }
</style>
