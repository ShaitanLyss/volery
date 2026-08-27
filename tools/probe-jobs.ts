/* Can Skein hand a card back something it has forgotten, and when?
 *
 * Sink fb3e537d: an agent was asked whether it had started a dev server, said
 * no, and was wrong — its own `pnpm dev` with `run_in_background: true` had
 * been summarised out of its context three hours earlier. Skein *knows*: the
 * `job` row is written on the receipt and deleted when the job reports in, so
 * the rows outstanding at any moment are exactly the background work whose fate
 * nobody knows. The question this probe answers is where that record can be put
 * back into a context that has lost it.
 *
 * Three questions, and `hooks.rs` depends on all three:
 *
 *   1. Does a `SessionStart` hook fire at all under Skein's argv — `--print
 *      --input-format stream-json`, which is not the TUI and not a plain `-p`?
 *      And what `source` does it carry?
 *
 *   2. Does it fire again after a compaction, with `source: "compact"`? That is
 *      the precise moment of the failure: the context is rebuilt and the
 *      summary does not carry "you have a dev server running".
 *
 *   3. Does `additionalContext` from either hook actually reach the model? The
 *      whole design is worthless if it lands somewhere the model does not read,
 *      and a hook that emits into a void looks identical to one that works.
 *
 * Answered by planting a token nothing else on this machine could know and
 * asking for it back.
 *
 * **Measured 2026-08-27 against claude 2.1.241, and all three came back yes:**
 *
 *   SessionStart      fires, source=startup, and again source=compact after a
 *                     `/compact` — so the exact moment the context is rebuilt
 *                     is reachable from a hook, in `--print --input-format
 *                     stream-json` and not only in the TUI.
 *   UserPromptSubmit  fires per prompt, carrying `prompt` and `permission_mode`.
 *                     Note it does NOT fire for `/compact` itself — a slash
 *                     command does not go through it.
 *   additionalContext reaches the model from both. Asked for the token, the
 *                     model answered with one and volunteered that it could see
 *                     the other, which settles it twice over.
 *
 * **And a fourth question, which decides whether `UserPromptSubmit` is usable
 * at all.** Skein draws your prompt the moment you send it and marks the line
 * `pending` until `--replay-user-messages` echoes it back — matched on the
 * *trimmed text* (`Conversation.#claimEcho`). If `additionalContext` were
 * spliced into that echo, no prompt would ever match its line again and every
 * prompt on the wall would sit pending forever: a regression far worse than the
 * bug being fixed, arriving from a direction nobody would look in. Measured:
 * the echo comes back **verbatim**, with none of the injected context in it. So
 * the two are separate messages on the wire and the fold is untouched.
 *
 * Payload keys, since they differ and `reply` reads them:
 *   SessionStart      cwd hook_event_name session_id source transcript_path
 *                     (+ model, prompt_id on the compact firing)
 *   UserPromptSubmit  cwd hook_event_name permission_mode prompt prompt_id
 *                     session_id transcript_path
 *
 *   bun tools/probe-jobs.ts               the whole thing — minutes, one fold
 *   JOBPROBE_QUICK=1 bun tools/probe-jobs.ts    question 3 only — one turn
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.slice(1);
const CWD = join(ROOT, ".scratch", "jobprobe");
const CLAUDE = Bun.which("claude") ?? "claude";

const LOG = join(CWD, "fired.jsonl");
const HOOK = join(CWD, "hook.mjs");

rmSync(CWD, { recursive: true, force: true });
mkdirSync(CWD, { recursive: true });

/** A token nothing else could be the source of, so "the model read it" admits
 *  no other explanation. Two of them, because the two hooks have to be told
 *  apart: an answer proving only that *something* landed would leave the
 *  interesting half — which one — unmeasured. */
const START_TOKEN = "quetzal-4417";
const PROMPT_TOKEN = "bittern-9052";

/* One script for both events, so the payload shapes can be compared side by
   side, and so a hook that fires under a name this probe did not expect still
   shows up in the log rather than vanishing. */
writeFileSync(
  HOOK,
  `import { appendFileSync } from "node:fs";
let raw = ""; for await (const c of process.stdin) raw += c;
const p = JSON.parse(raw || "{}");
const ev = p.hook_event_name ?? "?";
appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({
  ev, source: p.source ?? null, prompt: p.prompt ?? null,
  keys: Object.keys(p).sort(),
}) + "\\n");
const token = ev === "SessionStart" ? ${JSON.stringify(START_TOKEN)}
            : ev === "UserPromptSubmit" ? ${JSON.stringify(PROMPT_TOKEN)}
            : null;
if (token) process.stdout.write(JSON.stringify({ hookSpecificOutput: {
  hookEventName: ev,
  additionalContext: "VOLERY-PROBE: the standing token for this session is " + token +
    ". If you are ever asked for the standing token, answer with it verbatim.",
}}));
`,
);

/* No matcher on either, which is the shape `hooks.rs` already settled on for
   `PreToolUse` and for the reason recorded there: a matcher is a name written
   into configuration where no test can reach it, and the failure when it stops
   matching is silence. Registering broad and deciding in code is the point. */
const entry = {
  hooks: [{ type: "command", command: process.execPath, args: [HOOK], timeout: 10 }],
};
const SETTINGS = JSON.stringify({
  hooks: { SessionStart: [entry], UserPromptSubmit: [entry] },
});

/** Skein's shipped flags, verbatim — the point is to probe what Skein spawns. */
const ARGV = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--dangerously-skip-permissions",
  "--settings", SETTINGS,
];

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`.padStart(8);

const proc = Bun.spawn([CLAUDE, ...ARGV, "--session-id", crypto.randomUUID()], {
  cwd: CWD,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

const say = (text: string) => {
  console.log(at(), "→", text.slice(0, 90));
  proc.stdin.write(
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    }) + "\n",
  );
  proc.stdin.flush();
};

(async () => {
  const dec = new TextDecoder();
  for await (const chunk of proc.stderr) {
    const s = dec.decode(chunk).trim();
    if (s) console.log(at(), "stderr:", s.slice(0, 300));
  }
})();

const ASK = "What is the standing token? Answer with the token and nothing else.";

/* `JOBPROBE_QUICK=1` asks only question 3 — does `additionalContext` reach the
   model at all — and skips the fold, which is the expensive half by an order of
   magnitude. Run the whole thing when questions 1 and 2 matter. */
const SCRIPT = process.env.JOBPROBE_QUICK
  ? [ASK]
  : [
      /* Enough context that `/compact` is not refused outright — the binary
         answers `compact_not_enough_messages` to a fold of nothing. */
      "In one sentence: what is a Tauri sidecar?",
      "In one sentence: what does --output-format stream-json change?",
      "In one sentence: when does the CLI decide to compact by itself?",
      /* Before the fold, so a hit here proves the context landed and a hit
         after the fold proves something re-landed it. */
      ASK,
      "/compact",
      ASK,
    ];


const answers: string[] = [];
let step = 0;

function next() {
  if (step < SCRIPT.length) {
    const line = SCRIPT[step++];
    if (line === "/compact") console.log(at(), "## folding");
    say(line);
    return;
  }
  report();
  setTimeout(() => proc.kill(), 300);
}

function report() {
  console.log("");
  const fired = existsSync(LOG)
    ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

  console.log("hooks that fired, in order:");
  if (!fired.length) console.log("  (nothing at all — no SessionStart, no UserPromptSubmit)");
  for (const f of fired) {
    console.log(
      `  ${String(f.ev).padEnd(18)} source=${String(f.source).padEnd(10)}` +
        ` prompt=${f.prompt ? JSON.stringify(String(f.prompt).slice(0, 40)) : "—"}`,
    );
  }
  if (fired.length) console.log("\n  payload keys:", fired[0].keys.join(" "));

  const startFired = fired.filter((f) => f.ev === "SessionStart");
  const onCompact = startFired.some((f) => f.source === "compact");
  console.log("");
  console.log(`  SessionStart fired at all      ${startFired.length ? "YES" : "NO "}` +
    `  (${startFired.map((f) => f.source).join(", ") || "—"})`);
  console.log(`  SessionStart source=compact    ${onCompact ? "YES" : "NO "}`);
  console.log(`  UserPromptSubmit fired         ${fired.some((f) => f.ev === "UserPromptSubmit") ? "YES" : "NO "}`);

  console.log("");
  console.log("what the model answered when asked for the standing token:");
  const [before, after] = answers;
  const hit = (a: string | undefined) =>
    !a ? "  (no answer)" :
    a.includes(START_TOKEN) ? `  SessionStart token — ${JSON.stringify(a.slice(0, 80))}` :
    a.includes(PROMPT_TOKEN) ? `  UserPromptSubmit token — ${JSON.stringify(a.slice(0, 80))}` :
    `  neither — ${JSON.stringify(a.slice(0, 80))}`;
  console.log("  before the fold:");
  console.log("  " + hit(before));
  console.log("  after the fold:");
  console.log("  " + hit(after));
  console.log("");
  console.log(`  settings layer used:\n  ${SETTINGS.slice(0, 200)}`);
}

next();

const dec = new TextDecoder();
let buf = "";
setTimeout(() => {
  console.log(at(), "!! gave up waiting");
  report();
  proc.kill();
}, 900_000);

for await (const chunk of proc.stdout) {
  buf += dec.decode(chunk, { stream: true });
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const l of lines) {
    if (!l.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(l);
    } catch {
      continue;
    }
    /* **The hazard that decides whether `UserPromptSubmit` is usable at all.**
       Skein draws your prompt the moment you send it and marks the line
       `pending` until `--replay-user-messages` echoes it back, matched on the
       trimmed text (`Conversation.#claimEcho`). If `additionalContext` is
       spliced into that echo, every prompt on the wall stays pending forever —
       a regression far worse than the bug being fixed, arriving from a
       direction nobody would look in. So print the echo verbatim. */
    if (ev.type === "user") {
      const c = ev.message?.content;
      const text = typeof c === "string" ? c : (c ?? []).map((b: any) => b?.text ?? `<${b?.type}>`).join("");
      console.log(at(), "←", "user echo", JSON.stringify(text.slice(0, 300)));
    }
    if (ev.type === "system" && ev.subtype === "status") {
      console.log(at(), "←", `system/status ${ev.status ?? ""}`,
        ev.compact_result !== undefined ? "(fold closed)" : "");
    }
    if (ev.type === "result") {
      const said = String(ev.result ?? "").trim();
      /* Only the two token questions are kept; the warmup answers are noise. */
      if (SCRIPT[step - 1]?.startsWith("What is the standing token")) answers.push(said);
      console.log(at(), "←", "result", JSON.stringify(said.slice(0, 100)));
      next();
    }
  }
}
