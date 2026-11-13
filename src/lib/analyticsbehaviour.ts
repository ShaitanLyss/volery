/* Behaviour, not only spend: how the wall is worked (§9.7, §11.9).
 *
 * Three readings, one tab. Tools and MCP servers answer what the wall spends
 * its time on and where it fails; skills and agents answer what is invoked
 * rather than what it costs; habits answer how the work is shaped, which is
 * the "spawning tendencies, parallel agents tendencies" question.
 *
 * The tool side reads `tool_hour`, not `tool_fact`, and that is a choice about
 * honesty rather than about size. The fine tier is pruned at ninety days while
 * the rollup is kept, and the rollup counts *calls* into five latency bands
 * instead of storing a sample per call. `analytics.ts::latency` already knows
 * which grain it was handed and labels a band percentile an estimate, so a
 * month answers "about p95 = 1.2s" and says so rather than pretending to a
 * median over calls it no longer has.
 *
 * Rules carried from the document:
 *
 *  - **A server column is empty for a built-in, never guessed** (§11.9). An
 *    MCP name is `mcp__<server>__<tool>`, so the server is already a column on
 *    the row; a built-in has none and says nothing.
 *  - **Invoked and attributed are different questions.** Only the invoked half
 *    is recorded, so only it is drawn, and the face says what is missing rather
 *    than adding a zero to it (§9.7).
 *  - **A ratio whose divisor is zero is null, never 0** (§9.1).
 *  - **Cost per call is apportioned from the turn and says so.** `turnUsd` on
 *    a rollup row is the turn's cost divided across its calls by the fold, so
 *    a sum over the window is the spend and never a hidden meter (§11.9).
 *
 * Pure: no Tauri, no runes. Tested in `test/analyticsbehaviour.test.ts`.
 */

import { SERIES_ALL_PAIRS, latency, type LatencyReading, type ToolKind, type ToolTotal } from "./analytics";
import type { InvalidateRow } from "./analyticswork";
import { addDays, dayKey, startOfDay } from "./analyticstrace";
import { count, money } from "./usage";

const DAY = 86_400_000;

/* ── the rows, as the commands answer them ─────────────────────────────────*/

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const KINDS: readonly ToolKind[] = ["builtin", "mcp", "skill", "agent"];

/** A kind this build does not know reads as `builtin` rather than dropping the
 *  row: the calls happened, and losing them is the worse error of the two. */
function kindOf(raw: string): ToolKind {
  return (KINDS as readonly string[]).includes(raw) ? (raw as ToolKind) : "builtin";
}

/** One tool's totals over the window, normalised. A row with no tool name is
 *  dropped — it cannot be grouped under anything and would draw as a nameless
 *  line. */
export function asToolTotals(raw: unknown): ToolTotal[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolTotal[] = [];
  for (const one of raw) {
    const r = obj(one);
    if (!r) continue;
    const tool = str(r.tool);
    if (!tool) continue;
    out.push({
      kind: kindOf(str(r.kind)),
      server: str(r.server),
      tool,
      target: str(r.target),
      calls: num(r.calls),
      errors: num(r.errors),
      receipts: num(r.receipts),
      msTotal: num(r.msTotal),
      msUnder50: num(r.msUnder50),
      msUnder200: num(r.msUnder200),
      msUnder1s: num(r.msUnder1s),
      msUnder5s: num(r.msUnder5s),
      msOver5s: num(r.msOver5s),
      outBytes: num(r.outBytes),
      turnUsd: num(r.turnUsd),
    });
  }
  return out;
}

/** One session, whole: who opened it, what it spent on, and how long it lived.
 *
 * `opened_by` keeps its three states. A session with no lineage record is
 * `unknown` and is drawn as its own slice rather than folded into *person*,
 * because a spawn attributed to nobody is a fact about the record (§9.7). */
export type SessionFact = {
  session: string;
  host: string;
  project: string;
  source: string;
  /** `''` for a terminal session, which has no card behind it. */
  card: string;
  parentCard: string;
  openedBy: string;
  branch: string;
  startedAt: number;
  endedAt: number | null;
  cliMin: string;
  cliMax: string;
  accountFirst: string;
  accountLast: string;
  providerFirst: string;
  providerLast: string;
  turns: number;
};

export function asSessionFacts(raw: unknown): SessionFact[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionFact[] = [];
  for (const one of raw) {
    const r = obj(one);
    if (!r) continue;
    const session = str(r.session);
    const startedAt = num(r.startedAt);
    if (!session || !(startedAt > 0)) continue;
    const end = r.endedAt === null || r.endedAt === undefined ? null : num(r.endedAt);
    out.push({
      session,
      host: str(r.host),
      project: str(r.project),
      source: str(r.source),
      card: str(r.card),
      parentCard: str(r.parentCard),
      openedBy: r.openedBy === "person" || r.openedBy === "agent" ? r.openedBy : "unknown",
      branch: str(r.branch),
      startedAt,
      endedAt: end && end > 0 ? end : null,
      cliMin: str(r.cliMin),
      cliMax: str(r.cliMax),
      accountFirst: str(r.accountFirst),
      accountLast: str(r.accountLast),
      providerFirst: str(r.providerFirst),
      providerLast: str(r.providerLast),
      turns: num(r.turns),
    });
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

/* ── the tools, grouped the way the four views ask ─────────────────────────*/

/** The four tables are one table with a different key. `tools` is every call
 *  and is where a built-in's empty server is visible; `servers` is MCP only,
 *  because that is the only kind with a server to be a row of. */
export type ToolView = "tools" | "servers" | "skills" | "agents";

export const TOOL_VIEWS: readonly { key: ToolView; label: string; said: string }[] = [
  { key: "tools", label: "tools", said: "every call, built-in and mcp in one table" },
  { key: "servers", label: "servers", said: "one row per mcp server" },
  { key: "skills", label: "skills", said: "explicit skill calls, by name" },
  { key: "agents", label: "agents", said: "agent and task calls, by subagent" },
];

export type ToolSort =
  | "name"
  | "calls"
  | "errors"
  | "errorRate"
  | "p50"
  | "p95"
  | "bytes"
  | "cost";

export type ToolColumn = {
  key: ToolSort;
  label: string;
  /** The column's head when the room is narrow; the full word in the title. */
  short: string;
  numeric: boolean;
  views: readonly ToolView[];
};

/** One table, four readings. Every view shows the same measures, because a
 *  skill call and a subagent are calls like any other; what changes is the key
 *  rows are grouped by. `views` is kept so a future reading can show fewer
 *  columns without a second table. */
export const TOOL_COLUMNS: readonly ToolColumn[] = [
  { key: "name", label: "name", short: "name", numeric: false, views: ["tools", "servers", "skills", "agents"] },
  { key: "calls", label: "calls", short: "calls", numeric: true, views: ["tools", "servers", "skills", "agents"] },
  { key: "errors", label: "errors", short: "err", numeric: true, views: ["tools", "servers", "skills", "agents"] },
  { key: "errorRate", label: "error rate", short: "err%", numeric: true, views: ["tools", "servers", "skills", "agents"] },
  { key: "p50", label: "p50", short: "p50", numeric: true, views: ["tools", "servers", "skills", "agents"] },
  { key: "p95", label: "p95", short: "p95", numeric: true, views: ["tools", "servers", "skills", "agents"] },
  { key: "bytes", label: "result", short: "bytes", numeric: true, views: ["tools", "servers", "skills", "agents"] },
  { key: "cost", label: "apportioned", short: "cost", numeric: true, views: ["tools", "servers", "skills", "agents"] },
];

export function columnsFor(view: ToolView): ToolColumn[] {
  return TOOL_COLUMNS.filter((c) => c.views.includes(view));
}

/** One line of the table: a tool and its server, or a server, or a skill, or a
 *  subagent — whichever the view grouped by. `rows` is kept because a
 *  percentile needs the bands and a second query would be a second read of the
 *  same window. */
export type ToolLine = {
  /** Stable within one model; used as the row key. */
  key: string;
  kind: ToolKind;
  /** `''` for a built-in, and the face prints nothing there. */
  server: string;
  /** What the row is called: the tool, the server, the skill, the subagent. */
  name: string;
  calls: number;
  errors: number;
  receipts: number;
  bytes: number;
  cost: number;
  /** Null when nothing was called, never 0 (§9.1). */
  errorRate: number | null;
  p50: LatencyReading | null;
  p95: LatencyReading | null;
  rows: ToolTotal[];
};

/** The rows one view groups by. A skill's name is the row's `target`, not its
 *  tool name (`Skill` is every skill's tool name); an agent's is the subagent
 *  type, with the tool name as the fallback when the input carried none. */
function grouped(rows: readonly ToolTotal[], view: ToolView): Map<string, ToolTotal[]> {
  const groups = new Map<string, ToolTotal[]>();
  for (const row of rows) {
    let key: string | null = null;
    if (view === "tools") key = `${row.kind}\u0000${row.server}\u0000${row.tool}`;
    else if (view === "servers") key = row.kind === "mcp" ? row.server || "unnamed server" : null;
    else if (view === "skills") key = row.kind === "skill" ? row.target || row.tool : null;
    else key = row.kind === "agent" ? row.target || row.tool : null;
    if (key === null) continue;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

/** Group the window's rollups into table lines, unsorted and stable across a
 *  sort: the caller sorts a copy, so a click on a column head cannot reorder
 *  the scatter's colours. */
export function toolLines(rows: readonly ToolTotal[], view: ToolView): ToolLine[] {
  const out: ToolLine[] = [];
  for (const [key, group] of grouped(rows, view)) {
    let calls = 0;
    let errors = 0;
    let receipts = 0;
    let bytes = 0;
    let cost = 0;
    for (const row of group) {
      calls += row.calls;
      errors += row.errors;
      receipts += row.receipts;
      bytes += row.outBytes;
      cost += row.turnUsd;
    }
    const first = group[0];
    const name =
      view === "tools"
        ? first.tool
        : view === "servers"
          ? first.server || "unnamed server"
          : first.target || first.tool;
    out.push({
      key,
      kind: first.kind,
      server: first.server,
      name,
      calls,
      errors,
      receipts,
      bytes,
      cost,
      errorRate: calls > 0 ? errors / calls : null,
      p50: latency(group, 0.5),
      p95: latency(group, 0.95),
      rows: group,
    });
  }
  return out.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

/** A sorted copy. A null (a percentile nothing completed, a rate with no
 *  calls) sorts last whichever direction is asked for, because a dash at the
 *  top of an descending order is a reader asking why. */
export function sortToolLines(lines: readonly ToolLine[], key: ToolSort, dir: "asc" | "desc" = "desc"): ToolLine[] {
  const value = (line: ToolLine): number | string | null => {
    switch (key) {
      case "name":
        return line.name.toLowerCase();
      case "calls":
        return line.calls;
      case "errors":
        return line.errors;
      case "errorRate":
        return line.errorRate;
      case "p50":
        return line.p50?.ms ?? null;
      case "p95":
        return line.p95?.ms ?? null;
      case "bytes":
        return line.bytes;
      case "cost":
        return line.cost;
    }
  };
  const sign = dir === "asc" ? 1 : -1;
  return [...lines].sort((a, b) => {
    const av = value(a);
    const bv = value(b);
    if (av === null && bv === null) return a.name.localeCompare(b.name);
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === "string" || typeof bv === "string") {
      return sign * String(av).localeCompare(String(bv));
    }
    return sign * (av - bv) || a.name.localeCompare(b.name);
  });
}

/** One dot on the latency-against-failures scatter. */
export type ServerPoint = {
  server: string;
  calls: number;
  errors: number;
  errorRate: number | null;
  /** The x axis. p95 rather than p50, because the tail is what a card feels. */
  p95: number | null;
  /** `0`, `1`, `2` for the three loudest *drawn* servers and `-1` for the
   *  rest, which fold to one muted tone. Assigned from the window's server set
   *  by call count, so sorting the table cannot repaint the scatter (§10); a
   *  filter would have to lift this assignment into the model, which is why the
   *  tab has none. */
  slot: number;
};

/** The scatter's points, out of the same lines the table drew. Only a server
 *  with a latency reading can be placed; one whose calls never completed is in
 *  the table and not on the chart, which the face says. **A slot is spent only
 *  on a server that is drawn**, or a failing server would take one of the three
 *  names from a plotted neighbour that then had no label. */
export function serverPoints(rows: readonly ToolTotal[]): { points: ServerPoint[]; unplaced: number } {
  const lines = toolLines(rows, "servers").sort((a, b) => a.name.localeCompare(b.name));
  const placeable = lines.filter((line) => line.p95 !== null);
  const loudest = [...placeable].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  const slots = new Map<string, number>();
  loudest.slice(0, SERIES_ALL_PAIRS).forEach((line, i) => slots.set(line.key, i));
  const points: ServerPoint[] = placeable.map((line) => ({
    server: line.name,
    calls: line.calls,
    errors: line.errors,
    errorRate: line.errorRate,
    p95: line.p95?.ms ?? null,
    slot: slots.get(line.key) ?? -1,
  }));
  return { points, unplaced: lines.length - placeable.length };
}

/* ── the strip ─────────────────────────────────────────────────────────────*/

export type ToolKpis = {
  calls: number;
  errors: number;
  errorRate: number | null;
  p50: LatencyReading | null;
  p95: LatencyReading | null;
  bytes: number;
  cost: number;
  /** Distinct tools that were called, built-in and mcp together. */
  tools: number;
  /** Distinct mcp servers, which is the count the servers view draws. */
  servers: number;
};

/** The window's headline figures, over the same rows the tables group. A rate
 *  is total errors over total calls and never a sum of the lines' rates, and
 *  the percentile comes off the whole distribution rather than a mean of
 *  per-tool percentiles (§9.1). */
export function toolKpis(rows: readonly ToolTotal[]): ToolKpis {
  let calls = 0;
  let errors = 0;
  let bytes = 0;
  let cost = 0;
  const tools = new Set<string>();
  const servers = new Set<string>();
  for (const row of rows) {
    calls += row.calls;
    errors += row.errors;
    bytes += row.outBytes;
    cost += row.turnUsd;
    tools.add(`${row.kind}\u0000${row.server}\u0000${row.tool}`);
    if (row.kind === "mcp" && row.server) servers.add(row.server);
  }
  return {
    calls,
    errors,
    errorRate: calls > 0 ? errors / calls : null,
    p50: latency(rows, 0.5),
    p95: latency(rows, 0.95),
    bytes,
    cost,
    tools: tools.size,
    servers: servers.size,
  };
}

/* ── habits: what the wall does, rather than what it cost ──────────────────*/

export type Slice = { label: string; value: number; share: number | null };

/** A slice list with shares of the whole, biggest first. A label that is empty
 *  is named rather than dropped, so the shares still sum to the whole. */
export function slices(pairs: readonly [string, number][], emptyLabel = "unknown"): Slice[] {
  const merged = new Map<string, number>();
  for (const [label, value] of pairs) {
    const named = label || emptyLabel;
    merged.set(named, (merged.get(named) ?? 0) + value);
  }
  let total = 0;
  for (const value of merged.values()) total += value;
  return [...merged.entries()]
    .map(([label, value]) => ({ label, value, share: total > 0 ? value / total : null }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

export type SpawnDay = {
  /** `YYYY-MM-DD`, local. */
  day: string;
  at: number;
  person: number;
  agent: number;
  unknown: number;
  total: number;
};

export type HabitModel = {
  /** Sessions overlapping the window, of every source. */
  sessions: number;
  /** Sessions the wall itself opened: `source = card`, which is the doc's
   *  `spawns` measure. A renewal is another session and counts again. */
  spawns: number;
  byOpener: Slice[];
  byProject: Slice[];
  byProvider: Slice[];
  /** One entry per local day the window covers, zero-filled, oldest first. */
  days: SpawnDay[];
  perDay: number | null;
  /** Cards working at once: the peak and the mean over the window. */
  peakConcurrent: number;
  meanConcurrent: number | null;
  /** `Agent`/`Task` calls in the window, and them per card-session that was
   *  working in it. The denominator is every card session overlapping the
   *  window, not only the ones opened inside it: an old card that ran a fan-out
   *  this morning is part of both the numerator and the denominator. */
  agentCalls: number;
  fanOut: number | null;
  /** Account, provider and model moves. A move is one row however many
   *  dimensions it changed (§3.9), so this is a count of moves. */
  swaps: number;
  swapCards: number;
};

/** How many sessions were open at once, from their intervals, clipped to the
 *  window. A sweep rather than a pairwise pass: the wall's whole history is a
 *  few thousand sessions and the pairwise form is quadratic (§19).
 *
 *  An open session ends at the window's edge, the same rule the coordination
 *  strip draws with. The mean is the area under the curve over the window's
 *  length, which is the average number of cards working — not the average of
 *  the per-session durations, which is a different and larger number. */
export function concurrency(sessions: readonly SessionFact[], from: number, to: number): { peak: number; mean: number | null } {
  if (to <= from) return { peak: 0, mean: null };
  const edges: { at: number; delta: number }[] = [];
  for (const s of sessions) {
    const start = Math.max(from, s.startedAt);
    const end = Math.min(to, s.endedAt ?? to);
    if (end <= start) continue;
    edges.push({ at: start, delta: 1 }, { at: end, delta: -1 });
  }
  if (edges.length === 0) return { peak: 0, mean: 0 };
  /* An end sorts before a start at the same instant: a card that finished at
     16:00 and one that opened at 16:00 were never working together. */
  edges.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let live = 0;
  let peak = 0;
  let area = 0;
  let prev = edges[0].at;
  for (const edge of edges) {
    area += live * (edge.at - prev);
    live += edge.delta;
    prev = edge.at;
    if (live > peak) peak = live;
  }
  return { peak, mean: area / (to - from) };
}

/** The days the window covers, zero-filled. The strip draws every day
 *  including the quiet ones, because a gap in a bar chart reads as an outage
 *  rather than as a day off.
 *
 *  **The window is half-open, like the command's own.** A day that starts at
 *  the window's end is not a day it contains, and including it would add a
 *  phantom bar and divide the per-day rate by one day too many. */
/** A window is at most the year this surface offers; a thousand days is a guard
 *  against a malformed one walking for ever, never a limit a span reaches. */
const MAX_DAYS = 1_000;

function dayFrames(sessions: readonly SessionFact[], from: number, to: number): SpawnDay[] {
  const byDay = new Map<string, SpawnDay>();
  const first = startOfDay(from);
  let drawn = 0;
  for (let at = first; at < to && drawn < MAX_DAYS; at = addDays(at, 1), drawn += 1) {
    const day = dayKey(at);
    byDay.set(day, { day, at, person: 0, agent: 0, unknown: 0, total: 0 });
  }
  for (const s of sessions) {
    /* Bounded by the window as well as by the day, so the bars reconcile with
       the headline: a spawn the window did not contain is not on a bar either,
       even when it falls on one of the window's own days. */
    if (s.source !== "card" || s.startedAt < from || s.startedAt >= to) continue;
    const frame = byDay.get(dayKey(s.startedAt));
    if (!frame) continue;
    if (s.openedBy === "person") frame.person += 1;
    else if (s.openedBy === "agent") frame.agent += 1;
    else frame.unknown += 1;
    frame.total += 1;
  }
  return [...byDay.values()].sort((a, b) => a.at - b.at);
}

/** Whether a change row is a move between fundings. `invalidate_fact` also
 *  carries file invalidations, which are a different subject. */
export function isSwap(change: Pick<InvalidateRow, "kind">): boolean {
  return change.kind === "account" || change.kind === "provider" || change.kind === "model";
}

export function habitModel(
  sessions: readonly SessionFact[],
  tools: readonly ToolTotal[],
  changes: readonly InvalidateRow[],
  from: number,
  to: number,
): HabitModel {
  /* **A spawn is an opening inside the window**, which is not the same set as
     the sessions the window overlaps. The command returns a session that began
     last week and is still running because its spend and its bar belong to this
     window; it was not opened in it, and counting it would put a spawn on a day
     whose bar does not hold one. */
  const spawns = sessions.filter((s) => s.source === "card" && s.startedAt >= from && s.startedAt < to);
  /* A window that does not run forwards has no days to fill and no spawns to
     count; it is answered rather than thrown at `dayFrames`. */
  const days = to > from ? dayFrames(sessions, from, to) : [];
  const spawned = spawns.length;
  const agentCalls = tools.reduce((sum, row) => sum + (row.kind === "agent" ? row.calls : 0), 0);
  const swaps = changes.filter(isSwap);
  const moved = new Set<string>();
  for (const row of swaps) if (row.card) moved.add(row.card);
  /* **Cards working at once means cards**, not every session the window
     overlaps: an adopted terminal session has no card and is drawn on no
     coordination strip of this wall's. */
  const cardSessions = sessions.filter((s) => s.source === "card");
  const { peak, mean } = concurrency(cardSessions, from, to);
  /* Per *day*, not per calendar day touched: a 24-hour window spans two dates
     once you count the boundary, and dividing by two halved the rate. */
  const windowDays = to > from ? (to - from) / DAY : 0;
  return {
    sessions: sessions.length,
    spawns: spawned,
    byOpener: slices(spawns.map((s) => [s.openedBy, 1] as [string, number])),
    byProject: slices(spawns.map((s) => [s.project, 1] as [string, number])),
    /* The provider a session *last* spent on, because a card that moved is a
       card whose work mostly happened after the move. `unknown` is the real
       value for a funding that never resolved and is said as itself, never
       guessed at. */
    byProvider: slices(spawns.map((s) => [s.providerLast || s.providerFirst, 1] as [string, number])),
    days,
    perDay: windowDays > 0 ? spawned / windowDays : null,
    peakConcurrent: peak,
    meanConcurrent: mean,
    agentCalls,
    /* Every card session in the window, because the numerator counts agent
       calls made by all of them — an old card can fan out this morning. */
    fanOut: cardSessions.length > 0 ? agentCalls / cardSessions.length : null,
    swaps: swaps.length,
    swapCards: moved.size,
  };
}

/* ── saying it ─────────────────────────────────────────────────────────────*/

/** A duration, at the resolution its size deserves. Never a decimal on a
 *  millisecond: the bands interpolate, and `812.4ms` claims precision the data
 *  does not have. */
export function msSaid(ms: number): string {
  if (!(ms >= 0) || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    const s = ms / 1000;
    return `${s < 10 ? s.toFixed(1).replace(/\.0$/, "") : Math.round(s)}s`;
  }
  return `${Math.round(ms / 60_000)}m`;
}

/** A percentile's reading, with a `+` where the estimate landed in the open
 *  band: the reader is owed the difference between "5s" and "at least 5s". */
export function latencySaid(reading: LatencyReading | null): string {
  if (!reading) return "";
  return `${msSaid(reading.ms)}${reading.atLeast ? "+" : ""}`;
}

/** A size, in the unit a reader thinks in. A tool's result is bytes; a wall
 *  that says "1048576" is a wall that has not decided what it is showing. A
 *  measured zero is `0 B`: nothing came back, which is a reading, where a dash
 *  would claim the size is unknown. */
export function bytesSaid(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** A share, floored so nothing ever reads 100% while something is left. */
export function shareSaid(share: number | null): string {
  if (share === null || !Number.isFinite(share)) return "";
  return `${Math.floor(share * 100)}%`;
}

/** A rate, floored the same way and never rounded down to nothing: one failure
 *  in a thousand is `<1%`, not `0%`, because a face that says nothing failed
 *  next to "1 call returned an error" is a face arguing with itself. */
export function rateSaid(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "";
  if (rate > 0 && rate < 0.01) return "<1%";
  return `${Math.floor(rate * 100)}%`;
}

/** The cells of one line. **A dash means the measure does not exist** — no
 *  completed call, no turn claiming the cost; a measured zero prints as zero.
 *  Conflating the two is how a healthy tool's error column became all dashes. */
export function cellOf(line: ToolLine, key: ToolSort): string {
  switch (key) {
    case "name":
      return line.name;
    case "calls":
      return count(line.calls);
    case "errors":
      return count(line.errors);
    case "errorRate":
      return rateSaid(line.errorRate);
    case "p50":
      return latencySaid(line.p50);
    case "p95":
      return latencySaid(line.p95);
    case "bytes":
      return bytesSaid(line.bytes);
    case "cost":
      return line.cost > 0 ? money(line.cost) : "";
  }
}

/** A line's own sentence, for the row's title: the provenance §11.9 requires
 *  every figure to carry. */
export function toolTitle(line: ToolLine): string {
  const parts = [`${count(line.calls)} ${line.calls === 1 ? "call" : "calls"}`];
  if (line.kind === "mcp") parts.push(`mcp server ${line.server}`);
  else parts.push(line.kind === "builtin" ? "built-in" : line.kind);
  if (line.p95) {
    const scaled = line.p95.basis === "buckets" ? " (estimated from hourly bands)" : "";
    parts.push(`p95 ${latencySaid(line.p95)}${scaled}`);
  }
  if (line.cost > 0) parts.push("cost apportioned from the turn");
  if ("receipts" in line && line.receipts > 0) parts.push(`${count(line.receipts)} returned early`);
  return parts.join(" · ");
}

/** What the invoked half can and cannot say (§9.7). The attributed half needs
 *  a record this build does not write, and the face says so rather than
 *  drawing an empty column. */
export const ATTRIBUTION_GAP = "what the kit attributed is not recorded yet";

/** The habits' one sentence, generated from the numbers by a template and
 *  never by a model, the way the work page's lede is.
 *
 *  **Nothing opened is said before any rate is**: "0 cards were opened, about
 *  one every 33 days" is what a template does when it appends a clause it has
 *  no numerator for, and it argues with the empty strip drawn below it. */
export function habitSaid(model: HabitModel): string {
  if (model.sessions === 0) return "no sessions in this window";
  if (model.spawns === 0) return "no card was opened in this window";
  const cards = `${count(model.spawns)} ${model.spawns === 1 ? "card was" : "cards were"} opened`;
  const byAgent = model.byOpener.find((s) => s.label === "agent");
  const agent = byAgent && byAgent.value > 0 ? `, ${shareSaid(byAgent.share)} of them by an agent` : "";
  /* A rate below one a day is said as an interval rather than as a fraction:
     "about one every 33 days" is a reading, "0.0 a day" is not. */
  const perDay =
    model.perDay === null
      ? ""
      : `, about ${
          model.perDay < 0.5
            ? `one every ${Math.max(2, Math.round(1 / model.perDay))} days`
            : `${model.perDay.toFixed(1)} a day`
        }`;
  const busy = model.peakConcurrent > 1 ? `, and as many as ${model.peakConcurrent} were working at once` : "";
  return `${cards}${agent}${perDay}${busy}`;
}

/** At most `n` slices plus one that carries the rest, so the bars still add up
 *  to the whole and a reader is never shown four labels whose shares sum to
 *  60% with nothing saying where the rest went. */
export function foldSlices(slices: readonly Slice[], n: number): Slice[] {
  if (slices.length <= n) return [...slices];
  const head = slices.slice(0, n);
  const rest = slices.slice(n);
  let value = 0;
  let share = 0;
  for (const slice of rest) {
    value += slice.value;
    share += slice.share ?? 0;
  }
  return [...head, { label: "others", value, share }];
}

/** A day strip with no more columns than a narrow card can draw.
 *
 *  A year is 366 days, and 366 flex children with a 2px gap is more gap than
 *  the card is wide: the bars collapse to hairlines and the row overflows. So
 *  past `max` days, consecutive days fold into equal buckets. The last bucket
 *  is partial and is labelled by its first day, which is the only day in it the
 *  reader can name without arithmetic. */
export type DayBucket = SpawnDay & { days: number };

export function dayBuckets(days: readonly SpawnDay[], max = 52): DayBucket[] {
  if (days.length <= max) return days.map((d) => ({ ...d, days: 1 }));
  const size = Math.ceil(days.length / max);
  const out: DayBucket[] = [];
  for (let i = 0; i < days.length; i += size) {
    const group = days.slice(i, i + size);
    const first = group[0];
    out.push({
      day: first.day,
      at: first.at,
      person: group.reduce((n, d) => n + d.person, 0),
      agent: group.reduce((n, d) => n + d.agent, 0),
      unknown: group.reduce((n, d) => n + d.unknown, 0),
      total: group.reduce((n, d) => n + d.total, 0),
      days: group.length,
    });
  }
  return out;
}

/* ── the recorded agents (§4.4) ─────────────────────────────────────────────*/

/** One `analytics_agent` row: a subagent the wall watched, with **the cost it
 *  was billed at the time**. It is not recomputed anywhere in the front end,
 *  which is what makes a reading of last March stay true when a rate changes. */
export type AgentRecord = {
  agent: string;
  session: string;
  parentAgent: string;
  depth: number;
  kind: string;
  profile: string;
  requestedModel: string;
  startedAt: number;
  endedAt: number | null;
  turns: number;
  costUsd: number;
  account: string;
  provider: string;
};

export function asAgents(raw: unknown): AgentRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentRecord[] = [];
  for (const one of raw) {
    const r = obj(one);
    if (!r) continue;
    const agent = str(r.agent);
    const startedAt = num(r.startedAt);
    if (!agent || !(startedAt > 0)) continue;
    const end = r.endedAt === null || r.endedAt === undefined ? null : num(r.endedAt);
    out.push({
      agent,
      session: str(r.session),
      parentAgent: str(r.parentAgent),
      depth: num(r.depth),
      kind: str(r.kind),
      /* A profile the wall never saw is `unknown` at the face rather than an
         empty cell that reads as a rendering fault. */
      profile: str(r.profile),
      requestedModel: str(r.requestedModel),
      startedAt,
      endedAt: end,
      turns: num(r.turns),
      costUsd: num(r.costUsd),
      account: str(r.account),
      provider: str(r.provider),
    });
  }
  return out;
}

/** One line of the profile table: every agent that ran as `scout`, summed. An
 *  agent whose spawning call the wall never found is its own `unknown` line
 *  rather than guessed into a profile. */

export type ProfileLine = {
  profile: string;
  agents: number;
  turns: number;
  cost: number;
  /** The kinds seen under this profile, so `task` and `subagent` do not blend
   *  into one word with no way to tell which it was. */
  kinds: string[];
};

export function profileLines(rows: readonly AgentRecord[]): ProfileLine[] {
  const by = new Map<string, ProfileLine & { kindSet: Set<string> }>();
  for (const r of rows) {
    const key = r.profile || "unknown";
    let line = by.get(key);
    if (!line) {
      line = { profile: key, agents: 0, turns: 0, cost: 0, kinds: [], kindSet: new Set() };
      by.set(key, line);
    }
    line.agents += 1;
    line.turns += r.turns;
    line.cost += r.costUsd;
    if (r.kind) line.kindSet.add(r.kind);
  }
  return [...by.values()]
    .map(({ kindSet, ...line }) => ({ ...line, kinds: [...kindSet].sort() }))
    .sort((a, b) => b.cost - a.cost || b.turns - a.turns || a.profile.localeCompare(b.profile));
}

