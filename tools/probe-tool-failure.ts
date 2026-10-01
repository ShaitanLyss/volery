/* When an **MCP** tool call fails, which hook hears it — and can that hook add a
 * word the model reads?
 *
 * Sink e7431978: the shared browser's `@playwright/mcp` answered every call with
 * `TimeoutError: async initializeServer: Timeout 30000ms exceeded.` and nothing
 * else, because one tab in the shared Chrome would not initialise and playwright
 * waits on all of them. The *why* is something Volery can find out (it can
 * talk to the same Chrome), but only after the failure, and the user ruled out
 * paying for it before every successful call. So the question is whether a
 * post-call hook is a channel at all:
 *
 *   1. Does an MCP result carrying `isError: true` fire `PostToolUse`,
 *      `PostToolUseFailure`, or neither? (`gates.md` already records that
 *      `PostToolUse` cannot see a *shell* failure; MCP is a different path.)
 *   2. What does the payload carry — is playwright's error text in it, and
 *      under which key? That is what a router would have to match on.
 *   3. Does `hookSpecificOutput.additionalContext` from that hook reach the
 *      model? Measured by a code word the model can only know from there.
 *
 *   bun tools/probe-tool-failure.ts
 *
 * One real turn against a stub MCP server, pinned to Haiku.
 *
 * ── what it returned, 2026-10-01, claude 2.1.285 ──────────────────────────
 *
 * ```text
 * PostToolUse          fired: no
 * PostToolUseFailure   fired: yes
 *   payload keys      : session_id, transcript_path, cwd, prompt_id, permission_mode,
 *                       hook_event_name, tool_name, tool_input, tool_use_id, error,
 *                       is_interrupt, duration_ms, mcp_server
 *   carries the error : true   (verbatim, under `error`)
 * model said          : HERON-FAILURE
 * ```
 *
 * All three hold. An MCP `isError` result is a *failure* to the CLI, so it is
 * `PostToolUseFailure` alone that hears it — which is also why that hook can be
 * registered with no matcher for nothing: it never runs on a call that worked.
 * `error` is the server's text exactly, so `hooks::diagnoses_browser` matches
 * playwright's own words; and `additionalContext` reaches the model, which is
 * the whole channel `hooks::browser_failure` speaks on.
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CARD = process.env.SKEIN_CARD ?? "probe";
const dir = join(process.cwd(), `.scratch-${CARD}`, "tool-failure");
mkdirSync(dir, { recursive: true });

const CLAUDE = join(process.env.USERPROFILE ?? "", ".local", "bin", "claude.exe");
const LOG = join(dir, "events.log");
const HOOK = join(dir, "hook.mjs");
const STUB = join(dir, "stub-server.mjs");

/** Exactly what playwright said on the night, so a match written against this
 *  payload is a match against the real thing. */
const PLAYWRIGHT_ERROR =
  "### Error\nTimeoutError: async initializeServer: Timeout 30000ms exceeded.\n" +
  "  - <ws preparing> retrieving websocket url from http://127.0.0.1:9222\n" +
  "  - <ws connecting> ws://127.0.0.1:9222/devtools/browser/1b5a9636\n" +
  "  - <ws connected> ws://127.0.0.1:9222/devtools/browser/1b5a9636";

writeFileSync(
  STUB,
  `const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
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
        name: "tabs",
        description: "List browser tabs. Call this when asked to list tabs.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }]}});
    } else if (m.method === "tools/call") {
      send({ jsonrpc: "2.0", id: m.id, result: {
        content: [{ type: "text", text: ${JSON.stringify(PLAYWRIGHT_ERROR)} }],
        isError: true,
      }});
    } else if (m.id !== undefined) {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
    }
  }
});
`,
);

/* Logs the whole payload, and answers each event with its own code word so the
   model's reply says which one (if either) got through. */
writeFileSync(
  HOOK,
  `import { appendFileSync } from "node:fs";
let raw = ""; for await (const c of process.stdin) raw += c;
const p = JSON.parse(raw || "{}");
appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ t: Date.now(), payload: p }) + "\\n");
const ev = p.hook_event_name;
if ((ev === "PostToolUse" || ev === "PostToolUseFailure") && String(p.tool_name).startsWith("mcp__stub__")) {
  const word = ev === "PostToolUse" ? "HERON-POST" : "HERON-FAILURE";
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: ev,
    additionalContext: "volery: the code word is " + word + ".",
  }}));
}
`,
);

function settings() {
  const entry = [{ hooks: [{ type: "command", command: process.execPath, args: [HOOK], timeout: 30 }] }];
  return JSON.stringify({ hooks: { PostToolUse: entry, PostToolUseFailure: entry } });
}

const mcpConfig = JSON.stringify({ mcpServers: { stub: { command: process.execPath, args: [STUB] } } });

rmSync(LOG, { force: true });
const said = await new Promise<string>((resolve) => {
  const c = spawn(
    CLAUDE,
    [
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--model", "haiku",
      "--dangerously-skip-permissions",
      "--mcp-config", mcpConfig,
      "--strict-mcp-config",
      "--settings", settings(),
    ],
    { shell: false },
  );
  let buf = "";
  c.stdout.on("data", (d) => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev?.type === "result") {
        c.kill();
        resolve(String(ev.result ?? ""));
      }
    }
  });
  c.stderr.on("data", (d) => process.stderr.write(`[claude] ${d}`));
  c.on("exit", () => resolve(""));
  c.stdin.write(
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content:
          "Call the tabs tool exactly once. Then reply with two lines: first, the code word you " +
          "were given after the call if any (or NONE); second, the first line of the tool's output.",
      },
    }) + "\n",
  );
});

const events: { payload: any }[] = existsSync(LOG)
  ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];

for (const name of ["PostToolUse", "PostToolUseFailure"]) {
  const hit = events.find((e) => e.payload.hook_event_name === name && String(e.payload.tool_name).startsWith("mcp__stub__"));
  console.log(`${name.padEnd(20)} fired: ${hit ? "yes" : "no"}`);
  if (hit) {
    const { session_id, transcript_path, cwd, ...rest } = hit.payload;
    console.log(`  payload keys      : ${Object.keys(hit.payload).join(", ")}`);
    console.log(`  payload (trimmed) : ${JSON.stringify(rest).slice(0, 900)}`);
    console.log(`  carries the error : ${JSON.stringify(hit.payload).includes("initializeServer")}`);
  }
}
console.log(`\nmodel said:\n${said}`);
console.log(`\nadditionalContext reached the model: ${/HERON-(POST|FAILURE)/.test(said) ? said.match(/HERON-(POST|FAILURE)/)![0] : "no"}`);
