/* Actually run `kit.rs`'s assertions, and the spawn receipt's pointer at the
 * skill, on a machine where `cargo test` cannot run (`.claude/rules/build.md`).
 *
 *     bun tools/lift-kit.ts
 *
 * The module is nearly pure: the table of files, laying them out, pruning what
 * is not shipped. The one function that is not, `dir`, reads the app data
 * folder through a Tauri handle, and it is the only thing left out — every
 * test is about the parts it calls. The kit itself is copied beside the lifted
 * file, because `FILES` is a list of `include_str!("../kit/…")` resolved from
 * the including file, so what is asserted is the real text that ships.
 *
 * `serde_json` is borrowed out of cargo's target tree for the manifest test,
 * as `lift-roster.ts` does.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { blockAt, depsDir, newestRlib, rustEnv } from "./lift-scan.ts";

const KIT = "src-tauri/src/kit.rs";
const SPAWN = "src-tauri/src/spawn.rs";

const kit = readFileSync(KIT, "utf8").replace(/\r\n/g, "\n").split("\n");

/* Everything but `dir` and the Tauri import. Found by its head rather than by
   line number, and refused loudly if it is not there, since a lift that quietly
   kept the function would fail to compile for a reason that names Tauri. */
const head = kit.findIndex((l) => l.startsWith("pub fn dir("));
if (head < 0) throw new Error(`no \`pub fn dir(\` in ${KIT}; has it been renamed?`);
const dirBlock = blockAt(kit, head, KIT);
const lifted = kit
  .join("\n")
  .replace(dirBlock, "")
  .replace(/^use tauri::.*$/m, "");
if (lifted.includes("AppHandle")) throw new Error("the lift still names AppHandle");

const spawn = readFileSync(SPAWN, "utf8").replace(/\r\n/g, "\n").split("\n");
const ptr = spawn.findIndex((l) => l.startsWith("fn coordinate_pointer("));
if (ptr < 0) throw new Error(`no \`fn coordinate_pointer(\` in ${SPAWN}`);
const pointer = blockAt(spawn, ptr, SPAWN).replace("crate::kit::COORDINATE", "COORDINATE");
const pointerTest = (() => {
  const i = spawn.findIndex((l) => l.includes("fn only_the_first_receipt_points_at_the_method"));
  if (i < 0) throw new Error(`the pointer's test is gone from ${SPAWN}`);
  return blockAt(spawn, i, SPAWN);
})();

const body = [
  lifted,
  pointer,
  "#[cfg(test)]\nmod receipt {\n    use super::*;\n" + pointerTest + "\n}",
].join("\n\n");

const dir = mkdtempSync(join(tmpdir(), "lift-kit-"));
mkdirSync(join(dir, "src"));
cpSync("src-tauri/kit", join(dir, "kit"), { recursive: true });
const file = join(dir, "src", "lifted.rs");
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
      "-A",
      "unused_imports",
      "--extern",
      `serde_json=${newestRlib("serde_json")}`,
      "-L",
      `dependency=${depsDir()}`,
      file,
      "-o",
      exe,
    ],
    /* `every_file_in_the_kit_folder_ships` walks `CARGO_MANIFEST_DIR/kit`,
       which here is the copy beside the lifted file: the same tree, so the
       folder and `FILES` are compared exactly as cargo would compare them. */
    { encoding: "utf8", env: { ...rustEnv(), CARGO_MANIFEST_DIR: dir } },
  );
  if (build.status !== 0) {
    console.error(build.stderr || build.stdout);
    console.error(`\nthe lift is at ${file}; it was NOT removed, so you can read it.`);
    process.exit(1);
  }
  const run = spawnSync(exe, ["--test-threads", "1"], { encoding: "utf8" });
  console.log(run.stdout);
  if (run.stderr) console.error(run.stderr);
  rmSync(dir, { recursive: true, force: true });
  process.exit(run.status ?? 1);
} catch (e) {
  console.error(e);
  process.exit(1);
}
