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

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { healthPid, judge, parseEndpoint, pidAlive, type Endpoint } from "./endpoint.ts";

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

/** Read control.json and confirm it still describes a live Volery before any
 *  request — and above all before the token — leaves. A dead pid means the
 *  file is stale (a crash skips `Control::cleanup`), so it is removed, unless
 *  it changed since we read it, which means a new instance just wrote it. A
 *  live pid whose port does not answer as that pid is *refused but kept*: it
 *  may simply still be starting. */
async function endpoint(): Promise<Endpoint> {
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
  const raw = readFileSync(CONTROL_FILE, "utf8");
  let ep: Endpoint | null = null;
  try {
    ep = parseEndpoint(JSON.parse(raw));
  } catch {}
  if (!ep) {
    console.error(`${CONTROL_FILE} is not a control endpoint — refusing to use it`);
    process.exit(2);
  }
  const verdict = judge(ep, ep.pid === undefined ? null : pidAlive(ep.pid), await healthPid(ep.port));
  if (verdict.kind === "live") return ep;
  if (verdict.kind === "dead") {
    let removed = false;
    try {
      if (readFileSync(CONTROL_FILE, "utf8") === raw) {
        unlinkSync(CONTROL_FILE);
        removed = true;
      }
    } catch {}
    console.error(
      `stale control.json (${verdict.why})${removed ? " — removed it" : ""}; no Volery is running here.\n` +
        `Start one with SKEIN_CONTROL=1. Nothing was sent.`,
    );
  } else {
    console.error(
      `control.json at ${CONTROL_FILE} cannot be trusted (${verdict.why}). Nothing was sent` +
        ` — the token stays here. If Volery is still starting, try again.`,
    );
  }
  process.exit(3);
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

const { port, token } = await endpoint();
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
