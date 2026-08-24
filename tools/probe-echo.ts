/* Which prompts does `--replay-user-messages` actually echo back?
 *
 * `#claimEcho` in `conversation.svelte.ts` closes the books on a line when the
 * wire replays it. `awaiting` is what is left unclaimed, and `unacknowledged`
 * — the whole trigger for the prompt nudge — is `awaiting > 0` for longer than
 * the grace. So a prompt the CLI answers *itself*, without a model, is the
 * question: does it come back as a `user` event like any other, or does it
 * vanish, leaving a line awaited forever and a card that can never stop
 * looking stuck?
 *
 * `classify.ts` already records what these turns look like from the result end
 * — `num_turns: 0`, an all-zero usage, a `<synthetic>` assistant message
 * (probed 2026-08-14, claude 2.1.232). It says nothing about the replay, and
 * the replay is what the books are kept on.
 *
 *   bun tools/probe-echo.ts
 *
 * Costs two very small real turns.
 */

const CWD = new URL("../.scratch/probe", import.meta.url).pathname.slice(1);
const CLAUDE = Bun.which("claude") ?? "claude";

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
];

await Bun.$`mkdir -p ${CWD}`.quiet();

const proc = Bun.spawn([CLAUDE, ...ARGV, "--session-id", crypto.randomUUID()], {
  cwd: CWD, stdin: "pipe", stdout: "pipe", stderr: "pipe",
});

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`.padStart(7);

/* What was sent, and whether anything ever came back claiming to be it. This is
   `awaiting` in miniature — the same trimmed-text match `#echoOf` uses. */
const sent: { text: string; echoed: boolean }[] = [];

const say = (text: string) => {
  sent.push({ text, echoed: false });
  console.log(at(), "→ send:", JSON.stringify(text));
  proc.stdin.write(JSON.stringify({
    type: "user", message: { role: "user", content: [{ type: "text", text }] },
  }) + "\n");
  proc.stdin.flush();
};

(async () => {
  const dec = new TextDecoder();
  for await (const c of proc.stderr) { const s = dec.decode(c).trim(); if (s) console.log(at(), "stderr:", s); }
})();

let settle: (() => void) | null = null;

(async () => {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of proc.stdout) {
    buf += dec.decode(chunk);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev: any; try { ev = JSON.parse(line); } catch { continue; }

      if (ev.type === "user") {
        const c = ev.message?.content;
        const text = typeof c === "string" ? c
          : Array.isArray(c) ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("") : "";
        console.log(at(), "← USER REPLAY:", JSON.stringify(text.slice(0, 80)));
        const hit = sent.find((s) => !s.echoed && s.text.trim() === text.trim());
        if (hit) hit.echoed = true;
        else console.log(at(), "   (matched nothing sent — would not claim a line)");
      }
      if (ev.type === "result") {
        console.log(at(), `← result: subtype=${ev.subtype} num_turns=${ev.num_turns} :: ${String(ev.result ?? "").slice(0, 90)}`);
        settle?.(); settle = null;
      }
    }
  }
})();

const turn = (text: string) =>
  new Promise<void>((res) => { settle = res; say(text); setTimeout(() => { settle = null; res(); }, 90_000); });

await turn("say only: ok");
await turn("/model sonnet");
await turn("say only: done");

await new Promise((r) => setTimeout(r, 2000));
console.log("\n=== the books ===");
for (const s of sent) console.log(`  ${s.echoed ? "claimed  " : "AWAITED  "} ${JSON.stringify(s.text)}`);
const stuck = sent.filter((s) => !s.echoed);
console.log(`\nawaiting would be ${stuck.length} — ${stuck.length ? "a card in this state is `unacknowledged` forever" : "the books close"}`);
proc.kill();
