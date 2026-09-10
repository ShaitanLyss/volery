/* Actually run the sink's pure assertions on a machine with no MSVC.
 *
 * `cargo test` does not exist here — `.claude/rules/build.md` has the whole of
 * why. `bash tools/check-gnu.sh` *typechecks* the assertions in `sink.rs` and
 * cannot execute one of them, and a green typecheck reads exactly like a green
 * test run.
 *
 *     bun tools/lift-sink.ts
 *
 * **It regenerates from `sink.rs` on every run and keeps nothing**, for
 * `lift-servers.ts`' reason: a copy that can go stale will, and it goes on
 * passing while it does.
 *
 * ### Why this exists now, having been judged not worth it
 *
 * Card `8cf7dd31` looked at this on 2026-09-10 and decided against, on the
 * ground that the assertions carry `crate::` references the lift pattern could
 * not resolve. That was true of the pattern as it then stood and is no longer:
 * `tools/lift-scan.ts` is one string-aware brace counter for all fifteen of
 * them (4dfc013), and `lift-board.ts` had already shown that the references
 * this file makes come off cheaply. They are, in full —
 *
 * - `crate::store::SinkItem`, which is `#[derive(Debug, Clone)]` over sixteen
 *   plain fields and pulls in nothing;
 * - `crate::relay::handle_of`, which is one line;
 * - `crate::store::projects`, inside `Scopes::read` — the *impure* half, which
 *   no assertion touches and which is therefore simply not lifted. The two pure
 *   readings beside it are taken on their own and re-wrapped in an `impl`.
 *
 * So the judgement was right about the cost of the third and wrong that it had
 * to be paid.
 *
 * ### What is worth executing here rather than merely compiling
 *
 * Nearly all of it is **strings** — the row an agent reads a listing off, and
 * the sentences it is refused with. On this wall those are not copy-editing:
 * the whole of sink `23f5f762` is that a row did not say which scope it came
 * from, so a title copied out of it addressed the wrong item and `drop` filed a
 * twin, six times. A reworded row still typechecks. So does a refusal that has
 * stopped naming the id, or stopped saying what to pass instead — which is the
 * difference between a refusal an agent can act on and the same bug with better
 * manners.
 *
 * It borrows `serde_json` out of the target directory the way `lift-board.ts`
 * does, since the four tool schemas fold a `json!`.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { blockAt } from "./lift-scan.ts";

const DEPS = "src-tauri/target/x86_64-pc-windows-gnu/debug/deps";
const SINK = "src-tauri/src/sink.rs";
const STORE = "src-tauri/src/store.rs";
const RELAY = "src-tauri/src/relay.rs";

/** Which file each item is lifted out of, in the order they have to be declared. */
const ITEMS: [string, string][] = [
  [STORE, "struct SinkItem"],
  [RELAY, "fn handle_of"],
  [SINK, "const SINK_TOOL"],
  [SINK, "const DROP_TOOL"],
  [SINK, "const TAKE_TOOL"],
  [SINK, "const DONE_TOOL"],
  [SINK, "const HOLD_STALE_MS"],
  [SINK, "const MAX_TITLE"],
  [SINK, "const MAX_NOTE"],
  [SINK, "const MAX_GLOBS"],
  [SINK, "const KINDS"],
  [SINK, "fn hold_stale"],
  [SINK, "fn free"],
  [SINK, "fn may_edit"],
  [SINK, "fn title_taken"],
  [SINK, "fn sink_schema"],
  [SINK, "fn drop_schema"],
  [SINK, "fn take_schema"],
  [SINK, "fn done_schema"],
  [SINK, "fn globs_of"],
  [SINK, "fn globs_from"],
  [SINK, "fn ago"],
  [SINK, "fn short"],
  [SINK, "enum Pick"],
  [SINK, "fn resolve"],
  [SINK, "enum Filed"],
  [SINK, "fn filed"],
  [SINK, "fn scope_name"],
  [SINK, "fn scope_tag"],
  [SINK, "struct Scopes"],
  [SINK, "fn render"],
  [SINK, "fn ambiguous"],
  [SINK, "fn twin_refusal"],
  [SINK, "fn not_found"],
];

/** `Scopes`' pure half, reading by reading — `read` is the impure one and stays
 *  behind. Re-wrapped in an `impl` below, which is the one structural liberty
 *  this lift takes with the file it is testing. */
const METHODS: string[] = ["fn named", "fn of", "fn tag_of"];

const TESTS: string[] = [
  /* The hold, which is the one number here that blocks work when it is wrong. */
  "an_unheld_item_is_free",
  "a_fresh_hold_blocks_it",
  "a_hold_nobody_has_honoured_gives_way",
  "a_hold_outlasts_a_notice",
  /* What a written address means, and the refusal when it means two things. */
  "an_item_resolves_by_id_by_its_head_and_by_title",
  "too_short_a_fragment_matches_nothing",
  "two_items_under_one_title_are_refused_rather_than_guessed_between",
  "a_full_id_still_answers_where_the_title_is_ambiguous",
  "an_ambiguous_fragment_is_refused_too",
  /* Sink 23f5f762: the scope a receipt names, the scope a row carries, and the
     drop that would have made the seventh twin. */
  "a_receipt_says_which_scope_the_row_it_touched_is_filed_under",
  "a_listing_row_says_which_scope_it_came_from_in_one_word",
  "the_wall_and_a_project_do_not_look_alike",
  "the_rendered_row_carries_the_scope_beside_the_id",
  "a_cross_scope_drop_is_refused_with_the_id_that_holds_the_title",
  "the_refusal_names_the_other_scope_when_the_drop_is_the_wall_wide_one",
  /* The words the tools are advertised in, including the convention an agent
     would otherwise have to infer off a listing. */
  "the_four_tools_are_advertised_with_usable_schemas",
  "drop_says_what_does_not_belong_in_the_sink",
  "drop_says_what_seconding_a_wall_wide_item_takes",
  "take_says_to_put_it_back",
  "a_missing_item_names_what_is_actually_there",
  "globs_arrive_in_both_spellings",
  /* Rewording one, which is the user's verb and the other door onto the title
     invariant. */
  "an_item_nobody_is_on_may_be_reworded",
  "a_held_item_may_not_be_reworded",
  "a_lapsed_hold_does_not_block_a_rewording",
  "a_settled_item_is_history_and_is_not_reworded",
  "a_rename_onto_an_occupied_title_is_refused",
  "an_item_does_not_collide_with_itself",
  "one_title_in_two_projects_is_not_a_collision",
  "a_settled_item_does_not_hold_its_title",
  "the_reading_says_when_you_have_reworded_an_agents_item",
  "your_own_item_says_nothing_about_being_reworded",
];

/** The helpers the tests build their fixtures with. */
const HELPERS: string[] = ["fn item", "fn scopes", "fn one"];

const cache = new Map<string, string[]>();
function linesOf(file: string): string[] {
  let got = cache.get(file);
  if (!got) {
    got = readFileSync(file, "utf8").split(/\r?\n/);
    cache.set(file, got);
  }
  return got;
}

/** A lift is flat, so the paths that cross a module boundary come off. Narrow
 *  on purpose: only the prefixes these files actually use, so a fourth would
 *  fail to compile rather than be silently rewritten into something that
 *  happens to resolve. */
function flatten(rust: string): string {
  return rust
    .replaceAll("crate::store::", "")
    .replaceAll("crate::relay::", "")
    .replaceAll("serde_json::json!", "json!")
    .replaceAll("serde_json::Value", "Value");
}

function testsAt(file: string): number {
  const at = linesOf(file).findIndex((l) => /^\s*mod tests\s*\{/.test(l));
  return at < 0 ? linesOf(file).length : at;
}

function find(file: string, what: string, from = 0, to = Infinity): string {
  const lines = linesOf(file);
  const re = new RegExp(`^\\s*(pub(\\([a-z]+\\))?\\s+)?${what.replace(/ /g, "\\s+")}\\b`);
  const stop = Math.min(lines.length, to);
  for (let i = from; i < stop; i++) {
    if (re.test(lines[i])) return flatten(blockAt(lines, i, file));
  }
  throw new Error(`could not find "${what}" in ${file} — has it been renamed?`);
}

/** Above `mod tests`, so a test helper of the same name cannot be picked up
 *  instead of the thing being tested. */
const findItem = (file: string, what: string) => find(file, what, 0, testsAt(file));

/** Below it, for the fixtures. */
const findInTests = (what: string) => find(SINK, what, testsAt(SINK));

function findTest(name: string): string {
  const lines = linesOf(SINK);
  for (let i = testsAt(SINK); i < lines.length; i++) {
    if (new RegExp(`^\\s*fn ${name}\\s*\\(`).test(lines[i])) {
      return flatten(blockAt(lines, i, SINK));
    }
  }
  throw new Error(`could not find test "${name}" in ${SINK} — has it been renamed?`);
}

const rlib = readdirSync(DEPS).find((f) => /^libserde_json-[0-9a-f]+\.rlib$/.test(f));
if (!rlib) {
  console.error(
    `no serde_json rlib in ${DEPS} — run \`bash tools/check-gnu.sh\` first so cargo builds one.`,
  );
  process.exit(1);
}

const body = [
  "//! GENERATED by tools/lift-sink.ts — do not edit, do not keep.",
  "use serde_json::{json, Value};",
  ...ITEMS.map(([f, w]) => findItem(f, w)),
  /* `Scopes::read` needs an AppHandle and the store; the two readings beside it
     need neither, so they are re-wrapped here without it. */
  ["impl Scopes {", ...METHODS.map((m) => findItem(SINK, m)), "}"].join("\n"),
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  ...HELPERS.map(findInTests),
  ...TESTS.map(findTest),
  "}",
].join("\n\n");

const dir = mkdtempSync(join(tmpdir(), "lift-sink-"));
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
    {
      encoding: "utf8",
      /* Load-bearing: bare `rustc` takes the msvc default toolchain and dies on
         `link: extra operand`, which names nothing that points at the cause.
         Sink b282b54c and 276f26ca, found independently. */
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
  try {
    rmSync(exe, { force: true });
  } catch {
    /* the exe may still be held; the temp dir goes either way */
  }
}
