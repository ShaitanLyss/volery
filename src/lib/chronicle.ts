/* The chronicle: what happened on this wall, and the wisp that says so.
 *
 * One record, read two ways. A **wisp** is an entry in its first few seconds —
 * drawn at the edge of the card that wrote it, in wall space, so where it came
 * from is its *position* rather than a label you have to read. It drifts to the
 * register and settles into it as a row, and the row is the same object: nothing
 * here appears and then vanishes, so there is no dismissal gesture and no "did I
 * miss one".
 *
 * That is the whole of the design's claim, and it is why the geometry is not a
 * decoration: you never read "card X said Y", you watch it leave card X.
 *
 * `chronicle.rs` owns what an entry *is* — who may write one, what a level
 * means, the cap. This is the reading: normalizing a row into something
 * drawable, which entries are still in flight, and the grouping the register's
 * header and the peek both put in front of you when you come back.
 *
 * Pure — no runes — so all of the arithmetic above is tested directly, including
 * the flight, which is the one part of this nobody can check by looking at a
 * still screenshot.
 *
 * ### Two things here are decisions rather than mechanics
 *
 * **A card may not write `ask`.** The levels a card may use are `CARD_LEVELS`,
 * three of the four, and the fourth is Volery's alone. Amber on this wall means
 * *a structured ask is waiting* — `attention.svelte.ts` builds a whole ladder on
 * that, and its head comment argues against there ever being a second answer to
 * "how does Volery get your attention". So the wall may say "this card is asking
 * you"; a card may not claim your attention through this channel. It already has
 * `ask_user`, which is the honest way to want you and costs it its own turn.
 * The asymmetry is in the type on purpose — `Level` is what a row may hold and
 * `CardLevel` is what the `wisp` tool accepts, and nothing has to remember the
 * rule at a call site.
 *
 * **Nothing here escalates.** No level reaches the taskbar, the peek window or
 * the chime. The register is a record; the away-ladder stays Volery's own
 * judgement about cards that are blocked, failed or overdue. Chosen for
 * reversibility as much as for taste: adding escalation later is one optional
 * field on the tool and one branch in the ladder, and removing it later means
 * breaking a tool contract cards have already been taught.
 *
 * ### The cap is a GPU budget, not a taste
 *
 * `MAX_FLYING` and `flying`'s `life` parameter exist because of the measurement
 * in `motion.ts`: on this GPU the dominant term is the **present rate**, not the
 * painted area, so *any* continuously animating element makes the whole window
 * present at display rate and an 8px dot costs what a card-sized glow costs.
 * Three wisps therefore cost what one costs, and thirty cost the same again —
 * but thirty is also unreadable, so the cap is for the eye and the *life* is for
 * the GPU. A wall set to `still` passes `life: 0` and gets no flight at all,
 * which is what "no motion" has to mean; the entry still lands as a row, so
 * turning motion off loses you an animation and not a record.
 */

/** The four a row may hold, in the order the digest reads them — most urgent
 *  first, which is also `DIGEST_ORDER`. Kept in step with `chronicle.rs::LEVELS`,
 *  and the `test/chronicle.test.ts` case that asserts it is the only thing
 *  holding them together, since nothing on the wire carries the vocabulary. */
export const LEVELS = ["ask", "bad", "good", "note"] as const;
export type Level = (typeof LEVELS)[number];

/** The three a *card* may write. See the head comment — this is the escalation
 *  decision, expressed where it cannot be forgotten. */
export const CARD_LEVELS = ["bad", "good", "note"] as const;
export type CardLevel = (typeof CARD_LEVELS)[number];

/** What the wall keeps. The same number `chronicle.rs`'s cap keeps, for
 *  `journal.svelte.ts`'s reason: the Rust side is the source of truth for what
 *  exists, and a front end holding more would be claiming to remember rows a
 *  fresh read could not produce — so a reload would silently shorten the
 *  history and look like data loss. */
export const KEEP = 2000;

/** How long an entry is a wisp before it is only a row, in ms. */
export const WISP_MS = 6_000;

/** How many may be in the air at once. Beyond this the newest are drawn and the
 *  rest are a count — see the head comment for why this bound is about the eye
 *  and `life` is about the GPU. */
export const MAX_FLYING = 3;

/** What the wall can draw of a mark and a detail.
 *
 *  A wisp is drawn *large*, on the wall, for a moment, so a mark is a headline
 *  and not a paragraph. The trim is a backstop rather than the rule — the `wisp`
 *  tool's description asks for one line and `chronicle.rs` trims on the way in,
 *  which is where a card can be told it happened. Here it guarantees only that
 *  no row, however it got into the table, can draw a wall-sized rectangle. */
export const MARK_MAX = 120;
export const DETAIL_MAX = 240;

export type Entry = {
  id: string;
  /** The card that wrote it, or null for one of Volery's own. */
  from: string | null;
  /** The territory it belongs to, or null for a wall-level entry — the
   *  allowance running down belongs to no project. */
  projectId: string | null;
  /** What to call the source when drawing it.
   *
   *  Resolved at write time and stored, rather than looked up when read, and
   *  that is deliberate: a card gets closed, a project gets forgotten, and the
   *  row has to go on saying who spoke. A chronicle whose oldest rows read
   *  "unknown" is a chronicle that has lost the thing it was for. */
  source: string;
  level: Level;
  /** The headline. Drawn large in the wisp, and first in the row. */
  mark: string;
  /** One line under it, or empty. */
  detail: string;
  /** Files it concerns. Empty means none in particular. */
  paths: string[];
  at: number;
  seenAt: number | null;
};

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function maybeNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function isLevel(v: unknown): v is Level {
  return typeof v === "string" && (LEVELS as readonly string[]).includes(v);
}

/** Trim to what the wall can draw, and say so when it had to.
 *
 *  The ellipsis is the point: a silently shortened line reads as a card that
 *  wrote a short line, and the next question after "why is this cut off" is
 *  unanswerable without one. */
export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** A row from the store into something drawable.
 *
 *  The same bargain `normalize` in `sink.ts` strikes, and for the sharper of the
 *  two reasons it gives: a row that fails to draw is a thing that happened and
 *  is now invisible, and not losing those is the entire point of this feature.
 *  So a field renamed, a null where a string belongs, or a level from a newer
 *  build all degrade to something that draws rather than refusing.
 *
 *  `id` and `mark` are the two it cannot be drawn without — everything else has
 *  a sensible absence, while a row with no id could not be marked seen and a row
 *  with no mark is a blank line in the register. */
export function normalize(raw: unknown): Entry | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const mark = str(r.mark).trim();
  if (!id || !mark) return null;
  return {
    id,
    from: typeof r.from === "string" ? r.from : null,
    projectId: typeof r.projectId === "string" ? r.projectId : null,
    source: str(r.source, "volery"),
    /* An unknown level falls to `note` rather than being refused. A newer build
       writing `warn` must not make the entry invisible — and it must not fall to
       `ask` either, which would be a row inventing an urgency nobody wrote. */
    level: isLevel(r.level) ? r.level : "note",
    mark: clip(mark, MARK_MAX),
    detail: clip(str(r.detail).trim(), DETAIL_MAX),
    paths: Array.isArray(r.paths) ? r.paths.filter((p): p is string => typeof p === "string") : [],
    at: num(r.at),
    seenAt: maybeNum(r.seenAt),
  };
}

export function normalizeAll(raw: unknown): Entry[] {
  return Array.isArray(raw) ? raw.map(normalize).filter((e): e is Entry => e !== null) : [];
}

/** The `--st-*` suffix a level is drawn in.
 *
 *  A mapping rather than a stored colour, because colour on this wall is status
 *  and a level *is* a status: celadon finished, rust went wrong, amber is asking,
 *  muted is a note. Nothing here may introduce a colour of its own — see
 *  `tokens.css`. */
export function statusOf(level: Level): "work" | "ask" | "fail" | "rest" {
  switch (level) {
    case "good":
      return "work";
    case "ask":
      return "ask";
    case "bad":
      return "fail";
    default:
      return "rest";
  }
}

/** Newest first. The order both readings want, and the order the store already
 *  returns — restated here so a face never depends on having been handed it.
 *
 *  The tiebreak's only job is determinism. Two rows can share a millisecond —
 *  `store::now()` is ms and a turn ending writes more than one — and an id is
 *  `uuid_v4`, so it carries no time at all: neither direction is the "newer"
 *  one. Ascending, then, because a stable order that nothing has to reason
 *  about beats a clever one, and without it two reads of the same table can
 *  hand the register two different orders and make a row appear to move. */
export function byNewest(entries: readonly Entry[]): Entry[] {
  return [...entries].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function unseen(entries: readonly Entry[]): Entry[] {
  return entries.filter((e) => e.seenAt === null);
}

export function unseenCount(entries: readonly Entry[]): number {
  return unseen(entries).length;
}

export function newest(entries: readonly Entry[]): Entry | null {
  return byNewest(entries)[0] ?? null;
}

/* ── the flight ───────────────────────────────────────────────────────────── */

export type Flight = {
  /** Newest first, at most `max` of them. */
  wisps: Entry[];
  /** How many more were in the air and are not drawn. */
  overflow: number;
};

/** Which entries are still wisps, and how many did not fit.
 *
 *  `life: 0` is the `still` motion setting and returns nothing — see the head
 *  comment. A negative age (a row written by a machine whose clock is ahead, or
 *  a store carried off one machine onto another) counts as in flight rather than
 *  as expired: the alternative is an entry that is never a wisp and never
 *  explains why, and `portage.ts` means rows really do arrive from elsewhere. */
export function flying(
  entries: readonly Entry[],
  now: number,
  max: number = MAX_FLYING,
  life: number = WISP_MS,
): Flight {
  if (life <= 0 || max <= 0) return { wisps: [], overflow: 0 };
  const air = byNewest(entries).filter((e) => now - e.at < life);
  return { wisps: air.slice(0, max), overflow: Math.max(0, air.length - max) };
}

/* ── coming back ──────────────────────────────────────────────────────────── */

/** The order the digest reads, most urgent first. `LEVELS` is declared in this
 *  order so the two cannot drift; this alias is what the intent is called. */
export const DIGEST_ORDER = LEVELS;

/** What each group is called when you come back to it. Lowercase and quiet,
 *  like everything else on the wall, and phrased as what the *things* did rather
 *  than as a category — "went wrong" rather than "errors", because the row under
 *  it is a sentence and not a log level. */
const GROUP_LABEL: Record<Level, string> = {
  ask: "wants you",
  bad: "went wrong",
  good: "finished",
  note: "notes from cards",
};

export type Group = {
  level: Level;
  label: string;
  /** Newest first. */
  entries: Entry[];
};

/** What happened while you were away, grouped.
 *
 *  Unseen only, since that is the whole question — and empty groups are dropped
 *  rather than drawn at zero, because "went wrong: 0" is a line that makes you
 *  check something that did not happen. */
export function digest(entries: readonly Entry[]): Group[] {
  const waiting = unseen(entries);
  const groups: Group[] = [];
  for (const level of DIGEST_ORDER) {
    const mine = byNewest(waiting.filter((e) => e.level === level));
    if (mine.length) groups.push({ level, label: GROUP_LABEL[level], entries: mine });
  }
  return groups;
}

/** The one line the register's edge carries, or empty when there is nothing.
 *
 *  Counted rather than listed, because this is drawn on a widget's top edge in a
 *  strip a few pixels tall and the question it answers is only "is it worth
 *  opening". */
export function tally(entries: readonly Entry[]): string {
  const n = unseenCount(entries);
  if (n === 0) return "";
  return n === 1 ? "1 while you were away" : `${n} while you were away`;
}
