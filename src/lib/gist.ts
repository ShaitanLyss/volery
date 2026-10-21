/* What is drawn about a conversation, as one shape, on every wall.
 *
 * Lyss, 2026-10-19: *"remote cards report 0 tok and 0 turns, it shouldn't have
 * been possible, we need a structural fix."* A card on another wall is drawn
 * from its digest, and the digest was a list somebody kept by hand beside a
 * list of what the surfaces draw — so a field one surface drew and the digest
 * never carried was filled on the far side with a constant: `turns = 0`,
 * `ctxTokens = 0`, `costUsd = 0`, a chat card drawn as a project, a held card
 * as one at rest. A missing value drawn as a real one, and nothing anywhere
 * failed while it was so.
 *
 * So the facts a surface draws are this one type, and both kinds of card
 * produce it: a card here by `gistOf` over its `Conversation`, a card elsewhere
 * by reading the digest its wall made by **the same `gistOf`** (`shadow.ts::
 * digestOf` spreads it, and `readGist` has to read every key of it — a mapped
 * type, so a key added here is a compile error in both until both carry it).
 * `CardHandle.gist` is what a surface reads; `test/gist.test.ts` fails a
 * surface that reaches through `.conv` for one of these instead, and a shadow
 * that answers one with a constant.
 *
 * **Unknown is `null`, never zero.** A wall from before a field sends nothing,
 * and that reads as unknown — drawn as `—` — where a default would draw a
 * number nobody measured. The bar for a field here: some surface draws it, and
 * it means the same on either machine. A path does not (`planDoc`, `cwd`): it
 * names a file on the owning machine, so it stays `Conversation`'s.
 *
 * Times are on the clock of whoever made the gist. On the far side they are
 * moved onto this wall's clock (`Shadow.gist`) by the snapshot's own `at`, the
 * way every other moment in a digest is, so no two machines' clocks are ever
 * compared. Pure; tested in `test/gist.test.ts`. */

import type { Plan, Timeline } from "./timeline";
import type { Ending } from "./classify";

/** A card's live plan, as far as drawing it goes (`timeline.md`). The plan is
 *  `timeline.rs`'s, written by the owner alone; what crosses is the reading. */
export type GistTimeline = {
  id: string;
  title: string;
  plan: Plan;
  bornAt: number;
  updatedAt: number;
};

/** A prompt waiting for an account, or behind a round already out. */
export type GistHeld = {
  why: string;
  /** When an account is expected back, or null when none is known. */
  until: number | null;
  waiting: "allowance" | "turn";
  /** How many messages are waiting. */
  queue: number;
};

export type Gist = {
  kind: "project" | "chat";
  /** In plan mode — `gear === "planning"`. */
  planning: boolean;
  model: string | null;
  effort: string | null;
  /** The managed account it spends, by label. */
  account: string | null;
  bypassCaps: boolean;
  /** Context occupancy, 0–1. */
  ctx: number;
  /** The tokens behind `ctx`. */
  ctxTokens: number | null;
  /** Turns taken in this process's life. */
  turns: number | null;
  /** What those turns cost, in dollars. */
  costUsd: number | null;
  /** How far a compaction has got, while one runs. */
  compactFrac: number | null;
  /** When the running turn began, or null between turns. */
  turnSince: number | null;
  held: GistHeld | null;
  /** Processes it holds beyond what it booted with (`perf.rs`). */
  holding: { excess: number; fleet: number } | null;
  /** Its live plan (`timeline.md`) — the frise on the wall, the strip and the
   *  pane in chat view. Lyss, 2026-10-19: *"I noticed timelines don't seem to
   *  travel across the flyway."* */
  timeline: GistTimeline | null;
  /** How its last turn ended. A hint only: what a turn was *called* decides
   *  the dot and the words under a title, never where a card is listed. An
   *  older wall already sent it as the digest's `ending`, so it reads off one
   *  too. */
  ending: Ending | null;
  /** The rest it is in waits on you — a turn ended and nobody has
   *  acknowledged it (`notice.ts::owesYou`). What chat view's *needs you* is
   *  decided by. Null from a wall before it, which falls back to its notice. */
  owed: boolean | null;
};

/** What a `Conversation` hands `gistOf` — its own field names, which differ
 *  from the gist's in two places (`gear`, `accountLabel`). */
export type GistSource = {
  kind: "project" | "chat";
  gear: string;
  model?: string | null;
  effort?: string | null;
  accountLabel?: string | null;
  bypassCaps?: boolean;
  ctx: number;
  ctxTokens: number;
  turns: number;
  costUsd: number;
  compactFrac: number | null;
  working: boolean;
  turnSince: number | null;
  held: { why: string; until: number | null; waiting: "allowance" | "turn"; queue: readonly unknown[] } | null;
  holding: { excess: number; fleet: number } | null;
  ending: Ending | null;
  /** `Conversation.owed`, decided there over the fold only it holds. */
  owed: boolean;
};

/** The one function a gist is made by, for the face here and the digest that
 *  carries it to every other wall. `live` is the card's live timeline, which
 *  the wall's `Timelines` holds rather than the card — passed, never
 *  defaulted, so a caller cannot forget it and draw a card with no plan. */
export function gistOf(c: GistSource, live: Timeline | null): Gist {
  return {
    kind: c.kind,
    planning: c.gear === "planning",
    model: c.model ?? null,
    effort: c.effort ?? null,
    account: c.accountLabel ?? null,
    bypassCaps: c.bypassCaps === true,
    ctx: c.ctx,
    ctxTokens: c.ctxTokens,
    turns: c.turns,
    costUsd: c.costUsd,
    compactFrac: c.compactFrac,
    turnSince: c.working ? c.turnSince : null,
    held: c.held ? { why: c.held.why, until: c.held.until, waiting: c.held.waiting, queue: c.held.queue.length } : null,
    holding: c.holding,
    timeline: live
      ? { id: live.id, title: live.title, plan: live.plan, bornAt: live.bornAt, updatedAt: live.updatedAt }
      : null,
    ending: c.ending,
    owed: c.owed,
  };
}

/** A card on another wall's plan, as this wall's `Timelines` holds one: the
 *  same `Timeline` a plate, the plan strip and the pane draw, under an id no
 *  row of this wall's can have (`elsewhere:<host>:<id>`, the shadow's own
 *  spelling) and owned by the shadow, so `liveFor(shadow.id)` finds it. It has
 *  no session, no path and no spot: it is a reading of a plan, and the owner
 *  alone writes, archives or picks it up. */
export function afarTimeline(owner: { id: string; host: string; project: string; title: string }, g: GistTimeline): Timeline {
  return {
    id: afarTimelineId(owner.host, g.id),
    ownerId: owner.id,
    sessionId: null,
    cwd: "",
    project: owner.project,
    source: owner.title,
    title: g.title,
    plan: g.plan,
    state: "live",
    archivedAt: null,
    glassX: null,
    glassY: null,
    bornAt: g.bornAt,
    updatedAt: g.updatedAt,
    endedAt: null,
  };
}

export function afarTimelineId(host: string, id: string): string {
  return `elsewhere:${host}:${id}`;
}

/** Is this a plan drawn by a card on another wall — one this wall cannot
 *  archive, hang back up or hand to a card? */
export function isAfarTimeline(id: string): boolean {
  return id.startsWith("elsewhere:");
}

/** A count as a surface says it: the number, or `—` for one nothing measured. */
export function countSaid(n: number | null): string {
  return n === null ? "—" : n.toLocaleString();
}
