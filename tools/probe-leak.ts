/* Sink 1601a7a1: "some code is leaking in the transcript without even expanding
 * anything" — a Bash tool call's whole `command`, heredoc and all, standing in
 * the column under the agent's prose.
 *
 * Every path on disk is bounded. `describeTool` clips a Bash command to 46,
 * `foldSummary` clips the run cap to 46, and `ToolCall` renders arguments only
 * behind `{#if open}`. Folding all 278 session files on this machine through
 * `foldTranscript` turns up the reported command as exactly two 46-character
 * `tool` lines. So if it was drawn, it came off the wire in a field this app
 * reads and the session file never records — which is precisely how the last
 * instance of this bug hid (see e9b9d16, and `jobNote` in classify.ts).
 *
 * So: spawn with Skein's exact argv, make one Bash call whose command carries a
 * token nothing else could be the source of, and print *every* event the wire
 * carries that token in, with the JSON path it was found at.
 *
 *   bun tools/probe-leak.ts
 *
 * One small real turn.
 *
 * ── what it returned, 2026-08-27, claude 2.1.241 ──────────────────────────
 *
 * Three fields carry the whole command, and only the first is one this app
 * already knew to bound:
 *
 *   assistant  → message.content[*].input.command      115 chars
 *   system/task_started       → description            115 chars
 *   system/task_notification  → summary                115 chars
 *
 * The run that produced those numbers asked for a heredoc plus a `sleep 12`
 * and told the model to pass no `description`. It obliged, and:
 *
 *   run_in_background in the model's input : undefined
 *   a description was passed               : false
 *   summary IS the command                 : true
 *
 * **That `undefined` is the whole finding.** The call reads as an ordinary
 * foreground one in the session file — `input` is `{ command }` and nothing
 * else — and it raised a background job's notification anyway. So the two
 * calls in sink 1601a7a1, which look foreground on disk for exactly the same
 * reason, were not evidence against the job path; they were the job path with
 * its label filed off. Fixed already, in e9b9d16: `jobNote` clips the summary
 * to `JOB_NOTE_CAP` on both folds.
 *
 * Keep this probe. The bug it measures is invisible in `~/.claude/projects`
 * by construction, it has been reported four times, and three of those four
 * were spent re-establishing that fact from scratch.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.slice(1);
const CWD = join(ROOT, ".scratch", "leakprobe");
const CLAUDE = Bun.which("claude") ?? "claude";

rmSync(CWD, { recursive: true, force: true });
mkdirSync(CWD, { recursive: true });

/** In the command and nowhere else, so "the wire carried the command" admits no
 *  other explanation. */
const TOKEN = "shoveler-8831";

/** Skein's shipped flags, verbatim — see supervisor.rs. */
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

const proc = Bun.spawn([CLAUDE, ...ARGV, "--session-id", crypto.randomUUID()], {
  cwd: CWD,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

(async () => {
  const dec = new TextDecoder();
  for await (const c of proc.stderr) {
    const s = dec.decode(c).trim();
    if (s) console.log("stderr:", s.slice(0, 300));
  }
})();

/* A heredoc, because that is the reported shape: one `command` that is a whole
   file, so anything echoing it is unmissable. */
const ASK =
  `Run exactly this with the shell tool, once, and then say only "done".\n` +
  `Do NOT pass a \`description\` argument — pass only \`command\`. This is deliberate;\n` +
  `the probe is measuring what happens when the description is absent.\n\n` +
  "```\n" +
  `cat > ${TOKEN}.txt <<'EOF'\n` +
  `line one ${TOKEN}\nline two ${TOKEN}\nline three ${TOKEN}\n` +
  `EOF\n` +
  `sleep 12\n` +
  "```\n";

proc.stdin.write(
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: ASK }] } }) + "\n",
);
proc.stdin.flush();

/** Every place in one event the token appears, as a dotted path. Reported as
 *  paths rather than as a match count, because the whole question is *which
 *  field* — a tool_use input is expected and bounded, anything else is the bug. */
function paths(v: unknown, at = "", out: string[] = []): string[] {
  if (typeof v === "string") {
    if (v.includes(TOKEN)) out.push(`${at || "."}  (${v.length} chars)`);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => paths(x, `${at}[${i}]`, out));
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) paths(x, at ? `${at}.${k}` : k, out);
  }
  return out;
}

const seen = new Map<string, number>();
let n = 0;
let done = false;
let command: string | null = null;
let summary: string | null = null;
let hasDesc = false;
let bg: unknown = undefined;
const dec = new TextDecoder();
let buf = "";
for await (const chunk of proc.stdout) {
  buf += dec.decode(chunk);
  const rows = buf.split("\n");
  buf = rows.pop() ?? "";
  for (const row of rows) {
    if (!row.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(row); } catch { continue; }
    n++;
    /* The turn is over: one `result` closes it, and the process would otherwise
       sit waiting on stdin for the next prompt exactly as a card does. */
    if (ev.type === "result") done = true;
    /* Partial deltas would drown it: the command streams in as
       `input_json_delta`, a hundred fragments none of which is the whole. Only
       whole values are interesting here. */
    if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") continue;
    /* The two halves of the question, kept side by side: what the model wrote,
       and what the CLI told us about it when it finished. */
    if (ev.type === "assistant") {
      for (const b of ev.message?.content ?? []) {
        if (b?.type === "tool_use") {
          command = b.input?.command ?? null;
          hasDesc = typeof b.input?.description === "string";
          bg = b.input?.run_in_background;
        }
      }
    }
    if (ev.type === "system" && ev.subtype === "task_notification") {
      summary = ev.summary ?? null;
    }
    const found = paths(ev);
    if (!found.length) continue;
    const tag = `${ev.type}${ev.subtype ? "/" + ev.subtype : ""}`;
    for (const p of found) {
      const key = `${tag}  →  ${p.replace(/\[\d+\]/g, "[*]")}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    console.log(`\n── ${tag}`);
    for (const p of found) console.log("     ", p);
  }
  if (done || n > 4000) break;
}
proc.kill();

console.log(`\n\n=== ${n} events. every field the wire carried the command in ===\n`);
for (const [k, c] of [...seen].sort()) console.log(`${String(c).padStart(3)}×  ${k}`);

console.log(`\n=== the question this probe exists for ===`);
console.log(`  run_in_background in the model's input : ${JSON.stringify(bg)}`);
console.log(`  a description was passed              : ${hasDesc}`);
console.log(`  command length                        : ${command?.length ?? "—"}`);
console.log(`  task_notification summary length      : ${summary?.length ?? "— (none fired)"}`);
console.log(`  summary IS the command                : ${summary !== null && command !== null && summary.includes(command.split("\n")[0])}`);
if (summary) console.log(`\n  summary as the transcript would have had it:\n${summary.split("\n").map((l) => "    " + l).join("\n")}`);
