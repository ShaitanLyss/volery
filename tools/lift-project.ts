/* Actually run the version-bump reader's assertions on a machine with no MSVC.
 *
 * `cargo test` does not exist here — `.claude/rules/build.md` has the whole of
 * why, and "Writing an assertion nobody can run" is the rule this follows.
 *
 *     bun tools/lift-project.ts
 *
 * ### What is worth executing here rather than merely compiling
 *
 * **Which files a release is allowed to touch.** `version_files` enumerates six
 * paths; `set_version` then edits exactly one line of each, chosen by kind. Both
 * halves are promises about what a `chore: Release` commit will *not* contain,
 * and neither is visible to a typecheck — a tree-walking implementation and an
 * enumerating one have the same signature, and `splice` replacing every
 * occurrence instead of one line compiles perfectly.
 *
 * Sink `933c31d6` reported a release having rewritten a `shortRef("v0.12.0")`
 * fixture in `test/azdo.test.ts`. That turned out to be a wrong diagnosis —
 * `91d4b87` touched four files, none of them a test, and `git log -S` puts that
 * literal in `9639c70`, the commit that wrote the test — but the failure it
 * imagined is exactly the one this function would have if anybody made it
 * search, and it would be silent: `splice` only replaces what it was told was
 * there, so the edit succeeds and the file is committed under a release message.
 * `a_bump_plan_names_only_files_that_declare_the_version` builds a tree with
 * decoys in it and is the guard.
 *
 * These touch the real filesystem, under `std::env::temp_dir()`, which a lift
 * can do as well as cargo could — `std::fs` needs no rlib.
 *
 * **It regenerates from `project.rs` on every run and keeps nothing.**
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SRC = "src-tauri/src/project.rs";
const DEPS = "src-tauri/target/x86_64-pc-windows-gnu/debug/deps";
/** Where a **proc macro** lands, which is not beside everything else.
 *
 *  `VersionFile` derives `Serialize`, so this lift needs `serde_derive` — and a
 *  proc macro is compiled for the *host*, not for `--target`, so cargo puts it
 *  in the plain `debug/deps` rather than in the target-triple directory where
 *  the rlibs are. It is a `.dll` there rather than an `.rlib`, for the same
 *  reason: rustc dynamically loads it. Worth writing down, because the symptom
 *  of not knowing is "no serde_derive-*.rlib in deps" over a directory that
 *  plainly has serde in it. */
const HOST_DEPS = "src-tauri/target/debug/deps";

/** The pure declarations, in the order they have to be declared.
 *
 *  Listing what comes in rather than what stays out, as every other lift here
 *  argues: a new reader added to `project.rs` and not added here is untested,
 *  which is quiet — where `version_files` reaching for something this list omits
 *  breaks the build loudly, which is the safer direction to fail in. */
const ITEMS: string[] = [
  "struct VersionFile",
  "fn quoted_value",
  "fn json_line",
  "fn json_version",
  "fn bare_value",
  "fn toml_line",
  "fn toml_package_version",
  "fn toml_package_name",
  "fn lock_line",
  "fn ini_project_version",
  "fn splice",
  "fn set_version",
  "fn set_lock_version",
  "fn version_files",
];

const TESTS: string[] = [
  /* The two the sink item is about. */
  "a_bump_plan_names_only_files_that_declare_the_version",
  "setting_a_version_moves_one_line_and_leaves_look_alikes_alone",
];

const lines = readFileSync(SRC, "utf8").split(/\r?\n/);

/** Where a declaration starts, including the doc comments and attributes above
 *  it — a lift that dropped `#[test]` would compile into a file with nothing to
 *  run, and report that by passing. */
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

/** Brace depth, counting only braces that are *code*.
 *
 *  The other `lift-*.ts` scripts count every `{` and `}` in the line, which is
 *  fine until something lifted has a brace inside a string — and the assertions
 *  here are the first that do, because a `package.json` fixture is written out
 *  literally. The naive counter reads `"{\n  \"version\"…"` as opening a block
 *  that never closes, and rustc then reports `unclosed delimiter` against
 *  `mod tests {` four hundred lines above the actual cause.
 *
 *  So this walks the line: `"…"` strings with backslash escapes, `r"…"` and
 *  `r#"…"#` raw strings, `'c'` character literals, `//` to end of line, and
 *  `/* … *\/` across lines. The last of those is not hypothetical either —
 *  `json_line`'s own doc block says "the `{` of the root object", and that
 *  brace is why the first draft of this could not find the end of the function
 *  three lines below it. Not a full Rust lexer: nested block comments count as
 *  one, and lifetimes are handled only by not matching the char-literal shape.
 *  State is carried across lines because both raw strings and block comments
 *  can span them. */
function scan(
  line: string,
  state: { depth: number; raw: string | null; comment: boolean },
): void {
  let k = 0;
  /* Mid-raw-string from a previous line: skip to its terminator. */
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
    /* A char literal, but not a lifetime — `'a` has no closing quote. */
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

function block(i: number): string {
  const head = lines[i];
  if (/;\s*$/.test(head) && !head.includes("{")) {
    return lines.slice(startOf(i), i + 1).join("\n");
  }
  const state = { depth: 0, raw: null as string | null, comment: false };
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

/** `serde`'s rlib, found by hash rather than named — `VersionFile` derives
 *  `Serialize`, and deriving it is part of what is being lifted. */
function serdeRlib(): { rlib: string; derive: string } {
  let names: string[];
  try {
    names = readdirSync(DEPS);
  } catch {
    throw new Error(
      `${DEPS} does not exist — run \`bash tools/check-gnu.sh\` once so cargo builds the rlibs this borrows.`,
    );
  }
  const pick = (dir: string, re: RegExp, what: string) => {
    const hit = readdirSync(dir).filter((n) => re.test(n));
    if (!hit.length) throw new Error(`no ${what} in ${dir} — run tools/check-gnu.sh first`);
    /* Several hashes means several graphs' worth of artefacts. Newest wins, and
       it says so rather than choosing silently — if the pick is wrong, rustc
       refuses to link rather than producing something subtly other. */
    if (hit.length > 1) console.error(`note: ${hit.length} ${what} in ${dir}, using ${hit[hit.length - 1]}`);
    return join(dir, hit[hit.length - 1]);
  };
  void names;
  return {
    rlib: pick(DEPS, /^libserde-[0-9a-f]+\.rlib$/, "libserde-*.rlib"),
    derive: pick(HOST_DEPS, /^serde_derive-[0-9a-f]+\.dll$/, "serde_derive-*.dll"),
  };
}

const { rlib, derive } = serdeRlib();

const body = [
  "//! GENERATED by tools/lift-project.ts — do not edit, do not keep.",
  "use serde::Serialize;",
  "use std::path::Path;",
  ...ITEMS.map(find),
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  ...TESTS.map(findTest),
  "}",
].join("\n\n");

const dir = mkdtempSync(join(tmpdir(), "lift-project-"));
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
      `serde=${rlib}`,
      "--extern",
      `serde_derive=${derive}`,
      "-L",
      `dependency=${DEPS}`,
      "-L",
      `dependency=${HOST_DEPS}`,
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
  /* Single-threaded: both assertions build a tree under a fixed name in the
     temp directory, so running them concurrently would have each deleting the
     other's fixture. */
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
