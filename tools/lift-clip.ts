/**
 * Run `clip.rs`'s and `clean.rs`'s own assertions, without cargo.
 *
 * `bun tools/lift-clip.ts`
 *
 * ## Why this exists
 *
 * `cargo test` does not run on this machine and the failure names nothing that
 * points at the cause — the build script's `tauri-winres` step shells out to
 * `windres`, which is not there, and the panic that comes back is about a
 * `resource.rc` it could not preprocess. `.claude/rules/build.md` has the whole
 * of it. So every Rust assertion in this repository is either run on a machine
 * with MSVC or lifted, and the `tools/lift-*.ts` family is how it is lifted.
 *
 * ## Why this one is the easy case, and why that is the point
 *
 * The other lifts have to cut one function or one `json!` block out of a large
 * file that depends on the whole crate, and they do it by counting braces — which
 * is sink `4b20ad50`, because seven of them count braces inside string literals
 * and comments too, and the failure names `mod tests {` four hundred lines from
 * the cause. **This script does no scanning at all**, and deliberately adds no
 * eighth copy of that bug.
 *
 * It can avoid it because the files it compiles depend on **nothing above
 * themselves** — no `store`, no `AppHandle`, no serde, nothing but `std` and
 * each other. That is not an accident of how they happened to be written; it is
 * a property worth keeping, and this script is what makes keeping it pay. A
 * module with no upward dependencies is a module `rustc --test` can compile on
 * its own, so the files are handed over whole and what runs is the real code
 * with its real assertions rather than a transcription of them.
 *
 * ## It compiles two files now, and the guard is what changed
 *
 * `clip::keep` calls `clean::scrub`, because taking out a character that cannot
 * be recorded belongs on the one path every capped text field on every surface
 * already takes (sink `3937d33d`, and `crate::clean`'s own header). So this is
 * a two-module crate root rather than a single file — which costs a generated
 * `mod` line and keeps the whole approach, since `clean.rs` reaches nowhere
 * either.
 *
 * The check below is therefore no longer "does this file say `crate::`" but
 * "does it reach anything that is not in this root". If someone later reaches
 * further, this stops and says exactly which path it could not resolve. That is
 * the right failure: the cheap verification is worth more than the convenience
 * that would break it.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** The modules in the generated crate root, in the order they are declared. */
const MODULES = ["clean", "clip"];
const TOOLCHAIN = "stable-x86_64-pc-windows-gnu";

const sources = MODULES.map((name) => {
  const path = `src-tauri/src/${name}.rs`;
  return { name, path, src: readFileSync(path, "utf8") };
});

/* The one thing worth checking before compiling, because it is the property the
   whole approach rests on and a clear message here beats a rustc error about an
   unresolved path. */
for (const { path, src } of sources) {
  const reach = [...new Set(src.match(/crate::([A-Za-z_]+)/g) ?? [])].filter(
    (r) => !MODULES.includes(r.slice("crate::".length)),
  );
  if (reach.length) {
    console.error(
      `${path} now reaches past this lift (${reach.join(", ")}), so it can no longer be ` +
        `compiled on its own.\n` +
        `Either keep it dependency-free — which is what makes this lift possible — or ` +
        `rewrite this script to stub what it needs.`,
    );
    process.exit(1);
  }
}

const dir = mkdtempSync(join(tmpdir(), "lift-clip-"));
const root = join(dir, "lift.rs");
const exe = join(dir, "clip-test.exe");

try {
  /* Handed over verbatim. `--test` builds the harness around the `#[cfg(test)]`
     modules that are already in the files, so the assertions that run are the
     ones a machine with MSVC would run. */
  for (const { name, src } of sources) {
    writeFileSync(join(dir, `${name}.rs`), src);
  }
  writeFileSync(root, MODULES.map((m) => `mod ${m};\n`).join(""));

  const build = spawnSync(
    "rustup",
    ["run", TOOLCHAIN, "rustc", "--edition", "2021", "--test", root, "-o", exe],
    { encoding: "utf8" },
  );
  if (build.status !== 0) {
    console.error(build.stderr || build.stdout || "rustc did not run");
    process.exit(1);
  }
  /* Warnings are worth showing even on a green build — an unused import here is
     a test that stopped exercising something. */
  if (build.stderr?.trim()) {
    console.error(build.stderr.trim());
  }

  const run = spawnSync(exe, [], { encoding: "utf8" });
  process.stdout.write(run.stdout ?? "");
  if (run.stderr?.trim()) {
    process.stderr.write(run.stderr);
  }
  process.exit(run.status ?? 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
