<script lang="ts">
  /* What is arriving right now, across the flyway (§8.3).
   *
   * **A different reading from the chart above it, not a finer one.** The
   * analytics buckets a fact at five minutes because its questions are rates
   * over months; this answers "what is landing now", off the event stream, and
   * nothing here is stored. The strip is the last five minutes in five-second
   * columns, so a burst is visible while it is happening rather than after the
   * bucket closes.
   *
   * Two honesty rules. A machine with nothing in the window is not drawn at
   * all: a wall that is off is not a wall that spent nothing. And a rate over a
   * window with no width is a dash rather than 0, because a rate of zero is a
   * measurement and this is not one.
   *
   * The local line comes from the collector this window feeds. A peer's line
   * arrives with the flyway's live frame; until one does, the panel says the
   * fleet half is not connected rather than drawing one machine and calling it
   * the fleet.
   */
  import { clock } from "./conversation.svelte";
  import { live } from "./live.svelte";
  import { byHost, liveSaid, perMinute, stripOf, totalsIn } from "./live";
  import { money } from "./usage";

  let {
    /** This wall's name, off the roster; empty until the flyway answers. */
    host = "",
  }: { host?: string } = $props();

  const MINUTE = 60_000;
  const WINDOW = 5 * MINUTE;

  const now = $derived(Math.floor(clock.t / 1000) * 1000);
  const from = $derived(now - WINDOW);

  const rows = $derived(
    byHost(live.samples, from, now).map((r) => ({
      ...r,
      label: r.host === "" ? host || "this wall" : r.host,
    })),
  );
  /* The whole window and the last minute, because a five-minute rate hides a
     burst that started forty seconds ago and a one-minute rate is noise on a
     wall that is thinking. */
  const rate5 = $derived(perMinute(totalsIn(live.samples, from, now), from, now));
  const rate1 = $derived(
    perMinute(totalsIn(live.samples, now - MINUTE, now), now - MINUTE, now),
  );
  const bars = $derived(stripOf(live.samples, from, now, 60));
  const top = $derived(Math.max(1, ...bars));
</script>

<section class="al" aria-label="usage arriving now">
  <header class="al-head">
    <span class="al-title">arriving now</span>
    <span class="al-now">
      {liveSaid(rate1?.tokens ?? 0)}
      <span class="al-dim">this minute</span>
    </span>
    <span class="al-now">
      {liveSaid(rate5?.tokens ?? 0)}
      <span class="al-dim">over five</span>
    </span>
    <span class="al-now">
      {rate1 ? (rate1.usd > 0 ? `${money(rate1.usd * 60)}/h` : "unpriced") : "—"}
      <span class="al-dim">at this rate</span>
    </span>
    <span class="al-fleet">
      {#if rows.length === 0}
        nothing is arriving
      {:else}
        {rows.length === 1 ? "one machine" : `${rows.length} machines`}
      {/if}
    </span>
  </header>

  <div class="al-strip" role="img" aria-label="tokens arriving, five seconds a column, the last five minutes">
    {#each bars as v, i (i)}
      <span style={`height:${(v / top) * 100}%`}></span>
    {/each}
  </div>

  {#if rows.length > 0}
    <ul class="al-rows">
      {#each rows as row (row.host)}
        <li>
          <span class="al-name">{row.label}</span>
          <span class="al-num">{liveSaid((row.totals.tokens / WINDOW) * MINUTE)}</span>
          <span class="al-dim">{row.totals.usd > 0 ? money(row.totals.usd) : "unpriced"} over five</span>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .al {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 16px 12px;
    border-bottom: 1px solid var(--edge);
  }
  .al-head {
    display: flex;
    align-items: baseline;
    gap: 18px;
    font-size: 11.5px;
    color: var(--paper);
  }
  .al-title {
    color: var(--paper-mute);
    font-size: 10px;
    letter-spacing: 0.04em;
  }
  .al-now {
    font-variant-numeric: tabular-nums;
    display: inline-flex;
    gap: 6px;
    align-items: baseline;
  }
  .al-fleet {
    margin-left: auto;
    color: var(--paper-mute);
    font-size: 10.5px;
  }
  .al-dim {
    color: var(--paper-faint);
    font-size: 10px;
  }
  .al-strip {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 26px;
    border-bottom: 1px solid var(--edge);
  }
  .al-strip span {
    flex: 1 1 0;
    min-width: 1px;
    background: var(--paper-faint);
    border-radius: 1px 1px 0 0;
  }
  .al-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 22px;
    font-size: 11px;
    color: var(--paper-dim);
  }
  .al-rows li {
    display: flex;
    gap: 7px;
    align-items: baseline;
  }
  .al-name {
    color: var(--paper);
  }
  .al-num {
    font-variant-numeric: tabular-nums;
  }
</style>
