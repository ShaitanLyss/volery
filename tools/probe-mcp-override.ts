/* When a project's `.mcp.json` and Volery's `--mcp-config` both name a server,
 * which one does a card get — and can Volery switch the project's copy off?
 *
 * The MCP pool (`pool.rs`) rests on the answer. RISE's `.mcp.json` starts a
 * ~500 MB `bun` MCP server per card; the pool runs one per territory and hands
 * each card an HTTP entry under the same name instead. That only saves anything
 * if the card then does NOT also start the project's own copy.
 *
 *   bun tools/probe-mcp-override.ts
 *
 * Three arms, each one real turn on Haiku, in a scratch directory whose
 * `.mcp.json` declares server `X` as a stub that writes a marker file when it
 * starts:
 *
 *   A. no flag config               — does a `-p` card start the project's X at all?
 *   B. --mcp-config also names X    — which X starts, and which one is listed?
 *   C. B + `--settings {"disabledMcpjsonServers":["X"]}`
 *                                   — does the setting, in the flag layer, keep
 *                                     the project's copy from starting?
 *
 * Owns `.scratch-<card>/mcp-override/` and deletes only that.
 *
 * ── what it returned, claude 2.1.285, 2026-10-14 ─────────────────────────
 *
 * ```text
 * A. .mcp.json only            X connected, source "project"  project=true  flag=false
 * B. + --mcp-config naming X   X connected, source "dynamic"  project=false flag=true
 * C. B + disabledMcpjsonServers X connected, source "dynamic" project=false flag=true
 * ```
 *
 * **The flag config replaces the project's entry outright**, and the project's
 * copy is never started — B alone is the whole mechanism, so a pooled server
 * costs a card nothing of its own. C adds nothing measurable today; it is kept
 * in `hooks::settings` as a backstop, because the failure it guards is silent
 * and expensive: a CLI that one day started *both* copies would put the 500 MB
 * back on every card with every tool still working.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const CARD = process.env.SKEIN_CARD ?? "probe";
const DIR = `${process.cwd().replace(/\\/g, "/")}/.scratch-${CARD}/mcp-override`;
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

const STUB = `${DIR}/stub.ts`;
writeFileSync(
  STUB,
  `
import { writeFileSync } from "node:fs";
const tag = process.argv[2] ?? "?";
writeFileSync(${JSON.stringify(DIR)} + "/" + tag + ".started", String(process.pid));
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
        capabilities: { tools: {} }, serverInfo: { name: "stub-" + tag, version: "0.0.1" } } });
    else if (m.method === "tools/list")
      out({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "from_" + tag,
        description: "Says which copy this is.", inputSchema: { type: "object", properties: {} } }] } });
    else if (m.id !== undefined) out({ jsonrpc: "2.0", id: m.id, result: {} });
  }
});
`,
);

const BUN = (Bun.which("bun") ?? "bun").replace(/\\/g, "/");
const server = (tag: string) => ({ command: BUN, args: [STUB, tag] });
writeFileSync(`${DIR}/.mcp.json`, JSON.stringify({ mcpServers: { X: server("project") } }));

const CLAUDE = Bun.which("claude") ?? "claude";

async function arm(label: string, extra: string[]) {
  for (const t of ["project", "flag"]) rmSync(`${DIR}/${t}.started`, { force: true });
  const proc = Bun.spawn(
    [
      CLAUDE,
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--model", "claude-haiku-4-5-20251001",
      "--session-id", crypto.randomUUID(),
      ...extra,
    ],
    { cwd: DIR, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  proc.stdin.write(
    JSON.stringify({ type: "user", message: { role: "user", content: "Reply with the single word ok." } }) + "\n",
  );
  proc.stdin.flush();
  let servers = "(no init)";
  let tools: string[] = [];
  const deadline = setTimeout(() => proc.kill(), 120_000);
  outer: for await (const chunk of proc.stdout) {
    for (const line of new TextDecoder().decode(chunk).split("\n")) {
      if (!line.trim()) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "system" && ev.subtype === "init") {
        servers = JSON.stringify((ev.mcp_servers ?? []).filter((s: any) => s.name === "X"));
        tools = (ev.tools ?? []).filter((t: string) => t.startsWith("mcp__X__"));
      }
      if (ev.type === "result") break outer;
    }
  }
  clearTimeout(deadline);
  proc.kill();
  await Bun.sleep(500);
  console.log(`\n── ${label}`);
  console.log(`  init X      : ${servers}`);
  console.log(`  X tools     : ${JSON.stringify(tools)}`);
  console.log(`  started     : project=${existsSync(`${DIR}/project.started`)} flag=${existsSync(`${DIR}/flag.started`)}`);
}

const flagCfg = JSON.stringify({ mcpServers: { X: server("flag") } });
await arm("A. .mcp.json only", []);
await arm("B. .mcp.json + --mcp-config naming X", ["--mcp-config", flagCfg]);
await arm("C. B + disabledMcpjsonServers in --settings", [
  "--mcp-config", flagCfg,
  "--settings", JSON.stringify({ disabledMcpjsonServers: ["X"] }),
]);
rmSync(DIR, { recursive: true, force: true });
