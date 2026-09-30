/**
 * Which refuses a Bash `rm -rf` first: the user's `permissions.deny` rule, or a
 * `PreToolUse` hook? And does the hook even run when the rule matches?
 *
 * `hooks.rs` routes a card's shell delete into `mcp__skein__remove` from the
 * hook (sink b3d1036c). That only works if the hook sees the call. The incident
 * that filed the item came back in the CLI's own words — "Permission to use Bash
 * with command … has been denied." — not in Volery's, which every reason in
 * `hooks.rs` opens with. So either the rule preempts the hook, or the hook ran
 * and the rule's message won. The two want different designs.
 *
 * One variable: the deny rule, on or off. The hook logs every call it sees and
 * denies with a marker, so a run answers both halves — did it fire, and whose
 * words reached the model. A sentinel directory is the ground truth.
 *
 * Run:  bun tools/probe-deny-order.ts
 *       PROBE_TOOLS=Bash bun tools/probe-deny-order.ts   # force the tool list
 *
 * **Inconclusive on 2026-09-30, and why.** Spawned from a card, every run got
 * PowerShell and no Bash — `PROBE_TOOLS=Bash` gave no shell at all — so the
 * ordering question was never asked of a Bash tool. What it did confirm: the
 * hook fires on the PowerShell call with the rule on, and its reason is what
 * reaches the model. Re-run it wherever a card really does get Bash.
 *
 * Two real turns, pinned to Haiku. Its own directory under the card's scratch.
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), `.scratch-${process.env.SKEIN_CARD ?? "probe"}`, "deny-order");
mkdirSync(dir, { recursive: true });

const CLAUDE = join(process.env.USERPROFILE ?? "", ".local", "bin", "claude.exe");
const LOG = join(dir, "hook.log");
const HOOK = join(dir, "hook.mjs");
const TARGET = join(dir, "sentinel").replace(/\\/g, "/");

writeFileSync(
  HOOK,
  `import { appendFileSync } from "node:fs";
let raw = ""; for await (const c of process.stdin) raw += c;
const p = JSON.parse(raw || "{}");
appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ tool: p.tool_name, command: p.tool_input?.command }) + "\\n");
if (p.tool_input?.command) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
  hookEventName: "PreToolUse",
  permissionDecision: "deny",
  permissionDecisionReason: "HOOK-DENIED: the hook refused this call.",
}}));
`,
);

function settings(rule: boolean) {
  const s: Record<string, unknown> = {
    hooks: {
      PreToolUse: [
        { hooks: [{ type: "command", command: process.execPath, args: [HOOK], timeout: 10 }] },
      ],
    },
  };
  if (rule) s.permissions = { deny: ["Bash(rm -rf:*)"] };
  return JSON.stringify(s);
}

function turn(rule: boolean) {
  rmSync(LOG, { force: true });
  mkdirSync(join(dir, "sentinel"), { recursive: true });
  writeFileSync(join(dir, "sentinel", "keep.txt"), "x");
  return new Promise<{ tools: string[]; results: string[] }>((resolve) => {
    const c = spawn(
      CLAUDE,
      [
        "--print",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--model", "haiku",
        ...(process.env.PROBE_TOOLS ? ["--tools", process.env.PROBE_TOOLS] : []),
        "--dangerously-skip-permissions",
        "--settings", settings(rule),
      ],
      { shell: false },
    );
    let buf = "";
    const tools: string[] = [];
    const results: string[] = [];
    c.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev?.type === "system" && ev.subtype === "init") tools.push(...(ev.tools ?? []));
        for (const b of ev?.message?.content ?? []) {
          if (b.type === "tool_result") {
            const t = typeof b.content === "string"
              ? b.content
              : (b.content ?? []).map((x: any) => x.text ?? "").join("");
            results.push(t.slice(0, 160));
          }
        }
        if (ev?.type === "result") {
          c.kill();
          resolve({ tools, results });
        }
      }
    });
    c.on("exit", () => resolve({ tools, results }));
    c.stdin.write(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: `Use the Bash tool (not PowerShell) to run exactly this, once, and then stop: rm -rf ${TARGET}`,
        },
      }) + "\n",
    );
  });
}

for (const rule of [true, false]) {
  const { tools, results } = await turn(rule);
  const fired = existsSync(LOG) ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean) : [];
  const shells = tools.filter((t) => t === "Bash" || t === "PowerShell");
  console.log(`\ndeny rule ${rule ? "ON " : "OFF"} — shell tools: ${shells.join(", ") || "none"}`);
  console.log(`  hook fired on ${fired.filter((f) => f.includes('"command"')).length} shell call(s)`);
  for (const r of results) console.log(`  result: ${r.replace(/\s+/g, " ")}`);
  console.log(`  sentinel ${existsSync(join(dir, "sentinel")) ? "SURVIVED" : "DELETED"}`);
}
rmSync(dir, { recursive: true, force: true });
