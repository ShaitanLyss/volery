/* The wall's one browser MCP server, with each card on tabs of its own.
 *
 * Volery used to run `npx @playwright/mcp --port 9244 --cdp-endpoint …` as it
 * comes. Every HTTP session then took the browser's default context as it
 * found it: every page in the browser was one of its tabs, the first of them
 * was its "current" tab, and `browser_tabs select` brought a page to the front
 * of the one window they all shared. So two cards drove each other's pages,
 * and the page a card had brought forward hid everybody else's — rAF paused,
 * real input lost, screenshots timing out (sinks 9e05a3fd, 7af2acb4, d3169ad9
 * and their many twins; `.claude/rules/browser.md` has the list).
 *
 * This is the same server built from the same pieces `@playwright/mcp`'s own
 * CLI is built from (`tools.BrowserBackend`, `tools.filteredTools`,
 * `tools.resolveCLIConfigForMCP` — the package's public `tools` export), with
 * two differences, and they are the whole of it:
 *
 * - **A card is named in the URL**: `/mcp/<card>`. A session's backend gets a
 *   *scoped* view of the default context — the same cookie jar and the same
 *   sign-ins, but `pages()` and the `page` event carry only the pages this card
 *   owns. So its tab list, its current tab, `browser_tabs select` and `close`,
 *   and `run_code`'s `page` are all about its own pages and nobody else's.
 * - **Every page a card opens is a window of its own** (`Target.createTarget`
 *   with `newWindow`). A page that is the only tab in its window is never a
 *   background tab, so nothing another card brings forward can hide it.
 *
 * Ownership lives here, in `owners` (target id → card), and is written to the
 * state file so a restart of this process does not orphan every tab. A page
 * opened *by* a card's page (a popup, `target=_blank`) is that card's too. A
 * page nobody owns — the browser's first `about:blank`, one the person opened —
 * is in no card's list.
 *
 * Tabs are closed when their card is done with them: at once when Volery says
 * the card was closed (`POST /volery/release/<card>`), and after `GRACE` with
 * no live session otherwise — a card that went dormant, or was killed, stops
 * answering the heartbeat and its session is closed (sink f7553ae5).
 *
 * Plain CommonJS with no dependency of its own: it is run as
 * `npx -p @playwright/mcp@<pinned> node browserhost.cjs …`, and finds
 * playwright-core beside the package `npx` put on PATH.
 */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg("port", "9244"));
const HOST = arg("host", "127.0.0.1");
const CDP = arg("cdp-endpoint", "http://127.0.0.1:9222");
const STATE = arg("state", "");
/** How long a card's tabs outlive its last session. Long enough that a card
 *  whose CLI reconnects, or whose turn is merely between tools, keeps its page;
 *  short enough that a day of finished cards does not pile up in one Chrome. */
const GRACE = Number(arg("grace-ms", String(15 * 60 * 1000)));
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

/* ── ownership ───────────────────────────────────────────────────────────── */

/** target id → card handle. */
const owners = new Map();
/** card → number of sessions alive now. */
const live = new Map();
/** card → the timer that will close its tabs. */
const reaping = new Map();
/** card → createTarget calls in flight, so a `page` event that beats its own
 *  createTarget answer is not judged before the owner is written down. */
const creating = new Map();

function persist() {
  if (!STATE) return;
  try {
    const tmp = `${STATE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(owners)));
    fs.renameSync(tmp, STATE);
  } catch (e) {
    say("could not write", STATE, String(e));
  }
}

function own(targetId, card) {
  if (owners.get(targetId) === card) return;
  owners.set(targetId, card);
  persist();
}

/** Forget a tab once Chrome no longer lists it. */
async function forgetIfGone(targetId) {
  if (!owners.has(targetId)) return;
  try {
    const listed = await cdpJson("/json/list");
    if (listed.some((t) => t.id === targetId)) return;
  } catch {
    /* No browser to ask is a browser with no tabs. */
  }
  if (owners.delete(targetId)) persist();
}

async function cdpJson(route, method = "GET") {
  const res = await fetch(`${CDP}${route}`, { method });
  if (!res.ok) throw new Error(`${route}: ${res.status}`);
  return res.headers.get("content-type")?.includes("json") ? res.json() : res.text();
}

/** Close every tab a card owns. Over `/json/close`, which needs no session and
 *  so cannot be held up by a page that has stopped answering. */
async function release(card, why) {
  clearTimeout(reaping.get(card));
  reaping.delete(card);
  const mine = [...owners].filter(([, c]) => c === card).map(([id]) => id);
  for (const id of mine) {
    await cdpJson(`/json/close/${id}`, "PUT").catch(() => {});
    owners.delete(id);
  }
  if (mine.length) {
    persist();
    say(`closed ${mine.length} tab(s) of ${card}: ${why}`);
  }
  return mine.length;
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

/** Read the state a previous run left, keep what the browser still has. */
async function restore() {
  if (!STATE || !fs.existsSync(STATE)) return;
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(STATE, "utf8"));
  } catch {
    return;
  }
  let present = null;
  try {
    present = new Set((await cdpJson("/json/list")).map((t) => t.id));
  } catch {
    /* No browser up: every id in the file names a tab that is gone. */
    present = new Set();
  }
  for (const [id, card] of Object.entries(saved)) if (present.has(id) && typeof card === "string") owners.set(id, card);
  persist();
  for (const card of new Set(owners.values())) scheduleRelease(card);
}

/* ── a card's view of the browser ────────────────────────────────────────── */

const infoOf = new WeakMap();

/** A page's CDP target info, asked once. Under a deadline, because a page that
 *  stopped answering must cost this card nothing more than a missing tab. */
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
async function placement(browserSession) {
  try {
    const { targetInfos } = await browserSession.send("Target.getTargets");
    for (const t of targetInfos) {
      if (t.type !== "page") continue;
      const { bounds } = await browserSession.send("Browser.getWindowForTarget", { targetId: t.targetId });
      if (bounds && bounds.windowState === "normal") return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
    }
  } catch {}
  return {};
}

async function scoped(card) {
  const browser = await chromium.connectOverCDP(CDP, { noDefaults: true });
  const context = browser.contexts()[0];
  const emitter = new EventEmitter();
  const mine = [];

  /* Every page this card is given goes through here, and is announced to the
     backend before anything else can hand it out — a page `newPage` returns
     must already be in the backend's tab list, as it is with Playwright's own
     `newPage`, or the backend's current tab is left pointing at nothing. */
  const admit = (page, announce) => {
    if (mine.includes(page)) return;
    mine.push(page);
    page.once("close", () => {
      const i = mine.indexOf(page);
      if (i >= 0) mine.splice(i, 1);
      /* A page also "closes" when this session's connection does, and then
         the tab is still there and still this card's. Only Chrome can say
         which, so ask it. */
      void targetInfo(context, page).then((info) => info && forgetIfGone(info.targetId));
    });
    if (announce) emitter.emit("page", page);
  };

  const judge = async (page) => {
    const info = await targetInfo(context, page);
    if (!info) return false;
    await Promise.all([...(creating.get(card) || [])]).catch(() => {});
    if (owners.get(info.targetId) === card) return true;
    /* A popup is its opener's. */
    if (info.openerId && owners.get(info.openerId) === card) {
      own(info.targetId, card);
      return true;
    }
    return false;
  };

  await Promise.all(context.pages().map(async (p) => (await judge(p)) && admit(p, false)));
  /* Keep the order the pages were opened in, which is the order Chrome lists. */
  mine.sort((a, b) => context.pages().indexOf(a) - context.pages().indexOf(b));

  context.on("page", async (page) => {
    if (await judge(page)) admit(page, true);
  });

  async function newPage() {
    const session = await browser.newBrowserCDPSession();
    let targetId;
    const made = (async () => {
      const where = await placement(session);
      ({ targetId } = await session.send("Target.createTarget", { url: "about:blank", newWindow: true, ...where }));
      own(targetId, card);
    })();
    const set = creating.get(card) || new Set();
    creating.set(card, set);
    set.add(made);
    try {
      await made;
    } finally {
      set.delete(made);
      session.detach().catch(() => {});
    }
    /* The page event may have landed already, or be on its way. */
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      for (const p of mine) {
        const info = await targetInfo(context, p);
        if (info?.targetId === targetId) return p;
      }
      for (const p of context.pages()) {
        const info = await targetInfo(context, p);
        if (info?.targetId === targetId) {
          admit(p, true);
          return p;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("the new tab did not appear");
  }

  const proxy = new Proxy(context, {
    get(target, prop) {
      if (prop === "pages") return () => mine.filter((p) => !p.isClosed());
      if (prop === "newPage") return newPage;
      if (prop === "on" || prop === "addListener" || prop === "once" || prop === "off" || prop === "removeListener") {
        return (event, fn) => {
          (event === "page" ? emitter : target)[prop](event, fn);
          return proxy;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { browser, context: proxy };
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
          const { browser, context } = await scoped(card);
          const backend = new tools.BrowserBackend(config, context, toolList, {
            dispose: async () => {
              await browser.close().catch(() => {});
            },
          });
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
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ owners: Object.fromEntries(owners), live: Object.fromEntries(live) }));
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
  /* `/mcp` with no card is a client from before cards were named — a wall on
     an older build sharing this port. It still gets a view of its own, keyed
     by session, so it can neither see nor be seen; it simply cannot find its
     tabs again after a reconnect. */
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
  await restore();
  const server = http.createServer((req, res) => {
    onRequest(req, res).catch((e) => {
      say("request failed:", String(e));
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
  server.listen(PORT, HOST, () => say(`listening on http://${HOST}:${PORT}/mcp/<card>, driving ${CDP}`));
}

main().catch((e) => {
  say(String(e?.stack || e));
  process.exit(1);
});
