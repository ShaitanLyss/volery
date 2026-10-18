/* Does an image (or a PDF) inside an MCP tool RESULT reach the model?
 *
 * `tools/probe-image.ts` answers this for a prompt on stdin. An `ask_user`
 * answer is not a prompt: it is the result of a parked `tools/call`
 * (`ask.rs`), so a picture written into the answer box can only reach the
 * agent as a content block inside that result. MCP allows `image` and
 * embedded `resource` blocks there, and "the schema allows it" is not the claim
 * that matters. What matters is whether this CLI forwards the block into the
 * model's context, or drops it, or flattens it to a placeholder string.
 *
 *   bun tools/probe-tool-image.ts
 *
 * One throwaway stdio server with three tools, each returning what the answer
 * box would return:
 *
 *   look_image   [text, image(quadrants), text, image(stripes), text]
 *   look_pdf     [text, resource{blob: application/pdf}]
 *   look_path    [text naming a file path]  (the control: a path in the text)
 *
 * The pictures are generated, seven colours in an order nothing in a training
 * set has seen, so a right answer cannot be a guess. The PDF carries a code
 * word that appears nowhere else. One real turn, pinned to Haiku.
 *
 * Re-run against a CLI upgrade before trusting `ask.rs`'s image results.
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const DIR = `${process.cwd().replace(/\\/g, "/")}/.scratch/probe-tool-image`;
mkdirSync(DIR, { recursive: true });

/* ---- the pictures (probe-image.ts's, copied so this runs alone) -------- */

type RGB = [number, number, number];
const QUADS: { name: string; rgb: RGB }[] = [
  { name: "green", rgb: [0x2e, 0x8b, 0x57] },
  { name: "orange", rgb: [0xff, 0x8c, 0x00] },
  { name: "blue", rgb: [0x1e, 0x50, 0xc8] },
  { name: "white", rgb: [0xff, 0xff, 0xff] },
];
const STRIPES: { name: string; rgb: RGB }[] = [
  { name: "red", rgb: [0xcc, 0x22, 0x22] },
  { name: "yellow", rgb: [0xff, 0xdd, 0x33] },
  { name: "purple", rgb: [0x77, 0x33, 0xaa] },
];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function png(size: number, pick: (x: number, y: number) => RGB): Uint8Array {
  const stride = size * 3 + 1;
  const raw = new Uint8Array(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pick(x, y);
      const at = y * stride + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size);
  dv.setUint32(4, size);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const SIZE = 64;
const quadPng = png(SIZE, (x, y) => {
  const slot = (y < SIZE / 2 ? 0 : 2) + (x < SIZE / 2 ? 0 : 1);
  return QUADS[[0, 1, 3, 2][slot]].rgb;
});
const stripePng = png(SIZE, (_x, y) => STRIPES[Math.min(2, Math.floor(y / (SIZE / 3)))].rgb);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/* ---- the PDF: one page, one line, a code word found nowhere else -------- */

const WORD = "HERON-4417";
function pdf(line: string): Uint8Array {
  const stream = `BT /F1 24 Tf 72 700 Td (The code word is ${line}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) body += `${String(o).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}
const pdfBytes = pdf(WORD);

/* The control: a file on disk, named by path in a text result. The model has
   to Read it, which is what a file attached to an ask answer on a project card
   would do. A different code word, so the two arms cannot answer each other. */
const PATH_WORD = "KESTREL-9031";
const PATH_FILE = `${DIR}/note.txt`;
writeFileSync(PATH_FILE, `The code word is ${PATH_WORD}.\n`);

/* ---- the stub server ---------------------------------------------------- */

const RESULTS = {
  look_image: [
    { type: "text", text: "Here is the first picture: " },
    { type: "image", data: b64(quadPng), mimeType: "image/png" },
    { type: "text", text: " and here is the second one: " },
    { type: "image", data: b64(stripePng), mimeType: "image/png" },
    { type: "text", text: "." },
  ],
  look_pdf: [
    { type: "text", text: "Here is the document: " },
    {
      type: "resource",
      resource: { uri: "file:///attached/note.pdf", mimeType: "application/pdf", blob: b64(pdfBytes) },
    },
  ],
  look_path: [{ type: "text", text: `The file is at ${PATH_FILE}` }],
};

const STUB = `${DIR}/stub.ts`;
const CFG = `${DIR}/mcp.json`;
writeFileSync(STUB, `
const RESULTS = ${JSON.stringify(RESULTS)};
const TOOLS = Object.keys(RESULTS).map((name) => ({ name,
  description: "Return what the user attached.", inputSchema: { type: "object", properties: {} } }));
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.method === "initialize")
      out({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05",
        capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0.0.1" } } });
    else if (m.method === "tools/list")
      out({ jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } });
    else if (m.method === "tools/call")
      out({ jsonrpc: "2.0", id: m.id, result: { content: RESULTS[m.params?.name] ?? [] } });
    else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
`);
const BUN = (Bun.which("bun") ?? "bun").replace(/\\/g, "/");
writeFileSync(CFG, JSON.stringify({ mcpServers: { stub: { command: BUN, args: [STUB] } } }));

/* ---- the turn ----------------------------------------------------------- */

const CLAUDE = Bun.which("claude") ?? "claude";
const proc = Bun.spawn([
  CLAUDE,
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--forward-subagent-text",
  "--dangerously-skip-permissions",
  "--model", "haiku",
  "--mcp-config", CFG,
  "--session-id", crypto.randomUUID(),
], { cwd: DIR, stdin: "pipe", stdout: "pipe", stderr: "pipe" });

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`.padStart(7);
const names = new Map<string, string>();
const resultShape = new Map<string, string>();
let answer = "";

const done = async (code: number) => {
  proc.kill();
  await proc.exited;
  /* The stub server is the CLI's child and can outlive the kill by a beat on
     Windows, holding the directory open. */
  for (let i = 0; i < 20; i++) {
    try { rmSync(DIR, { recursive: true, force: true }); break; } catch { await Bun.sleep(250); }
  }
  process.exit(code);
};

(async () => {
  for await (const c of proc.stderr) {
    const s = new TextDecoder().decode(c).trim();
    if (s) console.log(at(), "stderr:", s.slice(0, 300));
  }
})();

(async () => {
  const dec = new TextDecoder();
  let buf = "";
  for await (const c of proc.stdout) {
    buf += dec.decode(c);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const raw = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!raw.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(raw); } catch { continue; }
      if (ev.type === "system" && ev.subtype === "init") {
        console.log(at(), `← init model=${ev.model} stub=${JSON.stringify((ev.tools ?? []).filter((t: string) => t.includes("stub")))}`);
      }
      for (const b of ev?.message?.content ?? []) {
        if (b?.type === "tool_use") names.set(b.id, b.name);
        if (b?.type === "tool_result") {
          const n = names.get(b.tool_use_id) ?? "?";
          /* What the CLI put in the model's context for this result — the
             block kinds, and any text, which is where a flattened image would
             show up as a placeholder string. */
          const shape = typeof b.content === "string"
            ? `string ${JSON.stringify(b.content.slice(0, 400))}`
            : (b.content ?? []).map((x: any) =>
                x.type === "text" ? `text(${JSON.stringify(String(x.text).slice(0, 400))})`
                : x.type === "image" ? `image(${x.source?.media_type ?? x.mimeType ?? "?"})`
                : x.type === "document" ? `document(${x.source?.media_type ?? "?"})`
                : x.type).join(" + ");
          resultShape.set(n, shape);
          console.log(at(), `← tool_result ${n}: ${shape}`);
        }
      }
      if (ev.type === "assistant") {
        const t = (ev.message?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
        if (t.trim()) {
          /* The last thing said is the answer; anything before it is the model
             narrating its tool calls, which can name a colour by accident. */
          answer = t;
          console.log(at(), "← assistant:", JSON.stringify(t.trim().slice(0, 300)));
        }
      }
      if (ev.type === "result") {
        console.log(at(), `← result subtype=${ev.subtype} turns=${ev.num_turns}`);
        verdict();
        return done(0);
      }
    }
  }
})();

function verdict() {
  const said = answer.toLowerCase();
  const colours = [...QUADS, ...STRIPES].map((c) => ({ name: c.name, at: said.indexOf(c.name) }));
  const seen = colours.filter((c) => c.at >= 0);
  const inOrder = seen.length === 7 && seen.every((c, i) => i === 0 || c.at > seen[i - 1].at);
  console.log("\n--- verdict -------------------------------------------------");
  console.log(`image  : ${seen.length}/7 colours named${inOrder ? ", in order" : ""} — ${seen.length === 7 && inOrder ? "FORWARDED" : "NOT SEEN"}`);
  console.log(`pdf    : code word ${said.includes(WORD.toLowerCase()) ? "named — FORWARDED" : "not named — NOT SEEN"}`);
  console.log(`path   : code word ${said.includes(PATH_WORD.toLowerCase()) ? "named — the agent read the path" : "not named"}`);
  for (const [k, v] of resultShape) console.log(`  ${k.padEnd(24)} ${v}`);
}

proc.stdin.write(JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content:
      "Call mcp__stub__look_image, mcp__stub__look_pdf and mcp__stub__look_path, one after the other. " +
      "Then answer in exactly three lines: " +
      "(1) the FIRST picture's four quadrant colours clockwise from top-left, then the SECOND picture's three stripe colours top to bottom, seven words comma separated, or NO IMAGE if no picture reached you; " +
      "(2) the code word in the PDF, or NO PDF if no document reached you; " +
      "(3) the code word in the file at the path look_path gives (read it with your Read tool).",
  },
}) + "\n");
proc.stdin.flush();

setTimeout(() => { console.log("\n[timed out after 180s]"); verdict(); done(1); }, 180_000);
