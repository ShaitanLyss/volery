/* Actually run the swallowed-argument check's assertions on a machine with no
 * MSVC.
 *
 * `cargo test` does not exist here — `.claude/rules/build.md` has the whole of
 * why, and "Writing an assertion nobody can run" is the rule this follows.
 *
 *     bun tools/lift-ask.ts
 *
 * ### What is worth executing here rather than merely compiling
 *
 * `swallowed` decides whether a tool call is refused, and it is on the path of
 * **every** call this server answers — the two that park and the whole roster
 * chain below them. Both directions of it are load-bearing and neither is
 * visible to a typecheck:
 *
 * - A false negative is the bug it was written for coming back: a wall of raw
 *   XML in front of the user where three buttons should have been, and nothing
 *   at either end saying so (sink `b6a278c1`).
 * - A false positive refuses a call that was fine. The escape hatch — pass the
 *   argument the text names — is the only thing that makes a refusal safe here,
 *   and it is one `&&` away from not existing.
 *
 * `declarations` is the other reason. It walks a string by hand rather than with
 * a regex, so an unterminated tag at the end of a text is an input that could
 * spin or panic on a thread holding somebody's turn open — and "it compiles" is
 * no evidence at all about that.
 *
 * `the_check_reads_the_tools_own_schema` is deliberately **not** lifted: it
 * calls `roster()`, which is the whole of `ask.rs`'s dependency graph. It runs
 * under `cargo test` on a machine that has one.
 *
 * ### It regenerates from `ask.rs` on every run and keeps nothing.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SRC = "src-tauri/src/ask.rs";
const DEPS = "src-tauri/target/x86_64-pc-windows-gnu/debug/deps";

/** The pure declarations, in the order they have to be declared.
 *
 *  Listing what comes in rather than what stays out, as every other lift here
 *  argues: something added to this group and not added here is untested, which
 *  is quiet — where a lifted function reaching for what this list omits breaks
 *  the build loudly, which is the safer direction to fail in. */
const ITEMS: string[] = [
  "const DECLARATION",
  "struct Swallowed",
  "fn strings_in",
  "fn declarations",
  "fn swallowed",
  "fn swallowed_note",
];

/** Consts declared inside `mod tests`, which `findTest` does not reach. */
const TEST_ITEMS: string[] = ["const ASK_ARGS"];

const TESTS: string[] = [
  "an_argument_that_arrived_inside_another_one_is_found",
  "quoting_the_syntax_is_allowed_when_the_argument_is_also_passed",
  "a_tag_naming_no_argument_of_this_tool_is_left_alone",
  "an_argument_lost_inside_a_nested_question_is_found_too",
  "a_tag_that_never_closes_names_nothing",
  "an_ordinary_call_is_not_examined_at_all",
  "the_refusal_names_what_was_lost_and_where_it_went",
];

const lines = readFileSync(SRC, "utf8").split(/\r?\n/);

/** Where a declaration starts, including the doc comments and attributes above
 *  it — a lift that dropped `#[derive(PartialEq)]` would compile into a
 *  different thing and say so only at the call site. */
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

/** Brace depth, counting only braces that are code — the string-aware version
 *  from `lift-project.ts`. Not optional here: `swallowed`'s own doc comment
 *  quotes `<parameter name="options">[{…}]`, braces and all, three lines above
 *  the function this has to delimit. That is sink `4b20ad50` exactly, and the
 *  naive counter every older lift uses would swallow the rest of the file. */
function scan(line: string, state: { depth: number; comment: boolean }): void {
  let k = 0;
  if (state.comment) {
    const end = line.indexOf("*/");
    if (end < 0) return;
    k = end + 2;
    state.comment = false;
  }
  for (; k < line.length; k++) {
    const ch = line[k];
    if (ch === "/" && line[k + 1] === "/") return;
    if (ch === "/" && line[k + 1] === "*") {
      const end = line.indexOf("*/", k + 2);
      if (end < 0) {
        state.comment = true;
        return;
      }
      k = end + 1;
      continue;
    }
    if (ch === '"') {
      k++;
      while (k < line.length && line[k] !== '"') k += line[k] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === "'") {
      const m = /^'(\\.|[^'\\])'/.exec(line.slice(k));
      if (m) k += m[0].length - 1;
      continue;
    }
    if (ch === "{") state.depth++;
    else if (ch === "}") state.depth--;
  }
}

function block(i: number): string {
  const head = lines[i];
  if (!head.includes("{") && !/;\s*$/.test(head)) {
    /* A declaration whose value continues onto the next lines. */
    let j = i;
    while (j < lines.length && !/;\s*$/.test(lines[j])) j++;
    return lines.slice(startOf(i), j + 1).join("\n");
  }
  if (/;\s*$/.test(head) && !head.includes("{")) {
    return lines.slice(startOf(i), i + 1).join("\n");
  }
  const state = { depth: 0, comment: false };
  let seen = false;
  for (let j = i; j < lines.length; j++) {
    scan(lines[j], state);
    if (state.depth > 0) seen = true;
    if (seen && state.depth === 0) return lines.slice(startOf(i), j + 1).join("\n");
  }
  throw new Error(`unterminated block at ${SRC}:${i + 1}`);
}

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
  let names: string[];
  try {
    names = readdirSync(DEPS);
  } catch {
    throw new Error(
      `${DEPS} does not exist — run \`bash tools/check-gnu.sh\` once so cargo builds the rlibs this borrows.`,
    );
  }
  const hit = names.filter((n) => /^libserde_json-[0-9a-f]+\.rlib$/.test(n));
  if (!hit.length) throw new Error(`no libserde_json-*.rlib in ${DEPS} — run tools/check-gnu.sh first`);
  /* Several hashes means several graphs' worth of artefacts. Newest wins, and
     it says so rather than choosing silently — if the pick is wrong, rustc
     refuses to link rather than producing something subtly other. */
  if (hit.length > 1) console.error(`note: ${hit.length} serde_json rlibs in ${DEPS}, using ${hit[hit.length - 1]}`);
  return join(DEPS, hit[hit.length - 1]);
}

const rlib = serdeJsonRlib();

const body = [
  "//! GENERATED by tools/lift-ask.ts — do not edit, do not keep.",
  "use serde_json::{json, Value};",
  ...ITEMS.map(find),
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  ...TEST_ITEMS.map(findInTests),
  ...TESTS.map(findTest),
  "}",
].join("\n\n");

const dir = mkdtempSync(join(tmpdir(), "lift-ask-"));
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
      env: { ...process.env, RUSTUP_TOOLCHAIN: "stable-x86_64-pc-windows-gnu" },
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
