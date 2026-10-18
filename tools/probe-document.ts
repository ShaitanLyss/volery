/* Does a PDF on stdin, as a `document` content block, reach the model?
 *
 * A chat card has no filesystem (`chat.md`): it cannot be handed a path and
 * told to read it. The API reads PDFs natively as a `document` block, so a
 * PDF attached to a prompt for a chat card goes inline, beside the text, the
 * way a picture does. `probe-image.ts` proved the `image` block on this path;
 * this proves the `document` one, with the chat card's own argv (`--tools
 * WebSearch,WebFetch`, no bypass), so the answer cannot have come from a Read.
 *
 *   bun tools/probe-document.ts
 *
 * The PDF is generated and carries a code word found nowhere else. One real
 * turn, pinned to Haiku.
 */

import { mkdirSync, rmSync } from "node:fs";

const DIR = `${process.cwd().replace(/\\/g, "/")}/.scratch/probe-document`;
mkdirSync(DIR, { recursive: true });

const WORD = "OSPREY-2286";
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

const CLAUDE = Bun.which("claude") ?? "claude";
const proc = Bun.spawn([
  CLAUDE,
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--tools", "WebSearch,WebFetch",
  "--model", "haiku",
  "--session-id", crypto.randomUUID(),
], { cwd: DIR, stdin: "pipe", stdout: "pipe", stderr: "pipe" });

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`.padStart(7);
let answer = "";
let replay = "";

const finish = async (code: number) => {
  proc.kill();
  await proc.exited;
  rmSync(DIR, { recursive: true, force: true });
  const named = answer.toUpperCase().includes(WORD);
  console.log("\n--- verdict -------------------------------------------------");
  console.log(`replay : content=[${replay}]`);
  console.log(named
    ? `PASS — the code word came back: a document block on stdin reaches the model.`
    : `FAIL — the code word did not come back. Answer: ${JSON.stringify(answer.slice(0, 200))}`);
  process.exit(named ? code : 1);
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
      if (ev.type === "system" && ev.subtype === "init") console.log(at(), `← init model=${ev.model} tools=${JSON.stringify(ev.tools)}`);
      if (ev.type === "user") {
        const c = ev.message?.content;
        replay = Array.isArray(c) ? c.map((b: any) => b?.type).join("+") : typeof c;
        console.log(at(), `← USER REPLAY content=[${replay}]`);
      }
      if (ev.type === "assistant") {
        const t = (ev.message?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
        if (t.trim()) { answer = t; console.log(at(), "← assistant:", JSON.stringify(t.trim().slice(0, 200))); }
      }
      if (ev.type === "result") {
        console.log(at(), `← result subtype=${ev.subtype} turns=${ev.num_turns}`);
        return finish(0);
      }
    }
  }
})();

proc.stdin.write(JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: [
      { type: "text", text: "Here is a document: " },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(pdf(WORD)).toString("base64") } },
      { type: "text", text: " What is the code word in it? Answer with the code word alone, or NO DOCUMENT if none reached you." },
    ],
  },
}) + "\n");
proc.stdin.flush();

setTimeout(() => { console.log("\n[timed out after 120s]"); void finish(1); }, 120_000);
