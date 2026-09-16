/* Which permission modes a running card can actually be put into, and out of.
 *
 * `probe-plan.ts` asked the *first* half of this — can a bypass card be put
 * into plan — and answered it. What it never asked is the way back under the
 * value Volery really sends. It came out via `acceptEdits`, on a card spawned
 * *with* `--dangerously-skip-permissions`, so it asked for a privilege the
 * session already held and every arm that could fail was missed. `/gear making`
 * sends `bypassPermissions`, and on a card launched without the flag the CLI
 * refuses it:
 *
 *   Cannot set permission mode to bypassPermissions because the session was
 *   not launched with --dangerously-skip-permissions
 *
 * That was a card that could enter plan mode and never leave — no writing
 * tools, no `ask_user`, no `ExitPlanMode` (it no longer exists), and a
 * `/gear making` that did nothing and said nothing. See `.claude/rules/gears.md`.
 *
 *   bun tools/probe-modes.ts              # spawned with the bypass flag (what Volery does)
 *   bun tools/probe-modes.ts --plan-born  # spawned `--permission-mode plan` (what it used to)
 *
 * **Costs no API turn at all.** A `control_response` comes back in ~60ms and no
 * prompt is ever sent, which is what makes this cheap enough to re-run against
 * every CLI upgrade — and it is worth re-running, because the whole spawn
 * arrangement in `supervisor::spawn_now` rests on the first line of the output.
 */

const CLAUDE = Bun.which("claude") ?? "claude";
const PLAN_BORN = process.argv.includes("--plan-born");

/** Skein's shipped flags, verbatim — the point is to probe what Skein spawns. */
const ARGV = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--forward-subagent-text",
  ...(PLAN_BORN ? ["--permission-mode", "plan"] : ["--dangerously-skip-permissions"]),
];

/* Every mode `supervisor::set_permission_mode` will pass through, each asked for
   *out of plan* — which is the direction that fails and the direction nothing
   had tested. `default` is not in that list and is asked anyway: the CLI's
   vocabulary is wider than the const, and knowing which of the two is wrong is
   worth one line. */
const MODES = [
  "plan", "bypassPermissions",
  "plan", "acceptEdits",
  "plan", "auto",
  "plan", "manual",
  "plan", "dontAsk",
  "plan", "default",
];

const proc = Bun.spawn([CLAUDE, ...ARGV, "--session-id", crypto.randomUUID()], {
  cwd: process.cwd(),
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

const asked = new Map<string, string>();
const refused: string[] = [];

(async () => {
  for await (const chunk of proc.stdout) {
    for (const line of new TextDecoder().decode(chunk).split("\n")) {
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type !== "control_response") continue;
      const r = ev.response ?? {};
      const want = asked.get(r.request_id) ?? "?";
      const ok = r.subtype === "success";
      if (!ok) refused.push(want);
      console.log(
        `  ${want.padEnd(18)} ${ok ? "ok     " : "REFUSED"}  ` +
        JSON.stringify(ok ? r.response : r.error),
      );
    }
  }
})();

(async () => {
  for await (const chunk of proc.stderr) {
    process.stderr.write(`[stderr] ${new TextDecoder().decode(chunk)}`);
  }
})();

console.log(
  `spawned with ${PLAN_BORN ? "--permission-mode plan" : "--dangerously-skip-permissions"}\n`,
);

for (const [i, mode] of MODES.entries()) {
  const id = `probe-modes-${i}`;
  asked.set(id, mode);
  proc.stdin.write(JSON.stringify({
    type: "control_request",
    request_id: id,
    request: { subtype: "set_permission_mode", mode },
  }) + "\n");
  proc.stdin.flush();
  /* Sequential rather than fired together, because what is being read is which
     *request* was refused and the responses carry only the id to tell them
     apart. One at a time keeps the transcript above readable as a ladder. */
  await new Promise((r) => setTimeout(r, 700));
}

await new Promise((r) => setTimeout(r, 1500));

console.log("\n=== what this run established ===");
console.log(`modes asked for ......... ${MODES.length}`);
console.log(`refused ................. ${refused.length ? refused.join(", ") : "none"}`);
console.log(
  refused.includes("bypassPermissions")
    ? "\nA card in this shape CANNOT be put back into making. That is the bug\n" +
      "`.claude/rules/gears.md` records; the spawn must carry the bypass flag."
    : "\nThe way back is open, which is what `/gear making` needs.",
);
proc.kill();
process.exit(0);
