/* Cost against output: what the money bought (§3.9) and what coordination
 * cost, as the work tab reads it.
 *
 * The facts are `work_fact` rows, `work_series`'s card totals, the hourly
 * per-card token sums that let a card's dollars be priced here, and the
 * session intervals that place its bar. Nothing in this file polls, rounds a
 * null to zero, or divides by a divisor that is not there.
 *
 * Three rules carried from `docs/ANALYTICS.md`:
 *
 *  - **A card with no artifact is not zero output.** Design, review and a
 *    question answered well leave no commit. It is drawn as *no artifact*, and
 *    `noArtifact` is a field rather than a zero in a cell.
 *  - **A ratio whose divisor is zero is null, never 0** (§9.1). The table
 *    prints a dash and says why.
 *  - **A conflict is an episode, not the command's latency.** The receipt's
 *    `ms` is how long the command was blocked; the episode runs to the next
 *    commit or merge on that branch, bounded at thirty minutes (§3.9).
 *
 * Pure: no Tauri, no runes. Tested in `test/analyticswork.test.ts`.
 */

import { modeledUsd, spanMsOf, type HourFact } from "./analytics";
import { SPANS } from "./analyticsroom";
import { money, count, rateAt } from "./usage";
import { shortHandle } from "./whois";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long the fine tier keeps card-level facts (§3.6). The work page's cost
 *  and its artifacts both come from that tier, so a span past this would draw a
 *  year of commits against ninety days of dollars, which is the one comparison
 *  the tab exists to make. The work tab therefore offers no span past it. */
export const WORK_KEEP_MS = 90 * DAY;

/* ── the rows, as the commands answer them ─────────────────────────────────*/

export type WorkKind =
  | "commit"
  | "push"
  | "pr_open"
  | "pr_merge"
  | "merge"
  | "rebase"
  | "conflict"
  | "worktree"
  | "branch";

export type WorkProvenance = "receipt" | "history";

export type WorkRow = {
  at: number;
  host: string;
  session: string;
  card: string;
  agent: string;
  kind: string;
  ref: string;
  branch: string;
  project: string;
  files: number;
  added: number;
  removed: number;
  conflictFiles: number;
  ms: number;
  provenance: WorkProvenance;
};

export type WorkHourRow = {
  hour: number;
  host: string;
  project: string;
  branch: string;
  kind: string;
  count: number;
  files: number;
  added: number;
  removed: number;
  conflictMs: number;
};

/** One card's tokens for one hour: the raw material for its dollars. */
export type CardSpendRow = {
  card: string;
  hour: number;
  account: string;
  model: string;
  provenance: string;
  inTok: number;
  outTok: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
  requests: number;
  usdReported: number;
};

/** The spans the work tab can answer: `usage_fact` and `work_fact` are pruned
 *  at ninety days, and a pair of numbers whose windows differ is not a pair.
 *  The spend tab keeps its year, because `usage_hour` has one. */
export const WORK_SPANS = SPANS.filter(
  (s) => (spanMsOf(s.span) ?? Infinity) <= WORK_KEEP_MS,
);

/** A span made answerable, so a surface opened from the spend tab's year reads
 *  the longest window the work facts can support rather than a half-filled
 *  one. */
export function workSpanFor(span: string, spanMs: number | null): string {
  if (spanMs !== null && spanMs <= WORK_KEEP_MS) return span;
  return "90d";
}

/** A card's session interval, as the coordination strip places its bar. */
export type WorkSessionRow = {
  session: string;
  host: string;
  card: string;
  project: string;
  source: string;
  startedAt: number;
  endedAt: number | null;
};

export type WorkSeries = {
  hourly: WorkHourRow[];
  spend: CardSpendRow[];
  sessions: WorkSessionRow[];
};

export type Span = [number, number];

export type PairOverlap = {
  left: string;
  right: string;
  minutes: number;
  files: string[];
  spans: Span[];
};

/** One invalidation fact (§3.9): an instruction write, a rule write, or a move
 *  of account, provider or model, and the excess attributed to it.
 *
 *  **Two provenances, one event.** A `receipt` row is the write or the move; an
 *  `attributed` row is one paying card's excess measured at the same instant.
 *  Event counts come from receipts and dollars from attributed rows, and the
 *  two are never added together (§9.1).
 */
export type InvalidateRow = {
  at: number;
  host: string;
  session: string;
  card: string;
  kind: string;
  ref: string;
  /** The directory the card stood in: the scope of who pays. */
  tree: string;
  affected: number;
  /** The attributed excess, in cache-write tokens. Priced here, never in Rust. */
  tokens: number;
  /** The same excess in fresh input tokens, where a restarted process's
   *  re-read of the prefix lands on the CLI this wall was measured against. */
  inTokens: number;
  /** The model the excess was written against, `''` on a receipt row. */
  model: string;
  usd: number;
  provenance: "receipt" | "attributed";
};

/** Everything one work read asks of the wall. */
export type WorkBundle = {
  rows: WorkRow[];
  series: WorkSeries;
  overlaps: PairOverlap[];
  invalidations: InvalidateRow[];
  /** The pair listing was refused or failed while the facts and the series
   *  answered. The strip says so rather than claiming nothing overlapped. */
  overlapsUnread?: boolean;
  /** The invalidation read failed. Its absence is said out loud rather than
   *  drawn as a window in which nothing was invalidated. */
  invalidationsUnread?: boolean;
};

/** The command, or a fixture. */
export type WorkReader = (from: number, to: number) => Promise<WorkBundle>;

/* ── what the commands answer, made drawable ───────────────────────────────*/

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asWorkRow(raw: unknown): WorkRow | null {
  const r = obj(raw);
  if (!r) return null;
  const at = num(r.at);
  if (!(at > 0)) return null;
  const kind = str(r.kind);
  if (!kind) return null;
  return {
    at,
    host: str(r.host),
    session: str(r.session),
    card: str(r.card),
    agent: str(r.agent),
    kind,
    ref: str(r.ref),
    branch: str(r.branch),
    project: str(r.project),
    files: Math.max(0, Math.trunc(num(r.files))),
    added: Math.max(0, Math.trunc(num(r.added))),
    removed: Math.max(0, Math.trunc(num(r.removed))),
    conflictFiles: Math.max(0, Math.trunc(num(r.conflictFiles))),
    ms: Math.max(0, Math.trunc(num(r.ms))),
    provenance: r.provenance === "history" ? "history" : "receipt",
  };
}

export function asInvalidateRows(raw: unknown): InvalidateRow[] {
  if (!Array.isArray(raw)) return [];
  const out: InvalidateRow[] = [];
  for (const one of raw) {
    const o = obj(one);
    if (!o) continue;
    const kind = str(o.kind);
    if (!kind) continue;
    const provenance = o.provenance === "attributed" ? "attributed" : "receipt";
    out.push({
      at: num(o.at),
      host: str(o.host),
      session: str(o.session),
      card: str(o.card),
      kind,
      ref: str(o.ref),
      tree: str(o.tree),
      affected: num(o.affected),
      tokens: num(o.tokens),
      inTokens: num(o.inTokens),
      model: str(o.model),
      usd: num(o.usd),
      provenance,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

export function asWorkRows(raw: unknown): WorkRow[] {
  return Array.isArray(raw) ? raw.map(asWorkRow).filter((r): r is WorkRow => r !== null) : [];
}

function asSpendRow(raw: unknown): CardSpendRow | null {
  const r = obj(raw);
  if (!r) return null;
  const hour = num(r.hour);
  if (!(hour > 0)) return null;
  return {
    card: str(r.card),
    hour,
    account: str(r.account),
    model: str(r.model),
    provenance: str(r.provenance) || "transcript",
    inTok: Math.max(0, Math.trunc(num(r.inTok))),
    outTok: Math.max(0, Math.trunc(num(r.outTok))),
    cacheRead: Math.max(0, Math.trunc(num(r.cacheRead))),
    write5m: Math.max(0, Math.trunc(num(r.write5m))),
    write1h: Math.max(0, Math.trunc(num(r.write1h))),
    requests: Math.max(0, Math.trunc(num(r.requests))),
    usdReported: num(r.usdReported),
  };
}

function asSessionRow(raw: unknown): WorkSessionRow | null {
  const r = obj(raw);
  if (!r) return null;
  const startedAt = num(r.startedAt);
  if (!(startedAt > 0)) return null;
  const ended = r.endedAt === null || r.endedAt === undefined ? null : num(r.endedAt);
  return {
    session: str(r.session),
    host: str(r.host),
    card: str(r.card),
    project: str(r.project),
    source: str(r.source),
    startedAt,
    endedAt: ended && ended > startedAt ? ended : null,
  };
}

/** The work series, made safe to draw. A row with no hour is dropped rather
 *  than folded into the first bucket, and unknown kinds are kept: the store's
 *  vocabulary may grow, and a kind this build cannot name still counts as an
 *  artifact rather than vanishing from a total. */
export function asWorkSeries(raw: unknown): WorkSeries {
  const r = obj(raw);
  if (!r) return { hourly: [], spend: [], sessions: [] };
  const hourly: WorkHourRow[] = Array.isArray(r.hourly)
    ? r.hourly
        .map((item) => {
          const h = obj(item);
          if (!h) return null;
          const hour = num(h.hour);
          if (!(hour > 0)) return null;
          return {
            hour,
            host: str(h.host),
            project: str(h.project),
            branch: str(h.branch),
            kind: str(h.kind),
            count: Math.max(0, Math.trunc(num(h.count))),
            files: Math.max(0, Math.trunc(num(h.files))),
            added: Math.max(0, Math.trunc(num(h.added))),
            removed: Math.max(0, Math.trunc(num(h.removed))),
            conflictMs: Math.max(0, Math.trunc(num(h.conflictMs))),
          };
        })
        .filter((x): x is WorkHourRow => x !== null)
    : [];
  const spend = Array.isArray(r.spend)
    ? r.spend.map(asSpendRow).filter((x): x is CardSpendRow => x !== null)
    : [];
  const sessions = Array.isArray(r.sessions)
    ? r.sessions.map(asSessionRow).filter((x): x is WorkSessionRow => x !== null)
    : [];
  return { hourly, spend, sessions };
}

function asPair(raw: unknown): PairOverlap | null {
  const r = obj(raw);
  if (!r) return null;
  const left = str(r.left);
  const right = str(r.right);
  if (!left || !right || left === right) return null;
  const spans = Array.isArray(r.spans)
    ? r.spans
        .map((s) => {
          if (!Array.isArray(s) || s.length < 2) return null;
          const a = num(s[0]);
          const b = num(s[1]);
          return b > a ? ([a, b] as Span) : null;
        })
        .filter((s): s is Span => s !== null)
    : [];
  return {
    left,
    right,
    minutes: Math.max(0, Math.trunc(num(r.minutes))),
    files: Array.isArray(r.files) ? r.files.map(str).filter(Boolean) : [],
    spans,
  };
}

export function asOverlaps(raw: unknown): PairOverlap[] {
  return Array.isArray(raw) ? raw.map(asPair).filter((p): p is PairOverlap => p !== null) : [];
}

/* ── pricing one card-hour ─────────────────────────────────────────────────*/

/** A card-hour's dollars, priced through the same table the spend page uses.
 *
 *  **`usdReported` wins only where it is the only correct figure**: a
 *  `turn`-provenance row is the CLI's own number (§7.4), and a sentinel account
 *  (`@deepseek`, `@credits`) has no price in a subscription rate table. A zero
 *  reported figure is not a reported figure, so it falls through to pricing
 *  rather than reading as free. */
export function spendOfRow(row: CardSpendRow): number | null {
  if (row.provenance === "turn" && row.usdReported > 0) return row.usdReported;
  const fact: HourFact = {
    hour: row.hour,
    host: "",
    account: row.account,
    provider: "",
    model: row.model,
    effort: "",
    cli: "",
    source: "",
    project: "",
    provenance: row.provenance === "turn" ? "turn" : "transcript",
    inTok: row.inTok,
    outTok: row.outTok,
    cacheRead: row.cacheRead,
    write5m: row.write5m,
    write1h: row.write1h,
    requests: row.requests,
    usdReported: row.usdReported,
  };
  return modeledUsd(fact, rateAt);
}

/* ── spans ─────────────────────────────────────────────────────────────────*/

/** Intervals with no empty or backwards member, merged where they touch. */
export function unionSpans(spans: readonly Span[]): Span[] {
  const clean = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Span[] = [];
  for (const [a, b] of clean) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function clipSpans(spans: readonly Span[], from: number, to: number): Span[] {
  const out: Span[] = [];
  for (const [a, b] of spans) {
    const start = Math.max(from, a);
    const end = Math.min(to, b);
    if (end > start) out.push([start, end]);
  }
  return unionSpans(out);
}

function spanMs(spans: readonly Span[]): number {
  return spans.reduce((n, [a, b]) => n + (b - a), 0);
}

/* ── conflicts, as episodes (§3.9) ─────────────────────────────────────────*/

/** How long an episode runs when nothing on the branch resolves it. */
export const CONFLICT_CAP_MS = 30 * MINUTE;

export type EpisodeClose = "commit" | "merge" | "pr_merge" | "cap";

export type ConflictEpisode = {
  branch: string;
  card: string;
  project: string;
  host: string;
  start: number;
  end: number;
  minutes: number;
  files: number;
  /** The blocked command's own latency, kept apart from the span. */
  latencyMs: number;
  closedBy: EpisodeClose;
  /** The resolving artifact's instant, or null when the cap ended it. */
  closedAt: number | null;
};

const CLOSERS = new Set(["commit", "merge", "pr_merge"]);

/** Each conflict row opens an episode; the next commit or merge on the same
 *  branch ends it, or the cap does. Sorted by start.
 *
 *  **The minutes are the span, never the latency alone.** A rebase blocked for
 *  two minutes and resolved twelve minutes later cost twelve; a command that
 *  was itself blocked past the cap keeps its measured latency, because the cap
 *  bounds how long a *resolution* is looked for, not how long the command was
 *  actually in it. */
export function conflictEpisodes(
  rows: readonly WorkRow[],
  cap = CONFLICT_CAP_MS,
): ConflictEpisode[] {
  const conflicts = rows.filter((r) => r.kind === "conflict").sort((a, b) => a.at - b.at);
  if (!conflicts.length) return [];

  /* **A branch is not unique across trees.** Two projects both on `main` are
     ordinary, and a commit in one must not be read as the resolution of a
     conflict in the other. The key is the tree the branch lives in. */
  const keyOf = (row: Pick<WorkRow, "host" | "project" | "branch">) =>
    `${row.host}\u0000${row.project}\u0000${row.branch}`;

  const closers = new Map<string, WorkRow[]>();
  for (const row of rows) {
    if (!CLOSERS.has(row.kind) || !row.branch) continue;
    const key = keyOf(row);
    const list = closers.get(key);
    if (list) list.push(row);
    else closers.set(key, [row]);
  }
  for (const list of closers.values()) list.sort((a, b) => a.at - b.at);

  const next = (row: WorkRow): WorkRow | null => {
    const list = closers.get(keyOf(row));
    if (!list) return null;
    /* The first closer strictly after the conflict; the command that emitted
       the CONFLICT line cannot also be the one that resolved it. */
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].at <= row.at) lo = mid + 1;
      else hi = mid;
    }
    return list[lo] ?? null;
  };

  const raw: ConflictEpisode[] = conflicts.map((row) => {
    const resolved = row.branch ? next(row) : null;
    const capped = row.at + cap;
    const by = resolved && resolved.at <= capped ? resolved : null;
    const end = by ? by.at : capped;
    const minutes = Math.max(row.ms, end - row.at) / MINUTE;
    return {
      branch: row.branch,
      card: row.card,
      project: row.project,
      host: row.host,
      start: row.at,
      end: row.at + minutes * MINUTE,
      minutes,
      files: row.conflictFiles,
      latencyMs: row.ms,
      closedBy: by ? (by.kind as EpisodeClose) : "cap",
      closedAt: by ? by.at : null,
    };
  });

  /* **One outage, not one per receipt.** A merge aborted and then a rebase, or
     a rebase whose `--continue` is not captured as a commit, leaves two
     conflict rows inside the same unresolved stretch. Summing them would count
     the same minutes twice, so an episode that opens while another is open on
     the same branch extends it instead. The union of the spans is the outage. */
  const out: ConflictEpisode[] = [];
  const open = new Map<string, ConflictEpisode>();
  for (const ep of raw) {
    const key = `${ep.host}\u0000${ep.project}\u0000${ep.branch}`;
    const prev = open.get(key);
    if (prev && ep.start <= prev.end) {
      const end = Math.max(prev.end, ep.end);
      if (ep.end > prev.end) {
        prev.closedBy = ep.closedBy;
        prev.closedAt = ep.closedAt;
      }
      prev.end = end;
      prev.files = Math.max(prev.files, ep.files);
      prev.latencyMs = Math.max(prev.latencyMs, ep.latencyMs);
      prev.minutes = Math.max((end - prev.start) / MINUTE, prev.latencyMs);
      prev.end = prev.start + prev.minutes * MINUTE;
    } else {
      const one = { ...ep };
      out.push(one);
      open.set(key, one);
    }
  }
  return out;
}

/* ── a card's own totals ───────────────────────────────────────────────────*/

/** The kinds that are an artifact: something landed. A conflict is a cost and
 *  a worktree or branch is a place to work, so none of the three is output. */
export const ARTIFACT_KINDS: readonly string[] = ["commit", "push", "pr_open", "pr_merge", "merge", "rebase"];
export const MERGED_KINDS: readonly string[] = ["pr_merge", "merge"];

export type CardWork = {
  card: string;
  label: string;
  project: string;
  /** Modeled or reported dollars, or null when no spend was attributed. */
  cost: number | null;
  unpriced: number;
  /** Card-hours whose figure is the CLI's own rather than a priced one. */
  reported: number;
  requests: number;
  commits: number;
  attributedCommits: number;
  pushes: number;
  prsOpened: number;
  prsMerged: number;
  merges: number;
  merged: number;
  /** Merges a history backfill attributed rather than a receipt naming them. */
  attributedMerges: number;
  rebases: number;
  conflictRows: number;
  conflictFiles: number;
  added: number;
  removed: number;
  net: number;
  churn: number;
  files: number;
  artifacts: number;
  noArtifact: boolean;
  activeMs: number;
  burnUsdPerHour: number | null;
  costPerMerged: number | null;
  costPerCommit: number | null;
  costPer1kNet: number | null;
};

/** What a work row is called.
 *
 *  The wall's own name where it has one. A card the store can no longer name
 *  gets its handle, which `whois.ts` owns, because this is a data row and not a
 *  surface introducing somebody: an unlabelled row cannot be told from its
 *  neighbour, and a table of "a card no longer on the wall" is not a reading.
 *  The handle is the only name the work fact carries. */
function labelOf(card: string, names?: ReadonlyMap<string, string>): string {
  if (!card) return "no card";
  const named = names?.get(card)?.trim();
  if (named) return named;
  return card.length > 10 ? shortHandle(card) : card;
}

export type CardWorkInput = {
  rows: readonly WorkRow[];
  series: WorkSeries;
  names?: ReadonlyMap<string, string>;
  from: number;
  to: number;
};

/** One row per card, whether or not it produced anything.
 *
 *  **The universe is spend plus sessions plus artifacts**, not the artifacts
 *  alone: a design card that spent $40 and committed nothing is the row this
 *  page exists to draw honestly, and building the list from `work_fact` would
 *  silently drop it. */
export function cardWorkOf(input: CardWorkInput): CardWork[] {
  const { rows, series, names, from, to } = input;

  const cards = new Set<string>();
  for (const row of rows) cards.add(row.card);
  for (const row of series.spend) cards.add(row.card);
  for (const s of series.sessions) cards.add(s.card);

  const byCard = new Map<string, WorkRow[]>();
  for (const row of rows) {
    const list = byCard.get(row.card);
    if (list) list.push(row);
    else byCard.set(row.card, [row]);
  }

  const spendByCard = new Map<string, CardSpendRow[]>();
  for (const row of series.spend) {
    const list = spendByCard.get(row.card);
    if (list) list.push(row);
    else spendByCard.set(row.card, [row]);
  }

  const sessionsByCard = new Map<string, Span[]>();
  const projects = new Map<string, Map<string, number>>();
  for (const s of series.sessions) {
    const list = sessionsByCard.get(s.card);
    const span: Span = [s.startedAt, s.endedAt ?? to];
    if (list) list.push(span);
    else sessionsByCard.set(s.card, [span]);
    if (s.project) {
      const counts = projects.get(s.card) ?? new Map<string, number>();
      counts.set(s.project, (counts.get(s.project) ?? 0) + 1);
      projects.set(s.card, counts);
    }
  }

  const out: CardWork[] = [];
  for (const card of cards) {
    const own = byCard.get(card) ?? [];
    const spend = spendByCard.get(card) ?? [];

    let commits = 0;
    let attributedCommits = 0;
    let pushes = 0;
    let prsOpened = 0;
    let prsMerged = 0;
    let merges = 0;
    let attributedMerges = 0;
    let rebases = 0;
    let conflictRows = 0;
    let conflictFiles = 0;
    let added = 0;
    let removed = 0;
    let files = 0;
    const projectCounts = new Map<string, number>();
    for (const row of own) {
      if (row.project) projectCounts.set(row.project, (projectCounts.get(row.project) ?? 0) + 1);
      switch (row.kind) {
        case "commit":
          commits += 1;
          if (row.provenance === "history") attributedCommits += 1;
          break;
        case "push":
          pushes += 1;
          break;
        case "pr_open":
          prsOpened += 1;
          break;
        case "pr_merge":
          prsMerged += 1;
          if (row.provenance === "history") attributedMerges += 1;
          break;
        case "merge":
          merges += 1;
          if (row.provenance === "history") attributedMerges += 1;
          break;
        case "rebase":
          rebases += 1;
          break;
        case "conflict":
          conflictRows += 1;
          conflictFiles += row.conflictFiles;
          break;
        default:
          break;
      }
      added += row.added;
      removed += row.removed;
      files += row.files;
    }

    /* A card whose only spend is unpriced is not a free card. `cost` stays
       null and `unpriced` says how much of the answer was refused. */
    let cost = 0;
    let priced = 0;
    let unpriced = 0;
    let reported = 0;
    let requests = 0;
    for (const row of spend) {
      requests += row.requests;
      const usd = spendOfRow(row);
      if (usd === null) unpriced += 1;
      else {
        cost += usd;
        priced += 1;
        if (row.provenance === "turn" && row.usdReported > 0) reported += 1;
      }
    }
    const dollars = priced > 0 ? cost : null;

    const sessionSpans = sessionsByCard.get(card);
    const fallback: Span[] = own.length
      ? [[Math.min(...own.map((r) => r.at)), Math.max(...own.map((r) => r.at)) + MINUTE]]
      : [];
    const spans = clipSpans(sessionSpans ?? fallback, from, to);
    const activeMs = spanMs(spans);

    const merged = prsMerged + merges;
    const artifacts = commits + pushes + prsOpened + merged + rebases;

    /* The project the card is most often recorded under, then the session's,
       and never an invented one. */
    const projectMap = projectCounts.size ? projectCounts : (projects.get(card) ?? new Map());
    let project = "";
    for (const [name, n] of projectMap) {
      if (!project || n > (projectMap.get(project) ?? 0) || (n === projectMap.get(project) && name < project)) {
        project = name;
      }
    }

    const hours = activeMs / HOUR;
    out.push({
      card,
      label: labelOf(card, names),
      project,
      cost: dollars,
      unpriced,
      reported,
      requests,
      commits,
      attributedCommits,
      pushes,
      prsOpened,
      prsMerged,
      merges,
      merged,
      attributedMerges,
      rebases,
      conflictRows,
      conflictFiles,
      added,
      removed,
      net: added - removed,
      churn: added + removed,
      files,
      artifacts,
      noArtifact: artifacts === 0,
      activeMs,
      burnUsdPerHour: dollars !== null && hours > 0 ? dollars / hours : null,
      costPerMerged: dollars !== null && merged > 0 ? dollars / merged : null,
      costPerCommit: dollars !== null && commits > 0 ? dollars / commits : null,
      costPer1kNet: dollars !== null && added - removed > 0 ? dollars / ((added - removed) / 1000) : null,
    });
  }

  /* Cost first and nulls last: the expensive cards are the question. A tie is
     broken by the label so the order is stable across a refresh. */
  return out.sort(
    (a, b) =>
      (b.cost ?? -1) - (a.cost ?? -1) ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  );
}

/* ── coordination ──────────────────────────────────────────────────────────*/

export type Coordination = {
  episodes: ConflictEpisode[];
  conflictMinutes: number;
  /** Dollars of card burn spent while conflicted; null when no episode could
   *  be priced, which is not the same as costing nothing. */
  coordinationUsd: number | null;
  pricedMinutes: number;
  unpricedMinutes: number;
  /** What each card's episodes cost, keyed by card; null where its burn was
   *  not known. */
  byCard: Map<string, number | null>;
};

/** Conflict minutes times the card's own burn rate (§3.9).
 *
 *  **The rate is the card's, not the wall's**: a card at 600k context burns ten
 *  times what a card at 60k does, and a wall-wide average would hide exactly
 *  the collision worth finding. An episode whose card has no priced spend is
 *  counted in minutes and left out of the dollars, so the face can say which
 *  half it is. */
export function coordinationOf(
  episodes: readonly ConflictEpisode[],
  cards: readonly CardWork[],
): Coordination {
  const burn = new Map(cards.map((c) => [c.card, c.burnUsdPerHour]));
  let usd = 0;
  let pricedMinutes = 0;
  let unpricedMinutes = 0;
  const byCard = new Map<string, number | null>();

  for (const episode of episodes) {
    const rate = burn.get(episode.card) ?? null;
    const prior = byCard.get(episode.card);
    if (rate === null) {
      unpricedMinutes += episode.minutes;
      byCard.set(episode.card, prior ?? null);
      continue;
    }
    const one = (episode.minutes / 60) * rate;
    usd += one;
    pricedMinutes += episode.minutes;
    byCard.set(episode.card, (prior ?? 0) + one);
  }

  return {
    episodes: [...episodes].sort((a, b) => a.start - b.start),
    conflictMinutes: episodes.reduce((n, e) => n + e.minutes, 0),
    coordinationUsd: pricedMinutes > 0 ? usd : null,
    pricedMinutes,
    unpricedMinutes,
    byCard,
  };
}

/* ── the strip's bars and bands ────────────────────────────────────────────*/

export type CardBar = {
  card: string;
  label: string;
  project: string;
  spans: Span[];
  cost: number | null;
  burnUsdPerHour: number | null;
};

export type OverlapBand = {
  left: string;
  right: string;
  spans: Span[];
  minutes: number;
  files: string[];
};

export function barsOf(cards: readonly CardWork[], series: WorkSeries, from: number, to: number): CardBar[] {
  const sessions = new Map<string, Span[]>();
  for (const s of series.sessions) {
    const list = sessions.get(s.card);
    const span: Span = [s.startedAt, s.endedAt ?? to];
    if (list) list.push(span);
    else sessions.set(s.card, [span]);
  }
  return cards
    .map((card) => {
      const spans = clipSpans(sessions.get(card.card) ?? [], from, to);
      return {
        card: card.card,
        label: card.label,
        project: card.project,
        spans,
        cost: card.cost,
        burnUsdPerHour: card.burnUsdPerHour,
      };
    })
    .filter((bar) => bar.spans.length > 0);
}

export function bandsOf(overlaps: readonly PairOverlap[], cards: readonly CardWork[], from: number, to: number): OverlapBand[] {
  const known = new Set(cards.map((c) => c.card));
  return overlaps
    .filter((p) => known.has(p.left) && known.has(p.right))
    .map((p) => ({
      left: p.left,
      right: p.right,
      spans: clipSpans(p.spans, from, to),
      minutes: p.minutes,
      files: p.files,
    }))
    .filter((b) => b.spans.length > 0);
}

/* ── the panels, and the scatter ───────────────────────────────────────────*/

export type Point = { at: number; value: number };

export type WorkPanels = {
  /** Dollars per UTC hour, priced from the card-hour rows. */
  cost: Point[];
  /** Artifacts per UTC hour, from the rolled-up work hours. */
  artifacts: Point[];
  costUnpriced: number;
};

export function panelsOf(series: WorkSeries): WorkPanels {
  const cost = new Map<number, number>();
  let unpriced = 0;
  for (const row of series.spend) {
    const usd = spendOfRow(row);
    if (usd === null) {
      unpriced += 1;
      continue;
    }
    cost.set(row.hour, (cost.get(row.hour) ?? 0) + usd);
  }
  const artifacts = new Map<number, number>();
  for (const row of series.hourly) {
    if (!ARTIFACT_KINDS.includes(row.kind)) continue;
    artifacts.set(row.hour, (artifacts.get(row.hour) ?? 0) + row.count);
  }
  const points = (m: Map<number, number>): Point[] =>
    [...m.entries()].map(([at, value]) => ({ at, value })).sort((a, b) => a.at - b.at);
  return { cost: points(cost), artifacts: points(artifacts), costUnpriced: unpriced };
}

export type ScatterMeasure = "merged" | "net";

export const SCATTER_MEASURES: readonly { key: ScatterMeasure; label: string; said: string }[] = [
  { key: "merged", label: "merged", said: "merged pull requests and merge commits" },
  { key: "net", label: "net lines", said: "lines added minus lines removed" },
];

export function scatterMeasureFor(raw: unknown): ScatterMeasure {
  return raw === "net" ? "net" : "merged";
}

export type ScatterPoint = {
  card: string;
  label: string;
  cost: number;
  y: number;
  noArtifact: boolean;
  project: string;
};

export type Scatter = {
  points: ScatterPoint[];
  /** Cards the scatter cannot place because no spend was attributed to them.
   *  A dot at zero cost would put the most expensive-looking card at the left
   *  edge, which is a lie about a missing row. */
  omitted: number;
  measure: ScatterMeasure;
};

/** The y axis of the scatter, without a repeated or impossible label.
 *
 *  A wall where nobody merged puts every dot on the same line; forcing a range
 *  of one and cutting it in thirds produced `0, 1, 1` for an integer measure,
 *  which is two identical labels and a tick at a value no card can hold. */
export function scatterTicks(lo: number, hi: number, measure: ScatterMeasure): number[] {
  if (!(hi > lo)) hi = lo + 1;
  const values =
    measure === "merged"
      ? [lo, Math.round((lo + hi) / 2), hi]
      : hi - lo < 2
        ? [lo, hi]
        : [lo, (lo + hi) / 2, hi];
  return [...new Set(values)];
}

export function scatterOf(cards: readonly CardWork[], measure: ScatterMeasure): Scatter {
  const points: ScatterPoint[] = [];
  let omitted = 0;
  for (const card of cards) {
    if (card.cost === null) {
      omitted += 1;
      continue;
    }
    points.push({
      card: card.card,
      label: card.label,
      cost: card.cost,
      y: measure === "net" ? card.net : card.merged,
      noArtifact: card.noArtifact,
      project: card.project,
    });
  }
  return { points, omitted, measure };
}

/* ── the KPI strip ─────────────────────────────────────────────────────────*/

export type WorkKpis = {
  cost: number | null;
  unpriced: number;
  /** Card-hours whose dollars are the CLI's own figure (§7.4). */
  reported: number;
  merged: number;
  mergedFromHistory: number;
  commits: number;
  attributedCommits: number;
  net: number;
  added: number;
  removed: number;
  conflictMinutes: number;
  leading: { project: string; artifacts: number; share: number | null } | null;
};

export function kpisOf(rows: readonly WorkRow[], cards: readonly CardWork[], coordination: Coordination): WorkKpis {
  let merged = 0;
  let mergedFromHistory = 0;
  let commits = 0;
  let attributedCommits = 0;
  let added = 0;
  let removed = 0;
  let artifacts = 0;
  const byProject = new Map<string, number>();
  for (const row of rows) {
    switch (row.kind) {
      case "commit":
        commits += 1;
        if (row.provenance === "history") attributedCommits += 1;
        break;
      case "pr_merge":
        merged += 1;
        if (row.provenance === "history") mergedFromHistory += 1;
        break;
      case "merge":
        merged += 1;
        if (row.provenance === "history") mergedFromHistory += 1;
        break;
      default:
        break;
    }
    if (ARTIFACT_KINDS.includes(row.kind)) {
      artifacts += 1;
      const project = row.project || "unnamed";
      byProject.set(project, (byProject.get(project) ?? 0) + 1);
    }
    added += row.added;
    removed += row.removed;
  }

  let leading: WorkKpis["leading"] = null;
  if (artifacts > 0) {
    for (const [project, n] of byProject) {
      if (!leading || n > leading.artifacts || (n === leading.artifacts && project < leading.project)) {
        leading = { project, artifacts: n, share: (n / artifacts) * 100 };
      }
    }
  }

  let cost = 0;
  let priced = 0;
  let unpriced = 0;
  let reported = 0;
  for (const card of cards) {
    if (card.cost !== null) {
      cost += card.cost;
      priced += 1;
    }
    unpriced += card.unpriced;
    reported += card.reported;
  }

  return {
    cost: priced > 0 ? cost : null,
    unpriced,
    reported,
    merged,
    mergedFromHistory,
    commits,
    attributedCommits,
    net: added - removed,
    added,
    removed,
    conflictMinutes: coordination.conflictMinutes,
    leading,
  };
}

/* ── invalidation (§3.9) ───────────────────────────────────────────────────*/

/** How close two writes to one path must be to be one churn episode. The same
 *  ten minutes `analytics.rs::CHURN_GAP_MS` chains them with, and the same span
 *  a conflict episode is measured over, so the strip's two readings share a
 *  scale. */
export const CHURN_GAP_MS = 10 * MINUTE;

/** How long attribution waits for a paying card's next request.
 *
 *  **Mirrors `analytics.rs::ATTRIBUTE_WAIT_MS`, which is the lookback.** The
 *  excess is paid at a card's next *start*, so a card roused hours after the
 *  write is the ordinary case rather than an edge; the copy that says
 *  *unmeasured* has to name this bound and must not hardcode a shorter one. */
export const ATTRIBUTE_WAIT_MS = 6 * HOUR;

/** That bound in words, so no surface writes the number twice. */
export function attributeWaitSaid(): string {
  const hours = Math.round(ATTRIBUTE_WAIT_MS / HOUR);
  return hours === 1 ? "an hour" : `${hours} hours`;
}

/** The kinds that are a write to a governing file, and so can churn. */
export const WRITE_KINDS: readonly string[] = ["instructions", "rule"];
/** The kinds that are a move of the funding a cache is keyed by. */
export const SWITCH_KINDS: readonly string[] = ["account", "provider", "model"];

/** The episode a write belongs to: the path, or the rules directory.
 *
 *  The mirror of `analytics.rs::invalidate_key`, and it has to agree with it:
 *  the store groups events for attribution and this groups them for the page. */
export function invalidateKey(kind: string, ref: string): string {
  if (kind !== "rule") return ref;
  const lower = ref.toLowerCase();
  const lead = lower.indexOf("/.claude/rules/");
  /* The needle with a leading slash starts one character before the segment,
     which is the off-by-one that made this answer `…/.claude/rule`. */
  if (lead >= 0) return ref.slice(0, lead + 1 + ".claude/rules".length);
  const bare = lower.indexOf(".claude/rules/");
  return bare >= 0 ? ref.slice(0, bare + ".claude/rules".length) : ref;
}

/** One card that paid for an invalidation, with its excess. */
export type InvalidatePayer = {
  session: string;
  card: string;
  tokens: number;
  /** Priced through `usage.ts`'s rate table at the event's model and instant.
   *  Null when the model has no rate, which is unmeasured rather than free. */
  usd: number | null;
};

/** A run of writes to one path, or one switch, and what it cost. */
export type InvalidateEpisode = {
  /** Identity for a keyed list: tree, key and start. */
  key: string;
  kind: string;
  /** The path as the last write named it, or the account/provider/model. */
  path: string;
  tree: string;
  start: number;
  end: number;
  /** How many writes the episode swallowed. 1 for a switch. */
  writes: number;
  /** The card that made the last write. Empty for a terminal or an unknown. */
  author: string;
  affected: number;
  payers: InvalidatePayer[];
  tokens: number;
  /** **Null is unmeasured, never zero.** A measured episode whose excess was
   *  nothing is 0, and the two are different readings (§9.1). */
  usd: number | null;
  measured: boolean;
};

/** §9.1's invalidation measures, one row per kind. */
export type KindInvalidation = {
  kind: string;
  events: number;
  episodes: number;
  measured: number;
  usd: number | null;
};

export type TreeInvalidation = {
  tree: string;
  /** The directory's last segment, which is what a table can read. */
  label: string;
  events: number;
  episodes: number;
  churnEpisodes: number;
  writes: number;
  impacted: number;
  usd: number | null;
  measured: number;
  last: number;
};

export type Invalidation = {
  episodes: InvalidateEpisode[];
  /** The runs of more than one write: the ones the advice is about. */
  churn: InvalidateEpisode[];
  /** Receipt rows that are a write to an instruction or rule file. */
  events: number;
  /** Receipt rows that are a move. */
  switches: number;
  episodesCount: number;
  /** Episodes that are a write to a governing file. The rest are moves, so a
   *  summary that counts every episode beside a write count reads wrong. */
  writeEpisodes: number;
  churnEpisodes: number;
  churnWriteCount: number;
  tokens: number;
  /** Summed attributed dollars; null when not one event could be measured. */
  usd: number | null;
  /** Episodes whose excess nobody could measure, which is not the same as 0. */
  unmeasured: number;
  byTree: TreeInvalidation[];
  /** The same reading split by kind, which §9.1 asks for beside the tree. */
  byKind: KindInvalidation[];
  /** The excess as a share of the window's spend, or null with no divisor. */
  share: number | null;
  advice: string;
};

/** The one sentence of advice the page may not drop (§3.9), and it is advice
 *  rather than a ban: document the change, and put it where the reader is. */
export const INVALIDATE_ADVICE =
  "a rule under .claude/rules/ is read only when a file it governs is opened, and the wall's standing instructions reach new cards and not live ones. the narrowest of the three fits the change without making every card read again.";

/** Price attributed cache-write tokens through the one rate table.
 *
 *  **Not a second price table.** `usage.ts::rateAt` is the table every other
 *  dollar on this wall is priced from, and 1.25 is the five-minute write
 *  multiplier `modeledUsd` applies; `test/analyticswork.test.ts` holds the two
 *  against each other on a row that carries nothing but a cache write. */
export function cacheWriteUsd(tokens: number, model: string, at: number): number | null {
  if (!Number.isFinite(tokens)) return null;
  const rate = rateAt(model, at);
  if (!rate) return null;
  return (tokens * rate.input * 1.25) / 1e6;
}

/** Fresh input at the model's own input rate: the other bucket a retired
 *  prefix lands in, and the one this machine's probe measured. */
export function inputUsd(tokens: number, model: string, at: number): number | null {
  if (!Number.isFinite(tokens)) return null;
  const rate = rateAt(model, at);
  if (!rate) return null;
  return (tokens * rate.input) / 1e6;
}

/** What one attributed row cost: the two buckets through their own rates. */
export function attributedUsd(tokens: number, inTokens: number, model: string, at: number): number | null {
  const write = cacheWriteUsd(tokens, model, at);
  const input = inputUsd(inTokens, model, at);
  if (write === null && input === null) return null;
  return (write ?? 0) + (input ?? 0);
}

/** Every episode in a window, with the excess its payers were measured against.
 *
 *  **Rows stay per write; the episode is derived here.** Three edits to one
 *  `CLAUDE.md` in ten minutes is one episode and its cost is the excess after
 *  the *last* write, because the earlier ones were overwritten before anybody
 *  read them. A switch is its own episode: there is no run to fold it into.
 */
export function invalidationOf(
  rows: readonly InvalidateRow[],
  spendUsd: number | null,
): Invalidation {
  const receipts = rows.filter((r) => r.provenance === "receipt").sort((a, b) => a.at - b.at);
  const attributed = rows.filter((r) => r.provenance === "attributed");

  const episodes: InvalidateEpisode[] = [];
  const open = new Map<string, InvalidateEpisode>();
  for (const row of receipts) {
    const isWrite = WRITE_KINDS.includes(row.kind);
    const key = isWrite ? invalidateKey(row.kind, row.ref) : `${row.session}\u0000${row.ref}`;
    const group = `${row.tree}\u0000${key}`;
    const prior = isWrite ? open.get(group) : undefined;
    if (prior && row.at - prior.end <= CHURN_GAP_MS) {
      prior.end = row.at;
      prior.path = row.ref;
      prior.writes += 1;
      prior.author = row.card;
      /* **The largest count any write in the run saw**, not the opener's: a card
         that starts five minutes into the run is counted by the later write's
         window and not the first one's. It is still not the union of sessions
         across a long run, because the rows carry counts rather than names. */
      prior.affected = Math.max(prior.affected, row.affected);
      continue;
    }
    const episode: InvalidateEpisode = {
      key: `${group}\u0000${row.at}`,
      kind: row.kind,
      path: row.ref,
      tree: row.tree,
      start: row.at,
      end: row.at,
      writes: 1,
      author: row.card,
      /* The first write's count: its window contains the run, which is what
         makes it the episode's count rather than the last write's. */
      affected: row.affected,
      payers: [],
      tokens: 0,
      usd: null,
      measured: false,
    };
    episodes.push(episode);
    if (isWrite) open.set(group, episode);
  }

  /* Attribution is written at the episode's last write, so that is where a
     payer is looked for. A row at another instant belongs to another episode. */
  for (const episode of episodes) {
    const paid = attributed.filter(
      (r) => r.at === episode.end && r.tree === episode.tree && r.ref === episode.path && r.kind === episode.kind,
    );
    if (!paid.length) continue;
    episode.measured = true;
    const payers = paid.map((r) => ({
      session: r.session,
      card: r.card,
      tokens: r.tokens + r.inTokens,
      usd: r.usd !== 0 ? r.usd : attributedUsd(r.tokens, r.inTokens, r.model, r.at),
    }));
    episode.payers = payers;
    episode.tokens = payers.reduce((n, p) => n + p.tokens, 0);
    const priced = payers.filter((p) => p.usd !== null);
    episode.usd = priced.length === payers.length ? payers.reduce((n, p) => n + (p.usd ?? 0), 0) : null;
    if (episode.usd === null) episode.measured = false;
  }

  const churn = episodes.filter((e) => e.writes > 1);
  const measured = episodes.filter((e) => e.measured);
  const usd = measured.length ? measured.reduce((n, e) => n + (e.usd ?? 0), 0) : null;
  const tokens = measured.reduce((n, e) => n + e.tokens, 0);

  const byTree = new Map<string, TreeInvalidation>();
  for (const episode of episodes) {
    const tree = episode.tree || "no tree";
    const one = byTree.get(tree) ?? {
      tree,
      label: tree === "no tree" ? tree : tree.split(/[\\/]/).filter(Boolean).pop() ?? tree,
      events: 0,
      episodes: 0,
      churnEpisodes: 0,
      writes: 0,
      impacted: 0,
      usd: 0,
      measured: 0,
      last: 0,
    };
    one.episodes += 1;
    one.writes += episode.writes;
    one.events += episode.writes;
    if (episode.writes > 1) one.churnEpisodes += 1;
    one.impacted = Math.max(one.impacted, episode.affected);
    if (episode.measured) {
      one.measured += 1;
      one.usd = (one.usd ?? 0) + (episode.usd ?? 0);
    }
    one.last = Math.max(one.last, episode.end);
    byTree.set(tree, one);
  }

  const kinds = new Map<string, KindInvalidation>();
  for (const episode of episodes) {
    const one = kinds.get(episode.kind) ?? { kind: episode.kind, events: 0, episodes: 0, measured: 0, usd: 0 };
    one.episodes += 1;
    one.events += episode.writes;
    if (episode.measured) {
      one.measured += 1;
      one.usd = (one.usd ?? 0) + (episode.usd ?? 0);
    }
    kinds.set(episode.kind, one);
  }

  return {
    episodes,
    churn,
    events: receipts.filter((r) => WRITE_KINDS.includes(r.kind)).length,
    switches: receipts.filter((r) => SWITCH_KINDS.includes(r.kind)).length,
    episodesCount: episodes.length,
    writeEpisodes: episodes.filter((e) => WRITE_KINDS.includes(e.kind)).length,
    churnEpisodes: churn.length,
    churnWriteCount: churn.reduce((n, e) => n + e.writes, 0),
    tokens,
    usd,
    unmeasured: episodes.length - measured.length,
    byTree: [...byTree.values()]
      .map((t) => ({ ...t, usd: t.measured ? t.usd : null }))
      .sort((a, b) => b.events - a.events || a.tree.localeCompare(b.tree)),
    byKind: [...kinds.values()]
      .map((k) => ({ ...k, usd: k.measured ? k.usd : null }))
      .sort((a, b) => b.events - a.events || a.kind.localeCompare(b.kind)),
    share: usd !== null && spendUsd !== null && spendUsd > 0 ? usd / spendUsd : null,
    advice: INVALIDATE_ADVICE,
  };
}

/** What an episode is called in a table or a hover, without a wall of path. */
export function episodeLabel(episode: InvalidateEpisode): string {
  if (episode.kind === "account") return episode.path || "its own sign-in";
  if (episode.kind === "provider") return episode.path || "an unnamed provider";
  if (episode.kind === "model") return episode.path || "an unnamed model";
  const parts = episode.path.split(/[\\/]/).filter(Boolean);
  const tail = parts.slice(-2).join("/");
  return tail || episode.path || "an unnamed file";
}

/** The author of an episode, named where the wall can name it. */
export function episodeAuthor(episode: InvalidateEpisode, names?: ReadonlyMap<string, string>): string {
  return labelOf(episode.author, names);
}

/* ── the prose ─────────────────────────────────────────────────────────────*/

/** The one sentence no skin is allowed to drop. It is the page's caveat and
 *  the room's footnote, kept here so they cannot drift. */
export const WORK_CAVEAT =
  "design, review and a question answered well produce no artifact. a card with none is drawn as no artifact, never as zero output, and nothing here ranks people.";

export type WorkStoryState = "nothing" | "no-artifacts" | "normal";

export type WorkFact = { label: string; value: string; note: string; off: boolean };

/** A net figure with its sign. **`count` reads any negative as `0`** (`usage.ts`
 *  clamps at zero), so a cleanup card whose net is -40 printed as `0` everywhere
 *  this prefixed only a `+`. One helper, used by both skins. */
export function signed(n: number): string {
  return `${n < 0 ? "-" : "+"}${count(Math.abs(n))}`;
}

export type WorkStory = {
  state: WorkStoryState;
  lede: string;
  facts: WorkFact[];
  sections: { id: "bought" | "coordination" | "reread" | "cannot"; title: string; body: string }[];
  empty: boolean;
};

export type WorkStoryInput = {
  span: string;
  rows: readonly WorkRow[];
  kpis: WorkKpis;
  coordination: Coordination;
  bands: readonly OverlapBand[];
  /** True when the pair listing failed while the rest answered. */
  overlapsUnread?: boolean;
  scratch: {
    /** True when the store has recorded nothing at all, which is the
     *  collector's first minute rather than a quiet week. */
    never: boolean;
    recorded: number;
    first: number | null;
    /** True when the spend read answered for an empty window, which is the
     *  only state in which `recorded` and `first` were computed at all
     *  (`analytics.rs` answers them for an empty window and nothing else).
     *  Without it the prose must not claim what is on record elsewhere. */
    outsideKnown?: boolean;
  };
  /** §3.9's invalidation reading. Optional so a caller that has no rows (a
   *  suite, an older build's command) draws nothing rather than a zero. */
  invalidation?: Invalidation;
};

function spanSaid(span: string): string {
  return SPANS.find((s) => s.span === span)?.said ?? `the last ${span}`;
}

function usdText(v: number | null): string {
  return v === null || !Number.isFinite(v) ? "an unpriced window" : money(v);
}

function linesText(net: number): string {
  return signed(net);
}

function plural(n: number, one: string, many: string): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

/** Which template the prose uses. The three states are facts about the window,
 *  not tones. */
export function workStoryState(input: WorkStoryInput): WorkStoryState {
  if (input.rows.length > 0) return "normal";
  return input.kpis.cost !== null && input.kpis.cost > 0 ? "no-artifacts" : "nothing";
}

export function workStoryOf(input: WorkStoryInput): WorkStory {
  const state = workStoryState(input);
  const { kpis, coordination, bands } = input;
  const when = spanSaid(input.span);
  const empty = state === "nothing";

  const facts: WorkFact[] = [
    {
      label: "cost",
      value: usdText(kpis.cost),
      note:
        kpis.cost === null
          ? kpis.unpriced > 0
            ? `${count(kpis.unpriced)} spend rows unpriced`
            : "no spend recorded"
          : kpis.unpriced > 0
            ? `${count(kpis.unpriced)} spend rows unpriced`
            : kpis.reported > 0
              ? "modeled and reported"
              : "modeled",
      off: kpis.cost === null,
    },
    {
      label: "merged",
      value: count(kpis.merged),
      note:
        kpis.mergedFromHistory > 0
          ? `${count(kpis.mergedFromHistory)} attributed from history`
          : "merge receipts",
      off: false,
    },
    {
      label: "commits",
      value: count(kpis.commits),
      note:
        kpis.attributedCommits > 0
          ? `${count(kpis.attributedCommits)} attributed from history`
          : "from receipts",
      off: false,
    },
    {
      label: "net lines",
      value: signed(kpis.net),
      note: `${count(kpis.added)} added, ${count(kpis.removed)} removed`,
      off: false,
    },
    {
      label: "conflict minutes",
      value: count(Math.round(kpis.conflictMinutes)),
      note: coordination.episodes.length
        ? plural(coordination.episodes.length, "episode", "episodes")
        : "none recorded",
      off: false,
    },
    {
      label: "leading project",
      value: kpis.leading?.project ?? "",
      note: kpis.leading?.share != null ? `${Math.round(kpis.leading.share)}% of artifacts` : "no artifacts to lead",
      off: kpis.leading === null,
    },
  ];

  let lede: string;
  if (state === "nothing") {
    if (!input.scratch.never) {
      const since = input.scratch.first !== null ? `, on a wall recording since ${new Date(input.scratch.first).toLocaleDateString("en-GB")}` : "";
      /* The count outside the window is only sayable when the spend read
         answered an empty window: on a window with rows in it, `recorded` is
         zero by construction, and "0 requests on record" would be a made-up
         fact rather than a reading. */
      const outside =
        input.scratch.outsideKnown && input.scratch.recorded > 0
          ? ` ${plural(input.scratch.recorded, "request is", "requests are")} on record outside this window.`
          : "";
      lede = `nothing was recorded in ${when}${since}.${outside}`;
    } else {
      lede = `nothing has been recorded yet. volery starts writing facts about a minute after it opens.`;
    }
  } else if (state === "no-artifacts") {
    lede = `${when} cost ${usdText(kpis.cost)} and produced no artifact. ${WORK_CAVEAT}`;
  } else {
    const merges = kpis.merged > 0 ? ` and ${plural(kpis.merged, "merge", "merges")}` : "";
    const cost = kpis.cost !== null ? ` cost ${usdText(kpis.cost)}` : " could not be priced";
    lede = `${when}${cost} for ${plural(kpis.commits, "commit", "commits")}${merges}, ${linesText(kpis.net)} net lines.`;
    if (coordination.conflictMinutes > 0) {
      lede += ` ${plural(Math.round(coordination.conflictMinutes), "minute", "minutes")} went to ${plural(coordination.episodes.length, "conflict", "conflicts")}.`;
    }
  }

  const bought: string[] = [];
  if (kpis.commits > 0 || kpis.merged > 0) {
    const parts = [
      kpis.commits > 0 ? plural(kpis.commits, "commit", "commits") : "",
      kpis.merged > 0 ? plural(kpis.merged, "merge", "merges") : "",
    ].filter(Boolean);
    bought.push(`the window produced ${parts.join(" and ")}, ${linesText(kpis.net)} net lines across ${plural(kpis.added + kpis.removed, "changed line", "changed lines")}.`);
  } else {
    bought.push("no commit or merge landed in this window.");
  }
  const perCommit = kpis.cost !== null && kpis.commits > 0 ? money(kpis.cost / kpis.commits) : null;
  const perMerge = kpis.cost !== null && kpis.merged > 0 ? money(kpis.cost / kpis.merged) : null;
  if (perCommit !== null || perMerge !== null) {
    const clauses = [
      perCommit !== null ? `${perCommit} a commit` : "",
      perMerge !== null ? `${perMerge} a merge` : "",
    ].filter(Boolean);
    bought.push(`that is ${clauses.join(" and ")} where a divisor exists.`);
  } else if (kpis.cost !== null) {
    bought.push("there is no commit or merge to divide the cost by, so no unit price is drawn.");
  }

  const coordinationBody: string[] = [];
  if (coordination.conflictMinutes > 0) {
    coordinationBody.push(
      `${plural(Math.round(coordination.conflictMinutes), "minute", "minutes")} across ${plural(coordination.episodes.length, "conflict episode", "conflict episodes")}`,
    );
    if (coordination.coordinationUsd !== null) {
      coordinationBody.push(`, ${money(coordination.coordinationUsd)} of the cards' own burn.`);
    } else {
      coordinationBody.push(", and no card's burn could be priced, so there are no dollars beside them.");
    }
    if (coordination.unpricedMinutes > 0) {
      coordinationBody.push(` ${plural(Math.round(coordination.unpricedMinutes), "minute", "minutes")} belong to cards with no priced spend and are left out of the dollars.`);
    }
  } else {
    coordinationBody.push("no conflict was recorded in this window.");
  }
  const shared = bands.reduce((n, b) => n + b.minutes, 0);
  if (bands.length > 0) {
    coordinationBody.push(
      ` ${plural(bands.length, "pair", "pairs")} of cards touched the same files for ${plural(Math.round(shared), "minute", "minutes")} in total.`,
    );
  }
  if (input.overlapsUnread) {
    coordinationBody.push(" the pair listing could not be read for this span, so the bands are missing rather than absent.");
  }

  /* §3.9's invalidation half, said in the same breath as coordination because
     it is the other way parallel work spends money on itself. **The summary is
     events, episodes and dollars or the word *unmeasured***: a window with no
     attributed row is not a window that cost nothing. */
  const inv = input.invalidation;
  const rereadBody = inv
    ? inv.events + inv.switches === 0
      ? `nothing was recorded in ${when}: no instruction file was written and no card moved account, provider or model.`
      : (() => {
          const parts = [
            `${plural(inv.events, "write to an instruction or rule file", "writes to instruction and rule files")} in ${plural(inv.writeEpisodes, "episode", "episodes")}`,
            inv.churnEpisodes > 0
              ? `${plural(inv.churnEpisodes, "churn run", "churn runs")} swallowed ${plural(inv.churnWriteCount, "write", "writes")}`
              : "",
            inv.switches > 0 ? `${plural(inv.switches, "move", "moves")} of account, provider or model` : "",
          ].filter(Boolean);
          const dollars =
            inv.usd === null
              ? "the excess could not be measured on any paying card, so no dollar figure is drawn rather than a zero"
              : `${money(inv.usd)} of excess re-reading${inv.share !== null ? `, ${Math.round(inv.share * 100)}% of the window's spend` : ""}`;
          const unmeasured =
            inv.unmeasured > 0 && inv.usd !== null
              ? ` ${plural(inv.unmeasured, "episode", "episodes")} left unmeasured.`
              : "";
          return `${parts.join(", ")}: ${dollars}.${unmeasured} ${INVALIDATE_ADVICE}`;
        })()
    : `the invalidation reading did not answer for ${when}, so nothing is claimed about re-reading.`;


  return {
    state,
    lede,
    facts,
    sections: empty
      ? []
      : [
          { id: "bought", title: "what it bought", body: bought.join(" ") },
          { id: "coordination", title: "what coordination cost", body: coordinationBody.join("") },
          { id: "reread", title: "what re-reading cost", body: rereadBody },
          { id: "cannot", title: "what this cannot see", body: WORK_CAVEAT },
        ],
    empty,
  };
}

/* ── the model both skins draw ─────────────────────────────────────────────*/

export type WorkModel = {
  kpis: WorkKpis;
  cards: CardWork[];
  scatter: Scatter;
  panels: WorkPanels;
  episodes: ConflictEpisode[];
  coordination: Coordination;
  invalidations: Invalidation;
  bars: CardBar[];
  bands: OverlapBand[];
  overlapsUnread: boolean;
  invalidationsUnread: boolean;
  story: WorkStory;
  caveat: string;
  empty: boolean;
};

export type WorkModelInput = {
  rows: readonly WorkRow[];
  series: WorkSeries;
  overlaps: readonly PairOverlap[];
  invalidations?: readonly InvalidateRow[];
  overlapsUnread?: boolean;
  invalidationsUnread?: boolean;
  names?: ReadonlyMap<string, string>;
  measure: ScatterMeasure;
  from: number;
  to: number;
  span: string;
  scratch: WorkStoryInput["scratch"];
};

/** Everything the work tab draws, in one value, built once.
 *
 *  Both presentations are handed this: the room draws the panels, the scatter
 *  and the strip from it, and the page draws the lede, one figure, the same
 *  table and the same caveat. **They cannot disagree**, because neither sums
 *  anything of its own. */
export function workModelOf(input: WorkModelInput): WorkModel {
  const series = input.series;
  const cards = cardWorkOf({ rows: input.rows, series, names: input.names, from: input.from, to: input.to });
  const episodes = conflictEpisodes(input.rows);
  const coordination = coordinationOf(episodes, cards);
  const kpis = kpisOf(input.rows, cards, coordination);
  const panels = panelsOf(series);
  const bars = barsOf(cards, series, input.from, input.to);
  const bands = bandsOf(input.overlaps, cards, input.from, input.to);
  const invalidations = invalidationOf(input.invalidations ?? [], kpis.cost);
  const story = workStoryOf({
    span: input.span,
    rows: input.rows,
    kpis,
    coordination,
    bands,
    overlapsUnread: input.overlapsUnread,
    invalidation: invalidations,
    scratch: input.scratch,
  });
  return {
    kpis,
    cards,
    scatter: scatterOf(cards, input.measure),
    panels,
    episodes,
    coordination,
    invalidations,
    invalidationsUnread: input.invalidationsUnread === true,
    bars,
    bands,
    overlapsUnread: input.overlapsUnread === true,
    story,
    caveat: WORK_CAVEAT,
    empty: story.empty,
  };
}

/* ── saying the small things ───────────────────────────────────────────────*/

/** A ratio with no divisor is a dash, never a zero (§9.1). */
export function ratioText(value: number | null, form: (v: number) => string): string {
  return value === null || !Number.isFinite(value) ? "" : form(value);
}
