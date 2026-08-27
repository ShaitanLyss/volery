/* Actually run the gate reading's assertions on a machine with no MSVC.
 *
 * `cargo test` does not exist here — `.claude/rules/build.md` has the whole of
 * why, and the short version is that rustc reaches for a bare `link.exe` and
 * finds GNU coreutils' `link`. So `bash tools/check-gnu.sh --profile test`
 * *typechecks* the assertions in `hooks.rs` and executes none of them, which is
 * worth saying out loud because a green `--profile test` reads exactly like a
 * green test run and is not one.
 *
 *     bun tools/lift-gates.ts
 *
 * **It regenerates from source on every run and keeps nothing**, for the reason
 * `tools/lift-servers.ts` states at length: a copy that can go stale will, and
 * it goes on passing while it does (ac3883e). Sink 276f26ca records the same
 * caveat from the other side — a lift proves the text you lifted, not the file
 * on disk — which is why this is run *alongside* `--profile test` rather than
 * instead of it. Do both or you have proved nothing.
 *
 * ### Why this one is worth having
 *
 * Everything lifted here produces **prose a card reads and then acts on**, which
 * looks like the least testable thing in the crate and is the most load-bearing.
 * `standing_gates` is the whole card-facing half of sink 3ebe1d59: it is what
 * replaces a broadcast to every card on the wall, an hour-late retraction of it,
 * and three independent diagnoses of one breakage. If its wording claims more
 * than was observed, it *is* that retracted broadcast, in a different envelope.
 * So "does the reading state its own limits" is not a copy-editing question, it
 * is the correctness question — and the tests assert it.
 *
 * It also needs **no dependency at all**, which is the cheapest of the three
 * lift tiers in sink 276f26ca: `standing_gates`, `who` and `ago` build a String
 * and touch no `serde_json`, so bare `rustc --test` is enough and this is
 * immune to whatever state the crate's dependency graph is in. That mattered on
 * the afternoon this feature comes from, when a `vergen`/`vergen_lib` conflict
 * had `cargo check` red for every card at once.
 *
 * `GateRun` is lifted out of `store.rs`, which is where it lives — the lift is
 * flat, so `crate::store::` comes off on the way in, and that rewrite is the one
 * place this script can lie about the code it is testing. It proves the bodies
 * are right and cannot prove the paths are.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const HOOKS = "src-tauri/src/hooks.rs";
const STORE = "src-tauri/src/store.rs";

/** Which file each item comes out of, in the order they have to be declared. */
const ITEMS: [string, string][] = [
  [STORE, "struct GateRun"],
  [HOOKS, "const GATE_STALE_MS"],
  [HOOKS, "const GATE_RUNNING_MS"],
  [HOOKS, "fn ago"],
  [HOOKS, "fn who"],
  [HOOKS, "fn standing_gates"],
];

/** The fixtures the tests build with, out of the test module. */
const HELPERS: string[] = ["const ME", "const OTHER", "fn gate_run"];

const TESTS: string[] = [
  /* The quiet path first. A reading that spoke when there was nothing to say
     would cost every card on the wall context on every prompt, forever. */
  "a_healthy_tree_is_silent",
  "my_own_work_is_not_narrated_to_me",
  /* The thing it is for. */
  "a_red_gate_somebody_else_saw_is_handed_over_with_its_provenance",
  "each_gate_speaks_for_itself",
  "an_observation_outlives_the_card_that_made_it",
  /* The bound that makes it bearable on every prompt, and its inverse — which
     is the case that must not be silenced along with it. */
  "a_card_that_has_since_run_the_gate_itself_is_told_nothing",
  "an_older_observation_of_mine_does_not_silence_a_newer_one_of_theirs",
  /* Staleness, in both directions: a stale red is a stale green with the sign
     flipped, and both send a card hunting something that is not there. */
  "nothing_here_speaks_about_yesterday",
  "the_newest_settled_run_decides_and_order_is_not_trusted",
  /* A gate in flight, which exists to stop two cards fighting for the cargo
     lock — observed all that afternoon. */
  "a_gate_running_right_now_says_so_rather_than_saying_nothing",
  "an_ancient_unsettled_row_is_not_announced_as_running",
  /* What a run may claim about itself. */
  "a_partial_run_does_not_claim_the_whole_gate",
  "a_flapping_gate_says_so_and_names_the_reason_it_usually_is",
  "one_change_is_not_flapping",
  /* And the one that keeps this from becoming the retracted broadcast. */
  "the_reading_states_its_own_limits_and_names_the_banned_escape",
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

/** From a declaration line to its closing brace, by depth. Handles the one-line
 *  `const` form too, which has no brace at all. */
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
  "//! GENERATED by tools/lift-gates.ts — do not edit, do not keep.",
  /* `GateRun` derives Serialize in `store.rs`, which is neither available here
     nor what the lift is after; the fields and Clone are. The attribute lines
     come off and Clone goes back on, so `r.clone()` in the fixtures still
     compiles against the same shape. */
  "#[derive(Debug, Clone)]",
  find(STORE, "struct GateRun").replace(/^#\[[^\]]*\]\s*$/gm, ""),
  ...ITEMS.filter(([, w]) => w !== "struct GateRun").map(([f, w]) => find(f, w)),
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  ...HELPERS.map(findInTests),
  ...TESTS.map(findTest),
  "}",
].join("\n\n");

const dir = mkdtempSync(join(tmpdir(), "lift-gates-"));
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
