/**
 * Run `clip.rs`'s own assertions, without cargo.
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
 * It can avoid it because `src-tauri/src/clip.rs` has **no `crate::` reference in
 * it** — no `store`, no `AppHandle`, no serde, nothing but `std`. That is not an
 * accident of how it happened to be written; it is a property worth keeping, and
 * this script is what makes keeping it pay. A module with no upward dependencies
 * is a module `rustc --test` can compile on its own, so the file is handed over
 * whole and what runs is the real code with its real assertions rather than a
 * transcription of them.
 *
 * If someone later reaches into the crate from `clip.rs`, this stops compiling
 * and says exactly which path it could not resolve. That is the right failure:
 * the cheap verification is worth more than the convenience that would break it.
 */

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SRC = "src-tauri/src/clip.rs";
const TOOLCHAIN = "stable-x86_64-pc-windows-gnu";

const src = readFileSync(SRC, "utf8");

/* The one thing worth checking before compiling, because it is the property the
   whole approach rests on and a clear message here beats a rustc error about an
   unresolved path. */
const reach = src.match(/crate::[A-Za-z_:]+/g);
if (reach) {
  console.error(
    `${SRC} now reaches into the crate (${[...new Set(reach)].join(", ")}), so it can no ` +
      `longer be compiled on its own.\n` +
      `Either keep it dependency-free — which is what makes this lift possible — or ` +
      `rewrite this script to stub what it needs.`,
  );
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "lift-clip-"));
const file = join(dir, "clip.rs");
const exe = join(dir, "clip-test.exe");

try {
  /* Handed over verbatim. `--test` builds the harness around the `#[cfg(test)]`
     module that is already in the file, so the assertions that run are the ones
     a machine with MSVC would run. */
  require("node:fs").writeFileSync(file, src);

  const build = spawnSync(
    "rustup",
    ["run", TOOLCHAIN, "rustc", "--edition", "2021", "--test", file, "-o", exe],
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
