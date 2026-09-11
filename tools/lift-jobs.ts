/* Actually run the background-work reading's assertions on a machine with no
 * MSVC.
 *
 * `cargo test` does not exist here — `.claude/rules/build.md` has the whole of
 * why. `bash tools/check-gnu.sh --profile test` *typechecks* the assertions in
 * `hooks.rs` and executes none of them, which is worth saying out loud because a
 * green `--profile test` reads exactly like a green test run and is not one.
 *
 *     bun tools/lift-jobs.ts
 *
 * **It regenerates from source on every run and keeps nothing**, for the reason
 * `tools/lift-gates.ts` states: a copy that can go stale will, and it goes on
 * passing while it does. Run it *alongside* `--profile test`, never instead —
 * a lift proves the text you lifted, not the file on disk (sink 276f26ca).
 *
 * ### Why this half is worth executing
 *
 * `standing_gates` is lifted next door because its prose is a claim a card acts
 * on. This is the other reading on the same hook, and it has the same shape of
 * risk pointing the other way: **the wording must not claim the work is
 * running**, and the bound that decides *whether it speaks at all* is now the
 * load-bearing part.
 *
 * That bound is what this exists for. Reported from nova `17f25bae` on
 * 2026-09-11: a card with a 28-minute background poll was handed the same three
 * lines at every turn boundary for as long as the poll ran, because "started and
 * not reported" is true of healthy work for its whole life. A notice that cries
 * wolf every turn trains every agent on the wall to skim it, which is exactly
 * the case it was built to catch. `since_fold` and `already_visible` are the
 * fix, they are pure string work, and every way of getting them wrong compiles:
 * a fold marker spelled slightly wrong silences nothing, a path matched in the
 * wrong escaping silences nothing, a label bound of two characters silences
 * everything. None of that is visible to a typecheck.
 *
 * No dependency at all — these build a String and compare substrings — so bare
 * `rustc --test` is enough and this is immune to whatever state the crate's
 * dependency graph is in.
 *
 * `PendingJob` is lifted out of `store.rs`, which is where it lives; the lift is
 * flat, so `crate::store::` comes off on the way in, and that rewrite is the one
 * place this script can lie about the code it is testing. It proves the bodies
 * are right and cannot prove the paths are.
 *
 * `live_context` is deliberately **not** lifted: it is the one line of this that
 * opens a file, and the judgement it defers to is the part a test can reach.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { blockAt } from "./lift-scan.ts";

const HOOKS = "src-tauri/src/hooks.rs";
const STORE = "src-tauri/src/store.rs";

/** Which file each item comes out of, in the order they have to be declared. */
const ITEMS: [string, string][] = [
  [STORE, "struct PendingJob"],
  [HOOKS, "const LABEL_ENOUGH"],
  [HOOKS, "fn since_fold"],
  [HOOKS, "fn already_visible"],
  [HOOKS, "fn ago"],
  [HOOKS, "fn standing_work"],
];

/** The fixtures the tests build with, out of the test module. */
const HELPERS: string[] = ["fn job", "fn rec"];

const TESTS: string[] = [
  /* The quiet path first, and it is the common one. */
  "a_card_holding_nothing_is_told_nothing",
  /* What the reading is for, and what it may claim while it says it. */
  "the_forgotten_dev_server_is_named_with_somewhere_to_look",
  "it_says_check_rather_than_asserting",
  "the_two_occasions_differ_by_what_can_be_claimed",
  "a_job_with_nowhere_to_look_is_still_named",
  "several_jobs_are_numbered",
  "ages_read_in_the_walls_own_register",
  /* And the bound that stops it repeating itself for as long as the work runs,
     with the case that must not be silenced along with it. */
  "work_the_card_can_still_read_is_not_named_again",
  "a_fold_puts_the_work_back_out_of_reach",
  "both_halves_of_a_fold_are_a_boundary",
  "only_the_newest_fold_bounds_the_reading",
  "a_windows_path_is_matched_as_json_writes_it",
  "a_label_too_short_to_mean_anything_silences_nothing",
  "an_empty_context_hides_nothing",
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

const block = (file: string, i: number): string => blockAt(linesOf(file), i, file);

/** A lift is flat, so paths crossing a module boundary come off. Narrow on
 *  purpose: only the prefix these two files actually use, so a third would fail
 *  to compile rather than be silently rewritten into something that resolves. */
function flatten(rust: string): string {
  return rust.replaceAll("crate::store::", "");
}

function find(file: string, what: string, from = 0): string {
  const lines = linesOf(file);
  const re = new RegExp(`^\\s*(pub(\\([a-z]+\\))?\\s+)?${what.replace(/ /g, "\\s+")}\\b`);
  for (let i = from; i < lines.length; i++) {
    if (re.test(lines[i])) return flatten(block(file, i));
  }
  throw new Error(`could not find "${what}" in ${file} — has it been renamed?`);
}

/** Where `mod tests` begins in hooks.rs, so a test-module item is not confused
 *  with a same-named one in the file proper. */
function testsAt(): number {
  const lines = linesOf(HOOKS);
  const at = lines.findIndex((l) => /^\s*mod tests\s*\{/.test(l));
  if (at < 0) throw new Error(`no test module in ${HOOKS}`);
  return at;
}

function findInTests(name: string): string {
  return find(HOOKS, name, testsAt());
}

function findTest(name: string): string {
  const lines = linesOf(HOOKS);
  for (let i = testsAt(); i < lines.length; i++) {
    if (new RegExp(`^\\s*fn ${name}\\s*\\(`).test(lines[i])) return flatten(block(HOOKS, i));
  }
  throw new Error(`could not find test "${name}" in ${HOOKS} — has it been renamed?`);
}

const body = [
  "//! GENERATED by tools/lift-jobs.ts — do not edit, do not keep.",
  /* `PendingJob` derives Serialize in `store.rs`, which is neither available
     here nor what the lift is after; the fields are. The attribute lines come
     off, and nothing in these tests needs anything they gave it. */
  find(STORE, "struct PendingJob").replace(/^#\[[^\]]*\]\s*$/gm, ""),
  ...ITEMS.filter(([, w]) => w !== "struct PendingJob").map(([f, w]) => find(f, w)),
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  ...HELPERS.map(findInTests),
  ...TESTS.map(findTest),
  "}",
].join("\n\n");

const dir = mkdtempSync(join(tmpdir(), "lift-jobs-"));
const file = join(dir, "lifted.rs");
const exe = join(dir, "lifted.exe");
writeFileSync(file, body);

try {
  const build = spawnSync(
    "rustc",
    ["--test", "--edition", "2021", "-A", "dead_code", file, "-o", exe],
    {
      encoding: "utf8",
      /* **Load-bearing.** Without it, bare `rustc` takes the msvc default
         toolchain and dies with `link: extra operand`, which reads as a missing
         MSVC linker rather than as a missing environment variable. Sink
         b282b54c is two cards hitting exactly this hours apart. */
      env: { ...process.env, RUSTUP_TOOLCHAIN: "stable-x86_64-pc-windows-gnu" },
    },
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
