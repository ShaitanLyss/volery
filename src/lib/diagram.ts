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

/** A diagram the frame drew, or why not. */
export type Drawn = { picture: Picture; w: number; h: number } | { error: string };

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
  if (typeof r.error === "string") return { error: firstLine(r.error.slice(0, 4_000)) };
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
