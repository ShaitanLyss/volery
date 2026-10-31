/* What is left of the allowance, and when it comes back.
 *
 * `limits.rs` asks `/api/oauth/usage` and answers in facts — a percentage, a
 * reset instant and the rate limiter's own name for each window. Everything a
 * person actually wants is here: what to call a window, which one is about to
 * stop you, how close to the edge counts as close, and how to say a countdown
 * that may be five minutes or five days. The same split `usage.ts` draws against
 * `usage.rs`, and for the same reason.
 *
 * Pure — no runes, no DOM, no `invoke` — so all of it has direct Bun tests.
 *
 * **This is the file that made "no percentage of an allowance" wrong.** The note
 * at the top of `usage.ts` argued at length that no limit is knowable from this
 * machine, and every fraction that file draws is a fraction of the wall's own
 * recent history because of it. That argument was true about *transcripts* and
 * false about the account: `rateLimits` really is null on every record, and the
 * endpoint the CLI's own `/usage` reads was simply never looked for. So the two
 * live side by side and answer different questions — `usage.ts` says what the
 * work has cost, this says how much of the allowance it has eaten — and only
 * this one may draw a percentage, because only this one has a real denominator.
 */

import { HOUR, MINUTE } from "./usage";

const DAY = 24 * HOUR;

/** One window the account is measured against, exactly as `limits.rs` hands it
 *  over. `kind` is the rate limiter's own vocabulary rather than anything
 *  readable — it is passed through unchanged so that a window you were watching
 *  and the window that eventually stops you are nameable as the same thing. */
export type Window = {
  kind: string;
  /** `session` or `weekly` — which clock this one runs on. */
  group: string;
  /** Percent of the allowance used, 0–100. The server's own figure. */
  used: number;
  /** The server's own level: `normal`, `warning`, and the rejection states. */
  severity: string;
  /** Epoch ms, or null where the server names no reset. */
  resetsAt: number | null;
  /** A model's display name, where the window is scoped to one. */
  scope: string | null;
  active: boolean;
};

/** Usage past the plan, as `limits.rs::Overage` hands it over. `enabled` is
 *  whether extra usage can cover a send *now* — the CLI's schema says it reads
 *  false once the credits are gone — so it is the one field the waterfall
 *  treats as room. The amounts are minor units of `currency` (cents for USD),
 *  optional because a reading from an older wall carries none of them. */
export type Overage = {
  enabled: boolean;
  used: number | null;
  limit?: number | null;
  spent?: number | null;
  currency?: string | null;
};

export type Report = {
  windows: Window[];
  overage: Overage | null;
  at: number;
  source: string;
  plan: string | null;
};

/* ── what a window is called ───────────────────────────────────────────────*/

/** The rate limiter's vocabulary, in words worth putting on a wall.
 *
 * A `kind` nothing here recognises is *kept* and titled from its own name rather
 * than dropped: these codenames change — the same response carried seven null
 * windows called things like `nimbus_quill` and `iguana_necktie` on
 * 2026-08-17 — and a window the account is genuinely being measured against must
 * appear even if this build has never heard of it. Drawing it under an ugly name
 * is a much smaller failure than not drawing it. */
export function said(w: Window): string {
  const base =
    w.kind === "session"
      ? "5 hours"
      : w.kind === "weekly_all"
        ? "7 days"
        : w.kind === "weekly_scoped" || w.group === "weekly"
          ? "7 days"
          : w.kind.replace(/_/g, " ");
  return w.scope ? `${base} · ${w.scope}` : base;
}

/** Session windows first, then the unscoped week, then the scoped ones by name.
 *
 * The order is what the face reads top to bottom, and it is deliberately *not*
 * by how full each is: a list that reorders itself as the day goes on is one you
 * have to re-read from the top every time you glance at it. */
export function ordered(windows: Window[]): Window[] {
  const rank = (w: Window) =>
    w.group === "session" ? 0 : w.kind === "weekly_all" ? 1 : w.scope ? 2 : 3;
  return [...windows].sort(
    (a, b) => rank(a) - rank(b) || said(a).localeCompare(said(b)),
  );
}

/* ── how close is close ────────────────────────────────────────────────────*/

export type Tier = "calm" | "warm" | "urgent";

/** Amber from three-quarters, rust from nine-tenths — and never calmer than the
 *  server said.
 *
 *  Both halves matter. Our own thresholds are needed because `severity` is
 *  `normal` right up until the server decides otherwise, and a window at 89% is
 *  worth a colour before anybody official says so. The server's word is taken
 *  when it is *worse* because it knows things this does not: an org-level
 *  restriction, a spend limit, a rejection already issued. Taking the worse of
 *  the two is the only combination where neither source can talk the other into
 *  drawing something calm that is not. */
export function tierOf(w: Window): Tier {
  const ours: Tier = w.used >= 90 ? "urgent" : w.used >= 75 ? "warm" : "calm";
  const s = w.severity.toLowerCase();
  const theirs: Tier =
    s === "rejected" || s === "exceeded" || s === "error"
      ? "urgent"
      : s === "warning" || s === "allowed_warning"
        ? "warm"
        : "calm";
  const rank = { calm: 0, warm: 1, urgent: 2 } as const;
  return rank[theirs] > rank[ours] ? theirs : ours;
}

/** The window that will actually stop you: the fullest one, whatever clock it
 *  runs on.
 *
 *  Not the one the server marks `is_active` — that flag says which window is
 *  *binding right now*, which on a quiet account is the five-hour one at 8%
 *  while the week sits at 94%. The question this widget is hung up to answer is
 *  "am I about to be cut off", and the answer to that is whichever window runs
 *  out first. */
export function binding(windows: Window[]): Window | null {
  let out: Window | null = null;
  for (const w of windows) if (!out || w.used > out.used) out = w;
  return out;
}

/* ── saying it ─────────────────────────────────────────────────────────────*/

/** A percentage at the precision it deserves, which is none.
 *
 *  Whole numbers throughout: the server reports one decimal, and a widget that
 *  redrew from `27.4%` to `27.5%` would be drawing attention to a change that
 *  means nothing. Rounded down rather than to nearest, so nothing ever reads
 *  `100%` while there is still allowance left to spend. */
export function pct(used: number): string {
  if (!(used > 0)) return "0%";
  return `${Math.min(100, Math.floor(used))}%`;
}

/** How long until a window rolls, in words that stay short across five orders of
 *  magnitude.
 *
 *  `usage.ts::left` is the same idea and stops being readable here: a weekly
 *  window is five days out, and `left` would print `142h 12m`. Days are the unit
 *  above a day, and below one this is `left`'s wording exactly — the two sit on
 *  the same face and must not disagree about what four hours is called.
 *
 *  Deliberately not ticking to the second, for the reason `Rest.svelte`'s `said`
 *  gives: a countdown you can watch is a countdown you do watch. */
export function until(ms: number): string {
  if (!(ms > 0)) return "any moment";
  if (ms >= DAY) {
    const d = Math.floor(ms / DAY);
    const h = Math.floor((ms % DAY) / HOUR);
    return h ? `${d}d ${h}h` : `${d}d`;
  }
  const mins = Math.round(ms / MINUTE);
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** When this window comes back, or null where the server named no reset — which
 *  a scoped window nobody has touched genuinely does. */
export function resetIn(w: Window, now: number): number | null {
  if (w.resetsAt === null) return null;
  return Math.max(0, w.resetsAt - now);
}

/** The plan these percentages are a percentage *of*, said the way the account
 *  spells it. The only thing in the reading that gives them a denominator, so it
 *  is on the face rather than in a tooltip. */
export function planSaid(plan: string | null): string {
  if (!plan) return "allowance";
  return `${plan} allowance`;
}

/** The whole reading as one sentence, for the tooltip the face has no room for. */
export function why(w: Window, now: number): string {
  const at = `${said(w)} — ${pct(w.used)} used`;
  const ms = resetIn(w, now);
  return ms === null ? at : `${at}, resets in ${until(ms)}`;
}
