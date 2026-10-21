/* Whether the conversation drawn for a card on another wall is current, and how
   to say so when it is not (sink 920916fa).

   A far card's conversation is pulled over the link (`shadows.svelte.ts`
   `readTail`) and kept in memory. Opening the panel again drew that kept copy
   and, if the card had moved on, swapped the fresh one in when it landed — so
   stale words read as current and the swap read as the card changing under you.

   Pure, so the rules are held by `test/shadow.test.ts` rather than by a wall. */

/** How long after the last time somebody looked at a far card its conversation
 *  is kept fresh in the background. Past it the kept copy is left to go stale
 *  and is read when the card is next opened — a card nobody has looked at for a
 *  while is not worth the owning wall's work on every change it makes. */
export const WARM_MS = 10 * 60_000;

/** The least between two background reads of one card. A working card moves its
 *  mark with every tool call; the read is the owner's front end folding a tail,
 *  so how often it may be asked is a clock rather than the card's chatter. */
export const WARM_EVERY_MS = 3_000;

/** Does a read have to happen? Never read once is yes; a failed last read is
 *  yes; otherwise only if the card's own wall has said it moved on since the
 *  mark the kept copy was read at. */
export function needsRead(s: { hasTail: boolean; readMark: string | null; mark: string; failed: boolean }): boolean {
  if (!s.hasTail || s.failed) return true;
  return s.readMark !== s.mark;
}

/** Should a snapshot that moved a card re-read its conversation unasked? Only
 *  one somebody looked at lately, whose wall is heard, and not faster than
 *  `WARM_EVERY_MS`. */
export function shouldWarm(s: {
  hasTail: boolean;
  warmUntil: number;
  now: number;
  lastRead: number;
  unheard: boolean;
  stale: boolean;
}): boolean {
  return s.hasTail && s.stale && !s.unheard && s.now < s.warmUntil && s.now - s.lastRead >= WARM_EVERY_MS;
}

function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 1 ? "under a minute old" : m === 1 ? "1 min old" : m < 120 ? `${m} min old` : `${Math.round(m / 60)} h old`;
}

/** The quiet line above a far conversation, or null when what is drawn is
 *  current. A read in flight is told apart from a wall that cannot be reached:
 *  the first says it is coming, the second says how old what is drawn is. A
 *  copy that is current by its mark says nothing at all. */
export function tailNote(s: {
  host: string;
  fetching: boolean;
  hasTail: boolean;
  why: string | null;
  readAt: number | null;
  now: number;
  unheard: boolean;
}): string | null {
  if (s.fetching) return `fetching from ${s.host}…`;
  if (!s.hasTail) return null;
  if (s.why || s.unheard) {
    const age = s.readAt === null ? "" : `, ${ago(s.now - s.readAt)}`;
    return `could not reach ${s.host} — showing what it last said${age}`;
  }
  return null;
}
