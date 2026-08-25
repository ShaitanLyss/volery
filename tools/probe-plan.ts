/* Can a card be put into plan mode, and what does that look like on the wire?
 *
 * Three questions, and the first decides whether plan mode can be a *mode* at
 * all or has to be a different kind of card:
 *
 *   1. **Does `set_permission_mode: "plan"` beat `--dangerously-skip-permissions`?**
 *      Every project card spawns with bypass (see `.claude/rules/chat.md`). If
 *      bypass wins, a card cannot be switched into planning and back — it would
 *      have to be respawned without the flag, which is a card that loses its
 *      process, not a card that changes gear.
 *
 *   2. **What arrives when the agent calls `ExitPlanMode`?** Does the turn park
 *      waiting for an answer — the shape `ask.rs` already knows how to hold — or
 *      does the tool just return and the turn carry on?
 *
 *   3. **Can it be switched back**, mid-session, so approving a plan and letting
 *      the card execute it is one conversation rather than two?
 *
 *   bun tools/probe-plan.ts
 *
 * Costs two or three real turns.
 */

const CLAUDE = Bun.which("claude") ?? "claude";
const CWD = process.cwd();

/** Skein's shipped flags, verbatim — the point is to probe what Skein spawns. */
const ARGV = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--forward-subagent-text",
  "--dangerously-skip-permissions",
];

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`.padStart(7);

const proc = Bun.spawn([CLAUDE, ...ARGV, "--session-id", crypto.randomUUID()], {
  cwd: CWD,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

function send(o: unknown) {
  proc.stdin.write(JSON.stringify(o) + "\n");
  proc.stdin.flush();
}

const say = (text: string) =>
  send({ type: "user", message: { role: "user", content: text } });

const control = (subtype: string, extra: Record<string, unknown> = {}) =>
  send({
    type: "control_request",
    request_id: `probe-${subtype}-${Math.floor(performance.now())}`,
    request: { subtype, ...extra },
  });

/* What the run has seen, so the summary at the end can be about facts rather
   than about whichever line happened to scroll past. */
const seen = {
  planToolCalls: [] as any[],
  modeResponses: [] as any[],
  edited: false,
  results: [] as string[],
};

let stage = 0;

(async () => {
  for await (const chunk of proc.stdout) {
    for (const line of new TextDecoder().decode(chunk).split("\n")) {
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }

      if (ev.type === "system" && ev.subtype === "init") {
        console.log(`${at()}  init            permissionMode=${ev.permissionMode ?? "(absent)"}  tools=${(ev.tools ?? []).length}`);
        const plan = (ev.tools ?? []).includes("ExitPlanMode");
        console.log(`${at()}                  ExitPlanMode offered at spawn: ${plan}`);
      }

      if (ev.type === "control_response") {
        seen.modeResponses.push(ev);
        console.log(`${at()}  control_resp    ${JSON.stringify(ev.response).slice(0, 200)}`);
      }

      for (const b of ev?.message?.content ?? []) {
        if (b.type === "tool_use") {
          if (b.name === "ExitPlanMode") {
            seen.planToolCalls.push(b);
            console.log(`${at()}  TOOL            ExitPlanMode  ${JSON.stringify(b.input).slice(0, 300)}`);
          } else if (["Write", "Edit", "NotebookEdit"].includes(b.name)) {
            seen.edited = true;
            console.log(`${at()}  TOOL            ${b.name} ${JSON.stringify(b.input?.file_path ?? "")}`);
          } else {
            console.log(`${at()}  tool            ${b.name}`);
          }
        }
        if (b.type === "tool_result") {
          const t = typeof b.content === "string"
            ? b.content
            : (b.content ?? []).map((c: any) => c.text ?? "").join("");
          if (t) console.log(`${at()}  tool_result     ${JSON.stringify(t.slice(0, 220))}`);
        }
      }

      if (ev.type === "result") {
        seen.results.push(ev.subtype);
        console.log(`${at()}  RESULT          subtype=${ev.subtype} ${JSON.stringify(String(ev.result ?? "")).slice(0, 260)}\n`);
        stage++;

        if (stage === 1) {
          /* Q3: back out of plan mode, then ask for the same edit again. */
          console.log(`${at()}  --> set_permission_mode acceptEdits, then ask again\n`);
          control("set_permission_mode", { mode: "acceptEdits" });
          setTimeout(() => say("Now actually create that file."), 400);
        } else {
          console.log("\n=== what this run established ===");
          console.log(`ExitPlanMode was called ......... ${seen.planToolCalls.length} time(s)`);
          console.log(`a file was written .............. ${seen.edited}`);
          console.log(`control responses ............... ${seen.modeResponses.length}`);
          console.log(`results ......................... ${seen.results.join(", ")}`);
          proc.kill();
          process.exit(0);
        }
      }
    }
  }
})();

(async () => {
  for await (const chunk of proc.stderr) {
    process.stderr.write(`[stderr] ${new TextDecoder().decode(chunk)}`);
  }
})();

/* Q1: ask for plan mode on a card spawned with bypass, then ask for something
   that would obviously edit a file. If bypass wins, the file is written. */
console.log(`${at()}  --> set_permission_mode plan\n`);
control("set_permission_mode", { mode: "plan" });
setTimeout(
  () => say("Create a file .scratch/plan-probe.txt containing the word HELLO. Keep it to that one step."),
  600,
);

setTimeout(() => {
  console.log("\n[timed out after 180s]");
  proc.kill();
  process.exit(1);
}, 180_000);
