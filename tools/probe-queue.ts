/* What happens to a prompt written to stdin while a turn is already running?
 *
 * `conversation.svelte.ts` says the CLI *queues* it behind the running turn,
 * and that it was "finally taken up minutes later". This probe answers the
 * question that matters to the wall: once the running turn's `result` lands,
 * does the queued prompt get taken up on its own — and how long does it take?
 *
 *   bun tools/probe-queue.ts            # send B while A is running
 *   bun tools/probe-queue.ts idle       # send B after A's result, as a control
 *   bun tools/probe-queue.ts stop       # send B while A runs, then interrupt A
 *
 * Nothing here needs a tool: both prompts are arithmetic, so the probe cannot
 * touch the repo it is spawned in.
 *
 * Costs two short real turns.
 */

/* The repo this is run from, rather than a path written down once. It was
   hard-coded to `C:/atelier/skein`, which this machine does not have, so the
   probe spawned into a directory that is not there — the usual silent rot of a
   tool nothing runs between the two times it is needed. */
const CWD = (await Bun.$`git rev-parse --show-toplevel`.text()).trim();
const CLAUDE = Bun.which("claude") ?? "claude";

/* Pinned small by default. Nothing measured here is a property of the model —
   whether a queued prompt is replayed is the CLI's bookkeeping — and the
   alternative is two real Opus turns to answer a question about plumbing.
   `PROBE_MODEL=` empty runs whatever the CLI would have chosen. */
const MODEL = process.env.PROBE_MODEL ?? "claude-haiku-4-5-20251001";

/** Skein's shipped flags, verbatim. */
const ARGV = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--forward-subagent-text",
  "--dangerously-skip-permissions",
  ...(MODEL ? ["--model", MODEL] : []),
];

const mode = Bun.argv[2] ?? "busy";
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`.padStart(8);

const A = "Count from 1 to 120, one number per line, nothing else. Use no tools.";
const B = "MARKER-BRAVO: reply with exactly the word bravo and nothing else. Use no tools.";

const proc = Bun.spawn([CLAUDE, ...ARGV, "--session-id", crypto.randomUUID()], {
  cwd: CWD, stdin: "pipe", stdout: "pipe", stderr: "pipe",
});

const send = (text: string, tag: string) => {
  console.log(at(), `→ ${tag}`);
  proc.stdin.write(JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  }) + "\n");
  proc.stdin.flush();
};

const control = (subtype: string) => {
  console.log(at(), `→ control ${subtype}`);
  proc.stdin.write(JSON.stringify({
    type: "control_request",
    request_id: crypto.randomUUID(),
    request: { subtype },
  }) + "\n");
  proc.stdin.flush();
};

(async () => {
  const dec = new TextDecoder();
  for await (const chunk of proc.stderr) {
    const s = dec.decode(chunk).trim();
    if (s) console.log(at(), "stderr:", s);
  }
})();

send(A, "prompt A (long)");

let results = 0;
let sentB = false;
let bReplayed = false;
let deadline = 0;

const dec = new TextDecoder();
let buf = "";
for await (const chunk of proc.stdout) {
  buf += dec.decode(chunk);
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { console.log(at(), "raw:", line.slice(0, 120)); continue; }

    if (ev.type === "stream_event") {
      /* One line the first time we see the model actually talking on A, then
         quiet — the point is the timeline, not the tokens. */
      if (mode !== "idle" && !sentB && ev.event?.type === "content_block_delta") {
        sentB = true;
        send(B, "prompt B (while A runs)");
        if (mode === "stop") setTimeout(() => control("interrupt"), 1500);
      }
      continue;
    }

    const said = (ev.message?.content ?? [])
      .filter((b: any) => b?.type === "text").map((b: any) => b.text).join("").trim();

    if (ev.type === "user") {
      const isB = said.includes("MARKER-BRAVO");
      console.log(at(), `user  isReplay=${ev.isReplay ?? false} ${isB ? "[= B replayed]" : ""} ${JSON.stringify(said.slice(0, 70))}`);
      if (isB) bReplayed = true;
    } else if (ev.type === "assistant") {
      console.log(at(), `assistant ${JSON.stringify(said.slice(0, 70))}`);
    } else if (ev.type === "result") {
      results += 1;
      console.log(at(), `result #${results} subtype=${ev.subtype} reason=${ev.terminal_reason ?? "-"} B-replayed=${bReplayed}`);
      if (mode === "idle" && results === 1 && !sentB) { sentB = true; send(B, "prompt B (card idle)"); continue; }
      if (results >= 2 || bReplayed) { console.log(at(), "== B was taken up =="); break; }
      /* A's turn is over and B has not been echoed. Wait and see whether the
         CLI ever drains it on its own. */
      deadline = Date.now() + 90_000;
      console.log(at(), "== A finished, B not yet echoed — watching 90s ==");
      setTimeout(() => {
        console.log(at(), "== 90s elapsed with no turn on B ==");
        proc.kill();
      }, 90_000);
    } else if (ev.type === "control_response") {
      console.log(at(), "control_response", JSON.stringify(ev.response ?? ev));
    } else if (ev.type === "system") {
      console.log(at(), `system/${ev.subtype}`);
    }
  }
}
console.log(at(), `done — results=${results} B replayed=${bReplayed}`);
proc.kill();
