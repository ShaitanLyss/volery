/* Run exactly what CI runs, in CI's order, and refuse to call a step green on
 * an exit code alone.
 *
 * ### Why this exists
 *
 * `v0.47.0`'s build failed on a compile error in `examples/flyway-link.rs` — a
 * `match` over `Frame` that did not cover the `Move` variant a card had added
 * hours earlier. Every card had run its gates and every card was green, because
 * the habit in this repository is `cargo test --lib`, and **`--lib` does not
 * build examples**. CI runs `cargo test` over the whole manifest, which does.
 *
 * It was the second time that exact file broke a release the same way
 * (`bac46df` was the first, for the `Tail` variant). Two instances of one shape
 * is a convention nobody can keep, not two mistakes: the gap between what a
 * card runs and what CI runs is a thing you have to *remember*, and under load
 * it gets skipped — the same argument `.scratch-$SKEIN_CARD/` is built on.
 *
 * So the list lives here rather than in anybody's head. `bun run gate` is the
 * answer to "is this ready to push", and it is right by construction because
 * it is read off `.github/workflows/release.yml`'s own steps.
 *
 * ### A clean exit is not a pass
 *
 * Every step here asserts something it *saw*, not that the process returned 0.
 * Three separate false greens turned up on 2026-10-09 alone: a lift runner that
 * could not run at all, a lift whose regex had stopped matching after a rename,
 * and `cargo` wrapped in Git Bash's `timeout` exiting 0 having run nothing.
 * `.claude/rules/build.md` has the last of those; the general form is that **a
 * harness able to report success without having tested anything is worse than
 * one that fails**, because the failure mode is silence that looks like virtue.
 *
 * Hence `expect` below: each step names a pattern that must appear in its own
 * output, and a step that cannot show it is red however it exited.
 *
 * `tauri build` is deliberately **not** here. It is the fourth CI step and it
 * takes minutes; this is the gate before a push, and the release rule already
 * says not to re-run gates for a version bump. Pass `--full` to include it when
 * you actually want the bundle checked. */

import { spawnSync } from "node:child_process";
import { staleArtifact } from "./stale";
import { pruneTarget } from "./prune-target";

type Step = {
  /** What it is, in CI's words. */
  name: string;
  cmd: string;
  args: string[];
  /** What its output must contain for this to count as a pass. A step that
   *  exits 0 without saying this has not run — see the header. */
  expect: RegExp;
  /** Only with `--full`. */
  heavy?: boolean;
};

/* Read off `.github/workflows/release.yml`. If you change one, change the
   other, and say in the commit that you did — the whole value here is that
   this list and CI's cannot drift. */
const STEPS: Step[] = [
  { name: "check", cmd: "bun", args: ["run", "check"], expect: /\b0 ERRORS\b/ },
  { name: "pure suites", cmd: "bun", args: ["run", "test"], expect: /\b(\d+) pass\b/ },
  {
    name: "rust suites",
    /* **`cargo test`, not `cargo test --lib`.** The whole manifest, which is
       what builds `examples/` — the thing that broke v0.47.0. And never behind
       Git Bash's `timeout`, which exits 0 having run nothing. */
    cmd: "cargo",
    args: ["test", "--manifest-path", "src-tauri/Cargo.toml"],
    expect: /test result: ok\. [1-9]\d* passed/,
  },
  /* Not a CI step, and here anyway: `bun run lifts` is the only thing that runs
     the lift assertions and there is no CI gate on them, which is how 24 of
     them sat unrunnable for weeks (`807b621`). A push is the right moment. */
  { name: "lifts", cmd: "bun", args: ["run", "lifts"], expect: /\b(\d+)\/\1\b|all .* passed/i },
  { name: "bundle", cmd: "bun", args: ["run", "tauri", "build"], expect: /Finished|built/i, heavy: true },
];

const full = process.argv.includes("--full");
const run = STEPS.filter((s) => full || !s.heavy);

/* Before the rust suite builds: superseded hashes of this crate out of
   `target/debug`, which otherwise grows ~50 GB a fortnight (sink b3300e79).
   Skips itself while any cargo runs, and never fails the gate. */
console.log(pruneTarget());

let failed = 0;
for (const s of run) {
  process.stdout.write(`\n── ${s.name} ─────────────────────────────\n`);
  const go = () => {
    const r = spawnSync(s.cmd, s.args, { encoding: "utf8", shell: true });
    return { r, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  const tail = (o: string) => o.split("\n").slice(-25).join("\n");
  let { r, out } = go();
  process.stdout.write(tail(out));

  /* A cargo step can go red because a concurrent build (another card, a lab)
     replaced an artifact in the shared target dir under it. Retry exactly once,
     only on the two known signatures, and say so — the retry still has to show
     `expect` below, so it is no softer than the first run. */
  const stale = s.cmd === "cargo" && r.status !== 0 ? staleArtifact(out) : null;
  if (stale) {
    console.error(`\n   ${s.name}: stale artifact (${stale}), retried once`);
    const first = out;
    ({ r, out } = go());
    process.stdout.write(tail(out));
    if (r.status !== 0 || !s.expect.test(out)) {
      console.error(`\n   first attempt, key lines:\n${first.split("\n").filter((l) => /error|invalid metadata|rlib format/.test(l)).slice(0, 6).join("\n")}`);
    }
  }

  const said = s.expect.test(out);
  if (r.status === 0 && said) {
    console.log(`\n   ${s.name}: green`);
    continue;
  }
  failed++;
  if (r.status !== 0) console.error(`\n   ${s.name}: FAILED (exit ${r.status})`);
  else {
    /* The dangerous case, and the reason this script is not three lines of
       shell: exit 0 with nothing to show for it. */
    console.error(
      `\n   ${s.name}: FAILED — exited 0 but never said what it checked.\n` +
        `   Expected output matching ${s.expect}.\n` +
        `   A clean exit is not a pass; something ran nothing. See .claude/rules/build.md.`,
    );
  }
}

if (failed) {
  console.error(`\n${failed} of ${run.length} steps red — this is what CI will say.\n`);
  process.exit(1);
}
console.log(`\nall ${run.length} steps green${full ? "" : " (bundle skipped — `bun run gate --full` for it)"}\n`);
