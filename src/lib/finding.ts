/* The finder's own reasoning, with no runes and no Tauri in it.
 *
 * Two separable things live here, and each of them is the sort of thing that
 * is obvious until you write it down:
 *
 *  - **The score.** Which of forty thousand paths you meant by `clssfy`. A
 *    subsequence match is the easy half; the half that decides whether the
 *    panel feels like telescope or like a `grep` is what it prefers when two
 *    paths both match.
 *  - **The merge.** Grep mode was asked to search names *and* contents, which
 *    is two answers arriving from two places and one list to put them in.
 *
 * The third used to be the space leader, which is now `leader.ts`: a machine
 * that answers with a `FindMode` is one that can only ever reach this panel,
 * and the wall grew a second thing to open.
 *
 * Pure, so it is tested directly (`test/finding.test.ts`). Nothing here knows
 * that ripgrep exists.
 */

import { DOCUMENTS, TABLES, extOf } from "./office";

/* ── what the panel is doing ─────────────────────────────────── */

/** Which of the two things the panel is doing.
 *
 *  `files` is a list fetched once and filtered here. `grep` is a question put
 *  to ripgrep per keystroke. They are one panel because they are one gesture
 *  with two settings, and ctrl+F swaps between them without losing the query —
 *  which is the whole reason they share a type rather than being two panels.
 *
 *  The space leader that opens them used to live here too, and is now
 *  `leader.ts` — it stopped being the finder's the moment a second thing
 *  wanted a chord.
 */
export type FindMode = "files" | "grep";

/* ── scoring a path against what you typed ────────────────────────────────── */

/** A run of characters in the candidate that the query matched, for the panel
 *  to draw brighter. Half-open, as every range in this codebase is. */
export type Span = { from: number; to: number };

export type Scored<T> = {
  item: T;
  score: number;
  /** Where the match landed, so it can be marked. Merged into runs rather than
   *  one span per character — the panel draws a `<span>` apiece, and a
   *  fifteen-letter query over a path is fifteen elements against three. */
  spans: Span[];
};

/** Characters after which the next one counts as the start of a word.
 *
 *  Both separators, because a path typed as `src/lib` and a path typed as
 *  `src\lib` are the same path to everybody except a string comparison. */
const BREAK = new Set(["/", "\\", "_", "-", ".", " "]);

/** Score one candidate against one query, or null if the query is not a
 *  subsequence of it at all.
 *
 *  Greedy left-to-right subsequence matching, which is not optimal and is the
 *  right trade: an optimal alignment over 40,000 paths per keystroke is a
 *  dynamic program per path, and greedy plus the bonuses below picks the same
 *  winner in every case anybody types. What the bonuses prefer, in order of
 *  how much they matter:
 *
 *   - **Consecutive characters.** `clsfy` matching `cl` `sfy` beats it matching
 *     five letters strewn across `src/lib/conversation.svelte.ts`. This is the
 *     one that does most of the work, and it compounds along a run so a whole
 *     substring hit is worth far more than two halves.
 *   - **Word starts.** A letter after a `/`, `_`, `-`, `.` or a lowercase→
 *     uppercase step. This is what makes `slt` find `src/lib/theme.ts`.
 *   - **The basename over the directory.** You almost always mean the file. A
 *     query that lands entirely in the last segment beats one spread over the
 *     path, which is what keeps `store` from answering with sixty files that
 *     merely live under a `store/` folder.
 *   - **Shortness**, faintly, as the tiebreak. Between two equally good
 *     matches the shallower path is nearly always the one meant, and without
 *     this the order between them is whatever ripgrep's walk happened to be.
 *
 *  Case-insensitive throughout: nobody types the capital in `Transcript` when
 *  they are looking for it. Case is used only as a bonus, never as a filter. */
export function score(candidate: string, query: string): { score: number; spans: Span[] } | null {
  if (!query) return { score: 0, spans: [] };

  const lowText = candidate.toLowerCase();
  const lowQuery = query.toLowerCase();

  /* Where the last path segment starts, for the basename bonus. -1 + 1 = 0
     when there is no separator, which is the whole path being the basename. */
  const base = Math.max(candidate.lastIndexOf("/"), candidate.lastIndexOf("\\")) + 1;

  let total = 0;
  let at = 0;
  let run = 0;
  let inBase = true;
  const hits: number[] = [];

  for (const ch of lowQuery) {
    /* A space in the query is a separator between terms rather than something
       to find — nobody is looking for a path with a space in it by typing the
       space. Skipping it here is what makes `lib theme` behave as two terms
       without any splitting: the subsequence simply continues. */
    if (ch === " ") {
      run = 0;
      continue;
    }
    const found = lowText.indexOf(ch, at);
    if (found === -1) return null;

    if (found === at && at > 0 && hits.length) {
      /* Consecutive. Compounding rather than flat, so a five-letter substring
         is worth much more than five separate letters — 2, 4, 6, 8, 10 rather
         than 2 apiece. */
      run += 1;
      total += 2 + run * 2;
    } else {
      run = 0;
      total += 1;
    }

    const before = found > 0 ? candidate[found - 1] : "";
    const boundary =
      found === 0 ||
      BREAK.has(before) ||
      /* camelCase, which is half the names in this repo. */
      (before === before.toLowerCase() && candidate[found] !== candidate[found].toLowerCase());
    if (boundary) total += 8;

    /* An exact-case hit is weak evidence you knew the name, and it costs
       nothing to reward: it only ever separates two candidates that already
       match equally. */
    if (candidate[found] === query[hits.length]) total += 1;

    if (found < base) inBase = false;

    hits.push(found);
    at = found + 1;
  }

  /* The whole query landed in the file's own name. Worth a great deal — it is
     the difference between `store` meaning `store.rs` and `store` meaning
     everything under `src/store/`. */
  if (inBase && base > 0) total += 30;
  /* And the file's name *starts* with what you typed, which is as close to
     certainty as a fuzzy match gets. */
  if (hits.length && hits[0] === base) total += 15;

  /* Shortness, as a tiebreak and nothing more — hence the small coefficient
     and the floor, so a deep path is never scored out of the running by its
     depth alone. */
  total += Math.max(0, 20 - candidate.length / 6);

  return { score: total, spans: runsOf(hits) };
}

/** Turn matched indices into the fewest spans that cover them. */
export function runsOf(hits: number[]): Span[] {
  const out: Span[] = [];
  for (const i of hits) {
    const last = out[out.length - 1];
    if (last && last.to === i) last.to = i + 1;
    else out.push({ from: i, to: i + 1 });
  }
  return out;
}

/** Split a string by spans into alternating plain and matched pieces.
 *
 *  Here rather than in the component because it is the one piece of the drawing
 *  that can be got wrong silently — an off-by-one drops a character out of the
 *  middle of a path, and the panel would look entirely plausible. */
export function pieces(text: string, spans: Span[]): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const s of spans) {
    if (s.from > at) out.push({ text: text.slice(at, s.from), hit: false });
    out.push({ text: text.slice(s.from, s.to), hit: true });
    at = s.to;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/** Move spans from indexing a whole path to indexing just its last segment.
 *
 *  The panel draws the directory and the filename as two elements, so a match
 *  marked against the whole path has to be re-based onto the half it landed in.
 *  Spans that fell in the *directory* are dropped rather than clamped to zero:
 *  a clamped half-span puts a bright mark on the first character of the
 *  filename, which is a character that did not match — and marking the wrong
 *  thing is worse than marking nothing, because the marks are the only reason
 *  a fuzzy list is readable. */
export function shift(spans: Span[], cut: number): Span[] {
  return spans
    .filter((s) => s.from >= cut)
    .map((s) => ({ from: s.from - cut, to: s.to - cut }));
}

/** How many results the panel will draw. A cap on the DOM rather than on the
 *  search: everything is scored, and this is how much of the answer is worth
 *  putting on screen. Past this you refine the query rather than scroll. */
export const SHOWN = 200;

/** Rank candidates against a query, best first.
 *
 *  An empty query is not an empty answer — it is the head of the list in the
 *  order ripgrep walked it, which is roughly depth-first and therefore roughly
 *  the shape of the project. That is a better thing to open onto than nothing,
 *  and it is why this returns early rather than scoring every path against "".
 *
 *  The sort is stable on ties by the walk order, which is what keeps the list
 *  from reshuffling when a keystroke changes nothing about the scores. */
export function rank(candidates: string[], query: string, cap = SHOWN): Scored<string>[] {
  if (!query.trim()) {
    return candidates.slice(0, cap).map((item) => ({ item, score: 0, spans: [] }));
  }
  const out: Scored<string>[] = [];
  for (const item of candidates) {
    const s = score(item, query);
    if (s) out.push({ item, score: s.score, spans: s.spans });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, cap);
}

/* ── grep mode: two answers, one list ─────────────────────────────────────── */

/** One line ripgrep found, as `find_grep` reports it. */
export type Hit = {
  /** Relative to the project root, with forward slashes — see `find.rs`. */
  path: string;
  /** 1-based, as every editor and every error message in the world counts. */
  line: number;
  /** 1-based column of the match, for marking it in the preview. */
  col: number;
  /** The whole line, already clipped by Rust. */
  text: string;
};

/** A row in the result list, in either mode.
 *
 *  One type for both because the list, the keyboard and the preview should not
 *  care which mode produced a row — that was the shape that let grep mode
 *  answer with file *names* as well as contents without a second code path.
 *  `line` is null for a row that is a whole file rather than a place in one. */
export type Row = {
  path: string;
  line: number | null;
  col: number | null;
  /** What to draw after the path: the matched line, or nothing. */
  text: string | null;
  /** Where the query matched, in whichever of the two strings it matched in. */
  spans: Span[];
  /** Which string the spans index into — the path, or the line of text. */
  marked: "path" | "text";
};

/** Grep mode's list: file names that match, then lines that match.
 *
 *  Names first, and this is a judgement rather than an accident. Typing
 *  `finding` while looking for `finding.ts` should not put you forty lines
 *  down a list of every file that mentions the word — a name match is a much
 *  stronger statement of intent than a content match, and there are always
 *  fewer of them. The content hits keep ripgrep's own order, which is the
 *  walk order and therefore groups a file's lines together.
 *
 *  `files` may be stale by a keystroke or two — it is fetched once per open —
 *  and that is fine here: a name match that arrives late is a row that appears,
 *  not a wrong answer. */
export function grepRows(hits: Hit[], files: string[], query: string, cap = SHOWN): Row[] {
  const named = query.trim()
    ? rank(files, query, cap).map(
        (s): Row => ({
          path: s.item,
          line: null,
          col: null,
          text: null,
          spans: s.spans,
          marked: "path",
        }),
      )
    : [];

  const seen = new Set(named.map((r) => r.path));
  const rows: Row[] = [...named];

  for (const h of hits) {
    if (rows.length >= cap) break;
    rows.push({
      path: h.path,
      line: h.line,
      col: h.col,
      text: h.text,
      /* Rust hands back a 1-based column and the length it matched is not
         reported, so the mark is the query's length from there — which is
         exactly right for a literal search and approximately right for a
         regex. Approximate is the honest cost of not parsing the pattern. */
      spans: h.col > 0 ? [{ from: h.col - 1, to: h.col - 1 + Math.max(1, query.length) }] : [],
      marked: "text",
    });
    seen.add(h.path);
  }
  return rows;
}

/** Files mode's list. The same shape, so the panel has one kind of row. */
export function fileRows(files: string[], query: string, cap = SHOWN): Row[] {
  return rank(files, query, cap).map((s) => ({
    path: s.item,
    line: null,
    col: null,
    text: null,
    spans: s.spans,
    marked: "path" as const,
  }));
}

/* ── moving about ─────────────────────────────────────────────────────────── */

/** Where Up or Down lands in a list of `count` rows.
 *
 *  Clamps rather than wrapping, for the reason `shell.ts::recall` clamps: a
 *  list that loops round to the top when you hold Down is one you cannot get
 *  out of, and here it is worse — the top of this list is the answer, so
 *  wrapping past the bottom silently puts you back on it as though nothing had
 *  moved. An empty list has nowhere to be, hence the 0. */
export function moveIn(count: number, at: number, by: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, at + by));
}

/* ── the viewer ───────────────────────────────────────────────────────────── */

/** How much of a file the viewer will hold. Generous — this is a reader, and
 *  the files it is pointed at are source — but bounded, because a 40MB log is
 *  a thing that exists and one `<div>` per line of it is not. */
export const VIEW_LINES = 6000;

/** Split a file into numbered lines, capped.
 *
 *  CRLF is dropped rather than kept: every file on this machine has them and a
 *  trailing `\r` in a `<div>` is an invisible character that breaks nothing and
 *  copies wrong. A file that is one enormous line is not split — that is a
 *  minified bundle, and the viewer wrapping it is the honest answer. */
export function viewLines(text: string, cap = VIEW_LINES): { no: number; text: string }[] {
  const out: { no: number; text: string }[] = [];
  /* An empty file is no lines, and `"".split("\n")` is `[""]` — which is one
     line, and slips past the trailing-newline guard below because that only
     fires when there is more than one element. Without this the viewer draws a
     numbered blank row over an empty file, which reads as a file with one
     blank line in it. */
  if (!text) return out;
  const lines = text.split("\n");
  /* A trailing newline makes a final empty element that is not a line of the
     file — every text file ends with one, so drawing it would put a phantom
     numbered row at the bottom of nearly every file. */
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  for (let i = 0; i < lines.length && i < cap; i++) {
    out.push({ no: i + 1, text: lines[i].replace(/\r$/, "") });
  }
  return out;
}

/** How many lines the preview beside the list shows. */
export const PREVIEW_ROWS = 60;

/** The slice of a file the preview shows, as half-open row indices into
 *  `viewLines`'s output.
 *
 *  The hit sits a third of the way down rather than in the middle, because
 *  what you want to see about a line of source is mostly *after* it — the
 *  function you have landed in the top of, rather than the blank line above
 *  the one before it. Both ends clamp, and the clamp is what makes a hit on
 *  line 2 show lines 1–60 instead of an empty half-window.
 *
 *  A row with no line — a whole file, which is every row in files mode — shows
 *  the head, which for source is the imports and for prose is the title. */
export function windowAround(
  total: number,
  line: number | null,
  rows = PREVIEW_ROWS,
): { from: number; to: number } {
  if (total <= rows || line === null) return { from: 0, to: Math.min(total, rows) };
  const from = Math.max(0, Math.min(total - rows, line - 1 - Math.floor(rows / 3)));
  return { from, to: from + rows };
}

/** Files whose viewer draws them as a document rather than as source.
 *
 *  Extension rather than content-sniffing, deliberately: a `.md` that opens as
 *  a wall of `##` is a reader arguing with you, and a heuristic that is right
 *  95% of the time about *whether to render* is worse than a rule you can
 *  predict. `mdx` and `mdc` are in because they parse as markdown for
 *  everything this renderer does with them; the JSX in an `mdx` comes out as
 *  text, which is honest and readable. */
export const MARKDOWN = new Set(["md", "markdown", "mdx", "mdc"]);

/** Whether the viewer opens this one rendered. */
export function isMarkdown(path: string): boolean {
  return MARKDOWN.has(extOf(path));
}

/** The extensions the viewer draws rather than reads.
 *
 *  **Must agree with `find::media_type`**, which is the half that decides the
 *  MIME string and does the reading. Two lists rather than one, and the seam is
 *  the same one `relay.ts` has with `relay.rs`: there is nothing to import
 *  across it, only the two agreeing. This side answers "ask Rust for bytes
 *  instead of text" and needs no MIME at all, so it is a set of extensions and
 *  not a table — a copy of the table would be a second place to get a media type
 *  wrong.
 *
 *  `svg` is deliberately in neither. It is text, so the existing viewer already
 *  opens it and shows what it contains — which is the more useful reading of a
 *  file you are looking at in a code viewer — and it is a document that can
 *  carry script in an app whose `csp` is null. See `find::media_type`. */
export const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);
export const VIDEOS = new Set(["mp4", "m4v", "webm", "ogv", "mov"]);

export type MediaKind = "image" | "video";

/** Which of the viewer's readings a file's *name* suggests.
 *
 *  Five now, and they arrived one at a time — source, then a rendered markdown
 *  document, then an image or a film, and now an Office document or a table. So
 *  this is one lookup rather than the fourth `if (SOMESET.has(ext))` in a row,
 *  which is what the last two were on the way to becoming.
 *
 *  **The one table is about the dispatch, not about the knowledge.** Each set
 *  still lives with the code that knows what to do with it — `DOCUMENTS` and
 *  `TABLES` in `office.ts`, beside the parsers — and this composes them, because
 *  moving them here would put Office's vocabulary in the finder's own module for
 *  no reason but tidiness. What the composition buys is the property that could
 *  not be stated while they were four separate calls: the sets are **disjoint**,
 *  asserted in `test/finding.test.ts`. An extension in two of them is a file
 *  whose reading depends on the order the `if`s happen to be in, which is
 *  exactly the class of bug the `IMAGES`/`VIDEOS` note above is about. */
export type Drawing = "image" | "video" | "markdown" | "document" | "table";

export const READINGS: Record<string, Drawing> = (() => {
  const out: Record<string, Drawing> = {};
  for (const ext of IMAGES) out[ext] = "image";
  for (const ext of VIDEOS) out[ext] = "video";
  for (const ext of MARKDOWN) out[ext] = "markdown";
  for (const ext of Object.keys(DOCUMENTS)) out[ext] = "document";
  for (const ext of TABLES) out[ext] = "table";
  return out;
})();

/** Which reading this file's name suggests, or null for plain source.
 *
 *  By name rather than by content, and that is not the same call `read_text`
 *  makes when it sniffs for a NUL. Sniffing answers "is this text", which an
 *  extension cannot be trusted about, because a file with no extension at all is
 *  perfectly normal. This answers "which of the readings to *try*" — and for the
 *  media arms that is all there is to say, since there is no byte pattern
 *  distinguishing a file the webview will render from one it will show a broken
 *  glyph for.
 *
 *  For a document it is a **hint and nothing more**, which is the half worth
 *  knowing: the reading is settled by `office.sniff` over the file's first bytes
 *  once they arrive, and a `.docx` whose bytes say otherwise is reported rather
 *  than drawn. All this decides there is which command to call, which is a
 *  question about saving a round trip. */
export function drawnAs(path: string): Drawing | null {
  return READINGS[extOf(path)] ?? null;
}

/** Which element would draw this file, or `null` for one to read as text. */
export function mediaKindOf(path: string): MediaKind | null {
  const kind = drawnAs(path);
  return kind === "image" || kind === "video" ? kind : null;
}

/** Whether the viewer asks Rust for this one's bytes as a document. */
export function docKindOf(path: string): "document" | "table" | null {
  const kind = drawnAs(path);
  return kind === "document" || kind === "table" ? kind : null;
}

/* ── reaching the viewer from somewhere else ──────────────────────────────── */

/** A path an agent wrote, reduced to one the viewer can open — or null.
 *
 *  This is the front-end mirror of `safe_join` in `find.rs`, and it exists
 *  because the two sides count from different places. A transcript is full of
 *  absolute paths (`C:\atelier\skein\src\lib\finding.ts`), the viewer reads
 *  `(root, relative)`, and Rust refuses anything that climbs out of the root —
 *  so a path has to be reduced here before it can be offered as a link at all.
 *
 *  **Null is the useful answer**, and it is why this returns one rather than
 *  throwing or clamping. A tool call can perfectly reasonably name a file in
 *  another repository, in `%TEMP%`, or in the engine directory — none of which
 *  this card's viewer can open. Those must stay inert text rather than becoming
 *  a link that fails when pressed, which is the one outcome worse than not
 *  offering the link.
 *
 *  Case-insensitively and over either separator, since Windows hands the same
 *  directory back as `C:\Users\...` or `c:\users\...` depending on who was
 *  asked, and an agent writes whichever slash it feels like. Whole segments
 *  only: `C:\atelier\skein2` is not inside `C:\atelier\skein`. */
export function insideRoot(path: string, root: string): string | null {
  if (!path || !root) return null;
  const norm = (s: string) => s.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  const r = norm(root);
  const p = path.replace(/\\/g, "/");
  const low = p.toLowerCase();

  /* Already relative. Accepted as it is — a tool call that wrote `src/lib/a.ts`
     meant it relative to the card's own directory, which is the root. `..` is
     refused here as well as in Rust, so a relative path that climbs out is not
     offered either. */
  if (!/^([A-Za-z]:|[\\/])/.test(p)) {
    const clean = p.replace(/^\.\//, "");
    if (!clean || clean.split("/").includes("..")) return null;
    return clean;
  }

  if (low === r) return null; // the root itself is a directory, not a file
  if (!low.startsWith(r + "/")) return null;
  const rel = p.slice(r.length + 1);
  return rel || null;
}

/** Where in a line of output a place on disk is named.
 *
 *  A `Grep` result is a list of places — `src/lib/finding.ts:42:7:  const at`
 *  — and every one of them is somewhere you might want to look. So the result
 *  text is scanned for the shape and each hit becomes a link, which turns a
 *  wall of matches into something you can walk.
 *
 *  **The guards matter more than the pattern**, because a false positive here
 *  is a link that goes nowhere sitting in the middle of an agent's output. So a
 *  candidate must carry a *file extension* before the colon — which is what
 *  rules out `10:30`, `Error at 5:12`, and every bare `key: 3` — and anything
 *  inside a `://` is skipped, which is what rules out `http://host:8080`.
 *  Deliberately conservative: a place this misses stays readable text, and a
 *  place it invents does not.
 *
 *  Returns spans into `text` with the parsed place, in the order they occur. */
export type Place = { from: number; to: number; path: string; line: number; col: number | null };

/* Extension before the colon is the whole guard. 1–12 characters of word, since
   `.ts` and `.uproject` both exist and nothing useful is longer.
 *
 * **No space in the path class**, and that is a deliberate loss. Allowing one
 * lets the match run backwards through prose: `see src/lib/a.ts:42` parsed with
 * a path of `see src/lib/a.ts`, and `ripgrep 15.2.0:1` became a place called
 * `ripgrep 15.2.0`. So `C:\Program Files\x\a.ts:3` is missed — which is the
 * right way round to fail, since a place this misses stays readable text and a
 * place it invents is a dead link in the middle of an agent's output. */
const PLACE = /([A-Za-z]:[\\/])?([\w.\-+/\\]*?[\w\-+]\.\w{1,12}):(\d+)(?::(\d+))?/g;

export function placesIn(text: string): Place[] {
  const out: Place[] = [];
  for (const m of text.matchAll(PLACE)) {
    const path = (m[1] ?? "") + m[2];
    /* A url, not a path — and the check is on the *matched* text rather than on
       what precedes it, because the path character class includes `/` and will
       happily swallow a scheme: `http://example.com:8080` matches with a path of
       `http://example.com` and a line of 8080. Looking backwards would never
       have seen it. */
    if (path.includes("://")) continue;
    /* The extension guard has already refused `10:30`; what is left is a "path"
       that is entirely digits and dots, which is a version number. */
    if (/^[\d.]+$/.test(m[2])) continue;
    /* **A relative candidate must carry a separator**, and this is the guard
       that measurement added rather than reasoning. `tools/probe-places.ts` over
       1,150 real tool results found `RailReplayTests.cpp:282` and dozens like
       it — a *filename mentioned in prose*, which `insideRoot` then happily
       reduced to a root-relative path that does not exist, producing precisely
       the dead link this whole pattern is written to avoid.
     *
     * The asymmetry with `insideRoot` is deliberate and is the point: a bare
     * name given as a tool's `file_path` argument genuinely means "relative to
     * the card's directory", because something passed it to a tool that then
     * opened it. A bare name found in a sentence means somebody was talking
     * about a file. Evidence that is good enough for the first is not good
     * enough for the second, so the second asks for more. Cost: `package.json:3`
     * in prose is not a link. Worth it. */
    if (!m[1] && !/[\\/]/.test(m[2])) continue;
    out.push({
      from: m.index,
      to: m.index + m[0].length,
      path,
      line: Number(m[3]),
      col: m[4] ? Number(m[4]) : null,
    });
  }
  return out;
}

/* ── a path named in prose ────────────────────────────────────────────────── */

/** What the transcript needs in order to make a path in prose clickable.
 *
 *  One prop rather than two, because it is threaded through every level of
 *  `Markdown` and `Inlines` and a second `{onpath}` beside `{onlink}` at nine
 *  call sites is nine chances to forget one. Absent where there is no project
 *  behind the prose, which is also how a surface opts out.
 *
 *  `how` is what the gesture meant: `open` reads the file or opens the folder,
 *  `reveal` shows either in Explorer. */
export type FileLinks = {
  /** The card's directory, which a relative path counts from. */
  root: string;
  go: (path: string, line: number | null, how: "open" | "reveal") => void;
};


/** A file or folder an agent named in a sentence, as a span into the text.
 *
 *  `line` is `null` for the common case; `path` is exactly what was written,
 *  which may be absolute, may be relative to the card's directory, and may not
 *  exist at all. */
export type Named = { from: number; to: number; path: string; line: number | null };

/** What a whole string is, read as a path — or null for one that is not.
 *
 *  **Deliberately permissive, where `placesIn` is deliberately strict**, and the
 *  difference is not a disagreement: `placesIn` is the last word on whether a
 *  `path:line` in a tool's output becomes a link, so a false positive there is a
 *  dead link in the middle of an agent's output and the guard has to be the
 *  pattern itself. A path named in prose is checked against the disk before it
 *  is offered (`paths.svelte.ts`), so the pattern here only has to be cheap
 *  enough to ask about — and being strict would cost the thing somebody
 *  actually wants, which is that a folder, a dotfile and a name with no
 *  extension are all openable.
 *
 *  Three things are still refused, because no amount of checking makes them
 *  worth asking about:
 *
 *  - a url, which the separator class would otherwise swallow whole
 *    (`https://example.com/a.ts` has slashes and an extension)
 *  - anything with no separator in it at all, which is the same call `placesIn`
 *    makes for the same reason — a bare name in a sentence is somebody talking
 *    about a file, and resolving it against the card's directory invents a path
 *    nobody wrote
 *  - a *spaced* string that is not plainly absolute, so ``const a = 1 / 2`` in a
 *    code span is not asked about while `C:\Program Files\x\a.ts` still is.
 *    Windows paths have spaces in them and prose has more. */
export function namedPath(
  raw: string,
): { path: string; line: number | null; text: string } | null {
  let s = raw.trim();
  /* The punctuation a sentence wraps a path in. Leading and trailing, and
     repeatedly, since `(see src/a.ts).` wears three of them. */
  while (s && "([{<\"'`".includes(s[0])) s = s.slice(1);
  while (s && ".,;:!?)]}>\"'`".includes(s[s.length - 1])) s = s.slice(0, -1);
  if (!s) return null;
  if (s.includes("://")) return null;

  /* `a.ts:42` and `a.ts:42:7` — the column is parsed so that it is not left on
     the path, and then dropped, because the viewer takes a line and nothing
     else. A trailing `:` has already gone above, so what is left here ends in a
     digit or is not a place at all. */
  let line: number | null = null;
  const text = s;
  const place = /^(.*?):(\d+)(?::\d+)?$/.exec(s);
  if (place && /[\\/]/.test(place[1])) {
    s = place[1];
    line = Number(place[2]);
  }

  const absolute = /^([A-Za-z]:[\\/]|[\\/]|~[\\/])/.test(s);
  if (/\s/.test(s) && !absolute) return null;
  if (!/[\\/]/.test(s)) return null;
  /* Only separators, or a version number somebody wrote with a slash in it. */
  if (!/[\w]/.test(s)) return null;
  if (/^[\d.\\/]+$/.test(s)) return null;
  /* `text` is what the link covers and `path` is what it opens. They differ by
     the `:42:7` a place carries, and keeping both is what stops a column
     number being left dangling as plain text beside its own link. */
  return { path: s, line, text };
}

/** Every path named in a run of prose, in the order they occur.
 *
 *  Tokenised on whitespace rather than matched with one pattern, which is the
 *  readable half of the same bargain `PLACE`'s character class strikes: a
 *  pattern that can run backwards through a sentence is a pattern that will,
 *  and a token is a thing with two ends somebody can reason about. A path with
 *  a space in it is therefore missed here and caught in a code span, where the
 *  whole span is one candidate. */
export function pathsIn(text: string): Named[] {
  const out: Named[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const found = namedPath(m[0]);
    if (!found) continue;
    /* Back to a span in the original text. The trimming above only ever takes
       characters off the two ends, so the path is a substring and `indexOf`
       finds the one occurrence that matters. */
    const at = m[0].indexOf(found.text);
    if (at < 0) continue;
    const from = m.index + at;
    out.push({ from, to: from + found.text.length, path: found.path, line: found.line });
  }
  return out;
}

/** A path as written, resolved against the card's directory.
 *
 *  The counterpart of `insideRoot`, which reduces an absolute path to a
 *  relative one; this is the other direction, and both exist because the two
 *  sides of this app count from different places. A path in prose may be
 *  either, and everything that *acts* on one — the viewer, Explorer — wants to
 *  be told exactly which.
 *
 *  `.` and `..` segments are resolved here rather than passed on. `safe_join`
 *  in `find.rs` refuses a `..` outright, so a path that climbs and comes back
 *  would be refused for a shape it does not really have — and Explorer is
 *  happy either way, which makes this the one place the two agree.
 *
 *  Separators are normalised to the root's, or to `\` when the root has none
 *  to copy. An agent writes whichever slash it feels like and Windows takes
 *  both; what must not happen is a path with one of each going to the shell. */
export function fullPath(root: string, path: string): string {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : root.includes("/") ? "/" : "\\";
  const absolute = /^([A-Za-z]:[\\/]|[\\/]{1,2})/.test(path);
  const joined = absolute ? path : `${root.replace(/[\\/]+$/, "")}${sep}${path}`;
  /* A leading `\\\\` is a UNC share and its two separators are part of the
     name, so the head is kept whole and only the rest is walked. */
  const unc = /^[\\/]{2}/.test(joined);
  const head = unc ? joined.slice(0, 2) : "";
  const parts = (unc ? joined.slice(2) : joined).split(/[\\/]+/);
  const out: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    /* A `..` that would climb past the root of the path is dropped rather than
       kept: there is nothing above a drive letter, and carrying it along would
       hand the shell a path it cannot mean. */
    if (part === "..") {
      if (out.length > 1 || (out.length === 1 && !/^([A-Za-z]:)?$/.test(out[0]))) out.pop();
      continue;
    }
    out.push(part);
  }
  const body = out.join(sep);
  /* A trailing separator says "folder" and is worth keeping — `open_folder`
     does not care, but the string is also what the tooltip shows. */
  const tail = /[\\/]$/.test(path) && !/[\\/]$/.test(body) ? sep : "";
  return head + body + tail;
}

/** The path as two pieces, so the panel can draw the directory quietly and the
 *  file plainly. The directory keeps its trailing separator — it reads as a
 *  path that way, and it means the two halves concatenate back to the whole. */
export function splitPath(path: string): { dir: string; name: string } {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (at === -1) return { dir: "", name: path };
  return { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
}
