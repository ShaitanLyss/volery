/* The files kept to hand — a tab above the dock for every file the viewer has
 * opened, so coming back to one is a click rather than a search and a scroll.
 *
 * The problem it exists for is narrow and real: the finder is very good at
 * getting you to a file and has no memory at all. You read halfway down
 * `store.rs`, press Escape to look at the card beside it, and getting back
 * means `<space>ff`, four characters, Enter, and the scroll all over again —
 * which is enough friction that you stop looking things up.
 *
 * **A tab is a reading, not a path.** That is the whole design. It carries
 * where the scroller was, what was selected, and which of the two readings
 * (source or document) it was in, because "the state I was at" is all three of
 * those and a tab that only remembered the path would have saved you the four
 * characters and none of the scroll.
 *
 * ### What is pure here, and what cannot be
 *
 * Everything except the DOM. `finder.svelte.ts` owns the list and calls these;
 * `Dogears.svelte` draws the strip and is the only thing that touches a
 * scroller or a `Selection`, because those are the two facts nothing else can
 * see. The seam between them is `Reading`, which is deliberately plain numbers:
 * a scroll offset and a pair of character offsets over the container's text.
 *
 * Character offsets rather than a line and a column, which is the one part that
 * looks like the harder answer and is the easier one. The source reading is
 * line-numbered `div`s and a rendered document is arbitrary markup, so a
 * line/column pair would work in one and mean nothing in the other; a flat
 * offset over the text nodes works in both, in the same twenty lines, and is
 * exact for as long as the DOM is the same — which it is, since the viewer
 * renders the whole file rather than a window of it.
 *
 * ### The fuse
 *
 * There is no cap on the tabs. What there is instead is a number that are
 * *safe* — the five most recently touched, by default — and a fuse under
 * everything below that line: fall out of the top five and you have five
 * minutes before the tab puts itself away. Coming back to a tab makes it the
 * most recent again, which both takes it off the fuse and resets it.
 *
 * That is a better rule than a hard cap for the reason a hard cap always fails:
 * the sixth file you open is not the least interesting one, it is the newest,
 * and a cap would either refuse it or silently throw away the tab you were
 * about to go back to. Time is the only thing that actually distinguishes a
 * file you are done with from one you are between.
 *
 * Nothing here schedules anything. The wall already has a one-second tick every
 * card reads (`clock` in `conversation.svelte.ts`), and expiry is a fold over
 * it — see the note in CLAUDE.md about looking for an event that already exists
 * near the thing you care about rather than starting a fourth poller.
 */

import { until } from "./limits";

/** How many tabs are safe from the fuse, by default. Five, because that is what
 *  fits across the bottom of a window at this size without the strip becoming a
 *  thing you read rather than a thing you glance at. */
export const KEEP_DEFAULT = 5;

/** And how long the ones below that line have, in minutes. */
export const FUSE_DEFAULT = 5;

/** The bounds the knobs are clamped to. `keep` may be **0**, and that is a real
 *  setting rather than a degenerate one: it is how you turn the strip off
 *  altogether, since a file that is never remembered never gets a tab. The
 *  ceilings are only there so a typo in a number field cannot put four hundred
 *  pills across the wall or a fuse that outlives the wall itself. */
export const KEEP_MAX = 40;
export const FUSE_MIN = 1;
export const FUSE_MAX = 600;

const MINUTE = 60_000;

/** Where a file was being read. Plain numbers on purpose — this is the seam
 *  between the component that can see a scroller and everything that cannot. */
export type Reading = {
  /** The scroller's offset, in px. */
  scroll: number;
  /** What was selected, as character offsets over the container's text nodes
   *  run end to end. Null when nothing was, which is the common case. */
  sel: { from: number; to: number } | null;
};

/** One file kept to hand. */
export type Dogear = {
  root: string;
  path: string;
  /** The line it was opened at, kept so the tab can say `:412` the way the
   *  result row it came from did. Null for a file opened at the top. */
  line: number | null;
  /** Source, or the document — a reading includes which of the two it was, so
   *  resuming a tab has to put that back or the scroll it restores belongs to a
   *  view that is not on screen. See the note on `Finder.raw`. */
  raw: boolean;
  /** Where you were. Null until the tab has been left once: a file that was
   *  opened and never scrolled has nothing to restore, and opening it again
   *  should behave exactly as opening it the first time did. */
  read: Reading | null;
  /** When it was last opened, resumed or left. The fuse burns from here. */
  touched: number;
};

/** What identifies a tab. Root as well as path, since the viewer reads
 *  `(root, relative)` and the same relative path exists in every project on
 *  this wall — `src/lib/theme.ts` in nova and in skein are two files.
 *
 *  A NUL joiner rather than a colon or a slash, because both of those occur in
 *  a Windows path and a key that can collide is a tab that overwrites another
 *  project's. */
export function keyOf(d: { root: string; path: string }): string {
  return `${d.root}\u0000${d.path}`;
}

/** A number, or nothing.
 *
 *  `Number` is the wrong question on its own here and the difference is a bug
 *  rather than a nicety: `Number("")` and `Number(null)` are both **0**, and 0
 *  is a meaningful setting for `keep` — it is the off switch. So a field
 *  somebody cleared, or a key an older build never wrote, would arrive as an
 *  explicit "keep nothing" and blank the strip with nobody having asked for it.
 *  Emptiness is checked before the coercion for exactly that reason. */
function readNum(n: unknown): number | null {
  if (n === null || n === undefined) return null;
  if (typeof n === "string" && n.trim() === "") return null;
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? v : null;
}

/** Clamp the `keep` knob. Anything unreadable falls back to the default rather
 *  than to zero, per the note above. */
export function clampKeep(n: unknown): number {
  const v = readNum(n);
  if (v === null) return KEEP_DEFAULT;
  return Math.max(0, Math.min(KEEP_MAX, v));
}

/** Clamp the fuse, in minutes. */
export function clampFuse(n: unknown): number {
  const v = readNum(n);
  if (v === null) return FUSE_DEFAULT;
  return Math.max(FUSE_MIN, Math.min(FUSE_MAX, v));
}

/** Note a file has been opened fresh — from a result row, or from a path in a
 *  transcript.
 *
 *  Fresh is the operative word, and it is why this clears `read`. You asked for
 *  line 900 of `store.rs`, so line 900 is where it opens, even if a tab for
 *  that file is already carrying a scroll from an hour ago; and a file asked
 *  for with no line opens where a file opens, at the top. Coming back to the
 *  *reading* is what a tab is for and `touch` is the gesture that does it.
 *
 *  The tab keeps its position in the strip when it already existed. Order here
 *  is the order they were opened in and never recency — a strip whose pills
 *  rearranged themselves every time you used one would be a row of buttons that
 *  are never twice in the same place. Recency is `touched`, and the only thing
 *  it decides is the fuse.
 *
 *  `keep: 0` remembers nothing at all, which is the off switch. */
export function remember(
  tabs: Dogear[],
  mark: { root: string; path: string; line: number | null; raw: boolean },
  now: number,
  keep: number,
): Dogear[] {
  if (keep <= 0) return tabs;
  const key = keyOf(mark);
  const at = tabs.findIndex((t) => keyOf(t) === key);
  const fresh: Dogear = { ...mark, read: null, touched: now };
  if (at === -1) return [...tabs, fresh];
  const out = tabs.slice();
  out[at] = fresh;
  return out;
}

/** Bring a tab back to the front of the recency order without disturbing where
 *  it sits or what it remembers. This is resuming one. */
export function touch(tabs: Dogear[], key: string, now: number): Dogear[] {
  const at = tabs.findIndex((t) => keyOf(t) === key);
  if (at === -1) return tabs;
  const out = tabs.slice();
  out[at] = { ...out[at], touched: now };
  return out;
}

/** Write down where a file was being read. Called as the viewer leaves it,
 *  which is the only moment the numbers are true. */
export function mark(tabs: Dogear[], key: string, read: Reading): Dogear[] {
  const at = tabs.findIndex((t) => keyOf(t) === key);
  if (at === -1) return tabs;
  const out = tabs.slice();
  out[at] = { ...out[at], read };
  return out;
}

/** Forget the reading without forgetting the tab — for the one gesture that
 *  invalidates it, which is switching between source and document. The offsets
 *  describe a DOM that is no longer on screen, and a scroll into the middle of
 *  a rendering that has half as many lines is worse than opening at the top. */
export function reread(tabs: Dogear[], key: string, raw: boolean): Dogear[] {
  const at = tabs.findIndex((t) => keyOf(t) === key);
  if (at === -1) return tabs;
  const out = tabs.slice();
  out[at] = { ...out[at], raw, read: null };
  return out;
}

/** Close one. */
export function drop(tabs: Dogear[], key: string): Dogear[] {
  const out = tabs.filter((t) => keyOf(t) !== key);
  return out.length === tabs.length ? tabs : out;
}

/** How long each tab has left, keyed by tab key — null for the ones that are
 *  safe, which is most of them.
 *
 *  Ranked by `touched`, newest first, and ties broken by position so the answer
 *  is stable: two tabs stamped in the same millisecond must not swap places
 *  between one tick and the next, or a pill would flicker on and off the fuse
 *  for as long as they stayed tied. */
export function fuses(
  tabs: Dogear[],
  keep: number,
  fuseMins: number,
  now: number,
): Map<string, number | null> {
  const order = tabs
    .map((t, i) => ({ key: keyOf(t), touched: t.touched, i }))
    .sort((a, b) => b.touched - a.touched || a.i - b.i);
  const span = Math.max(1, fuseMins) * MINUTE;
  const out = new Map<string, number | null>();
  order.forEach((o, rank) => {
    out.set(o.key, rank < keep ? null : Math.max(0, span - (now - o.touched)));
  });
  return out;
}

/** Close whatever has burned down. Returns the same array when nothing has, so
 *  a tick that changes nothing is not a write — this is called every second and
 *  a new array each time would invalidate every `$derived` reading the strip.
 *
 *  A tab whose fuse has *just* reached zero is kept for this tick and gone on
 *  the next, which is deliberate: `> 0` here and `<= 0` in the drawing would
 *  disagree about the final second and the pill would vanish a beat before the
 *  hairline emptied. */
export function reap(
  tabs: Dogear[],
  keep: number,
  fuseMins: number,
  now: number,
): Dogear[] {
  const left = fuses(tabs, keep, fuseMins, now);
  const out = tabs.filter((t) => {
    const ms = left.get(keyOf(t));
    return ms === null || ms === undefined || ms > 0;
  });
  return out.length === tabs.length ? tabs : out;
}

/** How full a fuse still is, 0..1, for the hairline under a pill. 1 is a fresh
 *  fuse and 0 is gone; a safe tab has no hairline at all rather than a full
 *  one, so this is only ever asked about a tab that has one. */
export function burn(leftMs: number, fuseMins: number): number {
  const span = Math.max(1, fuseMins) * MINUTE;
  return Math.max(0, Math.min(1, leftMs / span));
}

/** What a fuse says when you hover it.
 *
 *  `until` from `limits.ts` rather than a formatter of our own: it is the
 *  house wording for how long something has left, and two functions disagreeing
 *  about what four minutes is called is exactly the kind of seam nobody notices
 *  and everybody reads. It stops at "under a minute" rather than ticking down
 *  the seconds, which is also right here — a countdown you can watch is a
 *  countdown you do watch, and the hairline is the part meant to be glanced
 *  at. */
export function sayFuse(leftMs: number): string {
  return `closes in ${until(leftMs)} unless you come back to it`;
}

/** What a pill says: the last directory segment, and the filename.
 *
 *  Not the whole path, and not the bare filename either. The whole path does
 *  not fit and truncating it eats the filename, which is the half you are
 *  reading; the bare name loses the difference between three `mod.rs`. One
 *  segment is short, never needs an ellipsis, and tells `rules/finding.md` from
 *  `lib/finding.ts`. The full path is in the tooltip, which is where a thing
 *  you only occasionally need belongs. */
export function tabLabel(path: string): { dir: string; name: string } {
  const norm = path.replace(/\\/g, "/");
  const cut = norm.lastIndexOf("/");
  if (cut === -1) return { dir: "", name: norm };
  const name = norm.slice(cut + 1);
  const above = norm.slice(0, cut);
  const seg = above.slice(above.lastIndexOf("/") + 1);
  return { dir: seg ? `${seg}/` : "", name };
}

/* ── the selection, as offsets ─────────────────────────────────────────────
 *
 * Two inverses over one thing: a run of text nodes described only by their
 * lengths. The component walks the DOM for those lengths and calls these, which
 * is what keeps every piece of the arithmetic testable while the only untested
 * line is a TreeWalker. */

/** The flat offset of a position given as (which node, how far into it). */
export function flatOf(lengths: number[], i: number, off: number): number {
  let at = 0;
  for (let n = 0; n < i && n < lengths.length; n++) at += Math.max(0, lengths[n]);
  return at + Math.max(0, off);
}

/** And back: which node a flat offset lands in, and how far into it.
 *
 *  A boundary belongs to the *end* of the earlier node — `at` walks on only
 *  while it is strictly past one. Either choice describes the same Range, and
 *  this one is the one that cannot run off the end of the list: an offset equal
 *  to the total length lands on the last node's end rather than on a node that
 *  is not there. */
export function locate(lengths: number[], at: number): { i: number; off: number } {
  if (!lengths.length) return { i: 0, off: 0 };
  let left = Math.max(0, at);
  for (let i = 0; i < lengths.length; i++) {
    const len = Math.max(0, lengths[i]);
    if (left <= len) return { i, off: left };
    left -= len;
  }
  const last = lengths.length - 1;
  return { i: last, off: Math.max(0, lengths[last]) };
}
