/* Can a card save browser files in the worktree it works in?
 *
 *   bun tools/probe-worktree-files.ts         # a client by hand, no API turn
 *   bun tools/probe-worktree-files.ts live    # one real `claude` card, Haiku
 *
 * The wall's browser host (`src-tauri/src/browserhost.cjs`) gave Playwright a
 * card's launch directory as its one workspace, so a card launched in `nova`
 * and working in its worktree `nova-hop` was refused a screenshot there, and a
 * relative name landed in `nova` (sinks ac92fe93, c6683061). Now the roots are
 * the launch directory and the same place in every worktree of its repository,
 * read per call (`browserroots.cjs`).
 *
 * This drives the real host with a client that declares an MCP root the way
 * the CLI does — the card's launch directory — over a throwaway repository:
 *
 *   1. a screenshot saved by absolute path in the launch tree
 *   2. a worktree added *after* the session started; a screenshot, a snapshot
 *      and a console log saved inside it, and the printed link relative to it
 *   3. a relative name, now ambiguous, refused — and nothing written anywhere
 *   4. a path outside both refused, with the roots named
 *   5. a screenshot with no name still lands in the launch `.playwright-mcp`
 *
 * `live` is one real card launched in the repository, after the worktree
 * exists, told to save a screenshot into the worktree by absolute path — the
 * CLI declaring its own root, as a card on the wall does.
 *
 * Its own headed Chrome on 19334 and the host on 19447, under
 * `.scratch-<card>/worktree-files/`; the wall's 9222 and 9245 are never touched.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CHROME_PORT = 19334;
const MCP_PORT = 19447;
const HOST = "127.0.0.1";
const CARD = process.env.SKEIN_CARD ?? "probe";
const SCRATCH = path.resolve(`.scratch-${CARD}`, "worktree-files");
const REPO = path.join(SCRATCH, "repo");
const HOP = path.join(SCRATCH, "repo-hop");
const OUTSIDE = path.join(SCRATCH, "outside");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, what: string, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${extra && !ok ? `\n       ${extra}` : ""}`);
};
const text = (r: any) => (r?.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");

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

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });

let chrome: ChildProcess | undefined;
let host: ChildProcess | undefined;

async function main() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });
  git(REPO, "init", "-q");
  git(REPO, "-c", "user.email=p@p", "-c", "user.name=p", "commit", "-q", "--allow-empty", "-m", "init");

  const core = findCore();
  chrome = spawn(findChrome(), [`--remote-debugging-port=${CHROME_PORT}`, `--user-data-dir=${path.join(SCRATCH, "profile")}`, "--no-first-run", "--no-default-browser-check", "--no-startup-window", "--window-position=-2400,-2400"], { stdio: "ignore" });
  await waitFor(`http://${HOST}:${CHROME_PORT}/json/version`, 15000);
  host = spawn("node", ["src-tauri/src/browserhost.cjs", "--port", String(MCP_PORT), "--cdp-endpoint", `http://${HOST}:${CHROME_PORT}`, "--grace-ms", "2000"], { env: { ...process.env, VOLERY_PLAYWRIGHT_CORE: core }, stdio: ["ignore", "ignore", "pipe"] });
  host.stderr!.on("data", (d) => process.stdout.write(`        host| ${d}`));
  await waitFor(`http://${HOST}:${MCP_PORT}/volery/tabs`, 15000);

  if (process.argv[2] === "live") return live();

  const { Client, StreamableHTTPClientTransport, ListRootsRequestSchema } = require(path.join(core, "lib", "utilsBundle.js"));
  const client = new Client({ name: "probe-worktree-files", version: "0" }, { capabilities: { roots: { listChanged: false } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(REPO).href, name: "repo" }] }));
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://${HOST}:${MCP_PORT}/mcp/${CARD}-wtf`)));
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

  await call("browser_navigate", { url: "data:text/html,<title>wt</title><h1>worktree</h1><script>console.log('hello from the page')</script>" });

  // 1
  const inRepo = path.join(REPO, ".scratch", "a.png");
  let r = await call("browser_take_screenshot", { filename: inRepo, type: "png" });
  check(!r.isError && fs.existsSync(inRepo), "1. a screenshot saved in the launch tree", text(r));

  // 2
  git(REPO, "worktree", "add", "-q", HOP);
  const inHop = path.join(HOP, ".scratch", "walk-hop-sheet.jpg");
  r = await call("browser_take_screenshot", { filename: inHop.replaceAll("\\", "/"), type: "jpeg" });
  check(!r.isError && fs.existsSync(inHop), "2. a screenshot saved in a worktree added after the session started", text(r));
  check(!r.isError && /\.\.[\\/]repo-hop[\\/]\.scratch[\\/]walk-hop-sheet\.jpg/.test(text(r)), "   its link reads from the launch directory, into the worktree", text(r));
  const snap = path.join(HOP, ".scratch", "page.yml");
  r = await call("browser_snapshot", { filename: snap });
  check(!r.isError && fs.existsSync(snap), "   a snapshot saved in the worktree", text(r));
  const log = path.join(HOP, ".scratch", "console.log");
  r = await call("browser_console_messages", { level: "info", filename: log });
  check(!r.isError && fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("hello from the page"), "   a console log saved in the worktree", text(r));

  // 3
  r = await call("browser_take_screenshot", { filename: "rel.png", type: "png" });
  check(!!r.isError && text(r).includes("Relative file name refused"), "3. a relative name is refused while worktrees stand beside the launch tree", text(r));
  check(!fs.existsSync(path.join(REPO, "rel.png")) && !fs.existsSync(path.join(HOP, "rel.png")), "   and nothing was written in either tree");

  // 4
  const away = path.join(OUTSIDE, "x.png");
  r = await call("browser_take_screenshot", { filename: away, type: "png" });
  check(!!r.isError && text(r).includes("outside this card's roots") && text(r).includes(HOP) && !fs.existsSync(away), "4. a path outside the repository is refused, naming the roots", text(r));

  // 5
  r = await call("browser_take_screenshot", { type: "png" });
  const out = path.join(REPO, ".playwright-mcp");
  check(!r.isError && fs.existsSync(out) && fs.readdirSync(out).some((f) => f.endsWith(".png")), "5. a screenshot with no name still lands in the launch .playwright-mcp", text(r));
  check(!fs.existsSync(path.join(HOP, ".playwright-mcp")), "   and not in the worktree's");

  console.log("\n--- what the card reads when refused ---\n" + text(await call("browser_take_screenshot", { filename: "rel.png" })));
  await client.close().catch(() => {});
}

/* One real card, launched in the main checkout, saving into the worktree. The
   server is named `probebrowser`, never `browser`: a 401/403 is remembered by
   name machine-wide (`load.md` §1). */
async function live() {
  git(REPO, "worktree", "add", "-q", HOP);
  const shot = path.join(HOP, ".scratch", "live.png");
  const cfgFile = path.join(SCRATCH, "live.mcp.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ mcpServers: { probebrowser: { type: "http", url: `http://${HOST}:${MCP_PORT}/mcp/${CARD}-live` } } }));
  const prompt =
    `Use the probebrowser tools. First navigate to data:text/html,<h1>live</h1>. Then call browser_take_screenshot with ` +
    `type "png" and filename "${shot.replaceAll("\\", "/")}". Then call browser_take_screenshot again with filename "rel.png". ` +
    `Reply with the exact text each screenshot call returned, nothing else.`;
  const child = spawn("claude", ["-p", prompt, "--model", "haiku", "--strict-mcp-config", "--mcp-config", cfgFile, "--allowedTools", "mcp__probebrowser", "--output-format", "text"], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  await new Promise((r) => child.on("exit", r));
  console.log("--- the card said ---\n" + out.trim() + "\n---");
  check(fs.existsSync(shot), "live: a real card launched in the checkout saved a screenshot into the worktree");
  check(/Relative file name refused/.test(out), "live: and was told why its relative name was refused");
  check(!fs.existsSync(path.join(REPO, "rel.png")), "live: and nothing landed in the main checkout");
}

main()
  .catch((e) => {
    failures++;
    console.error(e);
  })
  .finally(async () => {
    for (const c of [host, chrome]) if (c?.pid) spawn("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" });
    await sleep(800);
    console.log(failures ? `\n${failures} FAILED` : "\nall ok");
    process.exit(failures ? 1 : 0);
  });
