/* Actually run the safe-delete assertions on a machine with no MSVC.
 *
 * `cargo test` does not exist here — `.claude/rules/build.md` has the whole of
 * why — so `bash tools/check-gnu.sh --all-targets` *typechecks* these and cannot
 * execute one of them.
 *
 *     bun tools/lift-remove.ts
 *
 * ### Why this pair earns a lift
 *
 * Two files, because the feature is two halves that only work together and each
 * half's load-bearing part is invisible to a typecheck.
 *
 * **`remove.rs`: `approved` and `refuse` are the whole of the safety.** There is
 * no undo behind this tool — `.claude/rules/undo.md` is explicit that the stack
 * cannot reach a file, and the delete is permanent by design — so everything the
 * module promises reduces to one string comparison and one predicate. A version
 * of `approved` that returned `true` for every answer compiles, passes
 * `check-gnu`, and deletes on a timeout. A `refuse` that returned `None` for
 * everything compiles just as well and hands every card on the wall a repository
 * root. Neither direction is visible to a green typecheck, which is
 * `lift-docket.ts`'s argument arriving somewhere it costs more.
 *
 * `under` is the sharpest of the readings, for the reason `section_gid_of` is
 * over in `lift-docket.ts`: it produces a *plausible* wrong answer rather than
 * an error. A `starts_with` that ignores segment boundaries makes
 * `C:/work/skein-old` a child of `C:/work/skein` — right for every path anybody
 * tests by hand, and wrong exactly when two directories share a prefix.
 *
 * **`hooks.rs`: `is_shelving` decides whether a card is stopped.** Both
 * directions cost something and neither shows up in a build. Too eager and the
 * guard fires on ordinary renames, which is how a guard becomes a thing every
 * card learns to route around; too slack and `mv .next .next-stale-audit-backup`
 * goes through, which is the exact command sink `14f2543e` was filed about.
 *
 * ### What is deliberately not lifted
 *
 * Everything that touches the wall: `survey`, `ground`, `other_writers`,
 * `servers_over`, `settle_delete` and the `git` shell-out on the `remove` side;
 * `reply`, `sweep` and `perilous` on the hooks side. So one assertion stays
 * behind `cargo test` — `the_move_guard_holds_where_the_other_two_step_aside`,
 * which calls `reply` to prove the third guard fires on a payload naming no card
 * — and that is a boundary worth stating rather than discovering: what this
 * proves is the *decisions*, and `bash tools/check-gnu.sh` is the other half and
 * covers the paths.
 *
 * ### The technique
 *
 * Variant 2 of build.md's ladder, as `lift-docket.ts` and `lift-roster.ts` use:
 * the readings build `serde_json::json!` values, so this borrows the
 * `serde_json` rlib cargo has already built rather than being limited to
 * dependency-free code. It finds the rlib by hash, since the hash moves with the
 * dependency graph.
 *
 * **It regenerates from the source files on every run and keeps nothing.**
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { blockAt } from "./lift-scan.ts";

const DEPS = "src-tauri/target/x86_64-pc-windows-gnu/debug/deps";
const REMOVE = "src-tauri/src/remove.rs";
const HOOKS = "src-tauri/src/hooks.rs";

/** What to lift out of `remove.rs`, in the order it has to be declared.
 *
 *  Listing what comes *in* rather than what stays out, as every other lift here
 *  argues, and the direction of failure is what makes that safe: something new
 *  and unlisted is simply not asserted about, while a test naming a function
 *  this list omits breaks the build loudly. */
const REMOVE_ITEMS = [
  "const MAX_PATHS",
  "const DELETE_IT",
  "const KEEP_IT",
  "fn approved",
  "fn unanswered",
  "fn declined",
  "fn key",
  "fn same",
  "fn under",
  "fn touches_git_dir",
  "fn is_root",
  "struct Survey",
  "struct Ground",
  "fn refuse",
  "fn human_size",
  "fn describe",
  "fn question",
  "fn remove_schema",
  "fn paths_from",
  "const REMOVE_TOOL",
];

/** And out of `hooks.rs`. `commands`, `strip_heredocs` and `heredoc_delims` are
 *  not the subject — they are what `displaced` is built on, and lifting the
 *  detector without them would be asserting about a different function. */
const HOOKS_ITEMS = [
  "const SEPS",
  "const MS_SEP",
  "const SHELVED",
  "struct Displaced",
  "const REMOVERS",
  "const RECURSIVE",
  "struct Wipe",
  "fn commands",
  "fn heredoc_delims",
  "fn strip_heredocs",
  "fn is_shelving",
  "fn displaced_in",
  "fn displaced",
  "fn displaced_reason",
  "fn wipes_in",
  "fn wipes",
  "fn wipe_reason",
];

const REMOVE_TESTS = [
  "fn dir",
  "fn ground_at",
  "only_the_button_is_an_approval",
  "a_refusal_is_an_answer_and_says_so",
  "anything_that_is_not_a_button_comes_back_verbatim",
  "containment_is_decided_on_segments_and_not_on_letters",
  "a_path_that_is_not_there_is_said_to_be_missing_rather_than_succeeding",
  "the_repository_itself_is_never_a_target",
  "a_root_of_anything_is_refused",
  "the_ground_the_card_stands_on_is_refused_and_a_sibling_is_not",
  "uncommitted_tracked_work_is_refused_and_the_refusal_says_whose_it_might_be",
  "a_build_cache_full_of_untracked_files_is_allowed_through_to_the_question",
  "the_question_carries_the_five_things_a_path_cannot_say",
  "the_question_says_it_cannot_be_taken_back",
  "the_question_always_names_both_buttons",
  "a_capped_walk_reads_as_a_floor_rather_than_a_count",
  "sizes_read_in_the_register_the_decision_is_made_in",
  "paths_come_in_as_one_or_many_and_never_twice",
  "the_schema_leads_with_the_habit_it_replaces",
  "the_schema_promises_no_self_serve_tier_and_no_way_back",
];

/** The move guard's own, minus the one that needs `reply`. */
const HOOKS_TESTS = [
  "a_directory_moved_out_of_its_own_way_is_a_delete",
  "an_ordinary_rename_is_left_alone",
  "shelving_is_read_the_way_the_filesystem_reads_a_path",
  "the_move_guard_is_not_a_delete_guard",
  "the_refusal_names_the_tool_and_the_way_back",
  "a_shelving_written_into_a_commit_message_is_prose",
  "every_spelling_that_deletes_a_tree_is_caught",
  "deleting_one_file_is_not_this",
  "the_wipe_refusal_hands_over_a_working_route",
  "a_wipe_written_into_a_commit_message_is_prose",
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
    const re = new RegExp(
      `^\\s*(pub(\\([a-z]+\\))?\\s+)?${what.replace(/ /g, "\\s+")}\\b`,
    );
    /* `blockAt` walks back over an item's doc comment *and* its attributes
       already, so a struct arrives with its `#[derive]` attached and nothing
       here has to reach for one. Doing it a second time here is how the first
       cut of this file emitted every derive twice, which rustc reports as
       `conflicting implementations of trait Default` — a message that names
       nothing pointing at a lift. */
    for (let i = 0; i < stop; i++) if (re.test(lines[i])) return block(i);
    throw new Error(`could not find "${what}" in ${file} — has it been renamed?`);
  };

  const findTest = (name: string): string => {
    const bare = name.startsWith("fn ") ? name.slice(3) : name;
    for (let i = testsAt(); i < lines.length; i++) {
      if (new RegExp(`^\\s*fn ${bare}\\s*[(<]`).test(lines[i])) return block(i);
    }
    throw new Error(`could not find test "${bare}" in ${file} — has it been renamed?`);
  };

  return { find, findTest };
}

const rm = reader(REMOVE);
const hk = reader(HOOKS);

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
  if (hit.length > 1) {
    console.error(`note: ${hit.length} serde_json rlibs in deps, using ${hit[hit.length - 1]}`);
  }
  return join(DEPS, hit[hit.length - 1]);
}

/* The two halves go in modules of their own rather than side by side, because
   both files declare a `tests` module and both would otherwise want the same
   name — and because keeping them apart is what lets each test body stay
   *verbatim*. An edited lift is evidence about the edit. */
const body: string[] = [
  "//! GENERATED by tools/lift-remove.ts — do not edit, do not keep.",
  "#![allow(dead_code, unused_imports)]",
  "",
  "mod removing {",
  "    use serde_json::{json, Value};",
  /* `is_root` reaches for `Path::parent` rather than counting separators, so
     the lift owes it the same import the module has. Named here rather than
     lifted out of the source's own `use` block, because that block also pulls
     in `tauri::AppHandle` and everything under it — which is the wall, and the
     boundary this file is about not crossing. */
  "    use std::path::Path;",
  ...REMOVE_ITEMS.map((i) => rm.find(i)),
  "    #[cfg(test)]",
  "    mod tests {",
  "        use super::*;",
  ...REMOVE_TESTS.map((t) => rm.findTest(t)),
  "    }",
  "}",
  "",
  "mod shelving {",
  ...HOOKS_ITEMS.map((i) => hk.find(i)),
  "    #[cfg(test)]",
  "    mod tests {",
  "        use super::*;",
  ...HOOKS_TESTS.map((t) => hk.findTest(t)),
  "    }",
  "}",
];

const dir = mkdtempSync(join(tmpdir(), "lift-remove-"));
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
