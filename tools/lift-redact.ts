/* Actually run the redactor's corpora, on a machine that cannot link the crate.
 *
 *     bun tools/lift-redact.ts
 *
 * `.claude/rules/build.md` has the whole of why `cargo test` does not run here.
 * This one is worth more than most lifts, because `redact.rs` is the module
 * that stands between a prompt and a file that gets copied to a peer: its two
 * corpora are the only thing asserting that every fake secret goes and that an
 * ordinary design brief survives. A redactor whose tests only ever *compile* has
 * never been run against a single secret.
 *
 * **This copies the whole file rather than lifting named items**, and the reason
 * is the same one that makes the lift safe: `redact.rs` reaches for nothing but
 * `std`. There is no `use crate::` in it, no sibling module and no dependency,
 * so the file *is* the lift, and copying it whole means there is no item list
 * to rot when a function is renamed, which is the failure four lifts were found
 * in on 2026-09-10 (sink `ce72b16b`).
 *
 * The one thing it cannot see is the module being wired into the crate: `mod
 * redact;` in `lib.rs` and the ingest calling `redact::redact` are checked by
 * `bash tools/check-gnu.sh --profile test`, not here.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { rustEnv } from "./lift-scan.ts";

const SOURCE = "src-tauri/src/redact.rs";

/* Read now, so a missing file is this script's own error rather than rustc's. */
const body = readFileSync(SOURCE, "utf8");

const dir = mkdtempSync(join(tmpdir(), "lift-redact-"));
const file = join(dir, "lifted.rs");
const exe = join(dir, "lifted.exe");
writeFileSync(file, body);

try {
  const build = spawnSync(
    "rustc",
    ["--test", "--edition", "2021", "-A", "dead_code", file, "-o", exe],
    /* Bare `rustc` takes the msvc default toolchain here and dies on
       `link: extra operand`, which names nothing that points at the cause. */
    { encoding: "utf8", env: rustEnv() },
  );
  if (build.status !== 0) {
    console.error(build.stderr || build.stdout);
    console.error(`\nthe lift is at ${file}, and it was NOT removed, so you can read it.`);
    process.exit(1);
  }
  const run = spawnSync(exe, ["--test-threads", "1"], { encoding: "utf8" });
  console.log(run.stdout);
  if (run.stderr) console.error(run.stderr);
  process.exit(run.status ?? 1);
} finally {
  /* Nothing is kept on success, for the reason every other lift gives: a stale
     copy goes on passing while the module it came from changes. */
  try {
    rmSync(exe, { force: true });
  } catch {
    /* the exe may still be held; the temp dir goes either way */
  }
}
