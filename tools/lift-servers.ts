/* Actually run `servers.rs`'s pure assertions on a machine with no MSVC.
 *
 * `cargo test` does not exist here — `.claude/rules/build.md` has the whole of
 * why, and the short version is that rustc reaches for a bare `link.exe` and
 * finds GNU coreutils' `link`. So `bash tools/check-gnu.sh --profile test`
 * *typechecks* the assertions in this crate and cannot execute one of them,
 * which is worth saying out loud because a green `--profile test` reads exactly
 * like a green test run and is not one.
 *
 * The way out that rule names is to lift the pure functions into a throwaway
 * and hand it to `rustc --test`: no cargo, no dependencies, no linker beyond
 * the one the gnu toolchain already brings. This is that, scripted.
 *
 * **It regenerates from the source file on every run and keeps nothing**, and
 * that is the whole reason it is a script rather than a `lifted.rs` somebody
 * re-runs. `joblog.rs`'s twelve tests were once run against a lift taken before
 * a constant was threaded through the function under it, so the green they
 * reported was about a version that no longer existed on disk — they passed
 * when re-lifted, but that was luck rather than method (ac3883e). A copy that
 * can go stale will, and it goes on passing while it does.
 *
 *     bun tools/lift-servers.ts
 *
 * What it can reach is exactly what is pure: the ANSI stripper, the group
 * resolver, the log ring's eviction, and one pass of the health poll. Everything
 * else in `servers.rs` spawns a process or wants an `AppHandle`, and is out of
 * reach of any technique short of an MSVC toolchain.
 *
 * `health_pass` is the newest of those and the clearest case for the technique
 * (sink 8cda666f). It was cut out of the detached poll thread precisely so it
 * could be run: the bug was about *when* the poll stops, the thread around it is
 * twenty seconds of `sleep`, and a typecheck cannot tell "stops when the group
 * is gone" from "stops when the group is gone, having first read a port that now
 * belongs to somebody else".
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SRC = "src-tauri/src/servers.rs";

/** The items to lift, named exactly as they are declared. */
const ITEMS = [
  "const KEEP_LINES",
  "const KEEP_BYTES",
  "const MAX_LINE",
  "const LOG_DEFAULT",
  "const LOG_MAX",
  "struct Said",
  "struct Trace",
  "impl Trace",
  "fn strip_ansi",
  "fn pick_group",
  "fn names_of",
  "fn health_pass",
];

/** The tests to lift, by function name. */
const TESTS = [
  "a_line_reaches_an_agent_with_the_colour_taken_off",
  "an_escape_it_does_not_know_costs_two_characters_not_the_line",
  "stripping_leaves_everything_that_is_not_an_escape",
  "one_group_needs_no_naming_and_several_do",
  "a_group_is_named_by_its_label_or_its_id",
  "an_ambiguous_name_is_refused_rather_than_guessed",
  "a_name_that_matches_nothing_says_what_there_is",
  "the_ring_keeps_its_last_lines_and_counts_what_it_dropped",
  "a_few_enormous_lines_bite_before_the_line_count_does",
  "the_byte_count_still_describes_what_is_in_the_ring",
  "a_line_bigger_than_the_whole_budget_does_not_wedge_the_ring",
  /* The health poll's two ways of stopping. Worth executing rather than
     compiling because the bug was about *when* it stops, and the thread it
     lives in is twenty seconds of `sleep` that no assertion could reach. */
  "spec",
  "a_poll_whose_group_is_gone_says_nothing_and_stops",
  "a_live_poll_reports_what_is_up_and_stops_when_all_of_it_is",
  "a_spec_with_no_port_is_skipped_without_holding_the_poll_open",
  "clearing_the_flag_is_what_the_poll_is_reading",
];

const src = readFileSync(SRC, "utf8");
const lines = src.split(/\r?\n/);

/** Where a declaration starts, including the doc comments and attributes above
 *  it — a lift that dropped `#[derive(Default)]` would compile into a different
 *  thing and say so only at the call site. */
function startOf(i: number): number {
  let from = i;
  while (from > 0) {
    const prev = lines[from - 1].trim();
    if (prev.startsWith("///") || prev.startsWith("//") || prev.startsWith("#[")) {
      from--;
      continue;
    }
    break;
  }
  return from;
}

/** From a declaration line to its closing brace, by depth. Handles the
 *  one-line `const` form too, which has no brace at all. */
function block(i: number): string {
  const head = lines[i];
  if (/;\s*$/.test(head) && !head.includes("{")) {
    return lines.slice(startOf(i), i + 1).join("\n");
  }
  let depth = 0;
  let seen = false;
  for (let j = i; j < lines.length; j++) {
    for (const ch of lines[j]) {
      if (ch === "{") {
        depth++;
        seen = true;
      } else if (ch === "}") depth--;
    }
    if (seen && depth === 0) return lines.slice(startOf(i), j + 1).join("\n");
  }
  throw new Error(`unterminated block at ${SRC}:${i + 1}`);
}

/** Find a declaration by its head, ignoring visibility. */
function find(what: string): string {
  const re = new RegExp(`^\\s*(pub(\\([a-z]+\\))?\\s+)?${what.replace(/ /g, "\\s+")}\\b`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return block(i);
  }
  throw new Error(`could not find "${what}" in ${SRC} — has it been renamed?`);
}

function findTest(name: string): string {
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^\\s*fn ${name}\\s*\\(`).test(lines[i])) return block(i);
  }
  throw new Error(`could not find test "${name}" in ${SRC} — has it been renamed?`);
}

/* A stand-in for the one type these functions borrow from `store.rs`. It is a
   stub rather than a lift because `ServerGroup` carries serde derives and a
   `Vec<ServerSpec>`, and `pick_group` reads exactly two of its fields — so a
   full lift would drag `store.rs`'s dependencies in to prove nothing. If
   `pick_group` ever reads a third field this will stop compiling, which is the
   right way for a stub to fail. */
const STUB = `
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/* \`Debug\` and \`Clone\` because the real one in \`store.rs\` derives both, and a
   stub that derived fewer would fail here for a reason that is about the stub —
   \`unwrap_err\` wants \`T: Debug\` — rather than about the code under test. */
#[derive(Debug, Clone)]
struct ServerGroup {
    id: String,
    project_id: String,
    label: String,
    autostart: bool,
    start_order: i64,
    servers: Vec<ServerSpec>,
}

#[derive(Debug, Clone)]
struct ServerSpec {
    label: String,
    command: String,
    cwd: Option<String>,
    port: Option<u16>,
}

/* Silence the dead-code warnings the stub's unread fields would otherwise
   generate — they are read by the real thing, not by these assertions. */
#[allow(dead_code)]
fn _unused(g: &ServerGroup, s: &ServerSpec) {
    let _ = (&g.project_id, &g.autostart, &g.start_order, &g.servers);
    let _ = (&s.label, &s.command, &s.cwd, &s.port);
}
`;

const body = [
  "//! GENERATED by tools/lift-servers.ts — do not edit, do not keep.",
  STUB,
  ...ITEMS.map(find),
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  `    fn group(id: &str, label: &str) -> ServerGroup {
        ServerGroup {
            id: id.into(),
            project_id: "p".into(),
            label: label.into(),
            autostart: true,
            start_order: 0,
            servers: Vec::new(),
        }
    }
    fn said(line: &str) -> Said {
        Said { label: "web".into(), line: line.into(), stderr: false, at: 0 }
    }`,
  ...TESTS.map(findTest),
  "}",
].join("\n\n");

const dir = mkdtempSync(join(tmpdir(), "lift-servers-"));
const file = join(dir, "lifted.rs");
const exe = join(dir, "lifted.exe");
writeFileSync(file, body);

try {
  const build = spawnSync(
    "rustc",
    ["--test", "--edition", "2021", "-A", "dead_code", file, "-o", exe],
    { encoding: "utf8", env: { ...process.env, RUSTUP_TOOLCHAIN: "stable-x86_64-pc-windows-gnu" } },
  );
  if (build.status !== 0) {
    console.error(build.stderr || build.stdout);
    console.error(`\nthe lift is at ${file} — it was NOT removed, so you can read it.`);
    process.exit(1);
  }
  const run = spawnSync(exe, ["--test-threads", "1"], { encoding: "utf8" });
  console.log(run.stdout);
  if (run.stderr) console.error(run.stderr);
  process.exit(run.status ?? 1);
} finally {
  /* Nothing is kept on success. A `lifted.rs` left on disk is the stale copy
     this script exists to make impossible. */
  try {
    rmSync(exe, { force: true });
  } catch {
    /* the exe may still be held; the temp dir goes either way */
  }
}
