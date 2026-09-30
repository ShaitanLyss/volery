/* What a token really costs, and whether `usage.ts`'s table still agrees.
 *
 *     bun tools/probe-prices.ts
 *
 * **Why this is a probe and not a fetch**, which is the question it exists to
 * answer once so nobody has to research it again. The table in `usage.ts` is
 * hard-coded, it went stale by a month once already (Sonnet 5 sat at $3/$15
 * waiting for an increase that was cancelled), and the obvious fix is to read
 * the numbers from somewhere живое instead. Four places were looked for, on
 * 2026-09-30 against claude 2.1.285, and this is what each answered:
 *
 * - **The transcripts.** No. Every field on an `assistant` record was
 *   enumerated across this machine's six most recent sessions: `message.usage`
 *   carries five kinds of token and no money at all, and no key anywhere on the
 *   record contains "cost" or "price". Pricing them is exactly why `usage.ts`
 *   needs a table.
 * - **A local file.** No. `~/.claude/policy-limits.json` holds restrictions,
 *   compliance taints and defaults — no rates.
 * - **An endpoint.** No. The CLI's URL strings include `/v1/models` and
 *   `/api/model_selector/`; neither returns pricing, and `/api/oauth/usage`
 *   (the one `limits.rs` already reads) answers in percentages of an allowance
 *   rather than in dollars.
 * - **The CLI's own table.** *Partly*, and the partly is the whole finding. The
 *   binary prices turns itself — `result.total_cost_usd` is where the day's
 *   figure comes from — and it encodes rates as tokens of the form
 *   `tier_<input>_<output>[_cache_read_<d>_<dd>]`. All seven are below, and
 *   every one matches the published docs exactly, cache-read overrides included.
 *
 *   **But the model→tier assignment is not recoverable.** The tokens sit in a
 *   minified bundle among the model ids without a readable structure binding
 *   one to the other, and the decisive evidence is an absence: there is no
 *   `tier_1_5` anywhere in the binary, so Haiku 4.5's $1/$5 — a rate the CLI
 *   demonstrably charges — is not expressible in this vocabulary at all. A
 *   source that cannot name one of the rates it uses is not a source.
 *
 * So the table stays hard-coded, and this turns "is it stale?" from an
 * afternoon's research into one command. What it checks is the half that *is*
 * sound: **every distinct (input, output) pair in `RATES` must appear as a tier
 * the CLI knows.** That catches an invented rate, a typo, and a tier the CLI
 * gained that nothing here has — without needing the assignment it cannot read.
 *
 * It cannot catch a rate assigned to the wrong model, and says so rather than
 * implying otherwise. For that, and for anything this reports as unknown, the
 * authority is https://platform.claude.com/docs/en/about-claude/pricing.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { RATES, type Rate } from "../src/lib/usage.ts";

/** The newest installed CLI, which is the one a card actually runs on. */
function newestCli(): string | null {
  const dir = join(homedir(), ".local", "share", "claude", "versions");
  let best: { path: string; at: number } | null = null;
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const at = statSync(path).mtimeMs;
      if (!best || at > best.at) best = { path, at };
    }
  } catch {
    return null;
  }
  return best?.path ?? null;
}

/** `tier_4_20_cache_read_0_20` → the rate it names.
 *
 *  The cache-read half is an *absolute* dollar figure in the token, where
 *  `Rate.cacheRead` is a multiple of input — so it is divided here rather than
 *  compared raw. $0.20 against a $4 input is the 0.05x the docs state. */
function readTier(tok: string): (Rate & { tok: string }) | null {
  const m = /^tier_(\d+)_(\d+)(?:_cache_read_(\d+)_(\d+))?$/.exec(tok);
  if (!m) return null;
  const input = Number(m[1]);
  const output = Number(m[2]);
  if (!input || !output) return null;
  const r: Rate & { tok: string } = { tok, input, output };
  if (m[3] !== undefined) r.cacheRead = Number(`${m[3]}.${m[4]}`) / input;
  return r;
}

const bin = newestCli();
if (!bin) {
  console.error(
    "no installed claude found under ~/.local/share/claude/versions — nothing to read\n" +
      "prices out of. The table in usage.ts cannot be checked from here; compare it by hand\n" +
      "against https://platform.claude.com/docs/en/about-claude/pricing",
  );
  process.exit(1);
}

/* Read as bytes and kept as bytes. The file is ~240MB of mostly binary, and
   decoding it as text is how one of these probes put NUL characters into a
   conversation and made it unsendable (`.claude/rules/repair.md` is the other
   end of that). Only the matched ASCII tokens ever become strings. */
const buf = readFileSync(bin);
const tiers = new Map<string, Rate & { tok: string }>();
for (const m of buf.toString("latin1").matchAll(/tier_\d+_\d+(?:_cache_read_\d+_\d+)?/g)) {
  const r = readTier(m[0]);
  if (r) tiers.set(r.tok, r);
}

console.log(`claude ${bin.split(/[\\/]/).pop()}  —  ${tiers.size} pricing tiers\n`);
for (const r of [...tiers.values()].sort((a, b) => a.input - b.input)) {
  const cr = r.cacheRead === undefined ? "" : `   cache read ${r.cacheRead}x`;
  console.log(`  $${r.input}/$${r.output} per MTok${cr}`.padEnd(46) + r.tok);
}

/** Every distinct pairing `RATES` claims, and who claims it. */
const claimed = new Map<string, string[]>();
for (const [id, r] of Object.entries(RATES)) {
  const key = `${r.input}_${r.output}_${r.cacheRead ?? ""}`;
  claimed.set(key, [...(claimed.get(key) ?? []), id]);
}

/** Rates the CLI has no tier token for, and the reason each is expected.
 *
 *  Without this the probe is red in its correct state, and a check that is
 *  always red is one nobody runs twice. Every entry is a claim that the absence
 *  has been looked into — so an absence *not* in here is the signal. */
const EXPECTED_ABSENT: Record<string, string> = {
  "1_5_": "haiku 4.5 — no `tier_1_5` exists in the binary at all; see the header",
  "0.8_4_": "haiku 3.5 — retired except on Bedrock and Google Cloud, so the CLI carries no tier",
};

const orphans: string[] = [];
const expected: string[] = [];
for (const [key, ids] of claimed) {
  const [input, output, cacheRead] = key.split("_");
  const hit = [...tiers.values()].find(
    (t) =>
      t.input === Number(input) &&
      t.output === Number(output) &&
      /* A tier with no cache-read token is the standard 0.1x, which is what an
         absent `cacheRead` means here — so the two absences match. */
      (t.cacheRead ?? "").toString() === cacheRead,
  );
  if (hit) continue;
  const row = `  $${input}/$${output}${cacheRead ? ` cache ${cacheRead}x` : ""}   ${ids.join(", ")}`;
  if (EXPECTED_ABSENT[key]) expected.push(`${row}\n      ${EXPECTED_ABSENT[key]}`);
  else orphans.push(row);
}

console.log(`\nusage.ts claims ${claimed.size} distinct rates across ${Object.keys(RATES).length} models.`);
if (orphans.length === 0) {
  console.log("every one of them is a tier this CLI knows, or a known absence.");
} else {
  console.log("\nNOT a tier this CLI knows, and not a known absence — check the docs:");
  for (const o of orphans) console.log(o);
}
if (expected.length > 0) {
  console.log("\nabsent on purpose:");
  for (const e of expected) console.log(e);
}

/* Said every time rather than only on a mismatch, because the thing most likely
   to go wrong here is somebody reading a green run as "the table is correct". */
console.log(
  "\nnote: this checks the rates, never which model carries which — a $5/$25 put on the\n" +
    "wrong model passes. Authority is the pricing docs.",
);

if (orphans.length > 0) process.exit(1);
