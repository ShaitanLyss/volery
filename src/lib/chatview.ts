/* Chat view's sidebar, decided once: which group each conversation is in, in
 * what order, under whom, and what is said beneath its title.
 *
 * Chat view (`docs/chat-mode.md`) is a second presentation of the same wall:
 * one conversation in front of you and every other one listed down the side,
 * sorted by what it needs from you. That sorting is the whole of what makes
 * the list useful, and it is read in three places — the sidebar, the narrow
 * drawer and a toast's "and N more" — so it is one pure function here rather
 * than a judgement each drawing makes for itself. Tested in
 * `test/chatview.test.ts`.
 *
 * Nothing here knows what a card is. The view builds a `ChatRow` per card off
 * its handle — the face, its question, its notices, its lineage — and hands the
 * list in; what comes back is drawn. */

import { queueOrder, type Waiting } from "./queue";

/** One conversation, as far as the sidebar is concerned. */
export type ChatRow = {
  id: string;
  title: string;
  /** Its project's name, or null for a chat card, which has none. */
  project: string | null;
  /** The wall it runs on, when that is not this one. */
  host?: string | null;
  /** Mid-turn, or holding background work. */
  working: boolean;
  /** What it is doing now, while it works (`conv.doing`). */
  doing: string;
  /** The question it is parked on, if one can be answered: the text, and which
   *  of how many a multi-question call is on. */
  asking: { text: string; nth: number; of: number } | null;
  /** A question you put off (`deferred_ask`). The agent's call has already
   *  returned, so it may be working — but you still owe the answer. */
  deferred: string | null;
  /** The notice standing about it, if any. `done` is a turn that finished;
   *  `question` one that ended on a question; `own` a notice the card raised
   *  itself; `failed` a card that gave up on an error. */
  notice: { kind: "done" | "question" | "own" | "failed"; text: string } | null;
  /** Its tier is `fail`: it broke, whether or not a notice says so. */
  failed: boolean;
  aside: boolean;
  /** When it was last active, in ms since the epoch. */
  lastAt: number;
  /** When the running turn started, if one is running. */
  turnAt: number | null;
  /** What it last said — the first line becomes a finished row's subtitle. */
  lastWords: string;
  /** The conversation that started it, if one did. */
  parent: string | null;
};

/** Which group, in the order they are drawn. */
export type GroupKey =
  | "needs"
  | "working"
  | "finished"
  | "today"
  | "yesterday"
  | "week"
  | "earlier"
  | "aside";

export const GROUP_LABEL: Record<GroupKey, string> = {
  needs: "needs you",
  working: "working",
  finished: "finished",
  today: "today",
  yesterday: "yesterday",
  week: "this week",
  earlier: "earlier",
  aside: "set aside",
};

const ORDER: GroupKey[] = ["needs", "working", "finished", "today", "yesterday", "week", "earlier", "aside"];

/** The colour a row's dot is drawn in, which is its status and nothing else
 *  (`--st-*`): asking amber, broken rust, working celadon. `done` is the
 *  hollow dot of a finished, unsettled row; `rest` and `chat` are achromatic. */
export type Tone = "ask" | "fail" | "work" | "done" | "rest";

/** A row as drawn. */
export type Placed = {
  row: ChatRow;
  group: GroupKey;
  /** How far it is indented under the conversation that started it. */
  depth: number;
  /** When it sits in a livelier group than its parent, the parent's title,
   *  drawn greyed above it — so the delegation tree is never broken by the
   *  grouping (§5.1). Null otherwise. */
  ghost: string | null;
  tone: Tone;
  /** The line under the title, or null for none. */
  sub: string | null;
  /** What sits at the right of the title: the age of a turn while it works,
   *  otherwise where it is (`portfolio`, `chat`, `portfolio · on laptop`). */
  aside: string;
};

export type Group = { key: GroupKey; label: string; rows: Placed[] };

/** Does this conversation need you? A parked question, one you put off, a
 *  notice it is waiting on you about, a turn that ended on a question, or a
 *  card that gave up. */
export function needsYou(r: ChatRow): boolean {
  return (
    r.asking !== null ||
    r.deferred !== null ||
    r.failed ||
    (r.notice !== null && r.notice.kind !== "done")
  );
}

/** The group a row belongs in on its own account, before lineage. */
export function groupOf(r: ChatRow, now: number): GroupKey {
  if (r.aside && !needsYou(r) && !r.working) return "aside";
  if (needsYou(r)) return "needs";
  if (r.working) return "working";
  if (r.notice?.kind === "done") return "finished";
  return dayOf(r.lastAt, now);
}

/** Today, yesterday, this week or earlier, by the local calendar — not by
 *  twenty-four-hour windows, which would call last night's work "today" at
 *  nine in the morning. "This week" is the six days before yesterday. */
export function dayOf(at: number, now: number): "today" | "yesterday" | "week" | "earlier" {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const start = midnight.getTime();
  if (at >= start) return "today";
  const day = 86_400_000;
  if (at >= start - day) return "yesterday";
  if (at >= start - 7 * day) return "week";
  return "earlier";
}

/** A turn's age, coarse: `40s`, `4m`, `2h`. The sidebar is read in passing;
 *  the thread carries the exact time. */
export function ageOf(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** Where a conversation is, as the row says it. */
export function whereOf(r: ChatRow): string {
  const place = r.project ?? "chat";
  return r.host ? `${place} · on ${r.host}` : place;
}

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim()) ?? "").trim();
}

function tone(r: ChatRow, group: GroupKey): Tone {
  if (r.failed || r.notice?.kind === "failed") return "fail";
  if (group === "needs") return "ask";
  if (r.working) return "work";
  if (group === "finished") return "done";
  return "rest";
}

/** What is said under the title. In *needs you* it is what the conversation
 *  is asking; in *working*, what it is doing and where; in *finished*, the
 *  first line of what it said. History rows carry none: their place is beside
 *  the title. */
export function subtitleOf(r: ChatRow, group: GroupKey): string | null {
  if (group === "needs") {
    if (r.asking) {
      const of = r.asking.of > 1 ? ` · ${r.asking.nth} of ${r.asking.of}` : "";
      return `asks: ${firstLine(r.asking.text)}${of}`;
    }
    if (r.notice?.kind === "failed" || r.failed) {
      return `stopped: ${firstLine(r.notice?.text ?? r.lastWords) || "it gave up"}`;
    }
    if (r.notice?.kind === "question") return firstLine(r.notice.text) || null;
    if (r.notice?.kind === "own") return firstLine(r.notice.text) || null;
    if (r.deferred !== null) return `answer later: ${firstLine(r.deferred)}`;
    return null;
  }
  if (group === "working") {
    const doing = r.doing.trim();
    return doing ? `${doing} · ${whereOf(r)}` : whereOf(r);
  }
  if (group === "finished") return firstLine(r.lastWords) || null;
  return null;
}

/** The order *needs you* is drawn in: `queueOrder` with **no ring**, so the
 *  conversation you click does not jump to the top (`queueOrder`'s own
 *  comment: it is never the order something already drawn is kept in).
 *  Questions an agent is stopped on first, then everything else that waits,
 *  each tier in the order the rows came — which is the wall's own order, so
 *  it holds still while nothing changes. */
function needsOrder(rows: ChatRow[]): ChatRow[] {
  const items: (Waiting & { row: ChatRow })[] = rows.map((row) => ({
    key: row.id,
    card: row.id,
    tier: row.asking ? 0 : 1,
    far: !!row.host,
    row,
  }));
  return queueOrder(items, null).map((i) => i.row);
}

/** Every group with something in it, in the order they are drawn, each row
 *  placed under the conversation that started it.
 *
 *  A child goes where its parent is, nested under it — unless it is in a
 *  livelier group of its own (asking while its parent rests, working while its
 *  parent is history), where it stays, under a greyed copy of the parent's
 *  title. A set-aside row never follows a parent out of *set aside*, and
 *  nothing follows a parent into it. */
export function groups(rows: readonly ChatRow[], now: number): Group[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const own = new Map(rows.map((r) => [r.id, groupOf(r, now)]));
  const rank = (g: GroupKey) => ORDER.indexOf(g);

  /** Where a row is drawn, and whether under a ghost. Walks up the chain, so a
   *  grandchild follows its parent as its parent follows its own. */
  const seen = new Map<string, { group: GroupKey; ghost: boolean }>();
  const placeOf = (r: ChatRow, trail: Set<string> = new Set()): { group: GroupKey; ghost: boolean } => {
    const done = seen.get(r.id);
    if (done) return done;
    const mine = own.get(r.id)!;
    const parent = r.parent ? byId.get(r.parent) : undefined;
    let out = { group: mine, ghost: false };
    if (parent && !trail.has(r.id)) {
      trail.add(r.id);
      const theirs = placeOf(parent, trail).group;
      if (mine === "aside" || theirs === "aside") out = { group: mine, ghost: false };
      else if (rank(mine) < rank(theirs)) out = { group: mine, ghost: true };
      else out = { group: theirs, ghost: false };
    }
    seen.set(r.id, out);
    return out;
  };
  for (const r of rows) placeOf(r);

  const out: Group[] = [];
  for (const key of ORDER) {
    const members = rows.filter((r) => seen.get(r.id)!.group === key);
    if (!members.length) continue;
    const inGroup = new Set(members.map((m) => m.id));
    /* The tops of this group's trees: a row whose parent is not drawn here
       under it. A ghosted child is a top, with its parent's title above it. */
    const tops = members.filter((r) => !r.parent || !inGroup.has(r.parent) || seen.get(r.id)!.ghost);
    /* Elsewhere, recency — but a working row by when its turn *began*, since
       its last activity moves with every word it writes and a list that
       reshuffled on each one could not be read, let alone clicked. */
    const ordered =
      key === "needs"
        ? needsOrder(tops)
        : key === "working"
          ? [...tops].sort((a, b) => (b.turnAt ?? b.lastAt) - (a.turnAt ?? a.lastAt))
          : [...tops].sort((a, b) => b.lastAt - a.lastAt);
    const placed: Placed[] = [];
    const visit = (r: ChatRow, depth: number, ghost: string | null) => {
      placed.push({
        row: r,
        group: key,
        depth,
        ghost,
        tone: tone(r, key),
        sub: subtitleOf(r, key),
        aside: key === "working" && r.turnAt !== null ? ageOf(now - r.turnAt) : whereOf(r),
      });
      for (const kid of members) {
        if (kid.parent === r.id && !seen.get(kid.id)!.ghost && kid.id !== r.id) {
          visit(kid, depth + 1, null);
        }
      }
    };
    for (const r of ordered) {
      const ghost = seen.get(r.id)!.ghost && r.parent ? (byId.get(r.parent)?.title ?? null) : null;
      visit(r, ghost ? 1 : 0, ghost);
    }
    out.push({ key, label: GROUP_LABEL[key], rows: placed });
  }
  return out;
}

/** The sidebar's order as one list of ids — what Ctrl+Tab walks, and what
 *  the next selection after a close is read from. *Set aside* is folded, so
 *  it is walked only when `withAside`. */
export function walkOrder(gs: readonly Group[], withAside = false): string[] {
  return gs.filter((g) => withAside || g.key !== "aside").flatMap((g) => g.rows.map((p) => p.row.id));
}

/** One step along the sidebar from `id`, wrapping; the first when nothing is
 *  selected or the selection is not in the list. */
export function step(order: readonly string[], id: string | null, by: 1 | -1): string | null {
  if (!order.length) return null;
  const at = id ? order.indexOf(id) : -1;
  if (at < 0) return by > 0 ? order[0] : order[order.length - 1];
  return order[(at + by + order.length) % order.length];
}

/** What to select after `closed` goes: the next in the sidebar's order — not
 *  the wall's — or the one before when it was last, or nothing. */
export function afterClose(order: readonly string[], closed: string): string | null {
  const at = order.indexOf(closed);
  if (at < 0) return order[0] ?? null;
  const rest = order.filter((id) => id !== closed);
  if (!rest.length) return null;
  return rest[Math.min(at, rest.length - 1)];
}

/** The next conversation that needs you after `id`, wrapping — Alt+↓, the
 *  dock's `space d n`. Null when nothing does. */
export function nextNeeding(gs: readonly Group[], id: string | null): string | null {
  const needs = gs.find((g) => g.key === "needs")?.rows.map((p) => p.row.id) ?? [];
  if (!needs.length) return null;
  const at = id ? needs.indexOf(id) : -1;
  return needs[(at + 1) % needs.length];
}

/** One project, as the sidebar's *projects* group draws it. */
export type ProjectRow = { name: string; count: number; live: Tone[] };

/** The projects, each with how many conversations it holds and a dot per
 *  live one in its status colour. A project with nothing in it still lists:
 *  it is a folder you opened, and its page is where a conversation starts. */
export function projectsOf(rows: readonly ChatRow[], names: readonly string[], now: number): ProjectRow[] {
  return names.map((name) => {
    const mine = rows.filter((r) => r.project === name && !r.host);
    const live = mine
      .map((r) => ({ r, g: groupOf(r, now) }))
      .filter(({ g }) => g === "needs" || g === "working")
      .map(({ r, g }) => tone(r, g));
    return { name, count: mine.length, live };
  });
}

/** Does a search for `query` find this conversation? Every word, in any case,
 *  somewhere in its title, its place or what it last said. */
export function matches(r: ChatRow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${r.title}\n${whereOf(r)}\n${r.lastWords}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}
