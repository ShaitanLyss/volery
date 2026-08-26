/* skeinctl — talk to a running Skein.
 *
 *   bun tools/ctl.ts health
 *   bun tools/ctl.ts snapshot
 *   bun tools/ctl.ts snapshot cards            # one dotted path out of it
 *   bun tools/ctl.ts focus card=caravan
 *   bun tools/ctl.ts send card=caravan text="say hello"
 *   bun tools/ctl.ts feed card=1 event:@fixtures/turn.json
 *   bun tools/ctl.ts real.click selector=".shut"
 *
 * Arguments are `key=value`. A value parses as JSON when it can, so
 * `options=["a","b"]` and `x=120` arrive as an array and a number rather than
 * as strings. `key:@file` reads JSON from a file, for anything too long to
 * type. The port and token come from control.json, which the app writes at
 * startup, so nothing has to be copied by hand.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Which wall to talk to, as the identifier naming its `%APPDATA%` folder.
 *
 *  `control.json` is written beside the database, so the folder that decides
 *  which store an instance opens also decides which control surface this
 *  reaches — one variable, not two. Defaults to the real studio, so every
 *  existing invocation is unchanged.
 *
 *  The one other value that means anything today is `dev.skein.lab`, which is
 *  what `bun run lab` starts: a second instance with its own store, its own
 *  `control.json` and an empty wall, so driving it cannot reach real work. See
 *  `.claude/rules/control.md`. */
const IDENTIFIER = process.env.SKEIN_ID?.trim() || "dev.skein.studio";

const CONTROL_FILE = join(process.env.APPDATA ?? "", IDENTIFIER, "control.json");

function endpoint(): { port: number; token: string } {
  if (!existsSync(CONTROL_FILE)) {
    console.error(
      `no control.json at ${CONTROL_FILE}\n` +
        `Start Skein with SKEIN_CONTROL=1 — e.g.\n` +
        `  $env:SKEIN_CONTROL="1"; bun run tauri dev\n` +
        `or, for the isolated lab wall:\n` +
        `  $env:SKEIN_CONTROL="1"; bun run lab\n` +
        `  $env:SKEIN_ID="dev.skein.lab"; bun tools/ctl.ts health`,
    );
    process.exit(2);
  }
  return JSON.parse(readFileSync(CONTROL_FILE, "utf8"));
}

/** `k=v`, `k:@file`, or a bare word (the op name). */
function parseArgs(argv: string[]): { op: string; body: Record<string, unknown>; path?: string } {
  let op = "";
  let path: string | undefined;
  const body: Record<string, unknown> = {};

  for (const raw of argv) {
    const fileAt = raw.indexOf(":@");
    const eq = raw.indexOf("=");

    if (fileAt > 0 && (eq < 0 || fileAt < eq)) {
      const key = raw.slice(0, fileAt);
      body[key] = JSON.parse(readFileSync(raw.slice(fileAt + 2), "utf8"));
    } else if (eq > 0) {
      const key = raw.slice(0, eq);
      const value = raw.slice(eq + 1);
      try {
        body[key] = JSON.parse(value);
      } catch {
        body[key] = value;
      }
    } else if (!op) {
      op = raw;
    } else {
      /* A second bare word narrows the output to one dotted path — the usual
         case is `snapshot cards`, where the whole thing is far too much. */
      path = raw;
    }
  }
  return { op, body, path };
}

const { op, body, path } = parseArgs(process.argv.slice(2));
if (!op) {
  console.error("usage: bun tools/ctl.ts <op> [key=value …] [out.path]");
  process.exit(2);
}

const { port, token } = endpoint();
const base = `http://127.0.0.1:${port}`;

let res: Response;
try {
  res =
    op === "health"
      ? await fetch(`${base}/health`)
      : await fetch(`${base}/op`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Skein-Token": token },
          body: JSON.stringify({ op, ...body }),
        });
} catch (err) {
  console.error(`could not reach Skein on ${base} — is it running?\n${String(err)}`);
  process.exit(3);
}

const text = await res.text();
let value: unknown;
try {
  value = JSON.parse(text);
} catch {
  console.error(`${res.status}: ${text}`);
  process.exit(1);
}

const picked = path
  ? path.split(".").reduce<any>((v, k) => (v == null ? v : v[k]), value)
  : value;

console.log(JSON.stringify(picked, null, 2));
/* Non-zero when the op failed, so a shell `&&` chain stops where it should. */
if (!res.ok || (value as any)?.ok === false) process.exit(1);
