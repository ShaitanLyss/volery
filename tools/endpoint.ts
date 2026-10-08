/* Reading `control.json` without trusting it.
 *
 * The file says where to send a credential, and it outlives the process that
 * wrote it whenever that process is killed rather than quit (`Control::cleanup`
 * is exit-time code, which a crash skips). Ephemeral ports are reused, so a
 * reader that posts straight away can hand `X-Skein-Token` to whatever owns the
 * port now. The pid the app writes into the file, and again in its /health
 * reply, is what makes the check possible; the decision is here, pure, so it
 * can be tested without a process. Used by `tools/ctl.ts` and `test/wall.test.ts`.
 */

export type Endpoint = { port: number; token: string; pid?: number };

/** What the file held, or null if it is not an endpoint at all. */
export function parseEndpoint(raw: unknown): Endpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Number.isInteger(r.port) || typeof r.token !== "string" || !r.token) return null;
  const ep: Endpoint = { port: r.port as number, token: r.token };
  if (Number.isInteger(r.pid) && (r.pid as number) > 0) ep.pid = r.pid as number;
  return ep;
}

export type Verdict =
  /** safe to talk to */
  | { kind: "live" }
  /** the writing process is gone: the file is stale and may be removed */
  | { kind: "dead"; why: string }
  /** the pid lives but the port does not say it is Volery's, or is silent */
  | { kind: "unconfirmed"; why: string };

/** `alive` is whether the pid is a running process; `healthPid` is the `pid` in
 *  what /health answered, or null when nothing answered or it named none. */
export function judge(ep: Endpoint, alive: boolean | null, healthPid: number | null): Verdict {
  if (ep.pid !== undefined && alive === false) {
    return { kind: "dead", why: `pid ${ep.pid} is not running` };
  }
  if (healthPid === null) {
    return { kind: "unconfirmed", why: `nothing on port ${ep.port} answered /health as Volery` };
  }
  if (ep.pid !== undefined && healthPid !== ep.pid) {
    return {
      kind: "unconfirmed",
      why: `port ${ep.port} answers as pid ${healthPid}, but control.json was written by pid ${ep.pid}`,
    };
  }
  /* A file from a build that wrote no pid can only be confirmed by /health
     answering, which it did. */
  return { kind: "live" };
}

/** Whether a pid is a running process. EPERM means it exists. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** GET /health and return the pid it names, or null. Never sends the token. */
export async function healthPid(port: number, timeoutMs = 3000): Promise<number | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const v = (await res.json()) as Record<string, unknown>;
    if (v?.name !== "skein") return null;
    return Number.isInteger(v.pid) ? (v.pid as number) : -1;
  } catch {
    return null;
  }
}
