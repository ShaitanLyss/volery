<script lang="ts">
/* What a point of this account's window is worth, and how steady that is (§22).
 *
 * One line per account under its ceilings: what one percent buys in tokens and
 * in dollars, what a whole window is worth, and whether the rate holds still.
 * Opening it draws the week as a heatmap of dollars per point by hour and
 * weekday, which is the shape Lyss asked about.
 *
 * **Blank cells are the reading that matters most here.** An hour with no
 * trustworthy movement is left empty rather than filled with the period's
 * average, because a heatmap that fills its gaps invents exactly the peak-hour
 * pattern it is being asked to find. `equivalence.ts` has the floors; this
 * component only refuses to draw below them.
 *
 * The heatmap is drawn in ink, not in hue. Magnitude is one hue light to dark,
 * and on this wall that hue is the paper's own: colour is status everywhere
 * else and stays that way.
 */

import { count } from "./usage";
import {
  bandSaid,
  mixSaid,
  smallMoney,
  verdictSaid,
  windowSaid,
  worthSaid,
  type WeekCell,
  type WindowReading,
} from "./equivalence";
  import { tipOf } from "./tipped.svelte";

let {
  label,
  kind,
  reading,
  fault = "",
  spanDays,
  sampled = true,
}: {
  /** The account, for the block's label in a screen reader. */
  label: string;
  /** The window this reading is of, in the words the caps row already uses. */
  kind: string;
  /** `null` is a read that failed; a reading with no hours is one that was
   *  answered and had nothing to measure. */
  reading: WindowReading | null;
  /** Why the read failed, already in words. */
  fault?: string;
  spanDays: number;
  /** Whether any allowance sample of this window exists at all. A wall that has
   *  never polled (or one upgraded into the feature today) has no samples, and
   *  that is not the same reading as a window that did not move: saying "no
   *  hour moved enough" about a window nobody has ever measured sends the
   *  reader looking for a quiet month they may not have had. */
  sampled?: boolean;
} = $props();

let open = $state(false);

const worth = $derived(reading?.worth ?? null);
const cells = $derived(reading?.grid ?? []);
const rated = $derived(cells.filter((c) => c.usdPerPoint !== null));
const lo = $derived(rated.length === 0 ? 0 : Math.min(...rated.map((c) => c.usdPerPoint!)));
const hi = $derived(rated.length === 0 ? 0 : Math.max(...rated.map((c) => c.usdPerPoint!)));

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** Where a cell sits between the cheapest and dearest hour, 0…1. A week where
 *  every hour costs the same reads at the middle rather than at white, which is
 *  the honest drawing of "there is nothing to see here". */
function shade(c: WeekCell): number | null {
  if (c.usdPerPoint === null) return null;
  if (!(hi > lo)) return 0.5;
  return Math.min(1, Math.max(0, (c.usdPerPoint - lo) / (hi - lo)));
}

function cellTitle(c: WeekCell): string {
  const day = DAYS[c.weekday];
  const hour = `${String(c.hour).padStart(2, "0")}:00`;
  if (c.usdPerPoint === null) {
    return `${day} ${hour} · not measured: no hour there moved enough to price a point`;
  }
  return `${day} ${hour} · ${smallMoney(c.usdPerPoint)} per point · ${count(c.points)} points over ${c.weeks} week${c.weeks === 1 ? "" : "s"}`;
}

/** The foot, built as parts and joined, so an empty mix does not leave a
 *  separator with nothing in front of it. */
const foot = $derived.by(() => {
  const parts: string[] = [];
  const mix = mixSaid(worth!);
  if (mix) parts.push(mix);
  const band = bandSaid(worth!);
  if (band) parts.push(band);
  parts.push(`${worth!.hours} hours, ${count(worth!.points)} points`);
  if (worth!.unpricedTokens > 0) {
    parts.push(`${count(worth!.unpricedTokens)} tokens the price table could not place, outside the rate`);
  }
  return parts.join(" · ");
});

const extremes = $derived.by(() => {
  if (rated.length < 2) return "";
  const cheap = rated.reduce((a, b) => (b.usdPerPoint! < a.usdPerPoint! ? b : a));
  const dear = rated.reduce((a, b) => (b.usdPerPoint! > a.usdPerPoint! ? b : a));
  if (cheap.usdPerPoint === dear.usdPerPoint) return "";
  return `cheapest ${DAYS[cheap.weekday]} ${String(cheap.hour).padStart(2, "0")}:00 at ${smallMoney(cheap.usdPerPoint!)} · dearest ${DAYS[dear.weekday]} ${String(dear.hour).padStart(2, "0")}:00 at ${smallMoney(dear.usdPerPoint!)}`;
});
</script>

{#if worth === null}
  <p class="aw-empty">
    {fault ? `the rate could not be read: ${fault}` : "the rate could not be read"}
  </p>
{:else if worth.hours === 0 || worth.usdPerPoint === null}
  <!-- Three different absences, and the first two were being reported as the
       third: no sample has ever been taken, or the window moved through work
       the price table cannot place, is not a window that did not move. -->
  {#if !sampled}
    <p class="aw-empty">
      this wall has not sampled this window yet, so there is nothing to price
    </p>
  {:else if worth.unpricedTokens > 0}
    <p class="aw-empty">
      this window moved, but {count(worth.unpricedTokens)} tokens were on models the
      price table cannot place, so there is no rate to give
    </p>
  {:else}
    <p class="aw-empty">
      no hour in the last {spanDays} days moved enough of this window to price a point
    </p>
  {/if}
{:else}
  <div class="aw">
    <button
      class="aw-line"
      type="button"
      aria-expanded={open}
      onclick={() => (open = !open)}
      {@attach tipOf(() => (`${kind}: ${verdictSaid(reading!.verdict)} · measured over ${worth.hours} hours of the last ${spanDays} days at ${mixSaid(worth) || "a mix this wall recorded"}`))}
    >
      <span class="aw-kind">{kind}</span>
      <span class="aw-main">{worthSaid(worth)}</span>
      <span class="aw-window">{windowSaid(worth)}</span>
      <span class="aw-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
    </button>

    {#if open && cells.length === 168}
      <p class="aw-verdict">{verdictSaid(reading!.verdict)}</p>
      <div class="aw-week">
        <div
          class="aw-grid"
          role="img"
          aria-label={`dollars per point by hour of the week, ${DAYS.join(", ")}. ${extremes || `${rated.length} of 168 hours had enough movement to measure`}`}
        >
          <span class="aw-corner"></span>
          {#each Array(24) as _, h}
            <span class="aw-hh">{h % 6 === 0 ? String(h).padStart(2, "0") : ""}</span>
          {/each}
          {#each DAYS as day, d}
            <span class="aw-dd">{day}</span>
            {#each Array(24) as _, h}
              {@const cell = cells[d * 24 + h]}
              {@const s = shade(cell)}
              <span
                class="aw-cell"
                class:aw-blank={s === null}
                style={s === null ? "" : `--aw-shade: ${(0.1 + s * 0.62).toFixed(3)}`}
                {@attach tipOf(() => (cellTitle(cell)))}
              ></span>
            {/each}
          {/each}
        </div>
        <p class="aw-key">
          darker is dearer per point · blank is an hour with nothing to measure
        </p>
        {#if extremes}<p class="aw-extremes">{extremes}</p>{/if}
      </div>

      <p class="aw-foot">{foot}</p>
    {/if}
  </div>
{/if}

<style>
  .aw {
    margin-top: 6px;
  }
  .aw-empty {
    margin: 6px 0 0;
    font-size: 11px;
    color: var(--paper-mute);
  }
  .aw-line {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
    width: 100%;
    padding: 4px 0;
    background: none;
    border: 0;
    font: inherit;
    color: var(--paper-mute);
    text-align: left;
    cursor: pointer;
  }
  .aw-line:hover .aw-main,
  .aw-line:focus-visible .aw-main {
    color: var(--paper);
  }
  .aw-line:focus-visible {
    outline: 1px solid var(--edge);
    outline-offset: 2px;
    border-radius: 3px;
  }
  .aw-kind {
    font-size: 10px;
    color: var(--paper-mute);
    letter-spacing: 0.03em;
  }
  .aw-main {
    font-size: 11.5px;
    color: var(--paper);
    font-variant-numeric: tabular-nums;
  }
  .aw-window {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .aw-caret {
    margin-left: auto;
    font-size: 13px;
    line-height: 1;
    color: var(--paper-mute);
  }
  .aw-verdict {
    margin: 0 0 2px;
    font-size: 10.5px;
    line-height: 1.45;
    color: var(--paper-mute);
  }
  .aw-week {
    margin: 6px 0 2px;
  }
  .aw-grid {
    display: grid;
    grid-template-columns: 2.2em repeat(24, minmax(0, 1fr));
    gap: 2px;
    align-items: center;
  }
  .aw-corner {
    height: 10px;
  }
  .aw-hh {
    font-size: 8.5px;
    color: var(--paper-mute);
    text-align: left;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  .aw-dd {
    font-size: 9px;
    color: var(--paper-mute);
    line-height: 1;
  }
  .aw-cell {
    display: block;
    aspect-ratio: 1;
    min-height: 7px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--paper) calc(var(--aw-shade, 0.06) * 100%), var(--surface));
  }
  .aw-blank {
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--edge);
  }
  .aw-key,
  .aw-extremes,
  .aw-foot {
    margin: 6px 0 0;
    font-size: 10.5px;
    line-height: 1.45;
    color: var(--paper-mute);
  }
  .aw-foot {
    font-variant-numeric: tabular-nums;
  }
</style>
