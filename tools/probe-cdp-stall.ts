/* What makes `@playwright/mcp` hang in `initializeServer` against a Chrome
 * that is otherwise fine — and can a plain CDP client name the culprit?
 *
 * Sink e7431978. Every `mcp__browser__*` call failed after 30s with
 * `TimeoutError: async initializeServer: Timeout 30000ms exceeded`, the trace
 * ending at `<ws connected>`. Reading playwright-core 1.64's `CRBrowser.connect`
 * says why that shape is possible: after the browser socket opens it
 * auto-attaches to every target and then `_waitForAllPagesToBeInitialized` —
 * so **one** page that never finishes initialising holds the whole connect,
 * for every card, until that page goes. Reading is not measuring, so this
 * builds the suspects one at a time and asks two things of each:
 *
 *   1. does `chromium.connectOverCDP` actually stall on it?
 *   2. does the check `hooks::diagnose_browser` makes — each target's own
 *      socket, `Page.enable` then `Runtime.evaluate("1")` under a short budget —
 *      tell it apart from a healthy page, and does `Page.enable` re-announce a
 *      dialog that was already open (which would let it say *dialog* rather
 *      than *not answering*)?
 *
 * Arms: a healthy page; an `alert()` left open; a renderer stuck in a loop;
 * and a page created while another CDP client holds `waitForDebuggerOnStart`
 * and never lets go (a stuck test script, which the Nova card was running
 * beside the shared browser that night).
 *
 *   node --experimental-strip-types tools/probe-cdp-stall.ts
 *
 * NODE, not bun, for the reason `probe-browser.ts` gives — and not under
 * coreutils' `timeout` either, which on this machine ended the run partway with
 * no output and exit 0, three times. No API turn. One headless Chrome per arm,
 * on its own profile and **port 19222** — never the wall's 9222.
 *
 * ── what it returned, 2026-10-01, Chrome 154, playwright-core 1.64 ─────────
 *
 * ```text
 * healthy page            diagnose ok      playwright connected in 202ms
 * alert() left open       diagnose STUCK   playwright FAILED after 8032ms
 *                         closed 200       playwright connected in 123ms (after the close)
 * renderer in a loop      diagnose STUCK   playwright FAILED after 8030ms
 *                         closed 200       playwright connected in 917ms (after the close)
 * held by a stuck client  diagnose ok      playwright connected in 96ms
 * ```
 *
 * Repeated across four runs. So: a dialog or a hung page **does** hold the
 * connect of every client, the check names it, and `/json/close` on that one
 * tab is the remedy — it works while the tab is stuck. The stuck-debugger
 * theory is out. On a stuck tab a fresh session gets no answer even to
 * `Page.enable`, and is not re-told about the open dialog, so a dialog cannot
 * be told apart from a hang from outside.
 *
 * Two things found along the way. **`evaluate("1")` alone is not the check**:
 * an early run had it answer for the loop page, which is why the third request
 * asks the event loop to turn. And **this machine's Chrome policy opens two
 * corporate SSO pages in every Chrome** (`RestoreOnStartupURLs`: Reach and the
 * Confluence wiki, which redirects to an Atlassian login), the wall's shared
 * browser included. Mid-redirect they can miss a 3s window, and once the
 * Atlassian login stalled the *healthy* arm's connect outright — so the arms
 * close them, and the hook asks a silent tab twice before naming it.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HOST = "127.0.0.1";
const PORT = 19222;
const CARD = process.env.SKEIN_CARD ?? "probe";
/* A directory per run: Windows can refuse to delete a profile Chrome has only
   just let go of, and a run that cannot start over the last one's leftovers
   measures nothing. */
const SCRATCH = path.join(process.cwd(), `.scratch-${CARD}`, `cdp-stall-${Date.now()}`);
fs.mkdirSync(SCRATCH, { recursive: true });

function findChrome(): string {
  const roots = ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"]
    .map((v) => process.env[v])
    .filter(Boolean)
    .map((b) => path.join(b!, "Google/Chrome/Application/chrome.exe"));
  for (const p of roots) if (fs.existsSync(p)) return p;
  throw new Error("no Chrome found");
}

/** The playwright-core `@playwright/mcp` itself resolves, out of npx's cache —
 *  the version that hung is the version worth measuring. */
function findPlaywrightCore(): string {
  if (process.env.PLAYWRIGHT_CORE) return process.env.PLAYWRIGHT_CORE;
  const npx = path.join(process.env.LOCALAPPDATA ?? "", "npm-cache", "_npx");
  for (const h of fs.readdirSync(npx)) {
    const mcp = path.join(npx, h, "node_modules", "@playwright", "mcp");
    const core = path.join(npx, h, "node_modules", "playwright-core", "index.js");
    if (fs.existsSync(mcp) && fs.existsSync(core)) return core;
  }
  throw new Error("no @playwright/mcp in the npx cache; set PLAYWRIGHT_CORE");
}

/* A probe that dies says why — a bare exit code 1 cost two runs here. */
process.on("exit", (c) => console.log(`(exit ${c})`));
process.on("unhandledRejection", (e) => {
  console.log("unhandled:", e);
  process.exit(1);
});

const core = findPlaywrightCore();
const { chromium } = await import(`file:///${core.replace(/\\/g, "/")}`).then((m: any) => m.default ?? m);
console.log(`playwright-core: ${core}\n`);

let chrome: ChildProcess | null = null;

async function startChrome() {
  const profile = path.join(SCRATCH, `profile-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });
  chrome = spawn(
    findChrome(),
    [
      `--remote-debugging-port=${PORT}`,
      `--remote-debugging-address=${HOST}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--headless=new",
      "--window-size=1280,800",
    ],
    { stdio: "ignore" },
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://${HOST}:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl as string;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("chrome did not open its port");
}

async function stopChrome() {
  /* The whole tree: `kill()` is one process of a dozen, and a renderer left
     behind holds the profile and, now and then, the next arm's start. */
  if (chrome?.pid) spawnSync("taskkill", ["/F", "/T", "/PID", String(chrome.pid)], { stdio: "ignore" });
  chrome = null;
  /* Chrome is a dozen processes and the port outlives the handle — the same
     wait `browser::await_port_closed` makes. */
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://${HOST}:${PORT}/json/version`);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function newPage(url: string) {
  const r = await fetch(`http://${HOST}:${PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  return (await r.json()) as { id: string; webSocketDebuggerUrl: string };
}

/** Exactly the check the hook makes, in TypeScript, so its verdict here is the
 *  verdict there. */
async function diagnose(budgetMs = 3000) {
  const list = (await (await fetch(`http://${HOST}:${PORT}/json/list`)).json()) as any[];
  return Promise.all(
    list
      .filter((t) => t.type === "page" || t.type === "iframe")
      .map(
        (t) =>
          new Promise<{ id: string; url: string; verdict: string }>((resolve) => {
            const ws = new WebSocket(t.webSocketDebuggerUrl);
            let dialog = "";
            const done = (verdict: string) => {
              clearTimeout(timer);
              try {
                ws.close();
              } catch {}
              resolve({ id: t.id, url: String(t.url).slice(0, 60), verdict });
            };
            const got = new Set<number>();
            const timer = setTimeout(
              () =>
                done(
                  `${dialog ? `DIALOG (${dialog}) ` : ""}STUCK enable=${got.has(1)} eval=${got.has(2)} turn=${got.has(3)}`,
                ),
              budgetMs,
            );
            ws.onopen = () => {
              ws.send(JSON.stringify({ id: 1, method: "Page.enable" }));
              ws.send(JSON.stringify({ id: 2, method: "Runtime.evaluate", params: { expression: "1", returnByValue: true } }));
              /* Whether the page's event loop turns, which `evaluate("1")`
                 does not ask: V8 serves an inspector evaluate on an interrupt,
                 mid-loop. A promise only a timer can resolve needs the loop. */
              ws.send(
                JSON.stringify({
                  id: 3,
                  method: "Runtime.evaluate",
                  params: { expression: "new Promise(r => setTimeout(() => r(1), 0))", awaitPromise: true, returnByValue: true },
                }),
              );
            };
            ws.onmessage = (m) => {
              const msg = JSON.parse(String(m.data));
              if (msg.method === "Page.javascriptDialogOpening") {
                dialog = `${msg.params.type}: ${msg.params.message}`;
              }
              if (msg.id) got.add(msg.id);
              if (got.has(1) && got.has(2) && got.has(3)) done(dialog ? `answered, but DIALOG (${dialog})` : "ok");
            };
            ws.onerror = () => done("socket error");
          }),
      ),
  );
}

async function connectTime(timeout = 8000) {
  const t0 = Date.now();
  try {
    const b = await chromium.connectOverCDP(`http://${HOST}:${PORT}`, { timeout });
    const ms = Date.now() - t0;
    await b.close().catch(() => {});
    return `connected in ${ms}ms`;
  } catch (e: any) {
    return `FAILED after ${Date.now() - t0}ms: ${String(e.message).split("\n")[0]}`;
  }
}

async function arm(name: string, setup: (browserWs: string) => Promise<void>) {
  console.log(`── ${name}`);
  const browserWs = await startChrome();
  try {
    await setup(browserWs);
    /* This machine's Chrome policy (`RestoreOnStartupURLs`) opens two
       corporate SSO pages in *every* Chrome, this one included, and their
       redirects make any arm noisy — one of them stalled the healthy arm's
       connect outright. So they go once the arm's own page exists (closing
       them first leaves a headless Chrome with no page, and it quits). They
       are left in the wall's browser, and that is the finding to keep. */
    await new Promise((r) => setTimeout(r, 1500));
    const opened = (await (await fetch(`http://${HOST}:${PORT}/json/list`)).json()) as any[];
    for (const t of opened.filter((t) => t.type === "page" && !String(t.url).startsWith("data:"))) {
      await fetch(`http://${HOST}:${PORT}/json/close/${t.id}`, { method: "PUT" });
    }
    /* Long enough that the startup pages a machine policy opens have loaded
       and the arm's own script has fired — a check run before the alert is
       up measures a healthy page, and did once. */
    await new Promise((r) => setTimeout(r, 3000));
    const found = await diagnose();
    for (const d of found) console.log(`   diagnose  ${d.verdict.padEnd(28)} ${d.url}`);
    console.log(`   playwright ${await connectTime()}`);
    /* The remedy the hook offers, tried: does closing the stuck tab over plain
       HTTP work while it is stuck, and does that free the connect? */
    const stuck = found.filter((d) => d.verdict.includes("STUCK"));
    if (stuck.length) {
      for (const d of stuck) {
        const r = await fetch(`http://${HOST}:${PORT}/json/close/${d.id}`, { method: "PUT" });
        console.log(`   closed    ${r.status} ${(await r.text()).trim()}`);
      }
      /* "Target is closing" is an acknowledgement, not a completion. */
      await new Promise((r) => setTimeout(r, 1500));
      console.log(`   playwright ${await connectTime()}  (after the close)`);
    }
  } finally {
    await stopChrome();
  }
  console.log();
}

const html = (s: string) => `data:text/html,${s}`;

await arm("healthy page", async () => {
  await newPage(html("<p>fine</p>"));
});

await arm("alert() left open", async () => {
  await newPage(html("<script>setTimeout(()=>alert('PROBE-ALERT'),50)</script>"));
});

await arm("renderer stuck in a loop", async () => {
  await newPage(html("<script>setTimeout(()=>{for(;;){}},50)</script>"));
});

let holder: WebSocket | null = null;
await arm("page born under a client that never releases waitForDebuggerOnStart", async (browserWs) => {
  holder = new WebSocket(browserWs);
  await new Promise((r) => (holder!.onopen = r));
  holder.send(
    JSON.stringify({
      id: 1,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
    }),
  );
  await new Promise((r) => setTimeout(r, 300));
  /* `Target.createTarget` over the holder, not `/json/new`: the HTTP route
     answers only once the page has started, and this one cannot start. */
  holder.send(JSON.stringify({ id: 2, method: "Target.createTarget", params: { url: html("<p>held</p>") } }));
  await new Promise((r) => setTimeout(r, 500));
});
holder?.close();

try {
  fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
} catch (e: any) {
  console.log(`(left ${SCRATCH} behind: ${e.code})`);
}
