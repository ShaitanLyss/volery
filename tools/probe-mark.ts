/* Can the wire carry a mark on a prompt?
 *
 * The wall sends some prompts on somebody else's behalf: the resumed-turn prompt, the jobs
 * report, the job nudge, the pick-up, and the two briefs an agent writes (a plan handover and
 * a spawned card's brief). Live, the front end knows, because the send is its own — but a
 * session file records them as ordinary `user` messages with nothing marking them, so after a
 * restart `own.ts` has to recognise them from their words, and the two free-form briefs cannot
 * be recognised at all. They read as the person's own prompts.
 *
 * The question this answers: **does the CLI keep an extra field we put on the user envelope** —
 * on the replay for the live fold, in the session file for the restored one — so a mark could
 * travel with the prompt instead of being guessed? Is `isMeta` one we may set ourselves?
 *
 *   bun tools/probe-mark.ts
 *
 * Four tiny turns on Haiku. One variable per variant, which is the whole of the method
 * (`docs`/`tools/probe-context.ts`): the same sentence, differing only in where the field sits.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.slice(1);
const CWD = join(ROOT, `.scratch-${process.env.SKEIN_CARD ?? "probe"}`, "probemark");
const CLAUDE = Bun.which("claude") ?? "claude";
mkdirSync(CWD, { recursive: true });

/** Skein's shipped flags, verbatim, plus a pinned model. */
const ARGV = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--dangerously-skip-permissions",
  "--model", "claude-haiku-4-5-20251001",
];

const session = crypto.randomUUID();
const proc = Bun.spawn([CLAUDE, ...ARGV, "--session-id", session], {
  cwd: CWD,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

/** The directory the CLI files this session under: every non-alphanumeric folded to `-`. */
const slug = CWD.replace(/[^A-Za-z0-9]/g, "-");
const transcript = join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".claude", "projects", slug, `${session}.jsonl`);

type Variant = { name: string; text: string; rec: (text: string) => unknown };

const VARIANTS: Variant[] = [
  { name: "baseline", text: "say only: alpha", rec: (text) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) },
  {
    name: "field on the record",
    text: "say only: bravo",
    rec: (text) => ({ type: "user", skeinOwn: true, message: { role: "user", content: [{ type: "text", text }] } }),
  },
  {
    name: "field inside message",
    text: "say only: charlie",
    rec: (text) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }], skeinOwn: true } }),
  },
  {
    name: "isMeta on the record",
    text: "say only: delta",
    rec: (text) => ({ type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text }] } }),
  },
];

const ran: string[] = [];
const echoes = new Map<string, string[]>();

const say = (v: Variant) => {
  ran.push(v.text);
  proc.stdin.write(JSON.stringify(v.rec(v.text)) + "\n");
  proc.stdin.flush();
};

let settle: (() => void) | null = null;

(async () => {
  for await (const chunk of proc.stderr) {
    const s = new TextDecoder().decode(chunk).trim();
    if (s) console.log("stderr:", s);
  }
})();

(async () => {
  let buf = "";
  for await (const chunk of proc.stdout) {
    buf += new TextDecoder().decode(chunk);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "user") {
        const c = ev.message?.content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("") : "";
        if (!text.trim()) continue;
        const keys = Object.keys(ev).filter((k) => !["type", "uuid", "timestamp", "session_id", "parent_tool_use_id", "message"].includes(k));
        echoes.set(text.trim(), keys);
        console.log("replay:", JSON.stringify(text.slice(0, 40)), "| record keys:", keys.join(", ") || "(none)");
      }
      if (ev.type === "result") settle?.();
    }
  }
})();

const turn = async (v: Variant) => {
  await new Promise<void>((res) => {
    settle = () => { settle = null; res(); };
    say(v);
    setTimeout(() => { settle = null; res(); }, 90_000);
  });
};

for (const v of VARIANTS) await turn(v);
await new Promise((r) => setTimeout(r, 1500));
proc.kill();

/* What the session file kept, which is the half the restored fold reads. */
console.log("\n=== where the fields went ===");
let lines: any[] = [];
try {
  lines = readFileSync(transcript, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
} catch (err) {
  console.log("no transcript at", transcript, String(err));
}
for (const v of VARIANTS) {
  const rec = lines.find((r) => {
    const c = r?.message?.content;
    const t = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("") : "";
    return t.trim() === v.text;
  });
  const own = rec && (rec.skeinOwn !== undefined || rec.message?.skeinOwn !== undefined);
  console.log(`\n${v.name.padEnd(24)} ${JSON.stringify(v.text)}`);
  console.log("  replay record keys :", (echoes.get(v.text) ?? []).join(", ") || "(nothing echoed)");
  console.log("  session record     :", rec ? Object.keys(rec).join(", ") : "(not found)");
  console.log("  mark survived      :", rec ? (own ? "YES" : "no") : "n/a", rec?.isMeta ? "| isMeta kept" : "");
}

/* Only this probe's own session: the rest of the machine's transcripts are not ours to touch. */
try {
  rmSync(transcript);
  rmSync(join(transcript, ".."), { recursive: false });
} catch {}
