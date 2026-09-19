/* Actually run the browser-wake assertions on a machine with no MSVC.
 *
 *     bun tools/lift-browser.ts
 *
 * `cargo test` cannot link here (`.claude/rules/build.md`), and
 * `bash tools/check-gnu.sh --profile test` typechecks these without running one
 * of them — which reads exactly like a green test run and is not one.
 *
 * ### Why this earns a lift
 *
 * Every card on this wall now spawns holding `mcp__browser__*`, whether or not
 * a Chrome exists, and the thing that makes that true rather than cruel is a
 * `PreToolUse` hook standing in front of the first call to start one. **Three
 * of the four decisions in that path fail silently**, which is the whole
 * argument:
 *
 * - **`wakes_browser` too narrow** and a browser tool wakes nothing. The card
 *   gets playwright's `ECONNREFUSED` on a port it has never heard of, which is
 *   sink `b6bfecba`'s symptom exactly — a capability that is there, does not
 *   work, and cannot say why. Too wide and every `Read` on every card pays a
 *   loopback round trip first.
 * - **`BROWSER_PREFIX` out of step with the server `ask::mcp_config`
 *   registers** and the hook waits for a name nothing produces. Nothing errors.
 *   It is the matcher-that-stopped-matching (`hooks.md`) with the two halves in
 *   different files.
 * - **The `PreToolUse` timeout under `WAKE_TIMEOUT`** and the CLI kills the
 *   hook mid-wait. A killed hook prints nothing, and printing nothing is how
 *   this module says *allow* — so the tool runs against a browser that is still
 *   starting and the refusal that would have explained it is discarded unread.
 *   A ceiling that is wrong in the permissive direction, which is the shape
 *   this codebase refuses everywhere.
 *
 * All three compile. None of them is visible to a typecheck, and two of them
 * are invisible on a wall where a browser happens to be running already.
 *
 * ### What is deliberately not lifted
 *
 * `reply` itself, so `a_browser_call_is_routed_and_says_nothing_with_no_port`
 * stays behind `cargo test` — the same boundary `lift-remove.ts` draws and for
 * the same reason: `reply` reaches `standing`, `perilous` and `sweep`, and
 * those reach the store, which is the wall. Stubbing them would be asserting
 * about a different function (`lift-selfhood.ts` makes this argument at
 * length).
 *
 * That leaves one real gap and it is worth naming: the browser arm's **position
 * inside `reply`** is load-bearing and is held up only by a typecheck and by
 * that one `cargo test`. Everything below it reads `tool_input.command` and
 * leaves when there is none, and an MCP call never has one — so an arm moved
 * below the shell arm would compile, pass every assertion in this file, and
 * never fire.
 *
 * ### The technique
 *
 * Variant 2 of build.md's ladder: `settings` and `mcp_config` build
 * `serde_json` values, so this borrows the rlib cargo has already built.
 *
 * **It regenerates from the source files on every run and keeps nothing.** A
 * copy that can go stale will, and it goes on passing while it does.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { blockAt } from "./lift-scan.ts";

const DEPS = "src-tauri/target/x86_64-pc-windows-gnu/debug/deps";
const HOOKS = "src-tauri/src/hooks.rs";
const ASK = "src-tauri/src/ask.rs";
const BROWSER = "src-tauri/src/browser.rs";

/** What the wake decisions are built out of, in declaration order. */
const HOOKS_ITEMS = [
  "const FLAG",
  "const FLAG_CARD",
  "const FLAG_DB",
  "const FLAG_PORT",
  "const BROWSER_PREFIX",
  "const WAKE_TIMEOUT",
  "fn wakes_browser",
  "fn after",
  "fn settings",
];

/** And the other end of the prefix claim. Lifted verbatim rather than stubbed:
 *  the whole point of `the_wake_prefix_is_the_server_the_config_registers` is
 *  that the *real* `mcp_config` and the *real* constant agree, and a stub that
 *  named the server "browser" by hand would assert nothing at all. */
const ASK_ITEMS = ["const ANSWER_MAX", "fn client_timeout_ms", "fn mcp_config"];

/** `mcp_config` reaches for this, so it comes too. It is four lines and it is
 *  also where the `--cdp-endpoint` argument is actually written, which is the
 *  fact the whole feature stands on. */
const BROWSER_ITEMS = [
  "const HOST",
  "const DEFAULT_PORT",
  /* The other two rungs of the timeout ladder. `READY_TIMEOUT` comes because
     `SHARED_START_WAIT` is derived from it, so lifting the derived one without
     its input would assert about a number this file had made up. */
  "const READY_TIMEOUT",
  "const SHARED_START_WAIT",
  "fn address",
  "fn mcp_server",
];

const TESTS = [
  "only_the_shared_browsers_tools_wake_a_browser",
  "the_wake_prefix_is_the_server_the_config_registers",
  "the_hook_outlives_the_wait_it_may_have_to_do",
  "a_chat_card_gets_no_port_to_wake_anything_with",
];

/** The per-file machinery, closed over one file's lines. */
function reader(file: string) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const block = (i: number): string => blockAt(lines, i, file);
  const testsAt = (): number => {
    const at = lines.findIndex((l) => /^\s*mod tests\s*\{/.test(l));
    return at < 0 ? lines.length : at;
  };
  /** Declarations are searched only *above* the test module, so a fixture
   *  sharing a name with a function is never the match. */
  const find = (what: string): string => {
    const stop = testsAt();
    const re = new RegExp(`^\\s*(pub(\\([a-z]+\\))?\\s+)?${what.replace(/ /g, "\\s+")}\\b`);
    for (let i = 0; i < stop; i++) if (re.test(lines[i])) return block(i);
    throw new Error(`could not find "${what}" in ${file} — has it been renamed?`);
  };
  const findTest = (name: string): string => {
    for (let i = testsAt(); i < lines.length; i++) {
      if (new RegExp(`^\\s*fn ${name}\\s*[(<]`).test(lines[i])) return block(i);
    }
    throw new Error(`could not find test "${name}" in ${file} — has it been renamed?`);
  };
  return { find, findTest };
}

const hk = reader(HOOKS);
const ask = reader(ASK);
const br = reader(BROWSER);

/** The `serde_json` rlib cargo already built, found by hash rather than named. */
function serdeJsonRlib(): string {
  let names: string[];
  try {
    names = readdirSync(DEPS);
  } catch {
    throw new Error(
      `${DEPS} does not exist — run \`bash tools/check-gnu.sh\` once so cargo builds the ` +
        `rlibs this borrows.`,
    );
  }
  const hit = names.filter((n) => /^libserde_json-[0-9a-f]+\.rlib$/.test(n)).sort();
  if (hit.length === 0) {
    throw new Error(`no libserde_json-*.rlib in ${DEPS} — run tools/check-gnu.sh first`);
  }
  return join(DEPS, hit[hit.length - 1]);
}

/* `crate::ask::mcp_config` and `crate::browser::mcp_server` resolve to these,
   because in a single-file lift the crate root *is* the file. That is what lets
   both test bodies stay verbatim — an edited lift is evidence about the edit
   rather than about the code. */
const body: string[] = [
  "//! GENERATED by tools/lift-browser.ts — do not edit, do not keep.",
  "#![allow(dead_code, unused_imports)]",
  "",
  "pub mod browser {",
  ...BROWSER_ITEMS.map((i) => br.find(i)),
  "}",
  "",
  "pub mod ask {",
  "    use serde_json::{json, Value};",
  "    use std::time::Duration;",
  ...ASK_ITEMS.map((i) => ask.find(i)),
  "}",
  "",
  ...HOOKS_ITEMS.map((i) => hk.find(i)),
  "",
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  ...TESTS.map((t) => hk.findTest(t)),
  "}",
];

const dir = mkdtempSync(join(tmpdir(), "lift-browser-"));
const file = join(dir, "lifted.rs");
const exe = join(dir, "lifted.exe");
writeFileSync(file, body.join("\n\n"));

try {
  const build = spawnSync(
    "rustc",
    [
      "--test",
      "--edition",
      "2021",
      "-A",
      "dead_code",
      "--extern",
      `serde_json=${serdeJsonRlib()}`,
      "-L",
      `dependency=${DEPS}`,
      file,
      "-o",
      exe,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        /* Load-bearing: bare `rustc` takes the msvc default toolchain and dies
           on `link: extra operand`, which names nothing that points at the
           cause. Sink b282b54c and 276f26ca, found independently. */
        RUSTUP_TOOLCHAIN: "stable-x86_64-pc-windows-gnu",
      },
    },
  );
  if (build.status !== 0) {
    console.error(build.stderr || build.stdout);
    console.error(`\nthe lift is at ${file} — it was NOT removed, so you can read it.`);
    process.exit(1);
  }
  const run = spawnSync(exe, { encoding: "utf8" });
  console.log(run.stdout || run.stderr);
  if (run.status !== 0) process.exit(1);
  rmSync(dir, { recursive: true, force: true });
} catch (e) {
  console.error(e);
  process.exit(1);
}
