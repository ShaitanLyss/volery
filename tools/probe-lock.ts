/**
 * Does `permissions.deny` in the `--settings` layer refuse a tool call on a card
 * that carries `--dangerously-skip-permissions`?
 *
 * The whole per-project read-only lock stands on this one answer, and getting it
 * wrong fails in the worst available shape: the switch is on, the settings JSON
 * is exactly as written, no error appears anywhere, and the card edits the
 * repository. A lock that silently does not lock is worse than no lock, because
 * somebody relied on it.
 *
 * **The bundle says yes and this checks it anyway.** Read out of 2.1.233 on this
 * machine, 2026-09-05, in the `canUseTool` warning:
 *
 *   canUseTool will not be invoked: permissionMode 'bypassPermissions'
 *   auto-approves every tool call (except explicit deny rules) before the
 *   callback is consulted. To gate every tool call, use a PreToolUse hook
 *   instead.
 *
 * That parenthesis is the claim. It is a sentence about the *SDK callback* path
 * though, and the deny rules it mentions are the ones that come off a settings
 * layer — so it is evidence rather than the measurement, and this is the module
 * whose last matcher bug (`hooks.rs`, `matcher: "Bash"`) went unnoticed for an
 * unknown number of versions precisely because a no-op looks like nothing.
 *
 * Run:  bun tools/probe-lock.ts
 *
 * Spawns two real turns against the real binary with Skein's argv shape, one
 * variable between them — the `deny` array. A few cents. Writes into
 * `.scratch-probe-lock/` and deletes only that.
 *
 * ── what it returned, against 2.1.233 on 2026-09-05 ───────────────────────
 *
 * (see the block at the foot of this file)
 */

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/* Its own directory, per CLAUDE.md: `.scratch/` is swept by whoever gets there
   first and this has a file it needs to still exist at the end. */
const DIR = join(process.cwd(), ".scratch-probe-lock");
const TARGET = join(DIR, "written-by-the-card.txt");

const CLAUDE = join(process.env.USERPROFILE ?? "", ".local", "bin", "claude.exe");

/** Skein's own argv shape for a project card, minus the parts that need a wall.
 *  `shell: false`, because with `shell: true` the settings JSON goes through
 *  cmd.exe quoting and comes back as "Invalid JSON provided to --settings" —
 *  the same hour `probe-deny.ts` records losing. */
function argv(deny: string[] | null): string[] {
  const settings: Record<string, unknown> = {};
  if (deny) settings.permissions = { deny };
  return [
    "--print",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--settings", JSON.stringify(settings),
  ];
}

type Turn = { wrote: boolean; used: string[]; refused: boolean; said: string };

function turn(label: string, deny: string[] | null, prompt: string): Promise<Turn> {
  rmSync(TARGET, { force: true });
  return new Promise((resolve) => {
    const c = spawn(CLAUDE, argv(deny), { shell: false, cwd: DIR });

    const used: string[] = [];
    let refused = false;
    let said = "";
    let buf = "";

    c.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        for (const b of ev?.message?.content ?? []) {
          if (b.type === "tool_use") used.push(b.name);
          if (b.type === "text") said += b.text;
          if (b.type === "tool_result") {
            const t =
              typeof b.content === "string"
                ? b.content
                : (b.content ?? []).map((x: any) => x.text ?? "").join("");
            /* Whatever the wording, a refusal says so and an error does not.
               Printed in full below rather than matched on exactly, since the
               phrasing is the CLI's and may move. */
            if (/permission|denied|not allowed|blocked/i.test(t)) refused = true;
            said += `\n[result] ${t}`;
          }
        }
        if (ev?.type === "result") {
          c.kill();
          resolve({ wrote: existsSync(TARGET), used, refused, said });
        }
      }
    });
    c.stderr.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
    c.on("exit", () => resolve({ wrote: existsSync(TARGET), used, refused, said }));

    c.stdin.write(
      JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n",
    );
  });
}

const ASK =
  `Use the Write tool to create the file written-by-the-card.txt in this directory, ` +
  `containing exactly the word OK. Do not use a shell command for this — the Write tool ` +
  `specifically. If you cannot, say why in one line and stop.`;

function show(label: string, t: Turn) {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 60 - label.length))}`);
  console.log(`   file written : ${t.wrote}`);
  console.log(`   tools used   : ${t.used.join(", ") || "(none)"}`);
  console.log(`   read as refused: ${t.refused}`);
  console.log(`   said         : ${t.said.trim().slice(0, 600).replace(/\n/g, "\n                  ")}`);
}

mkdirSync(DIR, { recursive: true });
try {
  /* The control first, and it is not a formality: if the card cannot write the
     file even with nothing denied, the deny arm proves nothing at all. */
  const control = await turn("control", null, ASK);
  show("control — bypass, no deny", control);

  const locked = await turn("locked", ["Edit", "Write", "NotebookEdit"], ASK);
  show(`locked — bypass + deny ["Edit","Write","NotebookEdit"]`, locked);

  console.log(`\n${"═".repeat(64)}`);
  if (!control.wrote) {
    console.log("INCONCLUSIVE — the control did not write the file, so the deny arm");
    console.log("says nothing. Read what it said above before believing anything else.");
    process.exit(2);
  }
  if (locked.wrote) {
    console.log("NO — `permissions.deny` does NOT bite under --dangerously-skip-permissions.");
    console.log("The lock cannot be built this way; it has to be a PreToolUse hook, which");
    console.log("`probe-deny.ts` has already measured as refusing under the bypass flag.");
    process.exit(1);
  }
  console.log("YES — `permissions.deny` holds on a card carrying");
  console.log("--dangerously-skip-permissions. The settings layer is the mechanism.");
  /* Which of the two ways it holds, because they are different features and the
     difference is what a card is told. Attempted-and-refused costs a call and
     teaches the model mid-turn; never-offered costs nothing and shapes the plan
     before it is made. */
  console.log(
    locked.used.includes("Write")
      ? "   ...by REFUSING the call: the tool was offered, reached for, and denied."
      : "   ...by WITHHOLDING the tool: it is not in the card's tool list at all.",
  );
} finally {
  /* The children were spawned with `cwd: DIR`, and on Windows a live process's
     working directory is a lock on it — an immediate rm answers EBUSY however
     dead the process looks. One retry after a breath is enough, and a leftover
     directory is a mess rather than a failure, so it never throws. */
  for (const wait of [0, 250, 1000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      rmSync(DIR, { recursive: true, force: true });
      break;
    } catch {
      /* still held; try again, then leave it */
    }
  }
}

/* ── measured 2026-09-05, claude 2.1.233 ──────────────────────────────────────
 *
 * control — bypass, no deny
 *    file written : true
 *    tools used   : Write
 *
 * locked — bypass + deny ["Edit","Write","NotebookEdit"]
 *    file written : false
 *    tools used   : ToolSearch, ToolSearch
 *    said         : "I'll write that file."
 *                   [result] No matching deferred tools found. …
 *                   "The Write tool isn't available in this session — it's not
 *                    in my tool list and ToolSearch turned up no deferred
 *                    `Write` — so I can't create the file"
 *
 * **YES, and by a better mechanism than the one that was expected.** A denied
 * tool is not offered and then refused; it is **not in the card's tool list at
 * all**. That was the answer worth spending a turn on, and it is not what the
 * bundle's `canUseTool` warning implies ("auto-approves every tool call except
 * explicit deny rules" reads as a refusal at call time).
 *
 * Three consequences, and the first two are why this is the better half of the
 * bargain:
 *
 *   - **It costs nothing per turn and nothing per attempt.** There is no denied
 *     call to pay for and no refusal to recover from mid-plan.
 *   - **The card plans around it** rather than discovering it. It said so in its
 *     own words, correctly, and stopped — which is what a read-only card should
 *     do rather than trying three more spellings.
 *   - **But nothing tells it *why*.** "Not in my tool list" is indistinguishable
 *     from a CLI that never had the tool, so the card cannot say "this project
 *     is locked" to the user, and it went looking through `ToolSearch` first —
 *     two wasted calls. That is what `guidance.rs`'s sentence is for: the lock
 *     says so in the system prompt as well as in the settings layer, and the
 *     prompt is the only half that can explain itself.
 *
 * `hooks::settings` builds the layer this proves.
 */
