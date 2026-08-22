/* How fast this wall is burning tokens — the derivative of what `usage.ts`
 * totals up.
 *
 * The `usage` widget answers "how much has gone"; this one answers "how fast is
 * it going *now*", which is a different question and wants a different
 * instrument. Same source, though: the five-minute buckets `usage.rs` reads out
 * of the transcripts, behind the one shared `Ledger`. Nothing here polls
 * anything — a rate widget is a second reading of numbers the ledger already
 * holds, so a wall with one of these on it costs exactly what a wall with a
 * usage widget costs, and a wall with neither still pays for nothing.
 *
 * Pure — no runes, no DOM, no `invoke` — so all of it has direct Bun tests.
 *
 * ── which unit, and over how long ─────────────────────────────────────────
 *
 * Two separate questions, and the ask ("per minute or hour or second,
 * whichever is most relevant") is really both of them. Answered from this
 * machine's own transcripts rather than from taste — eight days, 8,175
 * requests, probed 2026-08-21:
 *
 *   gap between requests    p50 5.8s   p90 32s    p99 8m
 *   tokens per request      p50 163k   p90 374k   max 801k
 *   tokens/min while busy   p50 420k   p90 2.0M   max 5.8M
 *   share of the wall clock with any activity in it at all:  22%
 *
 * **Per minute**, and the numbers are the argument:
 *
 * - *Per second* is finer than the thing it counts. One request carries a
 *   median 163k tokens and lands about every six seconds, so a per-second
 *   reading is dominated by where the request boundaries happen to fall — the
 *   unit is smaller than the quantum.
 * - *Per hour* is a projection, and a misleading one. Only 22% of the clock has
 *   any activity in it, so an instantaneous 25M/h describes an hour that never
 *   happens; the hour you actually get is several times lower. A number nobody
 *   can check against their own day is a number nobody reads twice.
 * - *Per minute* sits where the work sits. A turn takes about a minute and
 *   costs a few hundred thousand tokens, so "420k/min" reads against "a request
 *   is 163k" — you can hear it as two or three requests a minute.
 *
 * The other two are still offered (`Per`), because the ask asked for them and
 * because a wall worked differently from this one may well disagree. The
 * default is the one the data argues for.
 *
 * **Ten minutes** is the window the rate is averaged over, and that is a
 * property of the source rather than a preference: the buckets are five minutes
 * wide (`usage.rs::BUCKET_MS`), so anything shorter is mostly reading bucket
 * edges. Measured against the true per-request rate over the same window, over
 * three days of this machine's history:
 *
 *   window   median error vs. the truth over that same window
 *     5m       42%     (one boundary inside the window — the current bucket
 *                       counted whole against a five-minute denominator
 *                       over-reads by up to 2x early in a bucket)
 *    10m       20%
 *    15m       13%
 *    20m       10%
 *
 * Ten is where the granularity stops dominating and the reading is still short
 * enough to move while you watch: against a *true two-minute* rate — what is
 * actually happening right now — ten minutes tracks to about a third, and going
 * wider does not improve that at all (15m: 40%, 20m: 43%), because past ten the
 * window itself is the error rather than the buckets. So ten minutes is the
 * whole of what this source can honestly say, and saying it slower would buy
 * nothing.
 *
 * The needle is not stuck between the ledger's twenty-second beats, either: the
 * window's far edge slides with `now`, which comes off the wall's one-second
 * tick, so a lull decays the reading smoothly rather than stepping it. */

import { HOUR, MINUTE, type Slice, WEEK_MS } from "./usage";

/** How finely `usage.rs` cuts time. Mirrored rather than imported because it is
 *  a constant in Rust (`usage.rs::BUCKET_MS`) and nothing crosses the wire to
 *  say so — a bucket carries its start, never its width. Getting it wrong costs
 *  only the apportionment of the single oldest bucket in the window, which is
 *  bounded and small; it is not load-bearing the way the window is. */
export const BUCKET_MS = 5 * MINUTE;

/** How long a rate is averaged over. See the note at the top for the three days
 *  of measurement behind the number. */
export const WINDOW_MS = 10 * MINUTE;

/* ── the unit ──────────────────────────────────────────────────────────────*/

export type Per = "second" | "minute" | "hour";

const PER: Record<Per, number> = {
  second: 1000,
  minute: MINUTE,
  hour: HOUR,
};

const UNITS: Per[] = ["second", "minute", "hour"];

/** Total both ways round, the way `paceOf` is: a unit an older build wrote and
 *  a unit spelled wrong both read as the one the data argues for. */
export function perOf(v: string): Per {
  return (UNITS as string[]).includes(v) ? (v as Per) : "minute";
}

/** The unit as it goes after a numeral. Short, because it sits under a needle
 *  on a face two inches wide. */
export function shortUnit(per: Per): string {
  return per === "second" ? "/s" : per === "hour" ? "/h" : "/min";
}

/** The unit spelled out, for a header with room for it. */
export function saidUnit(per: Per): string {
  return per === "second"
    ? "tokens a second"
    : per === "hour"
      ? "tokens an hour"
      : "tokens a minute";
}

/* ── the reading ───────────────────────────────────────────────────────────*/

/** Every token a bucket holds, of whatever kind.
 *
 * All five, which is what `Totals.tokens` means one file over and therefore
 * what the `usage` widget's own token reading counts. It is worth knowing that
 * this total is about 99% cache reads on a wall worked like this one — so what
 * the needle really tracks is context size times request frequency, which is
 * "how hard is this being driven" and is the question a speedometer is for. A
 * reading that dropped cache would be a different and much smaller instrument,
 * and would disagree with the widget standing next to it. */
export function tokensOf(s: Slice): number {
  return s.input + s.output + s.cacheRead + s.write5m + s.write1h;
}

/** The rate over the ten minutes ending at `now`, in tokens per `per`.
 *
 * Three kinds of bucket, and the difference between the first two is a bug
 * waiting to be written:
 *
 * - **The bucket `now` is inside counts whole.** Everything in it has already
 *   happened, and all of it happened inside the window — apportioning it by how
 *   much of the *bucket* the window covers would scale the current activity
 *   down to nothing immediately after a boundary and back up over five minutes,
 *   which is a needle that sawtooths on a clock rather than on the work.
 * - **The bucket straddling the far edge is apportioned by overlap**, on the
 *   assumption that its tokens are spread evenly through it. That is the one
 *   guess in here, it is the standard one, and it is what makes the reading a
 *   continuous function of `now` rather than something that steps every five
 *   minutes as a bucket falls out of the back.
 * - Everything between them counts whole, which is the same rule as the first
 *   arriving at the same answer.
 *
 * A bucket dated after `now` is ignored rather than counted: that is a clock
 * that has been put back, and folding it in would read as a burst. */
export function rateAt(slices: Slice[], now: number, per: Per = "minute"): number {
  const from = now - WINDOW_MS;
  /* Where the current bucket starts. Written the long way round because `%` on
     a negative epoch is negative in JavaScript, and an epoch before 1970 is not
     a case worth being wrong about silently. */
  const here = now - (((now % BUCKET_MS) + BUCKET_MS) % BUCKET_MS);
  let n = 0;
  for (const s of slices) {
    if (s.at > now) continue;
    if (s.at + BUCKET_MS <= from) continue;
    if (s.at >= here) {
      n += tokensOf(s);
      continue;
    }
    const covered = s.at + BUCKET_MS - Math.max(s.at, from);
    n += tokensOf(s) * (covered / BUCKET_MS);
  }
  return n / (WINDOW_MS / PER[per]);
}

/** When anything was last recorded, or null on a wall that has never spent a
 *  token. The *end* of the last bucket rather than its start, since that is the
 *  latest instant anything in it could have happened — a face saying "nothing
 *  for 5m" the moment a turn finishes would be wrong by a bucket. */
export function lastAt(slices: Slice[]): number | null {
  let latest = -Infinity;
  for (const s of slices) if (s.at > latest) latest = s.at;
  return Number.isFinite(latest) ? latest + BUCKET_MS : null;
}

/** How long the wall has been quiet, or null if it has never been busy.
 *
 * A speedometer reading zero is a correct speedometer, so this is not what the
 * needle is drawn from — it is what the face says *beside* the needle, because
 * "0/min" and "0/min, and nothing for three hours" are different mornings. */
export function idleFor(slices: Slice[], now: number): number | null {
  const last = lastAt(slices);
  if (last === null) return null;
  return Math.max(0, now - last);
}

/* ── what the dial is marked in ────────────────────────────────────────────
 *
 * A speedometer needs a top, and a top is a fraction's denominator — which on
 * this wall may only ever be drawn against something real (`usage.md`). There
 * is no allowance in tokens to divide by: the account reports percentages, and
 * nothing anywhere says how many tokens a five-hour window holds. So the scale
 * is the same reference the `usage` widget's bars already use, one derivative
 * up — **the wall's own recent history**.
 *
 * Which part of it, though, is the whole design. The obvious answer, the
 * busiest ten minutes of the past week, was measured and thrown out: this
 * machine's peak is about 6.9M/min against a median busy pace of 550k, so a
 * needle scaled to the peak spends 92% of its working life in the bottom
 * seventh of the dial. An instrument whose needle never leaves the peg is not
 * reporting, it is decorating.
 *
 * So full scale is the **ninetieth percentile of the busy five minutes of the
 * past week** — the pace this wall reaches when it is genuinely going, rather
 * than the one spike where six cards happened to be mid-turn at once. On this
 * machine that is 1.73M/min, which snaps to a dial marked to 2M: normal work
 * sits at a quarter, hard work at half or better, and the needle passes full
 * scale about a tenth of the time it is moving at all. That is what a dial is
 * supposed to do. */

/** The steps a dial may be marked to: 1, 2 and 5 through every decade.
 *
 * Snapped rather than used raw so the face is *stable* — a scale recomputed off
 * a live percentile would creep by a few percent every beat and every numeral
 * on the dial would be a different number each time you looked. A ladder step
 * only changes when the wall's habits genuinely change, and then it changes
 * once. */
export function snapUp(v: number): number {
  if (!(v > 0)) return 0;
  const decade = Math.pow(10, Math.floor(Math.log10(v)));
  for (const lead of [1, 2, 5]) if (v <= lead * decade + 1e-9) return lead * decade;
  return 10 * decade;
}

/** The smallest dial worth marking, in tokens per minute.
 *
 * One request on this machine carries a median 163k tokens, so a full scale
 * much below this is a dial a single reply pegs — which says nothing about
 * pace, only that something happened. It is a floor rather than a default: any
 * wall with a week of history behind it will be above it. */
export const FLOOR_PER_MINUTE = 200_000;

/** A percentile of a sorted-on-the-way-through list. Nearest-rank, which for a
 *  few hundred buckets is exact enough and has no interpolation to argue
 *  about. */
export function quantile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)));
  return s[i] ?? 0;
}

/** Every busy five minutes of the past week, as a rate in `per` units.
 *
 * Buckets rather than sampled windows, because a bucket is an exact unit the
 * data already comes in — no grid to choose and no answer that depends on where
 * the samples happened to land. Empty buckets are not in `slices` at all, so
 * "busy" needs no test: a bucket that exists had something in it. */
export function busyRates(slices: Slice[], now: number, per: Per = "minute"): number[] {
  const from = now - WEEK_MS;
  const out: number[] = [];
  for (const s of slices) {
    if (s.at < from || s.at > now) continue;
    const n = tokensOf(s);
    if (n > 0) out.push(n / (BUCKET_MS / PER[per]));
  }
  return out;
}

/** What this wall reaches when it is going: the ninetieth percentile of its
 *  busy five minutes over the past week. */
export function busyPace(slices: Slice[], now: number, per: Per = "minute"): number {
  return quantile(busyRates(slices, now, per), 0.9);
}

/** What the dial is marked to, in `per` units.
 *
 * The busy pace, floored so a machine with nothing behind it is still marked to
 * something a single reply cannot peg. Deliberately **not** widened to fit the
 * current reading: a scale that grew to hold whatever the needle was doing
 * would re-mark the face mid-sweep — every numeral changing and the needle
 * falling back from the top — which reads as the instrument rescaling reality
 * rather than as the wall going fast. Pegging is what a speedometer does; the
 * numeral under the needle still says the true figure, and `over` says the
 * rest.
 *
 * The case that argued for widening it — a fresh machine whose very first
 * session runs far above the floor — is covered anyway, and by the statistic
 * rather than by a special case: `busyRates` includes the bucket now in
 * progress, so a wall doing 3M a minute has 3M-a-minute buckets in it within
 * five minutes and the dial has re-marked itself by the next beat. What is left
 * uncovered is the first five minutes of the first session ever run on a
 * machine, which is a pegged needle for one bucket.
 *
 * The ladder is in the unit you chose rather than in a canonical one, so
 * turning the knob to seconds re-marks the face to round numbers of tokens a
 * second instead of leaving it marked in sixtieths. Changing the unit therefore
 * moves the needle a little, deliberately: a dial whose numerals are not round
 * in the unit written under them is a dial nobody can read at a glance, and
 * sixty is not a power of ten, so one or the other had to give. */
export function fullScale(slices: Slice[], now: number, per: Per = "minute"): number {
  const floor = (FLOOR_PER_MINUTE / PER.minute) * PER[per];
  return snapUp(Math.max(busyPace(slices, now, per), floor));
}

/* ── the face of a dial ────────────────────────────────────────────────────*/

/** Where the sweep begins and how far it goes, in the degrees `clock.ts`'s
 *  `onFace` speaks: zero is straight up and it runs clockwise. A car's
 *  speedometer starts at about seven o'clock and ends at about five, which is
 *  this. */
export const START_DEG = -125;
export const SWEEP_DEG = 250;

/** Where on the sweep a fraction sits. */
export function angleFor(frac: number): number {
  return START_DEG + Math.min(1, Math.max(0, frac)) * SWEEP_DEG;
}

/** How far round the dial a reading is, clamped — a needle past the end says
 *  less than one pinned at the end, and `over` is what says the rest. */
export function fracOf(v: number, scale: number): number {
  if (!(scale > 0)) return 0;
  return Math.min(1, Math.max(0, v / scale));
}

/** Whether the reading has run past what the dial is marked to.
 *
 * Deliberately **not** a colour. Colour on this wall is status — celadon
 * working, amber asking, rust failed — and going faster than usual is none of
 * the three: nothing has failed and nothing is waiting on you. The one reading
 * here that would genuinely earn a redline is burning the allowance faster than
 * the window refills it, and that cannot be computed from this side: the
 * account reports a percentage and the transcripts report tokens, and nothing
 * anywhere converts between them. So the over-range is drawn as a mark on the
 * scale rather than as a warning, and the numeral says the number. */
export function over(v: number, scale: number): boolean {
  return scale > 0 && v > scale;
}

export type Tick = { at: number; frac: number; deg: number; major: boolean };

/** Every mark on the dial, majors numbered.
 *
 * How many majors comes off the ladder's lead digit so the numerals are always
 * whole steps of the scale: a dial marked to 2M is quartered, one marked to 1M
 * or 5M is fifthed. Each major is cut into five, which is the subdivision every
 * instrument uses because five is what an eye counts without counting. */
export function ticksOf(scale: number): Tick[] {
  if (!(scale > 0)) return [];
  /* The lead digit, recovered from the value rather than carried alongside it,
     so a scale that did not come out of `snapUp` still draws something sane. */
  const lead = scale / Math.pow(10, Math.floor(Math.log10(scale) + 1e-9));
  const majors = Math.abs(lead - 2) < 0.01 ? 4 : 5;
  const out: Tick[] = [];
  const steps = majors * 5;
  for (let i = 0; i <= steps; i += 1) {
    const frac = i / steps;
    out.push({ at: scale * frac, frac, deg: angleFor(frac), major: i % 5 === 0 });
  }
  return out;
}

/* ── the reading over time ─────────────────────────────────────────────────*/

/** The rate at `count` evenly spaced instants across the `span` ending at
 *  `now`, oldest first — the sparkline face.
 *
 * Every sample is a full `rateAt`, so the trace is the same reading the needle
 * gives, drawn where it was rather than where it is. It is therefore smoothed
 * by the same ten minutes: what this shows is the shape of a session, not the
 * shape of a turn, and it must not be read as the latter. */
export function trace(
  slices: Slice[],
  now: number,
  per: Per = "minute",
  count = 48,
  span = HOUR,
): number[] {
  const out: number[] = [];
  if (count < 2) return [rateAt(slices, now, per)];
  for (let i = 0; i < count; i += 1) {
    out.push(rateAt(slices, now - span * (1 - i / (count - 1)), per));
  }
  return out;
}

/* ── saying it ─────────────────────────────────────────────────────────────*/

/** A rate as a numeral, at the precision its size deserves.
 *
 * Not `usage.ts::count`, and the difference is the whole reason this exists: a
 * rate is a reading that moves, and `count` steps from `999` to `1.0k` to
 * `10k`, dropping a digit as it grows. On a total that is right — the figure is
 * read once. Under a needle it is a numeral whose *width* changes as the needle
 * sweeps, which reflows the line the eye is resting on. So the shape is fixed
 * at three significant figures and one suffix, and `0` is spelled `0` because a
 * dial at rest saying `0.00` is a dial pretending to a precision it has not
 * got.
 *
 * **Every threshold compares before it rounds**, which is the whole reason they
 * are `999.5` and `9.995` rather than the round numbers they look like. Testing
 * `v < 1e6` and *then* formatting is what turns 9,999 into `10.00k` and 99,950
 * into `100.0k` — six characters, from arithmetic that reads correct. The same
 * trap `usage.ts::money` is shaped around, found here the same way: by
 * asserting the width rather than the value. */
export function sayRate(v: number): string {
  if (!(v > 0)) return "0";
  if (v < 999.5) return String(Math.round(v));
  const [n, suffix] =
    v < 999_500 ? [v / 1000, "k"] : v < 999.5e6 ? [v / 1e6, "M"] : [v / 1e9, "B"];
  return `${n < 9.995 ? n.toFixed(2) : n < 99.95 ? n.toFixed(1) : Math.round(n)}${suffix}`;
}

/** A tick's numeral. Coarser than the reading on purpose — a scale is furniture
 *  and wants to be read past, so `1.5M` rather than `1.50M`, and `2M` rather
 *  than `2.0M`. Same compare-before-rounding thresholds as above. */
export function sayTick(v: number): string {
  if (!(v > 0)) return "0";
  if (v < 999.5) return String(Math.round(v));
  const [n, suffix] =
    v < 999_500 ? [v / 1000, "k"] : v < 999.5e6 ? [v / 1e6, "M"] : [v / 1e9, "B"];
  return `${n < 9.95 ? Number(n.toFixed(1)) : Math.round(n)}${suffix}`;
}

/** How long the wall has been quiet, in words that change about once a minute —
 *  the same cadence `usage.ts::left` keeps, and for the reason stated there. */
export function sayIdle(ms: number): string {
  const mins = Math.floor(ms / MINUTE);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
