/* How long is a card actually at rest between a <task-notification> arriving
 * and the turn it wakes?
 *
 * `WAKE_GRACE_S` is 12s and is set against a wake delay measured off
 * transcripts — but a transcript records the *finished* assistant message, and
 * `#beginTurn` fires on the first `thinking` block of the turn. Those are not
 * the same instant and on a reasoning model they are minutes apart. So the
 * transcript number says nothing about whether the nudge's timer ever finds a
 * card at rest, and this is the only place the answer exists.
 *
 *   bun tools/probe-nudge.ts
 *
 * Costs two small real turns and about a minute.
 */
const CWD = new URL("../.scratch/probe", import.meta.url).pathname.slice(1);
const CLAUDE = Bun.which("claude") ?? "claude";
const ARGV = ["--print","--input-format","stream-json","--output-format","stream-json","--verbose",
  "--include-partial-messages","--replay-user-messages","--forward-subagent-text","--dangerously-skip-permissions"];

await Bun.$`mkdir -p ${CWD}`.quiet();
const proc = Bun.spawn([CLAUDE, ...ARGV, "--session-id", crypto.randomUUID()], {
  cwd: CWD, stdin: "pipe", stdout: "pipe", stderr: "pipe" });

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`.padStart(8);
const say = (text: string) => {
  console.log(at(), "→", JSON.stringify(text).slice(0, 90));
  proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
  proc.stdin.flush();
};

/* The two instants the grace sits between. */
let notifiedAt = 0;
let settle: (() => void) | null = null;

(async () => { const d = new TextDecoder(); for await (const c of proc.stderr) { const s = d.decode(c).trim(); if (s) console.log(at(), "stderr:", s.slice(0,160)); } })();

(async () => {
  const d = new TextDecoder(); let buf = "";
  for await (const chunk of proc.stdout) {
    buf += d.decode(chunk); let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev: any; try { ev = JSON.parse(line); } catch { continue; }

      if (ev.type === "system" && /task|background/.test(ev.subtype ?? "")) {
        console.log(at(), "  RAW:", JSON.stringify(ev).slice(0, 1200));
      }
      if (ev.type !== "stream_event") {
        const cc = ev.message?.content;
        const tx = typeof cc === "string" ? cc : Array.isArray(cc)
          ? cc.map((b: any) => b?.type === "text" ? b.text : `[${b?.type}]`).join("") : "";
        console.log(at(), `  · ${ev.type}${ev.subtype ? "/" + ev.subtype : ""} ${JSON.stringify(tx.slice(0, 100))}`);
      }
      if (ev.type === "user") {
        const c = ev.message?.content;
        const text = typeof c === "string" ? c : Array.isArray(c)
          ? c.map((b: any) => b?.type === "text" ? b.text : b?.type === "tool_result" ? "[tool_result]" : "").join("") : "";
        if (text.includes("<task-notification>")) {
          notifiedAt = Date.now();
          console.log(at(), "← <task-notification> ARRIVED  ← the grace starts here");
        }
      }
      /* Exactly the events `#beginTurn` fires on. */
      if (ev.type === "stream_event") {
        const e = ev.event;
        const opens = (e?.type === "content_block_start" && ["tool_use","thinking"].includes(e.content_block?.type))
          || (e?.type === "content_block_delta" && ["text_delta","thinking_delta"].includes(e.delta?.type));
        if (opens && notifiedAt) {
          const dt = (Date.now() - notifiedAt) / 1000;
          console.log(at(), `← FIRST TURN EVENT — the card was at rest for ${dt.toFixed(2)}s`);
          console.log(`\n   grace is 12.00s → the nudge timer would have ${dt < 12 ? "found a WORKING card and returned (no nudge)" : "FIRED"}\n`);
          notifiedAt = 0;
        }
      }
      if (ev.type === "result") { console.log(at(), `← result num_turns=${ev.num_turns}`); settle?.(); settle = null; }
    }
  }
})();

const turn = (text: string, ms = 120_000) =>
  new Promise<void>((res) => { settle = res; say(text); setTimeout(() => { settle = null; res(); }, ms); });

await turn("Run this in the background with run_in_background true, using the Bash tool: bash -c 'sleep 20; echo finished'. Then reply with only the word: launched. Do not wait for it, do not check on it, do not say anything else.");
console.log(at(), "--- turn done; now watching an at-rest card for 90s ---");
await new Promise((r) => setTimeout(r, 90_000));
proc.kill();
