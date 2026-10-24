/* Does each card get tabs of its own from the shared browser, and do they keep
 * running while another card's tab is in front?
 *
 *   bun tools/probe-card-tabs.ts          # two sessions by hand, no API turn
 *   bun tools/probe-card-tabs.ts live     # two real `claude` cards at once, Haiku
 *   CHROME_FLAGS= bun tools/probe-card-tabs.ts   # without the occlusion flag,
 *                                         # to watch a card's page go hidden
 *
 * `src-tauri/src/browserhost.cjs` is the wall's browser MCP server, with a card
 * named in the URL (`/mcp/<card>`) and each card's pages in windows of their
 * own. This drives two "cards" at it by hand (no API turn) and asks the
 * questions the sink kept asking (9e05a3fd, 7af2acb4, d3169ad9, c735221a,
 * f7553ae5):
 *
 *   1. a page nobody owns — the browser's first tab — is in nobody's list
 *   2. A and B each navigate; each list holds only its own tab
 *   3. B opens a second tab and brings its first forward; A's page is still
 *      A's, still `visible`, rAF still fires, and a real mouse click lands
 *   4. A popup opened by A's page is A's
 *   5. A's session ends: within the grace its tabs survive and a new session
 *      for A finds them again; after it, they are closed
 *   6. Volery's release closes a card's tabs at once
 *
 * `live` is the same browser and host with two real cards on it, spawned with
 * the `browser` entry Volery writes (`/mcp/<card>`), driving at the same time:
 * A holds a page and measures it after B has opened, navigated and selected
 * tabs of its own; B lists what it can see. Then both processes are killed
 * hard, as Volery kills a card, and the heartbeat and the grace have to close
 * every tab they opened.
 *
 * One headed Chrome on 19333 with its own profile under
 * `.scratch-<card>/card-tabs/`, its first window parked off-screen the way
 * Volery parks it, and the host on 19446. The wall's own 9222 and 9244 are
 * never touched.
 */

import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const CHROME_PORT = 19333;
const MCP_PORT = 19446;
const PAGE_PORT = 19556;
const HOST = "127.0.0.1";
const CARD = process.env.SKEIN_CARD ?? "probe";
const SCRATCH = path.resolve(`.scratch-${CARD}`, "card-tabs");
const GRACE = 4000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (s: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${s}`);
let failures = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) failures++;
  say(`${ok ? "ok  " : "FAIL"} ${what}`);
};

/* A page that counts its own frames and the real clicks it receives. */
const pages = http.createServer((req, res) => {
  const name = new URL(req.url ?? "/", `http://${HOST}`).pathname.slice(1) || "root";
  res.setHeader("content-type", "text/html");
  res.end(`<title>${name}</title>
<button id=b style="position:fixed;left:0;top:0;width:300px;height:300px">${name}</button>
<a id=pop style="position:fixed;left:0;top:400px" href="/popup-of-${name}" target=_blank>pop</a>
<script>
  window.frames_ = 0; window.clicks_ = 0;
  const tick = () => { window.frames_++; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  document.getElementById('b').addEventListener('mousedown', () => window.clicks_++);
</script>`);
});

class Client {
  session: string | null = null;
  #next = 1;
  constructor(public card: string) {}

  async #post(body: unknown): Promise<any> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (this.session) headers["mcp-session-id"] = this.session;
    const r = await fetch(`http://${HOST}:${MCP_PORT}/mcp/${this.card}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(45_000) });
    const sid = r.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    if (r.status === 202) return { status: 202 };
    const text = await r.text();
    if ((r.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const datas = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5).trim()));
      return datas.find((d) => "result" in d || "error" in d) ?? { status: r.status, text };
    }
    try {
      return JSON.parse(text);
    } catch {
      return { status: r.status, text: text.slice(0, 200) };
    }
  }

  async init() {
    this.session = null;
    const r = await this.#post({ jsonrpc: "2.0", id: this.#next++, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: `probe-${this.card}`, version: "0" } } });
    await this.#post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    return r;
  }

  call(name: string, args: Record<string, unknown> = {}) {
    return this.#post({ jsonrpc: "2.0", id: this.#next++, method: "tools/call", params: { name, arguments: args } });
  }

  async end() {
    await fetch(`http://${HOST}:${MCP_PORT}/mcp/${this.card}`, { method: "DELETE", headers: { "mcp-session-id": this.session ?? "" } }).catch(() => {});
    this.session = null;
  }
}

const text = (r: any) => (r?.error ? `ERROR ${JSON.stringify(r.error)}` : (r?.result?.content ?? []).map((c: any) => c.text ?? "").join("\n"));
const tabLines = (r: any) => text(r).split("\n").filter((l) => /^- \d+:/.test(l));
const result = (r: any) => {
  const m = text(r).match(/### Result\n([\s\S]*?)(\n###|$)/);
  try {
    return JSON.parse(m?.[1]?.trim() ?? "null");
  } catch {
    return m?.[1]?.trim() ?? text(r).slice(0, 300);
  }
};
const cdpList = async () => (await (await fetch(`http://${HOST}:${CHROME_PORT}/json/list`)).json()).filter((t: any) => t.type === "page");

function findChrome(): string {
  for (const v of ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"]) {
    const p = path.join(process.env[v] ?? "", "Google/Chrome/Application/chrome.exe");
    if (fs.existsSync(p)) return p;
  }
  throw new Error("no Chrome found");
}

function findCore(): string {
  const npx = path.join(process.env.LOCALAPPDATA ?? "", "npm-cache", "_npx");
  for (const d of fs.readdirSync(npx)) {
    const pkg = path.join(npx, d, "node_modules", "@playwright", "mcp", "package.json");
    if (fs.existsSync(pkg) && JSON.parse(fs.readFileSync(pkg, "utf8")).version === "0.0.83") return path.join(npx, d, "node_modules", "playwright-core");
  }
  throw new Error("no cached @playwright/mcp@0.0.83 — run `npx -y @playwright/mcp@0.0.83 --version` once");
}

async function waitFor(url: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(500) });
      return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`${url} never answered`);
}

let chrome: ChildProcess | undefined;
let host: ChildProcess | undefined;

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  pages.listen(PAGE_PORT, HOST);
  chrome = spawn(findChrome(), [`--remote-debugging-port=${CHROME_PORT}`, `--user-data-dir=${path.join(SCRATCH, "profile")}`, "--no-first-run", "--no-default-browser-check", "--no-startup-window", ...(process.env.CHROME_FLAGS ?? "--disable-backgrounding-occluded-windows").split(" ").filter(Boolean)], { stdio: "ignore" });
  await waitFor(`http://${HOST}:${CHROME_PORT}/json/version`, 15000);
  /* Volery's first page, and its window parked the way `park_windows` does. */
  const first = await (await fetch(`http://${HOST}:${CHROME_PORT}/json/new?about:blank`, { method: "PUT" })).json();
  if (!process.env.NOPARK) await parkWindowOf(first.id);
  say(`chrome up; first page ${first.id.slice(0, 8)} parked`);

  host = spawn("node", ["src-tauri/src/browserhost.cjs", "--port", String(MCP_PORT), "--cdp-endpoint", `http://${HOST}:${CHROME_PORT}`, "--state", path.join(SCRATCH, "owners.json"), "--grace-ms", String(GRACE)], { env: { ...process.env, VOLERY_PLAYWRIGHT_CORE: findCore() }, stdio: ["ignore", "ignore", "pipe"] });
  host.stderr!.on("data", (d) => process.stdout.write(`        host| ${d}`));
  await waitFor(`http://${HOST}:${MCP_PORT}/volery/tabs`, 15000);

  if (process.argv.includes("live")) return live();

  const A = new Client("cardA");
  const B = new Client("cardB");
  await A.init();
  await B.init();

  // 1
  /* Listing makes sure there is a tab, so a fresh card's list is the one it
     was just given — never the page that was already there. */
  const emptyA = tabLines(await A.call("browser_tabs", { action: "list" }));
  check(emptyA.length === 1 && (await cdpList()).length === 2, `1. a fresh card is given a tab of its own, not the first page: ${emptyA.join(" | ")}`);

  // 2
  await A.call("browser_navigate", { url: `http://${HOST}:${PAGE_PORT}/a` });
  await B.call("browser_navigate", { url: `http://${HOST}:${PAGE_PORT}/b` });
  const la = tabLines(await A.call("browser_tabs", { action: "list" }));
  const lb = tabLines(await B.call("browser_tabs", { action: "list" }));
  check(la.length === 1 && la[0].includes("/a"), `2. A lists only its tab: ${la.join(" | ")}`);
  check(lb.length === 1 && lb[0].includes("/b"), `2. B lists only its tab: ${lb.join(" | ")}`);
  const listed = await cdpList();
  check(listed.length === 3, `2. the browser holds three pages (first + A + B): ${listed.length}`);

  // windows: every page its own, and off-screen like the first
  const wins = new Set<number>();
  for (const t of listed) wins.add((await windowOf(t.id)).windowId);
  check(wins.size === 3, `2. three pages, three windows (${wins.size})`);
  const aTarget = listed.find((t: any) => t.url.endsWith("/a"));
  const bounds = (await windowOf(aTarget.id)).bounds;
  check(bounds.left <= -10000, `2. A's window opened where the browser is parked (left ${bounds.left})`);

  // 3
  await B.call("browser_tabs", { action: "new" });
  await B.call("browser_navigate", { url: `http://${HOST}:${PAGE_PORT}/b2` });
  await B.call("browser_tabs", { action: "select", index: 0 });
  const seen = result(
    await A.call("browser_run_code_unsafe", {
      code: `async (page) => {
        const f0 = await page.evaluate(() => window.frames_);
        await page.waitForTimeout(500);
        const f1 = await page.evaluate(() => window.frames_);
        await page.mouse.click(100, 100);
        await page.waitForTimeout(100);
        return { url: page.url(), vis: await page.evaluate(() => document.visibilityState), frames: f1 - f0, clicks: await page.evaluate(() => window.clicks_) };
      }`,
    }),
  );
  say(`   A's page while B is busy: ${JSON.stringify(seen)}`);
  check(seen?.url?.endsWith("/a"), "3. A's run_code is on A's page");
  check(seen?.vis === "visible", "3. A's page is visible");
  check(seen?.frames > 5, "3. A's rAF keeps running");
  check(seen?.clicks === 1, "3. a real mouse click reached A's page");
  const lb2 = tabLines(await B.call("browser_tabs", { action: "list" }));
  check(lb2.length === 2 && !lb2.join().includes("/a"), `3. B lists its two tabs and not A's: ${lb2.join(" | ")}`);
  const closeOther = await B.call("browser_tabs", { action: "close", index: 5 });
  check(/not found/i.test(text(closeOther)), "3. B cannot close a tab index it does not have");

  // 4
  await A.call("browser_run_code_unsafe", { code: `async (page) => { await page.click('#pop'); await page.waitForTimeout(800); }` });
  const la2 = tabLines(await A.call("browser_tabs", { action: "list" }));
  check(la2.length === 2 && la2.join().includes("popup-of-a"), `4. A's popup is A's: ${la2.join(" | ")}`);
  const lb3 = tabLines(await B.call("browser_tabs", { action: "list" }));
  check(!lb3.join().includes("popup"), "4. ...and not B's");

  // 5
  await A.end();
  await sleep(GRACE / 3);
  await A.init();
  const back = tabLines(await A.call("browser_tabs", { action: "list" }));
  check(back.length === 2, `5. A's new session within the grace finds its tabs: ${back.join(" | ")}`);
  await A.end();
  await sleep(GRACE + 1500);
  const left = await cdpList();
  check(!left.some((t: any) => t.url.includes("/a") || t.url.includes("popup-of-a")), `5. after the grace A's tabs are closed (${left.map((t: any) => t.url.split("/").pop()).join(", ")})`);

  // 6
  const rel = await (await fetch(`http://${HOST}:${MCP_PORT}/volery/release/cardB`, { method: "POST" })).json();
  const after = await cdpList();
  check(rel.closed === 2 && after.length === 1, `6. release closed B's two tabs at once (${rel.closed}); left: ${after.length}`);
  const owners = await (await fetch(`http://${HOST}:${MCP_PORT}/volery/tabs`)).json();
  check(Object.keys(owners.owners).length === 0, "6. nobody owns anything now");
}

/* ── live: two real cards ─────────────────────────────────────────────── */

function card(handle: string, prompt: string): Promise<string> {
  const config = JSON.stringify({ mcpServers: { probebrowser: { type: "http", url: `http://${HOST}:${MCP_PORT}/mcp/${handle}` } } });
  const cfgFile = path.join(SCRATCH, `${handle}.mcp.json`);
  fs.writeFileSync(cfgFile, config);
  const child = spawn("claude", ["-p", prompt, "--model", "haiku", "--strict-mcp-config", "--mcp-config", cfgFile, "--allowedTools", "mcp__probebrowser", "--output-format", "text"], { cwd: SCRATCH, stdio: ["ignore", "pipe", "pipe"] });
  cards.push(child);
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  return new Promise((r) => child.on("exit", () => r(out.trim())));
}
const cards: ChildProcess[] = [];

async function live() {
  const page = (n: string) => `http://${HOST}:${PAGE_PORT}/${n}`;
  const A = card(
    "liveA",
    `Use only the mcp__probebrowser__ tools. 1) browser_navigate to ${page("a")}. 2) browser_wait_for with time 25. ` +
      `3) browser_run_code_unsafe with this code exactly: async (page) => { const f0 = await page.evaluate(() => window.frames_); await page.waitForTimeout(500); const f1 = await page.evaluate(() => window.frames_); await page.mouse.click(100, 100); await page.waitForTimeout(100); return JSON.stringify({ url: page.url(), vis: await page.evaluate(() => document.visibilityState), frames: f1 - f0, clicks: await page.evaluate(() => window.clicks_) }); } ` +
      `4) browser_tabs with action list. Then reply with ONLY two lines: line 1 the JSON string step 3 returned, line 2 the URLs from step 4 separated by spaces.`,
  );
  await sleep(4000);
  const B = card(
    "liveB",
    `Use only the mcp__probebrowser__ tools. 1) browser_navigate to ${page("b")}. 2) browser_tabs with action new. 3) browser_navigate to ${page("b2")}. ` +
      `4) browser_tabs with action select, index 0. 5) browser_navigate to ${page("b3")}. 6) browser_tabs with action list. ` +
      `Then reply with ONLY the URLs from step 6, separated by spaces.`,
  );
  const [a, b] = await Promise.all([A, B]);
  say(`   A said: ${a.replace(/\n/g, " / ")}`);
  say(`   B said: ${b.replace(/\n/g, " / ")}`);
  const json = a.match(/\{[^}]*\}/)?.[0];
  let seen: any = null;
  try {
    seen = JSON.parse(json ?? "null");
  } catch {}
  check(seen?.url?.endsWith("/a"), "live: A's run_code ran on A's page, after B had been driving");
  check(seen?.vis === "visible" && seen?.frames > 5, `live: A's page stayed visible and painting (${seen?.vis}, ${seen?.frames} frames)`);
  check(seen?.clicks === 1, "live: a real click reached A's page");
  check(!/\/b\d?\b/.test(a.split("\n").slice(1).join(" ")), "live: A's tab list holds none of B's pages");
  check(/\/b3\b/.test(b) && /\/b2\b/.test(b) && !/\/a\b/.test(b), "live: B's list is B's two tabs, the first navigated again, and not A's");
  /* No count of the browser's pages here: B finishes first, and its tabs are
     closed GRACE after its session goes — correctly, and usually before A is
     done. The host's own record says which card still holds what. */
  const owners = await (await fetch(`http://${HOST}:${MCP_PORT}/volery/tabs`)).json();
  say(`   owners: ${JSON.stringify(owners)}`);

  /* The CLI exited on its own here; a card Volery kills is the harder case,
     and the heartbeat is what has to notice either. */
  await sleep(GRACE + 20000);
  const after = await cdpList();
  check(after.length === 1, `live: with both cards gone, the heartbeat and the grace closed their tabs (${after.length} left)`);
}

async function cdp(method: string, params: Record<string, unknown> = {}) {
  const v = await (await fetch(`http://${HOST}:${CHROME_PORT}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const answer = await new Promise<any>((resolve) => {
    ws.onmessage = (e) => resolve(JSON.parse(String(e.data)));
    ws.send(JSON.stringify({ id: 1, method, params }));
  });
  ws.close();
  if (answer.error) throw new Error(JSON.stringify(answer.error));
  return answer.result;
}
const windowOf = (targetId: string) => cdp("Browser.getWindowForTarget", { targetId });
async function parkWindowOf(targetId: string) {
  const { windowId } = await windowOf(targetId);
  await cdp("Browser.setWindowBounds", { windowId, bounds: { left: -32000, top: -32000, width: 1280, height: 800 } });
}

main()
  .catch((e) => {
    failures++;
    console.error(e);
  })
  .finally(async () => {
    /* `kill` reaches one process and Chrome is a dozen; the tree has to go or
       the profile stays locked for the next run. */
    for (const c of [...cards, host, chrome]) if (c?.pid) spawn("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    pages.close();
    await sleep(1500);
    try {
      fs.rmSync(SCRATCH, { recursive: true, force: true });
    } catch {}
    say(failures ? `${failures} FAILED` : "all passed");
    process.exit(failures ? 1 : 0);
  });
