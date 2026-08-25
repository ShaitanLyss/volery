/**
 * What a `PreToolUse` hook can actually do, on the CLI that is installed now.
 *
 * Three questions, and `hooks.rs` depends on all three. Re-run it when the CLI
 * updates, or when the compensator seems to have stopped working — the failure
 * mode this probe exists for is *silence*, so nothing else will tell you.
 *
 *   1. Which `matcher` spellings fire, and what the shell tool is called.
 *      Measured 2026-08-25 on claude 2.1.241: `matcher: "Bash"` fires on
 *      NOTHING, because the tool is named `PowerShell`. That is how the hook
 *      module spent an unknown number of versions as a silent no-op.
 *
 *   2. Does `permissionDecision: "deny"` stop a call on a card spawned with
 *      `--dangerously-skip-permissions`? The shared-index guard is a refusal,
 *      so if this ever comes back `false` the guard has to become a warning
 *      instead. Measured 2026-08-25: yes, and the reason reaches the model.
 *
 *   3. Does the shell tool halve runs of backslashes? This is the deletion
 *      condition for `compensate` — and note it is per *tool*: the Bash tool
 *      does, the PowerShell tool does not, so compensating the wrong one adds
 *      backslashes rather than restoring them.
 *
 * Run:  bun tools/probe-deny.ts
 *
 * Spawns real turns against the real binary with Skein's argv shape, one
 * variable at a time. A few cents.
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), ".scratch");
mkdirSync(dir, { recursive: true });

/* Spawned with no shell, exactly as `supervisor.rs` does. With `shell: true` the
   settings JSON goes through cmd.exe quoting and comes back as
   "Invalid JSON provided to --settings" — measured, and a confusing hour. */
const CLAUDE = join(process.env.USERPROFILE ?? "", ".local", "bin", "claude.exe");
const LOG = join(dir, "probe-deny.log");
const HOOK = join(dir, "probe-deny-hook.mjs");

writeFileSync(
  HOOK,
  `import { appendFileSync } from "node:fs";
let raw = ""; for await (const c of process.stdin) raw += c;
const p = JSON.parse(raw || "{}");
appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ tool: p.tool_name, command: p.tool_input?.command }) + "\\n");
process.stdout.write(JSON.stringify({ hookSpecificOutput: {
  hookEventName: "PreToolUse",
  permissionDecision: "deny",
  permissionDecisionReason: "PROBE-DENIED: the hook refused this call.",
}}));
`,
);

type Fired = { tool?: string; command?: string };

function settings(matcher: string | null) {
  const entry: Record<string, unknown> = {
    hooks: [{ type: "command", command: process.execPath, args: [HOOK], timeout: 10 }],
  };
  if (matcher !== null) entry.matcher = matcher;
  return JSON.stringify({ hooks: { PreToolUse: [entry] } });
}

function turn(label: string, matcher: string | null, prompt: string) {
  rmSync(LOG, { force: true });
  return new Promise<{ fired: Fired[]; denied: boolean; emitted: string }>((resolve) => {
    const c = spawn(
      CLAUDE,
      [
        "--print",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--settings", settings(matcher),
      ],
      { shell: false },
    );

    let denied = false;
    let emitted = "";
    let buf = "";

    c.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        for (const b of ev?.message?.content ?? []) {
          if (b.type === "tool_use" && b.input?.command) emitted = b.input.command;
          if (b.type === "tool_result") {
            const t = typeof b.content === "string"
              ? b.content
              : (b.content ?? []).map((x: any) => x.text ?? "").join("");
            if (t.includes("PROBE-DENIED")) denied = true;
          }
        }
        if (ev?.type === "result") {
          const fired: Fired[] = existsSync(LOG)
            ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
            : [];
          c.kill();
          resolve({ fired, denied, emitted });
        }
      }
    });
    c.stderr.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
    c.on("exit", () => resolve({ fired: [], denied, emitted }));

    c.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
  });
}

const RUN = "Use the shell tool to run exactly: echo PROBE-OK";

console.log("1. which matcher fires, and what the shell tool is called");
console.log("   (the `denied` column is question 2: a refusal that reached the model)\n");
for (const m of ["Bash", "PowerShell", ".*", "", null]) {
  const { fired, denied } = await turn(String(m), m, RUN);
  const shell = fired.find((f) => f.command);
  console.log(
    `   matcher ${JSON.stringify(m).padEnd(14)} fired=${fired.length ? "yes" : "no "}` +
      `  tool=${(shell?.tool ?? "—").padEnd(12)} denied=${denied}`,
  );
}

console.log("\n3. does this shell tool halve runs of backslashes?\n");
const SLASHES = String.raw`echo 'a1\\b2\\\\c3\\\\\\d4\\\\\\\\e'`;
const { fired, emitted } = await turn(
  "slashes",
  null,
  `Run this with the shell tool, exactly as written, no changes:\n\n${SLASHES}`,
);
const arrived = fired.find((f) => f.command)?.command ?? "";
console.log(`   emitted  ${JSON.stringify(emitted)}`);
console.log(`   arrived  ${JSON.stringify(arrived)}`);
console.log(
  `\n   ${
    emitted === arrived
      ? "IDENTICAL — this tool has no collapse. Compensating it would ADD backslashes."
      : "DIFFERENT — this tool eats backslashes; `compensate` is still needed for it."
  }`,
);
