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
 * the sink reads from outside the assistant lines. Since phase 6a it also runs
 * the tool classifier, a result's size and error bit, the four receipt shapes
 * and the history log's numstat. All of it pure.
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
const SESSIONS = "src-tauri/src/sessions.rs";
/* The prompt vocabulary and the redactor are compiled whole, from their own
   files, because `Reading::prompt` calls them and they have no dependency the
   lift does not already link. `prompt.rs` reaches `crate::redact::fence_blocks`,
   which resolves here for the same reason it resolves in the app: both are
   modules of the crate this file is the root of. */
const PROMPT = "src-tauri/src/prompt.rs";
const REDACT = "src-tauri/src/redact.rs";

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
  /* `Batch` holds `Vec<Prompt>`, and `Prompt` names `prompt::Form`, so both
     come in with the sink that fills it. */
  "struct Prompt",
  "struct Batch",
  /* The tool and work reader (§3.7, §3.9; phase 6a). `Batch` holds these and
     `Reading::tools` fills them, so the shapes come in with the sink. */
  "struct ToolCall",
  "struct ToolResult",
  "struct Receipt",
  "struct ToolShape",
  /* The instruction-file writes and the account/provider/model moves (§3.9,
     the invalidation half). `Batch` holds the writes, so the struct and the
     parser that fills it come in with the sink — the list had neither, and
     this script has been failing to compile since the invalidation work
     landed, which is the one failure mode a lift must not have: it printed
     `E0425` and ran no assertion at all. */
  "struct InstructionWrite",
  "fn parse_writes",
  "const WRITE_TOOLS",
  "fn write_path",
  "fn instruction_kind",
  "const MAX_INVALIDATE_REF",
  "fn classify_tool",
  "fn parse_tool_use",
  "fn content_size",
  "struct ParsedResult",
  "fn parse_tool_result",
  "struct ParsedReceipt",
  "fn parse_receipts",
  "fn dedupe_receipts",
  "fn is_hex",
  "fn bracket_commit",
  "fn conflict_paths",
  "fn pr_link",
  "fn quoted_after",
  "struct HistCommit",
  "fn parse_numstat_log",
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
  /* Phase 6a's pure half: the tool classifier, the result's size and error
     bit, the four receipt shapes, and the history log's numstat. The fold and
     the sweep need a database and stay CI's. */
  "a_tool_name_is_reduced_to_the_dimensions_the_fact_has",
  "a_result_keeps_its_size_and_never_its_content",
  "a_commit_receipt_parses_branch_and_sha",
  "a_pr_receipt_names_its_number",
  "a_conflict_names_its_paths",
  "a_history_commit_carries_its_numstat_and_parents",
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

/** The one function `Reading::prompt` needs from `sessions.rs`, with the marker
 *  list and the two enums it decides with. Whole-file was not an option: that
 *  module's tests reach `crate::store` for a uuid, so it is lifted by item like
 *  analytics itself. */
function sessionsModule(): string {
  const src = open(SESSIONS);
  const items = [
    "enum Why",
    "const INJECTED",
    "const WALL",
    "const MAX_PROMPT_BYTES",
    "fn resend_marked",
    "enum Folded",
    "fn without_tag",
    "fn carries_text",
    "fn fold",
  ];
  return ["pub mod sessions {", ...items.map((i) => find(src, i)), "}"].join("\n\n");
}

/** The prompt vault, **stubbed, and it says so**.
 *
 *  `Prompt` and `Reading` name `crate::promptvault::Body`, `PromptVault` and
 *  `decide`, and the real module needs the store and a key — so it cannot be
 *  lifted onto a machine with no rusqlite, which is the whole reason this file
 *  exists. Nothing here asserts anything about a body: the stub answers
 *  `locked` with a locator, which is exactly what a wall with no vault gets.
 *  A copy of the real `decide` would be a second implementation that could
 *  drift and be believed; a stub this small cannot be mistaken for one. */
function promptvaultModule(): string {
  return `pub mod promptvault {
    #[derive(Clone)]
    pub(crate) struct Body {
        pub(crate) state: &'static str,
        pub(crate) vault_id: String,
        pub(crate) sealed: Option<Vec<u8>>,
        pub(crate) truncated: bool,
        pub(crate) locator: Option<(String, u64)>,
        pub(crate) captured_at: i64,
    }
    pub struct PromptVault;
    pub(crate) fn decide(
        _vault: Option<&PromptVault>,
        _host: &str,
        _session: &str,
        _prompt_id: &str,
        _first_at: i64,
        _redacted: &crate::redact::Redacted,
        path: &str,
        off: u64,
    ) -> Body {
        Body {
            state: "locked",
            vault_id: String::new(),
            sealed: None,
            truncated: false,
            locator: Some((path.to_string(), off)),
            captured_at: 0,
        }
    }
}`;
}

const analytics = open(ANALYTICS);
const usage = open(USAGE);

const body = [
  "//! GENERATED by tools/lift-analytics.ts — do not edit, do not keep.",
  "use std::collections::{HashMap, HashSet};",
  "use std::path::{Path, PathBuf};",
  /* The prompt module is a file rather than a block list here, so it is written
     beside this one and declared; see `PROMPT`. */
  "mod redact;",
  "mod prompt;",
  "use prompt::Form;",
  /* `analytics.rs` caps a reference with `crate::clip::preview`, which is a
     re-export of the flyway core's. That crate is not linked here, and the cap
     is not what these assertions are about: every reference in a lifted test is
     far under `MAX_INVALIDATE_REF`, so a preview that cuts at the cap and does
     nothing else answers identically. Written as a stub rather than an import
     so the lift keeps needing nothing but the app's own rlibs. */
  "pub mod clip {",
  "    pub fn preview(text: &str, max: usize) -> String {",
  "        if text.chars().count() <= max { return text.to_string(); }",
  "        text.chars().take(max).collect()",
  "    }",
  "}",
  creditsModule(),
  providerModule(),
  sessionsModule(),
  promptvaultModule(),
  "use sessions::Folded;",
  ["pub mod usage {", ...USAGE_ITEMS.map((i) => find(usage, i)), "}"].join("\n\n"),
  "use usage::{epoch_ms, Record};",
  ...ANALYTICS_ITEMS.map((i) => find(analytics, i)),
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  /* The fixture helper the tests share, lifted with them rather than written
     again here — a copy of it would be a second parser drifting from the one
     `usage.rs` exports. */
  findTest(analytics, "record"),
  /* The timestamp fixtures the phase 6a parser tests read their lines from. */
  findTest(analytics, "stamp"),
  findTest(analytics, "civil_from_days"),
  findTest(analytics, "call_line"),
  findTest(analytics, "result_line"),
  ...TESTS.map((t) => findTest(analytics, t)),
  "}",
].join("\n\n");

const dir = mkdtempSync(join(tmpdir(), "lift-analytics-"));
const file = join(dir, "lifted.rs");
const exe = join(dir, "lifted.exe");
writeFileSync(file, body);
/* Declared above as `mod prompt;` / `mod redact;`, so they have to be siblings
   of the root or rustc looks in the wrong directory. */
writeFileSync(join(dir, "prompt.rs"), readFileSync(PROMPT, "utf8"));
writeFileSync(join(dir, "redact.rs"), readFileSync(REDACT, "utf8"));

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
