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
/** Where Chrome is, resolved the way `browser.rs`'s `find_chrome` resolves it.
 *
 * It was a hardcoded `C:/Program Files/...`, and that path does not exist on
 * every machine — Chrome installs per-user under `LOCALAPPDATA` where there is
 * no local administrator, which is exactly the situation
 * `.claude/rules/build.md` documents for this one. The probe then died with an
 * `ENOENT` naming a path, which reads as a broken probe rather than as a
 * browser somewhere else. */
const CHROME = (() => {
  const roots = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.LOCALAPPDATA,
  ]
    .filter(Boolean)
    .map((r) => path.join(r!, "Google/Chrome/Application/chrome.exe"));
  return roots.find((r) => existsSync(r)) ?? roots[0] ?? "chrome.exe";
})();
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

/* ── a browser you cannot see ──────────────────────────────────────────── */

/** Can the shared browser be kept off the desktop and still be a picture?
 *
 * The measurement behind `browser::Mode`, and it chose the implementation
 * rather than merely confirming it. Three questions, in the order of how much
 * each changed the design:
 *
 * 1. **Does an unseen window still produce frames?** A window Windows believes
 *    is invisible is one Chrome stops painting, and `Page.startScreencast`
 *    then delivers nothing at all — a widget frozen on its first picture with
 *    the browser, the socket and the page all demonstrably fine.
 * 2. **What brings a hidden window back?** `ShowWindow(SW_HIDE)` is the
 *    obvious implementation and it loses to Chrome: opening a *tab* re-shows
 *    the window. Parking it off-screen survives that, which is why the mode
 *    that shipped is called `parked`.
 * 3. **Is headless visible to a server?** It is, in the `User-Agent` header —
 *    and nowhere else, which is what makes an override a complete fix rather
 *    than a more distinctive fingerprint than the honest one.
 *
 * Raw CDP rather than Playwright, so this branch needs no Playwright at all:
 * the questions are about windows and headers, and a driver in between would
 * add a launcher with opinions of its own about exactly the flags under test.
 */
async function hidden() {
  const port = 9231;
  /* How long to hold the screencast open. Three seconds answers "does it paint
     at all"; a longer hold answers "does it *keep* painting", which is the
     question Chrome's occlusion calculation makes different — it is throttled,
     so a window it will eventually give up on still paints for the first few
     seconds. `HOLD=30000` is what decided whether the occlusion flags are
     load-bearing for a parked window. */
  const HOLD = Number(process.env.HOLD ?? 3000);
  const page = `<!doctype html><meta charset=utf-8>
<body style="margin:0;background:#101014;color:#e8e4dc;font:40px monospace">
<div id=t>tick 0</div><button id=b style="width:420px;height:160px">click me</button>
<script>let n=0,k=0;setInterval(()=>{t.textContent='tick '+(++n)},50);
b.onclick=()=>{window.__k=++k};window.__k=0;</script>`;
  const file = path.join(HERE, "hidden.html");
  writeFileSync(file, page);

  /* One PowerShell preamble for every window question below. Note `R r;` is
     declared before the `out` rather than inside it: Windows PowerShell 5.1
     compiles this with a C# that predates inline out-declarations, and what it
     says when you forget is that a `)` is missing. */
  const PS = `
Add-Type @"
  using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
  public class W {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int m);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int t, uint f);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    public static List<IntPtr> Of(uint want) {
      var f = new List<IntPtr>();
      EnumWindows((h,l) => { uint p; GetWindowThreadProcessId(h, out p);
        if (p != want) return true;
        var sb = new StringBuilder(256); GetClassName(h, sb, 256);
        R r; GetWindowRect(h, out r);
        if (sb.ToString().StartsWith("Chrome_WidgetWin") && (r.Rt-r.L) > 100) f.Add(h);
        return true; }, IntPtr.Zero);
      return f; }
    public static string Snap(uint pid) {
      var o = "";
      foreach (var h in Of(pid)) { R r; GetWindowRect(h, out r);
        o += "vis=" + IsWindowVisible(h) + " at=" + r.L + "," + r.T + "  "; }
      return o == "" ? "(no windows)" : o; }
    public static string Hide(uint pid) {
      foreach (var h in Of(pid)) ShowWindow(h, 0);
      return "hidden"; }
    public static string Park(uint pid) {
      foreach (var h in Of(pid)) {
        ShowWindow(h, 0);
        SetWindowLong(h, -20, GetWindowLong(h, -20) | 0x80);        // WS_EX_TOOLWINDOW
        SetWindowPos(h, IntPtr.Zero, -32000, -32000, 0, 0, 0x0015); // NOSIZE|NOZORDER|NOACTIVATE
        ShowWindow(h, 8);                                           // SW_SHOWNA
      }
      return "parked"; }
  }
"@
`;
  const ps = (body: string) => {
    try {
      return execFileSync("powershell", ["-NoProfile", "-Command", PS + body], {
        encoding: "utf8",
      }).trim();
    } catch (e: any) {
      return `ERR ${(e.message ?? "").split("\n")[0]}`;
    }
  };

  const ready = async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (r.ok) return await r.json();
      } catch {}
      await sleep(250);
    }
    throw new Error("the port never answered");
  };

  /* The three flags that keep an unseen window painting. Their absence is the
     whole of question 1, and it is measured rather than assumed. */
  const AWAKE = [
    "--disable-features=CalculateNativeWinOcclusion",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];

  let seq = 0;
  async function run(label: string, extra: string[], after: (pid: number) => void = () => {}) {
    const profile = path.join(HERE, `hidden${seq++}`);
    mkdirSync(profile, { recursive: true });
    const child = spawn(
      CHROME,
      [
        `--remote-debugging-port=${port}`,
        "--remote-allow-origins=*",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        ...extra,
      ],
      { stdio: "ignore" },
    );
    const out: Record<string, unknown> = {};
    try {
      const v = await ready();
      await sleep(1500);
      after(child.pid!);
      await sleep(700);

      const ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.addEventListener("open", res, { once: true });
        ws.addEventListener("error", rej, { once: true });
      });
      let id = 0;
      let frames = 0;
      const got = new Map<number, any>();
      ws.addEventListener("message", (e: any) => {
        const m = JSON.parse(String(e.data));
        if (m.id) got.set(m.id, m);
        else if (m.method === "Page.screencastFrame") {
          frames++;
          /* Chrome sends nothing more until the last frame is acknowledged, so
             a missing ack is not a slow probe — it is a frame count of 1. */
          ws.send(
            JSON.stringify({
              id: ++id,
              method: "Page.screencastFrameAck",
              params: { sessionId: m.params.sessionId },
              sessionId: m.sessionId,
            }),
          );
        }
      });
      const call = async (method: string, params: any, sessionId?: string) => {
        const n = ++id;
        ws.send(JSON.stringify({ id: n, method, params, sessionId }));
        for (let i = 0; i < 80 && !got.has(n); i++) await sleep(100);
        return got.get(n);
      };

      const t = await call("Target.createTarget", {
        url: `file:///${file.replace(/\\/g, "/")}`,
      });
      const a = await call("Target.attachToTarget", {
        targetId: t.result.targetId,
        flatten: true,
      });
      const sid = a.result.sessionId;
      await call("Page.enable", {}, sid);

      /* **Applied a second time, and the first version of this probe was
         wrong for want of it.** Creating that page created a *tab*, and a tab
         puts a hidden window back on the desktop — so the frame count below
         was measuring a perfectly visible window and reported 44 frames for a
         mode whose whole question is what happens when there are none. The
         hook is idempotent, so parking twice costs nothing; hiding twice is
         what a hide-based implementation would genuinely have to do, since
         Volery re-parks on `Target.targetCreated` for exactly this reason. */
      after(child.pid!);
      await sleep(700);
      /* Snapshotted *here*, immediately before the measurement, so the row
         says what the window was actually doing while the frames were being
         counted rather than what it was doing a second earlier. */
      out.whileMeasuring = ps(`[W]::Snap(${child.pid})`);

      await call(
        "Page.startScreencast",
        { format: "jpeg", quality: 60, maxWidth: 900, maxHeight: 700 },
        sid,
      );
      await sleep(HOLD);
      out[`framesIn${HOLD / 1000}s`] = frames;

      /* A click, in the page's own CSS pixels. The other half of "is this
         browser usable at all", since a picture you cannot click is a
         screenshot. */
      const rect = await call(
        "Runtime.evaluate",
        {
          expression: `(() => { const r = document.getElementById('b').getBoundingClientRect();
                       return {x: r.x + r.width / 2, y: r.y + r.height / 2} })()`,
          returnByValue: true,
        },
        sid,
      );
      for (const type of ["mousePressed", "mouseReleased"]) {
        await call(
          "Input.dispatchMouseEvent",
          { type, ...rect.result.result.value, button: "left", clickCount: 1 },
          sid,
        );
      }
      await sleep(300);
      out.clicks = (
        await call("Runtime.evaluate", { expression: "window.__k", returnByValue: true }, sid)
      ).result.result.value;
      out.userAgent = (
        await call(
          "Runtime.evaluate",
          { expression: "navigator.userAgent", returnByValue: true },
          sid,
        )
      ).result.result.value;

      /* What a *tab* and then a *window* do to where the window sits. This is
         the question that chose parking over hiding, and the two answers
         differ — so read `afterATab` against `whileMeasuring`, which is the
         same window a moment before anything was opened. */
      await call("Target.createTarget", { url: "about:blank" });
      await sleep(1200);
      out.afterATab = ps(`[W]::Snap(${child.pid})`);
      await call("Target.createTarget", { url: "about:blank", newWindow: true });
      await sleep(1500);
      out.afterAWindow = ps(`[W]::Snap(${child.pid})`);
      ws.close();
    } catch (e: any) {
      out.error = e.message;
    } finally {
      try {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {}
    }
    console.log(`\n── ${label}`);
    for (const [k, v] of Object.entries(out)) console.log(`   ${k.padEnd(13)}: ${v}`);
  }

  console.log("\n=== a browser you cannot see ===");
  await run("a window, the way it was before any of this", []);
  await run("SW_HIDE, no extra flags — the obvious implementation", [], (pid) =>
    console.log(`   ${ps(`[W]::Hide(${pid})`)}`),
  );
  await run("SW_HIDE, with the three flags", AWAKE, (pid) =>
    console.log(`   ${ps(`[W]::Hide(${pid})`)}`),
  );
  await run("parked off-screen, with the three flags — what shipped", AWAKE, (pid) =>
    console.log(`   ${ps(`[W]::Park(${pid})`)}`),
  );
  /* The control for the row above, and the one the first draft of this probe
     forgot to run: it measured hiding with and without the flags, and then the
     code claimed the flags on behalf of *parking*, which is a different thing
     being done to the window. This is the pair that decides whether those
     three arguments earn their place. */
  await run("parked off-screen, no extra flags — the control", [], (pid) =>
    console.log(`   ${ps(`[W]::Park(${pid})`)}`),
  );
  await run("headless", ["--headless=new", "--window-size=1280,800"]);
  console.log(
    "\n  Read the frame counts against `whileMeasuring`: 0 frames on a window that\n" +
      "  was not visible means Chrome stopped painting one it believed nobody could\n" +
      "  see, which is a widget frozen on its first picture with everything else\n" +
      "  about the browser demonstrably fine. Then read `afterATab` against\n" +
      "  `whileMeasuring`: a hidden window comes back on a new tab, a parked one\n" +
      "  does not, and that is the whole reason the mode that shipped is a park.",
  );
}

/* ── main ──────────────────────────────────────────────────────────────── */

const which = process.argv[2] ?? "all";
/* `hidden` is raw CDP and needs no driver, so it must not be gated behind
   finding one — a machine with no Playwright can still answer the question
   this app's own launch arguments turn on. */
const pw = which === "hidden" ? null : findPlaywright();
if (which !== "hidden" && !pw) {
  console.error(
    "no playwright found. Tried ~/codes/rise, ~/codes/nova and ./node_modules.\n" +
      "Pass PLAYWRIGHT=<path to playwright/index.js>.",
  );
  process.exit(1);
}
const { chromium } = pw
  ? await import(`file:///${pw.replace(/\\/g, "/")}`).then((m: any) => m.default ?? m)
  : { chromium: null };

rmSync(HERE, { recursive: true, force: true });
mkdirSync(HERE, { recursive: true });

try {
  if (which === "cost" || which === "all") await cost(chromium);
  if (which === "collide" || which === "all") await collide(chromium);
  if (which === "share" || which === "all") await share(chromium);
  if (which === "vault" || which === "all") await vault(chromium);
  /* Deliberately **not** in `all`: it launches five browsers in a row and
     moves real windows around your desktop, which is not a thing to do to
     somebody who asked for the memory figures. */
  if (which === "hidden") await hidden();
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
