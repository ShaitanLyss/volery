/* Run every `tools/lift-*.ts`, and insist each one actually asserted something.
 *
 *     bun tools/lifts.ts          # or `bun run lifts`
 *
 * ### Why this exists
 *
 * A lift is the only test some of this Rust has on a machine with no MSVC
 * toolchain (`.claude/rules/build.md`): `cargo test` cannot link here, so a lift
 * pulls the pure half of a module into a standalone `rustc --test` crate and
 * runs the real assertions. Which means **a lift that is red is an assertion
 * silently not being made** — not a broken script, a missing guard.
 *
 * Nothing ran them but a person. On 2026-09-10 four of eighteen were found red
 * (sink `ce72b16b`), each from ordinary Rust drift — a `crate::` call added to
 * a module a lift covers, a return type that changed from a tuple to a struct,
 * a test renamed out from under a name list. Every one of those changes was
 * correct; none of their authors had any way to know a lift cared. **This
 * script is that way.** Whoever adds a `crate::` call to something a lift covers
 * owes the lift the same edit, and this is what tells them.
 *
 * ### It checks the pass count, not the exit code
 *
 * `rustc --test` with nothing to run reports `test result: ok. 0 passed` and
 * exits 0, so a lift whose `find` list has quietly emptied looks exactly like a
 * lift that passed. That is the failure mode this whole family has, one layer
 * out: sink `a8b2273c` is a background job's notification reporting the
 * *wrapper's* exit code rather than the build's, and it nearly shipped a "the
 * app links" claim about a build that had failed. So a zero count here is a
 * failure with its own name, and the totals are printed rather than summarised
 * as "ok" — a number that drops is the only warning a rotting lift gives.
 *
 * ### Sequentially, on purpose
 *
 * Eighteen rustc invocations is a few seconds and this wall routinely has ten
 * agents on it. Fanning them out would win a second or two and cost every other
 * card its CPU; the output would also arrive interleaved, which is worse to read
 * than it is fast.
 */

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

/** Files matching `lift-*.ts` that are not lifts.
 *
 *  Discovered by glob rather than listed, because a list is the thing that
 *  rotted: a new lift nobody added would be a lift nobody runs, which is the
 *  state this script exists to end. The exclusions are checked to still exist,
 *  so renaming one is loud rather than quietly re-including it. */
const NOT_A_LIFT = new Set(["lift-scan.ts"]);

const all = readdirSync("tools")
  .filter((f) => /^lift-.*\.ts$/.test(f))
  .sort();

for (const name of NOT_A_LIFT) {
  if (!all.includes(name)) {
    console.error(`tools/${name} is listed as not-a-lift and no longer exists — fix NOT_A_LIFT.`);
    process.exit(1);
  }
}

const lifts = all.filter((f) => !NOT_A_LIFT.has(f));
if (lifts.length === 0) {
  console.error("no tools/lift-*.ts found at all — this was run from the wrong directory.");
  process.exit(1);
}

/** `test result: ok. 26 passed; 0 failed; …` — the number is the whole point. */
const RESULT = /test result: (ok|FAILED)\. (\d+) passed/;

type Outcome = { lift: string; passed: number; why?: string };
const bad: Outcome[] = [];
let total = 0;

for (const file of lifts) {
  const lift = file.replace(/^lift-|\.ts$/g, "");
  const run = spawnSync("bun", [`tools/${file}`], { encoding: "utf8" });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const m = RESULT.exec(out);

  if (!m || m[1] !== "ok") {
    /* Whatever it said, first: a lift's own error names the module, the missing
       item or the renamed test, and that is the actionable half. */
    const why = (out.trim().split(/\r?\n/).find((l) => l.trim()) ?? "no output").trim();
    console.log(`  RED    ${lift.padEnd(10)} ${why}`);
    bad.push({ lift, passed: 0, why });
    continue;
  }

  const passed = Number(m[2]);
  total += passed;
  if (passed === 0) {
    /* Green and empty. See the header — this is the one an exit code cannot
       tell you about, and the reason the count is what is checked. */
    console.log(`  EMPTY  ${lift.padEnd(10)} ran and asserted nothing`);
    bad.push({ lift, passed, why: "asserted nothing" });
    continue;
  }
  console.log(`  ok     ${lift.padEnd(10)} ${passed} passed`);
}

console.log(
  `\n${lifts.length - bad.length}/${lifts.length} lifts green, ${total} assertions run.`,
);

if (bad.length > 0) {
  console.error(
    `\n${bad.length} lift(s) not making their assertions: ${bad.map((b) => b.lift).join(", ")}.` +
      `\nRun \`bun tools/lift-<name>.ts\` for the whole message. A lift that will not compile is` +
      `\nusually a \`crate::\` call added to a module it covers, or an item renamed under its list;` +
      `\nfix the list rather than deleting the assertion.` +
      `\nIf it is a missing serde_json rlib, run \`bash tools/check-gnu.sh\` once first.`,
  );
  process.exit(1);
}
