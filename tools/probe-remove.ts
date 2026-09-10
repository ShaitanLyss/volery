/**
 * Does the real `claude` binary accept `remove_schema()` and publish the tool?
 *
 * The one silent failure this feature has left, and `.claude/rules/ask.md`
 * records the shape of it from the other side: *"Neither form may be `required`
 * in the schema, or a call using the other one is refused by the client before
 * it reaches us — and a refused ask is an agent that stops asking."* A schema
 * the client will not take produces no error anywhere on this side. The server
 * lists it, every test is green, `tools/list` answers, and no call ever arrives.
 *
 * `remove_schema` has two shapes worth checking for that:
 *
 *   - `paths` is an `anyOf` of `string` and `array` — the same one-or-many form
 *     `touched` uses, but nothing has ever confirmed the CLI takes it on a tool
 *     it is asked to *call* rather than merely list.
 *   - `required: ["paths", "reason"]`, which is the field `ask_user` had to give
 *     up for exactly this reason.
 *
 * Run:  bun tools/probe-remove.ts
 *
 * ### What this proves, and what it does not
 *
 * **It does not run Volery.** There is no MSVC toolchain here, the app does not
 * link, and the MCP server lives inside it — so the tool cannot be exercised
 * from a running wall and nothing below should be read as saying it was.
 *
 * What it does is take `remove_schema()`'s **actual output**, compiled out of
 * `remove.rs` by the same lift machinery `tools/lift-remove.ts` uses, serve it
 * over a loopback HTTP MCP endpoint shaped exactly like `ask::start`'s, and
 * spawn the real binary against it with Skein's own `--mcp-config`. Then it
 * asks three questions of the answer:
 *
 *   1. does `system/init` report the server **connected**;
 *   2. is `mcp__skein__remove` in the card's tool list;
 *   3. does a real call arrive, with both arguments intact and `paths` in
 *      whichever form the model chose.
 *
 * The third is the one that could not be got any other way. Everything up to it
 * is checkable by reading; a `tools/call` landing with its `anyOf` argument
 * whole is not.
 *
 * ### What it deliberately does not do
 *
 * **It never parks and it never deletes.** The server answers the call on the
 * spot with a sentence saying it was a probe, where the real one would put a
 * question on the wall. This measures the wire, not the confirmation — there is
 * no wall here to draw one on.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { blockAt } from "./lift-scan.ts";

const DEPS = "src-tauri/target/x86_64-pc-windows-gnu/debug/deps";
const FILE = "src-tauri/src/remove.rs";
const CLAUDE = join(process.env.USERPROFILE ?? "", ".local", "bin", "claude.exe");

/* ── the schema, out of the source rather than retyped ─────────────────────
 *
 * Retyping it here would make this a probe of a copy, and a copy that drifts is
 * a green probe about a schema nobody ships. Same argument `lift-remove.ts`
 * makes for lifting test bodies verbatim. */

function serdeJsonRlib(): string {
  const names = readdirSync(DEPS);
  const hit = names.filter((n) => /^libserde_json-[0-9a-f]+\.rlib$/.test(n)).sort();
  if (!hit.length) throw new Error(`no libserde_json rlib in ${DEPS} — run tools/check-gnu.sh`);
  return join(DEPS, hit[hit.length - 1]);
}

function schemaFromSource(): unknown {
  const lines = readFileSync(FILE, "utf8").split(/\r?\n/);
  const find = (what: string): string => {
    const re = new RegExp(`^\\s*(pub(\\([a-z]+\\))?\\s+)?${what.replace(/ /g, "\\s+")}\\b`);
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return blockAt(lines, i, FILE);
    throw new Error(`could not find "${what}" in ${FILE} — has it been renamed?`);
  };

  const dir = mkdtempSync(join(tmpdir(), "probe-remove-"));
  const src = join(dir, "schema.rs");
  const exe = join(dir, "schema.exe");
  writeFileSync(
    src,
    [
      "use serde_json::{json, Value};",
      find("const REMOVE_TOOL"),
      find("fn remove_schema"),
      "fn main() { println!(\"{}\", remove_schema()); }",
    ].join("\n\n"),
  );
  const build = spawnSync(
    "rustc",
    ["--edition", "2021", "-A", "dead_code", "--extern", `serde_json=${serdeJsonRlib()}`,
     "-L", `dependency=${DEPS}`, src, "-o", exe],
    { encoding: "utf8", env: { ...process.env, RUSTUP_TOOLCHAIN: "stable-x86_64-pc-windows-gnu" } },
  );
  if (build.status !== 0) {
    console.error(build.stderr || build.stdout);
    throw new Error("could not compile remove_schema out of the source");
  }
  const out = spawnSync(exe, { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return JSON.parse(out.stdout);
}

/* ── a server shaped like ask::start's ─────────────────────────────────────*/

type Landed = { name: string; args: any };
const landed: Landed[] = [];

const schema = schemaFromSource();
console.log(`schema compiled out of ${FILE}: ${JSON.stringify(schema).length} bytes`);

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let rpc: any;
    try {
      rpc = JSON.parse(body || "{}");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const reply = (result: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    };
    if (rpc.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    switch (rpc.method) {
      case "initialize":
        return reply({
          protocolVersion: rpc.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "skein", version: "probe" },
        });
      case "tools/list":
        /* `alwaysLoad` so the tool is in the card's list without a ToolSearch
           step. The real roster defers `remove` behind a hint — that is a
           tiering decision and not a wire question, and forcing it here is what
           makes question 3 answerable in one turn. */
        return reply({
          tools: [{ ...(schema as any), _meta: { "anthropic/alwaysLoad": true } }],
        });
      case "ping":
        return reply({});
      case "tools/call": {
        landed.push({ name: rpc.params?.name, args: rpc.params?.arguments });
        /* Answered on the spot. The real one parks a question on the wall;
           there is no wall here, and parking would only measure this script. */
        return reply({
          content: [{ type: "text", text: "probe: the call arrived. Nothing was deleted." }],
        });
      }
      default:
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0", id: rpc.id,
          error: { code: -32601, message: `no method ${rpc.method}` },
        }));
    }
  });
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as any).port;
console.log(`serving one tool on http://127.0.0.1:${port}/mcp/probe`);

/* ── the real binary, with Skein's own --mcp-config ────────────────────────*/

const argv = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--dangerously-skip-permissions",
  "--mcp-config",
  JSON.stringify({
    mcpServers: {
      skein: { type: "http", url: `http://127.0.0.1:${port}/mcp/probe`, timeout: 120000 },
    },
  }),
];

const ASK =
  `Call the tool mcp__skein__remove once. Pass paths as the single string ` +
  `"C:\\\\tmp\\\\probe\\\\.next" and reason as "probe: checking the wire". ` +
  `Do not call any other tool and do not do anything else. Then stop.`;

type Result = { init: any; tools: string[]; said: string };

const outcome: Result = await new Promise((resolve) => {
  const c = spawn(CLAUDE, argv, { shell: false, cwd: process.cwd() });
  let init: any = null;
  const tools: string[] = [];
  let said = "";
  let buf = "";
  c.stdout.on("data", (d) => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev?.type === "system" && ev?.subtype === "init") init = ev;
      for (const b of ev?.message?.content ?? []) {
        if (b.type === "tool_use") tools.push(b.name);
        if (b.type === "text") said += b.text;
      }
      if (ev?.type === "result") { c.kill(); resolve({ init, tools, said }); }
    }
  });
  c.stderr.on("data", (d) => process.stderr.write(`[probe-remove] ${d}`));
  c.on("exit", () => resolve({ init, tools, said }));
  c.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: ASK } }) + "\n");
});

server.close();

/* ── the three questions ───────────────────────────────────────────────────*/

const servers = outcome.init?.mcp_servers ?? [];
const ours = servers.find((s: any) => s.name === "skein");
const listed = (outcome.init?.tools ?? []).filter((t: string) => t.includes("remove"));

console.log(`\n1. system/init says the server is: ${ours ? ours.status : "(not mentioned at all)"}`);
console.log(`2. remove in the card's tool list: ${listed.length ? listed.join(", ") : "NO"}`);
console.log(`3. calls that landed: ${landed.length}`);
for (const l of landed) {
  console.log(`     name  : ${l.name}`);
  console.log(`     args  : ${JSON.stringify(l.args)}`);
}
console.log(`\nthe card said: ${outcome.said.trim().slice(0, 500)}`);

const call = landed[0];
const ok =
  ours?.status === "connected" &&
  listed.length > 0 &&
  !!call &&
  typeof call.args?.reason === "string" &&
  (typeof call.args?.paths === "string" || Array.isArray(call.args?.paths));

console.log(`\n${"=".repeat(64)}`);
console.log(
  ok
    ? "The CLI takes this schema: the server connects, the tool is published, and a\n" +
      "real call arrives with both arguments intact. The `anyOf` on `paths` and the\n" +
      "two `required` fields are not refused before reaching us."
    : "SOMETHING DID NOT HOLD — read the three answers above rather than trusting this line.",
);
process.exit(ok ? 0 : 1);

/* ── measured 2026-09-10, claude 2.1.241 ─────────────────────────────────────
 *
 *   schema compiled out of src-tauri/src/remove.rs: 2332 bytes
 *
 *   1. system/init says the server is: connected
 *   2. remove in the card's tool list: mcp__skein__remove
 *   3. calls that landed: 1
 *        name  : remove
 *        args  : {"paths":"C:\\tmp\\probe\\.next","reason":"probe: checking the wire"}
 *
 * All three hold. The `anyOf` on `paths` survives — the model chose the string
 * form and it arrived as a string — and neither `required` field is refused
 * before the call reaches us, which was the failure `ask.md` had already paid
 * for once from the other direction.
 *
 * **The line worth reading twice is `name : remove`.** What arrives in
 * `params.name` is the *bare* name; the `mcp__skein__` prefix is the client's,
 * added for the card's tool list and stripped before the call goes out. The
 * first cut of `remove.rs` declared `REMOVE_TOOL` as the prefixed form, which
 * would have made `ask.rs`'s dispatch arm match nothing at all — the tool
 * listing correctly, the schema right, and no call ever arriving. Caught by
 * `test/classify.test.ts` before this ran; confirmed here by the wire.
 */
