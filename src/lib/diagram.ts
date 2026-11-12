/* A diagram an agent wrote, drawn rather than printed.
 *
 * Claude writes a diagram as a ```mermaid fence and expects the client to
 * draw it — that is how it was trained to show one, and it does it without
 * being asked. So the panel draws it, the way Claude Desktop does, rather than
 * asking agents to learn a way of their own (render an svg, then `show` it)
 * that nothing in their training ever showed them. Asked for by Lyss on
 * 2026-10-16: *"it should ideally match how claude desktop does it so that it
 * matches the training of the models instead of inventing an entirely new
 * way."* `.claude/rules/showing.md` has the whole of the argument.
 *
 * Mermaid parses untrusted text and builds DOM in whatever document runs it, so
 * it does not run in this one: `drawing.svelte.ts` keeps one hidden frame
 * behind the same wall a design preview stands behind (`sandbox.ts`), sends it
 * a fence's text and takes back a string. That string is only ever drawn as an
 * `<img>` over a `data:` URL — the element that draws an svg with its scripts
 * and its external references switched off — and never put into this document
 * as markup.
 *
 * This file is the part with no DOM in it: what a diagram fence is, what the
 * frame runs, the theme it is drawn in, and what is believed of its answer.
 * Pure, so it is tested directly (test/showing.test.ts). */

import { MAX_IMAGE_CHARS, pictureOf, type Picture } from "./classify";

/** Whether a fence is a diagram. Its info string's first word, as the parser
 *  hands it over — `mermaid`, in any case. */
export function isDiagramFence(lang: string | null): boolean {
  return (lang ?? "").toLowerCase() === "mermaid";
}

/** The most text one diagram may be — mermaid's own `maxTextSize` default, and
 *  past it mermaid refuses anyway. Said here so the refusal is ours and comes
 *  before a frame is asked anything. */
export const DIAGRAM_MOST = 50_000;

/** And the most edges, which is the bound on how long a layout can hold the
 *  renderer — mermaid's own default again. See the honest limit in
 *  `showing.md`: a frame on an opaque origin may share its renderer process
 *  with this window, so a pathological diagram is bounded rather than
 *  prevented. */
export const DIAGRAM_EDGES = 500;

/* ── what mermaid refused, and repairing what it did not have to ─────────────
 *
 * Asked for by Lyss on 2026-11-12, from a diagram of her own that drew as
 * *not drawn — mermaid could not read it: Parse error on line 4*. Two halves,
 * and they are deliberately separate: **repair what is provably unambiguous,
 * and tell the author about everything else.** An agent cannot see the panel,
 * so a fence it wrote that did not draw is invisible to it — and it will write
 * the same shape again all conversation. See `showing.md`.
 *
 * The corpus behind every rule here is 17 real fences harvested from this
 * machine's own transcripts plus 26 probed shapes, run through the pinned
 * mermaid 12.2.0 under this app's exact config (htmlLabels off, strict,
 * achromatic). What that found:
 *
 * - A backslash-escaped quote inside a label is **not** an escape to mermaid.
 *   The string ends at the quote, so the rest of the label parses as loose
 *   tokens and the fence fails. `#quot;`, `&quot;` and `&#34;` are the
 *   documented answers and **none of them renders a quote here**: with html
 *   labels off, mermaid HTML-escapes the label and the entity shows on screen
 *   as its own six characters. So the quote is repaired only when the caller
 *   says which character to put in its place, and otherwise reported.
 * - `] [ ( ) { } "` cannot appear in an *unquoted* edge label at all, and
 *   wrapping the same text in quotes draws it identically. That one is exact
 *   and is repaired unconditionally.
 * - `<b>`, `<strong>` and `**bold**` are drawn as their own literal text with
 *   html labels off. They parse, so they are not this file's business; they
 *   are named in the author's note instead, because a diagram that draws with
 *   visible tags in it is a diagram the author would fix if it knew.
 */

/** What a backslash-escaped quote becomes. A string is used for both sides; a
 *  pair alternates, so a substituted quote still opens and closes. `null`
 *  leaves the fence exactly as written and reports it: a substitute glyph is a
 *  visible decision, not a rendering detail. `'"'` is the right answer only if
 *  mermaid's HTML labels are turned on, where `&quot;` decodes; the two
 *  changes go together. */
export type QuoteRepair = string | [string, string] | null;

/** `null` reports rather than repairs. No substitution for `"` is
 *  character-identical: each one is a glyph the author did not type, so
 *  turning a set on is a decision somebody looks at first, not a default this
 *  file may choose. `showing.md` has the candidates and what each costs. */
export const QUOTE_REPAIR: QuoteRepair = null;

/** The characters mermaid's unquoted edge-label text cannot hold. Probed one
 *  at a time: each of these fails, and every other printable character,
 *  including `'`, `:` and `;`, parses.
 *
 *  `"` is deliberately absent. It is refused there too, but a label holding a
 *  quote is not fixed by wrapping it in more quotes: `|x " y|` becomes
 *  `|"x " y"|`, a different parse error. That fence is left to fail and to be
 *  reported, rather than made to look handled. */
const EDGE_HOSTILE = /[[\](){}]/;

/** An edge token immediately before an edge label's opening `|`. Matched
 *  rather than a bare `|` for a reason: a `|` is also a table cel in prose and
 *  a pipe in a sequence message's text, and neither is this. */
const EDGE_BEFORE_PIPE =
  /(?:-{2,}[>ox]|-\.+-+>|-\.-|={2,}>|={2,}|~{3,}|<-->|<\.+-+>|--)\s*$/;

/** A shape a diagram fence is written in, as the first word that is not a
 *  comment. Only these carry `|label|` edges. */
const FLOWCHART =
  /^\s*(?:(?:%%[^\n]*\n)|\s)*(?:flowchart|graph)\b/i;

/** Repair the shapes mermaid refuses but plainly understands, and say nothing
 *  about anything else. Returns the text to hand to the renderer, which is the
 *  same string whenever nothing was repaired.
 *
 *  **The boundary is meaning.** A repair is made only where the author's
 *  intent cannot be anything else: an unquoted edge label containing a
 *  delimiter mermaid cannot read is a label with that character in it, and
 *  quoting it changes no drawn character. A `\"` is repaired only under an
 *  explicit `quote` argument, because no substitution for it is character-
 *  identical and that is somebody's choice to make. */
export function repairFence(text: string, quote: QuoteRepair = QUOTE_REPAIR): string {
  let out = quote === null ? text : repairQuotes(text, quote);
  if (FLOWCHART.test(out)) out = repairEdgeLabels(out);
  return out;
}

/** `\"` becomes the chosen character, except where it can only be a *closing*
 *  quote.
 *
 *  Mermaid has no escape, so a `\"` is genuinely ambiguous: it is a backslash
 *  and then either a quote that ends the label (`A["C:\dir\"]`, a Windows path
 *  ending in a separator, which draws today) or a literal quote inside one
 *  (`Command::new(\"git\")`, which does not). **What settles it is whether the
 *  label goes on**: a literal quote means the string must be closed after it,
 *  so a `\"` with no other `"` later on its line is the closer and is left
 *  alone, and one with a later quote is the literal.
 *
 *  The case that rule gets wrong is a label that *ends* in a backslash on a
 *  line that also holds another quoted label — `A["C:\x\"] --> B["y"]` — and
 *  it is accepted rather than solved, because the wrong direction is loud: the
 *  fence fails to parse and its author is told, where refusing to repair the
 *  common shape would leave every `\"`-in-prose fence failing silently to the
 *  one reader who cannot see it.
 *
 *  `%%` lines are skipped whole: a directive is JSON, where `\"` really is an
 *  escape and changing it would break the directive. */
export function repairQuotes(text: string, quote: string | [string, string]): string {
  const [open, close] = typeof quote === "string" ? [quote, quote] : quote;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*%%/.test(line)) continue;
    /* Per line, so a second fence line opens its quote rather than closing
       one the line above left half-turned. */
    let side = false;
    let out = "";
    for (let at = 0; at < line.length; at++) {
      if (line[at] !== "\\" || line[at + 1] !== '"') {
        /* A label's own delimiter starts a new quoted string, so the pair
           opens again rather than closing one the label before left turned. */
        if (line[at] === '"') side = false;
        out += line[at];
        continue;
      }
      /* No `"` after it means nothing is left to close the label, so this is
         the closer and the backslash is the label's last character. */
      if (!line.slice(at + 2).includes('"')) {
        out += '\\"';
      } else {
        out += side ? close : open;
        side = !side;
      }
      at++;
    }
    lines[i] = out;
  }
  return lines.join("\n");
}

/** Wrap the text of every unquoted edge label that holds a character mermaid
 *  cannot read there. Nothing else on the line moves.
 *
 *  **One pass, and it knows what it is looking at.** A `|` means an edge label
 *  only outside a quoted string and outside a node's own brackets, because a
 *  quoted edge label may itself contain a `|` (`-->|"grep | head"|`) and a
 *  node label may contain a whole edge (`A["see -->|x]|"]`). Both parse today
 *  and both were rewritten into a parse error by the first cut, which read the
 *  line with two `indexOf`s and no idea where it was. The label's own end is
 *  found the same way, so a label holding an odd quote is left alone rather
 *  than guessed at. */
export function repairEdgeLabels(text: string): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let out = "";
    let depth = 0;
    let quoted = false;
    for (let at = 0; at < line.length; at++) {
      const c = line[at];
      if (c === '"') {
        quoted = !quoted;
        out += c;
        continue;
      }
      if (!quoted) {
        if (c === "[" || c === "(" || c === "{") depth++;
        else if (c === "]" || c === ")" || c === "}") depth = Math.max(0, depth - 1);
        else if (c === "|" && depth === 0 && afterEdge(line, at)) {
          const close = labelEnd(line, at + 1);
          if (close > 0) {
            const label = line.slice(at + 1, close);
            const already = /^\s*".*"\s*$/.test(label);
            out += "|" + (!already && EDGE_HOSTILE.test(label) ? `"${label.trim()}"` : label) + "|";
            at = close;
            continue;
          }
        }
      }
      out += c;
    }
    lines[i] = out;
  }
  return lines.join("\n");
}

/** Whether the text just before a `|` at `at` is an edge token.
 *
 *  A bounded window rather than the whole prefix: a one-line diagram is
 *  capped at 50,000 characters and could hold thousands of `|`, and testing
 *  the prefix at each one is quadratic in a string a model wrote. The longest
 *  token here is under a dozen characters and the spaces before it are a
 *  handful, so the window is generous. */
function afterEdge(line: string, at: number): boolean {
  let end = at - 1;
  for (let spaces = 0; end >= 0 && (line[end] === " " || line[end] === "\t"); spaces++) {
    if (spaces > 64) return false;
    end--;
  }
  return EDGE_BEFORE_PIPE.test(line.slice(Math.max(0, end - 31), end + 1));
}

/** Where an edge label opened at `from` ends: the first `|` that is not inside
 *  a quoted string. `-1` when there is none, which leaves the line alone. */
function labelEnd(line: string, from: number): number {
  let quoted = false;
  for (let at = from; at < line.length; at++) {
    if (line[at] === '"') quoted = !quoted;
    else if (line[at] === "|" && !quoted) return at;
  }
  return -1;
}

/** The line mermaid named in its refusal, counting from 1 at the fence body's
 *  first line, which is the `flowchart` line and not the ` ```mermaid ` one.
 *  Both of mermaid's refusals that name a line are matched: `Parse error on
 *  line N` and `Lexical error on line N`. `null` when the message names none,
 *  which is our own size bound and a frame that never answered. */
export function refusedLine(message: string): number | null {
  const m = /error on line (\d+)/i.exec(message);
  return m ? Number(m[1]) : null;
}

/** That line, trimmed and clipped, for a note to quote back at its author. */
export function refusedText(fence: string, line: number | null, most = 160): string {
  if (line === null || line < 1) return "";
  const one = fence.split("\n")[line - 1]?.trim() ?? "";
  return one.length > most ? one.slice(0, most - 1) + "…" : one;
}

/** A fence written back as markdown, for the clipboard. */
export function fenceMarkdown(text: string): string {
  const runs = text.match(/`{3,}/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `${fence}mermaid\n${text}\n${fence}`;
}

/** The colours a diagram is drawn in, as the frame needs them — resolved to
 *  `rgb(…)` by the caller, since the frame cannot read this window's tokens
 *  and mermaid's colour library cannot read a `var()`. */
export type Ink = {
  ink: string;
  surface: string;
  paper: string;
  dim: string;
  mute: string;
  faint: string;
  edge: string;
};

/** The font a diagram is laid out and drawn in. A system face, because the
 *  frame loads no fonts (its policy allows none from anywhere) and an `<img>`
 *  of an svg loads none either — so the face mermaid measures with is the face
 *  it is drawn in, and a label never overruns its box. */
export const DIAGRAM_FONT = '"Segoe UI", system-ui, -apple-system, sans-serif';

function channels(c: string): [number, number, number] | null {
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Between two colours, `t` of the way from `a` to `b`. */
function mix(a: string, b: string, t: number): string {
  const x = channels(a);
  const y = channels(b);
  if (!x || !y) return t < 0.5 ? a : b;
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** Whether a colour is the dark end of the page. */
export function isDark(c: string): boolean {
  const x = channels(c);
  if (!x) return true;
  const [r, g, b] = x.map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

/** Mermaid's configuration, from this window's ink.
 *
 *  **Achromatic, because colour on this wall is status.** Mermaid's `base`
 *  theme derives most of its palette from `primaryColor` by rotating its hue —
 *  which, from a grey, stays grey — and the handful it does not derive (pie
 *  slices, git branches, a timeline's sections) are given a ramp of the page's
 *  own greys here, so nothing on a diagram is a colour the wall did not choose.
 *  Drawn in the page's own tones rather than black on white, so a diagram
 *  reads as part of the answer, and re-drawn when the theme or the brightness
 *  changes (the caller keys its cache on these colours).
 *
 *  `securityLevel: "strict"` and no html labels are the half of containment
 *  that is mermaid's own: no click handlers, no html in a label, and every
 *  label drawn as svg text, which is also what draws the same in an `<img>`
 *  as it measured in the frame. */
export function diagramConfig(c: Ink): Record<string, unknown> {
  const dark = isDark(c.ink);
  const ramp = (n: number) =>
    Array.from({ length: n }, (_, i) => mix(c.surface, c.dim, n === 1 ? 0 : i / (n - 1)));
  const greys = ramp(12);
  const vars: Record<string, unknown> = {
    darkMode: dark,
    background: c.surface,
    fontFamily: DIAGRAM_FONT,
    fontSize: "14px",
    primaryColor: c.surface,
    primaryTextColor: c.paper,
    primaryBorderColor: c.faint,
    secondaryColor: c.ink,
    secondaryTextColor: c.paper,
    secondaryBorderColor: c.edge,
    tertiaryColor: c.ink,
    tertiaryTextColor: c.paper,
    tertiaryBorderColor: c.edge,
    lineColor: c.dim,
    textColor: c.paper,
    titleColor: c.paper,
    mainBkg: c.surface,
    nodeBorder: c.faint,
    clusterBkg: c.ink,
    clusterBorder: c.edge,
    edgeLabelBackground: c.surface,
    noteBkgColor: c.ink,
    noteTextColor: c.dim,
    noteBorderColor: c.edge,
    actorBkg: c.surface,
    actorBorder: c.faint,
    actorTextColor: c.paper,
    actorLineColor: c.mute,
    signalColor: c.dim,
    signalTextColor: c.paper,
    labelBoxBkgColor: c.surface,
    labelBoxBorderColor: c.edge,
    labelTextColor: c.paper,
    loopTextColor: c.paper,
    activationBkgColor: c.ink,
    activationBorderColor: c.faint,
    sequenceNumberColor: c.ink,
    pieTitleTextColor: c.paper,
    pieSectionTextColor: c.paper,
    pieLegendTextColor: c.paper,
    pieStrokeColor: c.ink,
    pieOuterStrokeColor: c.edge,
  };
  greys.forEach((g, i) => {
    vars[`pie${i + 1}`] = g;
    vars[`cScale${i}`] = g;
    vars[`cScaleLabel${i}`] = c.paper;
  });
  for (let i = 0; i < 8; i++) {
    vars[`git${i}`] = greys[Math.min(11, 2 + i)];
    vars[`gitBranchLabel${i}`] = c.paper;
  }
  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: vars,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    fontFamily: DIAGRAM_FONT,
    maxTextSize: DIAGRAM_MOST,
    maxEdges: DIAGRAM_EDGES,
    deterministicIds: true,
  };
}

/** What runs in the frame, after mermaid itself.
 *
 *  It answers only its parent, renders one fence per message, and hands back a
 *  string and its size — with the svg's own `width` and `height` set from its
 *  `viewBox` (mermaid writes `width="100%"` and a `max-width` style, which an
 *  `<img>` would draw at a size of its own choosing), and its style taken off.
 *  Whatever mermaid leaves in the frame's body after a failure is cleared, so
 *  the next fence is not laid out beside it. */
export const BOOT = `(() => {
  const answer = (m) => window.parent.postMessage(m, "*");
  const run = async (m) => {
    try {
      mermaid.initialize(m.config);
      const out = await mermaid.render("d" + m.id, m.text);
      const doc = new DOMParser().parseFromString(out.svg, "image/svg+xml");
      const root = doc.documentElement;
      if (!root || root.nodeName.toLowerCase() !== "svg") throw new Error("mermaid drew something that is not a picture");
      const vb = (root.getAttribute("viewBox") || "").trim().split(/[\\s,]+/).map(Number);
      let w = 0, h = 0;
      if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) { w = Math.ceil(vb[2]); h = Math.ceil(vb[3]); }
      if (w && h) { root.setAttribute("width", String(w)); root.setAttribute("height", String(h)); }
      root.removeAttribute("style");
      return { id: m.id, svg: new XMLSerializer().serializeToString(root), w, h };
    } catch (e) {
      return { id: m.id, error: String((e && e.message) || e) };
    } finally {
      for (const el of [...document.body.children]) if (el.tagName !== "SCRIPT") el.remove();
    }
  };
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent) return;
    const m = e.data || {};
    if (typeof m.id !== "number" || typeof m.text !== "string") return;
    run(m).then(answer);
  });
  answer({ ready: true });
})();`;

/** A diagram the frame drew, or why not.
 *
 *  `said` is mermaid's whole refusal, kept apart from `error` because the two
 *  have different readers: the panel says the first line, and the note that
 *  goes back to the author carries the last one too, which is where the token
 *  it wanted is named. */
export type Drawn =
  | { picture: Picture; w: number; h: number }
  | { error: string; said?: string };

/** UTF-8 to base64, which is what a `data:` URL of an svg carries — `btoa`
 *  alone throws on anything past Latin-1, and a label can be in any script. */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** What is believed of an answer from the frame.
 *
 *  **Only a string, and only drawn as a picture.** The frame is on the far side
 *  of the wall, so its answer is untrusted exactly as an agent's text is: it
 *  must be an object of the expected shape, its svg a string that opens as an
 *  svg and fits the picture cap, and its size two sane numbers — and then it
 *  goes through `pictureOf`, the same reader a tool result's picture passes,
 *  into a `data:` URL for an `<img>`. Nothing in it is ever markup here. */
export function readDrawn(reply: unknown): Drawn {
  const r = reply as { svg?: unknown; error?: unknown; w?: unknown; h?: unknown } | null;
  if (!r || typeof r !== "object") return { error: "the renderer answered with nothing" };
  if (typeof r.error === "string") {
    const said = r.error.slice(0, 4_000);
    return { error: firstLine(said), said };
  }
  /* The size before the encoding: base64 of a reply is a third larger than the
     reply and built in memory, so a pathological one is refused on its length
     rather than after the allocation it would have cost (found in review). */
  if (typeof r.svg === "string" && r.svg.length > (MAX_IMAGE_CHARS / 4) * 3)
    return { error: "the diagram is too large to draw here" };
  const svg = typeof r.svg === "string" ? r.svg.trim() : "";
  if (!svg.startsWith("<svg")) return { error: "the renderer answered with something that is not a picture" };
  const picture = pictureOf("image/svg+xml", base64(svg));
  if (!picture) return { error: "the diagram is too large to draw here" };
  const sane = (v: unknown) => (typeof v === "number" && v > 0 && v <= 65_535 ? Math.round(v) : 0);
  return { picture, w: sane(r.w), h: sane(r.h) };
}

/** An error, as the line under a fence that was not drawn says it. */
export function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "it could not be read";
  return line.length > 160 ? line.slice(0, 159) + "…" : line;
}
