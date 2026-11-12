<script lang="ts">
/* Today, split by who paid, and read in every currency it has (§21).
 *
 * The user's sentence, made a table: "158% of the 5-hour allowance of the
 * subscription + 40 anthropic api credits + 50 deepseek credits". One row per
 * funding, one column per unit, and the exchange printed under the percentages
 * so a percentage and a dollar are visibly the same spend seen twice.
 *
 * **A percentage is per account and per window kind and is never totalled
 * across either.** The total row carries money and tokens, which do add; its
 * percentage cells say "not summed" unless there is exactly one plan account,
 * where the total *is* that account.
 *
 * A cell that cannot be read says why in words, never a zero: "no window" for a
 * funding that has none, "not read" for a plan whose samples did not cover the
 * day. `$0.00` with tokens behind it is "unpriced" for the same reason (§9.1).
 *
 * Pure drawing: the fold is `fundings.ts`, the read is the shell's.
 */

import { count, money } from "./usage";
import { fundingSaid, type Exchange, type FundingReading } from "./fundings";

let {
  readings,
  exchange,
}: {
  /** `null` is a read that failed; `[]` is a day with nothing settled in it. */
  readings: readonly FundingReading[] | null;
  /** Dollars at api rates per allowance point, per account and kind. Empty
   *  when the attribution could not be computed; a rate is never invented. */
  exchange: readonly Exchange[];
} = $props();

const total = $derived.by(() => {
  const rows = readings ?? [];
  let usd = 0;
  let tokens = 0;
  let turns = 0;
  for (const r of rows) {
    usd += r.usd;
    tokens += r.tokens;
    turns += r.turns;
  }
  return { usd, tokens, turns };
});

/** How many subscription accounts are in the day. The total row may carry
 *  percentages only when it is one, because one account's percentage is the
 *  day's and two accounts' are two different currencies. */
const plans = $derived((readings ?? []).filter((r) => r.kind === "plan").length);

/** What the total row's percentage cells mean. Three cases, and the third was
 *  missing: a day funded entirely by credits and providers has no account whose
 *  points a total could be, so "not summed" would be claiming a sum was
 *  declined when there was nothing to sum. */
const totalSay = $derived(
  plans === 0
    ? "no subscription account has a window today, so there is no percentage to read beside the money"
    : plans === 1
      ? "one subscription, so the day's percentage is that account's"
      : "not summed: two accounts' points are not the same currency",
);

function windowOf(r: FundingReading, kind: string): { kind: string; points: number } | null {
  return r.windows.find((w) => w.kind === kind) ?? null;
}

function rateOf(account: string, kind: string): number | null {
  /* The block draws only the unscoped five-hour and weekly windows, so the
     scope is part of the lookup rather than something to ignore: a scoped
     window's rate is a different currency and must not be quoted here. */
  const one = exchange.find((e) => e.account === account && e.kind === kind && e.scope === "");
  return one && one.usdPerPoint > 0 ? one.usdPerPoint : null;
}

const sessionLabel = "5-hour";
const weekLabel = "weekly";

/** A funding whose dollars are zero while its tokens are not has a model the
 *  price table could not place. `$0.00` there would read as free, which is the
 *  one thing a money column must never say (§9.1). */
function unpriced(r: FundingReading): boolean {
  return r.usd <= 0 && r.tokens > 0;
}

/** A rate is a small number and `money` rounds it into nothing: one percent of
 *  a five-hour window is often a fraction of a cent, and `$0.00` under a
 *  percentage reads as "free" rather than "cheap". */
function rateSaid(usd: number): string {
  if (usd >= 0.01) return money(usd);
  return `$${usd.toFixed(4)}`;
}

</script>

<section class="af" aria-label="the day on this wall, by funding">
  <header class="af-head">
    <h3 class="af-title">the day on this wall, by funding</h3>
    <span class="af-sub">
      the title bar's figure, split · windows are the account's, so they count
      work anywhere
    </span>
  </header>

  {#if readings === null}
    <p class="af-empty">the funding breakdown could not be read</p>
  {:else if readings.length === 0}
    <p class="af-empty">nothing has settled today yet</p>
  {:else}
    <div class="af-wrap">
      <table class="af-table">
        <thead>
          <tr>
            <th scope="col">funding</th>
            <th scope="col" class="af-num">api credits</th>
            <th scope="col" class="af-num">tokens</th>
            <th scope="col" class="af-num">{sessionLabel}</th>
            <th scope="col" class="af-num">{weekLabel}</th>
          </tr>
        </thead>
        <tbody>
          {#each readings as r (r.label)}
            {@const session = windowOf(r, "session")}
            {@const week = windowOf(r, "weekly_all")}
            {@const sessionRate = rateOf(r.label, "session")}
            {@const weekRate = rateOf(r.label, "weekly_all")}
            <tr>
              <th scope="row" class="af-name">
                <span class="af-label">{fundingSaid(r.label, r.kind)}</span>
                <span class="af-kind">
                  {#if r.kind === "plan"}subscription · {/if}{r.turns} turn{r.turns === 1 ? "" : "s"}
                </span>
              </th>
              <td
                class="af-num af-money"
                title={unpriced(r) ? "tokens the price table could not place" : undefined}
              >
                {unpriced(r) ? "unpriced" : money(r.usd)}
              </td>
              <td class="af-num">{count(r.tokens)}</td>
              <td
                class="af-num"
                title={r.kind === "plan"
                  ? session
                    ? `${Math.round(session.points)}% of the 5-hour allowance today${
                        sessionRate
                          ? ` · 1% ≈ ${rateSaid(sessionRate)} of modeled work, measured over the last eight days`
                          : ""
                      }`
                    : "no five-hour sample covered today"
                  : "this funding has no allowance window"}
              >
                {#if r.kind === "plan" && session}
                  <span class="af-pct">{Math.round(session.points)}%</span>
                {:else}
                  <span class="af-none">{r.kind === "plan" ? "not read" : "no window"}</span>
                {/if}
              </td>
              <td
                class="af-num"
                title={r.kind === "plan"
                  ? week
                    ? `${Math.round(week.points)}% of the weekly allowance today${
                        weekRate
                          ? ` · 1% ≈ ${rateSaid(weekRate)} of modeled work, measured over the last eight days`
                          : ""
                      }`
                    : "no weekly sample covered today"
                  : "this funding has no allowance window"}
              >
                {#if r.kind === "plan" && week}
                  <span class="af-pct">{Math.round(week.points)}%</span>
                {:else}
                  <span class="af-none">{r.kind === "plan" ? "not read" : "no window"}</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
        {#if readings.length > 1}
          <tfoot>
            <tr>
              <th scope="row" class="af-name">
                <span class="af-label">total</span>
                <span class="af-kind">{total.turns} turns</span>
              </th>
              <td class="af-num af-money">
                {total.usd <= 0 && total.tokens > 0 ? "unpriced" : money(total.usd)}
              </td>
              <td class="af-num">{count(total.tokens)}</td>
              <td class="af-num" title={totalSay}>
                {#if plans === 0}
                  <span class="af-none">no window</span>
                {:else if plans === 1}
                  {@const only = readings.find((r) => r.kind === "plan")!}
                  {@const w = windowOf(only, "session")}
                  <span class="af-pct">{w ? `${Math.round(w.points)}%` : "not read"}</span>
                {:else}
                  <span class="af-none">not summed</span>
                {/if}
              </td>
              <td class="af-num" title={totalSay}>
                {#if plans === 0}
                  <span class="af-none">no window</span>
                {:else if plans === 1}
                  {@const only = readings.find((r) => r.kind === "plan")!}
                  {@const w = windowOf(only, "weekly_all")}
                  <span class="af-pct">{w ? `${Math.round(w.points)}%` : "not read"}</span>
                {:else}
                  <span class="af-none">not summed</span>
                {/if}
              </td>
            </tr>
          </tfoot>
        {/if}
      </table>
    </div>
    <p class="af-foot">
      {#if plans > 0}
        a percentage is how much of that account's window today has moved. it
        can pass 100%: five hours refill several times a day, so 158% is 1.58
        windows' worth. hover a percentage for what one point costs at api rates,
        measured over the last eight days.
      {:else}
        no subscription account has a window today, so there is no percentage to
        read beside the money.
      {/if}
    </p>
  {/if}
</section>

<style>
  .af {
    border: 1px solid var(--edge);
    border-radius: 8px;
    background: var(--surface);
    padding: 10px 12px 8px;
    container-type: inline-size;
  }
  .af-head {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-bottom: 6px;
  }
  .af-title {
    margin: 0;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.04em;
    color: var(--paper);
    text-transform: lowercase;
  }
  .af-sub {
    font-size: 10.5px;
    color: var(--paper-mute);
  }
  .af-empty {
    margin: 6px 0 2px;
    font-size: 11.5px;
    color: var(--paper-mute);
  }
  .af-wrap {
    overflow-x: auto;
  }
  .af-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
  }
  .af-table th,
  .af-table td {
    text-align: left;
    padding: 4px 8px 4px 0;
    border-bottom: 1px solid var(--edge);
    vertical-align: baseline;
  }
  .af-table thead th {
    font-size: 10px;
    font-weight: 500;
    color: var(--paper-mute);
    letter-spacing: 0.03em;
    padding-bottom: 3px;
  }
  .af-table tbody tr:last-child th,
  .af-table tbody tr:last-child td {
    border-bottom: 0;
  }
  .af-table tfoot th,
  .af-table tfoot td {
    border-top: 1px solid var(--edge);
    border-bottom: 0;
    padding-top: 6px;
    color: var(--paper);
    font-weight: 500;
  }
  .af-name {
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-weight: 400;
  }
  .af-label {
    color: var(--paper);
  }
  .af-kind {
    font-size: 10px;
    color: var(--paper-mute);
  }
  .af-num {
    text-align: right !important;
    white-space: nowrap;
  }
  .af-money {
    color: var(--paper);
  }
  .af-pct {
    color: var(--paper);
  }
  .af-none {
    font-size: 10px;
    color: var(--paper-mute);
  }
  .af-foot {
    margin: 7px 0 0;
    font-size: 10.5px;
    line-height: 1.45;
    color: var(--paper-mute);
  }

  /* Narrow: the table keeps its shape, and the tokens column is the one to go,
     because dollars and percentages are the two the block exists for. */
  @container (max-width: 380px) {
    .af-table th:nth-child(3),
    .af-table td:nth-child(3) {
      display: none;
    }
  }
</style>
