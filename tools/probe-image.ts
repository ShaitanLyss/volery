/* Does the CLI accept images on stdin, interleaved with text, and does the
 * model actually see them?
 *
 * `user_envelope` in `supervisor.rs` writes one content block — a `text` one —
 * into a `content` array that the Agent SDK's envelope says may hold several,
 * of several kinds. That is the whole basis for attaching a pasted screenshot
 * to a prompt rather than writing a path in it, and "the schema allows it" is
 * not the same claim as "this binary reads it and the model gets the pixels".
 *
 * Four things have to be true and only the last is interesting:
 *
 *   1. the CLI parses the envelope at all (a rejected line is silent — NDJSON
 *      has no error channel, and a bad line is a turn that simply never starts);
 *   2. it takes MORE THAN ONE image and does not collapse them;
 *   3. `--replay-user-messages` still echoes something `#claimEcho` can match,
 *      which matches on the *text* of a replay — an image envelope coming back
 *      shaped differently leaves the line awaited forever and the card stuck
 *      looking unacknowledged;
 *   4. the model can describe images it has no other way to know, AND can tell
 *      which is which from where they sit in the sentence. That last clause is
 *      the whole of the inline design: "look at [a], make it more like [b]"
 *      only means anything if position survives the wire.
 *
 * Which is why the pictures are generated here rather than taken off disk:
 * seven colours in an order nothing in a training set has ever seen. A model
 * guessing from the prompt alone gets them wrong; a model handed the pixels
 * gets seven out of seven, in the right two groups.
 *
 *   bun tools/probe-image.ts
 *
 * Costs one small real turn, plus what the images are worth as input tokens —
 * two 64x64 PNGs are a few hundred.
 */

import { deflateSync } from "node:zlib";

const CWD = new URL("../.scratch/probe-image", import.meta.url).pathname.slice(1);
const CLAUDE = Bun.which("claude") ?? "claude";

/** Skein's shipped flags, verbatim — `supervisor::spawn_now`. */
const ARGV = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--forward-subagent-text",
  "--dangerously-skip-permissions",
];

/* ---- the pictures ------------------------------------------------------ */

type RGB = [number, number, number];

/** Four quadrants, clockwise from top-left. Nameable without hedging, and
 *  unguessable as an ordered set. */
const QUADS: { name: string; rgb: RGB }[] = [
  { name: "green", rgb: [0x2e, 0x8b, 0x57] },
  { name: "orange", rgb: [0xff, 0x8c, 0x00] },
  { name: "blue", rgb: [0x1e, 0x50, 0xc8] },
  { name: "white", rgb: [0xff, 0xff, 0xff] },
];

/** Three stripes, top to bottom. A different *kind* of arrangement from the
 *  quadrants on purpose: a model that had only skimmed one image and inferred
 *  the other would have to invent a layout as well as colours. */
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

/** A minimal truecolour PNG, `pick` choosing a pixel's colour.
 *
 *  No dependencies on purpose: a probe that needs an install is a probe nobody
 *  re-runs when the next CLI version lands. */
function png(size: number, pick: (x: number, y: number) => RGB): Uint8Array {
  const stride = size * 3 + 1; // one filter byte per row
  const raw = new Uint8Array(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour

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

/* clockwise from top-left is TL, TR, BR, BL; row-major order is TL, TR, BL, BR
   — so the row-major slot maps through [0, 1, 3, 2]. */
const quadPng = png(SIZE, (x, y) => {
  const slot = (y < SIZE / 2 ? 0 : 2) + (x < SIZE / 2 ? 0 : 1);
  return QUADS[[0, 1, 3, 2][slot]].rgb;
});
const stripePng = png(SIZE, (_x, y) => STRIPES[Math.min(2, Math.floor(y / (SIZE / 3)))].rgb);

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

console.log(`images : two ${SIZE}x${SIZE} pngs, ${quadPng.length} + ${stripePng.length} bytes`);
console.log(`truth  : quadrants ${QUADS.map((q) => q.name).join(", ")} (clockwise from top-left)`);
console.log(`         stripes   ${STRIPES.map((s) => s.name).join(", ")} (top to bottom)`);

/* ---- the turn ---------------------------------------------------------- */

await Bun.$`mkdir -p ${CWD}`.quiet();

const proc = Bun.spawn([CLAUDE, ...ARGV, "--session-id", crypto.randomUUID()], {
  cwd: CWD,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`.padStart(7);

/* The sentence is deliberately the shape the feature produces: text, image,
   text, image, text — an image sitting where you were typing, not a tray of
   attachments bolted onto the end. */
const HEAD = "Here is the first picture: ";
const MID = " and here is the second one: ";
const TAIL =
  ". Name the FIRST picture's four quadrant colours clockwise from the top-left, " +
  "then the SECOND picture's three stripe colours top to bottom. " +
  "Seven words, comma separated, nothing else. If you were handed no pictures, say NO IMAGE.";

const envelope = {
  type: "user",
  message: {
    role: "user",
    content: [
      { type: "text", text: HEAD },
      { type: "image", source: { type: "base64", media_type: "image/png", data: b64(quadPng) } },
      { type: "text", text: MID },
      { type: "image", source: { type: "base64", media_type: "image/png", data: b64(stripePng) } },
      { type: "text", text: TAIL },
    ],
  },
};

const line = JSON.stringify(envelope);
console.log(at(), `→ send: ${line.length} bytes, content=[${envelope.message.content.map((b) => b.type).join("+")}]`);
proc.stdin.write(line + "\n");
proc.stdin.flush();

(async () => {
  const dec = new TextDecoder();
  for await (const c of proc.stderr) {
    const s = dec.decode(c).trim();
    if (s) console.log(at(), "stderr:", s);
  }
})();

let answer = "";
let replayText: string | null = null;
let replayShape: string | null = null;
let done = false;

const reader = (async () => {
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
      try {
        ev = JSON.parse(raw);
      } catch {
        continue;
      }

      if (ev.type === "system" && ev.subtype === "init") {
        console.log(at(), `← init: model=${ev.model}`);
      }
      if (ev.type === "user") {
        const c = ev.message?.content;
        replayShape =
          typeof c === "string" ? "string" : Array.isArray(c) ? c.map((b: any) => b?.type).join("+") : typeof c;
        replayText =
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("")
              : "";
        console.log(at(), `← USER REPLAY: content=[${replayShape}] text=${JSON.stringify(replayText.slice(0, 120))}`);
      }
      if (ev.type === "assistant") {
        const text = (ev.message?.content ?? [])
          .filter((b: any) => b?.type === "text")
          .map((b: any) => b.text)
          .join("");
        if (text.trim()) {
          answer = text.trim();
          console.log(at(), "← assistant:", JSON.stringify(answer.slice(0, 200)));
        }
      }
      if (ev.type === "result") {
        console.log(at(), `← result: subtype=${ev.subtype} is_error=${ev.is_error} turns=${ev.num_turns}`);
        done = true;
        return;
      }
    }
  }
})();

/* A rejected line is silent — NDJSON has no error channel — so "nothing came
   back" is a real outcome and needs a clock rather than a hang.
   The timer is *cleared* rather than left to expire: a pending `setTimeout`
   keeps Bun's event loop alive, so a probe that answered in four seconds still
   sat there for two minutes with its verdict stuck in the pipe. */
let bail: ReturnType<typeof setTimeout>;
const guard = new Promise<void>((res) => {
  bail = setTimeout(res, 120_000);
});
await Promise.race([reader, guard]);
clearTimeout(bail!);
proc.kill();

/* ---- the verdict ------------------------------------------------------- */

console.log("\n--- verdict -------------------------------------------------");

const said = answer.toLowerCase();
const order = [...QUADS, ...STRIPES].map((c) => ({ name: c.name, at: said.indexOf(c.name) }));
const seen = order.filter((c) => c.at >= 0);
const inOrder =
  seen.length === 7 && seen.every((c, i) => i === 0 || c.at > seen[i - 1].at);

console.log(`parsed : ${done ? "the CLI accepted the envelope and ran a turn" : "NO RESULT — the envelope was not accepted"}`);
console.log(
  `replay : ${replayShape === null ? "NONE — nothing to claim the pending line" : `content=[${replayShape}]`}` +
    (replayText !== null
      ? `\n         text is ${replayText.trim() === (HEAD + MID + TAIL).trim() ? "the concatenated text blocks" : "NOT a plain concatenation — #claimEcho needs looking at"}`
      : ""),
);
console.log(`saw    : ${seen.length}/7 colours named (${seen.map((c) => c.name).join(", ") || "none"})`);
console.log(`order  : ${inOrder ? "correct — position survived the wire" : "WRONG or incomplete — the two images were not told apart"}`);
console.log(
  seen.length === 7 && inOrder
    ? "\nPASS — interleaved image blocks on stdin reach the model, in order."
    : said.includes("no image")
      ? "\nFAIL — the turn ran and the model was handed no images."
      : "\nINCONCLUSIVE — read the answer above.",
);
