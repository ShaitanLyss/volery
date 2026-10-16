/* What leaves the panel when you copy.
 *
 * The transcript draws markdown as elements, so what the browser hands the
 * clipboard is the words with every mark taken off: a numbered list that is no
 * longer numbered, a bold label that is no longer a label, a fence that arrives
 * as loose lines of code. But an answer copied out of here is nearly always on
 * its way somewhere that reads markdown — a commit message, an issue, a note,
 * another agent's prompt — so the marks are the half you most want kept.
 *
 * It is put back together from what is drawn rather than sliced out of the
 * source text, because a selection is a DOM range and only the DOM knows where
 * one starts: the range is cloned, and the clone is walked back into markdown.
 * The walk is pure and takes `Bit`s — the little of a node it needs — so it is
 * tested without a browser (test/copy.test.ts); `bitsOf` is the ten lines that
 * turn a real fragment into them.
 *
 * A partial selection gives back a partial document, which is the honest
 * answer: half a table is not a table, and the half you dragged across is what
 * you asked for. What a clone cannot know is what it was inside — select the
 * middle of one bullet and the fragment has no list in it, so no `-` is
 * written.
 */

/** A node, as far as this needs to care. */
export type Bit = { text: string } | El;

export type El = { tag: string; attr: Record<string, string>; kids: Bit[] };

const isEl = (b: Bit): b is El => "tag" in b;

/** Tags that stand on their own line. Everything else is inline, and a run of
 *  inline bits between two blocks becomes a paragraph of its own — which is
 *  what a selection that starts mid-sentence looks like. */
const BLOCK = new Set([
  "P", "DIV", "FIGURE", "PRE", "BLOCKQUOTE", "UL", "OL", "LI", "HR", "TABLE", "THEAD",
  "TBODY", "TR", "SECTION", "NAV",
]);

const cls = (el: El) => el.attr.class ?? "";

/** What an element says it is in markdown, for the one kind of thing whose
 *  drawing cannot be read back into source: a picture. Its `src` is a `data:`
 *  URL the panel read off the disk, which is not what the agent wrote and is
 *  megabytes long — so `InlinePicture` carries the `![alt](path)` it was drawn
 *  from, and the walk writes that instead of descending. A figure a `show`
 *  call drew carries one too, or a selection across it would copy as a gap. */
const said = (el: El): string | undefined => el.attr["data-md"];

/** The panel's own furniture, which is not part of what anybody said: the
 *  fence's copy button and language tag, the streaming caret, the rule that
 *  says where the transcript on disk ends. Drawn, but never written.
 *
 *  `perch` is the copy button's wrapper, and is named here rather than left to
 *  the `BUTTON` rule below it: the wrapper is a `DIV`, which is a block, so
 *  recursing into it would put an empty block between a fence and whatever
 *  follows it. Dropping the whole thing is what the bare button did. */
function furniture(el: El): boolean {
  if (said(el) !== undefined) return false;
  return (
    (el.tag === "BUTTON" && !cls(el).includes("link")) ||
    /\b(lang|caret|seam|perch)\b/.test(cls(el))
  );
}

function kidsOf(el: El): Bit[] {
  return el.kids.filter((b) => !(isEl(b) && furniture(b)));
}

/** Everything inside a fragment, as blocks in document order. */
function blocks(kids: Bit[]): string[] {
  const out: string[] = [];
  let run: Bit[] = [];
  const flush = () => {
    const s = inline(run).trim();
    if (s) out.push(s);
    run = [];
  };
  for (const b of kids) {
    if (isEl(b) && furniture(b)) continue;
    if (isEl(b) && BLOCK.has(b.tag)) {
      flush();
      out.push(...block(b));
    } else run.push(b);
  }
  flush();
  return out;
}

function block(el: El): string[] {
  const md = said(el);
  if (md !== undefined) return md ? [md] : [];
  const kids = kidsOf(el);

  if (el.tag === "HR") return ["---"];

  if (el.tag === "PRE") {
    /* The language is a span inside the `pre` and the code is the `code`
       element beside it — both are the fence's own, and neither is prose. */
    const lang = el.kids.find((b) => isEl(b) && /\blang\b/.test(cls(b)));
    const body = kids.map(text).join("");
    return ["```" + (lang ? text(lang) : "") + "\n" + body + "\n```"];
  }

  if (el.tag === "BLOCKQUOTE") {
    const inner = blocks(kids).join("\n\n");
    return [inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")];
  }

  if (el.tag === "UL" || el.tag === "OL") {
    const ordered = el.tag === "OL";
    /* `start` is what the source's own first number was — a list beginning at
       4 was written beginning at 4, and renumbering it from 1 would change what
       the agent said. */
    let n = Number(el.attr.start ?? 1) || 1;
    /* Tight or loose is carried too, and the class is where the panel already
       records it: a list of six one-line thoughts must not come back spread
       over eleven lines. */
    const gap = /\btight\b/.test(cls(el)) ? "\n" : "\n\n";
    const items = kids.map((item) => {
      const mark = ordered ? `${n++}. ` : "- ";
      const body = isEl(item) ? blocks(kidsOf(item)).join(gap) : text(item);
      /* A wrapped line and a nested block sit under the marker, not under the
         margin: indented by exactly the marker's width, which is what makes a
         nested list nest again when this is read back. */
      const pad = " ".repeat(mark.length);
      return (
        mark + body.split("\n").map((l, i) => (i ? (l ? pad + l : l) : l)).join("\n")
      );
    });
    /* One block, not one per item: what separates them is the list's own
       business, and the joiner above this only knows about blank lines. */
    return [items.join(gap)];
  }

  if (el.tag === "TABLE") return [table(el)];

  /* An opened tool call's diff. Each row is its own element so it can carry a
     background — which makes every one of them a block, and blocks are joined
     with a blank line, so an eight-line edit came out of here sixteen lines
     tall with the shape of the change gone. It is lines, and it goes out as
     the fence every diff has always been pasted into. The gutter marks are
     part of it: `-` and `+` are what make the paste a diff rather than two
     versions of a file interleaved. */
  if (/\bdiff\b/.test(cls(el))) {
    const rows = kids.map((k) => (isEl(k) ? inline(kidsOf(k)) : k.text));
    return ["```diff\n" + rows.join("\n") + "\n```"];
  }

  // A heading is a div carrying its own level — see Markdown.svelte.
  const level = Number(el.attr["data-level"] ?? 0);
  if (level) return ["#".repeat(level) + " " + inline(kids).trim()];

  if (el.tag === "P") {
    const s = inline(kids).trim();
    return s ? [s] : [];
  }

  /* Anything else that holds things — a message, a line, a row of a partly
     selected table, the panel's own wrappers — is only its contents. */
  return blocks(kids);
}

function table(el: El): string {
  const rows: El[] = [];
  const walk = (bits: Bit[]) => {
    for (const b of bits) {
      if (!isEl(b)) continue;
      if (b.tag === "TR") rows.push(b);
      else walk(b.kids);
    }
  };
  walk(el.kids);
  if (!rows.length) return "";

  const cells = (r: El) =>
    r.kids.filter(isEl).map((c) => inline(kidsOf(c)).trim().replace(/\|/g, "\\|"));
  const line = (c: string[]) => `| ${c.join(" | ")} |`;

  const head = cells(rows[0]);
  /* Alignment is drawn as a style and read back off it: a column an agent
     centred should still be centred wherever this is pasted. */
  const rule = rows[0].kids.filter(isEl).map((c) => {
    const a = /text-align:\s*(left|center|right)/.exec(c.attr.style ?? "")?.[1];
    return a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---";
  });
  return [line(head), line(rule), ...rows.slice(1).map((r) => line(cells(r)))].join("\n");
}

/** One run of inline bits, with the marks put back on. */
function inline(kids: Bit[]): string {
  let out = "";
  for (const b of kids) {
    if (!isEl(b)) {
      out += b.text;
      continue;
    }
    const md = said(b);
    if (md !== undefined) {
      out += md;
      continue;
    }
    if (furniture(b)) continue;
    const inner = inline(kidsOf(b));
    if (b.tag === "STRONG") out += inner.trim() ? `**${inner}**` : inner;
    else if (b.tag === "EM") out += inner.trim() ? `*${inner}*` : inner;
    else if (b.tag === "DEL") out += inner.trim() ? `~~${inner}~~` : inner;
    else if (b.tag === "CODE") out += span(inner);
    else if (b.tag === "BUTTON") {
      /* A link is a button with its destination on the title — this window has
         no address bar, so there is no href to read (see Inlines.svelte). A url
         that is its own label is left bare: `[url](url)` is noise. */
      const href = b.attr.title ?? "";
      out += !href || inner === href ? inner : `[${inner}](${href})`;
    } else out += inner;
  }
  return out;
}

/** A code span, fenced by a run of backticks longer than any inside it. */
function span(v: string): string {
  const runs = v.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  const pad = v.startsWith("`") || v.endsWith("`") ? " " : "";
  return `${fence}${pad}${v}${pad}${fence}`;
}

/** Everything a bit holds, marks and all taken off. */
function text(b: Bit): string {
  if (!isEl(b)) return b.text;
  return b.kids.map(text).join("");
}

/** A selection, as the markdown it was drawn from.
 *
 *  Nothing is escaped on the way out. The text is what an agent wrote and the
 *  marks around it are the ones it wrote too, so a paste is what it typed — and
 *  putting backslashes in front of the asterisks in somebody's prose is a worse
 *  answer than the rare word that arrives emphasised. */
export function toMarkdown(kids: Bit[]): string {
  return blocks(kids).join("\n\n");
}

/** A real fragment, as `Bit`s. The only part of this file that has seen a DOM. */
export function bitsOf(node: Node): Bit[] {
  const out: Bit[] = [];
  for (const kid of node.childNodes) {
    if (kid.nodeType === Node.TEXT_NODE) out.push({ text: kid.nodeValue ?? "" });
    else if (kid.nodeType === Node.ELEMENT_NODE) {
      const el = kid as Element;
      const attr: Record<string, string> = {};
      for (const a of el.attributes) attr[a.name] = a.value;
      out.push({ tag: el.tagName, attr, kids: bitsOf(el) });
    }
  }
  return out;
}

/** What the clipboard should be given for the selection as it stands, or `""`
 *  when there is nothing selected to give. */
export function selectionMarkdown(): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
  return toMarkdown(bitsOf(sel.getRangeAt(0).cloneContents())).trim();
}
