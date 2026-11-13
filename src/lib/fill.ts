/* How fast a five-hour window is consumed, and whether that is changing (§14.6).
 *
 * **The question is a rate, not a level.** A window at 60% halfway through its
 * own five hours is not the same week as one at 60% after forty minutes, and
 * the five-hour gauge cannot tell those apart: it resets four times a day and
 * always reads something. What has no such ceiling is *how long the window
 * takes to be used up*, which is one number per window and comparable across
 * months. If that number falls, either the allowance got smaller or the work
 * got heavier, and both are worth noticing before the wall starts getting cut
 * off mid-turn.
 *
 * **The unit is hours to consume a whole window.** A window used at a steady
 * rate that would spend it in six hours reads `6h`, and that is the useful
 * direction: it says this person does not fill five-hour windows on an ordinary
 * day. On a heavy one the same figure reads `1h 20m`, which says a window is
 * not a limit they run into so much as a clock they reset.
 *
 * Every fill is a *fraction of the window's own level against its own opening*,
 * so it is comparable between a window watched from its first minute and one
 * the wall joined at 70%: the percentage is cumulative from the opening, and
 * nothing here needs the early samples. The one thing late sampling costs is
 * the exact moment a window crossed 100 — that is read off the samples, so a
 * window already full when the wall first looked is timed at that first look.
 *
 * Pure, and directly tested. The samples come from `allowancesamples.ts`, which
 * has already folded the wire's dips into a high-water mark.
 */

import type { WindowInstance } from "./allowancesamples";

export const HOUR_MS = 3_600_000;

/** The five-hour window's length. The window's reset is its close, so this is
 *  also how its opening is found. */
export const SESSION_MS = 5 * HOUR_MS;

/** The kind the samples carry for it: `limits[]`'s word, which `observed`
 *  normalises the stream's `five_hour` onto. */
export const SESSION_KIND = "session";

/** One window's fill. */
export type Fill = {
  account: string;
  /** When the window closed, epoch ms. Identifies the instance. */
  resetsAt: number;
  /** When it opened, by its own clock. */
  opened: number;
  /** The highest reading the window was seen at, 0–100+. */
  used: number;
  /** How far into the window the last sample was taken. */
  into: number;
  /** Hours to consume a whole window at this instance's average rate, or null
   *  where the window moved nothing or the samples predate its opening. */
  hours: number | null;
  /** Whether it actually reached 100 inside itself. */
  filled: boolean;
  /** When it crossed 100, where the samples show it. */
  crossedAt: number | null;
  /** Whether the window had closed by the moment asked about. A trend is made
   *  of closed windows only; the open one is a projection and moves. */
  closed: boolean;
};

/** Every five-hour window the samples describe, oldest first.
 *
 *  A window is identified by its reset, which is what `instancesOf` already
 *  grouped on, so a roll is a new fill and a wobble inside one is not. */
export function fillsOf(instances: readonly WindowInstance[], now: number): Fill[] {
  const out: Fill[] = [];
  for (const one of instances) {
    if (one.kind !== SESSION_KIND || one.resetsAt === null) continue;
    const resetsAt = one.resetsAt;
    const opened = resetsAt - SESSION_MS;
    const to = Math.min(one.to, resetsAt);
    const into = to - opened;
    /* The samples show the crossing to the resolution they were taken at; a
       reading at or past 100 is the window being full, whatever a wobble said
       a moment before it. */
    const crossedAt = one.points.find((p) => p.at <= resetsAt && p.used >= 100)?.at ?? null;
    let hours: number | null = null;
    if (crossedAt !== null) {
      hours = Math.max(0, crossedAt - opened) / HOUR_MS;
    } else if (one.last > 0 && into > 0) {
      /* The level is cumulative from the opening, so this needs no first
         sample: at 77% six hours into a window, a whole window takes 7.8. */
      hours = (into * 100) / one.last / HOUR_MS;
    }
    out.push({
      account: one.account,
      resetsAt,
      opened,
      used: one.last,
      into,
      hours,
      filled: crossedAt !== null,
      crossedAt,
      closed: resetsAt <= now,
    });
  }
  return out.sort((a, b) => a.resetsAt - b.resetsAt || a.account.localeCompare(b.account));
}

/* ── the trend ───────────────────────────────────────────────────────────── */

/** What "recent" and "the week before" mean for the comparison. A day is four
 *  or five windows on a busy wall, which is enough to speak about; the
 *  fortnight behind it is the more stable reading of what normal was. */
export const RECENT_MS = 24 * HOUR_MS;
export const BEFORE_MS = 7 * 24 * HOUR_MS;

/** How many windows each side needs before a comparison is made. One mad
 *  afternoon is an anecdote, and a warning off it is the sort of alarm that
 *  teaches people to ignore alarms. */
export const MIN_FILLS = 3;

/** How much of a window must have been watched before an unfinished one's
 *  extrapolation is worth comparing. **Half an hour, chosen against what the
 *  arithmetic is**: a window seen for five minutes at 2% projects a fill from
 *  the noise in two readings, and a median that let those in would move on a
 *  wall's start-up rather than on a person's day. A window that actually filled
 *  needs no floor — its crossing is a fact. */
export const MIN_INTO_MS = 30 * 60_000;

/** How much faster is worth saying, as a ratio of the two medians. Fifteen
 *  percent is above what a different mix of workdays does to one day's windows
 *  and below what a real change in the allowance would be; the symmetric upper
 *  bound exists so "slower" is not a verdict nobody ever sees. */
export const FASTER = 0.85;
export const SLOWER = 1.15;

export type FillTrend = {
  /** The median hours of the recent windows, and of the ones before them. */
  recent: number | null;
  before: number | null;
  /** recent / before. Below 1 is filling faster. Null where there is not
   *  enough on one side to compare. */
  ratio: number | null;
  counts: { recent: number; before: number };
  verdict: "faster" | "steady" | "slower" | "unknown";
};

/** Whether a fill is one a trend or a sparkline can compare: closed, moved,
 *  and either filled or watched long enough for its projection to mean
 *  something. */
export function trendable(f: Fill): boolean {
  return f.closed && f.hours !== null && f.hours > 0 && (f.filled || f.into >= MIN_INTO_MS);
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** One account's fill trend, or the wall's when `fills` is a mixed list.
 *
 *  **Closed windows only.** An open window's `hours` is a projection that
 *  moves every time a turn lands, and a median full of those would be a
 *  reading of how busy the last minute was. The open one belongs on the face
 *  as the current reading, not in the comparison. */
export function fillTrend(
  fills: readonly Fill[],
  now: number,
  recentMs = RECENT_MS,
  beforeMs = BEFORE_MS,
): FillTrend {
  const done = fills.filter(trendable);
  const recent = done.filter((f) => f.resetsAt > now - recentMs).map((f) => f.hours!);
  const before = done
    .filter((f) => f.resetsAt <= now - recentMs && f.resetsAt > now - recentMs - beforeMs)
    .map((f) => f.hours!);
  const a = median(recent);
  const b = median(before);
  const ratio = recent.length >= MIN_FILLS && before.length >= MIN_FILLS && a !== null && b !== null && b > 0 ? a / b : null;
  return {
    recent: a,
    before: b,
    ratio,
    counts: { recent: recent.length, before: before.length },
    verdict: ratio === null ? "unknown" : ratio <= FASTER ? "faster" : ratio >= SLOWER ? "slower" : "steady",
  };
}

/** The same, per account, in the registry's order. */
export function fillTrends(
  fills: readonly Fill[],
  accounts: readonly string[],
  now: number,
): Map<string, FillTrend> {
  const out = new Map<string, FillTrend>();
  for (const account of accounts) {
    out.set(account, fillTrend(fills.filter((f) => f.account === account), now));
  }
  return out;
}

/* ── saying it ───────────────────────────────────────────────────────────── */

/** `1h 20m`, the same shape the rest of the wall uses for a span under a day. */
export function fillSaid(hours: number): string {
  const mins = Math.max(0, Math.round(hours * 60));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${String(m).padStart(2, "0")}m`;
}

/** The line under an account's windows. **It says the window, not a number on
 *  its own**: "fills in 1h 20m" is a reading about a daily rhythm, and a bare
 *  duration beside a percentage invites being read as a countdown. */
export function fillSaidLine(fill: Fill): string {
  if (fill.hours === null) return "no movement yet";
  return fill.filled ? `fills in ${fillSaid(fill.hours)}` : `fills in ${fillSaid(fill.hours)} at this rate`;
}

/** The trend in words, for a tooltip or a line: what it is now, what it was,
 *  and how much faster. Null where there is not enough history to compare. */
export function trendSaid(trend: FillTrend): string | null {
  if (trend.recent === null || trend.before === null) return null;
  const change = Math.round(Math.abs(1 - trend.recent / trend.before) * 100);
  /* "Lately", not "now": the median is of the last day's windows, and a closed
     window three hours old is not a reading of this minute. */
  if (trend.verdict === "faster") return `${fillSaid(trend.recent)} lately, against ${fillSaid(trend.before)} the week before (${change}% faster)`;
  if (trend.verdict === "slower") return `${fillSaid(trend.recent)} lately, against ${fillSaid(trend.before)} the week before (${change}% slower)`;
  return `${fillSaid(trend.recent)} lately, against ${fillSaid(trend.before)} the week before`;
}

/** The compact half, for a line that has no room for both readings. Null
 *  where there is not enough history to compare. */
export function fillShort(trend: FillTrend): string | null {
  if (trend.verdict === "unknown" || trend.recent === null || trend.before === null) return null;
  const change = Math.round(Math.abs(1 - trend.recent / trend.before) * 100);
  if (trend.verdict === "faster") return `${change}% faster than the week before`;
  if (trend.verdict === "slower") return `${change}% slower than the week before`;
  return "steady against the week before";
}

/** The warning, where the trend is faster. **Names both causes and blames
 *  neither**: the reading cannot tell a smaller allowance from heavier work,
 *  and a sentence that chose one would be wrong about the other every time it
 *  mattered. */
export function fillWarning(account: string, trend: FillTrend): string | null {
  if (trend.verdict !== "faster" || trend.recent === null || trend.before === null) return null;
  const change = Math.round((1 - trend.recent / trend.before) * 100);
  return (
    `${account}: the 5-hour window is filling in ${fillSaid(trend.recent)}, against ` +
    `${fillSaid(trend.before)} the week before, ${change}% faster. either the allowance got ` +
    `smaller or the work got heavier.`
  );
}
