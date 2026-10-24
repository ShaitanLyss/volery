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
 * which card was which. And a hung tab now holds one connect, not every card's
 * (sink e5452945), though the one it holds is the one everybody shares.
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
const { mergeStates, readVault } = require(path.join(__dirname, "browservault.cjs"));

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

/* ── the one connection ──────────────────────────────────────────────────── */

let browserPromise = null;

/** The host's connection to Chrome, dialled on first need and again after
 *  Chrome went away — every context went with it, so the cards are forgotten
 *  too and each makes a fresh one at its next call. */
function connection() {
  if (!browserPromise) {
    const p = chromium.connectOverCDP(CDP, { noDefaults: true }).then((browser) => {
      browser.once("disconnected", () => {
        if (browserPromise === p) browserPromise = null;
        contexts.clear();
        say("chrome went away; every card's context with it");
      });
      return browser;
    });
    p.catch(() => {
      if (browserPromise === p) browserPromise = null;
    });
    browserPromise = p;
  }
  return browserPromise;
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

/** The save button: every card's context and the default one, merged. */
async function saveAll() {
  const browser = await connection();
  const entries = [...contexts.values()].sort((a, b) => a.made - b.made);
  /* The default context first, so a card's newer value wins a tie with it. */
  const captures = [];
  const base = browser.contexts()[0];
  if (base) captures.push(await capture(base));
  for (const e of entries) captures.push(await capture(e.context));
  return saveToVault(captures.filter(Boolean));
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
          const clientInfo = { cwd: firstRoot(roots), clientName: server.getClientVersion()?.name ?? "Playwright MCP" };
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
      return mergeTextParts(await backend.callTool(request.params.name, request.params.arguments || {}, extra.signal));
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
        const merged = await saveAll();
        return res.end(JSON.stringify({ ok: true, state: merged }));
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
