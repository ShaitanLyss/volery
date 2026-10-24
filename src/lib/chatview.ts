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
  /** Its tier is `fail`: it broke, whether or not a notice says so. Drawn
   *  (the dot is rust), and never by itself a reason it needs you — see
   *  `needsYou`. */
  failed: boolean;
  /** The rest it is in waits on you: a turn ended and nobody has acknowledged
   *  it (`notice.ts::owesYou`, carried as `Gist.owed`). Null from a wall
   *  before it, where the standing notice is the only reading there is. */
  owed: boolean | null;
  /** Its last turn was *called* a question (`classify.ts::endsOnQuestion`). A
   *  hint for the dot and the words, never for where the row is listed. */
  endedOnQuestion: boolean;
  /** Stopped for want of allowance rather than broken, or null — held until
   *  an account frees up, or stopped on the CLI's own refusal
   *  (`cards.svelte.ts::Allowance`). Said quietly under the title; never
   *  *needs you*. */
  allowance?: { until: number | null; reset: string | null } | null;
  /** Spending the organisation's API credits (`credits.ts`) — drawn only while
   *  boost is on, as the sidebar's half of boost's look. */
  credits?: boolean;
  /** How full its context window is, 0–1 (`Gist.ctx`), and whether it is
   *  dormant — drawn as the row's ring (`CtxRing.svelte`), so how used each
   *  conversation is reads down the list without opening one. */
  ctx?: number;
  ctxTokens?: number | null;
  dormant?: boolean;
  aside: boolean;
  /** When it was last active, in ms since the epoch. */
  lastAt: number;
  /** When the running turn started, if one is running. */
  turnAt: number | null;
  /** What it last said — the first line becomes a finished row's subtitle. */
  lastWords: string;
  /** The conversation that started it, if one did. */
  parent: string | null;
  /** When what it needs you for began waiting — its question asked, its
   *  notice raised — in ms on this wall's clock wherever it runs. What *needs
   *  you* is ordered by; null reads as the oldest. */
  since?: number | null;
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

/** Past this share of its window a row wears its ring whether or not it is
 *  the one in front (Lyss: a ring on every row was noise). Below it, only the
 *  selected conversation does. */
export const RING_FROM = 0.33;

/** Whether a row draws its context ring: the conversation in front always,
 *  any other only once it has used more than a third of its window. */
export function ringShown(ctx: number | undefined, selected: boolean): boolean {
  return selected || (ctx ?? 0) > RING_FROM;
}

/** What a row's context ring says on hover: how full, in the words the
 *  header already uses for it (*memory*), and the tokens behind it where
 *  they are known. */
export function ctxSaid(ctx: number, tokens: number | null | undefined): string {
  const pct = Math.round(Math.max(0, Math.min(1, ctx || 0)) * 100);
  const head = `memory ${pct}% full`;
  if (tokens == null || !(tokens > 0)) return head;
  const t = tokens >= 10_000 ? `${Math.round(tokens / 1000)}k` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
  return `${head} · ${t} tokens`;
}

/** A row as drawn. */
export type Placed = {
  row: ChatRow;
  group: GroupKey;
  /** How far it is indented under the conversation that started it. */
  depth: number;
  /** The conversation that started it, drawn greyed above it, when it is not
   *  the row above — so the delegation tree is never broken by the grouping
   *  (§5.1). Null when it is drawn under its parent, or a person started it. */
  ghost: Ghost | null;
  tone: Tone;
  /** The line under the title, or null for none. */
  sub: string | null;
  /** What sits at the right of the title: the age of a turn while it works,
   *  otherwise where it is (`portfolio`, `chat`, `portfolio · on laptop`). */
  aside: string;
};

export type Group = { key: GroupKey; label: string; rows: Placed[] };

/** The parent a child is drawn under when the parent is not the row above it.
 *
 *  It was a title and nothing else — greyed text no click reached, so the
 *  conversation that started a working child could not be opened from beside
 *  it (Lyss, 2026-10-19: *"I couldn't select the parent conversation of some
 *  of the child conversation"*). Now it says which of three things the parent
 *  is, because each wants a different gesture:
 *
 *  - `here` — listed, in a quieter group (or folded away in *set aside*):
 *    the label is the parent's title and selects it.
 *  - `closed` — not on any wall this one holds. `host` null is this wall's
 *    own card, whose recorded session may be adopted back and opened; a
 *    `host` is a card its wall closed, and nothing here can reopen it.
 *  - `unseen` — on a wall this one holds no word from (`lineage.ts`'s
 *    stray). Real, and out of reach. */
export type Ghost = {
  id: string;
  /** What the label reads. */
  label: string;
  state: "here" | "closed" | "unseen";
  /** The wall it is on, when that is not this one. */
  host: string | null;
};

/** The wall a card on another wall runs on, read off its id
 *  (`shadow.ts::shadowKey`, `elsewhere:<host>:<card>`), or null for this
 *  wall's own. Restated rather than imported so this file reads nothing of
 *  the flyway's; held equal by a test. */
export function hostOfKey(id: string): string | null {
  if (!id.startsWith("elsewhere:")) return null;
  const rest = id.slice("elsewhere:".length);
  const cut = rest.lastIndexOf(":");
  return cut > 0 ? rest.slice(0, cut) : null;
}

/** What a parent the list does not hold is drawn as. */
export function goneGhost(id: string, unseen: boolean): Ghost {
  const host = hostOfKey(id);
  if (unseen) return { id, label: `started on ${host ?? "another wall"} — not heard from`, state: "unseen", host };
  return {
    id,
    label: host ? `started by a conversation closed on ${host}` : "started by a closed conversation",
    state: "closed",
    host,
  };
}

/** Does this conversation need you — is something on it that only a person
 *  can answer, now?
 *
 *  A parked question, one you put off, and a standing notice that asks: a
 *  turn that ended on a question (`notice.md`'s detector), news the card
 *  sent itself, or a failure it gave up on. **Nothing else, and the tier is
 *  not on the list.** It was, as `failed`, and that put every card whose
 *  *stored* ending is an error into *needs you* for good: a card restored off
 *  disk comes back rust from a turn that broke last month, and a card on
 *  another wall arrives rust in its digest. Lyss, 2026-10-19, eight rows of
 *  "stopped: it gave up", most of them from QUEERISFREEDOM: *"it lists old
 *  stopped conversations as needs my attention."* On that wall seven cards
 *  read rust — the oldest stopped on 14 September, two on an exhausted
 *  session limit, one on an expired sign-in — and its notice queue held none.
 *
 *  The notice is the honest reading of "a failure you have not seen", because
 *  of how it lives: raised only when the card has given up (never while a
 *  heal is pending), never for a card you were watching, taken down by the
 *  card's next turn, by your acknowledging it — and by reading it here
 *  (`settles`). So nothing in *needs you* is older than your last look at
 *  it. And it is the dock's own reading — `Cards.noticing` is the queue both
 *  draw — so the two cannot disagree, which the tier did. An allowance stop
 *  is not in that queue at all (`notice.ts::waitsOnYou`); the row says
 *  *waiting for allowance* instead.
 *
 *  **And a rest you have not acknowledged** (`restOwed`), whatever the turn was
 *  called. A `done` notice used to be the one kind that did not need you, and
 *  what decides `done` is one paragraph read by a regex
 *  (`classify.ts::endsOnQuestion`). Lyss, 2026-10-21: *"sometimes I ask a
 *  question and go somewhere else. The card asks a follow-up question, but it
 *  was flagged as finished, so it's moved silently down the queue, and I'm
 *  never prompted to go check."* So the label is a hint and nothing more: a
 *  turn ending puts the next move with you until you acknowledge it. */
export function needsYou(r: ChatRow): boolean {
  return asksYou(r) || restOwed(r);
}

/** Something stands on it that asks: a parked question, one put off, or a
 *  notice that is not a plain rest. These outrank even a card that is working
 *  — a question you put off is yours while the card gets on. */
function asksYou(r: ChatRow): boolean {
  return r.asking !== null || r.deferred !== null || (r.notice !== null && r.notice.kind !== "done");
}

/** Its rest waits on you. Not while it works — a card that backgrounded work
 *  has not finished anything — and not when it stopped for want of allowance,
 *  which waits on no one. A card from a wall before `owed` is read by its
 *  standing notice, which is that wall's own reading of a rest not yet
 *  acknowledged. */
export function restOwed(r: ChatRow): boolean {
  if (r.working || r.allowance) return false;
  return r.owed ?? r.notice !== null;
}

/** How long a conversation that came to rest stays in *finished*, above the
 *  projects, whether or not its notice is up yet or has been read.
 *
 *  *Finished* was a turn with a `done` notice standing, and nothing else — so
 *  a card fell out of the live groups into the day's history the moment it
 *  stopped working, and came back up only when its notice rose. A notice very
 *  often rises late or never: it is held while a young job, a card it opened
 *  or an armed wake might still stir it (`notice.md`, *Holds*), and none is
 *  raised for the card you were watching. Lyss, 2026-10-20: *"they just
 *  shouldn't vanish from the top between working and finished"* — and the card
 *  that vanished was the one she was working with. So *finished* is a rest
 *  that is recent. An hour is a sitting: past it, the card is history.
 *
 *  Since 2026-10-21 only a rest you have **acknowledged** reaches it at all
 *  (`needsYou`): until then it is in *needs you*, so the move from one to the
 *  other is a gesture of yours and never the classifier's. */
export const RECENT_MS = 60 * 60_000;

/** The group a row belongs in on its own account, before lineage.
 *
 *  `delegating` is a row with a conversation it started — at any depth — still
 *  working: its own turn is over, its work is not, and it is filed with the
 *  work (Lyss: *"my ai testing card that keeps going even though it still has
 *  children (n deep) working"*). `groups` works it out; alone, a row has no
 *  children to ask. */
export function groupOf(r: ChatRow, now: number, delegating = false): GroupKey {
  if (r.aside && !needsYou(r) && !r.working) return "aside";
  if (asksYou(r)) return "needs";
  /* A card whose own turn is over while one it started works is filed with the
     work: its rest is not the end of anything yet, and the wall holds its
     notice for the same reason (`notice::held`). */
  if (r.working || delegating) return "working";
  if (restOwed(r)) return "needs";
  if (r.notice?.kind === "done" || now - r.lastAt < RECENT_MS) return "finished";
  return dayOf(r.lastAt, now);
}

/** When a card here came to rest, for the day it is listed under: this
 *  session's rest, else the store's last activity (all a card restored dormant
 *  has), else — a card with no record at all was opened this session and has
 *  done nothing yet — when it was opened. Null only while it works. Never
 *  unknown for a card here: an unknown age is filed with the oldest, which for
 *  a card opened a minute ago is plainly wrong (found driving a lab: a card
 *  adopted back from its session sat in *earlier*). */
export function restedOf(
  c: { working: boolean; restingSince: number | null; lastActive: number | null },
  opened: number,
): number | null {
  if (c.working) return null;
  return Math.max(c.restingSince ?? 0, c.lastActive ?? 0) || opened;
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

/** The first line with anything on it, as words: the marks markdown writes
 *  around them (`**`, `_`, backticks, a heading's `#`, a list's `-`) are taken
 *  off, since a subtitle is read in passing and a row reading
 *  `**What it does.**` is a row showing its working. */
function firstLine(text: string): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^([-*+]|\d+[.)])\s+/, "")
    /* Only at a word's edges, so `snake_case` and `2 * 3` keep theirs. */
    .replace(/(^|[\s(])(\*\*|__|\*|_|`)(\S(?:.*?\S)?)\2(?=$|[\s.,;:!?)])/g, "$1$3")
    .trim();
}

function tone(r: ChatRow, group: GroupKey): Tone {
  if (r.notice?.kind === "failed") return "fail";
  if (group === "needs") {
    if (asksYou(r)) return "ask";
    /* A rest waiting on you, drawn by what the turn was called: that is the
       one place the classifier still speaks, as a hint you can triage by. */
    if (r.failed) return "fail";
    return r.endedOnQuestion ? "ask" : "done";
  }
  if (r.working) return "work";
  /* Out of allowance is not broken: nothing about the card is wrong. */
  if (r.allowance) return "rest";
  if (r.failed) return "fail";
  /* The hollow dot is a rest you have not read: the notice, not the group,
     since *finished* also holds a recent rest whose notice is held or read. */
  if (r.notice?.kind === "done") return "done";
  return "rest";
}

/** What a row says of a card waiting for allowance: when it comes back, in the
 *  refusal's own words where there are some, else the hold's, else nothing. */
export function allowanceLine(a: { until: number | null; reset: string | null }, now: number): string {
  if (a.reset) return `waiting for allowance · resets ${a.reset}`;
  if (a.until !== null && a.until > now) return `waiting for allowance · back in ${ageOf(a.until - now)}`;
  return "waiting for allowance";
}

/** What is said under the title. In *needs you* it is what the conversation
 *  is asking; in *working*, what it is doing and where; in *finished*, the
 *  first line of what it said. History rows carry none — their place is
 *  beside the title — unless the card is waiting for allowance, which any
 *  row at rest says, since it is why the card is quiet. */
export function subtitleOf(r: ChatRow, group: GroupKey, now = Date.now()): string | null {
  if (group === "needs") {
    if (r.asking) {
      const of = r.asking.of > 1 ? ` · ${r.asking.nth} of ${r.asking.of}` : "";
      return `asks: ${firstLine(r.asking.text)}${of}`;
    }
    if (r.notice?.kind === "failed") return `stopped: ${firstLine(r.notice.text) || "it gave up"}`;
    if (r.notice?.kind === "question") return firstLine(r.notice.text) || null;
    if (r.notice?.kind === "own") return firstLine(r.notice.text) || null;
    if (r.deferred !== null) return `answer later: ${firstLine(r.deferred)}`;
    /* A rest you have not acknowledged: what it said, under what the turn was
       called — `finished:` is the classifier's word and only a word. */
    const said = firstLine(r.lastWords);
    if (r.failed) return `stopped: ${said || "it gave up"}`;
    if (r.endedOnQuestion) return said || null;
    return said ? `finished: ${said}` : "finished";
  }
  if (group === "working") {
    const doing = r.doing.trim();
    return doing ? `${doing} · ${whereOf(r)}` : whereOf(r);
  }
  if (r.allowance) return allowanceLine(r.allowance, now);
  if (group === "finished") return firstLine(r.lastWords) || null;
  return null;
}

/** The order *needs you* is drawn in: `queueOrder` with **no ring**, so the
 *  conversation you click does not jump to the top (`queueOrder`'s own
 *  comment: it is never the order something already drawn is kept in).
 *  Questions an agent is stopped on first, then everything else that waits,
 *  each tier by how long it has waited — wherever the card runs, as the
 *  dock's queue is — so it holds still while nothing changes. */
function needsOrder(rows: ChatRow[]): ChatRow[] {
  const items: (Waiting & { row: ChatRow })[] = rows.map((row) => ({
    key: row.id,
    card: row.id,
    tier: row.asking ? 0 : 1,
    /* A rest waiting on you has waited since it began, when nothing else
       dates it — never "the oldest", which would put the turn that ended a
       moment ago at the top of everything that has waited all morning. */
    since: row.since ?? (restOwed(row) ? row.lastAt : 0),
    row,
  }));
  return queueOrder(items, null).map((i) => i.row);
}

/** How many working conversations each row started, at any depth — its
 *  children, theirs, and so on down. Rows with none are absent. A parent the
 *  list does not hold breaks the chain there, and a cycle (which `relay.rs`
 *  should never let exist) is walked once. */
export function workingUnder(rows: readonly ChatRow[]): Map<string, number> {
  const kids = new Map<string, ChatRow[]>();
  for (const r of rows) {
    if (!r.parent || r.parent === r.id) continue;
    const list = kids.get(r.parent);
    if (list) list.push(r);
    else kids.set(r.parent, [r]);
  }
  const out = new Map<string, number>();
  for (const r of rows) {
    let n = 0;
    const seen = new Set([r.id]);
    const walk = (id: string) => {
      for (const k of kids.get(id) ?? []) {
        if (seen.has(k.id)) continue;
        seen.add(k.id);
        if (k.working) n++;
        walk(k.id);
      }
    };
    walk(r.id);
    if (n) out.set(r.id, n);
  }
  return out;
}

/** Every group with something in it, in the order they are drawn, each row
 *  placed under the conversation that started it.
 *
 *  A child goes where its parent is, nested under it — unless it is in a
 *  livelier group of its own (asking while its parent rests; a working child
 *  brings its parent into *working* instead, `groupOf`'s `delegating`), where
 *  it stays, under a greyed copy of the parent's
 *  title that selects the parent. A set-aside row never follows a parent out
 *  of *set aside*, and nothing follows a parent into it; either way the other
 *  is named above it. A parent the list does not hold is named too, as what it
 *  is (`Ghost`), never left out — a child drawn at the top with nothing above
 *  it reads as one a person started.
 *
 *  `unseen` is the parents on a wall this one holds no word from
 *  (`Kin.unseen`), which are drawn as out of reach rather than as closed. */
export function groups(rows: readonly ChatRow[], now: number, unseen: ReadonlySet<string> = new Set()): Group[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const working = workingUnder(rows);
  const own = new Map(rows.map((r) => [r.id, groupOf(r, now, (working.get(r.id) ?? 0) > 0)]));
  const rank = (g: GroupKey) => ORDER.indexOf(g);

  /** Where a row is drawn, and whether under a ghost. Walks up the chain, so a
   *  grandchild follows its parent as its parent follows its own. */
  const seen = new Map<string, { group: GroupKey; ghost: boolean }>();
  const placeOf = (r: ChatRow, trail: Set<string> = new Set()): { group: GroupKey; ghost: boolean } => {
    const done = seen.get(r.id);
    if (done) return done;
    const mine = own.get(r.id)!;
    const parent = r.parent && r.parent !== r.id ? byId.get(r.parent) : undefined;
    let out = { group: mine, ghost: false };
    if (r.parent && r.parent !== r.id && !parent) out = { group: mine, ghost: true };
    else if (parent && !trail.has(r.id)) {
      trail.add(r.id);
      const theirs = placeOf(parent, trail).group;
      if (mine === "aside" || theirs === "aside") out = { group: mine, ghost: mine !== theirs };
      else if (rank(mine) < rank(theirs)) out = { group: mine, ghost: true };
      else out = { group: theirs, ghost: false };
    }
    seen.set(r.id, out);
    return out;
  };
  for (const r of rows) placeOf(r);

  const ghostOf = (id: string): Ghost => {
    const p = byId.get(id);
    return p ? { id, label: p.title, state: "here", host: p.host ?? null } : goneGhost(id, unseen.has(id));
  };

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
    const visit = (r: ChatRow, depth: number, ghost: Ghost | null) => {
      placed.push({
        row: r,
        group: key,
        depth,
        ghost,
        tone: tone(r, key),
        sub:
          key === "working" && !r.working
            ? `waiting on ${working.get(r.id)} it started · ${whereOf(r)}`
            : subtitleOf(r, key, now),
        aside: key === "working" && r.turnAt !== null ? ageOf(now - r.turnAt) : whereOf(r),
      });
      for (const kid of members) {
        if (kid.parent === r.id && !seen.get(kid.id)!.ghost && kid.id !== r.id) {
          visit(kid, depth + 1, null);
        }
      }
    };
    for (const r of ordered) {
      const ghost = seen.get(r.id)!.ghost && r.parent ? ghostOf(r.parent) : null;
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
    /* Every wall's conversations in a project of this name — a card on
       another wall counts as one here does (`projectview.ts::rowsOf`). */
    const mine = rows.filter((r) => r.project === name);
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

/* Reading a finished conversation used to settle it: two seconds of its last
   message on screen, selected, the window in front (`docs/chat-mode.md` §5.4).
   It went on 2026-10-21 with the rule above, because reading is exactly how a
   follow-up question the classifier called *finished* slipped away — a glance,
   a plan to come back, and the row was gone. Acknowledging is a gesture now
   (`Skein.acknowledgeRest`: *done with it*, `space d a`, a notice's own
   acknowledge on either view) or a reply, which opens the turn that clears it. */

/* ── conversations that start conversations (§5.5) ─────────────────────── */

/** The handle of the card a `spawn` call opened, read off its receipt — or
 *  null when the call is something else, has not landed, failed, or opened
 *  nothing this build can read a handle out of.
 *
 *  Off the receipt rather than off `Skein.kin`, because kin knows *that* a card
 *  has children and not *which call* opened each one, and the linked card
 *  stands where the call stands. `spawn::opened_text` says `its handle is
 *  <eight hex>` on every arm, local or remote; a receipt that grows another
 *  shape draws no linked card, which is the quiet failure — the pane's
 *  *linked* tab, read off kin, still lists the child. */
export function spawnedHandle(call: { name: string; result?: { text: string; failed?: true } } | undefined): string | null {
  if (!call || call.name !== SPAWN_TOOL || !call.result || call.result.failed) return null;
  return /its handle is ([0-9a-f]{8})\b/.exec(call.result.text)?.[1] ?? null;
}

/** Must agree with `classify.ts::SKEIN_SPAWN_TOOL`; restated rather than
 *  imported so this file keeps knowing nothing of the event vocabulary beyond
 *  the one name it reads. Held by a test. */
export const SPAWN_TOOL = "mcp__skein__spawn";

/** Which card a handle names, among the ids on the wall — the card itself or
 *  null. A handle is an id's first eight characters (`relay::handle_of`);
 *  two ids sharing them is the case `relay.rs` refuses, so the first match is
 *  the only one. Used for a spawn's child and a relay's sender alike. */
export function cardByHandle(handle: string, ids: readonly string[]): string | null {
  if (!/^[0-9a-f]{8}$/.test(handle)) return null;
  /* A card on another wall is keyed `elsewhere:<host>:<card>`, and its handle
     is its own card id's — so the match is on that part. This wall's cards
     come first in every list handed here, so a handle both would answer to is
     the one standing here. */
  return ids.find((id) => (hostOfKey(id) ? id.slice(id.lastIndexOf(":") + 1) : id).startsWith(handle)) ?? null;
}

/** Where a card's handle stands in a run of prose — eight hex characters as a
 *  word of their own, which is how every card here is named to an agent and
 *  how agents name one another back (`fc5cb712: taking the build`, *board
 *  notice af3c1345*). Only the shape: whether a card answers to it is the
 *  wall's to say (`cardlinks.svelte.ts`), so a commit hash or a colour that
 *  happens to look like one is never drawn as a card. */
export function handlesIn(text: string): { from: number; to: number; handle: string }[] {
  const out: { from: number; to: number; handle: string }[] = [];
  for (const m of text.matchAll(/(?<![0-9A-Za-z_#-])[0-9a-f]{8}(?![0-9A-Za-z_-])/g)) {
    out.push({ from: m.index, to: m.index + 8, handle: m[0] });
  }
  return out;
}
