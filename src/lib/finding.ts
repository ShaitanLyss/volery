/* The finder's own reasoning, with no runes and no Tauri in it.
 *
 * Three separable things live here, and each of them is the sort of thing that
 * is obvious until you write it down:
 *
 *  - **The leader.** Space, then a sequence, the way nvim has done it for
 *    twenty years. It is a state machine over two keys and a stopwatch, and
 *    every interesting case is about what happens to the key that does *not*
 *    complete a chord.
 *  - **The score.** Which of forty thousand paths you meant by `clssfy`. A
 *    subsequence match is the easy half; the half that decides whether the
 *    panel feels like telescope or like a `grep` is what it prefers when two
 *    paths both match.
 *  - **The merge.** Grep mode was asked to search names *and* contents, which
 *    is two answers arriving from two places and one list to put them in.
 *
 * Pure, so it is tested directly (`test/finding.test.ts`). Nothing here knows
 * that ripgrep exists.
 */

/* ── the leader ───────────────────────────────────────────────────────────── */

/** The leader key, and it is the space bar because that is where these hands
 *  learned it (nvchad). It is free on this wall for one reason worth stating:
 *  the wall routes a bare printable key into the focused card's draft, and a
 *  prompt never *begins* with a space — by the time a space is a space you are
 *  already typing, focus is in the field, and that branch no longer fires. */
export const LEADER = " ";

/** How long a half-typed chord stands before it is forgotten. nvim's
 *  `timeoutlen` default, and it is a real bound rather than a nicety: a leader
 *  that never lapsed would make the *next* letter you typed on the wall an
 *  hour later part of a sequence you had forgotten opening. */
export const LAPSE_MS = 1000;

/** Which of the two things the panel is doing.
 *
 *  `files` is a list fetched once and filtered here. `grep` is a question put
 *  to ripgrep per keystroke. They are one panel because they are one gesture
 *  with two settings, and ctrl+F swaps between them without losing the query —
 *  which is the whole reason they share a type rather than being two panels. */
export type FindMode = "files" | "grep";

/** Every sequence the leader opens onto, keyed by the letters after it.
 *
 *  Two, deliberately, and they are nvchad's two: `ff` finds a file by name,
 *  `fw` searches for a word. Adding a third is one line here plus one branch
 *  in the panel — the machine below never learns any of these names. */
export const CHORDS: Record<string, FindMode> = {
  ff: "files",
  fw: "grep",
};

/** What a keypress did to the leader sequence.
 *
 *  `swallow` is the field the caller actually acts on, and it is separate from
 *  the kind because the two questions are separate: *what happened* and *whose
 *  key was that*. A `lapse` is the case that makes it worth having — the key
 *  that ends a sequence without completing one is **not** ours, and has to go
 *  on to whatever would have had it. That is what nvim does with `<space>q`:
 *  the space did nothing and the `q` is still a `q`. A finder that ate it
 *  instead would be a wall where a letter occasionally vanished. */
export type Chord =
  /** No sequence was open and this was not the leader. Nothing to do. */
  | { kind: "idle"; open: null; swallow: false }
  /** A modifier pressed on its own. Nothing changed, in either direction. */
  | { kind: "held"; open: string | null; swallow: false }
  /** The leader itself. A sequence is now open. */
  | { kind: "leader"; open: string; swallow: true }
  /** A prefix of something. Keep waiting. */
  | { kind: "pending"; open: string; swallow: true }
  /** A sequence completed. */
  | { kind: "fire"; open: null; swallow: true; mode: FindMode }
  /** A sequence was open and this key is not in any of them. The sequence is
   *  abandoned and the key belongs to somebody else — except for Escape, which
   *  is the one key that means "forget it" and is therefore swallowed. */
  | { kind: "lapse"; open: null; swallow: boolean };

/** Step the leader machine.
 *
 *  `open` is the letters typed since the leader, or null when no sequence is
 *  open. `sinceMs` is how long ago the last of them was pressed — passed in
 *  rather than read from a clock, so the lapse is part of the rule tested here
 *  rather than a `setTimeout` somewhere that nothing can see.
 *
 *  Note the lapse is checked *before* the key is read, and then the key is
 *  reconsidered from scratch. That matters for one case: pressing the leader,
 *  waiting, and pressing the leader again has to open a fresh sequence rather
 *  than be read as `<space><space>`. */
/** Keys that are somebody pressing a modifier and nothing else.
 *
 *  They have to leave a sequence exactly as it was, which is not obvious until
 *  it bites: every one of them fires its own keydown, so without this a hand
 *  brushing Shift between the leader and the letter would abandon the chord —
 *  and, worse, `<space>` then `Shift+F` (which is how a Caps-Locked keyboard
 *  types it) would never fire at all. */
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph"]);

export function chord(open: string | null, key: string, sinceMs = 0): Chord {
  if (MODIFIERS.has(key)) return { kind: "held", open, swallow: false };
  if (open !== null && sinceMs > LAPSE_MS) open = null;

  if (open === null) {
    if (key === LEADER) return { kind: "leader", open: "", swallow: true };
    return { kind: "idle", open: null, swallow: false };
  }

  /* The one key that closes a sequence and is still ours. Everything else that
     fails to match falls through to the wall, but Escape means "I did not mean
     to start this" and letting it also deselect a card would be one press
     doing two things. */
  if (key === "Escape") return { kind: "lapse", open: null, swallow: true };

  /* Modifiers and named keys are not letters in a chord. They abandon the
     sequence rather than extending it with the word "Shift". */
  if (key.length !== 1) return { kind: "lapse", open: null, swallow: false };

  /* Pressing the leader again inside a sequence restarts it, which is what the
     hand means: you have lost your place and are starting over. */
  if (key === LEADER) return { kind: "leader", open: "", swallow: true };

  const next = open + key.toLowerCase();
  const mode = CHORDS[next];
  if (mode) return { kind: "fire", open: null, swallow: true, mode };
  if (Object.keys(CHORDS).some((c) => c.startsWith(next))) {
    return { kind: "pending", open: next, swallow: true };
  }
  return { kind: "lapse", open: null, swallow: false };
}

/** What the hint under a half-typed chord offers.
 *
 *  Which-key, in one line and without a plugin. It exists because a leader
 *  sequence is the one gesture on this wall with *no* affordance at all —
 *  every other binding is either on a button or in a tooltip, and a chord you
 *  have half-forgotten is otherwise something you have to read the source for.
 *
 *  Returns the completions of `open`, as the remaining letters and what they
 *  do, in a stable order so the hint does not reshuffle under your hand. */
export function offers(open: string): { keys: string; mode: FindMode }[] {
  return Object.entries(CHORDS)
    .filter(([seq]) => seq.startsWith(open) && seq.length > open.length)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([seq, mode]) => ({ keys: seq.slice(open.length), mode }));
}

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
  const at = path.lastIndexOf(".");
  if (at === -1) return false;
  return MARKDOWN.has(path.slice(at + 1).toLowerCase());
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

/** Which element would draw this file, or `null` for one to read as text.
 *
 *  By name rather than by content, and that is not the same call `read_text`
 *  makes when it sniffs for a NUL. Sniffing answers "is this text", which an
 *  extension cannot be trusted about, because a file with no extension at all is
 *  perfectly normal. This answers "which element should draw it", which only the
 *  name can say — there is no byte pattern that distinguishes a file the webview
 *  will render from one it will show a broken-image glyph for. */
export function mediaKindOf(path: string): MediaKind | null {
  const at = path.lastIndexOf(".");
  if (at === -1) return null;
  const ext = path.slice(at + 1).toLowerCase();
  if (IMAGES.has(ext)) return "image";
  if (VIDEOS.has(ext)) return "video";
  return null;
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

/** The path as two pieces, so the panel can draw the directory quietly and the
 *  file plainly. The directory keeps its trailing separator — it reads as a
 *  path that way, and it means the two halves concatenate back to the whole. */
export function splitPath(path: string): { dir: string; name: string } {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (at === -1) return { dir: "", name: path };
  return { dir: path.slice(0, at + 1), name: path.slice(at + 1) };
}
