/* Actually run `spawn.rs`'s settle-notice assertions on a machine with no MSVC.
 *
 * `cargo test` does not exist here — `.claude/rules/build.md` has the whole of
 * why, and the short version is that rustc reaches for a bare `link.exe` and
 * finds GNU coreutils' `link`. `bash tools/check-gnu.sh --profile test`
 * *typechecks* the assertions in this crate and cannot execute one of them,
 * which is worth saying out loud because a green `--profile test` reads exactly
 * like a green test run and is not one.
 *
 * The way out that rule names is to lift the pure functions into a throwaway and
 * hand it to `rustc --test`. This is that, scripted, and it is the cheapest of
 * the three variants sink `276f26ca` collects: the functions under test do
 * nothing but build a `String`, so there is no `--extern` and no rlib to find —
 * unlike `tools/lift-smith.ts`, which needs serde_json for its `json!` schemas.
 *
 *     bun tools/lift-spawn.ts
 *
 * **It regenerates from the source file on every run and keeps nothing**, which
 * is the whole reason it is a script rather than a `lifted.rs` somebody re-runs.
 * `joblog.rs`'s twelve tests were once run against a lift taken before a
 * constant was threaded through the function under it, so the green they
 * reported was about a version that no longer existed on disk (ac3883e). A copy
 * that can go stale will, and it goes on passing while it does.
 *
 * What it can reach is exactly the prose half — the envelope, the list, the two
 * bounds. `settling`, `stirring`, `sweep` and `notice` all want an `AppHandle`
 * and a store, and are out of reach of any technique short of an MSVC toolchain.
 * What that leaves unproven is stated in `.claude/rules/spawn.md` rather than
 * hidden here: the fold and the delivery have never been run.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SRC = "src-tauri/src/spawn.rs";

/** The items to lift, named exactly as they are declared. */
const ITEMS = ["const SETTLE_GRACE_MS", "const SETTLE_APART_MS", "fn named", "fn envelope", "fn list"];

/** The tests to lift, by function name. */
const TESTS = [
  "the_wall_speaks_in_an_envelope_the_panel_already_knows",
  "the_notice_answers_the_question_that_was_being_polled",
  "it_counts_in_words_a_reader_expects",
  "names_are_listed_the_way_they_are_said_aloud",
  "a_card_is_named_by_title_and_by_handle",
  "the_grace_outlasts_a_pause_and_the_floor_bounds_the_cost",
];

const src = readFileSync(SRC, "utf8");
const lines = src.split(/\r?\n/);

/** Where a declaration starts, including the doc comments and attributes above
 *  it — a lift that dropped one would compile into a different thing and say so
 *  only at the call site. */
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

/** From a declaration line to its closing brace, by depth. Handles the one-line
 *  `const` form too, which has no brace at all. */
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

/* The one thing these borrow from another module. Lifted verbatim rather than
   stubbed with a guess: `handle_of` is eight characters of the id and the
   envelope's whole addressability rests on it agreeing with what `list` and
   `send` hand back, so a stub that took ten would pass a test about nothing.
   `crate::relay::…` resolves to this, because in a single-file lift the crate
   root is the file. */
const relay = readFileSync("src-tauri/src/relay.rs", "utf8");
function fromRelay(what: string): string {
  const rl = relay.split(/\r?\n/);
  const re = new RegExp(`^\\s*(pub\\s+)?${what.replace(/ /g, "\\s+")}\\b`);
  for (let i = 0; i < rl.length; i++) {
    if (re.test(rl[i])) {
      let depth = 0;
      let seen = false;
      if (/;\s*$/.test(rl[i]) && !rl[i].includes("{")) return rl[i];
      for (let j = i; j < rl.length; j++) {
        for (const ch of rl[j]) {
          if (ch === "{") {
            depth++;
            seen = true;
          } else if (ch === "}") depth--;
        }
        if (seen && depth === 0) return rl.slice(i, j + 1).join("\n");
      }
    }
  }
  throw new Error(`could not find "${what}" in relay.rs — has it been renamed?`);
}

const body = [
  "//! GENERATED by tools/lift-spawn.ts — do not edit, do not keep.",
  `pub mod relay {\n${fromRelay("const RELAY_MARK")}\n${fromRelay("fn handle_of")}\n}`,
  ...ITEMS.map(find),
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  ...TESTS.map(findTest),
  "}",
].join("\n\n");

const dir = mkdtempSync(join(tmpdir(), "lift-spawn-"));
const file = join(dir, "lifted.rs");
const exe = join(dir, "lifted.exe");
writeFileSync(file, body);

try {
  const build = spawnSync("rustc", ["--test", "--edition", "2021", "-A", "dead_code", file, "-o", exe], {
    encoding: "utf8",
    /* Without this, rustc uses the *default* toolchain — msvc here — and dies
       with `link: extra operand`, which is the misleading failure at the top of
       `.claude/rules/build.md`. Sink b282b54c is two cards discovering that the
       documented recipe omits this line. */
    env: { ...process.env, RUSTUP_TOOLCHAIN: "stable-x86_64-pc-windows-gnu" },
  });
  if (build.status !== 0) {
    console.error(build.stderr || build.stdout);
    console.error(`\nthe lift is at ${file} — it was NOT removed, so you can read it.`);
    process.exit(1);
  }
  const run = spawnSync(exe, [], { encoding: "utf8" });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  process.exit(run.status ?? 1);
} finally {
  if (process.exitCode !== 1) rmSync(dir, { recursive: true, force: true });
}
