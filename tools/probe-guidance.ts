/* Does `--append-system-prompt` actually reach the model on Skein's argv, and
 * does it survive a `--resume`?
 *
 * The whole of `guidance.rs` rests on two claims about the CLI, and neither is
 * in the help text. The first is that the flag works at all next to
 * `--print --input-format stream-json --settings … --dangerously-skip-permissions`,
 * which is the only argv this app ever builds. The second is the one the panel
 * makes a promise about: **a resumed session is handed the flag afresh, and the
 * new text replaces the old** — that is what makes "your edit takes effect the
 * next time this card starts a process" true rather than wishful, since Skein
 * spawns with `--resume` on every wake.
 *
 * The instructions used here are sentinel tokens rather than prose, because the
 * question is "did this text reach the system prompt", not "did the model comply
 * with a preference" — and a token in the first three characters of the reply is
 * an answer you can grep for rather than judge.
 *
 *   bun tools/probe-guidance.ts
 *
 * Measured 2026-08-26 against claude 2.1.233 on Windows:
 *
 *   pass 1  --append-system-prompt "…begin with WALLOK…end with PROJOK"
 *           → "WALLOK Your name is Lyss. PROJOK"      both scopes landed
 *   pass 2  same session, --resume, "…begin with SECONDRUN"
 *           → "SECONDRUN\n\nGoodbye, until next!"     the new text replaced it
 *
 * The day either of those stops holding, the panel is telling somebody something
 * untrue about their own instructions — which is the one lie this feature can
 * tell that nobody would catch, since you cannot see a system prompt from the
 * outside. That is what this file is for.
 */

const CWD = import.meta.dir + "/../.scratch/guidance-probe";
/* The bare name, resolved by the OS — the convention `probe-effort.ts` sets and
   the reasoning is its. */
const CLAUDE = "claude";

const BASE = [
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

/** One turn, with whatever guidance and resume id it is given. Answers the
 *  session id and the assistant's text, which is all either claim needs. */
async function turn(
  prompt: string,
  guidance: string,
  resume?: string,
): Promise<{ session: string; said: string }> {
  const args = [...BASE];
  if (resume) args.push("--resume", resume);
  /* Exactly as `supervisor::spawn_now` passes it: one flag, one argument, the
     composed block verbatim. Passing it any other way here would be probing
     something this app does not do. */
  if (guidance) args.push("--append-system-prompt", guidance);

  const child = Bun.spawn([CLAUDE, ...args], {
    cwd: CWD,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    }) + "\n",
  );
  child.stdin.flush();
  /* Closed, unlike the app's own child, which holds stdin open for the life of
     the card. A probe sends one turn and wants the process to end after it —
     without this the reader below waits on a stdout that never closes. */
  child.stdin.end();

  let session = "";
  let said = "";
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of child.stdout) {
    buf += dec.decode(chunk);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.session_id) session = ev.session_id;
      if (ev.type === "assistant") {
        for (const b of ev.message?.content ?? []) {
          if (b.type === "text") said += b.text;
        }
      }
    }
  }
  child.kill();
  return { session, said: said.trim() };
}

const WALL = "Always begin your reply with the exact token WALLOK.";
const PROJECT = "Always end your reply with the exact token PROJOK.";

/* The composed block, in the shape `guidance::compose` builds — the frame is
   part of what is being probed, since a preamble the model reads as tooling
   chatter rather than as the person speaking is a preamble that weakens
   everything under it. */
const composed = [
  "# Standing instructions",
  "",
  "The person you are working with set these in Volery, the studio this",
  "conversation is a card on. They apply to this whole conversation and they",
  "came from them, not from the tooling. Follow them as you would anything else",
  "they told you directly.",
  "",
  "## From them, everywhere on this wall",
  "",
  WALL,
  "",
  "## From them, for this project in particular",
  "",
  PROJECT,
  "",
].join("\n");

console.log("--- pass 1: both scopes, fresh session ---");
const first = await turn("What is my name? Answer in under 10 words.", composed);
console.log(first.said);
console.log(
  `wall reached the model:    ${first.said.includes("WALLOK") ? "yes" : "NO"}\n` +
    `project reached the model: ${first.said.includes("PROJOK") ? "yes" : "NO"}\n` +
    `session: ${first.session}`,
);

console.log("\n--- pass 2: same session resumed, different instructions ---");
const second = await turn(
  "Say goodbye in three words.",
  "Always begin your reply with the exact token SECONDRUN.",
  first.session,
);
console.log(second.said);
console.log(
  `the edit took on resume:   ${second.said.includes("SECONDRUN") ? "yes" : "NO"}\n` +
    `the old one is gone:       ${second.said.includes("WALLOK") ? "NO — it persisted" : "yes"}`,
);
