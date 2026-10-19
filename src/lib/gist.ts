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
};

/** The one function a gist is made by, for the face here and the digest that
 *  carries it to every other wall. */
export function gistOf(c: GistSource): Gist {
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
  };
}

/** A count as a surface says it: the number, or `—` for one nothing measured. */
export function countSaid(n: number | null): string {
  return n === null ? "—" : n.toLocaleString();
}
