/* Does a `PreToolUse` hook see an **MCP** tool call, and can it hold one up?
 *
 * `probe-deny.ts` answered this for the shell tool and for `deny`. The lazy
 * browser rests on two further claims that nothing in this repo had measured:
 *
 *   1. The hook fires for a tool served by an MCP server — and `tool_name` is
 *      the prefixed name (`mcp__<server>__<tool>`), which is what a router in
 *      `hooks::reply` would have to key on.
 *   2. **The CLI waits for the hook before running the tool.** That is the
 *      whole mechanism: a hook that takes two seconds to start Chrome and then
 *      says nothing turns a call that would have hit ECONNREFUSED into one that
 *      connects. Measured as an *ordering* — the stub server records when the
 *      tool actually ran, the hook records when it was entered and when it
 *      returned — because a hook the CLI ran concurrently would still "fire"
 *      and would still look fine in a log.
 *   3. And that `deny` reaches an MCP call too, since that is the channel the
 *      failure has to come back on.
 *
 *   bun tools/probe-mcp-hook.ts
 *
 * Two real turns against a stub MCP server with one tool. Pinned to Haiku, so
 * it is a fraction of a cent.
 *
 * ── what it returned, 2026-09-19 ──────────────────────────────────────────
 *
 * ```text
 * hook fired            yes
 * tool_name it saw      mcp__stub__ping
 * hook_event_name       PreToolUse
 * hook held for         1522ms  (asked for 1500)
 * tool ran              69ms AFTER the hook returned
 *   +0ms     hook-entered  ToolSearch
 *   +1522ms  hook-returned ToolSearch
 *   +3110ms  hook-entered  mcp__stub__ping
 *   +4628ms  hook-returned mcp__stub__ping
 *   +4697ms  tool-ran      ping
 *
 * deny arm:  tool ran anyway  no      reason reached model  true
 * ```
 *
 * All three hold, and the middle one is the mechanism. **The CLI waits**: the
 * stub server did not see the call until 69ms after a hook that had held for a
 * second and a half returned. So a hook can put a browser up in front of a call
 * that is about to need one, which is the whole of `hooks::wake_browser`.
 *
 * `tool_name` is the prefixed name, so a router keys on `mcp__<server>__` —
 * `hooks::wakes_browser` does, and `lift-browser.ts` holds that prefix to the
 * server `ask::mcp_config` actually registers.
 *
 * And `deny` reaches an MCP call exactly as it reaches a shell one (which
 * `probe-deny.ts` had already established), so a browser that cannot be started
 * is reported in Volery's own words rather than as playwright's `ECONNREFUSED`.
 *
 * One thing nobody asked for and everybody should know: **`ToolSearch` goes
 * through the hook too**, and it is the first thing a turn does. Anything added
 * to `reply` pays for itself there before the model has called a single real
 * tool, which is the argument for the browser arm being one string comparison.
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CARD = process.env.SKEIN_CARD ?? "probe";
const dir = join(process.cwd(), `.scratch-${CARD}`, "mcp-hook");
mkdirSync(dir, { recursive: true });

const CLAUDE = join(process.env.USERPROFILE ?? "", ".local", "bin", "claude.exe");
const LOG = join(dir, "events.log");
const HOOK = join(dir, "hook.mjs");
const STUB = join(dir, "stub-server.mjs");

/** How long the hook pretends to be starting a browser. Long enough that a
 *  concurrent run would interleave visibly rather than by a millisecond. */
const HOLD_MS = 1500;

/* A stdio MCP server with one tool, which records the moment it is called. */
writeFileSync(
  STUB,
  `import { appendFileSync } from "node:fs";
const log = (o) => appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ t: Date.now(), ...o }) + "\\n");
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === "initialize") {
      send({ jsonrpc: "2.0", id: m.id, result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "stub", version: "0" },
      }});
    } else if (m.method === "tools/list") {
      send({ jsonrpc: "2.0", id: m.id, result: { tools: [{
        name: "ping",
        description: "Reply with PROBE-PONG. Call this when asked to ping.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }]}});
    } else if (m.method === "tools/call") {
      log({ what: "tool-ran", name: m.params?.name });
      send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "PROBE-PONG" }] } });
    } else if (m.id !== undefined) {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
    }
  }
});
`,
);

function writeHook(mode: "hold" | "deny") {
  writeFileSync(
    HOOK,
    `import { appendFileSync } from "node:fs";
const log = (o) => appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ t: Date.now(), ...o }) + "\\n");
let raw = ""; for await (const c of process.stdin) raw += c;
const p = JSON.parse(raw || "{}");
log({ what: "hook-entered", tool: p.tool_name, event: p.hook_event_name });
${
  mode === "hold"
    ? `await new Promise((r) => setTimeout(r, ${HOLD_MS}));
log({ what: "hook-returned", tool: p.tool_name });
/* Say nothing: the call proceeds unchanged. */`
    : `log({ what: "hook-returned", tool: p.tool_name });
process.stdout.write(JSON.stringify({ hookSpecificOutput: {
  hookEventName: "PreToolUse",
  permissionDecision: "deny",
  permissionDecisionReason: "PROBE-DENIED: the shared browser could not be started.",
}}));`
}
`,
  );
}

type Ev = { t: number; what: string; tool?: string; name?: string; event?: string };

function settings() {
  /* No matcher, exactly as `hooks::settings` registers its own — a matcher is a
     tool name written into configuration where no test can reach it. */
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        { hooks: [{ type: "command", command: process.execPath, args: [HOOK], timeout: 30 }] },
      ],
    },
  });
}

function mcpConfig() {
  return JSON.stringify({
    mcpServers: { stub: { command: process.execPath, args: [STUB] } },
  });
}

function turn(label: string, prompt: string) {
  rmSync(LOG, { force: true });
  return new Promise<{ events: Ev[]; denied: boolean; said: string }>((resolve) => {
    const c = spawn(
      CLAUDE,
      [
        "--print",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--model", "haiku",
        "--dangerously-skip-permissions",
        "--mcp-config", mcpConfig(),
        "--strict-mcp-config",
        "--settings", settings(),
      ],
      { shell: false },
    );

    let denied = false;
    let said = "";
    let buf = "";
    c.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        for (const b of ev?.message?.content ?? []) {
          if (b.type === "tool_result") {
            const t =
              typeof b.content === "string"
                ? b.content
                : (b.content ?? []).map((x: any) => x.text ?? "").join("");
            if (t.includes("PROBE-DENIED")) denied = true;
            said += t;
          }
        }
        if (ev?.type === "result") {
          const events: Ev[] = existsSync(LOG)
            ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
            : [];
          c.kill();
          resolve({ events, denied, said });
        }
      }
    });
    c.stderr.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
    c.on("exit", () => resolve({ events: [], denied, said }));

    c.stdin.write(
      JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n",
    );
  });
}

const ASK = "Call the ping tool once, then reply with just what it said. Do nothing else.";

console.log("1 & 2. does the hook fire for an MCP tool, and does the CLI WAIT for it?\n");
writeHook("hold");
{
  const { events } = await turn("hold", ASK);
  const entered = events.find((e) => e.what === "hook-entered");
  const returned = events.find((e) => e.what === "hook-returned");
  const ran = events.find((e) => e.what === "tool-ran");
  console.log(`   hook fired          : ${entered ? "yes" : "no"}`);
  console.log(`   tool_name it saw    : ${entered?.tool ?? "—"}`);
  console.log(`   hook_event_name     : ${entered?.event ?? "—"}`);
  if (entered && returned && ran) {
    const held = returned.t - entered.t;
    const after = ran.t - returned.t;
    console.log(`   hook held for       : ${held}ms (asked for ${HOLD_MS})`);
    console.log(`   tool ran            : ${after}ms AFTER the hook returned`);
    console.log(
      `   => the CLI ${after >= -50 && ran.t >= returned.t ? "WAITS for the hook" : "ran the tool CONCURRENTLY"}`,
    );
  } else if (entered && !ran) {
    console.log("   tool never ran      : the hold swallowed the call");
  }
  for (const e of events) console.log(`     · +${e.t - events[0]!.t}ms ${e.what} ${e.tool ?? e.name ?? ""}`);
}

console.log("\n3. does `deny` stop an MCP tool call, and does the reason reach the model?\n");
writeHook("deny");
{
  const { events, denied } = await turn("deny", ASK);
  const ran = events.some((e) => e.what === "tool-ran");
  console.log(`   hook fired          : ${events.some((e) => e.what === "hook-entered") ? "yes" : "no"}`);
  console.log(`   tool ran anyway     : ${ran ? "YES — deny does not bite" : "no"}`);
  console.log(`   reason reached model: ${denied}`);
}
