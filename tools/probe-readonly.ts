/* Does plan mode let an MCP tool through if it says it only reads?
 *
 * The whole of `ask::reads_only` rests on the answer. Claude Code refuses MCP
 * tools to a planning card, and for the life of both features every
 * `mcp__skein__*` tool was refused — so a planning card could not read the sink
 * it is told to read, could not read the billboard it is told to read *before
 * working in a shared repository*, and could not ask the user a question, while
 * the descriptions telling it to do all three were still in its prompt.
 *
 *   bun tools/probe-readonly.ts
 *
 * Two tools, identical but for one annotation, on a throwaway server — so the
 * answer cannot be a property of anything else. Costs one real turn.
 *
 * Re-run this against a CLI upgrade. If the annotated tool ever starts being
 * blocked, `roster()`'s read-only tier silently stops working and nothing else
 * anywhere would say so: the tools are still *offered* either way, so the
 * failure arrives as a refusal at the moment of use rather than as a tool that
 * is missing.
 *
 * **What this does not establish**, stated because the gap is easy to miss and
 * this file is the evidence somebody will cite: the stub declares no tiering, so
 * both tools arrive loaded, and ten of the sixteen tools `reads_only` marks are
 * *deferred* — reached through `ToolSearch` rather than offered at init
 * (`chronicle`, `claude_status`, `touched`, `recall`, `pinned`, `server_log`,
 * `pipelines`, `reviews`, `tasks`, `records`). The gate almost certainly reads
 * the definition out of `tools/list`, which carries annotations whatever tier a
 * tool is in, and nothing here proves it. Closing it wants a planning card
 * calling a deferred tool against the real server, which is a bigger harness
 * than this — and the failure it would catch is the one the header calls the
 * worst shape: advertised, described, refused at the moment of use.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";

/* Its own named subdirectory under the shared scratch, deleted on the way out
   and only ever this one — see CLAUDE.md on why `.scratch/` is not a place to
   sweep broadly. */
const DIR = `${process.cwd().replace(/\\/g, "/")}/.scratch/probe-readonly`;
mkdirSync(DIR, { recursive: true });

const STUB = `${DIR}/stub.ts`;
const CFG = `${DIR}/mcp.json`;

writeFileSync(STUB, `
const TOOLS = [
  { name: "peek_annotated", description: "Return a fixed string.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true } },
  { name: "peek_bare", description: "Return a fixed string.",
    inputSchema: { type: "object", properties: {} } },
];
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
      out({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text",
        text: m.params?.name + " ran fine." }] } });
    else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
`);

const BUN = (Bun.which("bun") ?? "bun").replace(/\\/g, "/");
writeFileSync(CFG, JSON.stringify({ mcpServers: { stub: { command: BUN, args: [STUB] } } }));

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
  "--permission-mode", "plan",
  "--mcp-config", CFG,
  "--session-id", crypto.randomUUID(),
], { cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "pipe" });

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`.padStart(7);
const names = new Map<string, string>();
const verdict = new Map<string, string>();
let offered: string[] = [];

const done = (code: number) => {
  rmSync(DIR, { recursive: true, force: true });
  proc.kill();
  process.exit(code);
};

(async () => {
  for await (const chunk of proc.stdout) {
    for (const line of new TextDecoder().decode(chunk).split("\n")) {
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }

      if (ev.type === "system" && ev.subtype === "init") {
        offered = (ev.tools ?? []).filter((t: string) => t.includes("stub"));
        console.log(`${at()}  init  mode=${ev.permissionMode}  stub tools offered: ${JSON.stringify(offered)}`);
      }
      for (const b of ev?.message?.content ?? []) {
        if (b.type === "tool_use") names.set(b.id, b.name);
        if (b.type === "tool_result") {
          const t = typeof b.content === "string"
            ? b.content
            : (b.content ?? []).map((c: any) => c.text ?? "").join("");
          const n = names.get(b.tool_use_id) ?? "?";
          if (!n.includes("peek")) continue;
          const blocked = /while in plan mode|Cannot call/i.test(t);
          verdict.set(n, blocked ? "BLOCKED" : "ALLOWED");
          console.log(`${at()}  ${n}: ${blocked ? "BLOCKED" : "ALLOWED"}  ${JSON.stringify(t.slice(0, 110))}`);
        }
      }
      if (ev.type === "result") {
        console.log("\n=== what this run established ===");
        for (const [k, v] of verdict) console.log(`  ${k.padEnd(28)} ${v}`);
        if (verdict.size < 2) {
          console.log("  (the model did not call both — inconclusive, run it again)");
          return done(1);
        }
        /* Both are *offered* either way, which is the part worth printing: the
           annotation changes what happens at the reach, not what the card is
           told it has. So an unannotated read-only tool is worse than an absent
           one — advertised, described, and refused at the moment of use. */
        console.log(`\n  both offered at init ....... ${offered.length === 2}`);
        const good = verdict.get("mcp__stub__peek_annotated") === "ALLOWED"
          && verdict.get("mcp__stub__peek_bare") === "BLOCKED";
        console.log(
          good
            ? "\n`readOnlyHint` is honoured — `ask::reads_only` does what it claims."
            : "\nThe gate has MOVED. `ask::reads_only` no longer buys anything and\n" +
              "every read-only skein tool is refused to a planning card again.",
        );
        return done(good ? 0 : 1);
      }
    }
  }
})();

(async () => {
  for await (const chunk of proc.stderr) {
    process.stderr.write(`[stderr] ${new TextDecoder().decode(chunk)}`);
  }
})();

proc.stdin.write(JSON.stringify({
  type: "user",
  message: {
    role: "user",
    content: "Call both of these tools, one after the other, and tell me exactly what each "
      + "returned: mcp__stub__peek_annotated, then mcp__stub__peek_bare. Do not do anything "
      + "else and do not plan — just call them.",
  },
}) + "\n");
proc.stdin.flush();

setTimeout(() => { console.log("\n[timed out after 180s]"); done(1); }, 180_000);
