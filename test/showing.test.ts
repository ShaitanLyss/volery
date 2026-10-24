import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CACHE_CHARS,
  FILE_MARK,
  KEPT_MARK,
  SIZE_MARK,
  PictureCache,
  Sizes,
  frameWidth,
  isKeptName,
  nameOf,
  shownOf,
} from "../src/lib/showing";
import {
  PICTURE_EXTS,
  inlineText,
  localPicture,
  parseInline,
  parseMarkdown,
  pictureMarkdown,
  pictureSource,
} from "../src/lib/markdown";
import { MAX_IMAGE_CHARS, SKEIN_SHOW_TOOL, describeTool, pictureOf } from "../src/lib/classify";
import { blocksOf, isShown } from "../src/lib/transcript";
import { toMarkdown, type Bit } from "../src/lib/copy";
import { decodedGrowth } from "../src/lib/follow";
import { landed, type ToolCall } from "../src/lib/toolcall";
import type { Line } from "../src/lib/conversation.svelte";

const rust = readFileSync("src-tauri/src/show.rs", "utf8");
const PNG = "iVBORw0KGgo=";

/* ── where a picture written in prose comes from ─────────────────────────── */

describe("pictureSource", () => {
  test("a path on this machine is a picture, absolute or relative", () => {
    expect(pictureSource("C:\\tmp\\chart.png")).toBe("C:\\tmp\\chart.png");
    expect(pictureSource("C:/tmp/chart.PNG")).toBe("C:/tmp/chart.PNG");
    expect(pictureSource("charts/sales.svg")).toBe("charts/sales.svg");
    expect(pictureSource("./out/frame.webp")).toBe("./out/frame.webp");
    expect(pictureSource("/home/me/x.jpeg")).toBe("/home/me/x.jpeg");
  });

  test("a title after the path is a tooltip nobody asked for", () => {
    expect(pictureSource('charts/a.png "the chart"')).toBe("charts/a.png");
  });

  test("a path with spaces in it, with the brackets or without", () => {
    expect(pictureSource("<C:\\Program Files\\d.svg>")).toBe("C:\\Program Files\\d.svg");
    expect(pictureSource("<C:\\Program Files\\d.svg")).toBeNull();
    /* How an agent actually writes it — dropped silently, it would be alt
       text with nothing saying a picture was meant. */
    expect(pictureSource("C:\\Program Files\\d.svg")).toBe("C:\\Program Files\\d.svg");
    expect(pictureSource("my charts/a b.png")).toBe("my charts/a b.png");
    // A title still ends in a quote, which no picture's name does.
    expect(pictureSource('C:\\Program Files\\d.svg "the diagram"')).toBeNull();
  });

  test("a file url is the path it names, and one naming a host is not", () => {
    expect(pictureSource("file:///C:/tmp/a%20b.png")).toBe("C:/tmp/a b.png");
    expect(pictureSource("file:///home/me/x.png")).toBe("/home/me/x.png");
    expect(pictureSource("file://evil.example/share/x.png")).toBeNull();
    expect(pictureSource("file:///C:/bad%E0%A4%A.png")).toBeNull();
  });

  /* The half that matters: nothing on the network is ever asked for. */
  test("a url is never a picture — it stays the link it was", () => {
    expect(pictureSource("https://example.com/x.png")).toBeNull();
    expect(pictureSource("http://example.com/x.png")).toBeNull();
    expect(pictureSource("www.example.com/x.png")).toBeNull();
    expect(pictureSource("ftp://example.com/x.png")).toBeNull();
    expect(pictureSource("javascript:alert(1)//x.png")).toBeNull();
    const [node] = parseInline("![web](https://example.com/x.png)");
    expect(node.t).toBe("link");
  });

  /* Opening a share is an SMB handshake carrying this user's credentials to
     whatever host the text named. Every spelling is refused. */
  test("a share is never a picture, in any spelling", () => {
    expect(pictureSource("\\\\evil.example\\share\\x.png")).toBeNull();
    expect(pictureSource("//evil.example/share/x.png")).toBeNull();
    expect(pictureSource("\\/evil.example/x.png")).toBeNull();
    expect(pictureSource("\\\\?\\UNC\\evil.example\\share\\x.png")).toBeNull();
    expect(pictureSource("<\\\\evil example\\x.png>")).toBeNull();
    // The verbatim spelling of a local drive is local, unless it climbs.
    expect(pictureSource("\\\\?\\C:\\tmp\\x.png")).toBe("\\\\?\\C:\\tmp\\x.png");
    expect(pictureSource("\\\\?\\C:\\tmp\\..\\..\\x.png")).toBeNull();
    /* The device namespace normalises a `..` and its root is one segment from
       the redirector — refused outright, drive letter or not (found in review). */
    expect(pictureSource("\\\\.\\C:\\..\\UNC\\evil.example\\share\\x.png")).toBeNull();
    expect(pictureSource("\\\\.\\C:\\tmp\\x.png")).toBeNull();
  });

  test("only a picture's extension is a picture", () => {
    expect(pictureSource("report.pdf")).toBeNull();
    expect(pictureSource("chart")).toBeNull();
    expect(pictureSource("chart.png.exe")).toBeNull();
    expect(localPicture("a\u0000b.png")).toBeNull();
    expect(localPicture("x".repeat(1100) + ".png")).toBeNull();
  });

  test("a data URI is held to exactly the rules a tool result's picture is", () => {
    const ok = `data:image/png;base64,${PNG}`;
    expect(pictureSource(ok)).toBe(ok);
    expect(pictureSource(`data:IMAGE/PNG;base64,${PNG}`)).toBe(ok);
    // Not an image, not base64, or carrying something that would close the attribute.
    expect(pictureSource(`data:text/html;base64,${PNG}`)).toBeNull();
    expect(pictureSource("data:image/png,<svg onload=alert(1)>")).toBeNull();
    expect(pictureSource(`data:image/png;base64,${PNG}"onerror="x`)).toBeNull();
    expect(pictureSource(`data:image/svg+xml;base64,${PNG}`)).toBe(
      `data:image/svg+xml;base64,${PNG}`,
    );
    expect(pictureSource(`data:image/png;base64,${"A".repeat(MAX_IMAGE_CHARS + 4)}`)).toBeNull();
    // One reader, so the two sources cannot disagree.
    expect(pictureOf("image/png", PNG)?.url).toBe(ok);
  });

  test("the extensions are the wall's — read out of the Rust, not agreed by hand", () => {
    const m = /pub\(crate\) const PICTURES: \[&str; \d+\] = \[([^\]]+)\]/.exec(rust);
    expect(m).not.toBeNull();
    const theirs = [...m![1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
    expect(theirs.length).toBeGreaterThan(0);
    expect([...PICTURE_EXTS].sort()).toEqual([...theirs].sort());
  });
});

describe("a picture in the parse", () => {
  test("is its own inline, with its label's words as the alt", () => {
    const kids = parseInline("see ![the **sales** chart](charts/a.png) here");
    expect(kids).toEqual([
      { t: "text", v: "see " },
      { t: "img", alt: "the sales chart", src: "charts/a.png" },
      { t: "text", v: " here" },
    ]);
    expect(inlineText(kids)).toBe("see the sales chart here");
  });

  test("one this does not draw is its label, as before", () => {
    expect(parseInline("![a report](report.pdf)")).toEqual([{ t: "text", v: "a report" }]);
  });

  /* A link is the thing to press, and a picture is a button of its own: one
     inside the other would be a press doing two things. */
  test("a picture inside a link's label is drawn as its words", () => {
    expect(parseInline("[![logo](a.png) home](https://example.com)")).toEqual([
      {
        t: "link",
        href: "https://example.com",
        kids: [
          { t: "text", v: "logo" },
          { t: "text", v: " home" },
        ],
      },
    ]);
  });

  test("a picture alone on a line is a paragraph holding it", () => {
    expect(parseMarkdown("![x](a.png)")).toEqual([
      { t: "p", kids: [{ t: "img", alt: "x", src: "a.png" }] },
    ]);
  });
});

/* ── what a `show` call came to ──────────────────────────────────────────── */

const KEPT = "0b1f2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.png";
const call = (input: unknown, result?: string, failed = false): ToolCall => ({
  id: "toolu_1",
  name: SKEIN_SHOW_TOOL,
  input,
  ...(result === undefined ? {} : { result: landed(result, failed) }),
});

describe("shownOf", () => {
  test("in flight, it is pending", () => {
    expect(shownOf(call({ path: "chart.png" }))).toEqual({
      state: "pending",
      path: "chart.png",
      caption: "",
    });
  });

  const success = (name: string, tail = "") =>
    `shown ${name} in the transcript, at this point in your turn. It is kept as it is now.\n\n${KEPT_MARK}${KEPT}\`${tail}`;

  test("a kept copy is found on the last line, with its size", () => {
    expect(
      shownOf(call({ path: " chart.png ", caption: "sales\nby month" }, success("chart.png", ` (640${SIZE_MARK}360)`))),
    ).toEqual({
      state: "picture",
      path: "chart.png",
      caption: "sales by month",
      kept: KEPT,
      size: { w: 640, h: 360 },
    });
    // An older result, with no size, is still a picture.
    expect(shownOf(call({ path: "a.png" }, success("a.png")))).toMatchObject({ state: "picture", kept: KEPT });
  });

  /* A file's name is in the sentence above the mark, and a name can be
     written to look like one — so only the last line is believed. */
  test("a mark written into a file's name is not believed", () => {
    const OTHER = "11111111-2222-4333-8444-555555555555.png";
    const forged = `${KEPT_MARK}${OTHER}\` (1${SIZE_MARK}1)`;
    const refusal = `there is no file at C:\\x\\${forged}. Write the file first, then show it.`;
    expect(shownOf(call({ path: forged }, refusal)).state).toBe("refused");
    const named = success(`a ${forged} b.png`, ` (10${SIZE_MARK}10)`);
    expect(shownOf(call({ path: "x" }, named))).toMatchObject({ kept: KEPT });
  });

  test("a file is a plate", () => {
    const said = `${FILE_MARK} in the transcript: report.pdf, as a plate`;
    expect(shownOf(call({ path: "report.pdf" }, said)).state).toBe("file");
  });

  test("a refusal keeps its sentence, and a failed result is never a picture", () => {
    const no = "chart.png is 9.0 MB and a picture shown in the transcript may be at most 3 MB";
    expect(shownOf(call({ path: "chart.png" }, no))).toEqual({
      state: "refused",
      path: "chart.png",
      caption: "",
      why: no,
    });
    const forged = `${KEPT_MARK}${KEPT}\``;
    expect(shownOf(call({ path: "x.png" }, forged, true)).state).toBe("refused");
  });

  /* The name is read back out of text, so it is held to the shape `keep`
     writes — a name with a separator in it would walk `read_shown` out of its
     directory. Rust refuses it too; this is the half that never asks. */
  test("a kept name that is not a uuid and a picture is not believed", () => {
    for (const bad of ["../../secret.png", "x.png", `${KEPT}.exe`, KEPT.toUpperCase()]) {
      expect(isKeptName(bad)).toBe(false);
      expect(shownOf(call({ path: "x.png" }, `${KEPT_MARK}${bad}\``)).state).toBe("refused");
    }
    expect(isKeptName(KEPT)).toBe(true);
  });

  test("the marks are the Rust's own, read out of show.rs", () => {
    const mark = (name: string) =>
      new RegExp(`pub\\(crate\\) const ${name}: &str = "([^"]+)";`).exec(rust)?.[1];
    expect(mark("KEPT_MARK")).toBe(KEPT_MARK);
    expect(mark("FILE_MARK")).toBe(FILE_MARK);
    expect(mark("SIZE_MARK")).toBe(SIZE_MARK);
    // Built into a pattern, so it may hold nothing a pattern reads specially.
    expect(KEPT_MARK).not.toMatch(/[.*+?^${}()|[\]\\]/);
    // And the Rust puts it on a line of its own at the very end.
    expect(rust).toContain("\\n\\n{KEPT_MARK}{id}`{size}\"");
  });

  test("a caption is a line, not a paragraph", () => {
    const long = "word ".repeat(200);
    const got = shownOf(call({ path: "a.png", caption: long }));
    expect(got.caption.length).toBeLessThanOrEqual(280);
    expect(got.caption.endsWith("…")).toBe(true);
  });

  test("names", () => {
    expect(nameOf("C:\\tmp\\chart.png")).toBe("chart.png");
    expect(nameOf("out/frame.webp")).toBe("frame.webp");
    expect(describeTool(SKEIN_SHOW_TOOL, { path: "C:\\tmp\\chart.png" })).toBe("showed chart.png");
    expect(describeTool(SKEIN_SHOW_TOOL, {})).toBe("showed something");
  });
});

/* ── where it stands in the column ───────────────────────────────────────── */

const tool = (text: string): Line => ({ kind: "tool", text, call: { name: "Read", input: {} } });
const show = (path: string): Line => ({
  kind: "tool",
  text: `showed ${path}`,
  call: { id: path, name: SKEIN_SHOW_TOOL, input: { path } },
});

describe("a shown picture in the transcript", () => {
  test("is never folded into a run of machinery", () => {
    const blocks = blocksOf([tool("read a"), tool("read b"), show("x.png"), tool("read c")]);
    expect(blocks.map((b) => b.kind)).toEqual(["tools", "shown", "line"]);
    expect(isShown(show("x.png"))).toBe(true);
    expect(isShown(tool("read a"))).toBe(false);
  });

  test("two in a row are two pictures", () => {
    const blocks = blocksOf([show("a.png"), show("b.png")]);
    expect(blocks.map((b) => b.kind)).toEqual(["shown", "shown"]);
  });

  /* An absolute key, so the node — and the picture already decoded in it —
     survives the live column sliding off the front. */
  test("keeps its key as the column slides", () => {
    const lines = [tool("read a"), show("x.png")];
    const before = blocksOf(lines, "l", 10).find((b) => b.kind === "shown")!.key;
    const after = blocksOf(lines.slice(1), "l", 11).find((b) => b.kind === "shown")!.key;
    expect(after).toBe(before);
  });
});

/* ── holding pictures ────────────────────────────────────────────────────── */

describe("PictureCache", () => {
  test("holds up to its budget, least recently used going first", () => {
    const c = new PictureCache(10);
    c.put("a", "xxxx");
    c.put("b", "xxxx");
    expect(c.get("a")).toBe("xxxx"); // a is now the newer of the two
    c.put("c", "xxxx");
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe("xxxx");
    expect(c.get("c")).toBe("xxxx");
    expect(c.used).toBe(8);
  });

  test("a picture bigger than the whole budget is not held, and empties nothing", () => {
    const c = new PictureCache(10);
    c.put("a", "xxxx");
    c.put("huge", "x".repeat(11));
    expect(c.get("huge")).toBeUndefined();
    expect(c.get("a")).toBe("xxxx");
  });

  test("putting the same key again replaces it rather than counting it twice", () => {
    const c = new PictureCache(10);
    c.put("a", "xxxx");
    c.put("a", "xxxxxx");
    expect(c.used).toBe(6);
    expect(c.size).toBe(1);
  });

  test("the budget is the one the doc says", () => {
    expect(new PictureCache().budget).toBe(CACHE_CHARS);
  });
});

describe("Sizes", () => {
  test("remembers a measure and forgets the oldest past its bound", () => {
    const s = new Sizes(2);
    s.set("a", 100, 50);
    s.set("b", 10, 10);
    s.set("c", 1, 2);
    expect(s.get("a")).toBeUndefined();
    expect(s.get("c")).toEqual({ w: 1, h: 2 });
  });

  test("a picture with no size is not a measure", () => {
    const s = new Sizes();
    s.set("a", 0, 10);
    s.set("b", NaN, 10);
    expect(s.get("a")).toBeUndefined();
    expect(s.get("b")).toBeUndefined();
  });

  test("the box is never wider than the picture, the column, or too tall", () => {
    expect(frameWidth(800, 400)).toBe("min(800px, 100%, calc(28em * 2.0000))");
  });

  /* One picture pixel per screen pixel: on a 150% display a 640-pixel chart is
     427 CSS pixels wide, every pixel landing on one of the screen's. */
  test("a raster is never drawn bigger than its pixels on a dense screen", () => {
    expect(frameWidth(640, 360, 1.5)).toBe("min(426.67px, 100%, calc(28em * 1.7778))");
    expect(frameWidth(640, 360, 0)).toBe("min(640px, 100%, calc(28em * 1.7778))");
  });
});

/* ── the two places a picture reaches outside its own component ──────────── */

describe("copying across a picture", () => {
  const el = (tag: string, attr: Record<string, string>, kids: Bit[] = []): Bit => ({
    tag,
    attr,
    kids,
  });

  test("writes the markdown it was drawn from, inline in its sentence", () => {
    const md = pictureMarkdown("the chart", "charts/a.png");
    const got = toMarkdown([
      el("P", {}, [
        { text: "see " },
        el("SPAN", { class: "pic", "data-md": md }, [
          el("BUTTON", { class: "hit" }, [el("IMG", { src: "data:image/png;base64,AAAA" })]),
        ]),
        { text: " here" },
      ]),
    ]);
    expect(got).toBe("see ![the chart](charts/a.png) here");
  });

  test("a figure is a block of its own, not a gap", () => {
    const md = pictureMarkdown("sales by month", "C:\\tmp\\chart.png");
    const got = toMarkdown([
      el("P", {}, [{ text: "before" }]),
      el("DIV", { class: "figure", "data-md": md }, [el("DIV", { class: "caption" }, [{ text: "sales by month" }])]),
      el("P", {}, [{ text: "after" }]),
    ]);
    expect(got).toBe("before\n\n![sales by month](C:\\tmp\\chart.png)\n\nafter");
  });

  test("never pastes the bytes of a data picture", () => {
    const big = `data:image/png;base64,${"A".repeat(5000)}`;
    const md = pictureMarkdown("x", big);
    expect(md).toBe("![x](data:image/png;base64,…)");
    expect(pictureMarkdown("a [b] c", "<odd>.png")).toBe("![a b c](<<odd>.png>)");
    expect(pictureMarkdown("y", "C:\\Program Files\\d.svg")).toBe("![y](<C:\\Program Files\\d.svg>)");
  });

  test("an element carrying nothing to say says nothing", () => {
    expect(toMarkdown([el("DIV", { "data-md": "" }, [{ text: "furniture" }])])).toBe("");
  });
});

describe("following the tail as a picture loads", () => {
  /* `load` does not bubble, so `hearGrowth` hears it in the capture phase and
     asks only whether the thing that loaded took up room as it arrived. */
  test("a picture loading is growth; a frame loading is not", () => {
    expect(decodedGrowth({ tagName: "IMG" } as unknown as EventTarget)).toBe(true);
    expect(decodedGrowth({ tagName: "IFRAME" } as unknown as EventTarget)).toBe(false);
    expect(decodedGrowth(null)).toBe(false);
  });

  test("the listener is on the capture phase, which is the only way to hear it", () => {
    const src = readFileSync("src/lib/follow.ts", "utf8");
    expect(src).toMatch(/addEventListener\("load", loaded, true\)/);
    expect(src).toMatch(/removeEventListener\("load", loaded, true\)/);
  });
});

describe("the tool", () => {
  test("pin points at show, and show says it is the default", () => {
    const pin = readFileSync("src-tauri/src/pin.rs", "utf8");
    expect(pin).toContain("`show` it");
    expect(rust).toContain("this — not `pin` — is how to put something in front of the user");
    // And it says the reply's own markdown comes first — images and mermaid.
    expect(rust).toContain("first thing to reach");
  });
});

describe("finding a word in a figure", () => {
  test("looks in what the figure draws — its name and caption — not the line's words", async () => {
    const { textOf } = await import("../src/lib/hunt");
    const line: Line = {
      kind: "tool",
      text: "showed chart.png",
      call: { id: "t", name: SKEIN_SHOW_TOOL, input: { path: "out/chart.png", caption: "sales by month" } },
    };
    const [b] = blocksOf([line]);
    expect(b.kind).toBe("shown");
    expect(textOf(b)).toBe("chart.png\nsales by month");
  });
});

describe("the frame a diagram and a design stand behind", () => {
  test("is one wall, stated once", async () => {
    const { SANDBOX, sandboxPolicy, sandboxDoc } = await import("../src/lib/sandbox");
    // Never same-origin: the two together hand the frame the app's origin back.
    expect(SANDBOX).toBe("allow-scripts");
    expect(sandboxPolicy(true)).toContain("default-src 'none'");
    expect(sandboxPolicy(true)).toContain("script-src 'unsafe-inline'");
    expect(sandboxPolicy(false)).toContain("script-src 'none'");
    expect(sandboxPolicy(true)).not.toMatch(/https?:|connect-src|\*/);
    const doc = sandboxDoc({ scripts: ["a()</script><script>b()"], body: "<p>x</p>" });
    // The policy is the first thing in the document, ahead of anything that could run.
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<p>"));
    expect(doc).toContain("a()<\\/script><script>b()");
    expect(sandboxDoc({ scripts: false, body: "x" })).not.toContain("<script>");
    // And nothing but the shared wall stands a frame up.
    const gallery = readFileSync("src/lib/Gallery.svelte", "utf8");
    expect(gallery).not.toMatch(/sandbox="/);
    expect(gallery).toContain("sandbox={SANDBOX}");
    // Sound needs no `allow` on the frame: measured in a lab (sink ce6af271), an
    // opaque-origin scaled srcdoc frame runs an AudioContext after one click.
    // A permissions-policy grant would be a second thing the wall hands out.
    expect(gallery).not.toMatch(/\sallow=/);
  });
});

describe("a diagram fence", () => {
  test("is a closed mermaid fence, in any case", async () => {
    const { isDiagramFence } = await import("../src/lib/diagram");
    expect(isDiagramFence("mermaid")).toBe(true);
    expect(isDiagramFence("Mermaid")).toBe(true);
    expect(isDiagramFence("ts")).toBe(false);
    expect(isDiagramFence(null)).toBe(false);
  });

  /* The streaming contract is the parser's and is untouched: an unclosed
     fence is `open`, and only a closed one is ever drawn. */
  test("mid-stream it is an open code block, never a half-drawn diagram", () => {
    const partial = parseMarkdown("```mermaid\nflowchart LR\n  a --> b");
    expect(partial).toEqual([{ t: "code", lang: "mermaid", text: "flowchart LR\n  a --> b", open: true }]);
    const whole = parseMarkdown("```mermaid\nflowchart LR\n  a --> b\n```");
    expect(whole[0]).toMatchObject({ t: "code", lang: "mermaid", open: false });
    // Markdown.svelte draws a Diagram for a closed one only.
    const md = readFileSync("src/lib/Markdown.svelte", "utf8");
    expect(md).toContain('b.t === "code" && diagrams && !b.open && isDiagramFence(b.lang)');
  });

  test("copies back as the fence it was drawn from, even holding backticks", async () => {
    const { fenceMarkdown } = await import("../src/lib/diagram");
    expect(fenceMarkdown("graph TD\n  a --> b")).toBe("```mermaid\ngraph TD\n  a --> b\n```");
    expect(fenceMarkdown("a\n```\nb")).toBe("````mermaid\na\n```\nb\n````");
  });
});

describe("what is believed of the renderer's answer", () => {
  test("only an svg string, drawn as a picture, and never markup", async () => {
    const { readDrawn } = await import("../src/lib/diagram");
    const ok = readDrawn({ id: 1, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="5"></svg>', w: 10, h: 5 });
    expect("picture" in ok && ok.picture.url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect("picture" in ok && ok.w === 10 && ok.h === 5).toBe(true);
    // Unicode in a label survives the base64.
    const uni = readDrawn({ svg: "<svg><text>café — 図</text></svg>" });
    expect("picture" in uni).toBe(true);
    // Anything that is not an svg is refused.
    expect("error" in readDrawn({ svg: "<script>alert(1)</script>" })).toBe(true);
    expect("error" in readDrawn({ svg: 42 })).toBe(true);
    expect("error" in readDrawn(null)).toBe(true);
    expect("error" in readDrawn("<svg></svg>")).toBe(true);
    // A size that is not sane is no size.
    const odd = readDrawn({ svg: "<svg></svg>", w: -1, h: 1e9 });
    expect("picture" in odd && odd.w === 0 && odd.h === 0).toBe(true);
    // Too big to carry is said, not drawn.
    expect("error" in readDrawn({ svg: "<svg>" + "x".repeat(MAX_IMAGE_CHARS) + "</svg>" })).toBe(true);
    // An error is its first line, clipped.
    const bad = readDrawn({ error: "\n  Parse error on line 2:\n...stuff" });
    expect(bad).toEqual({ error: "Parse error on line 2:" });
  });

  test("the frame's own script reaches for nothing outside it", async () => {
    const { BOOT } = await import("../src/lib/diagram");
    expect(BOOT).not.toMatch(/fetch|XMLHttpRequest|import\(|https?:|localStorage|document\.cookie|eval/);
    // It answers only its parent.
    expect(BOOT).toContain("e.source !== window.parent");
  });
});

describe("the ink a diagram is drawn in", () => {
  const ink = {
    ink: "rgb(21, 18, 16)",
    surface: "rgb(30, 26, 24)",
    paper: "rgb(237, 228, 216)",
    dim: "rgb(180, 168, 156)",
    mute: "rgb(138, 126, 116)",
    faint: "rgb(97, 88, 80)",
    edge: "rgb(60, 54, 49)",
  };

  /* Colour on this wall is status. Every colour a diagram is given is one of
     the page's own, or a step between two of them — nothing mermaid would
     otherwise rotate into a hue. */
  test("is the page's own, and nothing else", async () => {
    const { diagramConfig } = await import("../src/lib/diagram");
    const c = diagramConfig(ink);
    const vars = c.themeVariables as Record<string, unknown>;
    const own = new Set(Object.values(ink));
    const channels = (v: string) => /rgb\((\d+), (\d+), (\d+)\)/.exec(v)!.slice(1).map(Number);
    const [s, d] = [channels(ink.surface), channels(ink.dim)];
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v !== "string" || !v.startsWith("rgb")) continue;
      if (own.has(v)) continue;
      // otherwise it is on the line from surface to dim
      const x = channels(v);
      const t = (x[0] - s[0]) / (d[0] - s[0]);
      for (let i = 0; i < 3; i++) expect(Math.abs(s[i] + (d[i] - s[i]) * t - x[i])).toBeLessThanOrEqual(1);
      expect(k).toMatch(/^(pie\d+|cScale\d+|git\d+)$/);
    }
    expect(vars.darkMode).toBe(true);
  });

  test("keeps mermaid's own containment switched on", async () => {
    const { diagramConfig, DIAGRAM_MOST, DIAGRAM_EDGES } = await import("../src/lib/diagram");
    const c = diagramConfig(ink);
    expect(c.securityLevel).toBe("strict");
    expect(c.htmlLabels).toBe(false);
    expect((c.flowchart as { htmlLabels: boolean }).htmlLabels).toBe(false);
    expect(c.maxTextSize).toBe(DIAGRAM_MOST);
    expect(c.maxEdges).toBe(DIAGRAM_EDGES);
  });

  test("a light page is drawn light", async () => {
    const { diagramConfig } = await import("../src/lib/diagram");
    const c = diagramConfig({ ...ink, ink: "rgb(245, 240, 232)", surface: "rgb(250, 247, 241)" });
    expect((c.themeVariables as { darkMode: boolean }).darkMode).toBe(false);
  });
});

describe("the review's second pass", () => {
  /* With a nonce, the two script tags this window wrote are the only script
     that runs — not an event handler a renderer bug left in its DOM. */
  test("the diagram frame runs only the scripts it was written with", async () => {
    const { sandboxPolicy, sandboxDoc, freshNonce } = await import("../src/lib/sandbox");
    const n = freshNonce();
    expect(n).toMatch(/^[0-9a-f]{32}$/);
    expect(freshNonce()).not.toBe(n);
    expect(sandboxPolicy(true, n)).toContain(`script-src 'nonce-${n}'`);
    expect(sandboxPolicy(true, n)).not.toMatch(/script-src[^;]*unsafe-inline/);
    const doc = sandboxDoc({ scripts: ["a()", "b()"], nonce: n });
    expect(doc.match(new RegExp(`<script nonce="${n}">`, "g"))?.length).toBe(2);
    // A nonce that is not hex is not written anywhere it could close something.
    const bad = sandboxDoc({ scripts: ["a()"], nonce: '" onload="x' });
    expect(bad).not.toContain("onload");
    expect(bad).toContain("script-src 'unsafe-inline'");
    // The gallery's previews keep their inline scripts.
    expect(sandboxPolicy(true)).toContain("script-src 'unsafe-inline'");
    // And the renderer uses one.
    expect(readFileSync("src/lib/drawing.svelte.ts", "utf8")).toContain("nonce: freshNonce()");
  });

  test("a reply too long to carry is refused before it is encoded", async () => {
    const { readDrawn } = await import("../src/lib/diagram");
    const huge = "<svg>" + "x".repeat((MAX_IMAGE_CHARS / 4) * 3) + "</svg>";
    expect(readDrawn({ svg: huge })).toEqual({ error: "the diagram is too large to draw here" });
    const long = readDrawn({ error: "y".repeat(100_000) });
    expect("error" in long && long.error.length <= 160).toBe(true);
  });

  /* No read stands between a data picture and the decode, so its header is
     asked about the pixel cap before it is given its src. */
  test("a data picture is measured before it is drawn", () => {
    const src = readFileSync("src/lib/InlinePicture.svelte", "utf8");
    const load = src.slice(src.indexOf("async function load("));
    const data = load.slice(load.indexOf('if (src.kind === "data")'), load.indexOf("url = src.url;"));
    expect(data).toContain('invoke<Measure>("measure_picture_data"');
    expect(data).toContain("tooLarge");
  });

  test("a frame that navigates itself is thrown away", () => {
    const src = readFileSync("src/lib/drawing.svelte.ts", "utf8");
    expect(src).toMatch(/\+\+loads > 1 && this\.#frame === frame\) this\.#close\(\)/);
  });
});
