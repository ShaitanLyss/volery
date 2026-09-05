/** Does the OAuth deployment rotate a refresh token when it is spent?
 *
 *  `.claude/rules/accounts.md` answers that from Claude Code's own bundle — the
 *  client is built on the premise that a refresh token stops working because it
 *  was used, and the argument is written out there. This is the empirical half,
 *  and the only reason it is worth having separately is that the source argument
 *  is about the *client* and this watches the *server*.
 *
 *  **It causes nothing.** The obvious experiment — hash a token, spend a turn on
 *  that account, hash again — costs somebody's money and invalidates the very
 *  credential it is asking about, which is why the question sat open for weeks.
 *  This one only reads what is already on disk. The accounts on a working
 *  machine refresh themselves roughly every eight hours, so:
 *
 *      bun tools/probe-rotation.ts            # take a reading
 *      …later…
 *      bun tools/probe-rotation.ts            # and it compares against the last
 *
 *  A `refreshToken` digest that changed while the store was rewritten is
 *  rotation, observed. One that held still across a rewrite that moved
 *  `accessToken` is a refresh that did not rotate.
 *
 *  **Nothing here prints, writes or returns a token, a fragment of one, or a
 *  length that would narrow one.** SHA-256 digests only — which is the whole
 *  point, and the rule the rest of this subsystem keeps (`limits.rs`'s `source`,
 *  `accounts.rs`'s `Summary`).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const ROOT = join(HOME, ".claude", "accounts");

/** Its own named subdirectory, deleted by nobody else — the convention every
 *  probe in here follows, and the one `.scratch/` being shared is why. */
const OUT = join(import.meta.dir, "..", ".scratch", "rotation");
const FILE = join(OUT, "fingerprints.json");

type Row = {
  state: string;
  mtime?: number;
  expiresAt?: number | null;
  refreshTokenExpiresAt?: number | null;
  plan?: string | null;
  accessToken?: string;
  refreshToken?: string;
};

const digest = (v: unknown) =>
  typeof v === "string" && v ? createHash("sha256").update(v).digest("hex") : undefined;

function read(path: string): Row {
  if (!existsSync(path)) return { state: "no credential" };
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { state: "unreadable" };
  }
  const o = ((doc.claudeAiOauth as Record<string, unknown>) ?? doc) as Record<string, unknown>;
  return {
    state: "read",
    mtime: Math.floor(statSync(path).mtimeMs),
    expiresAt: (o.expiresAt as number) ?? null,
    /* Recorded but never trusted on its own. It falls back to the previous
       value when the token response carries no `refresh_token_expires_in`, so a
       stamp that did not move says nothing about whether the value did — see
       `lrd` in accounts.md. */
    refreshTokenExpiresAt: (o.refreshTokenExpiresAt as number) ?? null,
    plan: (o.subscriptionType as string) ?? null,
    accessToken: digest(o.accessToken),
    refreshToken: digest(o.refreshToken),
  };
}

const stores: [string, string][] = [["<global>", join(HOME, ".claude", ".credentials.json")]];
if (existsSync(ROOT)) {
  for (const name of readdirSync(ROOT).sort()) {
    stores.push([name, join(ROOT, name, ".credentials.json")]);
  }
}

const now: Record<string, Row> = {};
for (const [label, path] of stores) now[label] = read(path);

const before: { takenAt?: number; accounts?: Record<string, Row> } = existsSync(FILE)
  ? JSON.parse(readFileSync(FILE, "utf8"))
  : {};

if (before.accounts) {
  const ago = Math.round((Date.now() - (before.takenAt ?? 0)) / 60000);
  console.log(`against a reading ${ago} minutes old\n`);
  let rewrites = 0;
  let rotations = 0;
  for (const [label, row] of Object.entries(now)) {
    const was = before.accounts[label];
    if (!was || was.state !== "read" || row.state !== "read") {
      console.log(`  ${label.padEnd(10)} — nothing to compare`);
      continue;
    }
    const rewritten = was.accessToken !== row.accessToken;
    const rotated = was.refreshToken !== row.refreshToken;
    if (rewritten) rewrites++;
    if (rotated) rotations++;
    const said = !rewritten
      ? "unchanged — no refresh happened yet"
      : rotated
        ? "REFRESHED, and the refresh token changed with it → rotation"
        : "refreshed, and the refresh token held still → no rotation on this call";
    console.log(`  ${label.padEnd(10)} — ${said}`);
  }
  console.log(
    `\n${rewrites} store(s) refreshed since the last reading, ${rotations} rotated.` +
      (rewrites === 0 ? " Come back in a few hours." : ""),
  );
} else {
  console.log("first reading — nothing to compare against yet. Run it again later.");
}

mkdirSync(OUT, { recursive: true });
writeFileSync(FILE, JSON.stringify({ takenAt: Date.now(), accounts: now }, null, 2) + "\n");
console.log(`\nwritten to ${FILE}`);
