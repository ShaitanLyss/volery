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
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { clock } from "./conversation.svelte";
  import { live } from "./live.svelte";
  import { byHost, liveSaid, perMinute, stripOf, totalsIn } from "./live";
  import { money } from "./usage";

  /** One wall's beat, as `flyway_live` and `flyway:live` carry it (§20.1). */
  type Beat = {
    msg: "live";
    host: string;
    at: number;
    tokens: number;
    usd: number;
    requests: number;
    cards: number;
    agents: number;
  };

  let {
    /** This wall's name, off the roster; empty until the flyway answers. */
    host = "",
  }: { host?: string } = $props();

  const MINUTE = 60_000;
  const WINDOW = 5 * MINUTE;
  /** Three beats is a link that is not working; two lost in a row is a blip. */
  const STALE_AFTER = 6_000;

  /** Every other wall's last beat. Kept here rather than in the collector
   *  because it is not a sample this wall took: it is what another machine said
   *  about itself, and it is never folded into this wall's own rate. */
  let peers = $state<Beat[]>([]);
  let unlisten: UnlistenFn | null = null;

  /* **Only while this panel is up.** The beat is what wakes the other machines,
     so a wall with nobody looking must stop saying it: the note carries
     `wants`, and the teardown says false. */
  $effect(() => {
    let gone = false;
    void (async () => {
      try {
        const rows = await invoke<Beat[]>("flyway_live");
        if (!gone) peers = rows;
        const off = await listen<Beat[]>("flyway:live", (e) => {
          if (!gone) peers = e.payload ?? [];
        });
        if (gone) off();
        else unlisten = off;
      } catch {
        /* No wall behind this page (the browser preview), or the link is down:
           the local half still draws, and the fleet half says it has heard
           nothing rather than drawing one machine as the fleet. */
      }
    })();
    return () => {
      gone = true;
      unlisten?.();
      unlisten = null;
      void invoke("flyway_note_live", {
        tokens: 0,
        usd: 0,
        requests: 0,
        cards: 0,
        agents: 0,
        wants: false,
      }).catch(() => {});
    };
  });

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

  /* **This wall's own beat, noted while the panel is up.** It is a rate rather
     than a count, so a beat that never lands costs a reading and not a fact,
     and a peer that misses one sees a two-second-old line instead of a hole.
     An effect on the wall's second is exactly one note a second. */
  $effect(() => {
    void now;
    void live.version;
    const totals = totalsIn(live.samples, now - MINUTE, now);
    void invoke("flyway_note_live", {
      tokens: totals.tokens,
      usd: totals.usd,
      requests: totals.requests,
      cards: 0,
      agents: 0,
      wants: true,
    }).catch(() => {});
  });

  const bars = $derived(stripOf(live.samples, from, now, 60));
  const top = $derived(Math.max(1, ...bars));

  /** The fleet lines, aged. **A beat's age is drawn and never interpolated**:
   *  two points two seconds apart and two thirty seconds apart joined by the
   *  same line are the same lie at different resolutions, so a stale wall keeps
   *  its last reading and says how old it is. */
  const fleetRows = $derived(
    peers
      .map((p) => ({ ...p, age: Math.max(0, now - p.at) }))
      .sort((a, b) => b.tokens - a.tokens || a.host.localeCompare(b.host)),
  );
  const fleetTotal = $derived(
    fleetRows.reduce((a, p) => a + (p.age <= STALE_AFTER ? p.tokens : 0), 0),
  );
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
      {rate1 ? (rate1.usd > 0 ? `${money(rate1.usd * 60)}/h` : "unpriced") : ""}
      <span class="al-dim">at this rate</span>
    </span>
    <span class="al-fleet">
      {#if fleetRows.length === 0}
        {rows.length === 0 ? "nothing is arriving" : "no other wall heard"}
      {:else}
        fleet {liveSaid(fleetTotal)}{#if fleetRows.some((p) => p.age > STALE_AFTER)}
          <span class="al-stale">some lines are old</span>
        {/if}
      {/if}
    </span>
  </header>

  <div class="al-strip" role="img" aria-label="tokens arriving, five seconds a column, the last five minutes">
    {#each bars as v, i (i)}
      <span style={`height:${(v / top) * 100}%`}></span>
    {/each}
  </div>

  {#if rows.length > 0 || fleetRows.length > 0}
    <ul class="al-rows">
      {#each rows as row (row.host)}
        <li>
          <span class="al-name">{row.label}</span>
          <span class="al-num">{liveSaid((row.totals.tokens / WINDOW) * MINUTE)}</span>
          <span class="al-dim">{row.totals.usd > 0 ? money(row.totals.usd) : "unpriced"} over five</span>
        </li>
      {/each}
      {#each fleetRows as row (row.host)}
        <li class:stale={row.age > STALE_AFTER}>
          <span class="al-name">{row.host}</span>
          <span class="al-num">{liveSaid(row.tokens)}</span>
          <span class="al-dim">
            {row.usd > 0 ? money(row.usd) : "unpriced"}/min
            {#if row.cards > 0}· {row.cards} card{row.cards === 1 ? "" : "s"}{/if}
            {#if row.age > STALE_AFTER}· {Math.round(row.age / 1000)}s old{/if}
          </span>
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
  .al-rows li.stale .al-name,
  .al-rows li.stale .al-num {
    color: var(--paper-faint);
  }
  .al-stale {
    margin-left: 6px;
    color: var(--paper-faint);
  }
</style>
