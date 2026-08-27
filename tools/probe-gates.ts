/* What does `PostToolUse` actually hand a hook, and can the wall learn from it
 * that a gate went red?
 *
 * Sink 3ebe1d59: nothing on the wall knows whether the tree builds. On
 * 2026-08-27 a `vergen`/`vergen_lib` conflict broke `cargo check` for every
 * card at once with an error naming nobody's file, and three cards diagnosed it
 * independently — one of them by broadcasting to the whole wall and then having
 * to retract, one by assuming its own new code was at fault, and one by
 * silently fixing it. A fourth ran `git stash` in the shared tree, wiping four
 * cards' work, while trying to answer *"is this error pre-existing or mine?"*
 *
 * The fix must not be a fourth poller. `CLAUDE.md` is explicit that there are
 * exactly three places in this app that go and look and that each owes an
 * argument; running the gates on a timer would be expensive **and** would fight
 * the cards for the cargo lock, which was itself a source of contention that
 * day. Cards run these gates constantly of their own accord, so the honest
 * shape is to fold what already happens — which means a hook, and it means this
 * probe, because `PreToolUse` sees the command and not the result.
 *
 * Six questions, and `gates.rs` cannot be designed without the first four:
 *
 *   1. Does `PostToolUse` fire at all under Skein's argv — `--print
 *      --input-format stream-json`, which is neither the TUI nor a plain `-p`?
 *      `hooks.md` records the matcher that stopped matching, so this asks with
 *      no matcher at all.
 *
 *   2. **Does the payload distinguish a command that succeeded from one that
 *      failed?** This is the load-bearing question. If `tool_response` carries
 *      no exit status then a green gate and a red one look identical to a hook,
 *      the record would have to be inferred from stdout by heuristic, and the
 *      design is a different one.
 *
 *   3. Is the command's *output* there, and how much of it? A reading that says
 *      "red" and cannot say what failed sends the reader to run the gate again,
 *      which is the cost this is meant to remove.
 *
 *   4. For a **backgrounded** call, does it fire on the receipt or on the
 *      completion? A dev server never completes, so if it fires at receipt the
 *      outcome of a backgrounded `bun run test` is not observable here at all
 *      and only the `job` table's own route can close it.
 *
 *   5. Does `additionalContext` from `PostToolUse` reach the model? That is the
 *      cheapest possible delivery of "another card already saw this red" — it
 *      arrives at the exact moment the card is staring at the failure, which is
 *      the moment the `git stash` reflex fires. If it does not land, delivery
 *      falls back to `UserPromptSubmit`, which `hooks.rs` already uses.
 *
 *   6. Same question for `PreToolUse`, which would let a card be told *before*
 *      it spends two minutes on a gate a sibling has already proved red.
 *
 * Answered by planting a token nothing else on this machine could be the source
 * of and asking for it back, which is `tools/probe-jobs.ts`'s method.
 *
 * ── Measured 2026-08-27 against claude 2.1.241, run twice ──────────────────
 *
 * **The one that decided the design, and it is the opposite of what was
 * assumed: `PostToolUse` does not fire for a tool call that failed.** Four
 * failing commands reached `PreToolUse` across two runs and not one of them
 * produced a `PostToolUse`. Eliminated as a crash in this probe's own hook by
 * logging a receipt before parsing anything: 6 receipts, 6 parsed firings, so
 * the CLI is not calling the hook rather than the hook dying on the payload.
 *
 * That is not an obstacle, it is the mechanism — and it is the bargain the `job`
 * table already strikes, one domain over. `PreToolUse` fires unconditionally, so
 * it says *a gate run started*. `PostToolUse` fires only on success, so its
 * arrival **is** the pass — which is also why `tool_response` carries no exit
 * status and does not need one. A row opened by the first and never closed by
 * the second is, by construction rather than by a query, a gate that did not
 * pass. See `hooks.md` on `job`: the row is written on the receipt and deleted
 * when the job reports in.
 *
 *   tool_response keys   stdout stderr interrupted isImage      — and NO exit code
 *   PostToolUse extras   duration_ms, which is the run's cost for free
 *   tool_use_id          on BOTH events, so the two are pairable
 *   backgrounded         PostToolUse fires ON THE RECEIPT, carrying
 *                        `backgroundTaskId` and an empty stdout. So it must NOT
 *                        be read as a pass — a backgrounded gate's outcome is
 *                        not observable here at all, and belongs to `job`.
 *   additionalContext    reaches the model from BOTH PreToolUse and PostToolUse
 *                        — asked for every token it could see, it listed both.
 *   tool_name            `PowerShell` here, `Bash` under Volery. Both live on
 *                        this machine at once; `hooks.md` records the matcher
 *                        that rotted on exactly this. Detect on the shape (does
 *                        the input carry a `command`), never on the name.
 *
 * Two bugs in the first version of this probe, both worth knowing because each
 * produced a confident wrong answer rather than an error:
 *
 *   - It scored the token question against the *last* `result`, and a
 *     backgrounded call reports its own completion as a further `result` after
 *     the question has been answered. A run that had seen both tokens was
 *     scored as having seen neither.
 *   - It logged nothing before parsing, so "the hook never fired" and "the hook
 *     threw on this payload" were the same silence — on the single question the
 *     design rests on.
 *
 *   bun tools/probe-gates.ts          the whole thing — one session, 5 turns
 *   GATEPROBE_KEEP=1 …                leave .scratch/gateprobe/fired.jsonl behind
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.slice(1);
const CWD = join(ROOT, ".scratch", "gateprobe");
const CLAUDE = Bun.which("claude") ?? "claude";

const LOG = join(CWD, "fired.jsonl");
const HOOK = join(CWD, "hook.mjs");

rmSync(CWD, { recursive: true, force: true });
mkdirSync(CWD, { recursive: true });

/** Two tokens, because questions 5 and 6 have to be told apart: an answer
 *  proving only that *something* landed would leave the interesting half — from
 *  which event — unmeasured. */
const POST_TOKEN = "kestrel-7731";
const PRE_TOKEN = "godwit-2204";

/* One script for every event, registered against all of them with no matcher —
   the shape `hooks.rs` settled on and for the reason recorded there: a matcher
   is a name written into configuration where no test can reach it, and the
   failure when it stops matching is silence. A hook firing under a name this
   probe did not expect therefore still shows up in the log.

   The whole payload is kept, with long strings shortened rather than dropped:
   the question is what the shape *is*, and a probe that only logged the keys it
   already expected would answer it with its own assumptions. */
writeFileSync(
  HOOK,
  [
    'import { appendFileSync } from "node:fs";',
    'let raw = ""; for await (const c of process.stdin) raw += c;',
    /* **The raw line goes down before anything is parsed**, and it is what makes
       a firing that *crashed* distinguishable from one that never happened. The
       first run of this probe logged nothing at all for the command that failed,
       and "PostToolUse does not fire on failure" and "my hook threw on the
       failure payload" are the same silence — with opposite consequences for the
       design resting on it. */
    'appendFileSync(' + JSON.stringify(LOG) + ', JSON.stringify({ arrived: raw.length }) + "\\n");',
    'const p = JSON.parse(raw || "{}");',
    'const ev = p.hook_event_name ?? "?";',
    "const shrink = (v, d = 0) => {",
    '  if (typeof v === "string") return v.length > 300 ? v.slice(0, 300) + "…[" + v.length + " chars]" : v;',
    "  if (v === null || typeof v !== \"object\") return v;",
    '  if (d > 3) return "…[deeper]";',
    "  if (Array.isArray(v)) return v.slice(0, 6).map((x) => shrink(x, d + 1));",
    "  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x, d + 1)]));",
    "};",
    "appendFileSync(" + JSON.stringify(LOG) + ", JSON.stringify({",
    "  ev,",
    "  keys: Object.keys(p).sort(),",
    "  tool: p.tool_name ?? null,",
    "  command: p.tool_input?.command ?? null,",
    "  background: p.tool_input?.run_in_background ?? null,",
    "  responseType: Array.isArray(p.tool_response)",
    '    ? "array"',
    "    : p.tool_response === null || p.tool_response === undefined",
    "      ? String(p.tool_response)",
    "      : typeof p.tool_response,",
    "  responseKeys:",
    '    p.tool_response && typeof p.tool_response === "object" && !Array.isArray(p.tool_response)',
    "      ? Object.keys(p.tool_response).sort()",
    "      : null,",
    "  response: shrink(p.tool_response),",
    '  at: new Date().toISOString(),',
    '}) + "\\n");',
    "const token = ev === \"PostToolUse\" ? " + JSON.stringify(POST_TOKEN),
    '            : ev === "PreToolUse" ? ' + JSON.stringify(PRE_TOKEN),
    "            : null;",
    "if (token) process.stdout.write(JSON.stringify({ hookSpecificOutput: {",
    "  hookEventName: ev,",
    '  additionalContext: "VOLERY-PROBE: the " + ev + " token is " + token +',
    '    ". If you are ever asked for a token, answer with every token you can see, verbatim.",',
    "}}));",
  ].join("\n"),
);

const entry = {
  hooks: [{ type: "command", command: process.execPath, args: [HOOK], timeout: 10 }],
};
const SETTINGS = JSON.stringify({
  hooks: { PreToolUse: [entry], PostToolUse: [entry] },
});

/** Skein's shipped flags, verbatim — the point is to probe what Skein spawns.
 *  Haiku because none of these questions are about the model, and the session
 *  is five turns of running `echo`. */
const ARGV = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--dangerously-skip-permissions",
  "--model", "claude-haiku-4-5-20251001",
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
  console.log(at(), "→", text.slice(0, 90).replace(/\n/g, " ⏎ "));
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

/* A pass, a failure, and a backgrounded call — the three shapes a gate run
   takes. The failure is the one the whole design turns on, so it is made
   unmistakable: a distinctive exit code, output on *both* streams, and a
   message no successful command could produce. */
const PASS = "Run this exact Bash command and nothing else: echo GATE-OK";
const FAIL =
  "Run this exact Bash command and nothing else, and do not try to fix or " +
  "rerun it afterwards — it is meant to fail: " +
  "sh -c 'echo on-stdout; echo GATE-BROKE-on-stderr >&2; exit 23'";
const BG =
  "Run this exact Bash command with run_in_background set to true, and nothing " +
  "else: sh -c 'sleep 6; echo LATE-OUTPUT; exit 19'";
const ASK =
  "List every VOLERY-PROBE token you can see, verbatim, and nothing else. If " +
  "you can see none, answer exactly: NONE.";

/* A second failure, shaped like a real gate rather than like a probe: no output
   at all, just a non-zero exit. `cargo check` on a red tree is the loud kind and
   a failing `bun test` can be the quiet kind, and if only one of them is
   observable the design has to know which. */
const FAIL_QUIET =
  "Run this exact Bash command and nothing else, and do not investigate or " +
  "retry it — a non-zero exit is the point: sh -c 'exit 1'";

const SCRIPT = [PASS, FAIL, FAIL_QUIET, BG, ASK];

const answers: string[] = [];
let step = 0;

function next() {
  if (step < SCRIPT.length) {
    say(SCRIPT[step++]);
    return;
  }
  /* The backgrounded call needs longer than its own sleep before question 4 can
     be answered: if `PostToolUse` fires on completion rather than on receipt,
     the second firing arrives while nothing else is happening. */
  console.log(at(), "## waiting out the backgrounded sleep");
  setTimeout(() => {
    report();
    setTimeout(() => proc.kill(), 300);
  }, 12_000);
}

function lines() {
  return existsSync(LOG)
    ? readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
}

/** The parsed firings. `arrived` rows are the pre-parse receipts. */
function fired() {
  return lines().filter((r) => r.ev !== undefined);
}

function report() {
  const rows = fired();
  console.log("");
  console.log("── every hook firing, in order ─────────────────────────────");
  if (!rows.length) console.log("  (nothing at all — no PreToolUse, no PostToolUse)");
  for (const r of rows) {
    console.log(
      `  ${String(r.ev).padEnd(12)} ${String(r.tool).padEnd(10)}` +
        ` bg=${String(r.background).padEnd(5)} response=${r.responseType}` +
        `  ${r.command ? JSON.stringify(String(r.command).slice(0, 46)) : ""}`,
    );
  }

  const post = rows.filter((r) => r.ev === "PostToolUse");
  const pre = rows.filter((r) => r.ev === "PreToolUse");

  console.log("");
  console.log("── 1. does PostToolUse fire under Skein's argv ─────────────");
  console.log(`  ${post.length ? "YES" : "NO "}  (${post.length} firings)`);
  if (post.length) console.log("  payload keys:", post[0].keys.join(" "));

  console.log("");
  console.log("── 2/3. what a PostToolUse payload carries ────────────────");
  for (const r of post) {
    console.log(`  ${JSON.stringify(String(r.command).slice(0, 60))}`);
    console.log(`    tool_response is ${r.responseType}` +
      (r.responseKeys ? `, keys: ${r.responseKeys.join(" ")}` : ""));
    console.log("    " + JSON.stringify(r.response).slice(0, 900));
  }

  /* **The question the whole design rests on.** A gate is interesting when it is
     red, so if a failing command emits no `PostToolUse` then the one outcome
     worth recording is the one that cannot be observed here, and the record has
     to be built from `PreToolUse` plus something else entirely. */
  console.log("");
  console.log("── 2b. DOES A FAILING COMMAND PRODUCE A PostToolUse ───────");
  const failed = (r: any) => /exit (1|23)'?$|GATE-BROKE/.test(String(r.command ?? ""));
  const failPre = pre.filter(failed);
  const failPost = post.filter(failed);
  console.log(`  failing commands seen by PreToolUse:   ${failPre.length}`);
  console.log(`  the same commands seen by PostToolUse:  ${failPost.length}`);
  console.log(
    failPre.length && !failPost.length
      ? "  → NO. PostToolUse does not fire for a tool call that failed.\n" +
        "    Every firing arrived whole (see the pre-parse receipts below), so this\n" +
        "    is the CLI not calling the hook rather than the hook crashing."
      : failPost.length
        ? "  → YES, it fires. What it carries about the failure is above."
        : "  → inconclusive: no failing command reached PreToolUse either.",
  );
  const receipts = lines().filter((r) => r.arrived !== undefined).length;
  console.log(`  pre-parse receipts: ${receipts}, parsed firings: ${rows.length}` +
    (receipts === rows.length ? "  (none crashed)" : "  ← A HOOK CRASHED, mid-parse"));

  console.log("");
  console.log("── 4. the backgrounded call ───────────────────────────────");
  const bg = rows.filter((r) => r.background === true);
  console.log(`  firings mentioning run_in_background: ${bg.length}` +
    ` (${bg.map((r) => r.ev).join(", ") || "—"})`);
  const bgPost = bg.filter((r) => r.ev === "PostToolUse");
  console.log(
    bgPost.length === 0
      ? "  no PostToolUse at all for the backgrounded call"
      : bgPost.length === 1
        ? "  exactly ONE PostToolUse — so it fires on the receipt or on the exit, and\n" +
          "  which one is decided by whether its response holds LATE-OUTPUT:  " +
          (JSON.stringify(bgPost[0].response).includes("LATE-OUTPUT") ? "ON THE EXIT" : "ON THE RECEIPT")
        : "  more than one PostToolUse — receipt AND completion",
  );

  console.log("");
  console.log("── 5/6. does additionalContext reach the model ─────────────");
  /* **Every answer, not the last one.** A backgrounded call reports its own
     completion as a further `result` after the token question has been answered,
     so reading only the final answer scored a run that had in fact seen both
     tokens as having seen neither. */
  const said = answers.join("\n");
  console.log(`  the model answered: ${JSON.stringify(said.slice(-200))}`);
  console.log(`  PostToolUse token seen   ${said.includes(POST_TOKEN) ? "YES" : "NO "}`);
  console.log(`  PreToolUse  token seen   ${said.includes(PRE_TOKEN) ? "YES" : "NO "}`);
  console.log("");
  console.log(`  ${pre.length} PreToolUse firings, ${post.length} PostToolUse`);
  if (!process.env.GATEPROBE_KEEP) console.log(`  (log kept at ${LOG} — GATEPROBE_KEEP=1 to keep the dir)`);
}

next();

const dec = new TextDecoder();
let buf = "";
const giveUp = setTimeout(() => {
  console.log(at(), "!! gave up waiting");
  report();
  proc.kill();
}, 600_000);

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
    if (ev.type === "assistant") {
      const text = (ev.message?.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      if (text.trim()) console.log(at(), "←", text.slice(0, 200).replace(/\n/g, " ⏎ "));
    }
    if (ev.type === "result") {
      const text = (ev.result ?? "").toString();
      answers.push(text);
      next();
    }
  }
}
clearTimeout(giveUp);
