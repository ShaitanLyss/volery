/* Actually run the forge tools' pure assertions on a machine with no MSVC.
 *
 * `cargo test` does not exist here — `.claude/rules/build.md` has the whole of
 * why, and the short version is that rustc reaches for a bare `link.exe` and
 * finds GNU coreutils' `link`. So `bash tools/check-gnu.sh --tests`
 * *typechecks* the assertions in this crate and cannot execute one of them,
 * which is worth saying out loud because a green `--tests` reads exactly like a
 * green test run and is not one.
 *
 *     bun tools/lift-smith.ts
 *
 * **It regenerates from the source files on every run and keeps nothing**, for
 * the reason `tools/lift-servers.ts` says at length: a copy that can go stale
 * will, and it goes on passing while it does (ac3883e).
 *
 * ### Two things this one does that `lift-servers.ts` does not
 *
 * **It lifts from three files.** The functions under test are split across
 * `forge.rs` (the shared readers), `azdo.rs` (the remote parser and the url
 * composer) and `smith.rs` (the tools' own judgements), because that split is
 * where the code belongs — and a lift is flat, so `crate::forge::` and
 * `crate::azdo::` are rewritten away on the way in. That rewrite is the one
 * place this script can lie about the code it is testing: it proves the
 * *bodies* are right and cannot prove the paths are, which is what
 * `check-gnu.sh --tests` is for and why both are run.
 *
 * **It borrows `serde_json` out of the target directory.** `one_pull` folds a
 * `Value`, so a dependency-free lift cannot reach it — the extension recorded
 * in sink 276f26ca. The rlib cargo already built is passed with `--extern`,
 * which costs nothing and means this lift is only as healthy as the tree's own
 * dependency graph. If that graph is broken, `cargo check` will have said so
 * first.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const DEPS = "src-tauri/target/x86_64-pc-windows-gnu/debug/deps";

/** Which file each item is lifted out of, in the order they have to be declared. */
const ITEMS: [string, string][] = [
  ["src-tauri/src/forge.rs", "fn encode"],
  ["src-tauri/src/forge.rs", "fn text"],
  ["src-tauri/src/azdo.rs", "fn decode"],
  ["src-tauri/src/azdo.rs", "fn azdo_parts"],
  ["src-tauri/src/azdo.rs", "fn org_of"],
  ["src-tauri/src/azdo.rs", "struct Origin"],
  ["src-tauri/src/azdo.rs", "fn origin_of"],
  ["src-tauri/src/azdo.rs", "fn pull_url"],
  ["src-tauri/src/azdo.rs", "fn full_ref"],
  ["src-tauri/src/smith.rs", "fn same_branch"],
  ["src-tauri/src/smith.rs", "fn went_wrong"],
  ["src-tauri/src/smith.rs", "fn one_pull"],
  ["src-tauri/src/smith.rs", "fn web_url"],
  /* The confirmation gate, which is the half of this work that has to be right
     the first time — a write that read a yes out of prose is a pull request
     nobody asked for, under the user's name, on somebody else's queue. */
  ["src-tauri/src/smith.rs", "const OPEN_IT"],
  ["src-tauri/src/smith.rs", "const DO_NOT_OPEN"],
  ["src-tauri/src/smith.rs", "const CHANGE_IT"],
  ["src-tauri/src/smith.rs", "const DO_NOT_CHANGE"],
  ["src-tauri/src/smith.rs", "const MAX_SHOWN"],
  ["src-tauri/src/smith.rs", "fn approved"],
  ["src-tauri/src/smith.rs", "fn clip"],
  ["src-tauri/src/smith.rs", "fn create_question"],
  ["src-tauri/src/smith.rs", "fn update_question"],
  ["src-tauri/src/smith.rs", "fn unanswered"],
  ["src-tauri/src/smith.rs", "fn declined"],
];

const TESTS: [string, string][] = [
  /* The three that were already here and cover the function this work
     refactored. `org_of` is now one line over `azdo_parts`, so these are the
     assertions that say the refactor kept every remote shape in the wild. */
  ["src-tauri/src/azdo.rs", "an_org_is_read_out_of_every_remote_shape_in_the_wild"],
  ["src-tauri/src/azdo.rs", "anything_that_is_not_azure_devops_is_not_guessed_at"],
  ["src-tauri/src/azdo.rs", "an_org_with_a_space_survives_the_round_trip"],
  /* And the new ones, which are about the two names a write needs and `org_of`
     never did. */
  ["src-tauri/src/azdo.rs", "all_three_names_a_write_needs_come_off_the_same_remotes"],
  ["src-tauri/src/azdo.rs", "the_project_is_the_repo_when_the_url_leaves_it_out"],
  ["src-tauri/src/azdo.rs", "the_legacy_collection_form_puts_the_project_before_the_git_marker"],
  ["src-tauri/src/azdo.rs", "nothing_that_is_not_a_repository_url_becomes_an_origin"],
  ["src-tauri/src/azdo.rs", "a_project_with_a_space_survives_into_a_pull_request_url"],
  ["src-tauri/src/azdo.rs", "a_branch_name_is_widened_to_the_ref_azure_devops_insists_on"],
  ["src-tauri/src/smith.rs", "a_branch_matches_across_both_forges_spellings"],
  ["src-tauri/src/smith.rs", "a_branch_that_is_not_the_one_asked_for_does_not_match"],
  ["src-tauri/src/smith.rs", "a_run_still_going_has_not_gone_wrong"],
  ["src-tauri/src/smith.rs", "a_run_that_succeeded_or_was_skipped_has_not_gone_wrong"],
  ["src-tauri/src/smith.rs", "both_forges_spellings_of_going_wrong_are_recognised"],
  ["src-tauri/src/smith.rs", "a_pull_request_url_is_composed_from_names_and_escaped"],
  ["src-tauri/src/smith.rs", "one_pull_keeps_the_description_and_drops_the_rest"],
  ["src-tauri/src/smith.rs", "a_pull_request_with_no_description_says_so_rather_than_saying_nothing"],
  ["src-tauri/src/smith.rs", "only_the_button_is_an_approval"],
  ["src-tauri/src/smith.rs", "a_deliberate_no_reads_differently_from_a_sentence"],
  ["src-tauri/src/smith.rs", "nobody_answering_is_not_read_as_a_yes"],
  ["src-tauri/src/smith.rs", "a_question_says_where_it_lands_and_whose_name_is_on_it"],
  ["src-tauri/src/smith.rs", "a_create_with_no_description_says_that_rather_than_showing_a_gap"],
  ["src-tauri/src/smith.rs", "an_update_question_names_which_fields_change"],
  ["src-tauri/src/smith.rs", "a_long_description_is_clipped_and_says_that_it_was"],
];

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
 *  it — a lift that dropped `#[derive(PartialEq)]` would compile into a
 *  different thing and say so only at the call site. */
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
  /* A `const` runs to its semicolon, however many continuation lines that takes.
     Handled before the brace scan and not by it, because a multi-line string
     const has no braces at all — so the depth walk runs past it and swallows
     whatever declarations follow until it finds somebody else's closing brace.
     Found while measuring the schemas against `SEARCH_HINT_PIPELINES`, which is
     four continuation lines long: the lift compiled with three items defined
     twice and the error named the duplicates rather than the cause. */
  if (/^\s*(pub(\([a-z]+\))?\s+)?const\b/.test(head)) {
    for (let j = i; j < lines.length; j++) {
      if (/;\s*$/.test(lines[j])) return lines.slice(startOf(lines, i), j + 1).join("\n");
    }
    throw new Error(`unterminated const at ${file}:${i + 1}`);
  }
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

/** A lift is flat, so the paths that cross a module boundary in the real tree
 *  have to come off. This is the one thing the technique cannot verify — see the
 *  header — and it is narrow on purpose: only the two prefixes these files
 *  actually use, so a third would fail to compile rather than be silently
 *  rewritten into something that happens to resolve. */
function flatten(rust: string): string {
  return rust
    .replaceAll("crate::azdo::", "")
    .replaceAll("crate::forge::", "")
    .replaceAll("serde_json::json!", "json!")
    .replaceAll("serde_json::Value", "Value");
}

function find(file: string, what: string): string {
  const lines = linesOf(file);
  const re = new RegExp(`^\\s*(pub(\\([a-z]+\\))?\\s+)?${what.replace(/ /g, "\\s+")}\\b`);
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return flatten(block(file, i));
  }
  throw new Error(`could not find "${what}" in ${file} — has it been renamed?`);
}

function findTest(file: string, name: string): string {
  const lines = linesOf(file);
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^\\s*fn ${name}\\s*\\(`).test(lines[i])) return flatten(block(file, i));
  }
  throw new Error(`could not find test "${name}" in ${file} — has it been renamed?`);
}

const rlib = readdirSync(DEPS).find((f) => /^libserde_json-[0-9a-f]+\.rlib$/.test(f));
if (!rlib) {
  console.error(
    `no serde_json rlib in ${DEPS} — run \`bash tools/check-gnu.sh\` first so cargo builds one.`,
  );
  process.exit(1);
}

const body = [
  "//! GENERATED by tools/lift-smith.ts — do not edit, do not keep.",
  "use serde_json::{json, Value};",
  ...ITEMS.map(([f, w]) => find(f, w)),
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  ...TESTS.map(([f, n]) => findTest(f, n)),
  "}",
].join("\n\n");

const dir = mkdtempSync(join(tmpdir(), "lift-smith-"));
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
