/* A board, and where a card goes when you drop it.
 *
 * Pure — no runes, no DOM, no `invoke` — so the one piece of arithmetic that
 * matters here is testable directly: **`plan`, which decides both where the card
 * is drawn and what Asana is told, in one call.** That is the whole design of
 * this file and the reason it exists rather than being inlined in the widget.
 *
 * The optimistic update and the request are two statements of the same
 * intention, and anything that computes them separately eventually computes
 * them differently. The trap is concrete rather than theoretical, and it was
 * measured against the live API on 2026-09-03 rather than read: `POST
 * /sections/{gid}/addTask` with no position puts the task at the **top** of the
 * section — a card at the bottom of a column, re-added with no position, came
 * back at the top. So a widget that drew the card where you dropped it and sent no
 * position would show it at the bottom of the column and have it jump to the
 * top on the next poll — which does not read as a disagreement about ordering,
 * it reads as the app having lost your drag. One function returns the new board
 * *and* the wire arguments, and they cannot disagree because they are the same
 * decision.
 *
 * `asana.svelte.ts` owns the connection and the rollback; `Asana.svelte` draws
 * it; `asana.rs` answers in these shapes.
 *
 * ## Columns are sections
 *
 * Asana has no separate notion of a board column: a *section* draws as a header
 * in list view and as a column in board view. So "the custom status columns" a
 * person means are sections, and `custom_fields` — which is what that phrase
 * sounds like — is a different feature this file knows nothing about. See
 * `asana.rs`. */

/** A card on the board. Mirrors `asana.rs`'s `Card` exactly; the wire is the
 *  only place these two files meet, so they are written out rather than
 *  generated, and the Rust tests and these tests each hold their own end. */
export type Card = {
  gid: string;
  name: string;
  /** Who it is on, or empty. Drawn, never matched on. */
  assignee: string;
  /** `due_on` — an ISO date with no time — or empty. */
  due: string;
  /** Whether the checkmark is ticked. **Not** whether it is in a "done" column;
   *  those are different facts and conflating them is the first thing anybody
   *  gets wrong about Asana. A task can sit in Done for weeks unticked, and a
   *  ticked one stays in whatever column it was in. */
  completed: boolean;
  url: string;
};

export type Column = {
  /** Empty for the unsectioned pile — a real place a task can be and not a
   *  place one can be *put*, since there is no section to POST to. That is what
   *  makes it not a drop target, and `plan` refuses it rather than leaving the
   *  face to remember. */
  gid: string;
  name: string;
  cards: Card[];
};

export type Board = {
  project: string;
  name: string;
  url: string;
  columns: Column[];
  /** Non-zero when the reading stopped at its page cap. A floor rather than a
   *  total — Asana does not say how many are left — so the face says "at
   *  least". Reported because a truncated reading that looks complete is an
   *  instrument claiming to know something it does not. */
  more: number;
  /** How many requests this reading cost. Somebody else's server. */
  asked: number;
};

/** What Asana is told. `before` and `after` are mutually exclusive — the API
 *  refuses both — and at most one is ever non-null here. */
export type Move = {
  task: string;
  section: string;
  before: string | null;
  after: string | null;
};

/* ── the one piece of arithmetic ───────────────────────────────────────────*/

/** Where the card goes, and what Asana is told, in one answer.
 *
 *  `before` is the card the dragged one should land *above*, or null for the
 *  end of the column — which is how a drop reads at the face: you are always
 *  either above something or past everything.
 *
 *  `null` means there is nothing to do, and every no-op arrives here rather
 *  than at the wire: a card that is not on this board, a column that is not, a
 *  drop onto the card's own position, and the unsectioned pile. That matters
 *  beyond tidiness — an optimistic update with no request behind it would draw
 *  a move that never happened and then be "corrected" by the next poll, which
 *  is indistinguishable from a failed save that forgot to roll back. */
export function plan(
  board: Board,
  task: string,
  section: string,
  before: string | null,
): { next: Board; wire: Move } | null {
  /* Not a drop target: there is no section to POST to, so the card can be read
     out of the pile and not put back into it. */
  if (!section) return null;
  /* Dropping a card onto itself. Reads as "above me", which is where it already
     is, and would otherwise compute a wire position naming the dragged task. */
  if (before === task) return null;

  const from = board.columns.find((c) => c.cards.some((k) => k.gid === task));
  const to = board.columns.find((c) => c.gid === section);
  if (!from || !to) return null;
  const card = from.cards.find((k) => k.gid === task);
  if (!card) return null;

  /* The target column without the dragged card, which is the list the drop
     position is relative to — and the list whose neighbours name the wire
     position. Getting this wrong is how `insert_after` ends up naming the very
     task being moved. */
  const rest = to.cards.filter((k) => k.gid !== task);
  const at = before === null ? rest.length : indexOr(rest, before, rest.length);

  /* Already exactly there. Compared against the *original* column so a
     within-column drag that changes nothing is caught: the stripped list plus
     an insertion at `at` has to differ from what is drawn. */
  if (from.gid === to.gid && sameOrder(from.cards, insertAt(rest, card, at))) return null;

  const next: Board = {
    ...board,
    columns: board.columns.map((c) => {
      if (c.gid === to.gid) return { ...c, cards: insertAt(rest, card, at) };
      if (c.gid === from.gid) return { ...c, cards: c.cards.filter((k) => k.gid !== task) };
      return c;
    }),
  };

  /* The wire position, from the same stripped list the card was drawn into.
     Empty column: neither, which is Asana's "top" and is also its only place.
     First: `insert_before` the card that is currently first. Otherwise:
     `insert_after` the one it now sits below — which is the form that survives
     the list having grown since, because it names a neighbour rather than an
     index. */
  const wire: Move =
    rest.length === 0
      ? { task, section, before: null, after: null }
      : at === 0
        ? { task, section, before: rest[0].gid, after: null }
        : { task, section, before: null, after: rest[at - 1].gid };

  return { next, wire };
}

function indexOr(cards: Card[], gid: string, fallback: number): number {
  const i = cards.findIndex((k) => k.gid === gid);
  return i === -1 ? fallback : i;
}

function insertAt(cards: Card[], card: Card, at: number): Card[] {
  const out = cards.slice();
  out.splice(Math.max(0, Math.min(at, out.length)), 0, card);
  return out;
}

function sameOrder(a: Card[], b: Card[]): boolean {
  return a.length === b.length && a.every((k, i) => k.gid === b[i].gid);
}

/** Which column a card is in, or null. What the store compares a landing poll
 *  against, so a reading taken before a move was saved cannot quietly undraw
 *  it. */
export function columnOf(board: Board, task: string): string | null {
  return board.columns.find((c) => c.cards.some((k) => k.gid === task))?.gid ?? null;
}

/* ── readings ──────────────────────────────────────────────────────────────*/

export function cardCount(board: Board): number {
  return board.columns.reduce((n, c) => n + c.cards.length, 0);
}

/** The line under the board's name.
 *
 *  Says what it cost as well as what it holds, the same as the pipelines
 *  widget's: this is somebody else's server and the wall should be honest about
 *  asking. And it says when a reading was cut short, because the alternative is
 *  a board that looks complete and is not. */
export function boardReading(board: Board): string {
  const cols = board.columns.length;
  const cards = cardCount(board);
  const head = `${cols} ${cols === 1 ? "column" : "columns"} · ${
    board.more > 0 ? `at least ${cards}` : cards
  } ${cards === 1 ? "card" : "cards"}`;
  return board.more > 0 ? `${head} · more than one reading holds` : head;
}

/** What a due date says, and whether it is late.
 *
 *  `late` is overdue only, and is deliberately not "urgent": today is not late,
 *  and colouring it as though it were would make every board permanently red
 *  by lunchtime. Colour is status here, and *overdue* is the only status a date
 *  carries on its own.
 *
 *  Both arguments are ISO dates (`2026-09-12`) and the comparison is string
 *  ordering, which is exact for that format and needs no timezone — the one
 *  place a `Date` would introduce one. `today` is passed in rather than read,
 *  which is what makes this testable at all and is the same bargain
 *  `timing.ts` strikes. */
export function dueReading(
  due: string,
  today: string,
): { text: string; late: boolean } | null {
  if (!due || !today) return null;
  const days = dayGap(today, due);
  /* Not a date this can reason about. Shown rather than swallowed: Asana has
     answered `due_on` as a plain date for years, so this is the arm for a field
     that changed shape, and showing it is how anybody would find that out. */
  if (days === null) return { text: due, late: false };
  /* One path for "today" rather than a string comparison above, so there is one
     definition of it — and so an impossible date cannot arrive here having
     quietly become a real one. */
  if (days === 0) return { text: "today", late: false };
  if (days < 0) {
    const late = -days;
    return { text: late === 1 ? "1 day late" : `${late} days late`, late: true };
  }
  if (days === 1) return { text: "tomorrow", late: false };
  if (days <= 13) return { text: `in ${days} days`, late: false };
  return { text: shortDate(due), late: false };
}

/** Whole days from one ISO date to another, or null if either will not parse.
 *
 *  `Date.UTC` on the parsed parts rather than `new Date(iso)`: the string form
 *  is parsed as UTC midnight by the spec and as *local* midnight by enough
 *  engines historically that a date-only comparison can come out a day wrong
 *  either side of a timezone. Building both from parts makes the arithmetic
 *  about the calendar, which is what a due date is. */
function dayGap(from: string, to: string): number | null {
  const a = utcOf(from);
  const b = utcOf(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 86_400_000);
}

function utcOf(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const at = Date.UTC(y, mo, d);
  /* Read back, because `Date.UTC` *rolls over* rather than refusing: the 29th
     of February in a year that has no such day silently becomes the 1st of
     March, and the gap then comes out as zero — so a date that cannot exist
     would draw as "today". Round-tripping is the cheapest way to tell a real
     date from an arithmetic accident, and an impossible one falls through to
     being shown verbatim, which is the only honest reading of it. */
  const back = new Date(at);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo || back.getUTCDate() !== d) {
    return null;
  }
  return at;
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/** `2026-09-12` → `12 sep`. Lowercase, day first, no year: the year is noise on
 *  a board where everything is within a quarter, and a date eighteen months out
 *  is a card nobody is reading the date of. */
function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}`;
}

/** Today, as the ISO date the readings above compare against.
 *
 *  In *local* time, because a due date is a day in the life of the person
 *  looking at the wall rather than an instant — a card due today must not read
 *  as "tomorrow" between midnight and 01:00 in Paris. Impure by nature, so it
 *  is one call in one place and everything downstream of it takes the string. */
export function todayIso(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** What a board with nothing on it should say, or null when there is a board to
 *  draw.
 *
 *  Five silences and they are different facts, which is the whole point of
 *  answering them here rather than with a nested ternary in the markup: a
 *  widget that says "nothing to show" when the real answer is "you have not
 *  stored a token" is a widget that sends you looking in the wrong place. Same
 *  argument `emptySaid` makes for the pipelines face. */
export function emptySaid(
  held: boolean,
  project: string,
  board: Board | null,
  ready: boolean,
): string | null {
  if (!held) return "no asana token — the tokens panel in the header takes one";
  if (!project) return "no project chosen — pick one";
  if (!ready) return "asking…";
  if (!board) return null;
  if (board.columns.length === 0) return "this project has no columns";
  if (cardCount(board) === 0) return "no cards on this board";
  return null;
}
