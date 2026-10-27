<script lang="ts">
  /* Claude Code and its plugins, kept current — the accounts panel's half.
   *
   * Under the "claude code 2.1.311" line, because that line is already where
   * this machine's Claude Code is described, and the moment this is wanted —
   * a skill just pushed — is a moment of asking "what is this machine running".
   * `<space> m u` runs it from anywhere without opening the panel.
   *
   * Everything said here is `freshen.ts`; the run is `freshen.rs`; which cards
   * are on the old copy and standing them down is `Skein`'s. */
  import { clock } from "./conversation.svelte";
  import { freshening } from "./freshening.svelte";
  import {
    EVERY_CHOICES,
    sayCame,
    sayEvery,
    sayRun,
    sayStale,
    sayWhat,
    type Stale,
  } from "./freshen";

  let {
    stale = [],
    onrestart,
  }: {
    stale?: Stale[];
    onrestart?: () => Promise<{ rested: number; kept: number }>;
  } = $props();

  const snap = $derived(freshening.snap);
  const last = $derived(snap?.last ?? null);
  const running = $derived(snap?.running === true);
  /* Open while it runs and after a run that has something to say; a run that
     found everything current folds to its one line. */
  let opened = $state<boolean | null>(null);
  const eventful = $derived(
    !!last && last.items.some((i) => i.state === "failed" || (i.state === "updated" && i.kind !== "marketplace")),
  );
  const showItems = $derived(opened ?? (running || eventful));
  const ready = $derived(stale.filter((s) => !s.busy).length);
  let restarting = $state(false);
  let said = $state<string | null>(null);

  const choice = $derived(snap && snap.settings.auto ? snap.settings.everyHours : 0);

  async function now() {
    said = null;
    const started = await freshening.now();
    if (!started && !freshening.fault) said = "already updating";
  }

  function every(e: Event) {
    const h = Number((e.currentTarget as HTMLSelectElement).value);
    void freshening.set(h > 0, h > 0 ? h : (snap?.settings.everyHours ?? 6));
  }

  async function restart() {
    if (!onrestart || restarting) return;
    restarting = true;
    said = null;
    try {
      const { rested, kept } = await onrestart();
      said = rested
        ? `stood ${rested} down — each comes back on the new copy at your next message${kept ? `; ${kept} still busy` : ""}`
        : "none could go yet — each is in the middle of something";
    } finally {
      restarting = false;
    }
  }
</script>

<div class="fresh">
  <div class="line">
    <span class="when" class:live={running}>{sayRun(last, clock.t)}</span>
    <span class="grow"></span>
    {#if last}
      <button class="fold" onclick={() => (opened = !showItems)} title={showItems ? "fold the list" : "every item of the last run"}
        >{showItems ? "less" : "each"}</button
      >
    {/if}
    <button
      class="run"
      onclick={() => void now()}
      disabled={running || !snap}
      title="claude update, then every plugin marketplace, then every installed plugin in every scope (space then m u)"
      >{running ? "updating…" : "update claude code & plugins"}</button
    >
  </div>

  {#if showItems && last}
    <ul class="items">
      {#each last.items as item, i (i)}
        <li class:bad={item.state === "failed"} class:live={item.state === "running"} class:quiet={item.state === "waiting" || item.state === "skipped"}>
          <span class="what">{sayWhat(item)}</span>
          <span class="came" title={item.said ?? ""}>{sayCame(item)}</span>
        </li>
      {/each}
    </ul>
  {/if}

  {#if stale.length}
    <div class="line stale">
      <span class="said" title={stale.map((s) => `${s.name}: ${s.why.join(", ")}`).join("\n")}>{sayStale(stale, ready)}</span>
      <span class="grow"></span>
      <button
        class="run"
        onclick={() => void restart()}
        disabled={restarting || ready === 0}
        title="stand down the cards on the old copy that are not in the middle of anything — nothing is lost, and each starts again on the new copy at your next message"
        >{restarting ? "restarting…" : ready === stale.length ? "restart them" : `restart the ${ready} at rest`}</button
      >
    </div>
  {/if}

  <div class="line">
    {#if snap && snap.autoAllowed}
      <label class="every">
        checks by itself
        <select value={String(choice)} onchange={every}>
          {#each EVERY_CHOICES as h (h)}
            <option value={String(h)}>{h === 0 ? "never" : h === 1 ? "every hour" : `every ${h} hours`}</option>
          {/each}
        </select>
      </label>
    {:else if snap}
      <span class="said">{sayEvery(snap.settings, false)}</span>
    {/if}
    {#if said || freshening.fault}<span class="said">{freshening.fault ?? said}</span>{/if}
  </div>
</div>

<style>
  .fresh {
    flex-basis: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding-top: 0.35rem;
    border-top: 1px solid var(--rule);
    font-family: var(--util);
    font-size: 0.7rem;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .grow {
    flex: 1;
  }
  .when,
  .said {
    color: var(--paper-dim);
  }
  .when.live,
  li.live .came {
    color: var(--st-work);
  }
  .run,
  .fold {
    font-family: var(--util);
    font-size: 0.7rem;
    padding: 0.15rem 0.55rem;
    border: 1px solid var(--edge);
    border-radius: 3px;
    background: var(--raised);
    color: var(--paper);
    cursor: pointer;
  }
  .fold {
    border-color: transparent;
    background: transparent;
    color: var(--paper-faint);
    padding: 0.15rem 0.3rem;
  }
  .run:hover:not(:disabled),
  .fold:hover {
    border-color: var(--paper-faint);
  }
  .run:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .items {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: minmax(0, auto) minmax(0, 1fr);
    column-gap: 0.75rem;
    row-gap: 0.1rem;
  }
  .items li {
    display: contents;
  }
  .what {
    color: var(--paper-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .came {
    color: var(--paper);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  li.quiet .came,
  li.quiet .what {
    color: var(--paper-faint);
  }
  li.bad .came {
    color: var(--st-fail);
    white-space: normal;
  }
  .stale .said {
    color: var(--paper);
  }
  .every {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--paper-dim);
  }
  .every select {
    font-family: var(--util);
    font-size: 0.7rem;
    background: var(--raised);
    color: var(--paper);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.05rem 0.3rem;
  }
</style>
