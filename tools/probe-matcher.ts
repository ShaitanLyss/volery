/* Can a `PreToolUse` matcher narrow the hook without the narrowing rotting?
 *
 * `hooks::settings` registers against **everything**, and `.claude/rules/hooks.md`
 * gives the argument: a matcher is a tool name written into configuration where
 * no test can reach it, and when `"Bash"` silently stopped matching `PowerShell`
 * every hook in the module was a no-op for an unknowable number of versions.
 * The cost was accepted as "a ~5ms process per tool call".
 *
 * **That premise is false.** Measured 2026-10-02 on this machine: the hook costs
 * ~350-800ms wall and 38.5MB peak working set per invocation, against 14.3MB for
 * `cmd /c exit` — and it fires on every tool call of every card, `ToolSearch`
 * and `Read` included. Ten cards at that rate is most of why tools feel slow.
 *
 * So the question is not "matcher or no matcher" but whether a matcher can be
 * written so that **rot costs milliseconds rather than correctness**. A negative
 * one does, and it is what the rule itself asks for when it says to "arrange for
 * the broad case to be the default and narrow inside your own code":
 *
 *     ^(?!(Read|Edit|Write|...)$).*$
 *
 * A tool that is renamed, or one that is new, is *not* in the exclusion list and
 * therefore still fires — so the shell guards and the backslash compensator
 * cannot be switched off by somebody else's rename. Only a tool explicitly named
 * here is skipped, and every name here is one that provably carries no
 * `tool_input.command` and is not `mcp__browser__*`.
 *
 *   bun tools/probe-matcher.ts
 *
 * Two real turns, pinned to Haiku. The first is the control: with no matcher,
 * `Read` must appear — otherwise the probe cannot tell a working narrowing from
 * a matcher that broke outright, which is the failure mode that matters.
 *
 * ── what it returned, 2026-10-02, claude 2.1.241 ──────────────────────────
 *
 * ```text
 * matcher under test:
 *   ^(?!(Read|Edit|Write|NotebookEdit|Glob|Grep|TodoWrite|Task|ToolSearch|WebFetch|WebSearch|ExitPlanMode)$).*$
 *
 * ── control: no matcher ──
 *   tools the hook saw   Read, Bash
 *   Read fired           yes
 *   shell fired          yes
 *
 * ── narrowed: negative lookahead ──
 *   tools the hook saw   Bash
 *   Read fired           no
 *   shell fired          yes
 * ```
 *
 * So the CLI tests the matcher as a JS regex, negative lookahead and all, and
 * the narrowing does what it says: the shell tool still reaches the hook, `Read`
 * no longer does. The control is the half that makes that worth anything — it
 * proves the turn exercised both tools, so "narrowed saw only Bash" cannot be a
 * matcher that quietly matched nothing.
 *
 * Note the shell tool is `Bash` here. This probe spawns `claude` directly rather
 * than through `supervisor.rs`, and `hooks.md` records that both `Bash` and
 * `PowerShell` are live on this machine at once — which is exactly why the
 * matcher must not be a positive list of shell names.
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const CARD = process.env.SKEIN_CARD ?? "probe";
const dir = join(process.cwd(), `.scratch-${CARD}`, "matcher");
mkdirSync(dir, { recursive: true });

const CLAUDE = join(process.env.USERPROFILE ?? "", ".local", "bin", "claude.exe");
const LOG = join(dir, "fired.log");
const HOOK = join(dir, "hook.mjs");
const SUBJECT = join(dir, "subject.txt");

/* Taken out of `hooks.rs` rather than written here, which is the lift pattern
   this repo uses for the same reason everywhere else: a list written down twice
   is a list that drifts, and the copy nobody runs is the one that rots. If this
   extraction stops finding the const, that is a failure worth stopping for —
   silently probing a *different* matcher than the one shipped is the one result
   this probe must never produce. */
const HOOKS_RS = join(process.cwd(), "src-tauri", "src", "hooks.rs");
const block = readFileSync(HOOKS_RS, "utf8").match(
  /pub const UNHOOKED_TOOLS: &\[&str\] = &\[([\s\S]*?)\];/,
);
if (!block) {
  console.error(
    `probe-matcher: could not find UNHOOKED_TOOLS in ${HOOKS_RS}.\n` +
      `  The const was renamed or reshaped. Fix this extraction rather than\n` +
      `  inlining the list here — see the note above.`,
  );
  process.exit(1);
}
const EXCLUDE = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
if (EXCLUDE.length === 0) {
  console.error("probe-matcher: UNHOOKED_TOOLS parsed as empty — refusing to probe nothing.");
  process.exit(1);
}

/* Anchored at both ends, exactly as `hooks::unhooked_matcher` builds it. An
   unanchored negative lookahead silently fails open: `.test()` retries at every
   offset, so `(?!(Read)$).*` matches "Read" from position 1. */
const MATCHER = `^(?!(${EXCLUDE.join("|")})$).*$`;

writeFileSync(SUBJECT, "volery probe subject file\n");

/* Logs the name of every tool it is consulted about, and says nothing — so the
   call proceeds unchanged and the turn is a normal one. */
writeFileSync(
  HOOK,
  `import { appendFileSync } from "node:fs";
let raw = ""; for await (const c of process.stdin) raw += c;
const p = JSON.parse(raw || "{}");
appendFileSync(${JSON.stringify(LOG)}, (p.tool_name ?? "?") + "\\n");
`,
);

function settings(matcher: string | null) {
  const entry = { hooks: [{ type: "command", command: process.execPath, args: [HOOK], timeout: 30 }] };
  return JSON.stringify({
    hooks: { PreToolUse: [matcher === null ? entry : { matcher, ...entry }] },
  });
}

function turn(matcher: string | null): Promise<string[]> {
  rmSync(LOG, { force: true });
  return new Promise((resolve) => {
    const c = spawn(
      CLAUDE,
      [
        "--print",
        "--output-format", "stream-json",
        "--verbose",
        "--model", "haiku",
        "--dangerously-skip-permissions",
        "--settings", settings(matcher),
      ],
      { shell: false },
    );
    c.stdin.write(
      `Do exactly two things, no commentary: (1) read the file ${SUBJECT} with the Read tool, ` +
        `(2) run the shell command \`echo volery-probe\`. Then stop.`,
    );
    c.stdin.end();
    c.stdout.resume();
    c.stderr.resume();
    c.on("close", () => {
      const seen = existsSync(LOG)
        ? readFileSync(LOG, "utf8").split("\n").filter(Boolean)
        : [];
      resolve(seen);
    });
  });
}

const shellish = (t: string) => t === "Bash" || t === "PowerShell";

console.log(`matcher under test:\n  ${MATCHER}\n`);

const control = await turn(null);
console.log("── control: no matcher ──");
console.log(`  tools the hook saw   ${[...new Set(control)].join(", ") || "(none)"}`);
const controlRead = control.includes("Read");
const controlShell = control.some(shellish);
console.log(`  Read fired           ${controlRead ? "yes" : "NO — control is broken"}`);
console.log(`  shell fired          ${controlShell ? "yes" : "NO — control is broken"}`);

const narrowed = await turn(MATCHER);
console.log("\n── narrowed: negative lookahead ──");
console.log(`  tools the hook saw   ${[...new Set(narrowed)].join(", ") || "(none)"}`);
const narrowedRead = narrowed.includes("Read");
const narrowedShell = narrowed.some(shellish);
console.log(`  Read fired           ${narrowedRead ? "yes — NOT narrowed" : "no"}`);
console.log(`  shell fired          ${narrowedShell ? "yes" : "NO — matcher is broken"}`);

const ok = controlRead && controlShell && !narrowedRead && narrowedShell;
console.log(
  `\nverdict: ${
    ok
      ? "the narrowing holds — the shell tool still fires, Read no longer does."
      : "DO NOT SHIP. Either the control did not exercise both tools, or the matcher " +
        "did not behave as a JS regex. A matcher that fires for nothing is the exact " +
        "silent failure hooks.md was written about."
  }`,
);
process.exit(ok ? 0 : 1);
