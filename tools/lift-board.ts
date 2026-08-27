/* Actually run the billboard's pure assertions on a machine with no MSVC.
 *
 * `cargo test` does not exist here — `.claude/rules/build.md` has the whole of
 * why, and the short version is that rustc reaches for a bare `link.exe` and
 * finds GNU coreutils' `link`. So `bash tools/check-gnu.sh --tests`
 * *typechecks* the assertions in `board.rs` and cannot execute one of them,
 * which is worth saying out loud because a green `--tests` reads exactly like a
 * green test run and is not one.
 *
 *     bun tools/lift-board.ts
 *
 * **It regenerates from `board.rs` on every run and keeps nothing**, for the
 * reason `tools/lift-servers.ts` says at length: a copy that can go stale will,
 * and it goes on passing while it does (ac3883e).
 *
 * ### Why this file is worth the twenty minutes it cost
 *
 * Most of what is lifted here is *strings* — the words a card is refused with.
 * That reads like the least testable thing in the crate and is in fact the most
 * load-bearing, because on this wall a refusal is the entire guard. A
 * `PreToolUse` deny stops the tool call; `post` refusing stops an announcement
 * about a call the agent then makes anyway. There is nothing downstream to
 * catch it. So "does the refusal say what it costs" is not a copy-editing
 * question, it is the correctness question, and it is asserted rather than
 * eyeballed.
 *
 * `Notice` is lifted out of `store.rs`, which is where it lives — the lift is
 * flat, so `crate::store::` comes off on the way in, and that rewrite is the
 * one place this script can lie about the code it is testing. It proves the
 * bodies are right and cannot prove the paths are; `check-gnu.sh --tests` is
 * what proves those, which is why both are run.
 *
 * It borrows `serde_json` out of the target directory the way `lift-smith.ts`
 * does, since `globs_from` folds a `Value`.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const DEPS = "src-tauri/target/x86_64-pc-windows-gnu/debug/deps";
const BOARD = "src-tauri/src/board.rs";
const STORE = "src-tauri/src/store.rs";

/** Which file each item is lifted out of, in the order they have to be declared. */
const ITEMS: [string, string][] = [
  ["src-tauri/src/store.rs", "struct Notice"],
  [BOARD, "const MAX_PER_CARD"],
  [BOARD, "const MAX_UNPATHED"],
  [BOARD, "const MAX_SUBJECT"],
  [BOARD, "const MAX_BODY"],
  [BOARD, "const MAX_GLOBS"],
  [BOARD, "const STALE_AFTER_MS"],
  [BOARD, "fn normalize"],
  [BOARD, "fn covers"],
  [BOARD, "fn glob"],
  [BOARD, "fn globs_of"],
  [BOARD, "fn stale"],
  [BOARD, "fn ago"],
  [BOARD, "fn globs_from"],
  [BOARD, "fn clip"],
  [BOARD, "fn tail_of"],
  [BOARD, "fn lost"],
  [BOARD, "fn yours"],
  [BOARD, "fn at_stake"],
  [BOARD, "fn refuse_full"],
  [BOARD, "fn refuse_bare"],
];

const TESTS: string[] = [
  /* The globs, which are the mechanism a claim is actually served by and the
     thing this change must not have disturbed. */
  "a_bare_name_matches_the_file_wherever_it_is",
  "a_path_matches_the_tail_so_the_agent_can_write_what_it_would_type",
  "a_tail_match_starts_at_a_directory_boundary",
  "one_star_stays_inside_a_segment_and_two_do_not",
  "windows_spells_a_path_two_ways_and_both_are_the_same_file",
  "a_pathological_pattern_still_answers_at_once",
  "an_empty_pattern_covers_nothing_rather_than_everything",
  "globs_arrive_as_a_string_or_a_list_and_are_capped",
  "a_notice_goes_stale_by_being_left_alone_and_re_posting_revives_it",
  "ages_read_as_prose",
  /* What a limit does when it is reached — the item. */
  "a_truncation_says_how_much_it_took",
  "a_receipt_is_silent_about_what_fitted_and_loud_about_what_did_not",
  "the_tail_shows_where_it_stopped_even_for_something_short",
  "a_refused_claim_says_what_the_claim_was_holding",
  "a_refused_announcement_does_not_claim_to_have_lost_a_file",
  "a_refusal_hands_back_the_notice_likeliest_to_be_finished_with",
  "a_claim_is_capped_more_generously_than_a_broadcast",
  "being_out_of_slots_altogether_names_the_files_it_left_unguarded",
  "being_out_of_bare_slots_points_at_the_form_that_still_has_room",
];

/** The two helpers the tests build their fixtures with. */
const HELPERS: string[] = ["fn notice", "fn subject"];

const cache = new Map<string, string[]>();
function linesOf(file: string): string[] {
  let got = cache.get(file);
  if (!got) {
    got = readFileSync(file, "utf8").split(/\r?\n/);
    cache.set(file, got);
  }
  return got;
}

/** Where a declaration starts, including the doc comments and attributes above
 *  it — a lift that dropped `#[derive(Clone)]` would compile into a different
 *  thing and say so only at the call site. */
function startOf(lines: string[], i: number): number {
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
function block(file: string, i: number): string {
  const lines = linesOf(file);
  const head = lines[i];
  if (/;\s*$/.test(head) && !head.includes("{")) {
    return lines.slice(startOf(lines, i), i + 1).join("\n");
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
    if (seen && depth === 0) return lines.slice(startOf(lines, i), j + 1).join("\n");
  }
  throw new Error(`unterminated block at ${file}:${i + 1}`);
}

/** A lift is flat, so the paths that cross a module boundary come off. Narrow
 *  on purpose: only the prefixes these two files actually use, so a third would
 *  fail to compile rather than be silently rewritten into something that
 *  happens to resolve. */
function flatten(rust: string): string {
  return rust
    .replaceAll("crate::store::", "")
    .replaceAll("crate::relay::", "")
    .replaceAll("serde_json::json!", "json!")
    .replaceAll("serde_json::Value", "Value");
}

function find(file: string, what: string, from = 0): string {
  const lines = linesOf(file);
  const re = new RegExp(`^\\s*(pub(\\([a-z]+\\))?\\s+)?${what.replace(/ /g, "\\s+")}\\b`);
  for (let i = from; i < lines.length; i++) {
    if (re.test(lines[i])) return flatten(block(file, i));
  }
  throw new Error(`could not find "${what}" in ${file} — has it been renamed?`);
}

/** The test module's own items, which are below `mod tests` and would otherwise
 *  collide with a same-named item in the file proper. */
function findInTests(name: string): string {
  const lines = linesOf(BOARD);
  const at = lines.findIndex((l) => /^\s*mod tests\s*\{/.test(l));
  if (at < 0) throw new Error(`no test module in ${BOARD}`);
  return find(BOARD, name, at);
}

function findTest(name: string): string {
  const lines = linesOf(BOARD);
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^\\s*fn ${name}\\s*\\(`).test(lines[i])) return flatten(block(BOARD, i));
  }
  throw new Error(`could not find test "${name}" in ${BOARD} — has it been renamed?`);
}

const rlib = readdirSync(DEPS).find((f) => /^libserde_json-[0-9a-f]+\.rlib$/.test(f));
if (!rlib) {
  console.error(
    `no serde_json rlib in ${DEPS} — run \`bash tools/check-gnu.sh\` first so cargo builds one.`,
  );
  process.exit(1);
}

const body = [
  "//! GENERATED by tools/lift-board.ts — do not edit, do not keep.",
  "use serde_json::{json, Value};",
  /* `Notice` derives Serialize/Deserialize in `store.rs` and neither is
     available or needed here; the fields are what the lift is after. */
  "#[derive(Clone)]",
  find(STORE, "struct Notice").replace(/^#\[[^\]]*\]\s*$/gm, ""),
  ...ITEMS.filter(([, w]) => w !== "struct Notice").map(([f, w]) => find(f, w)),
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  ...HELPERS.map(findInTests),
  ...TESTS.map(findTest),
  "}",
].join("\n\n");

const dir = mkdtempSync(join(tmpdir(), "lift-board-"));
const file = join(dir, "lifted.rs");
const exe = join(dir, "lifted.exe");
writeFileSync(file, body);

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
      `serde_json=${join(DEPS, rlib)}`,
      "-L",
      `dependency=${DEPS}`,
      file,
      "-o",
      exe,
    ],
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
