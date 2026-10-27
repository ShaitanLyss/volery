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
 *      for A finds them again; after it, they are closed — and what A held is
 *      saved into the vault first
 *   6. Volery's release closes a card's tabs at once, saving them too
 *   F. a page sharing its window with a popup tab is told its frames are not
 *      real, once; a page a script opens with `page.context().newPage()` gets a
 *      window of its own (`browserframes.cjs`)
 *
 * And, since each card became a browser context of its own (sinks 0ff8aa7f,
 * f3a07350, 38adbb03):
 *
 *   S. a card starts with the vault's cookie and localStorage (seeded)
 *   I. what A writes — a cookie, a localStorage key — B on the same origin
 *      does not see
 *   V. a sign-in made in one card reaches a card started after it was saved
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
const VAULT = path.join(SCRATCH, "vault.json");
/* Stands in for Volery's `ask::STALLED_PATH`: what the host reports, kept. */
const REPORT_PORT = 19667;
const reports: { card: string; body: any }[] = [];
const reportSink = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    try {
      reports.push({ card: decodeURIComponent(String(req.url).split("/").pop() ?? ""), body: JSON.parse(body) });
    } catch {}
    res.statusCode = 204;
    res.end();
  });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (s: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${s}`);
let failures = 0;
const check = (ok: boolean, what: string) => {
  if (!ok) failures++;
  say(`${ok ? "ok  " : "FAIL"} ${what}`);
};

/* A page that counts its own frames and the real clicks it receives. `/slow-*`
   answers after `?ms=`, and `/heavy` spends 40ms of every frame working — the
   shape of a WebGL scene being measured, busy and still turning. */
const pages = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}`);
  const name = url.pathname.slice(1) || "root";
  res.setHeader("content-type", "text/html");
  if (name.startsWith("slow")) {
    setTimeout(() => res.end(`<title>${name}</title><p>slow</p>`), Number(url.searchParams.get("ms") ?? 10000));
    return;
  }
  if (name.startsWith("loop")) {
    res.end(`<title>${name}</title><script>setTimeout(() => { for (;;) {} }, ${Number(url.searchParams.get("after") ?? 300)})</script>`);
    return;
  }
  if (name === "heavy") {
    res.end(`<title>heavy</title><script>
  window.frames_ = 0;
  const tick = () => { const t = performance.now(); while (performance.now() - t < 40) {} window.frames_++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
</script>`);
    return;
  }
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

  async #post(body: unknown, ms = 45_000): Promise<any> {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (this.session) headers["mcp-session-id"] = this.session;
    const r = await fetch(`http://${HOST}:${MCP_PORT}/mcp/${this.card}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
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

  call(name: string, args: Record<string, unknown> = {}, ms?: number) {
    return this.#post({ jsonrpc: "2.0", id: this.#next++, method: "tools/call", params: { name, arguments: args } }, ms);
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

/** The host as Volery runs it, and again after `stopHost` — the restart is
 *  the one moment the host's connect attaches to every tab in the browser. */
async function startHost() {
  host = spawn("node", ["src-tauri/src/browserhost.cjs", "--port", String(MCP_PORT), "--cdp-endpoint", `http://${HOST}:${CHROME_PORT}`, "--vault", VAULT, "--grace-ms", String(GRACE), "--report", `http://${HOST}:${REPORT_PORT}/browser/stalled/`], { env: { ...process.env, VOLERY_PLAYWRIGHT_CORE: findCore() }, stdio: ["ignore", "ignore", "pipe"] });
  host.stderr!.on("data", (d) => process.stdout.write(`        host| ${d}`));
  await waitFor(`http://${HOST}:${MCP_PORT}/volery/tabs`, 15000);
}

async function stopHost() {
  if (host?.pid) spawn("taskkill", ["/PID", String(host.pid), "/T", "/F"], { stdio: "ignore" });
  host = undefined;
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    try {
      await fetch(`http://${HOST}:${MCP_PORT}/volery/tabs`, { signal: AbortSignal.timeout(300) });
    } catch {
      return;
    }
    await sleep(200);
  }
}

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
  pages.listen(PAGE_PORT, HOST);
  reportSink.listen(REPORT_PORT, HOST);
  chrome = spawn(findChrome(), [`--remote-debugging-port=${CHROME_PORT}`, `--user-data-dir=${path.join(SCRATCH, "profile")}`, "--no-first-run", "--no-default-browser-check", "--no-startup-window", ...(process.env.CHROME_FLAGS ?? "--disable-backgrounding-occluded-windows").split(" ").filter(Boolean)], { stdio: "ignore" });
  await waitFor(`http://${HOST}:${CHROME_PORT}/json/version`, 15000);
  /* Volery's first page, and its window parked the way `park_windows` does. */
  const first = await (await fetch(`http://${HOST}:${CHROME_PORT}/json/new?about:blank`, { method: "PUT" })).json();
  if (!process.env.NOPARK) await parkWindowOf(first.id);
  say(`chrome up; first page ${first.id.slice(0, 8)} parked`);

  /* A vault holding one sign-in, the way a save leaves it. */
  fs.writeFileSync(
    VAULT,
    JSON.stringify({
      cookies: [{ name: "seeded", value: "yes", domain: HOST, path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }],
      origins: [{ origin: `http://${HOST}:${PAGE_PORT}`, localStorage: [{ name: "seeded", value: "yes" }] }],
    }),
  );
  await startHost();

  if (process.argv.includes("live-stall")) return liveStall();
  if (process.argv.includes("live")) return live();
  if (process.argv.includes("stall")) return stall();

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

  // S, I
  const stateOf = async (c: Client) =>
    result(await c.call("browser_run_code_unsafe", { code: `async (page) => page.evaluate(() => ({ cookie: document.cookie, seeded: localStorage.getItem("seeded"), theme: localStorage.getItem("theme") }))` }));
  const a0 = await stateOf(A);
  check(/seeded=yes/.test(a0?.cookie ?? "") && a0?.seeded === "yes", `S. A started with the vault's cookie and storage: ${JSON.stringify(a0)}`);
  await A.call("browser_run_code_unsafe", { code: `async (page) => page.evaluate(() => { document.cookie = "mine=a; path=/"; localStorage.setItem("theme", "dark"); })` });
  const b0 = await stateOf(B);
  check(!/mine=a/.test(b0?.cookie ?? "") && b0?.theme === null && b0?.seeded === "yes", `I. B on the same origin sees none of what A wrote: ${JSON.stringify(b0)}`);
  await B.call("browser_run_code_unsafe", { code: `async (page) => page.evaluate(() => { document.cookie = "signedin=b; path=/"; })` });

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

  // F: frames. A `target=_blank` popup is a tab in its opener's window, which
  // Chrome draws only in front — the card is told on its next call. A page a
  // script opens with `page.context().newPage()` gets a window of its own
  // (it was a tab in front of the measured page until 2026-10-27).
  const told = text(await A.call("browser_evaluate", { function: "() => 1" }));
  check(/### Frames\nThis page shares its Chrome window with one other tab/.test(told), "F. a page sharing its window with a popup tab is told so");
  const quiet = text(await A.call("browser_click", { element: "button", target: "#b" }));
  check(!quiet.includes("### Frames"), "F. ...once on an ordinary call, not every time");
  await A.call("browser_run_code_unsafe", { code: `async (page) => { const p = await page.context().newPage(); await p.goto("http://${HOST}:${PAGE_PORT}/sheet"); }` });
  const aPages = (await cdpList()).filter((t: any) => /\/(a|popup-of-a|sheet)$/.test(t.url));
  const sheet = aPages.find((t: any) => t.url.endsWith("/sheet"));
  const others = aPages.filter((t: any) => t !== sheet);
  const sheetWin = sheet ? (await windowOf(sheet.id)).windowId : -1;
  let shared = 0;
  for (const t of others) if ((await windowOf(t.id)).windowId === sheetWin) shared++;
  check(!!sheet && shared === 0, `F. a page opened with page.context().newPage() has a window of its own (sharing with ${shared})`);
  await A.call("browser_run_code_unsafe", { code: `async (page) => { for (const p of page.context().pages()) if (p.url().endsWith("/sheet")) await p.close(); }` });

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
  const v1 = JSON.parse(fs.readFileSync(VAULT, "utf8"));
  check(v1.cookies.some((c: any) => c.name === "mine" && c.value === "a"), "5. ...and what A held was saved into the vault first");

  // 6
  const rel = await (await fetch(`http://${HOST}:${MCP_PORT}/volery/release/cardB`, { method: "POST" })).json();
  const after = await cdpList();
  check(rel.closed === 2 && after.length === 1, `6. release closed B's two tabs at once (${rel.closed}); left: ${after.length}`);
  const v2 = JSON.parse(fs.readFileSync(VAULT, "utf8"));
  check(v2.cookies.some((c: any) => c.name === "signedin" && c.value === "b"), "6. ...and B's sign-in was saved into the vault");
  const owners = await (await fetch(`http://${HOST}:${MCP_PORT}/volery/tabs`)).json();
  check(Object.keys(owners.cards).length === 0, "6. no card holds a context now");

  // V
  const C = new Client("cardC");
  await C.init();
  await C.call("browser_navigate", { url: `http://${HOST}:${PAGE_PORT}/c` });
  const c0 = await stateOf(C);
  check(/signedin=b/.test(c0?.cookie ?? "") && /seeded=yes/.test(c0?.cookie ?? ""), `V. a card started after B was saved has B's sign-in: ${JSON.stringify(c0)}`);
  const saved = await (await fetch(`http://${HOST}:${MCP_PORT}/volery/save`, { method: "POST" })).json();
  check(saved.ok && saved.state.cookies.some((c: any) => c.name === "signedin"), `V. the save button answers with the merged vault (${saved.state?.cookies?.length} cookies)`);
}

/* ── stall: what one stuck tab does, and to whom ──────────────────────────
 *
 *   bun tools/probe-card-tabs.ts stall
 *
 * Measurement, not a pass/fail arm: every row is a timing and what came back.
 * Since each card became a context of its own the host connects once; what a
 * tab that stops answering does *after* that connect had never been measured
 * (sinks e5452945, e5776153). Five parts:
 *
 *   1. a page in card A loops by itself, A's other tab on another site:
 *      card B's calls, a new card C's first call, A's own calls, A's release
 *   2. an alert() left open in card D, on a tab that is not D's current one
 *   3. the things that are long by design — a page working hard, a long
 *      synchronous evaluate the agent started, browser_wait_for, a slow
 *      navigation, a page paused in a debugger — and what a raw look sees
 *   4. the host restarted with a stuck tab in the browser's own context:
 *      the one connect everybody shares
 *   5. whether a client that hides a target from itself — detaching from one
 *      Chrome paused for it — lets that page run, which is what a host that
 *      only attaches to its own contexts would rest on
 */

type Look = { enable: boolean; eval: boolean; turn: boolean; paused: boolean; dialog: string; ms: number; socket: boolean };

/** The three questions `browser::stalled_tabs` asks, over a socket of its
 *  own, plus `Debugger.enable` — which answers with `Debugger.paused` when the
 *  page is stopped at a breakpoint — when `debuggerToo`. */
function look(ws: string, budget = 2000, debuggerToo = false): Promise<Look> {
  return new Promise((resolve) => {
    const t = Date.now();
    const got = new Set<number>();
    let paused = false;
    let dialog = "";
    let socket = false;
    let sock: WebSocket;
    const done = () => {
      clearTimeout(timer);
      try {
        sock.close();
      } catch {}
      resolve({ enable: got.has(1), eval: got.has(2), turn: got.has(3), paused, dialog, ms: Date.now() - t, socket });
    };
    const timer = setTimeout(done, budget);
    sock = new WebSocket(ws);
    sock.onopen = () => {
      socket = true;
      sock.send(JSON.stringify({ id: 1, method: "Page.enable" }));
      sock.send(JSON.stringify({ id: 2, method: "Runtime.evaluate", params: { expression: "1", returnByValue: true } }));
      sock.send(JSON.stringify({ id: 3, method: "Runtime.evaluate", params: { expression: "new Promise(r => setTimeout(() => r(1), 0))", awaitPromise: true, returnByValue: true } }));
      if (debuggerToo) sock.send(JSON.stringify({ id: 4, method: "Debugger.enable" }));
    };
    sock.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.method === "Debugger.paused") paused = true;
      if (msg.method === "Page.javascriptDialogOpening") dialog = msg.params.message;
      if (msg.id) got.add(msg.id);
      if (got.has(1) && got.has(2) && got.has(3) && (!debuggerToo || got.has(4))) done();
    };
    sock.onerror = () => done();
  });
}

const showLook = (l: Look) =>
  !l.socket ? "no socket" : `enable=${+l.enable} eval=${+l.eval} turn=${+l.turn}${l.paused ? " PAUSED" : ""}${l.dialog ? ` dialog="${l.dialog}"` : ""} in ${l.ms}ms`;

async function lookAt(label: string, urlEnd: string, debuggerToo = false) {
  const t = (await cdpList()).find((x: any) => x.url.endsWith(urlEnd));
  if (!t) return say(`   look ${label.padEnd(40)} (no such tab)`);
  say(`   look ${label.padEnd(40)} ${showLook(await look(t.webSocketDebuggerUrl, 2000, debuggerToo))}`);
}

const firstLines = (r: any) => {
  const t = text(r).split("\n").filter((l) => l.trim() && !l.startsWith("```"));
  return (r?.result?.isError ? "isError: " : "") + t.slice(0, 2).join(" / ").slice(0, 150);
};

type Timed = { ms: number; out: string; text: string; hung: boolean; error: boolean };

async function timed(label: string, p: Promise<any>, cap: number): Promise<Timed> {
  const t = Date.now();
  let out: string;
  let full = "";
  let hung = false;
  let error = false;
  try {
    const r = await Promise.race([p, sleep(cap).then(() => "__cap")]);
    hung = r === "__cap";
    full = hung ? "" : text(r);
    error = !hung && !!r?.result?.isError;
    out = hung ? `HUNG (still running at ${cap / 1000}s)` : firstLines(r);
  } catch (e: any) {
    error = true;
    out = `THREW ${String(e?.message ?? e).split("\n")[0]}`;
  }
  const ms = Date.now() - t;
  say(`   ${label.padEnd(45)} ${String(ms).padStart(6)}ms  ${out}`);
  return { ms, out, text: full, hung, error };
}

async function stall() {
  const P = (n: string, host = HOST) => `http://${host}:${PAGE_PORT}/${n}`;
  const CAP = 15_000;
  const code = (body: string) => ({ code: `async (page) => { ${body} }` });
  /* `stall 3 6` runs only those parts. */
  const parts = process.argv.slice(process.argv.indexOf("stall") + 1).map(Number).filter(Boolean);
  const want = (n: number) => parts.length === 0 || parts.includes(n);
  const B = new Client("stallB");
  await B.init();
  await B.call("browser_navigate", { url: P("b") });

  if (want(1)) {
    say("── 1. a page in card A loops by itself");
    const A = new Client("stallA");
    await A.init();
    await A.call("browser_navigate", { url: P("a") });
    await A.call("browser_tabs", { action: "new" });
    await A.call("browser_navigate", { url: P("a2", "localhost") });
    await timed("baseline: A snapshot (a2, current)", A.call("browser_snapshot"), CAP);
    await timed("baseline: B snapshot", B.call("browser_snapshot"), CAP);
    /* Armed from a call that returns at once, so the loop is the page's own
       doing by the time anything is asked of it — not an agent's call. Its
       own reply then lists /a, frozen 300ms in: before the title deadline,
       that reply hung on it (measured, 15s and counting). */
    const armed = await timed(
      "A arms a loop in its /a, 300ms later",
      A.call("browser_run_code_unsafe", code(`const p = page.context().pages().find((p) => p.url().endsWith("/a")); await p.evaluate(() => setTimeout(() => { for (;;) {} }, 300)); return "armed";`), 60_000),
      CAP,
    );
    check(!armed.hung && armed.ms < 5000, `1. the reply that froze a tab of its own still came back (${armed.ms}ms)`);
    await sleep(1500);
    await lookAt("A /a (looping)", "/a");
    await lookAt("A /a2 (other site, same card)", "/a2");
    await lookAt("B /b", "/b");
    for (const [label, call] of [
      ["B navigate", () => B.call("browser_navigate", { url: P("b-2") })],
      ["B snapshot", () => B.call("browser_snapshot")],
      ["B tabs list", () => B.call("browser_tabs", { action: "list" })],
      ["B evaluate", () => B.call("browser_evaluate", { function: "() => 1 + 1" })],
      ["B run_code", () => B.call("browser_run_code_unsafe", code(`return page.url();`))],
    ] as const) {
      const t = await timed(label, call(), CAP);
      check(!t.hung && !t.error && t.ms < 5000, `1. ${label} beside A's frozen tab (${t.ms}ms)`);
    }
    const C = new Client("stallC");
    await C.init();
    const c = await timed("C (new card) first navigate", C.call("browser_navigate", { url: P("c") }), CAP);
    check(!c.hung && !c.error && c.ms < 8000, `1. a new card's first call beside A's frozen tab (${c.ms}ms)`);

    const snap = await timed("A snapshot (current a2 healthy)", A.call("browser_snapshot", {}, 60_000), CAP);
    check(!snap.hung && !snap.error && snap.ms < 5000, `1. A's call on its healthy tab came back (${snap.ms}ms)`);
    check(snap.text.includes(`(not answering)](${P("a")})`), "1. ...and its tab list says the frozen tab is not answering");
    for (const [label, call] of [
      ["A tabs list", () => A.call("browser_tabs", { action: "list" }, 60_000)],
      ["A evaluate on a2", () => A.call("browser_evaluate", { function: "() => 1 + 1" }, 60_000)],
      ["A navigate a2 elsewhere", () => A.call("browser_navigate", { url: P("a3", "localhost") }, 60_000)],
    ] as const) {
      const t = await timed(label, call(), CAP);
      check(!t.hung && t.ms < 5000, `1. ${label} (${t.ms}ms)`);
    }
    /* Bounded by Playwright's own 5s on listing the page's WebMCP tools,
       which a frozen page never answers. */
    const sel = await timed("A tabs select 0 (the looping one)", A.call("browser_tabs", { action: "select", index: 0 }, 60_000), CAP);
    check(!sel.hung && sel.ms < 10_000, `1. selecting the frozen tab comes back (${sel.ms}ms)`);
    const onIt = await timed("A snapshot on the looping one", A.call("browser_snapshot", {}, 60_000), 30_000);
    check(onIt.error && /stopped answering|still not answering/.test(onIt.text) && onIt.ms < 20_000, `1. A's call on its frozen tab is ended with the sentence (${onIt.ms}ms)`);
    check(/index 0/.test(onIt.text) && /another host/.test(onIt.text) && /did nothing to the tab/.test(onIt.text), "1. ...which names the tab and both ways out");
    const again = await timed("A snapshot on it again", A.call("browser_snapshot", {}, 60_000), 30_000);
    check(again.error && /still not answering/.test(again.text) && again.ms < 6000, `1. ...and the next call on it is told at once (${again.ms}ms)`);
    /* Lyss: never cut off the agent's own script. */
    const own = timed("A evaluate on the looping one", A.call("browser_evaluate", { function: "() => 1 + 1" }, 60_000), 20_000);
    const ownT = await own;
    check(ownT.hung, "1. A's own evaluate on the frozen tab is never cut off");
    const closed = await timed("A tabs close 0 (the looping one)", A.call("browser_tabs", { action: "close", index: 0 }, 60_000), CAP);
    check(!closed.hung && closed.ms < 5000, `1. closing the frozen tab works (${closed.ms}ms)`);
    await sleep(500);
    const after = await timed("A snapshot after the close", A.call("browser_snapshot", {}, 60_000), CAP);
    check(!after.hung && !after.error, "1. ...and A is free");
    const mine = reports.filter((r) => r.card === "stallA");
    say(`   reports for A: ${JSON.stringify(mine.map((r) => r.body))}`);
    check(mine.length === 1 && mine[0].body.url.endsWith("/a") && ["call", "list"].includes(mine[0].body.via), "1. the wall was told once, about the right tab");
    check(!reports.some((r) => r.card === "stallB" || r.card === "stallC"), "1. ...and about no other card");

    say("── 1b. A released while a tab of its still loops");
    await A.call("browser_tabs", { action: "new" }, 30_000).catch(() => {});
    await A.call("browser_navigate", { url: P("a4") }, 30_000).catch(() => {});
    await A.call("browser_run_code_unsafe", code(`await page.evaluate(() => setTimeout(() => { for (;;) {} }, 300)); return "armed";`), 30_000).catch(() => {});
    await sleep(1500);
    await lookAt("A /a4 (looping)", "/a4");
    const rel = await timed(
      "release A",
      fetch(`http://${HOST}:${MCP_PORT}/volery/release/stallA`, { method: "POST" })
        .then((r) => r.json())
        .then((j) => ({ result: { content: [{ type: "text", text: JSON.stringify(j) }] } })),
      30_000,
    );
    await sleep(1000);
    const left = (await cdpList()).filter((t: any) => /\/a\d?$/.test(t.url)).length;
    check(!rel.hung && rel.ms < 15_000 && left === 0, `1b. a card released with a frozen tab closes in bounded time (${rel.ms}ms, ${left} left)`);
  }
  if (want(1)) {
    /* The watch itself, with nothing known beforehand: the tab freezes two
       seconds into a call that is waiting on it. */
    say("── 1c. a tab that freezes while a call waits on it");
    const H = new Client("stallH");
    await H.init();
    await H.call("browser_navigate", { url: P("loop-h?after=2500") });
    /* `wait_for` with text has its own 5s; with a time it waits in the host
       and then builds a reply that snapshots the tab, frozen by then. */
    const w = await timed("H wait_for 5s, its tab freezing at 2.5s", H.call("browser_wait_for", { time: 5 }, 90_000), 60_000);
    check(w.error && /stopped waiting on this call after \d+s/.test(w.text) && /may still happen/.test(w.text) && w.ms < 25_000, `1c. the watch ends a call its tab froze under, and says it may still land (${w.ms}ms)`);
    await fetch(`http://${HOST}:${MCP_PORT}/volery/release/stallH`, { method: "POST" });
    say("── 1d. the agent's own code returns and leaves its tab frozen");
    const K = new Client("stallK");
    await K.init();
    await K.call("browser_navigate", { url: P("k") });
    const k = await timed("K run_code arms a loop in its current tab", K.call("browser_run_code_unsafe", code(`await page.evaluate(() => setTimeout(() => { for (;;) {} }, 300)); return "armed-k";`), 90_000), 60_000);
    /* Its settle wait is a timer in the page, which the host's clock now ends;
       the reply carries no snapshot, and its tab list says why the tab is
       quiet. */
    check(!k.error && /armed-k/.test(k.text) && /\(not answering\)/.test(k.text) && k.ms < 10_000, `1d. its reply still comes back, with its result, the tab marked not answering (${k.ms}ms)`);
    await fetch(`http://${HOST}:${MCP_PORT}/volery/release/stallK`, { method: "POST" });
    say("── 1e. a popup that is slow to load its first page");
    const Q = new Client("stallQ");
    await Q.init();
    await Q.call("browser_navigate", { url: P("q") });
    await Q.call("browser_run_code_unsafe", code(`await page.evaluate(() => window.open("/slow-popup?ms=15000", "_blank")); return "opened";`), 30_000);
    await sleep(1000);
    const ql = await timed("Q tabs list while its popup loads", Q.call("browser_tabs", { action: "list" }, 60_000), 30_000);
    await sleep(9000);
    const ql2 = await timed("Q tabs list again", Q.call("browser_tabs", { action: "list" }, 60_000), 30_000);
    check(!ql.hung && !ql2.hung && !/not answering/.test(ql.text + ql2.text), "1e. a popup still loading is never marked not answering");
    check(!reports.some((r) => r.card === "stallQ"), "1e. ...nor reported");
    await fetch(`http://${HOST}:${MCP_PORT}/volery/release/stallQ`, { method: "POST" });
    say("── 1f. a long timed wait while the page is busy on purpose");
    const W = new Client("stallW");
    await W.init();
    await W.call("browser_navigate", { url: P("w") });
    /* Busy without yielding for 12s, then fine: a computation that finishes. */
    await W.call("browser_run_code_unsafe", code(`await page.evaluate(() => setTimeout(() => { const t = Date.now(); while (Date.now() - t < 12000) {} }, 2500)); return "armed";`), 30_000);
    const ww = await timed("W wait_for 16s beside it", W.call("browser_wait_for", { time: 16 }, 90_000), 60_000);
    check(!ww.error && /Waited/.test(ww.text), `1f. a timed wait is never cut short by a page that is busy on purpose (${ww.ms}ms)`);
    check(!reports.some((r) => r.card === "stallW"), "1f. ...nor reported");
    await fetch(`http://${HOST}:${MCP_PORT}/volery/release/stallW`, { method: "POST" });
  }
  if (want(2)) {
    say("── 2. an alert() left open in card D, on its non-current tab");
    const D = new Client("stallD");
    await D.init();
    await D.call("browser_navigate", { url: P("d") });
    await D.call("browser_tabs", { action: "new" });
    await D.call("browser_navigate", { url: P("d2", "localhost") });
    await D.call("browser_run_code_unsafe", code(`const p = page.context().pages().find((p) => p.url().endsWith("/d")); await p.evaluate(() => setTimeout(() => alert("PROBE-ALERT"), 300)); return "armed";`));
    await sleep(1500);
    await lookAt("D /d (alert open)", "/d");
    await timed("D snapshot (current d2)", D.call("browser_snapshot", {}, 60_000), CAP);
    await timed("D tabs select 0 (the alert)", D.call("browser_tabs", { action: "select", index: 0 }, 60_000), CAP);
    const modal = await timed("D snapshot on the alert tab", D.call("browser_snapshot", {}, 60_000), CAP);
    check(/modal state/.test(modal.text) && !/stopped answering/.test(modal.text), "2. a dialog is Playwright's modal state, never a stall");
    /* Long enough for a watch to have looked, had it wrongly been one. */
    const waited = await timed("D wait_for 10s on the alert tab", D.call("browser_wait_for", { time: 10 }, 60_000), 30_000);
    check(!/stopped answering/.test(waited.text), "2. ...even when a call on it runs past the watch");
    const ok = await timed("D handle_dialog accept", D.call("browser_handle_dialog", { accept: true }, 60_000), CAP);
    check(!ok.hung && !ok.error, "2. ...and handle_dialog clears it");
    check(!reports.some((r) => r.card === "stallD"), "2. no report for an open dialog");
    say("── 2b. a dialog in a same-site popup, holding its opener");
    const G2 = new Client("stallDp");
    await G2.init();
    await G2.call("browser_navigate", { url: P("dp") });
    await G2.call("browser_run_code_unsafe", code(`const w = await page.evaluate(() => { window.open("/dp-popup", "_blank"); return 1; }); await page.waitForTimeout(1500); const pop = page.context().pages().find((p) => p.url().endsWith("/dp-popup")); await pop.evaluate(() => setTimeout(() => alert("POPUP-ALERT"), 300)); return "armed";`), 30_000);
    await sleep(1500);
    await G2.call("browser_tabs", { action: "select", index: 0 }, 30_000).catch(() => {});
    const held = await timed("Dp snapshot of the opener", G2.call("browser_snapshot", {}, 60_000), 45_000);
    say(`   opener reads: ${held.text.split("\n")[0].slice(0, 160)}`);
    check(!held.hung && (/modal state/.test(held.text) || /has a dialog open/.test(held.text) || !held.error), "2b. the opener's call is not left hanging on its popup's dialog");
    check(!/stopped answering/.test(held.text), "2b. ...and the opener is not named as the stuck tab");
    await fetch(`http://${HOST}:${MCP_PORT}/volery/release/stallDp`, { method: "POST" });
  }
  if (want(3)) {
    say("── 3. long by design, and what a look sees meanwhile");
    const E = new Client("stallE");
    await E.init();
    await E.call("browser_navigate", { url: P("heavy") });
    await sleep(1000);
    await lookAt("E /heavy, 40ms of work a frame", "/heavy");
    const heavy = await timed("E wait_for 12s on a page working hard", E.call("browser_wait_for", { time: 12 }, 60_000), 30_000);
    check(!heavy.error && /Waited/.test(heavy.text), "3. a page working hard is never named");
    {
      const long = timed("E evaluate: 12s synchronous, its own", E.call("browser_evaluate", { function: "() => { const t = Date.now(); while (Date.now() - t < 12000) {} return 'done'; }" }, 60_000), 30_000);
      await sleep(2500);
      await lookAt("E /heavy during its own 12s evaluate", "/heavy");
      await timed("B snapshot meanwhile", B.call("browser_snapshot"), CAP);
      const l = await long;
      check(!l.error && /done/.test(l.text), `3. the agent's own 12s synchronous evaluate runs to its answer (${l.ms}ms)`);
    }
    await E.call("browser_navigate", { url: P("e") });
    {
      const nav = timed("E navigate to a page answering in 14s", E.call("browser_navigate", { url: P("slow-e?ms=14000") }, 60_000), 30_000);
      await sleep(2500);
      const t = (await cdpList()).find((x: any) => x.url.endsWith("/e") || x.url.includes("slow-e"));
      say(`   look ${`E mid-navigation (${t?.url.split("/").pop()})`.padEnd(40)} ${t ? showLook(await look(t.webSocketDebuggerUrl)) : "(no tab)"}`);
      const n = await nav;
      check(!n.error && n.ms >= 13_000, `3. a slow navigation silent to a look is never named (${n.ms}ms)`);
    }
    await E.call("browser_navigate", { url: P("heavy") });
    {
      /* A person with DevTools, or a debugger statement: paused by a client
         that is not the host, as one would be. */
      const t = (await cdpList()).find((x: any) => x.url.endsWith("/heavy"));
      const dbg = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r) => (dbg.onopen = r));
      let n = 1;
      const send = (method: string, params = {}) => dbg.send(JSON.stringify({ id: n++, method, params }));
      send("Debugger.enable");
      send("Debugger.pause");
      await sleep(800);
      await lookAt("E /heavy paused in a debugger", "/heavy");
      const paused = await timed("E snapshot while paused", E.call("browser_snapshot", {}, 60_000), 18_000);
      check(paused.hung, "3. a page paused in a debugger is never named");
      send("Debugger.resume");
      await sleep(300);
      dbg.close();
      await sleep(500);
      await lookAt("E /heavy resumed", "/heavy");
    }
    check(!reports.some((r) => r.card === "stallE"), "3. no report for anything long by design");
  }
  if (want(4)) {
    say("── 4. the host restarted, a stuck tab in the browser's own context");
    const made = await (await fetch(`http://${HOST}:${CHROME_PORT}/json/new?${encodeURIComponent("data:text/html,<title>default-loop</title><script>setTimeout(()=>{for(;;){}},100)</script>")}`, { method: "PUT" })).json();
    await sleep(800);
    say(`   look ${"default context, a page looping".padEnd(40)} ${showLook(await look(made.webSocketDebuggerUrl))}`);
    await stopHost();
    await startHost();
    const F = new Client("stallF");
    await F.init();
    const first = await timed("after restart, a card's first call", F.call("browser_navigate", { url: P("f") }, 60_000), 45_000);
    check(!first.hung && !first.error && first.ms < 8000, `4. a frozen tab outside the cards' contexts no longer holds the connect (${first.ms}ms; was 30s and a failure)`);
    const tabs = await timed("F tabs list", F.call("browser_tabs", { action: "list" }, 60_000), CAP);
    check(!/default-loop/.test(tabs.text), "4. ...and no card sees that tab");
    /* A page born in the browser's own context after the connect is paused
       for the filter, which must let it run. */
    const born = await (await fetch(`http://${HOST}:${CHROME_PORT}/json/new?${encodeURIComponent("data:text/html,<title>born</title><script>setTimeout(()=>document.title='born-ran',50)</script>")}`, { method: "PUT", signal: AbortSignal.timeout(8000) })).json();
    await sleep(1000);
    const now = (await cdpList()).find((x: any) => x.id === born.id);
    check(now?.title === "born-ran", `4. a page opened outside the cards' contexts after the connect still runs (${now?.title})`);
    await fetch(`http://${HOST}:${CHROME_PORT}/json/close/${made.id}`, { method: "PUT" });
    await fetch(`http://${HOST}:${CHROME_PORT}/json/close/${born.id}`, { method: "PUT" });
    /* The save button reads that context itself now. */
    const saved = await (await fetch(`http://${HOST}:${MCP_PORT}/volery/save`, { method: "POST" })).json();
    check(saved.ok === true, `4. the save button still answers (${saved.state?.cookies?.length} cookies)`);
    /* The storage of a page in the browser's own context is saved under the
       origin Chrome lists for it, read in an isolated world, whatever the
       page has redefined in its own. */
    const own = await (await fetch(`http://${HOST}:${CHROME_PORT}/json/new?${encodeURIComponent(P("own"))}`, { method: "PUT" })).json();
    await sleep(800);
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(own.webSocketDebuggerUrl);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "localStorage.setItem('mine', 'kept'); JSON.stringify = () => '[\"https://elsewhere.test\",[[\"k\",\"v\"]]]'; 1", returnByValue: true } }));
      ws.onmessage = () => (ws.close(), resolve());
    });
    const saved2 = await (await fetch(`http://${HOST}:${MCP_PORT}/volery/save`, { method: "POST" })).json();
    const origins = (saved2.state?.origins ?? []).map((o: any) => o.origin);
    check(origins.includes(`http://${HOST}:${PAGE_PORT}`) && !origins.includes("https://elsewhere.test"), `4. a page's storage is saved under its own origin and no other (${origins.join(", ")})`);
    check((saved2.state?.origins ?? []).some((o: any) => o.localStorage?.some((i: any) => i.name === "mine" && i.value === "kept")), "4. ...and what it holds is read all the same");
    await fetch(`http://${HOST}:${CHROME_PORT}/json/close/${own.id}`, { method: "PUT" });
  }
  if (want(5)) {
    say("── 5. a client that hides a target from itself");
    {
      const v = await (await fetch(`http://${HOST}:${CHROME_PORT}/json/version`)).json();
      for (const resume of [false, true]) {
        const ws = new WebSocket(v.webSocketDebuggerUrl);
        await new Promise((r) => (ws.onopen = r));
        let n = 1;
        ws.onmessage = (m) => {
          const msg = JSON.parse(String(m.data));
          if (msg.method !== "Target.attachedToTarget" || msg.sessionId) return;
          const { sessionId, waitingForDebugger, targetInfo } = msg.params;
          if (!String(targetInfo.title + targetInfo.url).includes("hidden-")) return;
          if (resume && waitingForDebugger) ws.send(JSON.stringify({ id: n++, method: "Runtime.runIfWaitingForDebugger", sessionId }));
          ws.send(JSON.stringify({ id: n++, method: "Target.detachFromTarget", params: { sessionId } }));
        };
        ws.send(JSON.stringify({ id: n++, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } }));
        await sleep(300);
        const tag = `hidden-${resume ? "resumed" : "detached"}`;
        const t0 = Date.now();
        const made = await fetch(`http://${HOST}:${CHROME_PORT}/json/new?${encodeURIComponent(`data:text/html,<title>${tag}</title><script>setTimeout(()=>document.title='${tag}-ran',50)</script>`)}`, { method: "PUT", signal: AbortSignal.timeout(8000) })
          .then((r) => r.json())
          .catch(() => null);
        const answered = Date.now() - t0;
        await sleep(1000);
        const now = (await cdpList()).find((x: any) => x.title.startsWith(tag));
        say(`   ${resume ? "resume, then detach" : "detach only        "}  /json/new ${made ? `answered in ${answered}ms` : "DID NOT ANSWER"}; title ${JSON.stringify(now?.title)}${now ? `; ${showLook(await look(now.webSocketDebuggerUrl))}` : ""}`);
        ws.close();
        if (now) await fetch(`http://${HOST}:${CHROME_PORT}/json/close/${now.id}`, { method: "PUT" });
      }
    }
  }
  if (want(6)) {
    say("── 6. what still reaches a frozen tab");
    const raw = (ws: string, method: string, params = {}, budget = 3000) =>
      new Promise<string>((resolve) => {
        const t = Date.now();
        const s = new WebSocket(ws);
        const timer = setTimeout(() => (s.close(), resolve(`no answer in ${budget}ms`)), budget);
        s.onopen = () => s.send(JSON.stringify({ id: 1, method, params }));
        s.onmessage = (m) => {
          const msg = JSON.parse(String(m.data));
          if (msg.id !== 1) return;
          clearTimeout(timer);
          s.close();
          resolve(`${msg.error ? `error ${msg.error.message}` : "answered"} in ${Date.now() - t}ms`);
        };
        s.onerror = () => (clearTimeout(timer), resolve("socket error"));
      });
    /* A tab of its own for each remedy, looping by itself 300ms after it
       loads, so one remedy's leftovers cannot be the next one's result. */
    const frozen = async (name: string) => {
      const made = await (await fetch(`http://${HOST}:${CHROME_PORT}/json/new?${encodeURIComponent(P(`loop-${name}`))}`, { method: "PUT" })).json();
      await sleep(1500);
      say(`   ${`${name}: frozen`.padEnd(42)} ${showLook(await look(made.webSocketDebuggerUrl))}`);
      return made as { id: string; webSocketDebuggerUrl: string };
    };
    const after = async (label: string, t: { id: string }) => {
      await sleep(1500);
      const now = (await cdpList()).find((x: any) => x.id === t.id);
      say(`   ${label.padEnd(42)} ${now ? `${now.url.replace(`http://`, "").slice(0, 40)}: ${showLook(await look(now.webSocketDebuggerUrl))}` : "the tab is gone"}`);
      if (now) await fetch(`http://${HOST}:${CHROME_PORT}/json/close/${t.id}`, { method: "PUT" });
    };
    let t = await frozen("terminate");
    say(`   ${"Runtime.terminateExecution, alone".padEnd(42)} ${await raw(t.webSocketDebuggerUrl, "Runtime.terminateExecution")}`);
    await after("after it", t);
    t = await frozen("shot");
    say(`   ${"Page.captureScreenshot".padEnd(42)} ${await raw(t.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "jpeg", quality: 30 })}`);
    await after("after it", t);
    t = await frozen("samesite");
    say(`   ${"Page.navigate, same site".padEnd(42)} ${await raw(t.webSocketDebuggerUrl, "Page.navigate", { url: P("landed") }, 8000)}`);
    await after("after it", t);
    t = await frozen("othersite");
    say(`   ${"Page.navigate, another site".padEnd(42)} ${await raw(t.webSocketDebuggerUrl, "Page.navigate", { url: P("landed", "localhost") }, 8000)}`);
    await after("after it", t);
    t = await frozen("reload");
    say(`   ${"Page.reload".padEnd(42)} ${await raw(t.webSocketDebuggerUrl, "Page.reload", {}, 8000)}`);
    await after("after it", t);
    t = await frozen("close");
    const closed = await fetch(`http://${HOST}:${CHROME_PORT}/json/close/${t.id}`, { method: "PUT" });
    say(`   ${"/json/close".padEnd(42)} ${closed.status}`);
    await after("after it", t);
    /* And through a card: its only tab frozen 3s after it loads, so the
       navigate that took it there has answered first. */
    for (const [what, url] of [
      ["same site", P("landed")],
      ["another site", P("landed", "localhost")],
    ]) {
      const G = new Client(`stallG${what.length}`);
      await G.init();
      await G.call("browser_navigate", { url: P(`loop-g?after=3000`) });
      await sleep(4000);
      await lookAt(`card G's only tab, frozen`, "loop-g?after=3000");
      await timed(`G browser_navigate, ${what}`, G.call("browser_navigate", { url }, 60_000), 30_000);
      await timed(`G snapshot after`, G.call("browser_snapshot", {}, 60_000), 15_000);
      await fetch(`http://${HOST}:${MCP_PORT}/volery/release/${`stallG${what.length}`}`, { method: "POST" });
    }
  }
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
  say(`   contexts: ${JSON.stringify(owners)}`);

  /* The CLI exited on its own here; a card Volery kills is the harder case,
     and the heartbeat is what has to notice either. */
  await sleep(GRACE + 20000);
  const after = await cdpList();
  check(after.length === 1, `live: with both cards gone, the heartbeat and the grace closed their tabs (${after.length} left)`);
}

/* ── live-stall: a real card whose tab freezes under it ──────────────── */

async function liveStall() {
  const page = (n: string, host = HOST) => `http://${host}:${PAGE_PORT}/${n}`;
  const t = Date.now();
  const said = await card(
    "liveStall",
    `Use only the mcp__probebrowser__ tools. 1) browser_navigate to ${page("loop-live?after=2500")}. 2) browser_wait_for with time 5. ` +
      `3) If step 2 failed, do whatever its error message says frees you, then call browser_tabs with action list. ` +
      `Then reply with ONLY three lines: line 1 the first sentence of step 2's error (or "no error"), line 2 the tool call you made in step 3, line 3 the URLs from the tab list separated by spaces.`,
  );
  say(`   the card said (${((Date.now() - t) / 1000).toFixed(0)}s): ${said.replace(/\n/g, " / ")}`);
  check(/stopped answering/.test(said), "live-stall: a real card is handed the sentence");
  check(!/loop-live/.test(said.split("\n").slice(2).join(" ")), "live-stall: ...acts on it, and its frozen tab is gone from its list");
  check(Date.now() - t < 120_000, "live-stall: ...in well under the five minutes it used to cost");
  check(reports.some((r) => r.card === "liveStall"), "live-stall: ...and the wall was told");
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
    reportSink.close();
    await sleep(1500);
    try {
      fs.rmSync(SCRATCH, { recursive: true, force: true });
    } catch {}
    say(failures ? `${failures} FAILED` : "all passed");
    process.exit(failures ? 1 : 0);
  });
