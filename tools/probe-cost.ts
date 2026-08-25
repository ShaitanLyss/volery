/* What is `result.total_cost_usd` a running total *of*?
 *
 * The wall's day figure and every row of the ledger are built from it.
 * `conversation.svelte.ts` treats it as a session total and books the turn's
 * own cost as the step it took:
 *
 *     usd: Math.max(0, ev.total_cost_usd - this.#costAtLastTurn)
 *
 * `#costAtLastTurn` is a field on a `Conversation`, so its origin is the
 * *object* — zero for every card painted from SQLite at launch. If the number
 * on the wire is a running total per **process**, those two origins disagree
 * every time a card is woken, and the store says both failure modes are
 * happening. On 2026-08-25, in one day of turns:
 *
 *     0 tokens, $13.52       a cost step with no usage to justify it
 *     4.7M cache reads, $0   a real turn booked at nothing, the step clamped
 *
 * The clamp is the giveaway: `Math.max(0, …)` only fires when the number went
 * *down*, which a session total cannot do.
 *
 * So: does a resumed session's `total_cost_usd` carry the cost of the turns
 * before the resume, or start again from this process's own spend?
 *
 *   bun tools/probe-cost.ts
 *
 * Costs two very small real turns. Prints the two totals and the answer.
 */

const CWD = new URL("../.scratch/probe", import.meta.url).pathname.slice(1);
const CLAUDE = Bun.which("claude") ?? "claude";

/** Skein's shipped flags, verbatim — `probe-echo.ts`'s list. */
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

const session = crypto.randomUUID();

type Result = {
  cost: number | null;
  turns: number | null;
  usage: Record<string, number> | null;
};

/** One process: spawn it the way Skein does, say one thing, keep the `result`. */
async function once(mode: "fresh" | "resume", text: string): Promise<Result> {
  const flag = mode === "fresh" ? ["--session-id", session] : ["--resume", session];
  const proc = Bun.spawn([CLAUDE, ...ARGV, ...flag], {
    cwd: CWD, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });

  (async () => {
    const dec = new TextDecoder();
    for await (const c of proc.stderr) {
      const s = dec.decode(c).trim();
      if (s) console.log(`  [${mode}] stderr:`, s);
    }
  })();

  proc.stdin.write(JSON.stringify({
    type: "user", message: { role: "user", content: [{ type: "text", text }] },
  }) + "\n");
  proc.stdin.flush();

  let out: Result = { cost: null, turns: null, usage: null };
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of proc.stdout) {
    buf += dec.decode(chunk);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type !== "result") continue;
      const u = ev.usage ?? null;
      out = {
        cost: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : null,
        turns: typeof ev.num_turns === "number" ? ev.num_turns : null,
        usage: u && {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cache_read: u.cache_read_input_tokens ?? 0,
          cache_write: u.cache_creation_input_tokens ?? 0,
        },
      };
      proc.kill();
      return out;
    }
  }
  proc.kill();
  return out;
}

console.log("session", session, "\n");

console.log("── first process, fresh session ──");
const a = await once("fresh", "say only: ok");
console.log("  total_cost_usd", a.cost, " num_turns", a.turns, " usage", a.usage, "\n");

/* Long enough that the first process has certainly let the session file go —
   the CLI writes the transcript as it ends, and `--resume` reads it. */
await new Promise((r) => setTimeout(r, 2000));

console.log("── second process, --resume of the same session ──");
const b = await once("resume", "say only: ok again");
console.log("  total_cost_usd", b.cost, " num_turns", b.turns, " usage", b.usage, "\n");

if (a.cost === null || b.cost === null) {
  console.log("no cost on one of the results — nothing to conclude");
} else if (b.cost >= a.cost) {
  console.log(
    `CUMULATIVE across the resume: ${b.cost} >= ${a.cost}.\n` +
    "  A card restored from SQLite starts `#costAtLastTurn` at 0, so its first\n" +
    "  turn after a wake books the whole session's prior cost as this turn's\n" +
    "  spend. The day figure and the ledger over-report by the lifetime cost of\n" +
    "  every card woken that day.",
  );
} else {
  console.log(
    `PER PROCESS: ${b.cost} < ${a.cost}, so the counter restarted.\n` +
    "  A `Conversation` that survives a wake keeps a baseline the new process is\n" +
    "  already below, so `Math.max(0, …)` books that turn at nothing and every\n" +
    "  turn after it is measured from the wrong floor. The day figure\n" +
    "  under-reports, silently, and only for cards that were woken.",
  );
}
