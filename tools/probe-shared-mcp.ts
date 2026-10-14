/* Can ONE `@playwright/mcp` serve every card on the wall, instead of one each?
 *
 * Every project card used to carry its own stdio `npx @playwright/mcp
 * --cdp-endpoint http://127.0.0.1:9222`: ~217 MB and three processes per card
 * (sink 482e25ee), all driving the same Chrome. `mcphost.rs` replaces that with
 * one HTTP server for the wall. Reading playwright-core's source says each HTTP
 * session gets what a stdio server got — its own CDP connection, the browser's
 * default context, its own idea of the current tab. This is the measurement.
 *
 *   bun tools/probe-shared-mcp.ts
 *
 * Part 1 drives two sessions by hand (no API turn):
 *   1. a cookie set before any session — the user's own sign-in — is seen by both
 *   2. a cookie one session sets is seen by the other (one cookie jar)
 *   3. B navigating does not move A: A's snapshot is still A's page
 *   4. the server's private memory with two sessions attached
 *
 * Part 2 is one real `claude` turn on Haiku with the exact entry Volery writes
 * (`{"type":"http","url":…}`): does the CLI connect, list the tools and call
 * one — and when that process is killed hard, as Volery kills a card, does the
 * server close its session by itself (`DEBUG=pw:mcp:test` prints "delete http
 * session")?
 *
 * One headless Chrome on 19222 with its own profile under
 * `.scratch-<card>/shared-mcp/`, the MCP server on 19444. The wall's own
 * browser on 9222 and server on 9244 are never touched — and the server is
 * named `probebrowser`, never `browser`, for the reason below.
 *
 * ── what it returned, @playwright/mcp 0.0.83 / claude 2.1.285, 2026-10-14 ──
 *
 * ```text
 * server answering after      10–16s   (cold-ish npx on a loaded machine)
 * 3. A after B moved          /b-moved — both sessions drive the browser's
 *                             first page, exactly as N stdio servers do today
 * 4. two sessions attached    110 MB private, the whole server
 * 5. claude init              connected, 25 tools; a real call navigated
 * 6. claude killed hard       the server closed its session within 15s
 * ```
 *
 * **Three things it found that reading the source had not:**
 *
 * - **The MCP route has a host check of its own**, separate from the one in
 *   `computeAllowedHosts`: it admits only `localhost:<port>` unless told
 *   otherwise. A card sending `127.0.0.1:<port>` gets a 403, which is why
 *   `mcphost.rs` passes `--allowed-hosts 127.0.0.1:<port>`.
 * - **A 403 is remembered by name, machine-wide.** The CLI read that 403 as
 *   "needs auth" and wrote the server's *name* into
 *   `~/.claude/mcp-needs-auth-cache.json`; every later session on the machine
 *   then reported `needs-auth` without sending a single request. Had the probe
 *   used the name `browser`, every card on the wall would have lost its shared
 *   browser the moment this shipped. So the probe's server is `probebrowser`,
 *   and the shared server must never answer a card with 401 or 403.
 * - **Tab isolation is not what it costs.** Step 3 reads as a regression and
 *   is not one: each session picks the browser's first page, which is what
 *   every per-card stdio server already did (sinks 7af2acb4, 9e05a3fd). Sharing
 *   the server neither causes nor fixes it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const CHROME_PORT = 19222;
const MCP_PORT = 19444;
const PAGE_PORT = 19555;
const HOST = "127.0.0.1";
const CARD = process.env.SKEIN_CARD ?? "probe";
const SCRATCH = path.resolve(`.scratch-${CARD}`, "shared-mcp");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (s: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${s}`);

const pages = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const name = url.searchParams.get("name") ?? "x";
  if (url.pathname === "/set") {
    res.setHeader("set-cookie", `${name}=1; Path=/; Max-Age=3600`);
    res.end(`<title>set ${name}</title><h1>set ${name}</h1>`);
    return;
  }
  res.end(`<title>${url.pathname.slice(1)}</title><h1>cookies: [${req.headers.cookie ?? ""}]</h1>`);
});

/* ── a minimal streamable-HTTP MCP client ──────────────────────────────── */

class Client {
  session: string | null = null;
  #next = 1;
  constructor(public label: string) {}

  async #post(body: unknown): Promise<any> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.session) headers["mcp-session-id"] = this.session;
    const r = await fetch(`http://${HOST}:${MCP_PORT}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    const sid = r.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    if (r.status === 202) return { status: 202 };
    const text = await r.text();
    if ((r.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const datas = text
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice(5).trim()));
      return datas.find((d) => "result" in d || "error" in d) ?? { status: r.status, text };
    }
    try {
      return JSON.parse(text);
    } catch {
      return { status: r.status, text: text.slice(0, 200) };
    }
  }

  async init() {
    const r = await this.#post({
      jsonrpc: "2.0",
      id: this.#next++,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: `probe-${this.label}`, version: "0" } },
    });
    await this.#post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    return r;
  }

  call(name: string, args: Record<string, unknown> = {}) {
    return this.#post({ jsonrpc: "2.0", id: this.#next++, method: "tools/call", params: { name, arguments: args } });
  }
}

const text = (r: any) =>
  r?.error ? `ERROR ${JSON.stringify(r.error)}` : (r?.result?.content ?? []).map((c: any) => c.text ?? "").join("\n");
const cookiesIn = (r: any) => text(r).match(/cookies: \[([^\]]*)\]/)?.[1] ?? `(? ${text(r).slice(0, 120)})`;
const pageUrl = (r: any) => text(r).match(/Page URL: (\S+)/)?.[1]?.replace(`http://${HOST}:${PAGE_PORT}`, "") ?? `(? ${text(r).slice(0, 120)})`;

/* ── Chrome and the server ─────────────────────────────────────────────── */

function findChrome(): string {
  for (const v of ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"]) {
    const p = path.join(process.env[v] ?? "", "Google/Chrome/Application/chrome.exe");
    if (fs.existsSync(p)) return p;
  }
  throw new Error("no Chrome found");
}

async function waitFor(url: string, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(800) });
      await r.text();
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`${url} never answered`);
}

const kids: ChildProcess[] = [];
function killAll() {
  for (const c of kids) if (c.pid) spawn("taskkill", ["/T", "/F", "/PID", String(c.pid)], { stdio: "ignore" });
}

async function privateMb(port: number): Promise<string> {
  const ps = spawn(
    "pwsh",
    ["-NoProfile", "-Command",
      `$o=(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if ($o) { $p=Get-Process -Id $o; '{0} pid {1}: private {2:N0} MB' -f $p.Name,$p.Id,($p.PrivateMemorySize64/1MB) } else { 'no listener' }`],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let out = "";
  ps.stdout!.on("data", (d) => (out += d));
  await new Promise((r) => ps.on("close", r));
  return out.trim();
}

async function main() {
  try {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  } catch {
    /* a Chrome that died a moment ago can still hold its profile */
  }
  fs.mkdirSync(SCRATCH, { recursive: true });
  await new Promise<void>((r) => pages.listen(PAGE_PORT, HOST, () => r()));

  const chrome = spawn(findChrome(), [
    `--remote-debugging-port=${CHROME_PORT}`, `--remote-debugging-address=${HOST}`, "--remote-allow-origins=*",
    `--user-data-dir=${path.join(SCRATCH, "profile")}`, "--no-first-run", "--no-default-browser-check",
    "--no-startup-window", "--headless=new",
  ], { stdio: "ignore" });
  kids.push(chrome);
  await waitFor(`http://${HOST}:${CHROME_PORT}/json/version`, 20_000);
  await (await fetch(`http://${HOST}:${CHROME_PORT}/json/new?http://${HOST}:${PAGE_PORT}/set?name=user`, { method: "PUT" })).text();
  say("chrome up, the user's cookie set in its default context");

  /* Exactly what `mcphost::start` runs. */
  const server = spawn("cmd", ["/C", "npx", "--yes", "@playwright/mcp@latest", "--port", String(MCP_PORT),
    "--host", HOST, "--allowed-hosts", `${HOST}:${MCP_PORT}`, "--cdp-endpoint", `http://${HOST}:${CHROME_PORT}`],
    { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, DEBUG: "pw:mcp:test" } });
  kids.push(server);
  const log: string[] = [];
  server.stderr!.on("data", (d) => log.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const s0 = Date.now();
  await waitFor(`http://${HOST}:${MCP_PORT}/`, 90_000).catch(() => {});
  say(`server answering after ${((Date.now() - s0) / 1000).toFixed(1)}s`);

  /* ── part 1 ── */
  const a = new Client("A");
  const b = new Client("B");
  await a.init();
  await b.init();
  say(`sessions: A=${a.session ? "yes" : "NO"} B=${b.session ? "yes" : "NO"}`);
  say(`1. user's cookie   A: [${cookiesIn(await a.call("browser_navigate", { url: `http://${HOST}:${PAGE_PORT}/a-home` }))}]  B: [${cookiesIn(await b.call("browser_navigate", { url: `http://${HOST}:${PAGE_PORT}/b-home` }))}]`);
  await a.call("browser_navigate", { url: `http://${HOST}:${PAGE_PORT}/set?name=fromA` });
  say(`2. A's cookie, from B: [${cookiesIn(await b.call("browser_navigate", { url: `http://${HOST}:${PAGE_PORT}/b-after` }))}]`);
  await a.call("browser_navigate", { url: `http://${HOST}:${PAGE_PORT}/a-home` });
  await b.call("browser_navigate", { url: `http://${HOST}:${PAGE_PORT}/b-moved` });
  say(`3. A after B moved: ${pageUrl(await a.call("browser_snapshot"))}   (A expects /a-home)`);
  say(`4. server with two sessions: ${await privateMb(MCP_PORT)}`);

  /* ── part 2 ── */
  const cfg = JSON.stringify({ mcpServers: { probebrowser: { type: "http", url: `http://${HOST}:${MCP_PORT}/mcp` } } });
  const CLAUDE = Bun.which("claude") ?? "claude";
  const card = Bun.spawn([CLAUDE, "--print", "--input-format", "stream-json", "--output-format", "stream-json",
    "--verbose", "--dangerously-skip-permissions", "--strict-mcp-config", "--mcp-config", cfg,
    "--model", "claude-haiku-4-5-20251001", "--session-id", crypto.randomUUID()],
    { cwd: SCRATCH, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  card.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content:
    `Call mcp__probebrowser__browser_navigate with url http://${HOST}:${PAGE_PORT}/from-claude and reply with only the page title it reports.` } }) + "\n");
  card.stdin.flush();
  const deadline = setTimeout(() => card.kill(), 150_000);
  outer: for await (const chunk of card.stdout) {
    for (const line of new TextDecoder().decode(chunk).split("\n")) {
      if (!line.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "system" && ev.subtype === "init") {
        const s = (ev.mcp_servers ?? []).find((x: any) => x.name === "probebrowser");
        say(`5. claude init: browser ${JSON.stringify(s)}, ${(ev.tools ?? []).filter((t: string) => t.startsWith("mcp__probebrowser__")).length} tools`);
      }
      for (const blk of ev?.message?.content ?? []) {
        if (blk.type === "tool_result") say(`   tool result: ${JSON.stringify(typeof blk.content === "string" ? blk.content : blk.content?.[0]?.text ?? "").slice(0, 140)}`);
      }
      if (ev.type === "result") { say(`   claude said: ${JSON.stringify(ev.result).slice(0, 100)}`); break outer; }
    }
  }
  clearTimeout(deadline);
  const before = log.filter((l) => l.includes("delete http session")).length;
  /* As Volery ends a card: no goodbye. */
  spawn("taskkill", ["/T", "/F", "/PID", String(card.pid)], { stdio: "ignore" });
  await sleep(15_000);
  const after = log.filter((l) => l.includes("delete http session")).length;
  say(`6. claude killed hard; sessions the server closed on its own in 15s: ${after - before}`);
  say(`   server now: ${await privateMb(MCP_PORT)}`);
}

main()
  .catch((e) => {
    console.error("probe failed:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    killAll();
    pages.close();
    await sleep(500);
    process.exit(process.exitCode ?? 0);
  });
