/* Actually run the analytics ingest's pure assertions on a machine with no MSVC.
 *
 *     bun tools/lift-analytics.ts
 *
 * `cargo test` cannot link here (`.claude/rules/build.md`), so
 * `tools/check-gnu.sh --profile test` *typechecks* `analytics.rs`'s tests and
 * runs none of them — and a green `--tests` reads exactly like a green test run.
 * This is the half of phase 2b's suite that can be executed here.
 *
 * ### What it covers, and what it deliberately does not
 *
 * The bucket and hour boundaries, the ladder's four arms, the provider
 * sentinel, a subagent's depth, a replaced file's resume offset, the session
 * merge's first-and-last rules, the version comparison, and the two records
 * the sink reads from outside the assistant lines. All of it pure.
 *
 * **Not covered: anything that opens a database.** `a_request_is_folded_once…`
 * and `the_hour_is_the_sum_of_its_facts` need `store::migrate` and rusqlite,
 * which cannot be pulled in by block extraction — they are CI's, and the header
 * says so rather than letting a green run read as the whole suite.
 *
 * Everything is regenerated from the sources on every run and nothing is kept,
 * for the reason every `lift-*.ts` here gives: a copy that can go stale will,
 * and it goes on passing while it does.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { blockAt, depsDir, rustEnv, newestRlib } from "./lift-scan.ts";

const ANALYTICS = "src-tauri/src/analytics.rs";
const USAGE = "src-tauri/src/usage.rs";
const PROVIDER = "src-tauri/src/provider.rs";
const CREDITS = "src-tauri/src/credits.rs";

/** The declarations, in an order that lets each name be found when it is used.
 *
 *  Listed as what comes *in* rather than what stays out: a new pure function in
 *  `analytics.rs` and not here is simply untested, which is quiet — where a new
 *  *impure* one breaks this script loudly, which is the safer direction. */
const ANALYTICS_ITEMS: string[] = [
  "const BUCKET_MS",
  "const HOUR_MS",
  "struct Mark",
  "fn resume_at",
  "struct FileMark",
  "struct Batch",
  "struct Reading",
  "impl Reading",
  "struct Span",
  "struct Funding",
  "fn funding_at",
  "fn provider_of",
  "fn source_of",
  "fn source_rank",
  "fn resolve_agent",
  "fn depth_of",
  "fn hour_of",
  "fn bucket_of",
  "struct SessionNow",
  "struct SessionOld",
  "struct SessionWrite",
  "struct Card",
  "fn version_cmp",
  "fn version_less",
  "fn merge_session",
];

/** `Record` and the parser, from `usage.rs`: the sink's own input type, and the
 *  dedupe key test reads it through the same function the pass does. */
const USAGE_ITEMS: string[] = [
  "struct Totals",
  "struct Record",
  "fn epoch_ms",
  "fn offset_ms",
  "fn days_from_civil",
  "fn int",
  "fn read_record",
];

const TESTS: string[] = [
  "a_request_lands_in_its_five_minute_bucket",
  "an_hour_is_a_utc_hour",
  "the_dedupe_key_is_the_message_and_the_request",
  "the_ladder_takes_the_turn_then_the_owner_then_unknown",
  "a_request_no_turn_covers_takes_its_provider_from_the_card",
  "a_turn_that_named_its_own_identity_keeps_it",
  "an_open_turn_covers_the_requests_after_its_open",
  "a_provider_card_is_named_by_its_sentinel_and_not_by_its_model",
  "a_subagent_is_as_deep_as_its_links_prove",
  "a_replaced_file_is_read_from_zero",
  "a_session_records_the_funding_it_started_and_ended_on",
  "a_version_is_compared_as_a_number",
  "the_spawning_call_names_the_child_and_its_parent",
  "a_session_owner_is_read_once_and_kept",
  "a_file_is_only_consumed_to_its_last_newline",
];

type Src = { lines: string[]; testsAt: number; where: string };

function open(path: string): Src {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s*mod tests\s*\{/.test(l));
  return { lines, testsAt: at < 0 ? lines.length : at, where: path };
}

function find(src: Src, what: string): string {
  const re = new RegExp(`^\\s*(pub(\\([a-z]+\\))?\\s+)?${what.replace(/ /g, "\\s+")}\\b`);
  for (let i = 0; i < src.testsAt; i++) {
    if (re.test(src.lines[i])) return blockAt(src.lines, i, src.where);
  }
  throw new Error(`could not find "${what}" in ${src.where} — has it been renamed?`);
}

function findTest(src: Src, name: string): string {
  for (let i = src.testsAt; i < src.lines.length; i++) {
    if (new RegExp(`^\\s*fn ${name}\\s*\\(`).test(src.lines[i])) {
      return blockAt(src.lines, i, src.where);
    }
  }
  throw new Error(`could not find test "${name}" in ${src.where} — has it been renamed?`);
}

/** The provider table, lifted rather than restated: `provider_of` calls
 *  `crate::provider::of`, and the whole point of §4.1's test is that the
 *  sentinel comes out of the same table the spawn uses. */
function providerModule(): string {
  const src = open(PROVIDER);
  return [
    "pub mod provider {",
    find(src, "const DEEPSEEK"),
    find(src, "struct Provider"),
    find(src, "const PROVIDERS"),
    find(src, "fn of"),
    "}",
  ].join("\n\n");
}

/** The credits sentinel, read out of `credits.rs` so this cannot agree with a
 *  stale copy of it. */
function creditsModule(): string {
  const m = /pub const LABEL:\s*&str\s*=\s*("(?:[^"\\]|\\.)*");/.exec(
    readFileSync(CREDITS, "utf8"),
  );
  if (!m) throw new Error(`could not find LABEL in ${CREDITS} — has it been renamed?`);
  return `pub mod credits {\n    pub const LABEL: &str = ${m[1]};\n}`;
}

const analytics = open(ANALYTICS);
const usage = open(USAGE);

const body = [
  "//! GENERATED by tools/lift-analytics.ts — do not edit, do not keep.",
  "use std::collections::{HashMap, HashSet};",
  "use std::path::{Path, PathBuf};",
  creditsModule(),
  providerModule(),
  ["pub mod usage {", ...USAGE_ITEMS.map((i) => find(usage, i)), "}"].join("\n\n"),
  "use usage::Record;",
  ...ANALYTICS_ITEMS.map((i) => find(analytics, i)),
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  /* The fixture helper the tests share, lifted with them rather than written
     again here — a copy of it would be a second parser drifting from the one
     `usage.rs` exports. */
  findTest(analytics, "record"),
  ...TESTS.map((t) => findTest(analytics, t)),
  "}",
].join("\n\n");

const dir = mkdtempSync(join(tmpdir(), "lift-analytics-"));
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
      `serde_json=${newestRlib("serde_json")}`,
      "-L",
      `dependency=${depsDir()}`,
      file,
      "-o",
      exe,
    ],
    /* Bare `rustc` takes the msvc default toolchain and dies on
       `link: extra operand`, which names nothing that points at the cause. */
    { encoding: "utf8", env: rustEnv() },
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
  /* Nothing is kept on success. */
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the exe may still be held; the temp dir goes when the process does */
  }
}
