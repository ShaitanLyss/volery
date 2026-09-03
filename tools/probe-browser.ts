/* What a browser actually costs, and whether two clients can share one.
 *
 * Every figure in `browser.rs`'s module comment and in `.claude/rules/browser.md`
 * came out of this. It is here rather than in `.scratch-` because the numbers
 * decide a design — whether Volery should host pages in a webview or share a
 * real Chrome — and a decision nobody can re-derive is one that gets re-argued
 * from memory.
 *
 * **Run it with `node`, not `bun`** — the one probe in `tools/` that is not a
 * `bun tools/probe-*.ts`. Playwright's `launch()` never returns under Bun on
 * this machine: the import resolves, `chromium` is there, and the launch hangs
 * indefinitely rather than failing, so it looks like a slow browser rather than
 * an unsupported runtime.
 *
 *   node --experimental-strip-types tools/probe-browser.ts cost     # memory
 *   node --experimental-strip-types tools/probe-browser.ts collide  # one profile, two clients
 *   node --experimental-strip-types tools/probe-browser.ts share    # agent + widget, one page
 *   node --experimental-strip-types tools/probe-browser.ts vault    # sign in once, seed an isolated browser
 *   node --experimental-strip-types tools/probe-browser.ts          # all three
 *
 * Needs a Playwright on this machine. It deliberately does **not** add one to
 * this repo: Volery has no Playwright dependency and should not grow one to
 * measure somebody else's, so the path is found or the probe says what it
 * wanted. Pass `PLAYWRIGHT=<path to playwright/index.js>` to override.
 *
 * Owns `.scratch/browserprobe/` and deletes only that — the convention in
 * `CLAUDE.md`, and the reason is a rebuilt measurement harness (sink f1e1a8a2).
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const HERE = path.resolve(".scratch/browserprobe");
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const TARGET = process.env.TARGET ?? "http://localhost:3000/";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ── finding a playwright ──────────────────────────────────────────────── */

function findPlaywright(): string | null {
  if (process.env.PLAYWRIGHT) return process.env.PLAYWRIGHT;
  const guesses = [
    path.join(homedir(), "codes/rise/node_modules/playwright/index.js"),
    path.join(homedir(), "codes/nova/node_modules/playwright/index.js"),
    path.resolve("node_modules/playwright/index.js"),
  ];
  return guesses.find((g) => existsSync(g)) ?? null;
}

/* ── measuring ─────────────────────────────────────────────────────────── */

/** Private commit of every process whose command line names `marker`.
 *
 * Private commit rather than working set, because working set is what the OS
 * has chosen to keep resident and moves under memory pressure — two runs of the
 * same probe would disagree for reasons that have nothing to do with the
 * browser. Private commit is what the process has actually asked for.
 *
 * Our own tooling is excluded by name: `bash`, `powershell` and `node` all
 * carry the marker in their own command lines (it is in the path they were
 * started from) and would otherwise be counted as browser.
 */
function commitMb(marker: string): { mb: number; procs: number } {
  const ps = `
    $m=@{}; Get-Process | %{ $m[$_.Id]=$_.PrivateMemorySize64 }
    $t=0; $n=0
    Get-CimInstance Win32_Process | ? { $_.Name -notmatch '^(bash|powershell|pwsh|conhost|python|node|cmd|bun)\\.exe$' } | % {
      if ([string]$_.CommandLine -like '*${marker}*') { $t += $m[[int]$_.ProcessId]; $n++ }
    }
    "$([math]::Round($t/1MB,1)) $n"`;
  const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], {
    encoding: "utf8",
  }).trim();
  const [mb, procs] = out.split(/\s+/);
  return { mb: parseFloat(mb) || 0, procs: parseInt(procs) || 0 };
}

const say = (label: string, m: { mb: number; procs: number }) =>
  console.log(`  ${label.padEnd(36)} ${String(m.mb).padStart(8)} MB  (${m.procs} procs)`);

/* ── cost: what a browser costs and what a page costs ──────────────────── */

async function cost(chromium: any) {
  console.log(`\n=== cost  (target ${TARGET}) ===`);
  console.log("  a real page, not about:blank — the difference is ~100x and the");
  console.log("  blank figure is worthless for deciding anything.\n");

  const open = (dir: string) =>
    chromium.launchPersistentContext(path.join(HERE, dir), {
      channel: "chrome",
      headless: false,
      args: ["--no-first-run", "--no-default-browser-check"],
    });

  const go = async (ctx: any) => {
    const p = await ctx.newPage();
    await p.goto(TARGET, { waitUntil: "load", timeout: 15000 }).catch(() => {});
    return p;
  };

  const A = await open("profileA");
  await go(A);
  const one = commitMb("browserprobe");
  say("browser A + 1 page", one);

  for (let i = 0; i < 3; i++) await go(A);
  const four = commitMb("browserprobe");
  say("browser A + 4 pages", four);

  const B = await open("profileB");
  await go(B);
  const two = commitMb("browserprobe");
  say("+ a whole second browser + 1 page", two);

  console.log(`\n  fixed cost of a browser        : ${one.mb.toFixed(1)} MB`);
  console.log(
    `  marginal cost of a page        : ${((four.mb - one.mb) / 3).toFixed(1)} MB`,
  );
  console.log(`  cost of a SECOND browser       : ${(two.mb - four.mb).toFixed(1)} MB`);
  console.log(
    `  => sharing one browser saves   : ${(two.mb - four.mb - (four.mb - one.mb) / 3).toFixed(1)} MB per extra card`,
  );

  await A.close();
  await B.close();
  await sleep(1200);
  say("after close (leak check)", commitMb("browserprobe"));
}

/* ── collide: the bug the installed config has ─────────────────────────── */

async function collide(chromium: any) {
  console.log("\n=== collide ===");
  console.log("  `@playwright/mcp` with no --user-data-dir resolves to ONE default");
  console.log("  profile, so this is what the second card to want a browser gets.\n");

  const dir = path.join(HERE, "contested");
  const open = (label: string) =>
    chromium
      .launchPersistentContext(dir, {
        channel: "chrome",
        headless: true,
        args: ["--no-first-run"],
      })
      .then((c: any) => {
        console.log(`  ${label}: opened`);
        return c;
      })
      .catch((e: Error) => {
        console.log(`  ${label}: FAILED -> ${e.message.split("\n")[0].slice(0, 120)}`);
        return null;
      });

  const a = await open("card A");
  const b = await open("card B (while A holds it)");
  console.log(
    a && !b
      ? "  => COLLISION: the second card cannot have a browser at all"
      : "  => no collision",
  );
  for (const c of [a, b]) if (c) await c.close();

  console.log("\n  and the same two with --isolated (profile in memory):");
  const iso = (label: string) =>
    chromium
      .launch({ channel: "chrome", headless: true })
      .then((x: any) => {
        console.log(`  ${label}: opened`);
        return x;
      })
      .catch((e: Error) => {
        console.log(`  ${label}: FAILED -> ${e.message.split("\n")[0].slice(0, 120)}`);
        return null;
      });
  const c = await iso("card A");
  const d = await iso("card B");
  console.log(c && d ? "  => --isolated fixes it" : "  => --isolated does not fix it");
  for (const x of [c, d]) if (x) await x.close();
}

/* ── share: the whole design, end to end ───────────────────────────────── */

async function share(chromium: any) {
  console.log("\n=== share ===");
  console.log("  Volery owns the browser; the agent attaches with --cdp-endpoint;");
  console.log("  the widget attaches as a second client and dispatches input back.\n");

  const PORT = 9335;
  const dir = path.join(HERE, "shared");
  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${dir}`,
      /* Without this the socket below is refused during the handshake for
         carrying an Origin header, and nothing says so. */
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=800,600",
    ],
    { stdio: "ignore" },
  );

  let version: any = null;
  for (let i = 0; i < 40; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!version) {
    console.log("  FAILED: the browser never opened its port");
    chrome.kill();
    return;
  }
  console.log(`  1. browser up: ${version.Browser}`);

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("about:blank");
  await page.setContent(
    `<style>#b{position:absolute;left:50px;top:50px;width:200px;height:100px}</style>` +
      `<button id=b>click me</button><div id=out>clicks: 0</div>` +
      `<script>let n=0;document.getElementById('b').onclick=()=>{n++;document.title='clicks:'+n;` +
      `document.getElementById('out').textContent='clicks: '+n}</script>`,
  );
  console.log("  2. agent attached over CDP and set the page");

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = targets.find((x: any) => x.type === "page" && x.webSocketDebuggerUrl);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  let frames = 0;
  ws.onmessage = (e: MessageEvent) => {
    const m = JSON.parse(String(e.data));
    if (m.method === "Page.screencastFrame") {
      frames++;
      ws.send(
        JSON.stringify({
          id: ++id,
          method: "Page.screencastFrameAck",
          params: { sessionId: m.params.sessionId },
        }),
      );
    }
  };
  await new Promise((r) => (ws.onopen = r as any));
  console.log("  3. widget attached alongside it — both clients live");

  ws.send(JSON.stringify({ id: ++id, method: "Page.enable" }));
  ws.send(
    JSON.stringify({
      id: ++id,
      method: "Page.startScreencast",
      params: { format: "jpeg", quality: 60, everyNthFrame: 1 },
    }),
  );
  await page.evaluate(`document.body.style.background='#123'`);
  await sleep(1200);
  console.log(`  4. widget saw the agent's change: ${frames} frames`);

  const idle = frames;
  await sleep(1200);
  console.log(`  5. frames while nothing moved: ${frames - idle} (the idle cost)`);

  for (const type of ["mousePressed", "mouseReleased"]) {
    ws.send(
      JSON.stringify({
        id: ++id,
        method: "Input.dispatchMouseEvent",
        params: { type, x: 150, y: 100, button: "left", clickCount: 1 },
      }),
    );
  }
  await sleep(600);
  const title = await page.title();
  console.log(
    `  6. human click through the widget: ${title.includes("clicks:1") ? "LANDED" : `DID NOT LAND (title ${JSON.stringify(title)})`}`,
  );

  ws.close();
  await browser.close();
  /* `/T` because `chrome.kill()` is TerminateProcess and Chrome is a dozen
     processes — the same reason `browser.rs` puts it in a job object. Without
     the tree, the renderers keep the profile directory locked and the cleanup
     below fails with EPERM. */
  try {
    execFileSync("taskkill", ["/T", "/F", "/PID", String(chrome.pid)], { stdio: "ignore" });
  } catch {
    chrome.kill();
  }
  await sleep(1500);
}

/* ── vault: does a seeded browser actually arrive signed in? ───────────── */

/** The whole session-sharing design, end to end.
 *
 * Sign in somewhere (here: set a cookie and a localStorage item, which is what
 * a next-auth cookie and an MSAL token look like from the outside), capture it
 * the way `pane.svelte.ts` does — `Network.getAllCookies` plus
 * `Runtime.evaluate` over `Object.entries(localStorage)` — write the vault, and
 * then check a *fresh isolated* browser seeded from it can see both.
 *
 * If this fails, the "agents keep their own browser but skip the sign-in" half
 * of the design does not work and there is no point in the rest.
 */
async function vault(chromium: any) {
  console.log("\n=== vault ===");
  console.log("  sign in once in a shared browser, seed an isolated one from it.\n");

  const PORT = 9336;
  const dir = path.join(HERE, "vaultsrc");
  const statePath = path.join(HERE, "wall.json");
  /* A real http origin, because cookies are not stored for `data:` or `file:`
     URLs at all — a probe on one of those would report the vault empty and the
     cause would look like the capture rather than the page. */
  const ORIGIN = "http://localhost:3000";

  const chrome = spawn(
    CHROME,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${dir}`,
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 40; i++) {
    try {
      await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      break;
    } catch {
      await sleep(250);
    }
  }

  const shared = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = shared.contexts()[0].pages()[0] ?? (await shared.contexts()[0].newPage());
  await page.goto(`${ORIGIN}/auth/signin`, { waitUntil: "load", timeout: 20000 }).catch(() => {});
  await page.evaluate(`
    document.cookie = 'session-token=abc123; path=/';
    localStorage.setItem('msal.token', 'xyz789');
  `);
  console.log("  1. 'signed in': a cookie and a localStorage token set");

  /* Captured exactly as pane.svelte.ts does it. */
  const jar = await page.context().cookies();
  const entries = JSON.parse(
    await page.evaluate(`JSON.stringify(Object.entries(localStorage))`),
  );
  const state = {
    cookies: jar
      .filter((c: any) => c.name && c.domain)
      .map((c: any) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        expires: c.expires < 0 ? -1 : Math.floor(c.expires),
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite: ["Strict", "None"].includes(c.sameSite) ? c.sameSite : "Lax",
      })),
    origins: [
      { origin: ORIGIN, localStorage: entries.map(([name, value]: any) => ({ name, value })) },
    ],
  };
  writeFileSync(statePath, JSON.stringify(state));
  console.log(
    `  2. vault written: ${state.cookies.length} cookies, ${state.origins[0].localStorage.length} stored items`,
  );

  await shared.close();
  try {
    execFileSync("taskkill", ["/T", "/F", "/PID", String(chrome.pid)], { stdio: "ignore" });
  } catch {
    chrome.kill();
  }
  await sleep(1200);

  /* And now the half that matters: a browser with NOTHING of its own. */
  const fresh = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await fresh.newContext({ storageState: statePath });
  const p2 = await ctx.newPage();
  await p2.goto(`${ORIGIN}/auth/signin`, { waitUntil: "load", timeout: 20000 }).catch(() => {});
  const seenCookie = (await ctx.cookies()).find((c: any) => c.name === "session-token");
  const seenLocal = await p2.evaluate(`localStorage.getItem('msal.token')`);
  console.log(`  3. fresh isolated browser, seeded from the vault:`);
  console.log(`     cookie       : ${seenCookie ? seenCookie.value : "MISSING"}`);
  console.log(`     localStorage : ${seenLocal ?? "MISSING"}`);
  console.log(
    `  => ${seenCookie?.value === "abc123" && seenLocal === "xyz789" ? "BOTH CARRIED — an agent with its own browser arrives signed in" : "INCOMPLETE"}`,
  );
  await fresh.close();
}

/* ── main ──────────────────────────────────────────────────────────────── */

const which = process.argv[2] ?? "all";
const pw = findPlaywright();
if (!pw) {
  console.error(
    "no playwright found. Tried ~/codes/rise, ~/codes/nova and ./node_modules.\n" +
      "Pass PLAYWRIGHT=<path to playwright/index.js>.",
  );
  process.exit(1);
}
const { chromium } = await import(`file:///${pw.replace(/\\/g, "/")}`).then(
  (m: any) => m.default ?? m,
);

rmSync(HERE, { recursive: true, force: true });
mkdirSync(HERE, { recursive: true });

try {
  if (which === "cost" || which === "all") await cost(chromium);
  if (which === "collide" || which === "all") await collide(chromium);
  if (which === "share" || which === "all") await share(chromium);
  if (which === "vault" || which === "all") await vault(chromium);
} finally {
  /* Only our own subdirectory. `.scratch/` is shared by every card on this
     wall and sweeping it has already cost somebody a measurement harness.
 
     Tolerant, and retried: Chrome releases its profile directory some
     milliseconds after its last process goes, so a straight `rmSync` here threw
     EPERM *after the probe had already printed every answer* — which reads as
     the measurement having failed when it had succeeded. A probe whose exit
     code lies about its own findings is worse than one that leaves a directory
     behind. */
  try {
    rmSync(HERE, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch (e) {
    console.log(`\n  (left ${HERE} behind — ${(e as Error).message.split(":")[0]})`);
  }
}
