/* When does `@playwright/mcp --cdp-endpoint` actually open its CDP connection,
 * and can the browser arrive *after* the card that will drive it?
 *
 * The whole of today's behaviour hangs on one sentence in `browser.rs`: an MCP
 * server's arguments are settled when the card spawns, and `--cdp-endpoint`
 * needs a value that does not exist until Chrome is running. So a card opened
 * while the browser is down gets no `mcp__browser__*` at all and cannot be
 * given any without being woken again. That sentence is true about *arguments*.
 * It says nothing about when the argument is **dialled**, and that is the
 * question this answers, because the port number is already fixed (9222) and
 * therefore already writable with nothing running.
 *
 * Four things to find out, in the order they decide the design:
 *
 *   A. Does the server survive a dead endpoint? If `initialize` or `tools/list`
 *      needs CDP, nothing below is possible and the answer to the whole brief
 *      is "no".
 *   B. Does a *later* call succeed once Chrome appears — i.e. does it dial per
 *      call, or latch the first failure for the life of the process?
 *   C. Does it dial at startup at all? A server that connects eagerly turns any
 *      always-listening endpoint into an eager Chrome start, which is the
 *      opposite of lazy. Measured by pointing it at a TCP proxy that logs its
 *      accepts.
 *   D. End to end, the actual proposal: an always-bound Volery port that starts
 *      Chrome on the first connection and then splices bytes to it. Tools
 *      listed with nothing running, Chrome started by the first tool call, call
 *      succeeds.
 *
 *   bun tools/probe-lazy-browser.ts
 *
 * Costs no API turn — this drives the MCP server directly over stdio. It does
 * cost one Chrome (~450 MB) for the length of the run, on **port 19222 with its
 * own profile** under `.scratch-<card>/lazy-browser/`, so the wall's shared
 * browser on 9222 is never touched.
 *
 * ── what it returned, @playwright/mcp@latest / Chrome 153, 2026-09-19 ──────
 *
 * ```text
 * A. endpoint refused, nothing listening
 *    initialize        ok in 1030ms
 *    tools/list        25 tools
 *    first tools/call  isError: connect ECONNREFUSED 127.0.0.1:19222   [22ms]
 * B. Chrome started now, SAME server process
 *    chrome up         385ms
 *    second call       ok                                            [1800ms]
 *    server alive      true
 * C. pointed at a gate that counts its accepts, Chrome already up
 *    accepts after initialize + tools/list   0
 *    tools/call        ok                                             [167ms]
 *    accepts after the call                  2      (the HTTP, then the WS)
 * D. gate starts Chrome on the first connection
 *    tools listed with no chrome             25
 *    chrome started before the first call    no
 *    first tools/call  ok, having started chrome in 448ms            [2291ms]
 * ```
 *
 * **A is the finding the whole feature rests on.** The endpoint is an address,
 * not a dependency: the server comes up, advertises all 25 tools, and only
 * reaches for a socket when a tool is actually called. So `--cdp-endpoint` can
 * be written into every card's `--mcp-config` at spawn with nothing at the
 * other end, which is the thing `browser.rs` had assumed impossible.
 *
 * **B says the failure does not latch.** One server process, one refused call,
 * then Chrome appears and the next call succeeds — no restart, no re-spawn. A
 * server that had cached its first CDP failure would have made every design
 * below unbuildable.
 *
 * **C says "lazy" is true rather than hoped.** Zero accepts across `initialize`
 * and `tools/list` means registering the server costs nothing — no connection,
 * and therefore nothing that could be made to start a 450 MB browser. Two
 * accepts for one tool call, because Chrome echoes the request's `Host` into
 * `webSocketDebuggerUrl`, so the WebSocket comes back through the gate too.
 *
 * **D says the proxy design works, and it is not the one that shipped.** An
 * always-bound port that starts Chrome on its first connection and then splices
 * bytes does exactly what was wanted. What shipped instead is a `PreToolUse`
 * hook (`hooks::wake_browser`), and the reasons are in `.claude/rules/browser.md`
 * — briefly: a TCP accept is not evidence that anybody wants a browser, and the
 * proxy has no way to *say* anything when Chrome cannot be started, which is
 * the failure that matters most here. D is kept because it is the measurement
 * that makes that a choice rather than an assumption, and because if the hook
 * mechanism ever goes away this is the fallback, already proved.
 *
 * **Two of D's three failures were the prototype's own**, and they are worth
 * knowing before anybody re-runs this: bytes that arrive while the proxy is
 * still starting Chrome must be *kept* (bun drops them across an `await` even
 * after `pause()`), and a killed Chrome holds its port for a moment after the
 * handle is gone. Both read as "the proxy does not work". Neither is about the
 * proxy, and a Rust implementation has the first for free — not reading a
 * socket leaves the bytes in the kernel buffer.
 *
 * One thing this machine adds that nothing here causes: a freshly created
 * Chrome profile opens an enterprise-policy startup page, so a snapshot shows a
 * corporate login tab beside `about:blank`. It is not leakage from the wall's
 * own browser; every arm here runs on its own profile on port 19222.
 */

import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const CHROME_PORT = 19222;
const PROXY_PORT = 19333;
/* Arm D binds a port of its own rather than reusing arm C's. `close()` does not
   release a listener until every connection on it has gone, and a killed MCP
   server's sockets linger — so waiting on it turned into `Failed to listen`,
   which is a fact about the probe and not about anything being measured. */
const PROXY_PORT_D = 19334;
const HOST = "127.0.0.1";

const CARD = process.env.SKEIN_CARD ?? "probe";
const SCRATCH = path.resolve(`.scratch-${CARD}`, "lazy-browser");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function say(s: string) {
  console.log(s);
}

/* ── a minimal MCP client over stdio ───────────────────────────────────── */

class Server {
  child: ChildProcess;
  #buf = "";
  #next = 1;
  #waiting = new Map<number, (v: any) => void>();
  stderr: string[] = [];

  constructor(endpoint: string) {
    this.child = spawn(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["@playwright/mcp@latest", "--cdp-endpoint", endpoint],
      { stdio: ["pipe", "pipe", "pipe"], shell: false },
    );
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (d: string) => this.#ingest(d));
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (d: string) => {
      for (const line of d.split(/\r?\n/)) if (line.trim()) this.stderr.push(line.trim());
    });
  }

  #ingest(d: string) {
    this.#buf += d;
    let i: number;
    while ((i = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, i).trim();
      this.#buf = this.#buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const resolve = this.#waiting.get(msg.id);
      if (resolve) {
        this.#waiting.delete(msg.id);
        resolve(msg);
      }
    }
  }

  notify(method: string, params: unknown = {}) {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  call(method: string, params: unknown = {}, timeoutMs = 45_000): Promise<any> {
    const id = this.#next++;
    const p = new Promise<any>((resolve) => {
      this.#waiting.set(id, resolve);
      setTimeout(() => {
        if (this.#waiting.delete(id)) resolve({ timedOut: true });
      }, timeoutMs);
    });
    this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  }

  async handshake() {
    const r = await this.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "probe-lazy-browser", version: "0" },
    });
    this.notify("notifications/initialized");
    return r;
  }

  stop() {
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
  }
}

/* ── the thing being proposed, as fifty lines of TypeScript ────────────── */

/** A TCP listener that is always bound, counts its accepts, optionally runs a
 *  hook before the first byte moves, and then splices to Chrome.
 *
 *  This is the Rust design in miniature. If this works, the design works; if it
 *  does not, no amount of Rust will save it. */
class Gate {
  server: net.Server;
  accepts = 0;
  constructor(
    private port: number,
    private to: number,
    private onFirst?: () => Promise<void>,
  ) {
    this.server = net.createServer((sock) => {
      this.accepts++;
      const n = this.accepts;
      /* **Everything the client says before there is anywhere to send it is
         kept, and that is the whole of two bugs this prototype had.** The
         request arrives within a millisecond of the connection; the upstream
         may not exist for another 400 while Chrome starts. A socket with no
         reader in that window loses what it reads, and Chrome then sits waiting
         for a request that was thrown away until playwright gives up at 30s —
         which reads exactly like the proxy being impossible, twice over, and is
         not. `pause()` is not enough here (bun drops across a real `await`
         despite it), so the bytes are held explicitly.

         **A Rust implementation needs none of this**, which is worth saying
         because it is the only reason the prototype is harder than the thing it
         is a prototype of: not reading a socket leaves the bytes in the
         kernel's receive buffer and TCP stops the sender. The buffering here is
         a JavaScript problem. */
      const early: Buffer[] = [];
      sock.on("data", (c: Buffer) => early.push(c));
      const go = async () => {
        if (n === 1 && this.onFirst) await this.onFirst();
        const up = net.connect(this.to, HOST);
        /* `net.connect` buffers writes until it is connected, so what was held
           can go straight out and there is nothing to wait for. Waiting for the
           `connect` callback is what lost the bytes in the first place. */
        for (const c of early) up.write(c);
        early.length = 0;
        sock.removeAllListeners("data");
        sock.pipe(up);
        up.pipe(sock);
        up.on("error", () => sock.destroy());
        sock.on("error", () => up.destroy());
      };
      void go();
    });
  }
  listen() {
    return new Promise<void>((r) => this.server.listen(this.port, HOST, () => r()));
  }
  /** Awaited, because the next arm binds the same port and `close()` only
   *  *starts* closing — arm D opened with `Failed to listen at 127.0.0.1`
   *  until this returned a promise. */
  close() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}

/* ── Chrome, ours, on a port nobody else is using ──────────────────────── */

function findChrome(): string {
  const roots = ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"]
    .map((v) => process.env[v])
    .filter(Boolean)
    .map((b) => path.join(b!, "Google/Chrome/Application/chrome.exe"));
  for (const p of roots) if (fs.existsSync(p)) return p;
  throw new Error("no Chrome found");
}

let chrome: ChildProcess | null = null;

async function startChrome(): Promise<number> {
  if (chrome) return 0;
  const t0 = Date.now();
  /* A fresh profile per start. Chrome restores the previous session out of a
     persistent one, so a page opened in an earlier arm turns up in a later
     arm's snapshot and the reading stops being about the arm. */
  const profile = path.join(SCRATCH, `profile-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  chrome = spawn(
    findChrome(),
    [
      `--remote-debugging-port=${CHROME_PORT}`,
      `--remote-debugging-address=${HOST}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--headless=new",
      "--window-size=1280,800",
    ],
    { stdio: "ignore", detached: false },
  );
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://${HOST}:${CHROME_PORT}/json/version`);
      if (r.ok) {
        await r.text();
        return Date.now() - t0;
      }
    } catch {
      /* not up yet */
    }
    await sleep(120);
  }
  throw new Error("chrome did not open its port");
}

/** Kill it, and wait until the port stops answering.
 *
 *  **The wait is not politeness.** `kill()` reaches one process and Chrome is a
 *  dozen, so the port stays bound for a moment after the handle is gone — and a
 *  restart inside that moment gets a `/json/version` answered by the *dying*
 *  browser, which reads as a successful start and then drops the connection
 *  mid-request. That is exactly how the first run of arm D reported a 30s
 *  timeout and made the whole gate design look unworkable. The probe was wrong,
 *  not the design. */
async function stopChrome() {
  if (!chrome) return;
  try {
    chrome.kill();
  } catch {
    /* gone */
  }
  chrome = null;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://${HOST}:${CHROME_PORT}/json/version`, {
        signal: AbortSignal.timeout(400),
      });
      await r.text();
    } catch {
      return;
    }
    await sleep(120);
  }
}

/* ── the run ───────────────────────────────────────────────────────────── */

function toolNames(list: any): string[] {
  return (list?.result?.tools ?? []).map((t: any) => t.name);
}

function outcome(r: any): string {
  if (r?.timedOut) return "TIMED OUT";
  if (r?.error) return `error: ${JSON.stringify(r.error).slice(0, 200)}`;
  if (r?.result?.isError) {
    const text = (r.result.content ?? []).map((c: any) => c.text ?? "").join(" ");
    return `isError: ${text.replace(/\s+/g, " ").slice(0, 220)}`;
  }
  const text = (r?.result?.content ?? []).map((c: any) => c.text ?? "").join(" ");
  return `ok: ${text.replace(/\s+/g, " ").slice(0, 120)}`;
}

async function main() {
  /* Swept at the start rather than at the end, which is the convention every
     probe in `tools/` follows and which this one needs more than most: it
     makes a fresh Chrome profile per start (see `startChrome`), and a profile
     is tens of megabytes. Four runs left 248 MB here before this line existed.
     At the start rather than at the end because a run that dies half way
     should not also leave the mess — and because the directory is this card's
     own (`.scratch-$SKEIN_CARD`), so nothing else can be in it. */
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  say(`scratch: ${SCRATCH}`);

  /* ── A. a dead endpoint, and whether the server comes up anyway ────── */
  say("\n── A. endpoint refused, nothing listening on 19222 ──────────────");
  const a = new Server(`http://${HOST}:${CHROME_PORT}`);
  const t0 = Date.now();
  const initA = await a.handshake();
  say(`initialize        : ${initA?.timedOut ? "TIMED OUT" : initA?.error ? "error" : "ok"} in ${Date.now() - t0}ms`);
  const listA = await a.call("tools/list");
  const names = toolNames(listA);
  say(`tools/list        : ${names.length} tools${names.length ? ` (${names.slice(0, 3).join(", ")}…)` : ""}`);

  const t1 = Date.now();
  const callA = await a.call("tools/call", {
    name: "browser_navigate",
    arguments: { url: "about:blank" },
  });
  say(`first tools/call  : ${outcome(callA)} [${Date.now() - t1}ms]`);

  /* ── B. Chrome appears late; does the same server dial again? ──────── */
  say("\n── B. Chrome started now, same server process ───────────────────");
  const took = await startChrome();
  say(`chrome up         : ${took}ms`);
  const t2 = Date.now();
  const callB = await a.call("tools/call", {
    name: "browser_navigate",
    arguments: { url: "about:blank" },
  });
  say(`second tools/call : ${outcome(callB)} [${Date.now() - t2}ms]`);
  say(`server alive      : ${a.child.exitCode === null}`);
  a.stop();

  /* ── C. does it dial at startup? ───────────────────────────────────── */
  say("\n── C. pointed at a gate that counts accepts (Chrome already up) ─");
  const gateC = new Gate(PROXY_PORT, CHROME_PORT);
  await gateC.listen();
  const c = new Server(`http://${HOST}:${PROXY_PORT}`);
  await c.handshake();
  await c.call("tools/list");
  await sleep(1500);
  say(`accepts after initialize + tools/list : ${gateC.accepts}`);
  const t3 = Date.now();
  const callC = await c.call("tools/call", {
    name: "browser_navigate",
    arguments: { url: "about:blank" },
  });
  say(`tools/call        : ${outcome(callC)} [${Date.now() - t3}ms]`);
  say(`accepts after the call                : ${gateC.accepts}`);
  c.stop();
  await gateC.close();
  await stopChrome();

  /* ── D. the proposal, end to end ───────────────────────────────────── */
  say("\n── D. the proposal: gate starts Chrome on the first connection ──");
  let started = 0;
  const gateD = new Gate(PROXY_PORT_D, CHROME_PORT, async () => {
    started++;
    const ms = await startChrome();
    say(`   …gate started chrome in ${ms}ms`);
  });
  await gateD.listen();
  const d = new Server(`http://${HOST}:${PROXY_PORT_D}`);
  await d.handshake();
  const listD = await d.call("tools/list");
  await sleep(1200);
  say(`tools listed with no chrome : ${toolNames(listD).length}`);
  say(`chrome started yet          : ${started > 0 ? "yes" : "no"}`);
  const t4 = Date.now();
  const callD = await d.call("tools/call", {
    name: "browser_navigate",
    arguments: { url: "about:blank" },
  });
  say(`first tools/call            : ${outcome(callD)} [${Date.now() - t4}ms]`);
  const t5 = Date.now();
  const callD2 = await d.call("tools/call", {
    name: "browser_snapshot",
    arguments: {},
  });
  say(`second tools/call           : ${outcome(callD2)} [${Date.now() - t5}ms]`);
  say(`gate accepts                : ${gateD.accepts}`);
  d.stop();
  await gateD.close();

  if (d.stderr.length) say(`\nserver stderr (last 6):\n  ${d.stderr.slice(-6).join("\n  ")}`);
}

main()
  .catch((e) => {
    console.error("probe failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopChrome();
    await sleep(300);
    process.exit(process.exitCode ?? 0);
  });
