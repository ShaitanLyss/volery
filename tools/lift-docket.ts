/* Actually run `docket.rs`'s assertions on a machine with no MSVC.
 *
 * `cargo test` does not exist here — `.claude/rules/build.md` has the whole of
 * why — so `bash tools/check-gnu.sh --tests` *typechecks* these and cannot
 * execute one of them.
 *
 *     bun tools/lift-docket.ts
 *
 * ### Why this file earns a lift
 *
 * `docket.rs` has six writes and a credential handover behind one confirmation,
 * and **`approved` is the whole of the gate.** Everything the module promises —
 * that no card writes to somebody's Asana, and no card is given the unscoped
 * token, without a person pressing a button — reduces to one string comparison,
 * and neither direction of it is visible to a typecheck. A version that returned
 * `true` for every answer compiles, passes `check-gnu`, and hands every agent on
 * the wall the user's whole Asana account; a version that returned `false` for
 * every answer compiles just as well and makes the tools inert.
 *
 * The two-label form is the half worth asserting hardest. `approved` takes the
 * word it is matching against, so a write's yes and the token's yes are
 * different strings on purpose — and nothing but a test can say that the token
 * still refuses a write's `do it`, since passing the wrong constant is a call
 * that compiles perfectly.
 *
 * That is the same argument `lift-ask.ts` makes for `swallowed` and
 * `lift-gates.ts` for the gate readings: a predicate that decides whether
 * something happens is exactly the code a green typecheck says nothing about.
 *
 * The rest are the readings that produce a *plausible* wrong answer rather than
 * an error — `section_gid_of` filing a task under whichever column it occupies
 * on somebody else's board is the sharpest, since it is right whenever a task is
 * in one project and silently wrong when it is in two.
 *
 * ### The technique
 *
 * Variant 2 of build.md's ladder, as `lift-roster.ts` uses: the readings build
 * `serde_json::json!` values, so this borrows the `serde_json` rlib cargo has
 * already built rather than being limited to dependency-free code. It finds the
 * rlib by hash, since the hash moves with the dependency graph.
 *
 * **It regenerates from the source file on every run and keeps nothing.**
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { blockAt } from "./lift-scan.ts";

const DEPS = "src-tauri/target/x86_64-pc-windows-gnu/debug/deps";
const FILE = "src-tauri/src/docket.rs";

/** The one thing outside this module the lifted readings reach for.
 *
 *  `crate::forge::text` — three lines, and the readings are written against it
 *  rather than around it. Lifted verbatim into a `forge` module beside the rest,
 *  which is `lift-roster.ts`'s arrangement and the reason it works: the text is
 *  taken as it stands rather than edited until it compiles, because an edited
 *  lift is evidence about the edit. */
const FORGE = "src-tauri/src/forge.rs";

/** What to lift, in the order it has to be declared.
 *
 *  Listing what comes *in* rather than what stays out, as every other lift here
 *  argues, and the direction of failure is what makes that safe: something new
 *  and unlisted is simply not asserted about, while a test naming a function
 *  this list omits breaks the build loudly.
 *
 *  Everything here is pure. Nothing that touches `crate::asana`, the store or
 *  an `AppHandle` is liftable, and that boundary is worth stating rather than
 *  discovering: `permitted`, `find_project`, `find_section`, `describe` and all
 *  six action builders make requests or read the wall, so what this proves is
 *  the *decisions* and not the wiring. `bash tools/check-gnu.sh` is the other
 *  half and covers the paths. */
const ITEMS = [
  "const MAX_SHOWN",
  "const DO_IT",
  "const DO_NOT",
  "const HAND_IT_OVER",
  "const KEEP_IT",
  "fn approved",
  "fn clip",
  "fn unanswered",
  "fn declined",
  "fn question",
  "fn named",
  "fn task_json",
  "fn section_gid_of",
  "fn task_schema",
  "const TASKS_TOOL",
  "const TASK_TOOL",
  "const TOKEN_TOOL",
  "const SERVICE",
  "const TOKEN_ENV",
  "fn token_schema",
];

/** The assertions. Every `#[test]` in the module that does not need the wall —
 *  which at the time of writing is every one of them, and that is a property of
 *  the module worth keeping rather than a coincidence. */
const TESTS = [
  "only_the_button_is_an_approval",
  "a_refusal_is_an_answer_and_says_so",
  "anything_that_is_not_a_button_comes_back_verbatim",
  "a_field_nobody_named_is_left_alone",
  "every_action_in_the_schema_is_one_the_tool_answers_for",
  "a_write_with_no_action_says_what_the_actions_are",
  "a_clipped_body_says_it_was_clipped",
  "the_question_always_names_both_buttons",
  "a_task_reading_carries_notes_only_when_asked",
  "a_tasks_section_is_matched_on_this_project_and_not_the_first",
  "a_task_in_no_section_is_loose_rather_than_missing",
  "the_three_tools_do_not_share_a_name_with_each_other",
  "the_token_takes_its_own_word_and_not_the_writes_one",
  "asking_for_the_token_without_a_reason_is_refused_before_anybody_is_asked",
  "the_token_schema_says_what_it_cannot_take_back",
  "the_env_var_is_the_name_asana_tooling_already_reads",
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

const { find, findTest } = reader(FILE);

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

const body: string[] = [
  "//! GENERATED by tools/lift-docket.ts — do not edit, do not keep.",
  "use serde_json::{json, Value};",
  /* The readings say `crate::forge::text(…)`, so the *file* grows the shape the
     text expects: a module re-exporting the flattened root, so `crate::forge::x`
     resolves to the `x` sitting beside it. `crate::` is this file's own root
     here, which is what makes it work at all. */
  "pub mod forge { pub use super::*; }",
  reader(FORGE).find("fn text"),
  ...ITEMS.map(find),
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  ...TESTS.map(findTest),
  "}",
];

const dir = mkdtempSync(join(tmpdir(), "lift-docket-"));
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


