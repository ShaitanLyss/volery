/* Whether a `claude` session can be picked up on a machine where the repo
 * lives somewhere else — which is the whole of whether a card can be *moved*.
 *
 * Distributed Volery wants an orchestrator that can say "this work belongs on
 * the big box" and have it happen. Three things have to travel for that: the
 * code (git's job), the wall's own rows (ours, over the wire), and the
 * conversation. The conversation is the CLI's transcript, and the CLI files it
 * under a directory folded from the *cwd* —
 * `~/.claude/projects/C--atelier-skein/<session>.jsonl`. On the other machine
 * that same repo is at another path, so it folds to another directory, and
 * every record inside the file still says it was written somewhere that does
 * not exist there.
 *
 * Nothing about that is answerable by reading. `supervisor::transcript_dir_name`
 * records that the CLI decides whether it already owns a session by `statSync`
 * of exactly that folded path (`Own()` in the bundled JS), so putting the file
 * where the other machine would look for it is *plausibly* the whole job — and
 * plausibly is not a thing to build a feature on.
 *
 * So: two directories on this one machine stand in for two machines. They fold
 * to different slugs, which is the only property of "another computer" that
 * matters here. Plant a session in A, then try to resume it from B four ways.
 *
 *   bun tools/probe-migrate.ts
 *
 * **Costs four real turns, pinned to Haiku.** Minutes and pennies, and worth
 * re-running against a CLI upgrade, because `move` rests entirely on the answer.
 *
 * What a green run does NOT establish: this plants a short session with one
 * tool call in it. A card with four hundred turns and a compaction boundary is
 * a bigger transplant, and the first thing to try if a real move misbehaves
 * where this said it would not.
 */

import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLAUDE = Bun.which("claude") ?? "claude";
const HAIKU = "claude-haiku-4-5-20251001";
const CARD = process.env.SKEIN_CARD ?? "probe";

/** Skein's own flags, less the ones that only matter to a long-lived card. */
const BASE = [
  "--print",
  "--output-format", "stream-json",
  "--verbose",
  "--model", HAIKU,
  "--dangerously-skip-permissions",
];

/* ── the fold, which must agree with `supervisor::fold_dir_name` ──────────────
   ASCII alphanumerics survive; everything else becomes one dash *per UTF-16
   code unit*, so an astral character yields two. Reimplemented rather than
   shelled out to because a probe that trusts the code under test proves
   nothing — and because the Rust side has a test of its own against the CLI's
   real output (`transcript_dir_matches_claude_codes_own_naming`). If these two
   ever disagree, that test is the one that is right. */
function fold(cwd: string): string {
  let out = "";
  for (const ch of cwd) {
    if (/^[A-Za-z0-9]$/.test(ch)) out += ch;
    else out += "-".repeat(ch.length);
  }
  return out;
}

/** A path as the filesystem spells it — junctions followed, verbatim prefix off.
 *  `real_dir` + `plain` in `supervisor.rs`, and for the same reason: a child
 *  spawned at a junction reports the target and files its transcript there. */
function real(p: string): string {
  let r: string;
  try { r = realpathSync.native(p); } catch { return p; }
  if (r.startsWith("\\\\?\\UNC\\")) return "\\\\" + r.slice(8);
  if (r.startsWith("\\\\?\\")) return r.slice(4);
  return r;
}

const PROJECTS = join(homedir(), ".claude", "projects");
const slugOf = (realPath: string) => join(PROJECTS, fold(realPath));

/* ── two "machines" ───────────────────────────────────────────────────────────
   Different depths as well as different names, so the slugs differ in length
   and not only in one character — a bug that happened to preserve length would
   otherwise pass. */
const ROOT = join(process.cwd(), `.scratch-${CARD}`, "migrate");
const HOST_A = join(ROOT, "alpha", "repo");
const HOST_B = join(ROOT, "beta", "elsewhere", "repo");

type Turn = { code: number; text: string; sessionId: string | null; isError: boolean; stderr: string };

async function turn(cwd: string, args: string[], prompt: string): Promise<Turn> {
  const proc = Bun.spawn([CLAUDE, ...BASE, ...args, prompt], {
    cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [out, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;

  let text = "", sessionId: string | null = null, isError = false;
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === "system" && ev.subtype === "init") sessionId = ev.session_id ?? null;
    if (ev.type === "result") {
      text = typeof ev.result === "string" ? ev.result : "";
      isError = ev.is_error === true || ev.subtype !== "success";
    }
  }
  return { code, text, sessionId, isError, stderr };
}

/* ── setup ────────────────────────────────────────────────────────────────────
   Swept at the start rather than the end, so a failed run leaves its evidence
   on disk to read. Only ever this probe's own directories: the two scratch
   trees, and the two slug directories *derived from them*, which no other card
   and no real card can be filed under.

   Order is load-bearing. `realpathSync` on a path that is not there answers
   with the path it was handed, and that can fold to a different directory from
   the one the CLI will use once the directory exists — this repo has already
   lost every conversation in two territories to exactly that gap between the
   path we spawn with and the path the child reports (`supervisor::real_dir`).
   So: make the directories, *then* ask what they are really called. */
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(HOST_A, { recursive: true });
mkdirSync(HOST_B, { recursive: true });

const A_REAL = real(HOST_A);
const B_REAL = real(HOST_B);
const A_SLUG = slugOf(A_REAL);
const B_SLUG = slugOf(B_REAL);
for (const d of [A_SLUG, B_SLUG]) rmSync(d, { recursive: true, force: true });

if (A_SLUG === B_SLUG) {
  console.error("both hosts fold to the same directory — the probe would prove nothing.");
  process.exit(1);
}

/* A fresh word every run. A fixed one would let a transcript left behind by the
   *previous* run answer this run's question, which is the way a probe passes
   while measuring nothing. */
const WORD = `ALBATROSS-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

const results: Array<[string, boolean, string]> = [];
const record = (arm: string, ok: boolean, note: string) => {
  results.push([arm, ok, note]);
  console.log(`  ${arm.padEnd(22)} ${ok ? "yes" : "NO "}   ${note}`);
};

console.log(`host A  ${A_REAL}`);
console.log(`        → ${A_SLUG}`);
console.log(`host B  ${B_REAL}`);
console.log(`        → ${B_SLUG}`);
console.log(`codeword ${WORD}\n`);

/* ── arm 1: plant ─────────────────────────────────────────────────────────────
   One tool call in it on purpose. A text-only transcript is the easy case; a
   real card's history is tool calls, and those records carry paths of their own
   — which is the half a migration might have to rewrite. */
const planted = crypto.randomUUID();
console.log("planting a session on host A …");
const plant = await turn(HOST_A, ["--session-id", planted],
  `Run the shell command: echo ${WORD} > marker.txt\n` +
  `Then reply with exactly: planted`);

if (plant.isError || plant.code !== 0) {
  console.error(`\nthe plant turn failed (exit ${plant.code}) — nothing below would mean anything.`);
  console.error(plant.stderr.slice(0, 2000));
  process.exit(1);
}
const file = join(A_SLUG, `${planted}.jsonl`);
if (!existsSync(file)) {
  console.error(`\nno transcript at ${file}`);
  console.error("the fold above disagrees with the CLI's own naming — fix `fold` before reading further.");
  process.exit(1);
}
const original = readFileSync(file, "utf8");
console.log(`  transcript ${original.split("\n").filter(Boolean).length} records, ${original.length} bytes\n`);

/* ── what in here is path-shaped ──────────────────────────────────────────────
   Reconnaissance rather than a pass/fail: whatever a real move has to rewrite
   is in this census, and knowing the field names now is most of designing it. */
const needle = A_REAL;
const bearing = new Map<string, number>();
for (const line of original.split("\n")) {
  if (!line.trim()) continue;
  let rec: any;
  try { rec = JSON.parse(line); } catch { continue; }
  const walk = (node: any, path: string) => {
    if (typeof node === "string") {
      if (node.includes(needle) || node.includes(needle.replace(/\\/g, "\\\\"))) {
        bearing.set(path, (bearing.get(path) ?? 0) + 1);
      }
    } else if (Array.isArray(node)) {
      node.forEach((v) => walk(v, `${path}[]`));
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(rec, "");
}

console.log("fields carrying host A's path:");
if (bearing.size === 0) console.log("  (none — the transcript is path-free, which would make a move trivial)");
for (const [k, n] of [...bearing].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}×  ${k}`);
console.log();

/* ── the arms ─────────────────────────────────────────────────────────────── */
console.log("can the session be resumed …");

/* Control. If resuming where it was planted does not work, the probe is broken
   and every "NO" below is about the probe rather than about migration. */
const same = await turn(HOST_A, ["--resume", planted], "What was the codeword? Answer with the word alone.");
record("in place (control)", same.text.includes(WORD), same.isError ? `error: ${same.text.slice(0, 80)}` : same.text.trim().slice(0, 40));

/* Control in the other direction. Resuming on B with *no file there* must fail.
   If it succeeds, the CLI is finding sessions by something other than the
   folded path — which would be a far more interesting answer than a green run,
   and would mean the whole transplant is unnecessary. */
const absent = await turn(HOST_B, ["--resume", planted], "What was the codeword? Answer with the word alone.");
record("host B, no file", absent.text.includes(WORD), absent.isError ? `refused: ${(absent.text || absent.stderr).trim().slice(0, 70)}` : absent.text.trim().slice(0, 40));

/* ── and now the arms that are actually about another machine ─────────────────
   Host A's directory has to be GONE for any of this to mean anything. On the
   other machine it would never have existed; with it still here, every arm
   below can pass by the CLI simply reading the original — which is exactly what
   the control above caught it doing, and why the first cut of this probe would
   have reported a green run while measuring nothing.

   Kept in memory and written beside the scratch tree first, so a failed run
   still leaves the evidence somewhere to read. */
writeFileSync(join(ROOT, `${planted}.jsonl`), original);
rmSync(A_SLUG, { recursive: true, force: true });

/* The original gone and nothing put in its place: this must fail. If it does
   not, the session is being served from somewhere neither directory explains —
   a cache, an index — and no design that ships files is sound until that is
   found, because whatever it is will not exist on the other machine. */
const orphaned = await turn(HOST_B, ["--resume", planted], "What was the codeword? Answer with the word alone.");
record("A gone, no copy", orphaned.text.includes(WORD), orphaned.isError ? `refused: ${(orphaned.text || orphaned.stderr).trim().slice(0, 70)}` : orphaned.text.trim().slice(0, 40));

/* The transplant, verbatim. Every record still claims host A's cwd. */
mkdirSync(B_SLUG, { recursive: true });
writeFileSync(join(B_SLUG, `${planted}.jsonl`), original);
const verbatim = await turn(HOST_B, ["--resume", planted], "What was the codeword? Answer with the word alone.");
record("A gone, copied as-is", verbatim.text.includes(WORD), verbatim.isError ? `error: ${(verbatim.text || verbatim.stderr).trim().slice(0, 70)}` : verbatim.text.trim().slice(0, 40));

/* The transplant, with every occurrence of A's path rewritten to B's — both
   spellings, since JSON-encoded Windows paths appear doubled inside strings. */
const rewritten = original
  .split(needle.replace(/\\/g, "\\\\")).join(B_REAL.replace(/\\/g, "\\\\"))
  .split(needle).join(B_REAL);
writeFileSync(join(B_SLUG, `${planted}.jsonl`), rewritten);
const patched = await turn(HOST_B, ["--resume", planted], "What was the codeword? Answer with the word alone.");
record("A gone, paths rewritten", patched.text.includes(WORD), patched.isError ? `error: ${(patched.text || patched.stderr).trim().slice(0, 70)}` : patched.text.trim().slice(0, 40));

/* ── the reading ──────────────────────────────────────────────────────────── */
const by = Object.fromEntries(results.map(([k, v]) => [k, v]));
console.log("\n=== what this run established ===");

if (!by["in place (control)"]) {
  console.log("The control failed: a session could not be resumed where it was planted.");
  console.log("Nothing else here is evidence about anything. Check the CLI version first.");
} else if (by["A gone, no copy"]) {
  console.log("With the transcript DELETED and no copy anywhere, host B still answered.");
  console.log("The session is being served from something neither directory explains.");
  console.log("Find it before designing a move around shipping files — whatever it is,");
  console.log("it will not exist on the other machine, and every arm below is passing");
  console.log("for that reason rather than for the one being tested.");
} else {
  if (by["host B, no file"]) {
    console.log("While host A's copy was still there, host B resumed from it — so the");
    console.log("CLI looks past the cwd-folded directory to find a session by id. Good");
    console.log("news for a move: the slug need not be matched exactly. It is also why");
    console.log("the arms below delete the original first.\n");
  }
  if (by["A gone, copied as-is"]) {
    console.log("A session transplants VERBATIM. Putting the file in the other machine's");
    console.log("projects directory is the whole of moving a conversation — no record");
    console.log("rewriting, and the census above is only reconnaissance.");
    console.log("`move` is: quiesce on A, ship the file and the rows, resume on B,");
    console.log("confirm the model still has its history, then release A. Code by git.");
  } else if (by["A gone, paths rewritten"]) {
    console.log("A session transplants ONLY with its records rewritten. The fields in the");
    console.log("census above are load-bearing, and `move` owes a rewriter tested against");
    console.log("them — a field added by a later CLI that nobody rewrites is a card that");
    console.log("moves and quietly forgets what it was doing.");
  } else {
    console.log("A session does NOT transplant, either way. `move` cannot be a transfer");
    console.log("of the conversation, and becomes a handoff instead: summarise the plan");
    console.log("on A (`handoff.ts` already does this), spawn fresh on B, close A.");
    console.log("Cheaper to build, and it loses the history — worth knowing now.");
    console.log(`\nhost B's refusal: ${(verbatim.text || verbatim.stderr).trim().slice(0, 300)}`);
  }
}

console.log(`\nevidence left at ${ROOT} and the two slug directories above.`);
