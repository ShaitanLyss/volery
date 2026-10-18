/* Whether this machine's own Claude Code is signed in, asked without a turn.
 *
 * Chat view's empty state has to say "sign in to Claude" *before* the first
 * message, because every conversation is a `claude` process and a signed-out
 * one answers its first prompt with an error you have already waited for
 * (`docs/chat-mode.md` §5.9 step 2, §11.4). `accounts.rs::signed_in` answers
 * only for the accounts Volery manages — it looks for a `.credentials.json` in
 * a store under `~/.claude/accounts/<label>` — and nothing asked about the
 * default credential, the one an unmanaged card spawns as.
 *
 * The question is what to ask. Three candidates, and the arms below are the
 * whole of why the answer is the first:
 *
 *   - `claude auth status --json`, which prints a record and exits. Asked
 *     three ways: as Volery spawns an unmanaged card (the secure-storage
 *     override removed), against an empty secure-storage directory (a managed
 *     account that never signed in), and against an empty `CLAUDE_CONFIG_DIR`
 *     (a machine whose Claude Code has never been signed in at all — the
 *     newcomer's case, which cannot be produced on this machine any other way
 *     without signing Lyss out).
 *   - Reading `~/.claude/.credentials.json` ourselves. Rejected without a run:
 *     the CLI decides where its credential lives (the file, an override, an
 *     environment token) and a reader of one file is a second opinion that is
 *     wrong exactly when it matters.
 *   - The stream-json `initialize` control request, which carries an `account`
 *     field. Rejected: it needs the whole stream process up, which is a card's
 *     spawn to answer a yes/no.
 *
 *   bun tools/probe-auth.ts
 *
 * **Costs no API turn and no network sign-in.** Prints the shape of each answer
 * with the email and organisation redacted, the exit code, and the time — the
 * time because the empty state asks this when it is drawn, and a check that
 * took seconds would want caching.
 *
 * **What it returned**, 2026-10-18 against claude 2.1.288, from a card on a
 * managed account:
 *
 *   - the control: exit 0, `{ loggedIn: true, authMethod: "claude.ai", email,
 *     orgId, orgName, subscriptionType: "team", … }` in ~950ms;
 *   - as an unmanaged card spawns: exit **1**, `{ loggedIn: false, authMethod:
 *     "none", apiProvider, configDirectory, … }` — this machine's own default
 *     credential is signed out, because every sign-in on it is a managed
 *     account. That is the case the readiness rule has to get right: signed out
 *     by default and perfectly ready, since a card spawns on an account;
 *   - an empty secure-storage directory and an empty `CLAUDE_CONFIG_DIR`: the
 *     same signed-out record, exit 1, ~900ms.
 *
 * So: the record is the answer and **the exit code is not a failure** — signed
 * out exits 1 with a perfectly good record on stdout, and a caller that read a
 * non-zero exit as "could not ask" would report a newcomer's machine as broken
 * rather than signed out. And at ~1s a spawn, it is asked when the empty state
 * is drawn and on *look again*, never on a timer (`claude.rs::auth_status`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLAUDE = Bun.which("claude") ?? "claude";
const empty = () => mkdtempSync(join(tmpdir(), "probe-auth-"));

type Arm = { name: string; env: Record<string, string | undefined> };

const store = empty();
const config = empty();
const ARMS: Arm[] = [
  /* The control: whatever this shell already has. A card Volery spawned on a
     managed account carries that account's store here, so this is the signed-in
     shape — without it, a machine whose default credential is signed out reads
     exactly like a probe that cannot tell. */
  { name: "this shell, untouched (the control)", env: {} },
  { name: "as an unmanaged card spawns", env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined } },
  { name: "an empty secure-storage directory", env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: store } },
  {
    name: "an empty CLAUDE_CONFIG_DIR (never signed in)",
    env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_OAUTH_TOKEN: undefined },
  },
];

const REDACT = new Set(["email", "orgId", "orgName", "organizationName", "accountUuid"]);

for (const arm of ARMS) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(arm.env)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const t0 = performance.now();
  const p = Bun.spawnSync([CLAUDE, "auth", "status", "--json"], { env, stdout: "pipe", stderr: "pipe" });
  const ms = Math.round(performance.now() - t0);
  const out = p.stdout.toString().trim();
  let shape: unknown = out;
  try {
    const v = JSON.parse(out) as Record<string, unknown>;
    for (const k of Object.keys(v)) if (REDACT.has(k) && v[k]) v[k] = "<redacted>";
    shape = v;
  } catch {
    /* not JSON — printed as text */
  }
  console.log(`\n── ${arm.name}`);
  console.log(`exit ${p.exitCode} · ${ms}ms`);
  console.log(JSON.stringify(shape, null, 2));
  const err = p.stderr.toString().trim();
  if (err) console.log(`stderr: ${err.slice(0, 400)}`);
}

rmSync(store, { recursive: true, force: true });
rmSync(config, { recursive: true, force: true });
