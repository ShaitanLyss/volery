/* Actually run the away-pile's note assertions on a machine with no MSVC.
 *
 * `cargo test` does not exist here - `.claude/rules/build.md` has the whole of
 * why, and "Writing an assertion nobody can run" is the rule this follows.
 *
 *     bun tools/lift-presence.ts
 *
 * ### Why this file exists at all
 *
 * Because one of these went red in a **release build** on 2026-10-06 and
 * nowhere earlier. `pile_full`'s tail was reworded while the openings were
 * being split for `Queued`, and the assertion that it still tells a card to
 * "decide it yourself" was left behind - compiled by `cargo check --profile
 * test`, which type-checks a test body and never runs it, so the first thing
 * ever to execute it was the tagged build. A published tag with no installer
 * behind it, for a one-phrase mismatch a second of `rustc --test` catches.
 *
 * What these assertions guard is not cosmetic. These notes are the **entire**
 * contract with an agent whose question went to the pile, and each clause is a
 * way the feature fails silently without it: the question was not lost (or the
 * agent re-asks), nothing was decided (or a non-answer reads as consent, which
 * is `SKIPPED`'s lesson one layer over), the answer arrives as a *message*
 * rather than as this call's return value, and asking again queues a second
 * copy. None of that is visible to a typecheck; all of it is a string.
 *
 * `is_deferral` earns its place for a sharper reason: `park_and_stream` tells
 * one of Volery's own queueing notes from a real answer by asking it and
 * nothing else, so an opening added to `Queued` and not to that function is a
 * deferral the park reads as the user having spoken.
 *
 * Everything lifted is pure - `format!` over consts and a `Copy` enum - which
 * is what makes this possible. The rest of `presence.rs` reaches `AppHandle`
 * and the `Store` and cannot come.
 *
 * ### It regenerates from `presence.rs` on every run and keeps nothing.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { blockAt, depsDir, rustEnv, newestRlib } from "./lift-scan.ts";

const SRC = "src-tauri/src/presence.rs";
const NOTICE = "src-tauri/src/notice.rs";
const DEPS = depsDir();

/** The pure declarations, in the order they have to be declared.
 *
 *  Listing what comes in rather than what stays out, as every other lift here
 *  argues: something added to this group and not added here is untested, which
 *  is quiet — where a lifted function reaching for what this list omits breaks
 *  the build loudly, which is the safer direction to fail in. */
const ITEMS: string[] = [
  "const MAX_PER_CARD",
  "const DEFERRED_OPENING",
  "const UNATTENDED_OPENING",
  "enum Queued",
  "impl Queued",
  "fn is_deferral",
  "fn deferred_note",
  "fn pile_full",
];

/** Nothing is declared inside `mod tests` here. */
const TEST_ITEMS: string[] = [];

const TESTS: string[] = [
  "a_deferred_call_tells_the_agent_all_four_things",
  "a_full_pile_reads_as_a_timeout_rather_than_as_a_queue",
  "an_unattended_question_is_queued_without_claiming_the_wall_is_away",
  "either_opening_reads_as_a_deferral",
];

const lines = readFileSync(SRC, "utf8").split(/\r?\n/);

const block = (i: number): string => blockAt(lines, i, SRC);

function testsAt(): number {
  const at = lines.findIndex((l) => /^\s*mod tests\s*\{/.test(l));
  if (at < 0) throw new Error(`no test module in ${SRC}`);
  return at;
}

function findIn(what: string, from: number, to: number): string {
  const re = new RegExp(`^\\s*(pub(\\([a-z()]+\\))?\\s+)?${what.replace(/ /g, "\\s+")}\\b`);
  for (let i = from; i < to; i++) if (re.test(lines[i])) return block(i);
  throw new Error(`could not find "${what}" in ${SRC} — has it been renamed?`);
}

const find = (what: string) => findIn(what, 0, testsAt());
const findInTests = (what: string) => findIn(what, testsAt(), lines.length);

function findTest(name: string): string {
  for (let i = testsAt(); i < lines.length; i++) {
    if (new RegExp(`^\\s*fn ${name}\\s*\\(`).test(lines[i])) return block(i);
  }
  throw new Error(`could not find test "${name}" in ${SRC} — has it been renamed?`);
}

/** `serde_json`'s rlib, found by hash rather than named. Its own dependencies
 *  (itoa, ryu, memchr, serde) come off `-L dependency`, which is why only the
 *  one `--extern` is needed. */
function serdeJsonRlib(): string {
  return newestRlib("serde_json");
}

const rlib = serdeJsonRlib();

/** `is_deferral` asks `crate::notice::QUEUED_OPENING`, the third opening, so the
 *  real constant comes in a module of that name rather than a copy of its text —
 *  a copy would pass when the two had drifted, which is what the test is for. */
const noticeLines = readFileSync(NOTICE, "utf8").split(/\r?\n/);
const queuedAt = noticeLines.findIndex((l) => /^\s*pub const QUEUED_OPENING\b/.test(l));
if (queuedAt < 0) throw new Error(`could not find "const QUEUED_OPENING" in ${NOTICE} — has it been renamed?`);

const body = [
  "//! GENERATED by tools/lift-presence.ts — do not edit, do not keep.",
  "use serde_json::{json, Value};",
  `mod notice {\n${blockAt(noticeLines, queuedAt, NOTICE)}\n}`,
  ...ITEMS.map(find),
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  ...TEST_ITEMS.map(findInTests),
  ...TESTS.map(findTest),
  "}",
].join("\n\n");

const dir = mkdtempSync(join(tmpdir(), "lift-presence-"));
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
      `serde_json=${rlib}`,
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
      env: rustEnv(),
    },
  );
  if (build.status !== 0) {
    console.error(build.stderr || build.stdout);
    console.error(`\nthe lift is at ${file} — it was NOT removed, so you can read it.`);
    process.exit(1);
  }
  const run = spawnSync(exe, [], { encoding: "utf8" });
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
