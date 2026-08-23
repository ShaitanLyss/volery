/* Markdown, as an agent actually writes it.
 *
 * Claude speaks markdown — headings, lists, fenced code, tables — and the
 * transcript showed all of it as literal asterisks and hashes. This turns one
 * `text` line into a small tree the panel renders as elements.
 *
 * It is a parser, not a renderer: nothing here produces a string of HTML, so
 * there is no escaping to get wrong and no `{@html}` anywhere on the path. The
 * component walks the tree and Svelte does the escaping.
 *
 * Deliberately not CommonMark-complete. What is here is what agent prose
 * contains; what is left out is either absent from it (reference links, setext
 * headings, HTML blocks, footnotes) or wrong for this surface (raw HTML, images
 * — the panel has no business fetching from the network).
 *
 * Pure, so it is tested directly — see test/markdown.test.ts. */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; kids: Inline[] }
  | { t: "em"; kids: Inline[] }
  | { t: "del"; kids: Inline[] }
  | { t: "link"; href: string; kids: Inline[] };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { t: "p"; kids: Inline[] }
  | { t: "h"; level: number; kids: Inline[] }
  /** `open` marks a fence with no closer yet — the ordinary state mid-stream,
   *  and the reason a code block doesn't flicker into being a paragraph first. */
  | { t: "code"; lang: string | null; text: string; open: boolean }
  | { t: "quote"; kids: Block[] }
  | { t: "list"; ordered: boolean; start: number; tight: boolean; items: Block[][] }
  | { t: "hr" }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] };

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/;
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const BULLET = /^([ \t]*)([-*+])([ \t]+)(.*)$/;
const ORDERED = /^([ \t]*)(\d{1,9})([.)])([ \t]+)(.*)$/;
/** Escapable ASCII punctuation, per CommonMark. */
const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, "\n").split("\n"));
}

/** Does this line begin a block of its own? Used to decide where a paragraph
 *  or a lazy continuation stops. */
function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HR.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line)
  );
}

type Marker = {
  ordered: boolean;
  indent: number;
  num: number;
  content: string;
  /** The column the item's content starts at — what continuation lines are
   *  measured against, and what tells a nested list from the next item. */
  col: number;
};

function markerAt(line: string): Marker | null {
  /* `* * *` is a rule, not three empty bullets. HR wins, as it does in every
     renderer, or every thematic break becomes a list. */
  if (HR.test(line)) return null;
  const b = BULLET.exec(line);
  if (b) {
    const indent = b[1].length;
    return {
      ordered: false,
      indent,
      num: 1,
      content: b[4],
      col: indent + 1 + b[3].length,
    };
  }
  const o = ORDERED.exec(line);
  if (o) {
    const indent = o[1].length;
    return {
      ordered: true,
      indent,
      num: Number(o[2]),
      content: o[5],
      col: indent + o[2].length + 1 + o[4].length,
    };
  }
  return null;
}

function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    /* A backtick fence's info string can't itself contain a backtick — that is
       what keeps `` `a` and `b` `` from opening a code block. */
    if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      const marker = fence[1][0];
      const len = fence[1].length;
      const indent = line.length - line.trimStart().length;
      const info = fence[2].trim();
      const close = new RegExp(`^ {0,3}\\${marker}{${len},}[ \\t]*$`);
      const body: string[] = [];
      let open = true;
      i++;
      while (i < lines.length) {
        if (close.test(lines[i])) {
          open = false;
          i++;
          break;
        }
        /* The opening fence's indentation is the block's left edge, not part of
           the code. Removing more than a line has is not an error. */
        body.push(lines[i].slice(0, indent).trim() ? lines[i] : lines[i].slice(indent));
        i++;
      }
      out.push({
        t: "code",
        lang: info.split(/\s+/)[0] || null,
        text: body.join("\n"),
        open,
      });
      continue;
    }

    if (HR.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      out.push({
        t: "h",
        level: h[1].length,
        // `## title ##` — a closing run of hashes is decoration, not text.
        kids: parseInline((h[2] ?? "").replace(/[ \t]+#+$/, "")),
      });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (QUOTE.test(l)) {
          buf.push(l.replace(QUOTE, ""));
          i++;
        } else if (l.trim() && !startsBlock(l)) {
          // Lazy continuation: a wrapped quote line often loses its `>`.
          buf.push(l);
          i++;
        } else break;
      }
      out.push({ t: "quote", kids: parseBlocks(buf) });
      continue;
    }

    const mk = markerAt(line);
    if (mk) {
      i = readList(lines, i, mk, out);
      continue;
    }

    const table = readTable(lines, i);
    if (table) {
      out.push(table.block);
      i = table.next;
      continue;
    }

    /* A paragraph runs to the first blank line or the first line that is
       something else. Its own newlines are kept: an agent's line breaks in
       prose are meaningful (a wrapped list of names, an address, a short
       stanza), and collapsing them the way CommonMark does reads as a bug in a
       chat transcript. Same choice GFM's `breaks` makes. */
    const buf = [line.replace(/[ \t]+$/, "")];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !readTable(lines, i)) {
      buf.push(lines[i].replace(/[ \t]+$/, ""));
      i++;
    }
    out.push({ t: "p", kids: parseInline(buf.join("\n")) });
  }

  return out;
}

/** Consume one list starting at `at`, push it, and return the next index. */
function readList(lines: string[], at: number, first: Marker, out: Block[]): number {
  const ordered = first.ordered;
  const items: string[][] = [];
  let tight = true;
  let cur: string[] | null = null;
  let col = 0;
  let blanks = 0;
  let i = at;

  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      blanks++;
      i++;
      continue;
    }

    const mk = markerAt(l);
    /* A marker indented past the current item's content column belongs *to*
       that item — it is a nested list, and is parsed when the item is. */
    if (mk && (cur === null || mk.indent < col)) {
      if (mk.ordered !== ordered) break;
      if (blanks) tight = false;
      cur = [mk.content];
      items.push(cur);
      col = mk.col;
      blanks = 0;
      i++;
      continue;
    }
    if (!cur) break;

    const indent = l.length - l.trimStart().length;
    if (indent >= col) {
      if (blanks) {
        cur.push("");
        tight = false;
      }
      cur.push(l.slice(col));
      blanks = 0;
      i++;
      continue;
    }
    /* An unindented continuation only continues an item while nothing has
       interrupted it — after a blank line, or at anything block-shaped, the
       list is over. */
    if (blanks === 0 && !startsBlock(l) && !readTable(lines, i)) {
      cur.push(l.trim());
      i++;
      continue;
    }
    break;
  }

  out.push({
    t: "list",
    ordered,
    start: first.num,
    tight,
    items: items.map((it) => parseBlocks(it)),
  });
  return i;
}

/** Split one table row into cells. Pipes inside code spans still split — GFM
 *  says so, and `\|` is the escape. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (/(^|[^\\])\|$/.test(s)) s = s.slice(0, -1);
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      buf += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(buf.trim());
      buf = "";
    } else buf += s[i];
  }
  cells.push(buf.trim());
  return cells;
}

/** Is this pair of lines a table's head and its alignment rule?
 *
 *  The whole of the decision, and it takes no more than the two lines — which
 *  is what lets the streaming scanner below ask exactly the question `readTable`
 *  asks without parsing anything. Pulled out rather than duplicated: the two
 *  have to agree, or the scanner settles a line the parser is still using. */
function tableAt(head: string | undefined, spec: string | undefined): boolean {
  if (!head?.includes("|") || !spec?.includes("|")) return false;
  const rule = splitRow(spec);
  return (
    rule.length === splitRow(head).length && rule.every((c) => /^:?-+:?$/.test(c))
  );
}

function readTable(
  lines: string[],
  at: number,
): { block: Block; next: number } | null {
  const head = lines[at];
  const spec = lines[at + 1];
  if (!tableAt(head, spec)) return null;
  const cols = splitRow(head);
  const rule = splitRow(spec);

  const align: Align[] = rule.map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : null;
  });

  const rows: Inline[][][] = [];
  let i = at + 2;
  /* Rows run to the first blank line or the first line that is something else
     — a row without pipes is still a row, which is what GFM says and what a
     one-column table needs. */
  while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
    const cells = splitRow(lines[i]);
    // Ragged rows are common in hand-written tables; pad rather than refuse.
    rows.push(
      Array.from({ length: cols.length }, (_, c) => parseInline(cells[c] ?? "")),
    );
    i++;
  }

  return {
    block: { t: "table", align, head: cols.map(parseInline), rows },
    next: i,
  };
}

/* ── an answer as it is being written ────────────────────────────────────── */

/** An answer split at the last place nothing after it can reach. */
export type Streamed = {
  /** Blocks that cannot change again, parsed exactly once. The *same array*
   *  until one more of them settles, so a panel redrawing per token redraws
   *  none of them. */
  settled: Block[];
  /** The part still being written, re-parsed on every call. */
  tail: Block[];
};

/** The scanner's whole memory of where it stands. */
type Where = {
  /** What would close the fence we are inside, or null for none. */
  fence: RegExp | null;
  /** The list we are inside, as the two things `readList` breaks on: the
   *  column its current item's content starts at, and whether it is numbered. */
  list: { ordered: boolean; col: number } | null;
  /** Blank lines since the last line of content. Only a list cares — a blank
   *  line does not end one, so what the list does *next* is what says whether
   *  those blanks were inside it or after it. */
  blanks: number;
};

const EMPTY: Block[] = [];

/** One growing markdown source, parsed once rather than once per token.
 *
 *  `conv.streaming` grows by a fragment at a time — cards spawn with
 *  `--include-partial-messages`, so that is thousands of times a turn — and
 *  re-parsing the whole of it per delta is quadratic in the length of the
 *  answer. Measured here: 24,400 characters over ~2,000 deltas cost 1,344 ms of
 *  parsing alone, 2.2 ms of it on the last delta; double the answer and the
 *  total quadruples. A hundred-thousand-character plan, which is an ordinary
 *  thing for a card to write, is on the order of twenty seconds of it — on the
 *  same thread that folds every event on the wall, with Svelte's diff of the
 *  block array on top.
 *
 *  This is the argument the panel already makes about `lines`, one level down:
 *  a settled line is folded the once *because* `lines` only ever grows. So does
 *  an answer, and everything above the last **block boundary** in it is settled
 *  in the same sense — it has been written, and nothing arriving later can
 *  reach back past that point and change it.
 *
 *  What counts as a boundary is the whole of the subtlety, and getting it wrong
 *  is a code block that flickers into prose mid-stream. A blank line settles
 *  what is above it: a paragraph stops at one, a quote's lazy continuation
 *  stops at one, a table's rows stop at one, and `readTable`'s one line of
 *  lookahead cannot see past one. **Unless** we are inside a fence, where a
 *  blank line is code, or inside a list, where `readList` counts blanks and
 *  carries on regardless. So the scanner tracks exactly those two and mirrors
 *  `readList`'s break condition branch for branch — and where it cannot yet
 *  tell, it stays *inside*: a boundary that was not one is a wrong answer, a
 *  boundary missed is only a slower one.
 *
 *  What is left is linear — each line is scanned once, and only the tail after
 *  the last boundary is re-parsed. The honest limit is an answer with no
 *  boundary in it at all: one enormous fence, or one loose list running the
 *  whole length of it, is no faster than it was. A fence at least degrades
 *  well, since nothing inside one is parsed for inlines.
 *
 *  The source must only ever *grow*, or start again from a shorter one. `key`
 *  is what tells a different source from a longer one — the panel passes the
 *  card's id, since moving to another card mid-turn is exactly the case a
 *  length comparison cannot see. */
export class StreamedMarkdown {
  #key: string | null = null;
  /** Characters of the source already taken in. */
  #seen = 0;
  /** Every complete line so far, and the incomplete one after the last "\n". */
  #lines: string[] = [];
  #rest = "";
  /** Blocks for `#lines[0 … #at)`, which cannot change again. Replaced rather
   *  than appended to, so its identity is the signal that one more settled. */
  #done: Block[] = EMPTY;
  #at = 0;
  /** How far the boundary scan has read. Never past `#lines.length - 1`: asking
   *  whether a line inside a list is a table's first row takes the line after
   *  it, and the line after the last one has not been written yet. */
  #scanned = 0;
  #where: Where = { fence: null, list: null, blanks: 0 };
  /** The last answer given, so an unchanged source is unchanged output — and so
   *  that being asked twice for the same string costs nothing and changes
   *  nothing. */
  #out: Streamed | null = null;

  read(key: string, src: string): Streamed {
    if (key !== this.#key || src.length < this.#seen) {
      this.#key = key;
      this.#seen = 0;
      this.#lines = [];
      this.#rest = "";
      this.#done = EMPTY;
      this.#at = 0;
      this.#scanned = 0;
      this.#where = { fence: null, list: null, blanks: 0 };
      this.#out = null;
    }
    if (this.#out && src.length === this.#seen) return this.#out;

    this.#take(src.slice(this.#seen));
    this.#seen = src.length;
    this.#settle();

    /* The tail is what is still in play: the lines below the last boundary, and
       the part of the newest line that has no newline after it yet. */
    const tail = this.#lines.slice(this.#at);
    for (const l of this.#rest.replace(/\r\n?/g, "\n").split("\n")) tail.push(l);
    this.#out = { settled: this.#done, tail: parseBlocks(tail) };
    return this.#out;
  }

  /** Take in what has arrived since last time, as whole lines. */
  #take(add: string) {
    if (!add) return;
    let chunk = this.#rest + add;
    /* A "\r" at the very end may be half of a "\r\n" whose other half is in the
       next fragment, so it waits rather than becoming a line break here. */
    let hold = "";
    if (chunk.endsWith("\r")) {
      hold = "\r";
      chunk = chunk.slice(0, -1);
    }
    const parts = chunk.replace(/\r\n?/g, "\n").split("\n");
    this.#rest = parts.pop()! + hold;
    for (const l of parts) this.#lines.push(l);
  }

  /** Read the new lines, and settle everything above the last boundary. */
  #settle() {
    const lines = this.#lines;
    const w = this.#where;
    const end = lines.length - 1;
    let bound = -1;
    let i = this.#scanned;

    while (i < end) {
      const line = lines[i];
      const blank = !line.trim();

      if (w.fence) {
        if (w.fence.test(line)) w.fence = null;
        i++;
        continue;
      }

      if (w.list) {
        if (blank) {
          w.blanks++;
          i++;
          continue;
        }
        /* Branch for branch with `readList`'s loop, and it has to stay that
           way — this is the one place the scanner can be wrong in the
           direction that costs a wrong answer rather than a slow one. */
        const mk = markerAt(line);
        if (mk && mk.indent < w.list.col) {
          /* The same kind carries the list on; a different kind ends it and
             starts another on the very same line. Either way a list is open,
             which is all this needs to know. */
          w.list = { ordered: mk.ordered, col: mk.col };
          w.blanks = 0;
          i++;
          continue;
        }
        if (line.length - line.trimStart().length >= w.list.col) {
          w.blanks = 0;
          i++;
          continue;
        }
        if (w.blanks === 0 && !startsBlock(line) && !tableAt(line, lines[i + 1])) {
          i++;
          continue;
        }
        /* The list is over — so the blanks before this line were after it, and
           the last of them is a boundary after all. */
        if (w.blanks > 0) bound = i;
        w.list = null;
        w.blanks = 0;
        // and this line is read at the top level, below.
      }

      if (blank) {
        bound = i + 1;
        i++;
        continue;
      }

      const f = FENCE.exec(line);
      if (f && !(f[1][0] === "`" && f[2].includes("`"))) {
        w.fence = new RegExp(`^ {0,3}\\${f[1][0]}{${f[1].length},}[ \\t]*$`);
        i++;
        continue;
      }

      /* Everything else is either one line (a heading, a rule) or something a
         blank line already ends (a quote and its lazy continuation, a table's
         rows, a paragraph), so a list is the only other thing worth carrying.
         `markerAt` answers null for a quote and for a thematic break, which is
         what keeps this in step with `parseBlocks`' order of tries. */
      const mk = markerAt(line);
      w.list = mk ? { ordered: mk.ordered, col: mk.col } : null;
      w.blanks = 0;
      i++;
    }

    this.#scanned = i;
    if (bound > this.#at) {
      this.#done = this.#done.concat(parseBlocks(lines.slice(this.#at, bound)));
      this.#at = bound;
    }
  }
}

/** The words of an inline run, with every mark taken off. */
export function inlineText(kids: Inline[]): string {
  let out = "";
  for (const k of kids) out += k.t === "text" || k.t === "code" ? k.v : inlineText(k.kids);
  return out;
}

/** How long a bold opening can be and still be a label rather than a sentence
 *  somebody emphasised. */
const RUN_IN_MAX = 90;

/** The run-in heading a paragraph opens with, or `null`.
 *
 *  Agents write a section's name in bold at the head of its paragraph far more
 *  often than they write `##` above it — `**1. The impact pipeline.** The
 *  largest unbuilt system left…` is six sections and no headings at all. On the
 *  page that bold *is* the heading: it is where a section starts and what it is
 *  called, and a rail that lists only `#` headings has nothing to say about an
 *  answer written this way, which is most of them.
 *
 *  It has to open the paragraph — bold in the middle of a sentence is emphasis,
 *  and there is no section beginning there — and it has to be short, or a first
 *  sentence written in bold for weight becomes a rail entry that is the
 *  paragraph again. */
export function runIn(kids: Inline[]): string | null {
  /* A leading space of its own is not a reason to say no: the paragraph still
     opens with the bold, whatever the source's indentation was. */
  const head = kids[0]?.t === "text" && !kids[0].v.trim() ? kids[1] : kids[0];
  if (!head || head.t !== "strong") return null;
  const label = inlineText(head.kids).replace(/\s+/g, " ").trim();
  if (!label || label.length > RUN_IN_MAX) return null;
  return label;
}

/** Where a `href` may point. Everything else renders as plain text: this window
 *  is the app, so a `javascript:` or `data:` destination has nothing legitimate
 *  to do in a transcript. */
export function safeHref(raw: string): string | null {
  const href = raw.trim().replace(/^<|>$/g, "");
  // A space or a control character in a destination means it was never one.
  if (!href || href.split("").some((ch) => ch <= " ")) return null;
  if (/^(https?:\/\/|mailto:)/i.test(href)) return href;
  if (/^www\./i.test(href)) return `https://${href}`;
  return null;
}

function runAt(src: string, i: number, ch: string): number {
  let n = 0;
  while (src[i + n] === ch) n++;
  return n;
}

/** The next run of exactly `len` `ch`s that could close a span opened at
 *  `from`. Exactly, not at least: `*a **b** c*` closes on the final single
 *  asterisk, and taking the first run of two would tear the nesting apart.
 *  Code spans are skipped whole, so `**a `b*` c**` still works. */
function findCloser(src: string, from: number, ch: string, len: number): number {
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      const run = runAt(src, i, "`");
      const end = src.indexOf("`".repeat(run), i + run);
      i = end === -1 ? i + run : end + run;
      continue;
    }
    if (c === ch) {
      const run = runAt(src, i, ch);
      const before = src[i - 1];
      if (run === len && before && !/\s/.test(before)) return i;
      i += run;
      continue;
    }
    i++;
  }
  return -1;
}

/** The matching `]` for the `[` at `open`, honouring nesting and code spans. */
function closeBracket(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") {
      const run = runAt(src, i, "`");
      const end = src.indexOf("`".repeat(run), i + run);
      i = end === -1 ? i + run - 1 : end + run - 1;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i;
  }
  return -1;
}

function matchLink(src: string, at: number): { nodes: Inline[]; end: number } | null {
  const image = src[at] === "!";
  const open = image ? at + 1 : at;
  const close = closeBracket(src, open);
  if (close === -1 || src[close + 1] !== "(") return null;

  let depth = 0;
  let end = -1;
  for (let i = close + 1; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
      continue;
    }
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  const label = src.slice(open + 1, close);
  // `(url "title")` — the title is a tooltip nobody asked for; the url is all we take.
  const href = safeHref(src.slice(close + 2, end).trim().split(/\s+/)[0] ?? "");
  const kids = parseInline(label);

  /* An image is rendered as a link to it. The panel does not fetch anything —
     reference images are a deliberate, hand-placed thing on the wall (see
     images.svelte.ts), and a transcript that quietly reached the network would
     be a different app. */
  if (!href) return { nodes: kids.length ? kids : [{ t: "text", v: label }], end: end + 1 };
  return {
    nodes: [{ t: "link", href, kids: kids.length ? kids : [{ t: "text", v: href }] }],
    end: end + 1,
  };
}

function matchEmphasis(src: string, at: number): { node: Inline; end: number } | null {
  const ch = src[at];
  const run = runAt(src, at, ch);
  const len = ch === "~" ? 2 : Math.min(run, 3);
  if (ch === "~" && run < 2) return null;
  if (len > run) return null;

  // An opener is glued to what it opens: `a * b` is arithmetic, not emphasis.
  const after = src[at + len];
  if (!after || /\s/.test(after)) return null;
  /* `_` never fires inside a word, or every `snake_case_name` in prose turns
     into italics halfway through. `*` may, which is what makes `a**b**c` bold. */
  if (ch === "_" && /[\p{L}\p{N}]/u.test(src[at - 1] ?? "")) return null;

  const close = findCloser(src, at + len, ch, len);
  if (close === -1) return null;
  if (ch === "_" && /[\p{L}\p{N}]/u.test(src[close + len] ?? "")) return null;

  const kids = parseInline(src.slice(at + len, close));
  const end = close + len;
  if (ch === "~") return { node: { t: "del", kids }, end };
  if (len === 3) return { node: { t: "strong", kids: [{ t: "em", kids }] }, end };
  return { node: { t: len === 2 ? "strong" : "em", kids }, end };
}

/* A bare url ends before the punctuation that ends the sentence it sits in.
   A closing paren counts only if the url opened one — wikipedia links do. */
function trimUrl(url: string): string {
  let s = url;
  while (s.length) {
    const last = s[s.length - 1];
    if (".,;:!?'\"".includes(last)) s = s.slice(0, -1);
    else if (last === ")" && (s.match(/\(/g)?.length ?? 0) < (s.match(/\)/g)?.length ?? 0))
      s = s.slice(0, -1);
    else break;
  }
  return s;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];

    if (c === "\\" && PUNCT.test(src[i + 1] ?? "")) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    if (c === "`") {
      const run = runAt(src, i, "`");
      const close = src.indexOf("`".repeat(run), i + run);
      /* Only a *matched* run is code. An unmatched backtick is a literal one —
         which is also what keeps a half-typed span from swallowing the rest of
         a streaming line. */
      if (close !== -1 && runAt(src, close, "`") === run) {
        flush();
        let v = src.slice(i + run, close);
        if (v.length > 2 && v.startsWith(" ") && v.endsWith(" ")) v = v.slice(1, -1);
        out.push({ t: "code", v });
        i = close + run;
        continue;
      }
    }

    if (c === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({
          t: "link",
          href: m[1],
          kids: [{ t: "text", v: m[1].replace(/^mailto:/i, "") }],
        });
        i += m[0].length;
        continue;
      }
    }

    if (c === "[" || (c === "!" && src[i + 1] === "[")) {
      const link = matchLink(src, i);
      if (link) {
        flush();
        out.push(...link.nodes);
        i = link.end;
        continue;
      }
    }

    if (c === "*" || c === "_" || c === "~") {
      const em = matchEmphasis(src, i);
      if (em) {
        flush();
        out.push(em.node);
        i = em.end;
        continue;
      }
    }

    /* Bare urls. Agents write them unadorned far more often than they write
       `[label](url)`, and an unlinked one is the single most common thing you
       want to click in a transcript. */
    if ((c === "h" || c === "w") && !/[\p{L}\p{N}]/u.test(src[i - 1] ?? "")) {
      const m = /^(?:https?:\/\/|www\.)[^\s<>"'`\]]+/.exec(src.slice(i));
      if (m) {
        const url = trimUrl(m[0]);
        const href = safeHref(url);
        if (href) {
          flush();
          out.push({ t: "link", href, kids: [{ t: "text", v: url }] });
          i += url.length;
          continue;
        }
      }
    }

    buf += c;
    i++;
  }

  flush();
  return out;
}
