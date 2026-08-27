/* Actually run the music selector's pure assertions on a machine with no MSVC.
 *
 * `cargo test` does not exist here — `.claude/rules/build.md` has the whole of
 * why, and the short version is that rustc reaches for a bare `link.exe` and
 * finds GNU coreutils' `link`. So `bash tools/check-gnu.sh --profile test`
 * *typechecks* the assertions in `selector.rs` and cannot execute one of them,
 * which is worth saying out loud because a green `--profile test` reads exactly
 * like a green test run and is not one.
 *
 *     bun tools/lift-selector.ts
 *
 * **It regenerates from `selector.rs` on every run and keeps nothing**, for the
 * reason `tools/lift-board.ts` and `tools/lift-servers.ts` both say at length:
 * a copy that can go stale will, and it goes on passing while it does.
 *
 * ### What is worth executing here rather than merely compiling
 *
 * Two things, and they are the two that cannot be eyeballed.
 *
 * **The uri parsing.** `normalize_uri` accepts three shapes because those are
 * the three that arrive — the uri proper, the share link with its `?si=`
 * tracking parameter, and the share link with an `intl-de` locale segment
 * Spotify inserts for some accounts and not others. That last one is exactly
 * the bug that works on the machine it was written on and fails on the next,
 * and a typecheck has nothing to say about it.
 *
 * **The refusal.** `refuse_while_playing` is the entire transport boundary —
 * the user's "not volume, not play/pause" is enforced by that one function and
 * by the absence of any other verb. On this wall a refusal *is* the guard:
 * there is nothing downstream to catch an agent that talks its way past one. So
 * "does it refuse while playing, and does the refusal say what to do instead"
 * is the correctness question, not a copy-editing one, and it is asserted.
 *
 * It borrows `serde_json` out of the target directory the way `lift-board.ts`
 * does, since the schemas and the search parser both fold a `Value`.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const DEPS = "src-tauri/target/x86_64-pc-windows-gnu/debug/deps";
const SELECTOR = "src-tauri/src/selector.rs";

/** The pure declarations, in the order they have to be declared.
 *
 *  Everything `selector.rs` holds *except* the four items that reach outside it
 *  — `fetch_search` (ureq), `do_records`, `do_put_on` and `handle` (an
 *  `AppHandle`). Listing what comes in rather than what stays out is deliberate:
 *  a new pure function added to that file and not added here simply is not
 *  tested, which is quiet, where a new *impure* one would break this script
 *  loudly. The quiet failure is the safer direction for a lift. */
const ITEMS: string[] = [
  "const RECORDS_TOOL",
  "const PUT_ON_TOOL",
  "const DEFAULT_LIMIT",
  "const MAX_LIMIT",
  "const DEFAULT_TYPES",
  "const KINDS",
  "fn encode",
  "fn normalize_uri",
  "fn is_context",
  "fn search_url",
  "fn clean_types",
  "struct Hit",
  "fn str_at",
  "fn artists_of",
  "fn fmt_ms",
  "fn parse_hits",
  "fn render_hits",
  "fn tally",
  "fn refuse_while_playing",
  "fn records_schema",
  "fn put_on_schema",
];

const TESTS: string[] = [
  /* What a card is allowed to name, and the three shapes that actually arrive. */
  "a_uri_survives_being_a_uri",
  "a_share_link_loses_its_tracking_parameter",
  "an_intl_segment_is_skipped",
  "a_bare_host_is_still_a_link",
  "nonsense_is_refused_with_an_example",
  "a_kind_that_cannot_be_played_is_refused",
  "an_empty_uri_points_at_records",
  "contexts_are_the_things_with_tracks_in_them",
  /* The request. */
  "a_query_is_encoded_for_a_query_string",
  "the_limit_is_clamped_both_ways",
  "the_market_is_the_users_own",
  "unknown_types_fall_back_rather_than_refusing",
  /* Reading Spotify's answer, including the null it really returns. */
  "a_track_reads_with_its_album_and_length",
  "a_null_playlist_does_not_take_the_answer_with_it",
  "a_row_with_no_uri_is_dropped",
  "missing_buckets_are_not_an_error",
  "an_album_reads_with_its_year",
  "durations_read_as_minutes_and_seconds",
  "the_uri_leads_every_line",
  "nothing_found_says_so_without_pretending",
  "the_tally_counts_per_kind_and_pluralises",
  /* The boundary — the user's scoping, asserted rather than trusted. */
  "a_quiet_wall_may_be_played_to",
  "a_playing_wall_is_left_alone",
  "the_refusal_carries_a_way_forward",
  "no_schema_offers_a_transport_verb",
  "both_tools_are_named_and_described",
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
 *  different thing and say so only at the assertion. */
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

/** Where the test module begins, so the file proper and the tests can be
 *  searched separately — `fn tally` in the file and a fixture of the same name
 *  in the tests would otherwise be the same match. */
function testsAt(): number {
  const at = linesOf(SELECTOR).findIndex((l) => /^\s*mod tests\s*\{/.test(l));
  if (at < 0) throw new Error(`no test module in ${SELECTOR}`);
  return at;
}

function find(what: string): string {
  const lines = linesOf(SELECTOR);
  const stop = testsAt();
  const re = new RegExp(`^\\s*(pub(\\([a-z]+\\))?\\s+)?${what.replace(/ /g, "\\s+")}\\b`);
  for (let i = 0; i < stop; i++) {
    if (re.test(lines[i])) return block(SELECTOR, i);
  }
  throw new Error(`could not find "${what}" in ${SELECTOR} — has it been renamed?`);
}

function findTest(name: string): string {
  const lines = linesOf(SELECTOR);
  for (let i = testsAt(); i < lines.length; i++) {
    if (new RegExp(`^\\s*fn ${name}\\s*\\(`).test(lines[i])) return block(SELECTOR, i);
  }
  throw new Error(`could not find test "${name}" in ${SELECTOR} — has it been renamed?`);
}

const rlib = readdirSync(DEPS).find((f) => /^libserde_json-[0-9a-f]+\.rlib$/.test(f));
if (!rlib) {
  console.error(
    `no serde_json rlib in ${DEPS} — run \`bash tools/check-gnu.sh\` first so cargo builds one.`,
  );
  process.exit(1);
}

const body = [
  "//! GENERATED by tools/lift-selector.ts — do not edit, do not keep.",
  "use serde_json::{json, Value};",
  ...ITEMS.map(find),
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  ...TESTS.map(findTest),
  "}",
].join("\n\n");

const dir = mkdtempSync(join(tmpdir(), "lift-selector-"));
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
    /* Load-bearing: bare `rustc` takes the msvc default toolchain and dies on
       `link: extra operand`, which names nothing that points at the cause. */
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
