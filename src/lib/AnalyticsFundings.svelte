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
 * percentage cells are drawn only when the total *is* one account.
 *
 * **A cell with nothing to say says nothing.** A funding with no window, a plan
 * whose samples did not cover the day, a total that is two accounts' points
 * added as though they were one currency: all of them are an empty cell, never
 * a dash and never a word. The reason is on the hover, where somebody who is
 * asking the question reaches it, and where it does not read as a reading.
 * A zero is still drawn where a zero is real; `$0.00` with tokens behind it is
 * "unpriced" for the same reason (§9.1).
 *
 * Pure drawing: the fold is `fundings.ts`, the read is the shell's.
 */

import { count, money } from "./usage";
import {
  fundingSaid,
  type Exchange,
  type FundingMix,
  type FundingReading,
} from "./fundings";

let {
  readings,
  exchange,
  mix,
}: {
  /** `null` is a read that failed; `[]` is a day with nothing settled in it. */
  readings: readonly FundingReading[] | null;
  /** Dollars at api rates per allowance point, per account and kind. Empty
   *  when the attribution could not be computed; a rate is never invented. */
  exchange: readonly Exchange[];
  /** The day's tokens by class, per funding label (§21.1). `null` is a failed
   *  read, which the panel says rather than drawing four empty rows. */
  mix: readonly FundingMix[] | null;
} = $props();

/** The funding whose breakdown is pinned open. A hover shows it; a click or a
 *  keyboard's Enter keeps it up, which is what makes the trace reachable
 *  without a pointer. */
let opened = $state<string | null>(null);

/** What a cell's hover says about one class: the count, what it cost, and the
 *  effective rate, which is an average across the models the day used. */
function classSaid(tokens: number, usd: number): string {
  const rate = tokens > 0 ? `$${((usd / tokens) * 1e6).toFixed(2)}/M` : "";
  /* Nothing priced is nothing said, not a dash: the count is the reading and
     the money is simply not available for that class. */
  return [`${count(tokens)}`, usd > 0 ? money(usd) : "", rate].filter((p) => p !== "").join(" · ");
}

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

/** A label's breakdown, or null where the read failed or the funding's facts
 *  are not in the day the money is counted on (a card whose turn settled after
 *  midnight, a plan whose work happened elsewhere). */
function mixOfLabel(all: readonly FundingMix[] | null, label: string): FundingMix | null {
  return all?.find((m) => m.label === label) ?? null;
}

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
            {@const one = mixOfLabel(mix, r.label)}
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
              <!-- **15M of what.** A raw total is mostly cache reads, and the
                   same count can be a dollar or hundreds; the trace is one
                   hover away rather than four columns wider, and it works from
                   the keyboard because the cell takes focus. -->
              <td class="af-num">
                <!-- A button rather than a span: it reveals something, it takes
                     focus, and it can be pinned open with the same gesture a
                     keyboard uses. -->
                <button
                  type="button"
                  class="af-mix"
                  aria-expanded={opened === r.label}
                  aria-describedby={one ? `af-tip-${r.label}` : undefined}
                  onclick={() => (opened = opened === r.label ? null : r.label)}
                  onblur={() => (opened === r.label ? (opened = null) : undefined)}
                >
                  {count(r.tokens)}
                  {#if one}
                    <span class="af-tip" role="tooltip" id={`af-tip-${r.label}`}>
                      <span class="af-tip-head">tokens today, priced as the day ran</span>
                      <span class="af-tip-row"
                        ><span>input</span><span>{classSaid(one.input.tokens, one.input.usd)}</span></span
                      >
                      <span class="af-tip-row"
                        ><span>output</span><span>{classSaid(one.output.tokens, one.output.usd)}</span></span
                      >
                      <span class="af-tip-row"
                        ><span>cache read</span><span>{classSaid(one.cacheRead.tokens, one.cacheRead.usd)}</span
                        ></span
                      >
                      <span class="af-tip-row"
                        ><span>cache write</span><span
                          >{classSaid(one.cacheWrite.tokens, one.cacheWrite.usd)}</span
                        ></span
                      >
                      <!-- The trace's own total, so the four rows add up on the
                           face. It is the fine tier's reading of the same day
                           and can differ from the cell's figure, which is the
                           settlement table's; a difference is a turn no
                           transcript was read for, not a rounding. -->
                      <span class="af-tip-row af-tip-total"
                        ><span>all four</span><span>{classSaid(one.tokens, one.usd)}</span></span
                      >
                      <span class="af-tip-foot">
                        {count(one.weight)} input-token equivalents
                        {#if one.unpriced > 0}· {count(one.unpriced)} unpriced{/if}
                      </span>
                    </span>
                  {/if}
                </button>
              </td>
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
                {#if plans === 1}
                  {@const only = readings.find((r) => r.kind === "plan")!}
                  {@const w = windowOf(only, "session")}
                  {#if w}<span class="af-pct">{Math.round(w.points)}%</span>{/if}
                {/if}
              </td>
              <td class="af-num" title={totalSay}>
                {#if plans === 1}
                  {@const only = readings.find((r) => r.kind === "plan")!}
                  {@const w = windowOf(only, "weekly_all")}
                  {#if w}<span class="af-pct">{Math.round(w.points)}%</span>{/if}
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
  /* **Not a scroller, and that is deliberate.** `overflow-x: auto` computes its
     other axis to `auto` too, so a scroller here would clip the token panel
     that hangs under the cell. The table has five short columns and fits; a
     room dragged narrower compresses it rather than hiding the trace. */
  .af-wrap {
    overflow: visible;
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

  /* The tokens cell and its trace (§21.1). The button is the cell's own
     reading, drawn as text: it is interactive only because it reveals
     something, so it carries no chrome until it is hovered or focused. */
  .af-mix {
    position: relative;
    display: inline-block;
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: inherit;
    cursor: help;
    border-bottom: 1px dotted var(--edge);
  }
  .af-mix:hover,
  .af-mix:focus-visible {
    color: var(--paper);
    border-bottom-color: var(--paper-mute);
    outline: none;
  }
  .af-tip {
    display: none;
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    z-index: 20;
    width: max-content;
    min-width: 250px;
    padding: 9px 11px 8px;
    text-align: left;
    background: var(--raised);
    border: 1px solid var(--edge);
    border-radius: 7px;
    box-shadow: 0 12px 28px rgb(0 0 0 / 42%);
    color: var(--paper-dim);
    font-size: 11px;
    line-height: 1.6;
    white-space: nowrap;
  }
  .af-mix:hover .af-tip,
  .af-mix:focus-visible .af-tip,
  .af-mix[aria-expanded="true"] .af-tip {
    display: block;
  }
  .af-tip-head {
    display: block;
    margin-bottom: 4px;
    color: var(--paper-mute);
    font-size: 10px;
    letter-spacing: 0.03em;
  }
  .af-tip-row {
    display: flex;
    justify-content: space-between;
    gap: 18px;
    font-variant-numeric: tabular-nums;
  }
  .af-tip-row > span:first-child {
    color: var(--paper-mute);
  }
  .af-tip-total {
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid var(--edge);
    color: var(--paper);
  }
  .af-tip-foot {
    display: block;
    margin-top: 3px;
    color: var(--paper-mute);
  }
  .af-money {
    color: var(--paper);
  }
  .af-pct {
    color: var(--paper);
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
