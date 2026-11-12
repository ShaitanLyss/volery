/* The live strip (§11.1): five readings, one row, at the top of the room.
 *
 * Each is a value, a delta or a comparison, and a sparkline where the data
 * exists. **A tile that cannot be measured says so.** It never shows zero for
 * *unknown*, which is the rule the whole surface is written to (§9.1) and the
 * one a strip of five numbers is most likely to break.
 *
 * What each tile is made of, and where it comes from:
 *
 * - the binding window: allowance samples (§3.3), which the wall notes off the
 *   poll and off a card's own stream. The fullest instance that has not reset,
 *   across every account.
 * - today against yesterday: the spend window's own fact buckets, priced the
 *   way every other dollar on the surface is priced.
 * - the fleet burn and the fleet's cards: the flyway's readings, passed in by
 *   the shell, which is where the ledger and the roster already are.
 * - unattributed points: the delta the account moved minus what its own facts
 *   explain (§5.3), over the last week.
 *
 * Pure and directly tested.
 */

import {
  allowanceResidual,
  bindingOf,
  daySpend,
  type AllowanceResidual,
  type AllowanceSample,
  type CostBucket,
  type WindowInstance,
} from "./allowancesamples";
import { said as windowSaid, until, type Window } from "./limits";
import { sayParts, sayRate as rateSaid } from "./rate";
import { count, dayStart, money } from "./usage";
import { shareSaid } from "./analyticsbehaviour";
import { FINE_BUCKET_MS } from "./allowancesamples";


/** The flyway's own readings, handed in by the shell. `cards` is every wall's
 *  working cards and `local` is this machine's share of them. */
export type FleetReading = {
  rate: number;
  parts: { host: string | null; rate: number }[];
  silent: string[];
  cards: number;
  local: number;
  /** Whether **this** wall's burn rate is being read at all. The ledger only
   *  walks transcripts while something is watching it; a tile showing 0 for a
   *  rate nobody computed is the measured-zero-for-unknown this surface is
   *  written not to draw. */
  measured: boolean;
};

export type StripTile = {
  key: "allowance" | "today" | "burn" | "cards" | "unattributed";
  label: string;
  value: string;
  note: string;
  /** The hover: the same reading in more words. */
  title?: string;
  /** Cannot be measured, and the value says why rather than showing a zero. */
  off: boolean;
  /** The sparkline, oldest to newest. Absent where there is no history to
   *  draw, which is not the same as a flat line. */
  points?: number[];
};

/** The week's residual, or why there is none. */
export type WeekResidual =
  | { state: "read"; residual: AllowanceResidual }
  | { state: "none" }
  | { state: "why"; why: string };

export const WEEK_MS = 7 * 86_400_000;

/** Fold the week's unattributed points once.
 *
 *  **The expensive half is separated from the drawing on purpose.** The shell
 *  folds this on a minute and hands the answer in, because the strip re-renders
 *  every second so its countdown moves and this loop is over the week's spans
 *  times the week's cost buckets — a cost proportional to the data rather than
 *  to the reading. */
export function weekResidual(
  samples: readonly AllowanceSample[] | null,
  instances: readonly WindowInstance[],
  costs: readonly CostBucket[] | null,
  now: number,
): WeekResidual {
  if (samples === null) return { state: "why", why: "the allowance samples could not be read" };
  if (costs === null) return { state: "why", why: "the cost facts could not be read" };
  const from = now - WEEK_MS;
  /* An instance that ended before the week holds no delta inside it; one that
     straddles the edge is kept whole, because its samples are what the first
     span is measured from. */
  const recent = instances.filter((i) => i.to >= from);
  /* **The week's own window, and only it.** The five-hour and the weekly are
     different currencies (§5.5); summing them would give a number in no unit
     at all, and `residualOf` itself says to call it once per kind. */
  const weekly = recent.filter((i) => i.kind === "weekly_all");
  if (weekly.length === 0) return { state: "none" };
  /* A bucket that begins before the first sample can still overlap the first
     span, and `spansOf` would cut it by its width — so the left edge is one
     bucket wider than the window, not the window itself. */
  const firstAt = Math.min(...weekly.map((i) => i.from));
  const overlapping = costs.filter((b) => b.at + FINE_BUCKET_MS > firstAt);
  return { state: "read", residual: allowanceResidual(weekly, overlapping, "weekly_all") };
}

export type StripInput = {
  /** `null` is a read that failed; `[]` is a wall that has taken no sample. */
  samples: readonly AllowanceSample[] | null;
  /** The samples folded into their window instances, done once by the shell. */
  instances: readonly WindowInstance[];
  /** The fine-tier cost buckets today is priced from, or `null` when that read
   *  failed. */
  costs: readonly CostBucket[] | null;
  /** The week's residual, folded on a minute by the shell. */
  week: WeekResidual;
  /** The first instant the reads reach, which says whether "yesterday" is a
   *  whole day rather than part of one. */
  coveredFrom: number;
  now: number;
  /** The flyway's readings, or null where this surface was opened with no
   *  link to the roster (the browser preview). */
  fleet: FleetReading | null;
};

function instanceWindow(one: WindowInstance): Window {
  return {
    kind: one.kind,
    group: one.kind === "session" ? "session" : "weekly",
    used: one.last,
    severity: "normal",
    resetsAt: one.resetsAt,
    scope: one.scope || null,
    active: false,
  };
}

export function stripModel(input: StripInput): StripTile[] {
  const { samples, instances, costs, week, coveredFrom, now, fleet } = input;
  const buckets = costs ?? [];
  return [
    allowanceTile(samples, instances, now),
    todayTile(costs, buckets, coveredFrom, now),
    ...fleetTiles(fleet),
    unattributedTile(week),
  ];
}

function allowanceTile(
  samples: readonly AllowanceSample[] | null,
  instances: readonly WindowInstance[],
  now: number,
): StripTile {
  if (samples === null) {
    return {
      key: "allowance",
      label: "binding window",
      value: "not read",
      note: "the allowance samples could not be read",
      off: true,
    };
  }
  const binding = bindingOf(instances, now);
  if (!binding) {
    return {
      key: "allowance",
      label: "binding window",
      value: "no sample yet",
      note: "the allowance poll has not answered yet",
      off: true,
    };
  }
  const w = windowSaid(instanceWindow(binding));
  const reset = binding.resetsAt === null ? "no reset named" : `resets in ${until(binding.resetsAt - now)}`;
  const moved = Math.max(0, binding.last - binding.first);
  return {
    key: "allowance",
    label: "binding window",
    value: `${Math.floor(binding.last)}%`,
    note: `${w} · ${binding.account} · ${reset}`,
    title:
      `${w} on ${binding.account}: ${binding.last}% used, ${reset}` +
      (moved > 0 ? ` · moved ${Math.round(moved)} points while it was watched` : ""),
    off: false,
    points: binding.points.map((p) => p.used),
  };
}

function todayTile(
  costs: readonly CostBucket[] | null,
  buckets: readonly CostBucket[],
  coveredFrom: number,
  now: number,
): StripTile {
  if (costs === null) {
    return {
      key: "today",
      label: "today",
      value: "not read",
      note: "the cost facts could not be read",
      off: true,
    };
  }
  /* **Yesterday's midnight is `dayStart(today's midnight - 1)`, not
     `today - 24h`.** A DST day is 23 or 25 hours long, and a fixed 24 would
     put an hour of the wrong day into the figure twice a year. */
  const todayFrom = dayStart(now);
  const yesterdayFrom = dayStart(todayFrom - 1);
  const { today, yesterday } = daySpend(buckets, now, todayFrom, yesterdayFrom, coveredFrom);
  /* Yesterday and today on one axis, so the shape is a comparison rather than
     a curve with no scale. */
  const hours = Math.min(49, Math.max(1, Math.ceil((now - yesterdayFrom) / 3_600_000)));
  const points = hourlyCost(buckets, yesterdayFrom, hours);
  return {
    key: "today",
    label: "today",
    value: money(today),
    note:
      yesterday === null
        ? "yesterday is before this window"
        : `so far · ${money(yesterday)} yesterday`,
    title: "modeled cost over the local day, against the whole of yesterday",
    off: false,
    points: points.some((p) => p > 0) ? points : undefined,
  };
}

function hourlyCost(buckets: readonly CostBucket[], from: number, hours: number): number[] {
  const out = Array.from({ length: hours }, () => 0);
  for (const b of buckets) {
    const slot = Math.floor((b.at - from) / 3_600_000);
    if (slot >= 0 && slot < hours) out[slot] += b.cost;
  }
  return out;
}

function fleetTiles(fleet: FleetReading | null): StripTile[] {
  if (!fleet) {
    return [
      { key: "burn", label: "fleet burn", value: "not read", note: "no flyway reading here", off: true },
      { key: "cards", label: "cards working", value: "not read", note: "no flyway reading here", off: true },
    ];
  }
  /* Walls the roster has heard from: the ones with a rate, plus the ones that
     said no rate. A silent wall is still a wall, and counting only the
     measured ones would make the cards note say "on this machine" over a
     fleet-wide count. */
  const walls = fleet.parts.length + fleet.silent.length;
  const peers = walls > 1 || fleet.silent.length > 0;
  const burn: StripTile =
    !fleet.measured && !peers
      ? {
          key: "burn",
          label: "fleet burn",
          value: "not read",
          note: "nothing is reading this wall's burn",
          off: true,
        }
      : {
          key: "burn",
          label: "fleet burn",
          value: `${rateSaid(fleet.rate)} tok/min`,
          note: fleet.measured
            ? peers
              ? `across ${count(walls)} walls`
              : "this machine"
            : "this machine is not reading its burn",
          /* A hover that lists "this wall 0 tok/min" for a wall nothing is
             reading would repeat the lie the value just avoided. */
          title: fleet.measured
            ? sayParts({ total: fleet.rate, parts: fleet.parts, silent: fleet.silent }, " tok/min")
            : "this machine's burn is not being read: the ledger has no recent pass",
          off: false,
        };
  return [
    burn,
    {
      key: "cards",
      label: "cards working",
      value: count(fleet.cards),
      note: peers ? `${count(fleet.local)} on this machine` : "on this machine",
      off: false,
    },
  ];
}

function unattributedTile(week: WeekResidual): StripTile {
  if (week.state === "why") {
    return {
      key: "unattributed",
      label: "unattributed",
      value: "not read",
      note: week.why,
      off: true,
    };
  }
  if (week.state === "none") {
    return {
      key: "unattributed",
      label: "unattributed",
      value: "no weekly sample",
      note: "this week was read on the five-hour window only",
      off: true,
    };
  }
  const r = week.residual;
  if (r.delta <= 0) {
    return {
      key: "unattributed",
      label: "unattributed",
      value: "0 pts",
      note: "no allowance moved this week",
      off: false,
    };
  }
  const share = r.residual / r.delta;
  return {
    key: "unattributed",
    label: "unattributed",
    value: `${Math.round(r.residual)} pts`,
    note: `${shareSaid(share)} of ${Math.round(r.delta)} this week${r.coverage === "partial" ? " · partial" : ""}`,
    title:
      `the account moved ${Math.round(r.delta)} points this week; ` +
      `${Math.round(r.attributed)} are explained by requests on this wall` +
      (r.coverage === "partial"
        ? ". a wall sent samples and no facts, so the residual is a floor rather than a whole account"
        : ""),
    off: false,
  };
}
