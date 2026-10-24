/* The wall's one browser MCP server, with each card in a browser context of
 * its own.
 *
 * Volery used to run `npx @playwright/mcp --port 9244 --cdp-endpoint …` as it
 * comes. Every HTTP session then took the browser's default context as it
 * found it: every page in the browser was one of its tabs, the first of them
 * was its "current" tab, and `browser_tabs select` brought a page to the front
 * of the one window they all shared. So two cards drove each other's pages,
 * the page a card had brought forward hid everybody else's — rAF paused, real
 * input lost, screenshots timing out — and one cookie jar and one localStorage
 * meant a theme or an impersonation one card set changed what every other card
 * saw (sinks 9e05a3fd, 7af2acb4, d3169ad9, 0ff8aa7f and their many twins;
 * `.claude/rules/browser.md` has the list).
 *
 * This is the same server built from the same pieces `@playwright/mcp`'s own
 * CLI is built from (`tools.BrowserBackend`, `tools.filteredTools`,
 * `tools.resolveCLIConfigForMCP` — the package's public `tools` export), with
 * three differences, and they are the whole of it:
 *
 * - **A card is named in the URL**: `/mcp/<card>`, and gets a browser context
 *   of its own — its own cookies, localStorage, sessionStorage and cache, its
 *   own pages. A context is a partition inside the one Chrome, not a second
 *   browser; it costs what its pages cost. The backend is handed that context,
 *   so the tab list, the current tab, `select`, `close`, `run_code`'s `page`,
 *   the cookie tools and routing are all about this card and nobody else, and
 *   Playwright scopes them itself rather than a filter here doing it.
 * - **A card starts signed in.** Its context is created at its first browser
 *   call, seeded from the vault (`sessions/wall.json`, the shape Playwright
 *   calls `storageState`): cookies and localStorage, the latter because MSAL
 *   keeps its tokens there. Sign-ins flow back the other way when a card's
 *   context closes and when the widget's save is pressed, merged by
 *   `browservault.cjs`'s rule — so a login done in one card reaches every card
 *   started after it. A card already running keeps its own copy: one that
 *   finds itself signed out asks the person, as it always has.
 * - **Every page a card opens is a window of its own** (`Target.createTarget`
 *   with `newWindow`), opened where the browser already stands. A page alone in
 *   its window is never a background tab, so nothing another card brings
 *   forward can hide it.
 *
 * **One connection holds every context.** Pages in a context a Playwright
 * connection did not create are filed under that connection's *default*
 * context (`CRBrowser._onAttachedToTarget` in playwright-core 1.64), so a
 * session dialling Chrome for itself could never hold a card's context as one.
 * The host dials once, creates the contexts on that connection, and hands each
 * session its card's. A context created this way is disposed when the
 * connection goes (`disposeOnDetach`), so a restart of this process closes the
 * cards' pages with it — the honest outcome, since it is also what forgets
 * which card was which.
 *
 * **A tab that stops answering stalls nobody, and its own card is told**
 * (2026-10-25). The connection is dialled through a filter that shows
 * Playwright only the cards' own contexts (`browsercdp.cjs`), so no other tab
 * can hold it; a tab's title, the MCP's settle waits and a call still running
 * past `WATCH_AFTER` each have a deadline, and a call is ended only on
 * evidence — `browserstall.cjs` says what counts, and what the card is told.
 * Nothing is ever done to the page, and the agent's own script is never cut
 * off; both are Lyss's decisions.
 *
 * A card's context is closed when its card is done with it: at once when
 * Volery says the card was closed (`POST /volery/release/<card>`), and after
 * `GRACE` with no live session otherwise — a card that went dormant, or was
 * killed, stops answering the heartbeat and its session is closed (sink
 * f7553ae5). Its sign-ins are saved first.
 *
 * Plain CommonJS with no dependency of its own: it is run as
 * `npx -p @playwright/mcp@<pinned> node browserhost.cjs …`, and finds
 * playwright-core beside the package `npx` put on PATH. `browservault.cjs` is
 * written beside it.
 */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { mergeStates, readVault, stateFromCdp, webOrigin } = require(path.join(__dirname, "browservault.cjs"));
const { TargetFilter } = require(path.join(__dirname, "browsercdp.cjs"));
const stall = require(path.join(__dirname, "browserstall.cjs"));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg("port", "9245"));
const HOST = arg("host", "127.0.0.1");
const CDP = arg("cdp-endpoint", "http://127.0.0.1:9222");
/** The saved sign-ins. Empty means seed nothing and save nothing. */
const VAULT = arg("vault", "");
/** How long a card's context outlives its last session. Long enough that a
 *  card whose CLI reconnects keeps its pages; short enough that a day of
 *  finished cards does not pile up in one Chrome. */
const GRACE = Number(arg("grace-ms", String(2 * 60 * 1000)));
/** Only the one host the cards use, as `--allowed-hosts` did: it keeps a page
 *  that rebinds a name of its own to loopback from driving the browser. */
const ALLOWED = [`${HOST}:${PORT}`, `localhost:${PORT}`];
/** Where to tell the wall that a card's tab stopped answering, with the card
 *  appended — Volery's ask listener (`ask::STALLED_PATH`). Empty, and nothing
 *  is reported. */
const REPORT = arg("report", "");

/* ── finding playwright-core ─────────────────────────────────────────────── */

function locate() {
  const env = process.env.VOLERY_PLAYWRIGHT_CORE;
  if (env && fs.existsSync(path.join(env, "lib", "coreBundle.js"))) return env;
  /* `npx -p` puts `<install>/node_modules/.bin` on PATH; playwright-core is a
     sibling of `.bin`. Every entry is tried, because the order npm writes them
     in is not something to depend on. */
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const root = path.resolve(dir, "..", "playwright-core");
    if (fs.existsSync(path.join(root, "lib", "coreBundle.js")) && fs.existsSync(path.resolve(dir, "..", "@playwright", "mcp"))) return root;
  }
  try {
    return path.dirname(require.resolve("playwright-core/package.json"));
  } catch {
    return null;
  }
}

const CORE = locate();
if (!CORE) {
  console.error("browserhost: could not find playwright-core beside @playwright/mcp on PATH");
  process.exit(2);
}
const { tools } = require(path.join(CORE, "lib", "coreBundle.js"));
const utils = require(path.join(CORE, "lib", "utilsBundle.js"));
const { chromium } = require(CORE);
const { Server, StreamableHTTPServerTransport, CallToolRequestSchema, ListToolsRequestSchema } = utils;

const say = (...a) => console.error("browserhost:", ...a);

/* ── the one connection, which sees only the cards' contexts ─────────────── */

let browserPromise = null;

/** The host's connection to Chrome, dialled on first need and again after
 *  Chrome went away — every context went with it, so the cards are forgotten
 *  too and each makes a fresh one at its next call.
 *
 *  Dialled **through `filtered()`**, so it attaches to no tab but the cards'
 *  own. Before that, one tab anywhere in the browser that never answered held
 *  this connect, and so every card's browser, for thirty seconds a try
 *  (`browsercdp.cjs` has the measurement). */
function connection() {
  if (!browserPromise) {
    const p = filtered()
      .then((ws) => chromium.connectOverCDP(ws, { noDefaults: true }))
      .then((browser) => {
        browser.once("disconnected", () => {
          if (browserPromise === p) browserPromise = null;
          contexts.clear();
          say("chrome went away; every card's context with it");
        });
        return browser;
      })
      .catch((e) => {
        throw new Error(
          `volery: Volery's browser server could not connect to the shared browser at ${CDP} (${String((e && e.cause && e.cause.message) || (e && e.message) || e).split("\n")[0]}). ` +
            "The server attaches to no tab but the cards' own, so no tab can be what is holding it: the browser itself is down or not answering. " +
            "Retry once; if it fails again, tell the user rather than reaching for another browser — the browser widget can restart it.",
        );
      });
    p.catch(() => {
      if (browserPromise === p) browserPromise = null;
    });
    browserPromise = p;
  }
  return browserPromise;
}

let filterServer = null;

/** A loopback socket that is Chrome's browser endpoint with every target
 *  outside this connection's own contexts taken out — `browsercdp.cjs` is the
 *  rule. Each connection to it opens its own to Chrome, at the same path, so
 *  the browser id in the path is Chrome's own. Resolves to the address to
 *  hand `connectOverCDP`, once Chrome has answered `/json/version`. */
async function filtered() {
  const version = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
  const upstream = new URL(version.webSocketDebuggerUrl);
  if (!filterServer) {
    filterServer = new Promise((resolve, reject) => {
      const server = new utils.wsServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      server.on("connection", splice);
      server.once("listening", () => resolve(server));
      server.once("error", reject);
    });
    filterServer.catch(() => (filterServer = null));
  }
  const server = await filterServer;
  return `ws://127.0.0.1:${server.address().port}${upstream.pathname}`;
}

/** One client of the filter — in practice the host's one Playwright
 *  connection — joined to its own socket on Chrome, with the filter between
 *  them. Bytes from the client go to Chrome untouched; a message from Chrome is
 *  passed on unless the filter takes it, and whatever the filter wants to say
 *  instead goes to Chrome. Either side closing closes the other. */
function splice(client, req) {
  /* A request this cannot turn into Chrome's own address is closed, not
     thrown: an exception here is uncaught, and would end the server. */
  let chrome;
  try {
    if (!String(req.url || "").startsWith("/devtools/browser/")) throw new Error("not a browser endpoint");
    const origin = new URL(CDP);
    chrome = new utils.ws(`ws://${origin.host}${req.url}`, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  } catch (e) {
    say("refused a connection to the filter:", String(e && e.message ? e.message : e));
    try {
      client.close();
    } catch {}
    return;
  }
  const filter = new TargetFilter();
  const waiting = [];
  const toChrome = (data) => (chrome.readyState === 1 ? chrome.send(data) : waiting.push(data));
  client.on("message", (data, binary) => {
    const text = binary ? null : data.toString();
    if (text !== null) filter.fromClient(text);
    toChrome(text ?? data);
  });
  chrome.on("open", () => {
    for (const d of waiting.splice(0)) chrome.send(d);
  });
  chrome.on("message", (data, binary) => {
    if (binary) return client.readyState === 1 && client.send(data);
    const text = data.toString();
    const { forward, send } = filter.fromBrowser(text);
    for (const m of send) toChrome(m);
    if (forward && client.readyState === 1) client.send(text);
  });
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    if (filter.letGo) say(`let go of ${filter.letGo} tab(s) outside the cards' contexts on that connection`);
    try {
      client.close();
    } catch {}
    try {
      chrome.close();
    } catch {}
  };
  client.on("close", end);
  chrome.on("close", end);
  client.on("error", end);
  chrome.on("error", end);
}

/* ── the vault ───────────────────────────────────────────────────────────── */

let vaultWrites = Promise.resolve();

function vaultNow() {
  if (!VAULT) return { cookies: [], origins: [] };
  try {
    return readVault(fs.readFileSync(VAULT, "utf8"));
  } catch {
    return { cookies: [], origins: [] };
  }
}

/** Merge these captures into the vault and write it, atomically and one write
 *  at a time — a card closing and a save pressed in the same second must not
 *  each read the old file and the second write lose the first. */
function saveToVault(captures) {
  const run = vaultWrites.then(() => {
    if (!VAULT) return vaultNow();
    const merged = mergeStates(vaultNow(), captures, Math.floor(Date.now() / 1000));
    const tmp = `${VAULT}.writing`;
    fs.writeFileSync(tmp, JSON.stringify(merged));
    fs.renameSync(tmp, VAULT);
    return merged;
  });
  vaultWrites = run.catch(() => {});
  return run;
}

/** What a context holds, or nothing if it will not say. Under a deadline: a
 *  hung page must cost a save its sign-ins from that card, not the save. */
async function capture(context) {
  try {
    return await Promise.race([context.storageState(), new Promise((_, no) => setTimeout(() => no(new Error("no answer")), 10000))]);
  } catch {
    return null;
  }
}

/* ── each card's context ─────────────────────────────────────────────────── */

/** card → { context, id, made } — `made` orders captures, oldest first. */
const contexts = new Map();
/** card → a context being made, so two sessions of one card share it. */
const making = new Map();
/** card → number of sessions alive now. */
const live = new Map();
/** card → the timer that will close its context. */
const reaping = new Map();
/** Context creation is one at a time: the new context's id is read as the one
 *  Chrome did not have a moment before, which only holds if nobody else made
 *  one in between. */
let creation = Promise.resolve();

async function contextFor(card) {
  const have = contexts.get(card);
  if (have) return have;
  if (making.has(card)) return making.get(card);
  const p = (creation = creation.catch(() => {}).then(async () => {
    const browser = await connection();
    const cdp = await browser.newBrowserCDPSession();
    try {
      const before = new Set((await cdp.send("Target.getBrowserContexts")).browserContextIds);
      /* `viewport: null` keeps the window's own size, as the default context
         always had; Playwright's 1280×720 emulation would put a page that
         does not match its window in front of a person watching it. */
      const context = await browser.newContext({ storageState: vaultNow(), viewport: null });
      const after = (await cdp.send("Target.getBrowserContexts")).browserContextIds;
      const id = after.find((x) => !before.has(x));
      const entry = { context, id, made: Date.now(), card };
      contexts.set(card, entry);
      context.on("close", () => {
        if (contexts.get(card) === entry) contexts.delete(card);
      });
      context.on("page", (p) => watchPage(entry, p));
      for (const p of context.pages()) watchPage(entry, p);
      say(`made a context for ${card}`);
      return entry;
    } finally {
      cdp.detach().catch(() => {});
    }
  }));
  making.set(card, p);
  try {
    return await p;
  } finally {
    making.delete(card);
  }
}

/** Save what a card's context holds into the vault, then close it — and with
 *  it every page and window it had. */
async function release(card, why) {
  clearTimeout(reaping.get(card));
  reaping.delete(card);
  const entry = contexts.get(card);
  if (!entry) return 0;
  contexts.delete(card);
  const pages = entry.context.pages().length;
  const state = await capture(entry.context);
  if (state) await saveToVault([state]).catch((e) => say("could not save sign-ins:", String(e)));
  await entry.context.close().catch(() => {});
  say(`closed ${card}'s context and ${pages} page(s): ${why}`);
  return pages;
}

/** The save button: every card's context and the default one, merged. A
 *  default context that could not be read is said in `missed`, so the button
 *  never reports a save that left the person's own tabs out. */
async function saveAll() {
  const entries = [...contexts.values()].sort((a, b) => a.made - b.made);
  /* The default context first, so a card's newer value wins a tie with it. */
  const own = await captureDefault();
  const captures = own.state ? [own.state] : [];
  for (const e of entries) captures.push(await capture(e.context));
  const merged = await saveToVault(captures.filter(Boolean));
  return { merged, missed: own.missed };
}

/** What the browser's own context holds — the widget's pages, the ones the
 *  person opened — read over plain CDP, because the host's Playwright
 *  connection no longer sees that context (`browsercdp.cjs`), and asking its
 *  `storageState()` would open a page there that the filter then hides from
 *  Playwright, which would wait for it for ever.
 *
 *  Two things are deliberately not the page's to say. **Which site the
 *  storage belongs to** is read off the URL Chrome lists for the target, not
 *  asked of the page. **The reading itself** runs in an isolated world of the
 *  host's own (`Page.createIsolatedWorld`), whose globals the page's scripts
 *  cannot reach, as Playwright's own `storageState()` read in its utility
 *  world. Only web origins are kept (`browservault.cjs::webOrigin`).
 *
 *  Every question has a deadline and no early cutoff — a save on a loaded
 *  machine is slow, not wrong — and what could not be read is said rather than
 *  saved as nothing. */
async function captureDefault() {
  try {
    const version = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
    const asked = await askRaw(
      version.webSocketDebuggerUrl,
      [
        { id: 1, method: "Target.getBrowserContexts" },
        { id: 2, method: "Target.getTargets" },
        { id: 3, method: "Storage.getCookies" },
      ],
      10000,
      undefined,
      false,
    );
    const cookies = asked.got.get(3)?.result?.cookies;
    if (!Array.isArray(cookies)) return { state: null, missed: "the browser's own tabs could not be read, so their sign-ins were not saved" };
    const ctx = asked.got.get(1)?.result || {};
    const others = new Set(ctx.browserContextIds || []);
    const mine = (t) => (ctx.defaultBrowserContextId ? t.browserContextId === ctx.defaultBrowserContextId : !others.has(t.browserContextId));
    const pages = (asked.got.get(2)?.result?.targetInfos || []).filter((t) => t.type === "page" && mine(t));
    const list = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(5000) })
      .then((r) => r.json())
      .catch(() => []);
    const origins = [];
    let unread = 0;
    await Promise.all(
      pages.map(async (t) => {
        const target = list.find((x) => x.id === t.targetId);
        let origin;
        try {
          origin = new URL(target?.url ?? t.url).origin;
        } catch {
          return;
        }
        if (!webOrigin(origin) || !target) return;
        const entries = await isolatedStorage(target.webSocketDebuggerUrl, t.targetId);
        if (entries) origins.push({ origin, entries });
        else unread++;
      }),
    );
    const state = stateFromCdp(cookies, origins, Math.floor(Date.now() / 1000));
    const missed = unread
      ? `${unread === 1 ? "one of the browser's own tabs" : `${unread} of the browser's own tabs`} did not answer, so its local storage was not saved`
      : undefined;
    return { state, missed };
  } catch (e) {
    return { state: null, missed: `the browser's own tabs could not be read (${String(e && e.message ? e.message : e)}), so their sign-ins were not saved` };
  }
}

/** A page's localStorage, read in a world of the host's own: the page's
 *  scripts share its DOM and none of its globals, so nothing they define can
 *  stand in for what is asked. A page target's main frame id is the target's. */
async function isolatedStorage(ws, frameId) {
  const asked = await askRaw(
    ws,
    [{ id: 1, method: "Page.createIsolatedWorld", params: { frameId, worldName: "volery-save", grantUniveralAccess: false } }],
    5000,
    undefined,
    false,
    (m, send) => {
      if (m.id === 1 && m.result && m.result.executionContextId) {
        send({
          id: 2,
          method: "Runtime.evaluate",
          params: { expression: "JSON.stringify(Object.entries(localStorage))", contextId: m.result.executionContextId, returnByValue: true },
        });
        return false;
      }
      return m.id === 1 || m.id === 2;
    },
  );
  try {
    const entries = JSON.parse(asked.got.get(2)?.result?.result?.value);
    return Array.isArray(entries) ? entries.filter((e) => Array.isArray(e) && typeof e[0] === "string") : null;
  } catch {
    return null;
  }
}

/** Ask one target a few questions over a socket of its own, under one
 *  deadline, and never throw: the answers that came back, by id, and whether
 *  getting through at all used more than half the time (`late`), which is too
 *  short a question to read silence from — so a look gives up there, and a
 *  capture, which wants answers rather than a judgement, passes `cutoff`
 *  false. `onAnswer`, when given, sees each answer and may send a follow-up;
 *  it returns true once the exchange is complete. */
function askRaw(ws, questions, budget, onEvent, cutoff = true, onAnswer) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const got = new Map();
    let socket = false;
    let late = false;
    let done = false;
    let s;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        s && s.terminate();
      } catch {}
      resolve({ socket, late, got });
    };
    const timer = setTimeout(finish, budget);
    try {
      s = new utils.ws(ws, { perMessageDeflate: false, handshakeTimeout: budget });
    } catch {
      return finish();
    }
    s.on("open", () => {
      socket = true;
      if (cutoff && Date.now() - t0 > budget / 2) {
        late = true;
        return finish();
      }
      for (const q of questions) s.send(JSON.stringify(q));
    });
    s.on("message", (data) => {
      let m;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (m.method && onEvent) onEvent(m);
      if (m.id === undefined) return;
      got.set(m.id, m);
      if (onAnswer) {
        if (onAnswer(m, (q) => s.send(JSON.stringify(q)))) finish();
      } else if (questions.every((q) => got.has(q.id))) finish();
    });
    s.on("error", finish);
    s.on("close", finish);
  });
}

function sessionOpened(card) {
  live.set(card, (live.get(card) || 0) + 1);
  clearTimeout(reaping.get(card));
  reaping.delete(card);
}

function sessionClosed(card) {
  const n = Math.max(0, (live.get(card) || 0) - 1);
  live.set(card, n);
  if (n === 0) scheduleRelease(card);
}

function scheduleRelease(card) {
  clearTimeout(reaping.get(card));
  const t = setTimeout(() => {
    if (!live.get(card)) void release(card, "no session for a while");
  }, GRACE);
  t.unref?.();
  reaping.set(card, t);
}

/* ── a page is a window ──────────────────────────────────────────────────── */

const infoOf = new WeakMap();

/** A page's CDP target info, asked once, under a deadline. */
function targetInfo(context, page) {
  let known = infoOf.get(page);
  if (known) return known;
  known = (async () => {
    const session = await context.newCDPSession(page);
    try {
      const { targetInfo } = await session.send("Target.getTargetInfo");
      return targetInfo;
    } finally {
      session.detach().catch(() => {});
    }
  })();
  known = Promise.race([known, new Promise((_, no) => setTimeout(() => no(new Error("no answer")), 3000))]).catch(() => null);
  infoOf.set(page, known);
  /* A lookup that failed — a loaded machine, a page mid-swap — is asked again
     next time rather than standing for ever as "no target". */
  known.then((info) => {
    if (!info && infoOf.get(page) === known) infoOf.delete(page);
  });
  return known;
}

/** Where a new window should open: where the browser already is. Parked means
 *  off every screen, so a card's window never flashes onto the desktop; shown
 *  means beside the one you are looking at. */
async function placement(cdp) {
  try {
    const { targetInfos } = await cdp.send("Target.getTargets");
    for (const t of targetInfos) {
      if (t.type !== "page") continue;
      const { bounds } = await cdp.send("Browser.getWindowForTarget", { targetId: t.targetId });
      if (bounds && bounds.windowState === "normal") return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
    }
  } catch {}
  return {};
}

/** The card's context, with `newPage` opening a window rather than a tab.
 *  Everything else is Playwright's own, scoped to the context by Playwright. */
function windowed(entry, browser) {
  const { context, id } = entry;
  async function newPage() {
    if (!id) return context.newPage();
    const cdp = await browser.newBrowserCDPSession();
    let targetId;
    try {
      const where = await placement(cdp);
      ({ targetId } = await cdp.send("Target.createTarget", { url: "about:blank", newWindow: true, browserContextId: id, ...where }));
    } finally {
      cdp.detach().catch(() => {});
    }
    /* The `page` event may have landed already, or be on its way. */
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      for (const p of context.pages()) {
        const info = await targetInfo(context, p);
        if (info?.targetId === targetId) return p;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("the new tab did not appear");
  }
  return new Proxy(context, {
    get(target, prop) {
      if (prop === "newPage") return newPage;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/* ── a card's tab that stops answering ───────────────────────────────────── */

/** A call still running this long has its card's current tab looked at, and
 *  again this often while it runs, for at most `WATCH_FOR` — the CLI's own
 *  idle limit on an HTTP call, past which nobody is waiting. Long enough that
 *  nearly every call has answered first, and a look at a page that is fine
 *  costs milliseconds. */
const WATCH_AFTER = 8000;
const WATCH_EVERY = 15000;
const WATCH_FOR = 5 * 60 * 1000;
/** One look's budget, `browser::STALL_BUDGET`'s number for the same three
 *  questions, and the gap between the two looks that name a tab. */
const LOOK_BUDGET = 2000;
const LOOK_GAP = 4000;
/** How long a tab's title may take before the tab list says it is not
 *  answering instead of waiting for it. */
const TITLE_WITHIN = 1500;
/** ...and a tab already known not to answer, which every reply would
 *  otherwise wait the whole deadline for again. Still asked, so a page that
 *  has come back says so at once. */
const TITLE_WITHIN_KNOWN = 250;
/** How far past its own length a settle wait may run before the host's clock
 *  ends it. */
const SETTLE_SLACK = 2000;
/** How long a navigation in flight excuses a silent page. MCP's own
 *  navigation timeout, so a navigation that will never commit stops excusing
 *  anything when Playwright itself would have given up on it. A page that has
 *  not yet left its first `about:blank` is excused as long: a popup is handed
 *  to Playwright only once it has initialised, so its first navigation's
 *  request can come before anything here is listening. */
const NAV_GRACE = 60000;

/** page → what the host knows about it: its card, when it appeared, the
 *  main-frame navigations in flight, since when it has been known not to
 *  answer, whether that was reported, the judgement in progress, the last
 *  title it answered with, and when a call that needed it last came back. */
const watching = new WeakMap();

function watchPage(entry, page) {
  if (watching.has(page)) return;
  const s = { entry, born: Date.now(), navs: new Map(), stuckSince: 0, reported: false, judging: null, title: "", served: 0 };
  watching.set(page, s);
  const main = () => page.mainFrame();
  page.on("request", (r) => {
    try {
      if (r.isNavigationRequest() && r.frame() === main()) s.navs.set(r, Date.now());
    } catch {}
  });
  const settled = (r) => s.navs.delete(r);
  page.on("response", (resp) => settled(resp.request()));
  page.on("requestfailed", settled);
  page.on("requestfinished", settled);
  page.on("framenavigated", (f) => {
    if (f === main()) s.navs.clear();
  });
}

function navigating(page, s) {
  const now = Date.now();
  for (const t of s.navs.values()) if (now - t < NAV_GRACE) return true;
  let url = "";
  try {
    url = page.url();
  } catch {}
  return (url === "" || url === "about:blank") && now - s.born < NAV_GRACE;
}

/** The session's own MCP `Tab` for a page. Two sessions of one card share its
 *  pages, and the tab a page remembers (`Tab.forPage`) is whichever session
 *  wrapped it last, so the session's backend is asked first. */
function tabOf(backend, page) {
  try {
    const own = backend?._context?.tabs?.().find((t) => t.page === page);
    return own || tools.Tab.forPage(page);
  } catch {
    return undefined;
  }
}

/** Playwright holds a dialog as a modal state and already answers every tool
 *  with it at once, naming `browser_handle_dialog` — normal flow, not a stall. */
function dialogOpen(backend, page) {
  try {
    return !!tabOf(backend, page)?.modalStates().some((m) => m.type === "dialog");
  } catch {
    return false;
  }
}

/** A tab of the card with a dialog open, if any: a dialog blocks its tab's
 *  whole process, which a same-site tab shares. */
function dialogElsewhere(backend, entry, page) {
  return entry.context.pages().find((p) => p !== page && dialogOpen(backend, p));
}

function currentPage(backend, entry) {
  try {
    const own = backend?._context?.currentTab?.();
    if (own && own.page) return own.page;
  } catch {}
  return entry.context.pages().find((p) => {
    try {
      return tools.Tab.forPage(p)?.isCurrentTab();
    } catch {
      return false;
    }
  });
}

/** The page's own socket and the title the browser has for it — the
 *  browser's, so it is there even when the page cannot be asked for one. */
async function whereIs(entry, page) {
  const info = await targetInfo(entry.context, page);
  if (!info) return null;
  const list = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.json())
    .catch(() => []);
  const t = list.find((x) => x.id === info.targetId);
  return t ? { ws: t.webSocketDebuggerUrl, title: t.title } : null;
}

/** One look: `browser::stalled_tabs`' three questions. The third, a promise
 *  only a timer can resolve, is the one that matters; a page that answers the
 *  first two and not the third answers the protocol, which is never named
 *  (`browserstall.cjs::reading`), so nothing more is asked of it. */
async function look(ws) {
  const { socket, late, got } = await askRaw(
    ws,
    [
      { id: 1, method: "Page.enable" },
      { id: 2, method: "Runtime.evaluate", params: { expression: "1", returnByValue: true } },
      { id: 3, method: "Runtime.evaluate", params: { expression: "new Promise(r => setTimeout(() => r(1), 0))", awaitPromise: true, returnByValue: true } },
    ],
    LOOK_BUDGET,
  );
  return stall.reading({ socket, late, enable: got.has(1), turn: got.has(3) });
}

/** What excuses a silent page right now. `since` is when the judgement began:
 *  a call that needed the page and came back after that is proof it answered. */
function excuses(backend, page, s, since) {
  return {
    closed: page.isClosed(),
    /* Any of the card's tabs: a dialog blocks its tab's whole process, which a
       same-site tab shares, so the tab that looks stuck may only be waiting on
       it. The watch tells the card which tab has it (`dialogNote`). */
    dialog: dialogOpen(backend, page) || !!dialogElsewhere(backend, s.entry, page),
    navigating: navigating(page, s),
    served: s.served > since,
  };
}

/** Two looks `LOOK_GAP` apart, and what the host knows in between: `silent`
 *  when the page answered nothing both times and nothing excuses it,
 *  otherwise null. Never more than one judgement of a page at a time. */
function judge(backend, page, via) {
  const s = watching.get(page);
  if (!s) return Promise.resolve(null);
  if (s.judging) return s.judging;
  const since = Date.now();
  s.judging = (async () => {
    const before = excuses(backend, page, s, since);
    if (before.closed || before.dialog || before.navigating) return null;
    const where = await whereIs(s.entry, page);
    if (!where) return null;
    if (where.title) s.title = where.title;
    const first = await look(where.ws);
    if (first === "ok") return answered(s);
    if (first !== "silent") return null;
    await new Promise((r) => setTimeout(r, LOOK_GAP).unref?.());
    const second = await look(where.ws);
    if (second === "ok") return answered(s);
    const v = stall.verdict(first, second, excuses(backend, page, s, since));
    if (v) {
      if (!s.stuckSince) s.stuckSince = Date.now();
      if (!s.reported) {
        s.reported = true;
        report(s, page, via);
      }
    }
    return v;
  })()
    .catch(() => null)
    .finally(() => {
      s.judging = null;
    });
  return s.judging;
}

function answered(s) {
  s.stuckSince = 0;
  s.reported = false;
  return null;
}

/** Tell the wall, once per tab per time it stops: a chronicle row, through
 *  Volery's own listener. Fire and forget — a report that does not land costs
 *  a row, never the card its answer. The URL goes without its query or
 *  fragment, which is where a sign-in leaves its codes. */
function report(s, page, via) {
  const url = stall.bareUrl(page.url());
  say(`${s.entry.card}'s tab ${url} stopped answering; the card is told ${via === "call" ? "in the reply to its call" : "in its tab list"}`);
  if (!REPORT) return;
  fetch(`${REPORT}${encodeURIComponent(s.entry.card)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(stall.reportBody({ title: s.title, url, via })),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

/** Before a call is dispatched: a current tab already known not to answer,
 *  one more look that agrees, and a tool that needs the page means the call
 *  is not made at all — so nothing it would have done can land later. */
async function upFront(backend, entry, tool) {
  if (!stall.refusedUpFront(tool)) return null;
  const page = currentPage(backend, entry);
  const s = page && watching.get(page);
  if (!s || !s.stuckSince) return null;
  const where = await whereIs(entry, page);
  const r = where ? await look(where.ws) : "unknown";
  if (r === "ok") {
    answered(s);
    return null;
  }
  const now = excuses(backend, page, s, Date.now());
  if (r !== "silent" || now.closed || now.dialog || now.navigating) return null;
  const index = entry.context.pages().indexOf(page);
  if (index < 0) return null;
  return stall.stuckNote({ index, title: s.title, url: page.url(), gap: LOOK_GAP / 1000, still: true });
}

/** Watch one call: resolves with the sentence that ends the wait, or with
 *  null once `stop` is called, the client gives up, or `WATCH_FOR` passes.
 *  Never for the agent's own code, which may be the very thing keeping the
 *  page busy, nor for the tools that get rid of a tab. */
function watchCall(backend, entry, tool, args, signal) {
  let stopped = false;
  const t0 = Date.now();
  const over = () => stopped || (signal && signal.aborted) || Date.now() - t0 > WATCH_FOR;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
  /* Never rejects: the race in the call handler may already have settled,
     and an unhandled rejection ends this process — the whole wall's browser
     server — on a modern Node. */
  const promise = (async () => {
    if (!stall.watched(tool)) return null;
    await wait(WATCH_AFTER + stall.waitsFirst(tool, args));
    while (!over()) {
      const page = currentPage(backend, entry);
      if (page && !page.isClosed()) {
        const v = await judge(backend, page, "call");
        if (over()) return null;
        const index = entry.context.pages().indexOf(page);
        const seconds = Math.round((Date.now() - t0) / 1000);
        if (v && index >= 0) {
          return stall.stuckNote({ index, title: watching.get(page)?.title, url: page.url(), seconds, gap: LOOK_GAP / 1000 });
        }
        /* Silent, and excused only because another tab of the card has a
           dialog open: the dialog is the likelier cause, and the remedy. */
        const other = !v && index >= 0 && dialogElsewhere(backend, entry, page);
        if (other) {
          const where = await whereIs(entry, page);
          const r = where ? await look(where.ws) : "unknown";
          if (over()) return null;
          const at = entry.context.pages().indexOf(other);
          if (r === "silent" && at >= 0) {
            return stall.dialogNote({ index, title: watching.get(page)?.title, dialogIndex: at, dialogTitle: watching.get(other)?.title || stall.bareUrl(other.url()), seconds });
          }
        }
      }
      await wait(WATCH_EVERY);
    }
    return null;
  })().catch((e) => {
    say("a watch failed and stood down:", String(e && e.message ? e.message : e));
    return null;
  });
  return {
    promise,
    /** The call came back. If it was one that needed its tab, that is proof the
     *  tab answered, and a judgement of it already under way stands down. */
    stop(settled) {
      stopped = true;
      if (settled && stall.refusedUpFront(tool)) {
        const page = currentPage(backend, entry);
        const s = page && watching.get(page);
        if (s) s.served = Date.now();
      }
    },
  };
}

/** **A tab's title gets a deadline.** Every reply lists every tab of the card
 *  with its title, asked of the page with no deadline at all, so one frozen
 *  tab held every call its card made, on its healthy tabs too (measured,
 *  `probe-card-tabs.ts stall`). Past `TITLE_WITHIN` the list reads the
 *  browser's own title and *not answering* (or *loading*), and the page is
 *  looked at in the background.
 *
 *  `Tab` is the MCP's own class, from the package's public `tools` export;
 *  the title is asked inside `headerSnapshot` before its first await, so the
 *  page's `title` is shadowed for exactly that synchronous stretch and an
 *  agent's own `page.title()` is never touched. Pinned with the package, and
 *  said in the log if it is ever not there. */
function guardTitles() {
  const header = tools.Tab && tools.Tab.prototype && tools.Tab.prototype.headerSnapshot;
  if (typeof header !== "function") {
    say("tools.Tab.headerSnapshot is not there: a frozen tab will hold its card's replies");
    return;
  }
  tools.Tab.prototype.headerSnapshot = function () {
    const page = this.page;
    const own = Object.prototype.hasOwnProperty.call(page, "title");
    if (!own) page.title = () => titleWithin(page);
    try {
      return header.call(this);
    } finally {
      if (!own) delete page.title;
    }
  };
}

/** **The MCP's settle waits get a deadline of their own length and a bit.**
 *  `Tab.waitForTimeout` waits by evaluating a `setTimeout` *in the page* —
 *  the half-second settle after every action and after the agent's own code
 *  — so on a frozen page it never ends, inside the tool, after the agent's
 *  script has already returned (measured, `probe-card-tabs.ts stall`, 1d). A
 *  wait that has run `SETTLE_SLACK` past its own length has nothing left to
 *  wait for; the host's own clock ends it, and the evaluate is left to settle
 *  when the page answers. (`browser_wait_for`'s time is a sleep in the host,
 *  not this.) */
function guardSettles() {
  const settle = tools.Tab && tools.Tab.prototype && tools.Tab.prototype.waitForTimeout;
  if (typeof settle !== "function") {
    say("tools.Tab.waitForTimeout is not there: a settle wait can hang on a frozen tab");
    return;
  }
  tools.Tab.prototype.waitForTimeout = function (time) {
    const run = settle.call(this, time);
    return Promise.race([run, new Promise((r) => setTimeout(r, (Number(time) || 0) + SETTLE_SLACK).unref?.())]);
  };
}

async function titleWithin(page) {
  const asked = Object.getPrototypeOf(page).title.call(page);
  const s = watching.get(page);
  const within = s && s.stuckSince ? TITLE_WITHIN_KNOWN : TITLE_WITHIN;
  const got = await Promise.race([asked.then((v) => ({ v }), () => null), new Promise((r) => setTimeout(() => r(undefined), within).unref?.())]);
  if (got === null) return asked;
  if (got) {
    if (s) {
      s.title = got.v;
      if (s.stuckSince) answered(s);
    }
    return got.v;
  }
  asked.catch(() => {});
  const loading = !!s && navigating(page, s);
  if (s && !loading) void judge(undefined, page, "list");
  return stall.titleNote(s?.title, loading);
}

/* ── the MCP server, one per session ─────────────────────────────────────── */

let config;
let toolList;

function mergeTextParts(result) {
  const content = [];
  const text = [];
  for (const part of result.content) {
    if (part.type === "text") {
      text.push(part.text);
      continue;
    }
    if (text.length) content.push({ type: "text", text: text.join("\n") }), (text.length = 0);
    content.push(part);
  }
  if (text.length) content.push({ type: "text", text: text.join("\n") });
  return { ...result, content };
}

/** `createServer` from playwright-core's own `server.ts`, with the backend
 *  built for one card. Kept to the same shape — lazy backend on the first
 *  call, a heartbeat that closes the session of a client that has gone, the
 *  backend dropped when the browser disconnects — so a card cannot tell this
 *  server from the one it replaced except by what it sees in `browser_tabs`. */
function sessionServer(card, streamOpened) {
  const server = new Server({ name: "Playwright", version: "volery" }, { capabilities: { tools: { listChanged: true } } });
  let backendPromise;
  let heartbeat = false;
  let opened = false;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const backend = await backendPromise?.catch(() => undefined);
    return { tools: [...toolList.map((t) => toMcp(t.schema)), ...(backend?.dynamicTools?.() ?? [])] };
  });

  const close = () => {
    backendPromise?.then((b) => b.dispose()).catch(() => {});
    if (opened) {
      opened = false;
      sessionClosed(card);
    }
  };
  server.onclose = close;

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      if (!backendPromise) {
        const promise = (async () => {
          let roots = [];
          if (server.getClientCapabilities()?.roots) {
            await Promise.race([streamOpened, new Promise((r) => setTimeout(r, 5000))]);
            roots = (await server.listRoots().catch(() => ({ roots: [] }))).roots;
          }
          /* A client that names no root still needs somewhere for its console
             log and screenshots: with `cwd` undefined, `outputDir` throws
             `The "paths[0]" argument must be of type string` on navigate,
             wait_for and screenshot alike (measured, `probe-card-tabs.ts
             stall`, whose client declares no roots). A card always names its
             working tree, so this is only ever the fallback. */
          const clientInfo = { cwd: firstRoot(roots) ?? require("os").tmpdir(), clientName: server.getClientVersion()?.name ?? "Playwright MCP" };
          const browser = await connection();
          const entry = await contextFor(card);
          /* No dispose of our own: the context is the card's, not the
             session's, and outlives it by `GRACE`. */
          const backend = new tools.BrowserBackend(config, windowed(entry, browser), toolList, {});
          await backend.initialize(clientInfo);
          return backend;
        })().then((backend) => {
          backend.on?.("dynamictoolschange", () => {
            if (backendPromise === promise) void server.sendToolListChanged().catch(() => {});
          });
          backend.once("disconnected", () => {
            if (backendPromise === promise) backendPromise = undefined;
            void backend.dispose().catch(() => {});
          });
          if (!heartbeat) {
            heartbeat = true;
            void streamOpened.then(() => beat(server));
          }
          return backend;
        });
        promise.catch(() => {
          if (backendPromise === promise) backendPromise = undefined;
        });
        backendPromise = promise;
      }
      const backend = await backendPromise;
      const tool = request.params.name;
      const args = request.params.arguments || {};
      const entry = contexts.get(card);
      /* A tab already known not to answer is looked at once more *before* the
         call is dispatched, so a refused call is one that was never made. */
      const refused = entry ? await upFront(backend, entry, tool) : null;
      if (refused) return { content: [{ type: "text", text: refused }], isError: true };
      const call = backend.callTool(tool, args, extra.signal);
      /* Raced against a watch on the card's own tab, which ends the wait with
         a sentence only on evidence (`watchCall`). What it ends is the wait,
         not the work: the call goes on inside Playwright and settles when the
         tab answers or closes, and nothing is done to the page. */
      const watch = entry ? watchCall(backend, entry, tool, args, extra.signal) : null;
      let settled = false;
      try {
        const first = watch
          ? await Promise.race([call.then((r) => ({ r })), watch.promise.then((note) => (note ? { note } : call.then((r) => ({ r }))))])
          : { r: await call };
        if (first.note) {
          call.catch(() => {});
          return { content: [{ type: "text", text: first.note }], isError: true };
        }
        settled = !first.r?.isError;
        return mergeTextParts(first.r);
      } finally {
        watch?.stop(settled);
      }
    } catch (error) {
      return { content: [{ type: "text", text: "### Error\n" + String(error) }], isError: true };
    }
  });

  return {
    server,
    open() {
      if (!opened) {
        opened = true;
        sessionOpened(card);
      }
    },
  };
}

function beat(server) {
  const once = () =>
    Promise.race([server.ping(), new Promise((_, no) => setTimeout(() => no(new Error("ping timeout")), 5000))])
      .then(() => setTimeout(once, 3000))
      .catch(() => void server.close());
  once();
}

function toMcp(schema) {
  const readOnly = schema.type === "readOnly" || schema.type === "assertion";
  return {
    name: schema.name,
    description: schema.description,
    inputSchema: utils.z.toJSONSchema(schema.inputSchema),
    annotations: { title: schema.title, readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true },
  };
}

function firstRoot(roots) {
  for (const root of roots) {
    try {
      const url = new URL(root.uri);
      if (url.protocol === "file:") return require("url").fileURLToPath(url);
    } catch {}
  }
  return undefined;
}

/* ── HTTP ────────────────────────────────────────────────────────────────── */

const sessions = new Map();
const CARD = /^[A-Za-z0-9_-]{1,64}$/;

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

async function onRequest(req, res) {
  /* Never a 401 or 403: the CLI remembers either by server *name*,
     machine-wide, and lists `browser` as needing auth on every card after
     (`load.md` §1). A wrong host is a 421. */
  if (!ALLOWED.includes(String(req.headers.host || "").toLowerCase())) {
    res.statusCode = 421;
    return res.end("wrong host");
  }
  const url = new URL(`http://localhost${req.url}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts[0] === "volery") {
    if (parts[1] === "release" && CARD.test(parts[2] || "") && req.method === "POST") {
      const closed = await release(parts[2], "the card was closed");
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ closed }));
    }
    if (parts[1] === "tabs" && req.method === "GET") {
      const cards = {};
      for (const [card, e] of contexts) cards[card] = e.context.pages().map((p) => p.url());
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ cards, live: Object.fromEntries(live) }));
    }
    if (parts[1] === "save" && req.method === "POST") {
      res.setHeader("content-type", "application/json");
      try {
        const { merged, missed } = await saveAll();
        return res.end(JSON.stringify({ ok: true, state: merged, missed }));
      } catch (e) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    }
    res.statusCode = 404;
    return res.end();
  }
  if (parts[0] !== "mcp") {
    res.statusCode = 404;
    return res.end();
  }

  const sessionId = req.headers["mcp-session-id"];
  if (sessionId) {
    const s = sessions.get(sessionId);
    if (!s) {
      res.statusCode = 404;
      return res.end("Session not found");
    }
    if (req.method === "GET") s.streamOpened.resolve();
    return s.transport.handleRequest(req, res);
  }
  if (req.method !== "POST") {
    res.statusCode = 400;
    return res.end("Invalid request");
  }
  /* `/mcp` with no card is a client that did not name itself. It still gets a
     context of its own, keyed by session, so it can neither see nor be seen;
     it simply cannot find its pages again after a reconnect. */
  const id = crypto.randomUUID();
  const card = parts[1] && CARD.test(parts[1]) ? parts[1] : `session-${id}`;
  const streamOpened = deferred();
  const made = sessionServer(card, streamOpened.promise);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => id,
    onsessioninitialized: () => {
      sessions.set(id, { transport, streamOpened });
      made.open();
    },
  });
  /* Set before `connect`, which chains its own close onto this one. */
  transport.onclose = () => sessions.delete(id);
  await made.server.connect(transport);
  await transport.handleRequest(req, res);
}

async function main() {
  config = await tools.resolveCLIConfigForMCP({ cdpEndpoint: CDP });
  toolList = tools.filteredTools(config);
  guardTitles();
  guardSettles();
  const server = http.createServer((req, res) => {
    onRequest(req, res).catch((e) => {
      say("request failed:", String(e));
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
  server.listen(PORT, HOST, () => say(`listening on http://${HOST}:${PORT}/mcp/<card>, driving ${CDP}${VAULT ? ", seeding from " + VAULT : ""}`));
}

main().catch((e) => {
  say(String(e?.stack || e));
  process.exit(1);
});
