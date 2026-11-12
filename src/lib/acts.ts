/* What the person did, folded into readings (§3.10, §11.9).
 *
 * **Nothing here types.** No keystroke content, no draft text, no prompt text
 * is recorded anywhere on this path: a row says that a send happened, never
 * what was sent. That line is the whole difference between a scoreboard and a
 * keylogger, and it is the first thing to read before adding a kind to
 * `ACTION_KINDS`. The vocabulary is closed for the same reason — there is no
 * `key`, deliberately, so the next person reaching for one finds the argument
 * instead of a gap.
 *
 * The store keeps one row per gesture bucket (`action_fact`, a minute) and an
 * hour rollup of the same. This module is the fold: it takes what the window
 * read returns and answers the questions the behaviour page asks, in pure
 * functions with direct tests. Everything that could be drawn as a zero and
 * was not measured returns `null` instead, because a wall that says "0
 * switches an hour" about a window it could not read is lying with a number.
 */

/** The verbs, in the one order anything lists them. **This is the second copy
 *  and it is meant to be**: `analytics::ACTION_KINDS` in Rust is the first, and
 *  `tools/lift-actions.ts` reads both files and fails if they disagree, which
 *  is the same guard the flyway's vocabularies get. A kind one side spells
 *  differently is a row the writer refuses or a row nothing draws, and neither
 *  says so. */
export const ACTION_KINDS = [
  "focus",
  "send",
  "interrupt",
  "click",
  "command",
  "leader",
  "view",
  "open",
  "close",
  "spawn",
  "move",
  "rename",
  "search",
  "pause",
  "resume",
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

/** The kinds whose *order* is the reading. A focus mark is what a switch is
 *  folded from; the rest group naturally beside it. Mirrors
 *  `analytics::ACTION_MARK_KINDS`. */
export const MARK_KINDS = ["focus", "send", "interrupt", "spawn", "close"] as const;

/** What "actions a minute" counts. Deliberate gestures at the work: a click, a
 *  prompt, an interrupt, a command. It is **not** every row — navigation kinds
 *  (`view`, `open`, `move`, `rename`, `search`) would inflate a rate for
 *  moving the viewport, and a rate that rises when you tidy a wall has stopped
 *  measuring anything. The per-kind breakdown is drawn beside it, so nothing is
 *  hidden by leaving them out. */
export const GESTURE_KINDS = ["click", "send", "interrupt", "command"] as const;

/** Returning to a card inside this is the same visit, not a switch. Twenty
 *  seconds is about as long as a glance takes: shorter and a double-take
 *  counts as fragmentation that did not happen, longer and a real
 *  back-and-forth stops counting at all. */
export const SWITCH_FLOOR_MS = 20_000;

export type ActionSeriesRow = { at: number; kind: string; count: number };
export type ActionMark = { at: number; host: string; kind: string; target: string };
/** One grouped row, whether the group is a card (`target`) or a machine
 *  (`host`). `first` and `last` are bucket floors, so a span derived from them
 *  is accurate to the minute. `name` is the card's name, which the store
 *  resolves — a raw id is not something a face may draw. */
export type ActionSlice = {
  key: string;
  kind: string;
  count: number;
  first: number;
  last: number;
  name: string;
};

export type ActionWindow = {
  from: number;
  to: number;
  bucket: number;
  /** Answered from the hour rollup: the counts are whole, the order is gone. */
  coarse: boolean;
  series: ActionSeriesRow[];
  marks: ActionMark[];
  /** The window held more visits than a fold may be handed, so the marks are
   *  empty for a reason other than the tier. **The band still draws**: the
   *  rate, the card counts and the strip need no marks, and a cap that took
   *  them down as well would be a window refused for the one half it could
   *  not answer. */
  marksCapped: boolean;
  cards: ActionSlice[];
  hosts: ActionSlice[];
};

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const text = (v: unknown, max: number): string =>
  typeof v === "string" ? v.slice(0, max) : "";

const rows = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** A read, normalised. **A field that will not parse is dropped, never drawn
 *  as zero**: the store refusing a window is the honest failure, and a row
 *  with `count: NaN` in it would paint a gap as a quiet minute. */
export function asActionWindow(raw: unknown, fallback: { from: number; to: number; bucket: number }): ActionWindow {
  const r = (raw ?? {}) as Record<string, unknown>;
  const series: ActionSeriesRow[] = [];
  for (const row of rows(r.series)) {
    const o = row as Record<string, unknown>;
    const at = num(o.at);
    const count = num(o.count);
    if (at === null || count === null) continue;
    series.push({ at, kind: text(o.kind, 40), count });
  }
  const marks: ActionMark[] = [];
  for (const row of rows(r.marks)) {
    const o = row as Record<string, unknown>;
    const at = num(o.at);
    if (at === null) continue;
    marks.push({
      at,
      host: text(o.host, 80),
      kind: text(o.kind, 40),
      target: text(o.target, 80),
    });
  }
  const slices = (v: unknown): ActionSlice[] => {
    const out: ActionSlice[] = [];
    for (const row of rows(v)) {
      const o = row as Record<string, unknown>;
      const count = num(o.count);
      const first = num(o.first);
      const last = num(o.last);
      if (count === null || first === null || last === null) continue;
      out.push({
        key: text(o.key, 80),
        kind: text(o.kind, 40),
        count,
        first,
        last,
        name: text(o.name, 200),
      });
    }
    return out;
  };
  const from = num(r.from) ?? fallback.from;
  const to = num(r.to) ?? fallback.to;
  return {
    from,
    to,
    bucket: num(r.bucket) ?? fallback.bucket,
    coarse: r.coarse === true,
    marksCapped: r.marksCapped === true,
    series,
    marks,
    cards: slices(r.cards),
    hosts: slices(r.hosts),
  };
}

/** One stay on one card. `until` is when attention left it — the next focus,
 *  or the end of the window for whatever is open now. */
export type Visit = { card: string; at: number; until: number };

/** The focus marks folded into visits, with the twenty-second floor applied.
 *
 * **The floor is what makes a switch count mean something.** Without it, Tab
 * through six cards looking for one and back again reads as six context
 * switches, and the reading punishes exactly the gesture that finds things.
 * So a focus that returns to the card you were on before, inside the floor, is
 * a glance that did not happen: the brief visit is dropped and the earlier
 * stay continues through it.
 *
 * A repeat focus for the card already in hand is not a mark at all — the
 * collector does not send one — but a stored row can be one, so it folds here
 * too. */
export function visits(marks: ActionMark[], to: number): Visit[] {
  const kept: { card: string; at: number }[] = [];
  for (const m of marks) {
    if (m.kind !== "focus") continue;
    const top = kept.at(-1);
    if (top && top.card === m.target) continue;
    const under = kept.at(-2);
    if (top && under && under.card === m.target && m.at - top.at < SWITCH_FLOOR_MS) {
      /* A blip: back where we were, quickly. The stay never ended. */
      kept.pop();
      continue;
    }
    kept.push({ card: m.target, at: m.at });
  }
  return kept.map((v, i) => ({ card: v.card, at: v.at, until: i + 1 < kept.length ? kept[i + 1]!.at : Math.max(to, v.at) }));
}

const hours = (from: number, to: number): number => (to - from) / 3_600_000;

/** Context switches an hour. `null` when the span holds no focus at all, which
 *  is a window this wall did not watch rather than a quiet one. */
export function switchesPerHour(marks: ActionMark[], from: number, to: number): number | null {
  const folded = visits(marks, to);
  if (!folded.length) return null;
  const span = hours(from, to);
  if (span <= 0) return null;
  return Math.max(0, folded.length - 1) / span;
}

/** The median stay. The median rather than the mean because one card left
 *  open all night would move a mean past anything a day looks like. */
export function medianDwellMs(marks: ActionMark[], from: number, to: number): number | null {
  const folded = visits(marks, to);
  if (!folded.length) return null;
  const stays = folded.map((v) => Math.max(0, v.until - v.at)).sort((a, b) => a - b);
  const mid = Math.floor(stays.length / 2);
  return stays.length % 2 ? stays[mid]! : Math.round((stays[mid - 1]! + stays[mid]!) / 2);
}

/** Deliberate gestures a minute over the window (§11.9's "starcraft reading"). */
export function gestureRate(series: ActionSeriesRow[], from: number, to: number): number | null {
  const minutes = (to - from) / 60_000;
  if (minutes <= 0) return null;
  const counted = GESTURE_KINDS as readonly string[];
  let n = 0;
  let seen = false;
  for (const row of series) {
    if (!counted.includes(row.kind)) continue;
    n += row.count;
    seen = true;
  }
  return seen ? n / minutes : null;
}

/** How often a turn is stopped rather than left to finish. A high rate on one
 *  card is a card that cannot be left alone, which is a prompt to change the
 *  card rather than the person. `null` when nothing was sent in the window.
 *
 *  **Counted from the bucket counts, not from the marks.** The marks are the
 *  events, and reading them was the first shape; but the count table answers
 *  the same question at every span (the marks stop at ninety days) and costs a
 *  hundredth of the rows, and a rate is a count rather than a sequence. */
export function interruptRate(series: ActionSeriesRow[]): { sends: number; interrupts: number; share: number } | null {
  let sends = 0;
  let interrupts = 0;
  for (const row of series) {
    if (row.kind === "send") sends += row.count;
    else if (row.kind === "interrupt") interrupts += row.count;
  }
  if (!sends) return null;
  return { sends, interrupts, share: interrupts / sends };
}

/** How scattered the window was: distinct cards touched an hour, and the share
 *  of its minutes that held any gesture at all. `null` for a coarse window,
 *  whose marks were never sent. */
export function fragmentation(
  window: ActionWindow,
): { cardsPerHour: number; busyShare: number } | null {
  if (window.coarse) return null;
  const span = hours(window.from, window.to);
  if (span <= 0) return null;
  const touched = new Set(window.marks.filter((m) => m.kind === "focus").map((m) => m.target));
  const minutes = new Set<number>();
  for (const row of window.series) {
    if (row.count > 0) minutes.add(Math.floor(row.at / 60_000));
  }
  /* The series is bucketed by the drawing's grain, so a minute is only a
     minute when the read was asked for minutes. The share is then of the
     buckets that were asked for, which is what the face says it is. */
  const buckets = Math.max(1, Math.round((window.to - window.from) / window.bucket));
  return { cardsPerHour: touched.size / span, busyShare: minutes.size / buckets };
}

/** One card's lifetime in the window, beside the token lifetime §11.10 draws.
 *  `dwellMs` sums the visits, which is the part the SQL slice cannot answer —
 *  it has the timestamps but not the order. */
export type CardRow = {
  card: string;
  /** The card's name as the wall has it, or empty for one whose row is gone. */
  name: string;
  focus: number;
  sends: number;
  interrupts: number;
  dwellMs: number;
};

export function cardRows(window: ActionWindow): CardRow[] {
  const rows = new Map<string, CardRow>();
  const got = (card: string, name = ""): CardRow => {
    let row = rows.get(card);
    if (!row) {
      row = { card, name, focus: 0, sends: 0, interrupts: 0, dwellMs: 0 };
      rows.set(card, row);
    } else if (!row.name && name) row.name = name;
    return row;
  };
  for (const slice of window.cards) {
    if (!slice.key) continue;
    const row = got(slice.key, slice.name);
    if (slice.kind === "focus") row.focus += slice.count;
    else if (slice.kind === "send") row.sends += slice.count;
    else if (slice.kind === "interrupt") row.interrupts += slice.count;
  }
  for (const v of visits(window.marks, window.to)) got(v.card).dwellMs += Math.max(0, v.until - v.at);
  /* Busiest first, and a card with no name is the wall itself rather than a
     row: `target` is empty for a gesture on the ground. */
  return [...rows.values()].sort(
    (a, b) => b.focus + b.sends + b.interrupts - (a.focus + a.sends + a.interrupts),
  );
}

/* ── the collector's protocol, pure so it can be tested ──────────────────────
 *
 * The collector folds gestures into minute buckets and sends each bucket's
 * **running total**. Which bucket to send and when to forget it is where the
 * one bug in that protocol lives, and it is arithmetic rather than timing, so
 * it belongs here with a test rather than inside a `.svelte.ts` nothing can
 * run. `acts.svelte.ts` is then only the clock and the `invoke`.
 */

/** One bucket as it is held and sent: a minute, a verb, and how many so far. */
export type ActionBucket = {
  key: string;
  at: number;
  kind: string;
  target: string;
  detail: string;
  count: number;
};

export const MINUTE_MS = 60_000;

/** Fold one gesture in. The bucket is found by (minute, verb, target, detail)
 *  so a burst is one row, and it is **mutated in place** — that is the whole
 *  point of the map, and a copy per click is the cost this shape avoids. */
export function noteIn(
  buckets: Map<string, ActionBucket>,
  kind: string,
  target: string,
  detail: string,
  now: number,
): ActionBucket {
  const at = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const key = `${at}|${kind}|${target}|${detail}`;
  const held = buckets.get(key);
  if (held) {
    held.count += 1;
    return held;
  }
  const fresh: ActionBucket = { key, at, kind, target, detail, count: 1 };
  buckets.set(key, fresh);
  return fresh;
}

/** **Which buckets may be forgotten now that `sent` has landed.**
 *
 *  A bucket is forgotten only when its minute is over **and** nothing arrived
 *  while the write was in the air. Both halves are load-bearing, and the first
 *  one alone is the bug this function exists to stop being written by hand:
 *  forgetting a bucket as soon as it is sent makes the click after the flush
 *  start a fresh count at one, and a store holding three refuses it — so the
 *  minute reads as the largest five-second window in it instead of as the
 *  minute. */
export function forgetAfter(
  buckets: Map<string, ActionBucket>,
  sent: readonly ActionBucket[],
  now: number,
): void {
  const at = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  for (const s of sent) {
    const held = buckets.get(s.key);
    if (held && held.count === s.count && s.at < at) buckets.delete(s.key);
  }
}

/** A per-bucket series for the sparkline: the gesture kinds summed, with a
 *  zero for every bucket in the span so a quiet hour draws as a gap rather than
 *  as a line that skips it. */
export function gestureSeries(window: ActionWindow): number[] {
  const counted = GESTURE_KINDS as readonly string[];
  const at = new Map<number, number>();
  for (const row of window.series) {
    if (!counted.includes(row.kind)) continue;
    at.set(row.at, (at.get(row.at) ?? 0) + row.count);
  }
  const out: number[] = [];
  for (let b = window.from - (window.from % window.bucket); b < window.to; b += window.bucket) {
    out.push(at.get(b) ?? 0);
  }
  return out;
}

/** A rate said the way a person says it, or the honest word for not knowing. */
export function perHour(n: number | null): string {
  if (n === null) return "no reading";
  if (n < 10) return `${n.toFixed(1)}/h`;
  return `${Math.round(n)}/h`;
}

export function duration(ms: number | null): string {
  if (ms === null) return "no reading";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const h = ms / 3_600_000;
  return h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h)}h`;
}
