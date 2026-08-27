/* Reading a background job's output while it is still being written.
 *
 * A card's long-running work — a dev server, a watcher, a test run somebody
 * backgrounded — writes to a file the CLI names in its receipt and then says
 * nothing more about until it finishes. `Conversation.jobs` already knows the
 * work exists; this is what it takes to *read* it, and it is all arithmetic
 * about bytes rather than anything about Claude.
 *
 * Two things are being got right here and both were got wrong first in a
 * scratch build:
 *
 * **A log is opened at its end.** A dev server left up overnight is tens of
 * megabytes, and the useful part is the last screenful. So the first read seeks
 * backwards from the size rather than starting at zero — which means the first
 * chunk begins mid-line, and the half-line at the front of it has to go or the
 * pane opens on a fragment that reads as corruption.
 *
 * **The file is appended to, not rewritten.** Every read after the first starts
 * where the last one stopped, so a 40 MB log costs one 40 MB read on open and
 * a few hundred bytes a second afterwards. The two ways that continuity breaks
 * — the file shrank because something rotated or truncated it, and the read had
 * to skip ahead because more arrived than a single read will carry — are the
 * same case as far as the fold is concerned: what is held is no longer
 * contiguous with what arrived, so it is dropped rather than spliced. Splicing
 * them is how a pane ends up showing two halves of different minutes glued at a
 * line boundary, with nothing saying so.
 *
 * Pure — no runes, no DOM, no `invoke`. `Jobs.svelte` draws it and does the
 * polling; the poll is folded onto the wall's own second tick rather than being
 * a fourth clock, and the argument for that is in `.claude/rules/panel.md`. */

import { spanOf } from "./classify";
import { diagnosticOf } from "./buildlog";
import type { Row } from "./logface";

/** How many complete lines of one job's output are held in memory.
 *
 * A bound on this process rather than on the pane: the panel scrolls, so unlike
 * a widget on the wall there is no height deciding what fits. What decides it is
 * that a card may hold several jobs and a dev server prints all day, and a
 * transcript panel that grew without limit would be a leak wearing a feature's
 * clothes. Four hundred is a couple of screenfuls at any reading size, and the
 * face says it is showing the last four hundred rather than implying it has
 * them all. */
export const TAIL_LINES = 400;

/** The most one read will carry back over the IPC boundary.
 *
 * 256 KB is roughly ten times the deepest opening screenful and small enough
 * that the copy is not felt. It is a cap on the *transport*, not on the file:
 * when more than this has arrived since the last read, `readWindow` takes the
 * newest 256 KB and says how much it stepped over. */
export const READ_BYTES = 256 * 1024;

/** `from` of -1 means nothing has been read yet — the file is opened at its end.
 *
 *  Not 0, which is a real offset and the one a rewound file legitimately takes.
 *  Conflating them is how a re-opened pane read a 40 MB dev-server log from the
 *  beginning and showed the morning's startup banner as though it were now.
 *
 *  **Where in the file to read is Rust's decision and not this module's**, and
 *  the split is deliberate: choosing the offset needs the file's length, which
 *  is a `stat` — asking for it from here would be a second round trip per tick
 *  for a number the read is about to take anyway. So `joblog::read_from` owns
 *  the seek and has `cargo test` over it; this module owns what the pane holds
 *  and has `test/jobs.test.ts` over that. `fold` is written so that it does not
 *  *need* to know how the offset was chosen — it compares the offset it was
 *  handed against the one it expected, which is the whole of the contract
 *  between the two halves. */
export const UNREAD = -1;

/** Everything one job's pane is holding between reads. */
export type Held = {
  /** Complete lines, oldest first, capped at `TAIL_LINES`. */
  lines: string[];
  /** The end of the file with no newline on it yet — a line still being
   *  written, or a progress bar that never ends one. Kept out of `lines` so it
   *  cannot be drawn twice as it grows. */
  partial: string;
  /** Where the next read starts. `UNREAD` until the first has landed. */
  next: number;
  /** Bytes of this file that were never on screen. */
  skipped: number;
};

export const NOTHING_HELD: Held = { lines: [], partial: "", next: UNREAD, skipped: 0 };

/** What one read brought back. `at` is where it actually started, which is not
 *  necessarily where the last one stopped — see `readWindow`. */
export type Chunk = { at: number; text: string; next: number };

/** Fold a chunk into what is held.
 *
 * The whole of the subtlety is the first line. When `at` is anything but the
 * offset the last read stopped at, this chunk is not contiguous with what is
 * held — so the held lines go, the held partial goes, and the chunk's own first
 * line goes too, because a read that started at an arbitrary byte started in the
 * middle of one. The exception is `at === 0`, which is a genuine beginning and
 * whose first line is whole.
 *
 * `\r` is stripped from the end of each line rather than the text being split on
 * a newline pair: the two ends of a pipe on Windows do not reliably agree, and a
 * log with mixed endings should not draw half its lines with a stray glyph. */
export function fold(held: Held, got: Chunk, cap = TAIL_LINES): Held {
  const contiguous = got.at === held.next;
  let text = contiguous ? held.partial + got.text : got.text;
  let skipped = held.skipped;

  if (!contiguous) {
    skipped += Math.max(0, got.at - Math.max(0, held.next));
    if (got.at > 0) {
      /* Started mid-line. A chunk with no newline in it at all is *entirely* a
         fragment, so there is nothing to keep — not even a partial, or the next
         chunk would be glued onto half a line. */
      const cut = text.indexOf("\n");
      text = cut < 0 ? "" : text.slice(cut + 1);
    }
  }

  const parts = text.split("\n");
  const partial = parts.pop() ?? "";
  const grown = contiguous ? [...held.lines, ...parts] : parts;
  const lines = grown.length > cap ? grown.slice(grown.length - cap) : grown;

  return {
    lines: lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)),
    partial,
    next: got.next,
    skipped,
  };
}

/** The lines as the face draws them, newest last.
 *
 * The partial rides along as an ordinary row, because from the reader's side a
 * line still being written is a line — it simply has no newline on it yet. It is
 * held separately only so that it can be *replaced* rather than appended to as
 * it grows.
 *
 * The tone is `buildlog`'s, deliberately and not a fourth copy of the same
 * judgement: what a backgrounded `run_in_background` command is, nearly always,
 * is a build, a test run or a server, which is exactly the subject
 * `diagnosticOf` was measured against. The gutter mark is null throughout —
 * every line here came down the same pipe from the same command, so a mark
 * naming its source would name the same thing four hundred times. */
export function rowsOf(held: Held): Row[] {
  const all = held.partial ? [...held.lines, held.partial] : held.lines;
  return all.map((text) => {
    const d = diagnosticOf(text);
    return {
      mark: null,
      tone: d === "error" ? ("fail" as const) : d === "warning" ? ("warn" as const) : ("plain" as const),
      text,
    };
  });
}

/** A size, for the one place a byte count is worth saying out loud.
 *
 *  Not `perf.ts`'s `bytes`, which is about memory and stops at MB with one
 *  decimal — a log that has run to 3 GB is a real thing to be told about, and
 *  rounding it to "3072.0 MB" reads as an instrument that has lost its footing. */
export function size(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** What one job's row says when it is folded away.
 *
 *  The label is the model's own `description` where it wrote one — see
 *  `jobLabel` — so this adds only the two things the label cannot carry: what
 *  kind of work it is, and how long it has been at it. The age is the whole
 *  point of the row: a job of ninety seconds is a command, and one of four hours
 *  is a dev server somebody has forgotten about. */
export function jobCap(
  job: { label: string; kind: string; since: number },
  now: number,
): string {
  const age = spanOf(Math.max(0, (now - job.since) / 1000));
  return `${job.label} · ${job.kind} · ${age}`;
}

/** Why this job's pane has nothing in it, in the pane's own words.
 *
 * Four answers and they are genuinely different things to say, which is why this
 * is not a boolean. `nofile` is the one worth being careful about: a `Monitor`
 * and an `Agent` name no output file in their receipt and theirs is derived from
 * the session and the task id — so a CLI that moves its task directory lands
 * here, and the honest thing is to say the file is not where it should be rather
 * than to draw an empty pane that reads as a silent process. Same bargain
 * `store::pending_jobs` strikes when it existence-checks a derived path. */
export function absence(why: "waiting" | "empty" | "nofile" | "unreadable"): string {
  switch (why) {
    case "waiting":
      return "reading…";
    case "empty":
      return "started, and has printed nothing yet";
    case "nofile":
      return "this kind of job writes no log Volery can find — its result arrives as a notification";
    case "unreadable":
      return "its output file is not where the CLI said it would be";
  }
}

/** The one line the drawer's own cap carries.
 *
 * Said in full rather than as a count, because the count is the thing the card's
 * hollow ring already draws and a second copy of it would be furniture. What a
 * person opening this wants is what the work *is*. */
export function drawerCap(jobs: { label: string }[]): string {
  if (!jobs.length) return "no background work";
  if (jobs.length === 1) return `${jobs[0].label} — running in the background`;
  return `${jobs.length} background jobs — ${jobs.map((j) => j.label).join(", ")}`;
}

/** What a pane says about what it will never show you.
 *
 * Null when nothing was missed, which is the ordinary case for a job whose log
 * has been open since it started. Non-null is either an opening — the pane
 * seeks to the end of a file that was already large — or a burst that outran a
 * single read. Both are a real gap in what is on screen, and the rule this
 * follows is the one the workflow cap follows: **a bound on coverage is said out
 * loud, because silent truncation reads as having shown everything.** */
export function missing(held: Held): string | null {
  if (held.skipped <= 0) return null;
  return `${size(held.skipped)} earlier isn't shown — opened at the end`;
}
