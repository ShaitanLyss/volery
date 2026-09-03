/* Office documents, read rather than refused.
 *
 * A `.pdf`, a `.docx`, an `.xlsx`, a `.pptx` and a `.csv` are the working set
 * of a company that runs on Office 365, and until now every one of them landed
 * on the viewer's binary path — `read_text` sniffs the head for a NUL, all five
 * of them have one, and the panel said **"not a text file — nothing to read
 * here"**. Which is the right sentence for an `.exe` and the wrong one for the
 * spreadsheet somebody just asked you about. Sink 7b661546.
 *
 * ### Why the parsing is here, and why it has no dependencies
 *
 * The reading is what decided it. A `.docx` here becomes `Block[]` — the same
 * value `parseMarkdown` produces — so it is drawn by the repo's own
 * `Markdown.svelte`, at the theme's reading size, inside the same measure a rule
 * is read at. That is a *better* document than any converter hands over, because
 * the alternatives all answer in their own vocabulary: `mammoth` gives HTML that
 * would then have to be sanitised and themed from nothing, and SheetJS gives a
 * cell matrix that still needs the grid written on top of it. Both would have
 * been a dependency bought to do the half of the work that was already done.
 *
 * What the dependency would have bought is *coverage* — SheetJS knows a thousand
 * quirks of a thousand producers — and that is the honest cost of this file. The
 * bet is that the quirks worth having are few and nameable (shared strings,
 * date formats, sheet order, a semicolon-separated CSV) and that each of them is
 * cheaper to hold as twenty tested lines than as a megabyte nobody in this repo
 * can read. If that bet turns out wrong it turns out wrong per format, and one
 * arm of `Doc` can be replaced without touching the others.
 *
 * The dependencies are none because the platform has the three primitives:
 * `DecompressionStream("deflate-raw")` is the inflate, `TextDecoder` is the
 * decode, and OOXML's XML wants a scanner rather than a parser since it is
 * machine-written and uses about six of XML's features. `DOMParser` was the
 * obvious reach for that last one and is deliberately not taken: it does not
 * exist outside a browser, so taking it would move this file out of the tested
 * half of the codebase to save eighty lines.
 *
 * Rust's share of the feature is *bytes past `safe_join`* and nothing else — it
 * learns no format vocabulary at all, which is why there is no third extension
 * table to keep in agreement with `find.rs`. Only one side is guessing. See
 * `finding.ts`.
 *
 * **The one arm this leaves on the table is legacy `.doc`/`.xls`/`.ppt`**, which
 * are OLE compound files and get a plate that names them and offers the desktop.
 * That is a real gap and the named way to close it is `calamine` in Rust, which
 * opens `.xls` properly and would be faster than this on a large workbook
 * besides. It is a separate piece of work with its own IPC shape, not a thing to
 * bolt onto a zip reader.
 *
 * **The framing that matters for safety: this parses to data.** Nothing here
 * executes a document. A `.docx` becomes `Block[]` — the same value
 * `parseMarkdown` produces — and is drawn by the repo's own `Markdown.svelte`, so
 * a Word file reads in the viewer exactly as a rule does. A spreadsheet becomes
 * strings in a grid. The one active format is PDF, and it is the one thing here
 * that is *not* parsed: see `Folio.svelte` for where it is drawn and what that
 * costs.
 *
 * Pure, so it is tested directly (`test/office.test.ts`).
 */

import type { Align, Block, Inline } from "./markdown";

/* ── what a document turns into ───────────────────────────────────────────── */

/** One cell of a spreadsheet, already a string.
 *
 *  `num` is kept apart from the text because it is the only thing the drawing
 *  needs that the text cannot say: a column of numbers reads right-aligned and a
 *  column of labels does not, and "does this look like a number" guessed at
 *  render time would right-align a part code. */
export type Cell = { v: string; num: boolean };

/** One sheet — of a workbook, or the whole of a CSV. */
export type Grid = {
  name: string;
  rows: Cell[][];
  /** Rows or columns were cut at `GRID_ROWS`/`GRID_COLS`. Said out loud in the
   *  panel, the same bargain the finder's own `capped` strikes: a reader that
   *  quietly cannot see the bottom of a sheet is worse than one that admits it. */
  capped: boolean;
};

/** A document, in the shape the viewer draws.
 *
 *  Four arms rather than one per file extension, because the *reading* is what
 *  differs and not the format: a `.docx` and a `.pptx` are both prose, a `.xlsx`
 *  and a `.csv` are both a grid, and `.doc`/`.xls`/`.ppt` are all the same
 *  answer — a different and much nastier container that this does not open. */
export type Doc =
  | { kind: "sheet"; sheets: Grid[] }
  /** `Block[]`, so `Markdown.svelte` draws it. See the note at the top. */
  | { kind: "prose"; blocks: Block[]; what: "word" | "deck" }
  /** Not parsed. The bytes, for the webview's own viewer — `Folio.svelte`. */
  | { kind: "pdf"; bytes: Uint8Array }
  /** A legacy OLE compound file. Named, and handed to the desktop. */
  | { kind: "legacy"; what: string };

/* ── the extension hint ───────────────────────────────────────────────────── */

/** Which document reading a *name* suggests, for deciding which command to call.
 *
 *  A **hint**, and the word is doing work. The reading is decided on the bytes
 *  (`sniff`), because that is the rule `read_text` already keeps and an
 *  extensionless file is normal; this only answers "is it worth asking for the
 *  bytes at all", which is a question about avoiding a round trip and nothing
 *  more. When the two disagree the bytes win, out loud — see `readDocument`.
 *
 *  Keyed by extension in one table rather than a set per family, which is the
 *  shape `finding.ts` now uses for all four readings: a third parallel array
 *  would have inherited the hazard the `IMAGES`/`VIDEOS` pair already has, of
 *  two lists that must agree and no reason they will. */
export const DOCUMENTS: Record<string, "pdf" | "word" | "sheet" | "deck" | "legacy"> = {
  pdf: "pdf",
  docx: "word",
  /* Macro-enabled and template spellings are the same container with a
     different content type, and Word writes them for the same documents. The
     macros are XML we never look at, let alone run. */
  docm: "word",
  dotx: "word",
  xlsx: "sheet",
  xlsm: "sheet",
  xltx: "sheet",
  pptx: "deck",
  pptm: "deck",
  potx: "deck",
  /* The pre-2007 spellings. A different format entirely — OLE compound files,
     records rather than XML — and the honest answer is a plate that names them
     and offers the desktop. Kept in the table rather than left out so that
     answer is given deliberately instead of arriving as "not a text file". */
  doc: "legacy",
  xls: "legacy",
  ppt: "legacy",
};

/** A `.csv` is *text*, so it comes down the text path and never needs bytes.
 *
 *  Which makes it the one format here with two honest readings and therefore the
 *  only one whose `raw` toggle means anything: the grid, or the file. Kept apart
 *  from `DOCUMENTS` for exactly that reason — the entries there are all files
 *  with no source to show. `tsv` too, since the sniff below finds its delimiter
 *  without being told. */
export const TABLES = new Set(["csv", "tsv"]);

/** The extension, lowercased, or `""` for a file with none. */
export function extOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dot = path.lastIndexOf(".");
  if (dot === -1 || dot < slash + 2) return "";
  return path.slice(dot + 1).toLowerCase();
}

/* ── sniffing the container ───────────────────────────────────────────────── */

/** What the first bytes of a file say it is.
 *
 *  Three containers, and the vocabulary stops there on purpose: `zip` does not
 *  say *which* OOXML document, because the answer to that is inside the archive
 *  and `readDocument` is already opening it. A sniffer that guessed the family
 *  from the extension after refusing to trust it for the container would be
 *  keeping the guess and losing the argument.
 *
 *  `PK\x05\x06` and `PK\x07\x08` are the empty and spanned spellings of a zip's
 *  first record; an OOXML file always starts with `PK\x03\x04`, but a reader that
 *  only knew the one would call a legitimately empty archive "not a document",
 *  which is a worse sentence than "there is nothing in it". */
export type Container = "pdf" | "zip" | "ole";

export function sniff(bytes: Uint8Array): Container | null {
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf"; // %PDF-
  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04])) return "zip";
  if (starts(bytes, [0x50, 0x4b, 0x05, 0x06])) return "zip";
  if (starts(bytes, [0x50, 0x4b, 0x07, 0x08])) return "zip";
  /* The OLE compound file header — `.doc`, `.xls`, `.ppt`, and also `.msi` and
     a dozen other things nobody means. Recognised so it can be *named*. */
  if (starts(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole";
  return null;
}

function starts(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
  return true;
}

/** Base64 to bytes.
 *
 *  Here rather than in the caller because it is the seam Rust hands the file
 *  across, and it is the one line in the arrangement where a wrong answer is
 *  silent: `atob` on a string with a stray newline in it throws, and on a string
 *  that is merely the wrong length returns something shorter than the file. */
export function bytesOf(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/* ── the zip ──────────────────────────────────────────────────────────────── */

/** How many entries one archive may have.
 *
 *  A `.docx` is a dozen; a `.xlsx` with a chart per sheet is a few hundred. Four
 *  thousand is far past anything Office writes and near enough that a hand-made
 *  archive cannot make this loop the reason the app stopped. */
const ZIP_ENTRIES = 4096;

/** And how much it may inflate to, over all of them.
 *
 *  This is the zip-bomb bound and it is the reason it is a *total* rather than a
 *  per-entry one: the classic bomb is not one enormous member, it is ten
 *  thousand small ones. 96 MB is roomy for a real deck with images in it — which
 *  are never inflated here anyway, since only the XML members are asked for. */
const ZIP_INFLATED = 96 * 1024 * 1024;

/** One member of an archive, located but not yet read. */
type Entry = {
  name: string;
  /** 0 stored, 8 deflate. Anything else is refused by name. */
  method: number;
  from: number;
  compressed: number;
  size: number;
};

/** An archive's members, addressable by name and read on demand.
 *
 *  Lazy, and that is the whole reason it is a class rather than a
 *  `Map<string, Uint8Array>`: a deck of forty slides with a photograph on each is
 *  mostly JPEG, none of which this reads, and inflating the archive to find the
 *  four XML files in it would be the expensive way to get the cheap answer. */
export class Zip {
  #data: Uint8Array;
  #entries = new Map<string, Entry>();
  #inflated = 0;

  private constructor(data: Uint8Array, entries: Map<string, Entry>) {
    this.#data = data;
    this.#entries = entries;
  }

  /** Read an archive's central directory.
   *
   *  The central directory rather than a walk of the local headers, and it is not
   *  a preference: a local header is allowed to defer its sizes to a data
   *  descriptor *after* the compressed bytes (general-purpose flag bit 3), which
   *  is what a streaming writer does — so a walk from offset zero cannot know
   *  where the next header starts. The directory always carries the real sizes. */
  static open(data: Uint8Array): Zip {
    const eocd = findEocd(data);
    if (eocd === -1) throw new Error("not a zip archive — no end-of-directory record");

    /* Zip64 is refused rather than half-read. Office writes it only past 65,535
       members or 4 GB, both of which are far past `DOC_CAP` — so the case is
       unreachable in practice, and a clear sentence beats a reader that would
       otherwise take the truncated 32-bit fields at face value and index into
       the middle of the file. */
    const count = u16(data, eocd + 10);
    const cdAt = u32(data, eocd + 16);
    if (count === 0xffff || cdAt === 0xffffffff) {
      throw new Error("this archive is zip64, which this reader does not open");
    }

    const entries = new Map<string, Entry>();
    let at = cdAt;
    for (let i = 0; i < count && i < ZIP_ENTRIES; i++) {
      if (at + 46 > data.length || u32(data, at) !== 0x02014b50) break;
      const flags = u16(data, at + 8);
      const method = u16(data, at + 10);
      const compressed = u32(data, at + 20);
      const size = u32(data, at + 24);
      const nameLen = u16(data, at + 28);
      const extraLen = u16(data, at + 30);
      const commentLen = u16(data, at + 32);
      const localAt = u32(data, at + 42);
      const name = utf8(data.subarray(at + 46, at + 46 + nameLen));
      at += 46 + nameLen + extraLen + commentLen;

      /* Bit 0 is "encrypted". Refused by *skipping* rather than by throwing: a
         document with one protected member is still a document, and the member
         that is asked for will report its own absence. */
      if (flags & 0x1) continue;
      if (method !== 0 && method !== 8) continue;

      /* Where the bytes actually are. The local header repeats the name and may
         carry a *different* extra field, so its length has to be read here
         rather than assumed from the directory's. */
      if (localAt + 30 > data.length || u32(data, localAt) !== 0x04034b50) continue;
      const from = localAt + 30 + u16(data, localAt + 26) + u16(data, localAt + 28);
      if (from + compressed > data.length) continue;

      entries.set(name, { name, method, from, compressed, size });
    }
    return new Zip(data, entries);
  }

  /** Every member's name, in directory order. */
  get names(): string[] {
    return [...this.#entries.keys()];
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  /** One member's bytes, or null if it is not there.
   *
   *  Absence is the useful answer for the same reason `insideRoot`'s null is: a
   *  `.xlsx` with no `sharedStrings.xml` is an entirely ordinary workbook — one
   *  whose cells are all numbers — and a reader that threw over it would refuse
   *  the simplest file of the lot. */
  async read(name: string): Promise<Uint8Array | null> {
    const e = this.#entries.get(name);
    if (!e) return null;
    const raw = this.#data.subarray(e.from, e.from + e.compressed);
    this.#inflated += e.size;
    if (this.#inflated > ZIP_INFLATED) {
      throw new Error("this archive inflates to more than this reader will hold");
    }
    if (e.method === 0) return raw;
    return inflate(raw);
  }

  /** One member as text. UTF-8, which every part of an OOXML document is. */
  async text(name: string): Promise<string | null> {
    const bytes = await this.read(name);
    return bytes ? utf8(bytes) : null;
  }
}

/** Where the end-of-central-directory record is.
 *
 *  Scanned backwards, because it is the *last* record and its own length depends
 *  on a trailing comment nobody can predict. 65,557 is the furthest back it can
 *  legally be — a 16-bit comment length plus the 22-byte record. */
function findEocd(data: Uint8Array): number {
  const floor = Math.max(0, data.length - 65_557);
  for (let at = data.length - 22; at >= floor; at--) {
    if (u32(data, at) === 0x06054b50) return at;
  }
  return -1;
}

/** `deflate-raw` through the platform, which has had it since 2023.
 *
 *  The write is deliberately not awaited before the read: `Response` drains the
 *  readable end, so awaiting the writer first would park on a stream nobody is
 *  yet reading. Its rejection is swallowed for the same reason it cannot be
 *  awaited — a corrupt member surfaces as the `arrayBuffer` below failing, which
 *  is the error with the useful message in it. */
async function inflate(raw: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const w = ds.writable.getWriter();
  void w.write(raw).then(
    () => w.close(),
    () => {},
  );
  const out = await new Response(ds.readable).arrayBuffer();
  return new Uint8Array(out);
}

function u16(d: Uint8Array, at: number): number {
  return d[at] | (d[at + 1] << 8);
}
function u32(d: Uint8Array, at: number): number {
  return (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24)) >>> 0;
}

const DECODER = new TextDecoder("utf-8");
function utf8(bytes: Uint8Array): string {
  return DECODER.decode(bytes);
}

/* ── xml ──────────────────────────────────────────────────────────────────── */

/** A parsed element. `kids` holds elements and text runs, in document order.
 *
 *  Text is kept as strings in the same array rather than gathered onto the
 *  element, because mixed content is the whole of what a Word paragraph is —
 *  `<w:r>` then `<w:tab/>` then `<w:r>` — and an element that had lost the order
 *  of its children would have lost the sentence. */
export type El = { name: string; attrs: Record<string, string>; kids: (El | string)[] };

/** How deep an element tree may nest, and how many elements it may have.
 *
 *  Both are bounds on a document written by something other than Office. The
 *  depth one is the load-bearing half: this parser is a loop with a stack rather
 *  than recursion, so what an unbounded nest costs is memory rather than the
 *  stack — which fails later and less clearly. */
const XML_DEPTH = 256;
const XML_NODES = 400_000;

/** A tag scanner, not an XML parser, and the difference is the licence.
 *
 *  It handles what OOXML uses: elements, attributes, text, self-closing tags,
 *  comments, CDATA, the declaration and a doctype. It does **not** do namespace
 *  resolution, entity declarations, or validation — and namespaces are the one
 *  worth saying out loud, because the way it copes is what everything downstream
 *  depends on: prefixes are kept as written and matched on the **local** name
 *  (`local`, `kids`, `first` below). Word has always written `w:` and PowerPoint
 *  `a:`, but that is a convention and not the spec, and a reader that hard-coded
 *  the prefix would be one that a different producer's file broke.
 *
 *  Malformed input yields a shorter tree rather than an exception. That is the
 *  right failure here — half a document is readable and a thrown error is not —
 *  and it is why nothing below trusts an element to have the children it should. */
export function parseXml(src: string): El | null {
  const root: El = { name: "#doc", attrs: {}, kids: [] };
  const stack: El[] = [root];
  let nodes = 0;
  let at = 0;
  const n = src.length;

  while (at < n) {
    const lt = src.indexOf("<", at);
    if (lt === -1) break;
    if (lt > at) {
      /* Every text run is kept here, whitespace included, and the structural
         ones are dropped afterwards by `prune`. Deciding it while scanning was
         the first attempt and cannot work: whether a whitespace run is markup
         depends on whether its parent turns out to have element children, and at
         the moment the run is read the parent's later children have not been
         seen — so the indentation before a paragraph's first `<w:r>` was kept
         and every paragraph in a pretty-printed document gained a newline. */
      stack[stack.length - 1].kids.push(unescapeXml(src.slice(at, lt)));
    }
    at = lt;

    if (src.startsWith("<!--", at)) {
      const end = src.indexOf("-->", at + 4);
      at = end === -1 ? n : end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", at)) {
      const end = src.indexOf("]]>", at + 9);
      const body = src.slice(at + 9, end === -1 ? n : end);
      stack[stack.length - 1].kids.push(body);
      at = end === -1 ? n : end + 3;
      continue;
    }
    if (src.startsWith("<?", at)) {
      const end = src.indexOf("?>", at + 2);
      at = end === -1 ? n : end + 2;
      continue;
    }
    if (src.startsWith("<!", at)) {
      const end = src.indexOf(">", at + 2);
      at = end === -1 ? n : end + 1;
      continue;
    }

    const gt = findTagEnd(src, at);
    if (gt === -1) break;
    const body = src.slice(at + 1, gt);
    at = gt + 1;

    if (body.startsWith("/")) {
      const name = body.slice(1).trim();
      /* Closed by name rather than by position: an unmatched closer in the
         middle of a file would otherwise pop a parent and reparent the whole
         rest of the document under its grandparent. */
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    const el = readTag(inner);
    if (!el) continue;
    if (++nodes > XML_NODES) break;
    stack[stack.length - 1].kids.push(el);
    if (!selfClosing && stack.length < XML_DEPTH) stack.push(el);
  }

  const top = (root.kids.find((k) => typeof k !== "string") as El | undefined) ?? null;
  if (top) prune(top);
  return top;
}

/** Drop the whitespace that was indentation rather than content.
 *
 *  **An element with element children has no meaningful whitespace-only text
 *  between them**, which is true of every OOXML part and is the whole rule. An
 *  element with *no* element children keeps whatever it has, which is what makes
 *  `<w:t xml:space="preserve"> </w:t>` a single space — the only way there is to
 *  write one in a Word document.
 *
 *  A pass rather than a decision taken while scanning, for the reason in the
 *  note above: the question cannot be answered until the element is closed.
 *  Office writes these files without indentation, so on a real document this
 *  finds nothing and costs one walk; on anything a human or another producer
 *  formatted, it is the difference between a paragraph and a paragraph with a
 *  newline glued to the front of it. */
function prune(el: El) {
  let hasElements = false;
  for (const k of el.kids) if (typeof k !== "string") hasElements = true;
  if (hasElements) {
    el.kids = el.kids.filter((k) => typeof k !== "string" || k.trim() !== "");
    for (const k of el.kids) if (typeof k !== "string") prune(k);
  }
}

/** The `>` that ends a tag, skipping any inside a quoted attribute value. */
function findTagEnd(src: string, at: number): number {
  let quote = "";
  for (let i = at + 1; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

const ATTR = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function readTag(body: string): El | null {
  const m = /^([\w:.-]+)/.exec(body);
  if (!m) return null;
  const attrs: Record<string, string> = {};
  for (const a of body.slice(m[1].length).matchAll(ATTR)) {
    attrs[a[1]] = unescapeXml(a[3] ?? a[4] ?? "");
  }
  return { name: m[1], attrs, kids: [] };
}

/** The five predefined entities and numeric references, and nothing else.
 *
 *  Nothing else exists in an OOXML part — a declared entity would need a DTD,
 *  which these files do not carry — and an unknown `&foo;` is left as written,
 *  which is the visible failure rather than the silent one. */
export function unescapeXml(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code =
          body[1] === "x" || body[1] === "X"
            ? parseInt(body.slice(2), 16)
            : parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
    }
  });
}

/** An element's local name — `w:p` is a `p`. See the note on `parseXml`. */
export function local(name: string): string {
  const at = name.indexOf(":");
  return at === -1 ? name : name.slice(at + 1);
}

/** Child elements with this local name. */
export function kids(el: El | null | undefined, name: string): El[] {
  if (!el) return [];
  const out: El[] = [];
  for (const k of el.kids) if (typeof k !== "string" && local(k.name) === name) out.push(k);
  return out;
}

/** The first child with this local name, or null. */
export function first(el: El | null | undefined, name: string): El | null {
  if (!el) return null;
  for (const k of el.kids) if (typeof k !== "string" && local(k.name) === name) return k;
  return null;
}

/** The first descendant with this local name, breadth-first, or null.
 *
 *  Breadth rather than depth, which matters for the one case it is used for:
 *  a slide's `txBody` is looked for under a shape, and a depth-first walk would
 *  find one belonging to a *nested* group before the shape's own. */
export function find(el: El | null | undefined, name: string): El | null {
  if (!el) return null;
  let level: El[] = [el];
  for (let d = 0; d < XML_DEPTH && level.length; d++) {
    const next: El[] = [];
    for (const e of level) {
      for (const k of e.kids) {
        if (typeof k === "string") continue;
        if (local(k.name) === name) return k;
        next.push(k);
      }
    }
    level = next;
  }
  return null;
}

/** All the text under an element, concatenated in document order. */
export function textOf(el: El | null | undefined): string {
  if (!el) return "";
  let out = "";
  const walk = (e: El, depth: number) => {
    if (depth > XML_DEPTH) return;
    for (const k of e.kids) {
      if (typeof k === "string") out += k;
      else walk(k, depth + 1);
    }
  };
  walk(el, 0);
  return out;
}

/** An attribute by local name, ignoring its prefix. */
export function attr(el: El | null | undefined, name: string): string | null {
  if (!el) return null;
  for (const k of Object.keys(el.attrs)) if (local(k) === name) return el.attrs[k];
  return null;
}

/** The **relationship** id an element points at, which is not `attr(el, "id")`.
 *
 *  This needs its own function because of one element, and it is the one that
 *  matters most: a real `<p:sldId id="256" r:id="rId2"/>` carries *both*. `id`
 *  there is PowerPoint's own slide number and `r:id` is the relationship — so
 *  looking a local name up would answer `256`, the map lookup would miss, and
 *  every deck would silently fall through to the guess-from-filenames path.
 *
 *  Which is exactly the bug a hand-written fixture hides: a test archive is
 *  written with the attributes the reader needs, so `<p:sldId r:id="rId2"/>`
 *  passes and no real file does. Found by reading the format rather than by the
 *  suite, which is worth knowing about every test in `office.test.ts` — they
 *  prove the reader consistent with what somebody believed the format was.
 *
 *  So: a prefixed `:id` wins over a bare one, and a bare one is the fallback for
 *  a producer that declares the relationship namespace as the default. */
export function relId(el: El | null | undefined): string | null {
  if (!el) return null;
  const keys = Object.keys(el.attrs);
  for (const k of keys) if (k.endsWith(":id")) return el.attrs[k];
  for (const k of keys) if (k === "id") return el.attrs[k];
  return null;
}

/* ── relationships ────────────────────────────────────────────────────────── */

/** An OOXML part's `_rels`, as id → target.
 *
 *  Every cross-reference in these formats goes through one: a workbook names
 *  `rId3` and the rels file says that is `worksheets/sheet2.xml`. Targets are
 *  relative to the *owning part's* directory, which is why the callers below
 *  join rather than using them as written. */
export function rels(xml: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  const root = xml ? parseXml(xml) : null;
  for (const r of kids(root, "Relationship")) {
    const id = attr(r, "Id");
    const target = attr(r, "Target");
    /* The leading slash is *kept*: a `/xl/styles.xml` is package-absolute and
       must not be joined onto the naming part's directory, or `under("xl", ...)`
       answers `xl/xl/styles.xml`. Stripping it here was the first attempt and is
       wrong for exactly the targets that carry one. */
    if (id && target) out[id] = target;
  }
  return out;
}

/** Join a rels target onto the directory of the part that named it. */
function under(dir: string, target: string): string {
  /* Package-absolute, so it is already the whole path. */
  if (target.startsWith("/")) return target.replace(/^\/+/, "");
  if (!target.startsWith("../")) return dir ? `${dir}/${target}` : target;
  /* `../media/x.png` from `ppt/slides` is `ppt/media/x.png`. Office writes these
     for anything shared between parts. */
  const up = dir.split("/").slice(0, -1).join("/");
  return under(up, target.slice(3));
}

/* ── spreadsheets ─────────────────────────────────────────────────────────── */

/** How much of a sheet the viewer holds.
 *
 *  A cap on what is *built*, not on what is drawn — the rule `find.rs` states
 *  about every one of its own bounds. 5,000 rows is a sheet you scroll and
 *  256 columns is past `IV`, which is where Excel itself stopped until 2007;
 *  together they are 1.2M cells, which is more than the DOM should hold and
 *  about ten times more than anybody reads in a viewer. */
export const GRID_ROWS = 5000;
export const GRID_COLS = 256;

/** A cell reference's column, zero-based. `A1` → 0, `AA7` → 26. */
export function colOf(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
    else break;
  }
  return n - 1;
}

/** A workbook, as its sheets in the order the tabs are in.
 *
 *  Order comes from `workbook.xml` rather than from the file names, and that is
 *  not pedantry: `sheet1.xml` is the order the sheets were *created* in, which
 *  is not the order they are shown in the moment anybody drags a tab. */
export async function readWorkbook(zip: Zip): Promise<Grid[]> {
  const book = parseXml((await zip.text("xl/workbook.xml")) ?? "");
  const map = rels(await zip.text("xl/_rels/workbook.xml.rels"));
  const shared = await readShared(zip);
  const dates = await readDateStyles(zip);

  const out: Grid[] = [];
  const listed = kids(first(book, "sheets"), "sheet");
  for (const s of listed) {
    const id = relId(s);
    const target = id ? map[id] : null;
    if (!target) continue;
    const xml = await zip.text(under("xl", target));
    if (xml === null) continue;
    out.push({
      name: attr(s, "name") || `sheet ${out.length + 1}`,
      ...readSheet(xml, shared, dates),
    });
  }

  /* A workbook whose `workbook.xml` we could not follow is still a workbook —
     fall back to the worksheet parts in name order, which is right for every
     file nobody has rearranged. Better a sheet in the wrong order than none. */
  if (!out.length) {
    const parts = zip.names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
    for (const p of parts) {
      const xml = await zip.text(p);
      if (xml === null) continue;
      out.push({ name: p.slice(p.lastIndexOf("/") + 1, -4), ...readSheet(xml, shared, dates) });
    }
  }
  return out;
}

/** The shared string table. Absent for a workbook of nothing but numbers. */
async function readShared(zip: Zip): Promise<string[]> {
  const xml = await zip.text("xl/sharedStrings.xml");
  if (xml === null) return [];
  const root = parseXml(xml);
  /* `textOf` over the whole `<si>` rather than its `<t>`, because a string with
     any formatting in it is split into `<r>` runs — and reading only the first
     `<t>` is how a cell reading "Q3 **actual**" comes back as "Q3 ". */
  return kids(root, "si").map((si) => textOf(si));
}

/** One worksheet's cells. */
function readSheet(
  xml: string,
  shared: string[],
  dates: Set<number>,
): { rows: Cell[][]; capped: boolean } {
  const root = parseXml(xml);
  const data = find(root, "sheetData");
  const rows: Cell[][] = [];
  let capped = false;

  for (const r of kids(data, "row")) {
    if (rows.length >= GRID_ROWS) {
      capped = true;
      break;
    }
    /* `r` is the sheet's own row number and it *skips*: a sheet with data on
       rows 1 and 900 has two `<row>` elements. Honoured rather than ignored,
       because a grid that closed the gap would put the second row under the
       first and read as a sheet that does not look like the one in Excel. */
    const no = Number(attr(r, "r") || rows.length + 1);
    while (rows.length < Math.min(no - 1, GRID_ROWS)) rows.push([]);
    if (rows.length >= GRID_ROWS) {
      capped = true;
      break;
    }

    const row: Cell[] = [];
    for (const c of kids(r, "c")) {
      const at = colOf(attr(c, "r") ?? "");
      const col = at >= 0 ? at : row.length;
      if (col >= GRID_COLS) {
        capped = true;
        continue;
      }
      while (row.length < col) row.push({ v: "", num: false });
      row[col] = cellOf(c, shared, dates);
    }
    rows.push(row);
  }
  return { rows, capped };
}

/** One cell, as the string it should read as.
 *
 *  The `t` attribute is the type and the cases that are not "a number" are the
 *  interesting ones. `s` is an index into the shared table — a cell whose `<v>`
 *  is `7` and whose `t` is `s` reads "Region", not 7 — and getting that wrong is
 *  the most visible way to be wrong about a spreadsheet. `str` is a formula's
 *  string *result*, which is already in `<v>`; `inlineStr` puts its text in an
 *  `<is>` instead. A formula's `<f>` is never drawn: a viewer showing `=SUM(B2:B9)`
 *  where Excel shows `4,182` would be showing the sheet's source, and there is no
 *  gesture here for asking for that. */
function cellOf(c: El, shared: string[], dates: Set<number>): Cell {
  const t = attr(c, "t") ?? "n";
  if (t === "s") {
    const i = Number(textOf(first(c, "v")));
    return { v: shared[i] ?? "", num: false };
  }
  if (t === "inlineStr") return { v: textOf(first(c, "is")), num: false };
  if (t === "str") return { v: textOf(first(c, "v")), num: false };
  if (t === "b") return { v: textOf(first(c, "v")) === "1" ? "TRUE" : "FALSE", num: false };
  if (t === "e") return { v: textOf(first(c, "v")), num: false };
  if (t === "d") return { v: textOf(first(c, "v")).slice(0, 19).replace("T", " "), num: false };

  const raw = textOf(first(c, "v"));
  if (!raw) return { v: "", num: false };
  const style = Number(attr(c, "s") ?? -1);
  if (dates.has(style)) {
    const date = serialDate(Number(raw));
    if (date) return { v: date, num: false };
  }
  return { v: raw, num: Number.isFinite(Number(raw)) };
}

/** Which cell styles carry a date format.
 *
 *  This is the difference between a column of dates and a column of five-digit
 *  numbers, which is the single most common way a spreadsheet reader looks
 *  broken: a date in a `.xlsx` **is** a number, and the only thing that says
 *  otherwise is its number format. So `cellXfs` is read for each style's
 *  `numFmtId`, and an id is a date if it is one of the built-in date formats or
 *  if its custom code contains a date token.
 *
 *  The built-in ids are fixed by the spec (14–17 dates, 18–21 times, 22
 *  date-time, 45–47 elapsed time) and are not written into the file at all,
 *  which is why they have to be known here. */
async function readDateStyles(zip: Zip): Promise<Set<number>> {
  const out = new Set<number>();
  const xml = await zip.text("xl/styles.xml");
  if (xml === null) return out;
  const root = parseXml(xml);

  const custom = new Map<number, string>();
  for (const f of kids(first(root, "numFmts"), "numFmt")) {
    const id = Number(attr(f, "numFmtId"));
    const code = attr(f, "formatCode") ?? "";
    if (Number.isFinite(id)) custom.set(id, code);
  }

  const builtin = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
  const xfs = kids(first(root, "cellXfs"), "xf");
  for (let i = 0; i < xfs.length; i++) {
    const id = Number(attr(xfs[i], "numFmtId") ?? 0);
    if (builtin.has(id) || isDateCode(custom.get(id) ?? "")) out.add(i);
  }
  return out;
}

/** Whether a number-format code formats a date.
 *
 *  The tokens are `y m d h s`, and the two things that have to be stepped over
 *  are the reason this is not a bare `/[ymdhs]/`: a literal in `"..."` (`0" kg"`
 *  has a `g` but also, in other codes, a `d`) and a colour or condition in
 *  `[...]` (`[Red]-0.00`, `[$-409]`). `m` is ambiguous between month and minute
 *  and it does not matter — both are dates. */
export function isDateCode(code: string): boolean {
  let quote = false;
  let bracket = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      if (ch === '"') quote = false;
      continue;
    }
    if (ch === '"') {
      quote = true;
      continue;
    }
    if (ch === "[") bracket++;
    else if (ch === "]") bracket = Math.max(0, bracket - 1);
    else if (!bracket && /[ymdhs]/i.test(ch)) return true;
    /* An escaped character is a literal, `\d` being the one that would otherwise
       read as a day. */
    else if (ch === "\\") i++;
  }
  return false;
}

/** An Excel serial number as a readable date.
 *
 *  Day 1 is 1900-01-02 and there is no day 60 — Lotus 1-2-3 believed 1900 was a
 *  leap year and Excel has been bug-compatible with it since 1985, so the epoch
 *  that makes every date after February 1900 come out right is **1899-12-30**.
 *  A serial below 61 is therefore in the range where the two calendars disagree,
 *  and rather than pick a wrong day it is left as the number it is: a
 *  spreadsheet with a date in January 1900 in it is a spreadsheet where the
 *  number is the more honest answer.
 *
 *  A fractional part is a time of day, and is drawn only when there is one — a
 *  column of dates should not grow ` 00:00` down its whole length. */
export function serialDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 61 || serial > 2_958_465) return null;
  const days = Math.floor(serial);
  const ms = Math.round((serial - days) * 86_400_000);
  const d = new Date(Date.UTC(1899, 11, 30) + days * 86_400_000 + ms);
  const iso = d.toISOString();
  return ms === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/* ── csv ──────────────────────────────────────────────────────────────────── */

/** The delimiters worth guessing between.
 *
 *  Semicolon is not an afterthought: Excel writes it for every locale whose
 *  decimal separator is a comma, so half the CSVs in a European company are
 *  semicolon-separated and a reader that assumed a comma would draw every row of
 *  them as one enormous cell. */
const DELIMS = [",", ";", "\t", "|"];

/** Which delimiter a CSV uses.
 *
 *  Decided on **consistency across rows** rather than on the count in the first
 *  one, which is the guard that matters: a comma-separated file with a semicolon
 *  inside one quoted field would otherwise be read as semicolon-separated the
 *  moment that field appeared in the header. So each candidate is scored by how
 *  many of the first few rows agree about the field count, and a delimiter that
 *  never divides anything scores nothing. */
export function sniffDelimiter(text: string, sample = 20): string {
  let best = ",";
  let bestScore = -1;
  for (const d of DELIMS) {
    const rows = splitRows(text, d, sample);
    if (!rows.length) continue;
    const width = rows[0].length;
    if (width < 2) continue;
    const agree = rows.filter((r) => r.length === width).length;
    /* Width breaks the tie, so a file that parses consistently under both `,`
       and `;` is read with whichever actually divides it into more fields. */
    const score = agree * 1000 + width;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** RFC 4180, with the two things real files do that it does not say.
 *
 *  A quote inside a quoted field is doubled (`""`), which is the rule; and the
 *  row terminator is any of `\r\n`, `\n` or a bare `\r`, which is not — but a
 *  file written by a Mac in 1998 is a file somebody will open. A quote that is
 *  never closed runs to the end of the file rather than throwing: the last field
 *  being long is a readable failure, and refusing the file is not. */
export function splitRows(text: string, delim: string, cap = Infinity): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const n = text.length;
  /* A byte-order mark is what Excel puts at the front of every CSV it writes,
     and left in it makes the first header cell not match its own name. */
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  const endRow = () => {
    row.push(field);
    field = "";
    /* A trailing newline is not an empty last row — the same phantom `viewLines`
       drops, and for the same reason. */
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
      continue;
    }
    if (ch === delim) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      endRow();
      if (ch === "\r" && text[i + 1] === "\n") i++;
      i++;
      if (rows.length >= cap) return rows;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || row.length) endRow();
  return rows;
}

/** A CSV as a grid, with its delimiter guessed and said. */
export function readTable(name: string, text: string): Grid {
  const delim = sniffDelimiter(text);
  const raw = splitRows(text, delim, GRID_ROWS + 1);
  const capped = raw.length > GRID_ROWS;
  const rows: Cell[][] = raw.slice(0, GRID_ROWS).map((r) =>
    r.slice(0, GRID_COLS).map((v) => ({
      v,
      /* A number for the purpose of aligning it, which is a narrower claim than
         "this is numeric data". Three things the shape refuses that a coercion
         would not: a blank (`Number("")` is 0), a code with leading zeros
         (`Number("007")` is 7, and a part number right-aligned as a quantity is
         a column that reads wrong), and anything with a space or a sign in it
         that only `parseFloat` would forgive. */
      num: /^-?(0|[1-9]\d*)(\.\d+)?$/.test(v.trim()),
    })),
  );
  return { name: `${name} · ${delim === "\t" ? "tab" : delim}`, rows, capped };
}

/* ── word ─────────────────────────────────────────────────────────────────── */

/** A Word document as `Block[]`, for the repo's own renderer to draw.
 *
 *  The mapping is the whole idea and it is worth stating what it *is*: this does
 *  not convert Word to markdown text and re-parse it, which is the obvious cheap
 *  route and would mean escaping every asterisk in the document and losing the
 *  ones that were really there. It builds the block tree directly, so a run of
 *  bold text becomes `{t:"strong"}` rather than two asterisks that have to
 *  survive a second parser.
 *
 *  What is deliberately dropped: page geometry, fonts, colours, footnotes,
 *  comments, images, and anything a `w:drawing` carries. This is a *reading*,
 *  and the reading of a Word file in a code viewer is its text with its
 *  structure — the same bargain the markdown reading strikes against a `.md`. */
export async function readWord(zip: Zip): Promise<Block[]> {
  const xml = await zip.text("word/document.xml");
  if (xml === null) return [];
  const root = parseXml(xml);
  const body = find(root, "body");
  const links = rels(await zip.text("word/_rels/document.xml.rels"));
  const ordered = await readNumbering(zip);
  return blocksOf(body, links, ordered);
}

/** The list formats, as numId → whether level zero is numbered.
 *
 *  Two hops, because Word stores it that way: a paragraph names a `numId`, which
 *  names an `abstractNumId`, which holds the levels. Only level zero is read —
 *  a nested list that switched from numbers to letters is a distinction the
 *  block model does not carry, and inventing one for it would be a renderer knob
 *  nothing else on this wall has. */
async function readNumbering(zip: Zip): Promise<Set<string>> {
  const out = new Set<string>();
  const xml = await zip.text("word/numbering.xml");
  if (xml === null) return out;
  const root = parseXml(xml);

  const abstract = new Map<string, boolean>();
  for (const a of kids(root, "abstractNum")) {
    const id = attr(a, "abstractNumId");
    if (!id) continue;
    const lvl = kids(a, "lvl").find((l) => (attr(l, "ilvl") ?? "0") === "0") ?? first(a, "lvl");
    const fmt = attr(first(lvl, "numFmt"), "val") ?? "bullet";
    abstract.set(id, fmt !== "bullet" && fmt !== "none");
  }
  for (const n of kids(root, "num")) {
    const id = attr(n, "numId");
    const ref = attr(first(n, "abstractNumId"), "val");
    if (id && ref && abstract.get(ref)) out.add(id);
  }
  return out;
}

/** The body's children, with consecutive list paragraphs gathered.
 *
 *  Gathering is the only structural work here and it is the part Word makes
 *  awkward: there is no list element. A list is a *run of paragraphs* each
 *  carrying a `numPr` with a level, and the tree has to be rebuilt from that —
 *  which is why this is a loop with a stack of open lists rather than a map over
 *  the children. */
function blocksOf(body: El | null, links: Record<string, string>, ordered: Set<string>): Block[] {
  const out: Block[] = [];
  /* Each open list, innermost last, with the level it was opened for. */
  const open: { level: number; block: Extract<Block, { t: "list" }> }[] = [];

  const push = (b: Block) => {
    if (open.length) open[open.length - 1].block.items.at(-1)?.push(b);
    else out.push(b);
  };
  const closeTo = (level: number) => {
    while (open.length && open[open.length - 1].level > level) open.pop();
  };

  for (const el of body?.kids ?? []) {
    if (typeof el === "string") continue;
    const name = local(el.name);

    if (name === "tbl") {
      closeTo(-1);
      const t = tableOf(el, links);
      if (t) push(t);
      continue;
    }
    if (name !== "p") continue;

    const pPr = first(el, "pPr");
    const numPr = first(pPr, "numPr");
    const numId = attr(first(numPr, "numId"), "val");
    /* `numId` 0 is Word's "this paragraph was in a list and is not any more",
       which is written by removing the bullets rather than the property. */
    const inList = !!numId && numId !== "0";
    const kidsOf = runsOf(el, links);

    if (inList) {
      const level = Number(attr(first(numPr, "ilvl"), "val") ?? 0);
      closeTo(level);
      let top = open[open.length - 1];
      if (!top || top.level < level) {
        const block: Extract<Block, { t: "list" }> = {
          t: "list",
          ordered: ordered.has(numId),
          start: 1,
          tight: true,
          items: [],
        };
        push(block);
        open.push({ level, block });
        top = open[open.length - 1];
      }
      top.block.items.push([{ t: "p", kids: kidsOf }]);
      continue;
    }

    closeTo(-1);
    /* An empty paragraph is Word's blank line and there are a great many of
       them; drawn, they are a document with holes in it. */
    if (!kidsOf.length) continue;

    const style = attr(first(pPr, "pStyle"), "val") ?? "";
    const level = headingLevel(style);
    if (level) out.push({ t: "h", level, kids: kidsOf });
    else if (/^Quote|^IntenseQuote/i.test(style)) out.push({ t: "quote", kids: [{ t: "p", kids: kidsOf }] });
    else out.push({ t: "p", kids: kidsOf });
  }
  return out;
}

/** Which heading a paragraph style is, or 0.
 *
 *  `Heading1` is what Word writes in English and `berschrift1` — with the umlaut
 *  already eaten by the style-id rules — is what it writes in German, so the
 *  match is on the trailing digit with a known prefix rather than on the whole
 *  name. `Title` is a level one, since a document has one and it is its heading. */
export function headingLevel(style: string): number {
  if (/^Title$/i.test(style)) return 1;
  if (/^Subtitle$/i.test(style)) return 2;
  const m = /^(?:Heading|heading|Head|berschrift|Titre|Kop|Ttulo|Titolo)-?(\d)$/.exec(style);
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= 6 ? n : 0;
}

/** A paragraph's runs as inline nodes.
 *
 *  Adjacent runs with the same formatting are *not* merged, and that is fine —
 *  the renderer draws a `<span>` per node either way, and Word splits a sentence
 *  into runs at every spell-check boundary, so merging would be a loop earning
 *  nothing visible. What is merged is bold-and-italic, by nesting, since the
 *  block model has no combined node. */
function runsOf(p: El, links: Record<string, string>): Inline[] {
  const out: Inline[] = [];
  const walk = (el: El, href: string | null) => {
    for (const k of el.kids) {
      if (typeof k === "string") continue;
      const name = local(k.name);
      if (name === "hyperlink") {
        const id = relId(k);
        walk(k, (id && links[id]) || attr(k, "anchor") || null);
        continue;
      }
      if (name === "smartTag" || name === "sdt" || name === "sdtContent" || name === "ins") {
        walk(k, href);
        continue;
      }
      /* A deletion in a document with tracked changes. The text is in the file
         and is *not* in the document, and drawing it would put struck-out prose
         nobody wrote into the middle of a paragraph. */
      if (name === "del") continue;
      if (name !== "r") continue;

      const rPr = first(k, "rPr");
      let text = "";
      for (const part of k.kids) {
        if (typeof part === "string") continue;
        const pn = local(part.name);
        if (pn === "t" || pn === "delText") text += textOf(part);
        else if (pn === "tab") text += "\t";
        else if (pn === "br" || pn === "cr") text += "\n";
      }
      if (!text) continue;

      let node: Inline = { t: "text", v: text };
      if (attr(first(rPr, "i"), "val") !== "0" && first(rPr, "i")) node = { t: "em", kids: [node] };
      if (attr(first(rPr, "b"), "val") !== "0" && first(rPr, "b")) {
        node = { t: "strong", kids: [node] };
      }
      if (first(rPr, "strike") || first(rPr, "dstrike")) node = { t: "del", kids: [node] };
      out.push(href ? { t: "link", href, kids: [node] } : node);
    }
  };
  walk(p, null);
  return out;
}

/** A Word table as the block model's table.
 *
 *  The first row is the head, which is what the block model has and what a Word
 *  table almost always means. Merged cells are *not* honoured — `gridSpan` is
 *  read only far enough to keep the columns lined up, since a table whose second
 *  row is short by one draws every cell in it under the wrong heading. */
function tableOf(tbl: El, links: Record<string, string>): Block | null {
  const trs = kids(tbl, "tr");
  if (!trs.length) return null;
  const rows = trs.map((tr) =>
    kids(tr, "tc").flatMap((tc) => {
      const kidsOf = kids(tc, "p").flatMap((p) => runsOf(p, links));
      const span = Number(attr(first(first(tc, "tcPr"), "gridSpan"), "val") ?? 1);
      const cells: Inline[][] = [kidsOf];
      for (let i = 1; i < Math.min(span, GRID_COLS); i++) cells.push([]);
      return cells;
    }),
  );
  const head = rows[0];
  const align: Align[] = head.map(() => null);
  return { t: "table", align, head, rows: rows.slice(1) };
}

/* ── powerpoint ───────────────────────────────────────────────────────────── */

/** A deck as `Block[]`: a heading per slide, its text under it.
 *
 *  Same renderer as Word, and the same argument — a deck read in a code viewer
 *  is its words in slide order. What it is *not* is a rendering: shapes have
 *  positions, and a viewer that drew them would be a second PowerPoint. So the
 *  reading is an outline, and a slide's title is its heading because that is the
 *  one shape whose role the file states.
 *
 *  Speaker notes are deliberately left out. They are in `ppt/notesSlides/` and
 *  they are the half of a deck nobody meant to publish; if they are ever wanted
 *  they want a toggle rather than being folded into the slide. */
export async function readDeck(zip: Zip): Promise<Block[]> {
  const pres = parseXml((await zip.text("ppt/presentation.xml")) ?? "");
  const map = rels(await zip.text("ppt/_rels/presentation.xml.rels"));

  let parts = kids(first(pres, "sldIdLst"), "sldId")
    .map((s) => relId(s))
    .map((id) => (id ? map[id] : null))
    .filter((t): t is string => !!t)
    .map((t) => under("ppt", t));

  /* Same fallback as the workbook's, and the same argument: slide order is worth
     getting right and a deck with no order is still worth reading. Sorted
     numerically, since `slide10.xml` sorts before `slide2.xml` as a string. */
  if (!parts.length) {
    parts = zip.names
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => slideNo(a) - slideNo(b));
  }

  const out: Block[] = [];
  for (let i = 0; i < parts.length; i++) {
    const xml = await zip.text(parts[i]);
    if (xml === null) continue;
    const tree = find(parseXml(xml), "spTree");
    const shapes = shapesOf(tree);

    const titleAt = shapes.findIndex((s) => s.title);
    const title = titleAt === -1 ? "" : shapes[titleAt].lines.join(" ").trim();
    out.push({
      t: "h",
      level: 2,
      kids: [{ t: "text", v: title || `slide ${i + 1}` }],
    });

    const lines = shapes.filter((_, at) => at !== titleAt).flatMap((s) => s.lines);
    const items = lines.map((l) => l.trim()).filter(Boolean);
    if (items.length) {
      out.push({
        t: "list",
        ordered: false,
        start: 1,
        tight: true,
        items: items.map((v) => [{ t: "p", kids: [{ t: "text", v }] } as Block]),
      });
    }
  }
  return out;
}

function slideNo(name: string): number {
  return Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

/** Every text-bearing shape on a slide, in tree order.
 *
 *  Groups are walked into, since a slide built from a template puts most of its
 *  content in one. A shape is the *title* when its placeholder says so — the
 *  only role in the file that is stated rather than inferred from position. */
function shapesOf(tree: El | null): { title: boolean; lines: string[] }[] {
  const out: { title: boolean; lines: string[] }[] = [];
  const walk = (el: El | null, depth: number) => {
    if (!el || depth > 12) return;
    for (const k of el.kids) {
      if (typeof k === "string") continue;
      const name = local(k.name);
      if (name === "grpSp") {
        walk(k, depth + 1);
        continue;
      }
      if (name !== "sp") continue;
      const ph = find(first(k, "nvSpPr"), "ph");
      const type = attr(ph, "type") ?? "";
      const body = find(k, "txBody");
      if (!body) continue;
      const lines = kids(body, "p")
        .map((p) => textOf(p))
        .filter((t) => t.trim());
      if (!lines.length) continue;
      out.push({ title: type === "title" || type === "ctrTitle", lines });
    }
  };
  walk(tree, 0);
  return out;
}

/* ── the one entry point ──────────────────────────────────────────────────── */

/** Which OOXML document an archive holds.
 *
 *  `[Content_Types].xml` first, because it is the one part every OPC package is
 *  required to have and it names the document's own part by content type — which
 *  is the format's own answer to the question. The directory prefixes are the
 *  fallback, and they are reliable in practice for the same reason the content
 *  types are: both are written by the same producer. Neither is the *extension*,
 *  which is the whole point. */
export function familyOf(zip: Zip, types: string | null): "word" | "sheet" | "deck" | null {
  if (types) {
    /* Substring rather than a parse: these are long, fixed strings and the only
       question asked of them is which one is present. */
    if (types.includes("wordprocessingml.document.main")) return "word";
    if (types.includes("spreadsheetml.sheet.main")) return "sheet";
    if (types.includes("presentationml.presentation.main")) return "deck";
    if (types.includes("presentationml.slideshow.main")) return "deck";
    if (types.includes("presentationml.template.main")) return "deck";
    if (types.includes("wordprocessingml.template.main")) return "word";
    if (types.includes("spreadsheetml.template.main")) return "sheet";
  }
  if (zip.has("word/document.xml")) return "word";
  if (zip.has("xl/workbook.xml")) return "sheet";
  if (zip.has("ppt/presentation.xml")) return "deck";
  return null;
}

/** What an OLE compound file probably is, from its name alone.
 *
 *  The only place in this file where the extension decides anything, and it is
 *  because there is nothing else to go on: telling a `.doc` from an `.xls`
 *  means walking the compound file's directory, which is the whole of the format
 *  this deliberately does not open. The name is used to write a better sentence
 *  and for nothing else — a wrong guess costs a wrong word in a plate that says
 *  "open it outside" either way. */
function legacyName(ext: string): string {
  if (ext === "doc") return "a pre-2007 Word document";
  if (ext === "xls") return "a pre-2007 Excel workbook";
  if (ext === "ppt") return "a pre-2007 PowerPoint deck";
  return "a pre-2007 Office document";
}

/** Bytes to a document, deciding on the bytes.
 *
 *  `hint` is the extension and is used for exactly two things, both of them
 *  cosmetic: naming a CSV's grid and wording the legacy plate. Everything that
 *  decides *what is drawn* comes from `sniff` and, inside an archive, from the
 *  package's own content types.
 *
 *  Throws with a sentence rather than returning null, because every failure here
 *  is one the panel should say out loud: a `.docx` that is really a renamed
 *  `.zip` of holiday photos is worth being told about, and so is a truncated
 *  file. `finder.svelte.ts` puts it in `fault`. */
export async function readDocument(bytes: Uint8Array, hint: string): Promise<Doc> {
  const container = sniff(bytes);

  if (container === "pdf") return { kind: "pdf", bytes };
  if (container === "ole") return { kind: "legacy", what: legacyName(hint) };
  if (container !== "zip") {
    throw new Error(
      hint
        ? `this does not look like a .${hint} — its first bytes are not a document this reads`
        : "not a document this reads",
    );
  }

  const zip = Zip.open(bytes);
  const family = familyOf(zip, await zip.text("[Content_Types].xml"));
  if (family === "sheet") return { kind: "sheet", sheets: await readWorkbook(zip) };
  if (family === "word") return { kind: "prose", blocks: await readWord(zip), what: "word" };
  if (family === "deck") return { kind: "prose", blocks: await readDeck(zip), what: "deck" };
  throw new Error("a zip archive, but not an Office document — nothing in it to read");
}
