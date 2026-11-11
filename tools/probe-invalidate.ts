/* What does a write to CLAUDE.md actually cost the next turn?
 *
 * `docs/ANALYTICS.md` §3.9 attributes an excess cache write to an instruction
 * file being edited, and that attribution rests on a mechanism rather than a
 * measurement: the next request writes the prefix again because the file it
 * carries has changed. This probe measures it.
 *
 * One card, one tree, pinned to Haiku:
 *
 *   turn 1  a short prompt, and the cache write it pays      (the baseline)
 *   write   the probe writes a CLAUDE.md into the tree itself
 *   turn 2  the same prompt in the same process              (picked up?)
 *   respawn `--resume`, then the same prompt again           (picked up at start?)
 *
 * The three numbers answer two questions the attribution assumes. If turn 2
 * writes no more cache than turn 1, an edit is not picked up by a running
 * process at all and the cost lands on the next spawn instead, which is a
 * correction to §3.9 rather than a failed probe. The third arm is what says
 * which.
 *
 * It spends real API turns and is never run for you: nothing imports it, and
 * `bun run test` does not know it exists.
 *
 *   bun tools/probe-invalidate.ts            # all three arms
 *   bun tools/probe-invalidate.ts keep       # leave the tree for a look
 *
 * Measured 2026-11-12 on this machine, claude 2.1.319, `haiku`:
 *
 *   turn 1                        in 45,590  cache read      0  cache write 0
 *   write a 14 KB CLAUDE.md
 *   turn 2, same process          in    177  cache read 45,440  cache write 0
 *   turn 3, `--resume`            in  3,795  cache read 45,568  cache write 0
 *
 * **A running process does not re-read the file; a resumed one does, and the
 * re-read arrives as fresh input.** Turn 3 is 3,618 input tokens above the
 * turn-2 shape — about the size of the file — with no cache creation reported
 * on any request at all. So §3.9's excess is real, but it lands in `in_tok`
 * rather than in `write_5m` on this CLI, and it lands at the next *spawn*
 * rather than at the next turn. `invalidate_fact.in_tokens` exists for that
 * second bucket, and `.claude/rules`/`docs/ANALYTICS.md` §20 carry the finding.
 */

const CWD = process.cwd();
/* Bun.spawn does not always resolve a bare name from a Git Bash PATH. */
const CLAUDE = Bun.which("claude") ?? "claude";
const MODEL = "haiku";

/** Skein's shipped flags, minus what a probe has no wall for.
 *
 * **`--strict-mcp-config` with no `--mcp-config` is deliberate.** The prefix
 * being invalidated is the tree's, and a probe that paid for the user's MCP
 * schemas would measure them rather than the file. */
const BASE = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--strict-mcp-config",
  "--dangerously-skip-permissions",
  "--model", MODEL,
];

type Turn = { cacheWrite: number; cacheRead: number; input: number; output: number };

/** Read one process to the end of a turn and answer that turn's usage.
 *
 * **Every assistant message is folded once per `message.id`**, the rule
 * `usage.rs` states: one API response is several records, each repeating the
 * same `usage` verbatim, and summing them counts one turn two to five times. */
async function drive(
  argv: string[],
  prompts: string[],
): Promise<{ turns: Turn[]; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, {
    cwd: tree(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const turns: Turn[] = [];
  let seen = new Set<string>();
  let turn: Turn = { cacheWrite: 0, cacheRead: 0, input: 0, output: 0 };
  let sent = 0;
  let stdout = "";
  let stderr = "";

  const stderrDone = (async () => {
    for await (const chunk of proc.stderr as any) {
      stderr += new TextDecoder().decode(chunk);
    }
  })();

  const writePrompt = () => {
    const text = prompts[sent++];
    proc.stdin.write(
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n",
    );
    proc.stdin.flush();
  };

  const deadline = setTimeout(() => proc.kill(), 180_000);
  writePrompt();
  const reader = (proc.stdout as any).getReader();
  const dec = new TextDecoder();
  let buf = "";
  outer: for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = dec.decode(value, { stream: true });
    stdout += text;
    buf += text;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) {
      if (!l.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(l); } catch { continue; }
      if (ev.type === "assistant" && ev.message?.usage) {
        const id = ev.message.id ?? ev.uuid;
        if (seen.has(id)) continue;
        seen.add(id);
        const u = ev.message.usage;
        if (process.env.PROBE_VERBOSE) console.log("usage:", JSON.stringify(u));
        turn.input += u.input_tokens ?? 0;
        turn.output += u.output_tokens ?? 0;
        turn.cacheRead += u.cache_read_input_tokens ?? 0;
        turn.cacheWrite +=
          (u.cache_creation_input_tokens ?? 0) ||
          ((u.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
            (u.cache_creation?.ephemeral_1h_input_tokens ?? 0));
      }
      if (ev.type === "result") {
        turns.push(turn);
        turn = { cacheWrite: 0, cacheRead: 0, input: 0, output: 0 };
        seen = new Set();
        if (sent < prompts.length) {
          writePrompt();
          continue;
        }
        break outer;
      }
    }
  }
  clearTimeout(deadline);
  try { proc.kill(); } catch {}
  await stderrDone;
  return { turns, stdout, stderr };
}

/** A directory of its own under this card's scratch area. **The real tree is
 *  never edited**: a probe that wrote a `CLAUDE.md` into the repository it is
 *  run from would change every card's reading for the rest of the afternoon. */
function tree(): string {
  const base = process.env.SKEIN_CARD
    ? `.scratch-${process.env.SKEIN_CARD}/probe-invalidate`
    : ".scratch/probe-invalidate";
  const dir = `${CWD}/${base}`;
  Bun.spawnSync(["mkdir", "-p", dir]);
  return dir;
}

function line(name: string, t: Turn | undefined): string {
  if (!t) return `${name.padEnd(12)}  no turn`;
  return (
    `${name.padEnd(12)}` +
    ` cache write ${String(t.cacheWrite).padStart(7)}` +
    ` | cache read ${String(t.cacheRead).padStart(7)}` +
    ` | in ${String(t.input).padStart(5)}` +
    ` | out ${String(t.output).padStart(5)}`
  );
}

const keep = Bun.argv.includes("keep");
const treeDir = tree();
const session = crypto.randomUUID();
const ask = "Reply with exactly: ok";

console.log(`tree:    ${treeDir}`);
console.log(`session: ${session}`);
console.log(`model:   ${MODEL}\n`);

/* Turn 1 and 2 in one process: does a running card notice the file? */
const first = await drive(
  [CLAUDE, ...BASE, "--session-id", session],
  [ask, ask],
).catch((e) => {
  console.log("first process FAILED:", String(e).slice(0, 300));
  return null;
});

if (!first) process.exit(1);
console.log(line("turn 1", first.turns[0]));

/* **Big enough that its absence or presence cannot be mistaken for noise.**
   A one-line file changes a prefix by a handful of tokens, which is inside the
   history a second turn adds anyway; 4,000 tokens is unmistakable in the cache
   read. The marker is random so no two runs share a prefix. */
const marker = crypto.randomUUID();
const body = `# probe ${marker}\n` + Array.from({ length: 200 }, (_, i) => `line ${i}: the prefix this file carries is what an invalidation retires.`).join("\n") + "\n";
await Bun.write(`${treeDir}/CLAUDE.md`, body);
console.log(`wrote    CLAUDE.md into the tree (${body.length} bytes)`);

console.log(line("turn 2", first.turns[1]));

/* The third arm: the same session, a new process, which is what a card gets
   when it is woken. This is where a changed prefix should be read. */
const second = await drive(
  [CLAUDE, ...BASE, "--resume", session],
  [ask],
).catch((e) => {
  console.log("resume FAILED:", String(e).slice(0, 300));
  return null;
});
if (second) console.log(line("turn 3", second.turns[0]));

/* The comparison is **turn 2 against turn 3**, not either against turn 1: a
   session's first request pays for a system prompt nobody has cached yet, so
   turn 1 is the wrong baseline for what a write costs. */
console.log("\nwhat this says:");
const base = first.turns[1];
if (base && second?.turns[0]) {
  const after = second.turns[0];
  const input = after.input - base.input;
  const write = after.cacheWrite - base.cacheWrite;
  console.log(
    `  a resumed process after the write: ${input >= 0 ? "+" : ""}${input} input tokens, ` +
      `${write >= 0 ? "+" : ""}${write} cache-write tokens`,
  );
  console.log(
    input > 0 || write > 0
      ? "  → the file was re-read, and the buckets above say where it was billed"
      : "  → no re-read was seen; the file may not have been loaded at all",
  );
}
console.log(
  "\n  §3.9 attributes the excess to the paying card's request after the last write.\n" +
    "  Read the deltas above against that, and against which bucket they land in:\n" +
    "  `invalidate_fact` carries both, and the page prices each at its own rate.",
);

if (!keep) Bun.spawnSync(["rm", "-rf", treeDir]);
