<script lang="ts">
  /* What is on you, across every project.
   *
   * The cheapest useful thing in the Asana subsystem and the one a developer
   * glances at most: one request, one list, no board to choose. Asana will show
   * you this too — it is "My tasks" — but it is a tab you go to, and the whole
   * argument for the wall is that a thing you check twenty times a day should
   * be on it rather than behind a click.
   *
   * The ordering and the counts are `asana.ts` and tested: late first and most
   * overdue at the top, then today, then by date, then everything undated, and
   * anything ticked last however overdue it was. Nothing here decides anything.
   *
   * **A row is a link and nothing else**, which is the floor the board widget
   * draws one step further in. A move between columns is reversible by dragging
   * it back; ticking a task off from a wall you glance at is not, and it lands
   * in somebody's project as though you had meant it. */

  import type { Asana } from "./asana.svelte";
  import {
    assignedTally,
    chipsOf,
    dueReading,
    mineSaid,
    orderAssigned,
    todayIso,
    type Assigned,
  } from "./asana";
  import { clock } from "./conversation.svelte";
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
  const open = $derived(textOf(widget, "showing", "open") === "open");
  const today = $derived(todayIso(new Date(clock.t)));
  const wanted = $derived(rowsFor(widget.h));

  /* Asking is what makes the poller run: with no tasks widget up, nothing asks
     Asana what is on you. Two effects rather than one, for the reason
     `Pipelines` gives — a tracking effect's cleanup fires on every change, so a
     single one would detach and reattach every time the filter was switched. */
  $effect(() => {
    asana.attachMine(widget.id, open);
  });
  $effect(() => () => asana.detach(widget.id));

  const feed = $derived(asana.feed(open));
  const all = $derived<Assigned[]>(feed?.rows ?? []);
  const shown = $derived(orderAssigned(all, today));
  const rows = $derived(shown.slice(0, wanted));
  const rest = $derived(shown.length - rows.length);
  const tally = $derived(assignedTally(all, today));
  const said = $derived(mineSaid(asana.token.held(), feed?.ready ?? false, all.length));

  function why(t: Assigned): string {
    const due = dueReading(t.due, today);
    return `${t.name}\n${[t.project, due?.text].filter(Boolean).join(" · ")}`;
  }
</script>

<div class="mine" data-variant={variant}>
  <header>
    <span class="what">on me</span>
    {#if feed?.ready}
      <!-- Late is the only one that earns a colour, and only when there is one:
           a widget with a red number on it at all times is a widget you stop
           reading. -->
      <span class="tally">
        {#if tally.late}<span class="late">{tally.late} late</span> · {/if}{tally.today} today ·
        {tally.open} open
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
  {:else if variant === "counts"}
    <!-- The reading that still says something at the size of a card, where a
         list of names says nothing at all. Three numbers and what they are. -->
    <ul class="counts" data-text>
      <li class:warn={tally.late > 0}><b>{tally.late}</b><span>late</span></li>
      <li><b>{tally.today}</b><span>today</span></li>
      <li><b>{tally.soon}</b><span>this week</span></li>
    </ul>
  {:else}
    <ul class="rows" data-text>
      {#each rows as t (t.gid)}
        {@const due = dueReading(t.due, today)}
        {@const chips = chipsOf(t, 1)}
        <li>
          <button class="row" title={why(t)} onclick={() => onopen(t.url)}>
            <span class="name" class:done={t.completed}>{t.name}</span>
            <span class="meta">
              {#if t.project}<span class="in">{t.project}</span>{/if}
              {#each chips.shown as f (f.name)}
                <span class="chip" title={f.name}>{f.value}</span>
              {/each}
              {#if due}
                <span class="due" class:late={due.late}>{due.text}</span>
              {/if}
            </span>
          </button>
        </li>
      {/each}
      {#if rest > 0}
        <!-- What did not fit, said rather than silently cut. Same rule as the
             board's page cap and the pipelines widget's overflow. -->
        <li class="more">and {rest} more</li>
      {/if}
    </ul>
  {/if}

  {#if feed?.fault}
    <p class="oops">{feed.fault}</p>
  {/if}
</div>

<style>
  .mine {
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
  .late {
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
    padding: 0.16rem 0.25rem;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
  }
  .row:hover {
    background: var(--raised);
  }
  .name {
    color: var(--paper-mute);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Ticked. Struck through rather than coloured — colour is status here and
     "finished" is the one status that is good news. */
  .done {
    text-decoration: line-through;
    color: var(--paper-faint);
  }
  .meta {
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
    font-family: var(--util);
    font-size: 0.6rem;
    color: var(--paper-faint);
    overflow: hidden;
  }
  .in {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* A custom field's value, which is whatever that board's owner set it to be.
     Bordered rather than coloured: it is somebody else's vocabulary and this
     wall's colours are spoken for. */
  .chip {
    border: 1px solid var(--edge);
    border-radius: 2px;
    padding: 0 0.22rem;
    white-space: nowrap;
    flex: 0 0 auto;
  }
  .due {
    margin-left: auto;
    white-space: nowrap;
  }
  .due.late {
    color: var(--st-fail);
  }
  .more {
    color: var(--paper-faint);
    font-family: var(--util);
    font-size: 0.6rem;
    padding: 0.1rem 0.25rem;
  }

  .counts {
    list-style: none;
    margin: 0;
    padding: 0;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: space-around;
    gap: 0.4rem;
    user-select: text;
  }
  .counts li {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.1rem;
  }
  .counts b {
    font-family: var(--display);
    font-size: 1.5rem;
    font-weight: 400;
    line-height: 1;
    color: var(--paper);
    font-variant-numeric: tabular-nums;
  }
  .counts span {
    font-family: var(--util);
    font-size: 0.58rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--paper-faint);
  }
  /* Only when there is something late. A permanently red number is one nobody
     looks at. */
  .counts li.warn b {
    color: var(--st-fail);
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
