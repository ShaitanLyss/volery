/* Actually run `supervisor.rs`'s selfhood assertions on a machine with no MSVC.
 *
 * `cargo test` does not exist here — `.claude/rules/build.md` has the whole of
 * why. `bash tools/check-gnu.sh --profile test` *typechecks* the assertions and
 * cannot execute one of them, which is worth saying out loud because a green
 * `--profile test` reads exactly like a green test run and is not one.
 *
 *     bun tools/lift-selfhood.ts
 *
 * What it reaches is the prose: `append_prompt` composes a `String` out of two
 * plain structs and a `&str` constant, so there is no `AppHandle`, no store and
 * no rlib to find — variant 1 of build.md's ladder, the cheapest there is.
 *
 * **What it deliberately cannot reach** is the four assertions in that module
 * that ask `ask::dispatch` what the server advertises. Those need the whole
 * crate, and they are the ones that would catch a *renamed tool* rather than a
 * misworded sentence. So a green here says the clauses say what they should say
 * to a card; it does not say the tools they name exist. `check-gnu.sh
 * --profile test` is what holds up the other end, by typechecking them.
 *
 * **It regenerates from the source on every run and keeps nothing.** A copy that
 * can go stale will, and it goes on passing while it does — `joblog.rs`'s twelve
 * tests were once run against a lift taken before a constant was threaded
 * through the function under it (ac3883e).
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SRC = "src-tauri/src/supervisor.rs";
const STORE = "src-tauri/src/store.rs";

/** The items to lift out of `supervisor.rs`, named as they are declared. */
const ITEMS = ["const MCP_PREFIX", "struct Selfhood", "fn append_prompt"];

/** And the one thing they borrow from another module. Lifted verbatim rather
 *  than stubbed: `Provenance`'s `elsewhere` is the field the whole of sink
 *  `0cf05791` turns on, and a stub that got its meaning backwards would pass a
 *  test about nothing. */
const FROM_STORE = ["struct Provenance"];

/** The tests. The four that ask the MCP server what it advertises are absent on
 *  purpose — see the note at the top. */
const TESTS = [
  "selves",
  "fullest",
  "a_chat_card_is_not_told_who_it_is",
  "a_card_is_told_its_own_handle",
  "a_spawned_card_is_told_who_opened_it",
  "a_card_the_user_opened_is_told_no_such_thing",
];

/** Brace depth, counting only braces that are *code*.
 *
 *  Lifted from `tools/lift-project.ts`, which is the one script that has this
 *  right — the seven older ones count every `{` and `}` on the line, strings and
 *  comments included, and sink `4b20ad50` is what that costs. It matters here
 *  rather than being defensive: `append_prompt` is nothing *but* format strings,
 *  and every `{MCP_PREFIX}` in one is a brace a naive counter would open a block
 *  on. The failure is loud and names the wrong place — rustc reports an unclosed
 *  delimiter against `mod tests {`, hundreds of lines from the cause.
 *
 *  Handles `"…"` with backslash escapes, `r"…"` / `r#"…"#`, `'c'` char literals,
 *  `//` to end of line and `/* … *\/` across lines. Not a full lexer: nested
 *  block comments count as one, and lifetimes are handled by not matching the
 *  char-literal shape. */
function scan(
  line: string,
  state: { depth: number; raw: string | null; comment: boolean },
): void {
  let k = 0;
  if (state.raw !== null) {
    const end = line.indexOf(state.raw);
    if (end < 0) return;
    k = end + state.raw.length;
    state.raw = null;
  }
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
    if (ch === "r" && (line[k + 1] === '"' || line[k + 1] === "#")) {
      const m = /^r(#*)"/.exec(line.slice(k));
      if (m) {
        const close = `"${m[1]}`;
        const end = line.indexOf(close, k + m[0].length);
        if (end < 0) {
          state.raw = close;
          return;
        }
        k = end + close.length - 1;
        continue;
      }
    }
    if (ch === '"') {
      k++;
      while (k < line.length && line[k] !== '"') k += line[k] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === "'") {
      const m = /^'(\\.|[^'\\])'/.exec(line.slice(k));
      if (m) {
        k += m[0].length - 1;
        continue;
      }
      continue;
    }
    if (ch === "{") state.depth++;
    else if (ch === "}") state.depth--;
  }
}

/** One file's worth of lifting. Both sources want the same three operations, so
 *  they share one closure rather than the copy-paste `lift-spawn.ts` has. */
function lifter(path: string) {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);

  /** Where a declaration starts, doc comments and attributes included — a lift
   *  that dropped a `#[derive]` would compile into a different thing and say so
   *  only at the call site. */
  const startOf = (i: number): number => {
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
  };

  const block = (i: number): string => {
    if (/;\s*$/.test(lines[i]) && !lines[i].includes("{")) {
      return lines.slice(startOf(i), i + 1).join("\n");
    }
    const state = { depth: 0, raw: null as string | null, comment: false };
    let seen = false;
    for (let j = i; j < lines.length; j++) {
      scan(lines[j], state);
      if (state.depth > 0) seen = true;
      if (seen && state.depth === 0) return lines.slice(startOf(i), j + 1).join("\n");
    }
    throw new Error(`unterminated block at ${path}:${i + 1}`);
  };

  const testsAt = (): number => {
    const at = lines.findIndex((l) => /^\s*mod tests\s*\{/.test(l));
    return at < 0 ? lines.length : at;
  };

  return {
    /** Above the test module only, so a helper and a test of the same name do
     *  not resolve to each other. */
    find(what: string): string {
      const stop = testsAt();
      const re = new RegExp(
        `^\\s*(pub(\\([a-z]+\\))?\\s+)?${what.replace(/ /g, "\\s+")}\\b`,
      );
      for (let i = 0; i < stop; i++) if (re.test(lines[i])) return block(i);
      throw new Error(`could not find "${what}" in ${path} — has it been renamed?`);
    },
    findTest(name: string): string {
      for (let i = testsAt(); i < lines.length; i++) {
        if (new RegExp(`^\\s*fn ${name}\\s*\\(`).test(lines[i])) return block(i);
      }
      throw new Error(`could not find test "${name}" in ${path} — has it been renamed?`);
    },
  };
}

const sup = lifter(SRC);
const store = lifter(STORE);

const body = [
  "//! GENERATED by tools/lift-selfhood.ts — do not edit, do not keep.",
  /* `crate::store::Provenance` resolves to this, because in a single-file lift
     the crate root is the file. */
  `pub mod store {\n${FROM_STORE.map((w) => store.find(w)).join("\n\n")}\n}`,
  ...ITEMS.map((w) => sup.find(w)),
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  ...TESTS.map((t) => sup.findTest(t)),
  "}",
].join("\n\n");

const dir = mkdtempSync(join(tmpdir(), "lift-selfhood-"));
const file = join(dir, "lifted.rs");
const exe = join(dir, "lifted.exe");
writeFileSync(file, body);

try {
  const build = spawnSync(
    "rustc",
    ["--test", "--edition", "2021", "-A", "dead_code", file, "-o", exe],
    {
      encoding: "utf8",
      /* Without this, rustc takes the *default* toolchain — msvc here — and dies
         with `link: extra operand`, which is the misleading failure at the top
         of `.claude/rules/build.md`. Sink b282b54c is two cards discovering that
         the documented recipe omitted this line, hours apart. */
      env: { ...process.env, RUSTUP_TOOLCHAIN: "stable-x86_64-pc-windows-gnu" },
    },
  );
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
