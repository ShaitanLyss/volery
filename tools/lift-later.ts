/* Actually run the wake envelope's assertions on a machine with no MSVC.
 *
 * `cargo test` does not exist here — `.claude/rules/build.md` has the whole of
 * why, and the short version is that rustc reaches for a bare `link.exe` and
 * finds GNU coreutils' `link`. So `bash tools/check-gnu.sh --tests`
 * *typechecks* `later.rs`'s assertions and cannot execute one of them, which is
 * worth saying out loud because a green `--tests` reads exactly like a green
 * test run and is not one.
 *
 *     bun tools/lift-later.ts
 *
 * **It regenerates from `later.rs` on every run and keeps nothing**, for the
 * reason every other `lift-*.ts` here says at length: a copy that can go stale
 * will, and it goes on passing while it does.
 *
 * ### What is worth executing here rather than merely compiling
 *
 * **`envelope`'s first line is a wire format with a parser at the other end**,
 * and the other end is a regex in TypeScript that no Rust compiler has ever
 * looked at. `relay.ts`'s `WAKE` matches that line whole and lifts the elapsed
 * phrase out of it for the transcript's fold cap. The two disagreed for a
 * fortnight and nothing said so, because disagreeing costs no error — the front
 * end simply drew the wake as something the user had typed (sink af952612). A
 * typecheck cannot see any of that; the assertion can, and only if it runs.
 *
 * **`said` is integer division with two thresholds**, which is the shape that
 * compiles under every off-by-one it has. 90 seconds and 90 minutes are the
 * boundaries, and "1 hours ago" is a thing this function can say.
 *
 * `RELAY_MARK` is lifted out of `relay.rs` beside it rather than written down
 * here, because `a_wake_is_marked_as_its_own_thing` asserts the two marks are
 * *different* — hardcoding one of them would be asserting a constant against
 * itself, which is the failure sink 933c31d6 describes from the other side.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const LATER = "src-tauri/src/later.rs";
const RELAY = "src-tauri/src/relay.rs";

/** The pure declarations, in the order they have to be declared.
 *
 *  Everything in `later.rs` that touches no `AppHandle` and no store. Listing
 *  what comes *in* rather than what stays out is deliberate, the same way
 *  `lift-tunnel.ts` argues it: a new pure function added to that file and not
 *  added here is simply untested, which is quiet — where a new *impure* one
 *  would break this script loudly, which is the safer direction to fail in. */
const ITEMS: string[] = [
  "const MIN_DELAY_S",
  "const MAX_DELAY_S",
  "const MAX_SERVED",
  "const WAKE_MARK",
  "fn said",
  "fn envelope",
];

const TESTS: string[] = [
  /* The wire format, and the reason this script exists. */
  "the_envelope_is_the_shape_the_front_end_parses",
  "a_wake_is_marked_as_its_own_thing",
  /* Integer division with two thresholds. */
  "the_elapsed_time_is_said_at_every_scale",
  "the_range_is_a_wait_rather_than_a_calendar",
];

const lines = readFileSync(LATER, "utf8").split(/\r?\n/);

/** Where a declaration starts, including the doc comments and attributes above
 *  it — a lift that dropped an attribute would compile into a different thing
 *  and say so only at the assertion. */
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

/** From a declaration line to its closing brace, by depth. */
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
  throw new Error(`unterminated block at ${LATER}:${i + 1}`);
}

/** Where the test module begins, so the file proper and the tests are searched
 *  separately — a fixture sharing a name with a function would otherwise be the
 *  same match. */
function testsAt(): number {
  const at = lines.findIndex((l) => /^\s*mod tests\s*\{/.test(l));
  if (at < 0) throw new Error(`no test module in ${LATER}`);
  return at;
}

function find(what: string): string {
  const stop = testsAt();
  const re = new RegExp(`^\\s*(pub(\\([a-z]+\\))?\\s+)?${what.replace(/ /g, "\\s+")}\\b`);
  for (let i = 0; i < stop; i++) {
    if (re.test(lines[i])) return block(i);
  }
  throw new Error(`could not find "${what}" in ${LATER} — has it been renamed?`);
}

function findTest(name: string): string {
  for (let i = testsAt(); i < lines.length; i++) {
    if (new RegExp(`^\\s*fn ${name}\\s*\\(`).test(lines[i])) return block(i);
  }
  throw new Error(`could not find test "${name}" in ${LATER} — has it been renamed?`);
}

/** `crate::relay::RELAY_MARK`, read out of `relay.rs` and re-declared as a
 *  module of the lifted crate — `crate::` resolves to this file's own root, so
 *  the test's path works unedited. Read rather than written down: the whole
 *  point of the assertion is that the two marks differ. */
function relayModule(): string {
  const src = readFileSync(RELAY, "utf8");
  const m = /pub const RELAY_MARK:\s*&str\s*=\s*("(?:[^"\\]|\\.)*");/.exec(src);
  if (!m) throw new Error(`could not find RELAY_MARK in ${RELAY} — has it been renamed?`);
  return `pub mod relay {\n    pub const RELAY_MARK: &str = ${m[1]};\n}`;
}

const body = [
  "//! GENERATED by tools/lift-later.ts — do not edit, do not keep.",
  relayModule(),
  ...ITEMS.map(find),
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  ...TESTS.map(findTest),
  "}",
].join("\n\n");

const dir = mkdtempSync(join(tmpdir(), "lift-later-"));
const file = join(dir, "lifted.rs");
const exe = join(dir, "lifted.exe");
writeFileSync(file, body);

try {
  const build = spawnSync(
    "rustc",
    ["--test", "--edition", "2021", "-A", "dead_code", file, "-o", exe],
    /* Load-bearing: bare `rustc` takes the msvc default toolchain and dies on
       `link: extra operand`, which names nothing that points at the cause.
       Two cards found this independently — sink b282b54c and 276f26ca. */
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
