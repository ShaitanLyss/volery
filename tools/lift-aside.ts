/* Actually run the side question's assertions on a machine with no MSVC.
 *
 * `cargo test` does not exist here — `.claude/rules/build.md` has the whole of
 * why, and "Writing an assertion nobody can run" is the rule this follows.
 *
 *     bun tools/lift-aside.ts
 *
 * ### What is worth executing here rather than merely compiling
 *
 * **`Asides`' generation counter is the whole of "one at a time per card".** A
 * second `/btw` while the first is still out supersedes it, and the loser's
 * answer is dropped rather than delivered late under a question it does not
 * answer. Every way of getting that wrong compiles: `release` that forgets to
 * check the generation cancels the winner's claim; a counter that starts at the
 * same number twice makes a sleeping thread think it is still current. Neither is
 * visible to a typecheck and both are one line.
 *
 * **`FRAME` is quoted from the CLI and its constraints are load-bearing** — they
 * are what keeps the fork answering instead of picking up tools and working. A
 * reworded frame still compiles, and so does one whose `<system-reminder>` never
 * closes, which is what it shipped as (sink cc3a4f27).
 *
 * Dependency-free: `Asides` is a `Mutex<HashMap>` and an `AtomicU64`, so this is
 * variant 1 of build.md's ladder with no `--extern` at all.
 *
 * **It regenerates from `aside.rs` on every run and keeps nothing.**
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SRC = "src-tauri/src/aside.rs";

/** The pure declarations, in the order they have to be declared. */
const ITEMS: string[] = ["const FRAME", "struct Asides", "impl Asides"];

const TESTS: string[] = [
  "the_frame_asks_for_an_answer_rather_than_work",
  "the_reminder_closes_before_the_question_goes_in",
  "a_second_aside_supersedes_the_first",
  "one_card_does_not_cancel_anothers",
  "a_generation_is_never_handed_out_twice",
];

const lines = readFileSync(SRC, "utf8").split(/\r?\n/);

/** Where a declaration starts, including the doc comments and attributes above
 *  it — a lift that dropped `#[derive(Default)]` would compile into a different
 *  thing and say so only at the call site. */
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
 *  from `lift-project.ts`. `FRAME` has no braces in it today and `Asides` has
 *  none either, so the naive counter would do; this is here because sink
 *  4b20ad50 is about seven scripts that used the naive one and bit the first
 *  person to lift something with a brace in a string. */
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
  if (/;\s*$/.test(head) && !head.includes("{")) {
    /* A `const` whose value runs over several lines with a `\` continuation. */
    let j = i;
    while (j < lines.length && !/;\s*$/.test(lines[j])) j++;
    return lines.slice(startOf(i), j + 1).join("\n");
  }
  if (!head.includes("{") && !/;\s*$/.test(head)) {
    /* A declaration whose `= "..."` continues onto the next lines. */
    let j = i;
    while (j < lines.length && !/;\s*$/.test(lines[j])) j++;
    return lines.slice(startOf(i), j + 1).join("\n");
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

function find(what: string): string {
  const stop = testsAt();
  const re = new RegExp(`^\\s*(pub(\\([a-z]+\\))?\\s+)?${what.replace(/ /g, "\\s+")}\\b`);
  for (let i = 0; i < stop; i++) if (re.test(lines[i])) return block(i);
  throw new Error(`could not find "${what}" in ${SRC} — has it been renamed?`);
}

function findTest(name: string): string {
  for (let i = testsAt(); i < lines.length; i++) {
    if (new RegExp(`^\\s*fn ${name}\\s*\\(`).test(lines[i])) return block(i);
  }
  throw new Error(`could not find test "${name}" in ${SRC} — has it been renamed?`);
}

const body = [
  "//! GENERATED by tools/lift-aside.ts — do not edit, do not keep.",
  "use std::sync::atomic::{AtomicU64, Ordering};",
  "use std::sync::Mutex;",
  ...ITEMS.map(find),
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  ...TESTS.map(findTest),
  "}",
].join("\n\n");

const dir = mkdtempSync(join(tmpdir(), "lift-aside-"));
const file = join(dir, "lifted.rs");
const exe = join(dir, "lifted.exe");
writeFileSync(file, body);

try {
  const build = spawnSync(
    "rustc",
    ["--test", "--edition", "2021", "-A", "dead_code", file, "-o", exe],
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
