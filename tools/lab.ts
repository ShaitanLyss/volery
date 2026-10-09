/* bun run lab — a lab wall of your own, in one command.
 *
 *   bun run lab                      the lab, exactly as before: `tauri dev` on
 *                                    `dev.skein.lab`, vite on :1421, hot reload
 *   bun run lab <name> [--frozen] [--no-build] [--peer <name>]
 *   bun run lab <name> --join-installed-wall-flyway   (read the note on 3 first)
 *                                    a wall called <name>, with everything it
 *                                    owns derived from that name
 *   bun run lab down <name>          stop it and delete everything it left —
 *                                    yours only, unless --force
 *   bun run lab down --all           the same for every named lab of yours, and
 *                                    the leftovers of any that are gone
 *   bun run lab list                 what is up, and on which port
 *
 * Running several walls side by side was always possible — `VOLERY_SECOND`,
 * `VOLERY_WALL_DIR` and a copied binary — and on 2026-10-08 four cards spent a
 * day finding out how by stepping on each of the five things below. Every one
 * of them is derived here from the name, so none of them can be got wrong:
 *
 *  1. **The port.** Vite is `--strictPort`, so two labs on one port is a
 *     refusal; cards were negotiating :1421/:1425/:1429 over relay messages.
 *     Hashed from the name into 1430–1499 and probed, then recorded.
 *  2. **The webview's profile.** Two processes on one WebView2 user data folder
 *     never attach, silently. Each lab has its own identifier and so its own
 *     folder, and `WEBVIEW2_USER_DATA_FOLDER` names it as well.
 *  3. **The flyway.** Every wall on this machine reads one vault, so a lab
 *     joined the installed wall's flyway — as this machine, when nobody set
 *     `VOLERY_FLYWAY_HOST` — and became a row on Lyss's roster and shadows on
 *     her wall for good. A lab now flies on a key under its own identifier
 *     (`flyway::key::OWN_TARGET`), minted at launch or copied from its
 *     `--peer`, as `lab-<name>.<machine>`; `down` deletes the key with the
 *     rest. `--join-installed-wall-flyway` is the one way onto Lyss's real
 *     flyway, her roster, her shadows and her sink. It exists for proving a
 *     lab against the installed wall and for nothing else, and the lab may use
 *     that key but never change or clear it.
 *  4. **The DLLs.** A binary copied out of `target\debug` without its DLLs exits
 *     53 — `0xC0000135 STATUS_DLL_NOT_FOUND` cut to a byte, naming nothing. The
 *     copy takes every DLL beside it, and an exit of 53 is translated.
 *  5. **The orphan sweep.** The installed wall reaps a process in a card's job
 *     whose parent has gone (`perf.rs::sweep`). This launcher stays up as the
 *     parent of everything it starts, so run it as a foreground command — from a
 *     card, a *background* shell call — and never with `&`.
 *
 * And two that are not footguns but were missing:
 *
 *  - **`--frozen`** serves a `vite build` rather than the dev server, so another
 *    card's edit cannot hot-reload the wall out from under a test holding state
 *    in memory. See `.claude/rules/control.md`.
 *  - **`down`** takes a wall away whole. The binary is always a copy (a rebuild
 *    cannot replace it mid-run, and `tauri dev` cannot run twice on one target
 *    directory), so a named lab is never hot-reloaded on the Rust side.
 *
 * What it will not do: point anything at `dev.skein.studio` (a named lab is
 * `dev.skein.lab.<name>` by construction, in `src-tauri/src/lab.rs` as well as
 * here), set `VOLERY_SECOND` (`claim_wall` is what refuses a second process
 * under one name, and it is left to), or run more than `MAX_LABS` at once.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { join, resolve } from "node:path";

/* ── the pure part, which test/lab.test.ts holds ──────────────────────────── */

/** How many lab walls may be up at once, the bare one included. Each is a
 *  webview and a process tree, on a machine that also hosts the cards doing the
 *  work — 11 cards measured at 66 processes and 9 GB on 2026-10-08. */
export const MAX_LABS = 3;

/** The identifier prefix every named lab carries. Never the studio's. */
export const LAB_PREFIX = "dev.skein.lab.";

const PORT_FLOOR = 1430;
const PORT_SPAN = 70;

const RESERVED = new Set(["down", "list", "up", "help"]);

/** The opt-in onto the installed wall's flyway, spelled so that nobody types
 *  it without meaning it. */
export const FLAG_INSTALLED = "--join-installed-wall-flyway";

/** Why a name cannot be a lab, or `null` if it can. The same alphabet
 *  `lab.rs::identity` accepts: the name becomes two folder names and a mutex
 *  name, so nothing a path or a kernel namespace reads specially. */
export function badName(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,15}$/.test(name)) {
    return `"${name}" is not a lab name — lowercase letters, digits and dashes, at most 16, starting with a letter or digit`;
  }
  if (RESERVED.has(name)) return `"${name}" is a command, not a name`;
  return null;
}

export function identifierOf(name: string): string {
  return LAB_PREFIX + name;
}

/** FNV-1a, so the same name asks for the same port on every run. */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

/** The ports a name tries, in order: its own first, then onward round the
 *  range. A collision between two names is a probe step, never a refusal. */
export function portsFor(name: string): number[] {
  const start = fnv(name) % PORT_SPAN;
  return Array.from({ length: PORT_SPAN }, (_, i) => PORT_FLOOR + ((start + i) % PORT_SPAN));
}

/** What a lab calls itself on the flyway. The machine is in it so two
 *  machines' labs called `a` stay two, and `lab-` leads so nobody mistakes one
 *  for a real wall. Kept under `key.rs::host_name`'s 40-character clip. */
export function flywayHost(name: string | null, machine: string): string {
  const m = (machine.trim() || "this-machine").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return (name ? `lab-${name}.${m}` : `lab.${m}`).slice(0, 40);
}

export type Plan =
  | { kind: "bare"; passthrough: string[]; real: boolean }
  | { kind: "up"; name: string; frozen: boolean; build: boolean; peer: string | null; real: boolean }
  | { kind: "down"; names: string[] | "all"; force: boolean }
  | { kind: "list" }
  | { kind: "help" }
  | { kind: "refused"; why: string };

/** argv after the script, as a plan. */
export function plan(args: string[]): Plan {
  const [first, ...rest] = args;
  if (first === undefined || first.startsWith("-")) {
    if (first === "-h" || first === "--help") return { kind: "help" };
    return { kind: "bare", passthrough: args.filter((a) => a !== FLAG_INSTALLED), real: args.includes(FLAG_INSTALLED) };
  }
  if (first === "help") return { kind: "help" };
  if (first === "list") return { kind: "list" };
  if (first === "down") {
    const force = rest.includes("--force");
    const words = rest.filter((a) => a !== "--force");
    if (words.length === 1 && words[0] === "--all") return { kind: "down", names: "all", force };
    if (words.length === 0) return { kind: "refused", why: "down what? `bun run lab down <name>`, or `--all`" };
    for (const n of words) {
      const why = badName(n);
      if (why) return { kind: "refused", why };
    }
    return { kind: "down", names: words, force };
  }
  const name = first === "up" ? rest.shift() : first;
  if (name === undefined) return { kind: "refused", why: "up what? `bun run lab <name>`" };
  const why = badName(name);
  if (why) return { kind: "refused", why };
  let frozen = false;
  let build = true;
  let peer: string | null = null;
  let real = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--frozen") frozen = true;
    else if (a === "--no-build") build = false;
    else if (a === FLAG_INSTALLED) real = true;
    else if (a === "--peer") {
      const p = rest[++i];
      if (p === undefined) return { kind: "refused", why: "--peer wants a lab name" };
      const bad = badName(p);
      if (bad) return { kind: "refused", why: bad };
      peer = p;
    } else return { kind: "refused", why: `${a} is not something a named lab takes` };
  }
  if (real && peer) {
    return { kind: "refused", why: `${FLAG_INSTALLED} and --peer pick two different flyways; choose one` };
  }
  return { kind: "up", name, frozen, build, peer, real };
}

/** Why `me` may not take a lab down, or `null` if it may.
 *
 *  A lab that is up belongs to whoever launched it — the card whose
 *  `SKEIN_CARD` is in its record, or a person at a terminal (`null`). Written
 *  after `down --all`, run as a harmless check, took down another card's lab
 *  mid-demo on 2026-10-09: every lab on this machine sits in one folder family,
 *  so "all" meant everybody's. A gone lab's leftovers are anybody's to clear. */
export function mayTakeDown(
  name: string,
  owner: string | null | undefined,
  up: boolean,
  me: string | null,
  force: boolean,
): string | null {
  if (!up || force || (owner ?? null) === me) return null;
  const whose = owner ? `card ${owner}` : "somebody at a terminal";
  return `${name} is up and belongs to ${whose}, not ${me ? `card ${me}` : "you"} — ask them, or pass --force if they are gone for good`;
}

/** Whether `path` is one of the two folders lab `name` owns — the only paths
 *  `down` will ever delete. Exact equality against the two it would have made,
 *  never a prefix: `dev.skein.lab.a` is a prefix of `dev.skein.lab.ab`, and
 *  `dev.skein.lab` (the bare lab, whose store people copy real data into) and
 *  `dev.skein.studio` are its neighbours in the same directory. */
export function deletable(path: string, name: string, roaming: string, local: string): boolean {
  if (badName(name) || !roaming || !local) return false;
  const id = identifierOf(name);
  const mine = [`${roaming}\\${id}`, `${local}\\${id}`].map((p) => p.toLowerCase());
  return mine.includes(path.toLowerCase());
}

/** Whether a launcher exit code is the missing-DLL one, which says nothing. */
export function dllMissing(code: number | null): boolean {
  return code === 53 || code === 0xc0000135 || code === -1073741515;
}

/* ── the impure part ──────────────────────────────────────────────────────── */

const REPO = resolve(import.meta.dir, "..");
const ROAMING = process.env.APPDATA ?? "";
const LOCAL = process.env.LOCALAPPDATA ?? "";
const MACHINE = process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? "";
/** Who is asking: the card's handle, or `null` for a person at a terminal. */
const ME = process.env.SKEIN_CARD?.trim() || null;
const TARGET = join(REPO, "src-tauri", "target", "debug");
const VITE = join(REPO, "node_modules", ".bin", process.platform === "win32" ? "vite.exe" : "vite");

/** Everything one lab owns on disk: the identifier's two folders, and nothing
 *  else. The launcher's own files go inside the local one, so `down` deleting
 *  two folders is the whole of a teardown. */
function places(name: string | null) {
  const id = name ? identifierOf(name) : "dev.skein.lab";
  const local = join(LOCAL, id);
  return {
    id,
    roaming: join(ROAMING, id),
    local,
    home: join(local, "lab"),
    webview: join(local, "EBWebView"),
    record: join(local, "lab", "lab.json"),
  };
}

type Record = {
  name: string | null;
  /** The card that launched it, so nobody else's `down` takes it. */
  card?: string | null;
  launcher: number;
  exe?: number;
  port: number;
  host: string;
  frozen: boolean;
  /** On the installed wall's flyway rather than the labs' own. */
  real?: boolean;
  started: string;
};

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readRecord(path: string): Record | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record;
  } catch {
    return null;
  }
}

/** Every lab with a record, named or bare, and whether it is still up. */
function labs(): { record: Record; up: boolean; local: string }[] {
  if (!LOCAL || !existsSync(LOCAL)) return [];
  const out: { record: Record; up: boolean; local: string }[] = [];
  for (const dir of readdirSync(LOCAL)) {
    if (dir !== "dev.skein.lab" && !dir.startsWith(LAB_PREFIX)) continue;
    const record = readRecord(join(LOCAL, dir, "lab", "lab.json"));
    if (record) out.push({ record, up: alive(record.launcher) || alive(record.exe), local: join(LOCAL, dir) });
  }
  return out;
}

const LOUD =
  "THIS LAB IS JOINING THE INSTALLED WALL'S REAL FLYWAY: it will be a row on Lyss's roster, its " +
  "cards shadows on her wall, and it will sync her sink. It can use that key and never change it.";

function say(line: string) {
  console.log(`lab: ${line}`);
}

function refuse(why: string): never {
  console.error(`lab: ${why}`);
  process.exit(2);
}

/** Whether anything answers on a port, on either loopback. Vite binds
 *  `localhost`, which is `::1` on this machine, so v4 alone would say free. */
function answers(port: number): Promise<boolean> {
  const one = (host: string) =>
    new Promise<boolean>((done) => {
      const s = connect({ port, host });
      s.once("connect", () => (s.destroy(), done(true)));
      s.once("error", () => done(false));
      s.setTimeout(400, () => (s.destroy(), done(false)));
    });
  return Promise.all([one("127.0.0.1"), one("::1")]).then(([a, b]) => a || b);
}

async function freePort(name: string): Promise<number> {
  for (const p of portsFor(name)) if (!(await answers(p))) return p;
  refuse(`every port in ${PORT_FLOOR}–${PORT_FLOOR + PORT_SPAN - 1} answers; something else owns the range`);
}

function killTree(pid: number | undefined) {
  if (!alive(pid)) return;
  spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
}

function gb(bytes: number) {
  return `${(bytes / 2 ** 30).toFixed(1)} GB`;
}

function freeBytes(): number | null {
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `(Get-PSDrive ${REPO[0]}).Free`],
    { encoding: "utf8" },
  );
  const n = Number(r.stdout?.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function buildRunning(): boolean {
  const r = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
  return /^"(cargo|rustc)\.exe"/im.test(r.stdout ?? "");
}

/** `cargo build` once, unless told not to — and not on top of somebody
 *  else's build or a nearly full disk, both of which happened on 2026-10-08. */
function build() {
  if (buildRunning()) {
    refuse(
      "a cargo build is already running on this machine. Wait for it, or pass --no-build " +
        `to run the binary already in target\\debug (${age(join(TARGET, "skein.exe"))}).`,
    );
  }
  const free = freeBytes();
  if (free !== null && free < 8 * 2 ** 30) {
    refuse(`only ${gb(free)} free on ${REPO[0]}: — a debug build can take more. Pass --no-build to use the existing binary.`);
  }
  say("cargo build (a no-op when target\\debug is current)");
  const r = spawnSync("cargo", ["build"], { cwd: join(REPO, "src-tauri"), stdio: "inherit" });
  if (r.status !== 0) {
    refuse(
      "cargo build failed. If the link step said access denied, target\\debug\\skein.exe is " +
        "running under a `tauri dev` — pass --no-build to copy the binary that is there.",
    );
  }
}

function age(path: string): string {
  try {
    const mins = Math.round((Date.now() - statSync(path).mtimeMs) / 60000);
    return mins < 90 ? `built ${mins} min ago` : `built ${Math.round(mins / 60)} h ago`;
  } catch {
    return "there is none";
  }
}

/** The binary and every DLL beside it, into the lab's own `bin`. A copy, so a
 *  rebuild cannot replace it mid-run; every DLL, so it does not exit 53. */
function freezeBinary(home: string): string {
  const exe = join(TARGET, "skein.exe");
  if (!existsSync(exe)) refuse(`no ${exe} — run without --no-build`);
  /* A binary from before `lab.rs` ignores VOLERY_LAB and opens as whatever it
     was compiled as — for one built by `bun run tauri dev`, the real wall. The
     variable's name is a literal in the code that reads it, so its absence
     from both halves of the binary is proof the copy cannot be told. */
  const knows = ["skein.exe", "skein_lib.dll"].some((f) => {
    const p = join(TARGET, f);
    return existsSync(p) && readFileSync(p).includes("VOLERY_LAB_PORT");
  });
  if (!knows) {
    refuse(`${exe} (${age(exe)}) predates named labs and would ignore the name — rebuild (drop --no-build)`);
  }
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const dlls = readdirSync(TARGET).filter((f) => f.toLowerCase().endsWith(".dll"));
  for (const f of ["skein.exe", ...dlls]) copyFileSync(join(TARGET, f), join(bin, f));
  say(`froze skein.exe (${age(exe)}) and ${dlls.length} DLLs into ${bin}`);
  return join(bin, "skein.exe");
}

async function waitFor(port: number, what: ChildProcess, log: string) {
  for (let i = 0; i < 240; i++) {
    if (what.exitCode !== null) {
      refuse(`the front end exited (${what.exitCode}) before answering on :${port}:\n${tail(log)}`);
    }
    try {
      const r = await fetch(`http://localhost:${port}/`);
      if (r.ok) return;
    } catch {}
    await Bun.sleep(250);
  }
  refuse(`nothing answered on :${port} within a minute:\n${tail(log)}`);
}

function tail(path: string): string {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/).slice(-15).join("\n");
  } catch {
    return "(no log)";
  }
}

/* ── the verbs ────────────────────────────────────────────────────────────── */

function cap(exclude: string | null) {
  const up = labs().filter((l) => l.up && l.record.name !== exclude);
  if (up.length >= MAX_LABS) {
    const names = up.map((l) => l.record.name ?? "(bare)").join(", ");
    refuse(
      `${up.length} labs are already up (${names}), and ${MAX_LABS} is the limit — each is a ` +
        `webview and a process tree on a machine the cards also live on. Take one down first: ` +
        `\`bun run lab down <name>\`.`,
    );
  }
}

async function bare(passthrough: string[], real: boolean) {
  const where = places(null);
  const mine = readRecord(where.record);
  if (mine && alive(mine.launcher)) refuse(`the bare lab is already up (launcher ${mine.launcher})`);
  cap(null);
  /* What differs from before: the lab flies on a key under its own
     identifier unless asked otherwise (`lab.rs::flyway_for`), and is never
     called this machine. Somebody who set a host on purpose keeps it. */
  const env = { ...process.env };
  delete env.VOLERY_LAB_ON_INSTALLED_FLYWAY;
  if (real) {
    env.VOLERY_LAB_ON_INSTALLED_FLYWAY = "1";
    say(LOUD);
  }
  env.VOLERY_FLYWAY_HOST ||= flywayHost(null, MACHINE);
  mkdirSync(where.home, { recursive: true });
  const record: Record = {
    name: null,
    card: ME,
    launcher: process.pid,
    port: 1421,
    host: env.VOLERY_FLYWAY_HOST!,
    frozen: false,
    real,
    started: new Date().toISOString(),
  };
  writeFileSync(where.record, JSON.stringify(record, null, 2));
  say(`bare lab: dev.skein.lab on :1421, flyway host ${record.host}`);
  const child = spawn("bun", ["run", "tauri", "dev", "--config", "src-tauri/tauri.lab.conf.json", ...passthrough], {
    cwd: REPO,
    env,
    stdio: "inherit",
  });
  const end = () => {
    try {
      if (readRecord(where.record)?.launcher === process.pid) unlinkSync(where.record);
    } catch {}
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      killTree(child.pid);
      end();
      process.exit(130);
    });
  }
  child.on("exit", (code) => {
    end();
    process.exit(code ?? 1);
  });
}

async function up(name: string, frozen: boolean, wantBuild: boolean, peer: string | null, real: boolean) {
  const where = places(name);
  const was = readRecord(where.record);
  if (was && (alive(was.launcher) || alive(was.exe))) {
    const whose = was.card ? `card ${was.card}'s` : "somebody's";
    refuse(`lab ${name} is already up on :${was.port} — ${whose}, launcher ${was.launcher}. Pick another name.`);
  }
  cap(name);
  if (peer) {
    const theirs = readRecord(places(peer).record);
    if (!theirs || !(alive(theirs.launcher) || alive(theirs.exe))) {
      refuse(`--peer ${peer}: there is no lab ${peer} up to take a flyway key from. Bring it up first.`);
    }
  }
  /* Claimed before the build rather than after it, so for the minutes cargo
     takes this lab already counts against the cap, and `down --all` sees a
     live lab with an owner — not a record-less folder it may clear. */
  mkdirSync(where.home, { recursive: true });
  const claim: Record = {
    name,
    card: ME,
    launcher: process.pid,
    port: 0,
    host: flywayHost(name, MACHINE),
    frozen,
    real,
    started: new Date().toISOString(),
  };
  writeFileSync(where.record, JSON.stringify(claim, null, 2));
  process.on("exit", () => {
    try {
      if (readRecord(where.record)?.launcher === process.pid) unlinkSync(where.record);
    } catch {}
  });
  if (wantBuild) build();

  const exe = freezeBinary(where.home);
  const port = await freePort(name);
  const host = flywayHost(name, MACHINE);
  const log = join(where.home, "vite.log");
  const out = openSync(log, "w");

  let front: ChildProcess;
  if (frozen) {
    const dist = join(where.home, "dist");
    say(`vite build → ${dist}`);
    const b = spawnSync(VITE, ["build", "--outDir", dist, "--emptyOutDir"], { cwd: REPO, stdio: ["ignore", out, out] });
    if (b.status !== 0) refuse(`vite build failed:\n${tail(log)}`);
    front = spawn(VITE, ["preview", "--outDir", dist, "--port", String(port), "--strictPort"], {
      cwd: REPO,
      stdio: ["ignore", out, out],
    });
  } else {
    front = spawn(VITE, ["--port", String(port), "--strictPort"], { cwd: REPO, stdio: ["ignore", out, out] });
  }

  let exeChild: ChildProcess | null = null;
  const end = (code: number) => {
    killTree(exeChild?.pid);
    killTree(front.pid);
    try {
      if (readRecord(where.record)?.launcher === process.pid) unlinkSync(where.record);
    } catch {}
    process.exit(code);
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => end(130));

  await waitFor(port, front, log);

  /* What the wall inherits, with everything that could point it somewhere
     else taken out first: a store directory, a forced second instance, a peer
     or an identity from whatever shell this was launched in. */
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["VOLERY_SECOND", "VOLERY_WALL_DIR", "VOLERY_FLYWAY_PEER", "VOLERY_LAB_ON_INSTALLED_FLYWAY", "VOLERY_LAB_PEER", "SKEIN_ID", "VOLERY_LAB", "VOLERY_LAB_PORT"]) {
    delete env[k];
  }
  Object.assign(env, {
    VOLERY_LAB: name,
    VOLERY_LAB_PORT: String(port),
    VOLERY_FLYWAY_HOST: host,
    WEBVIEW2_USER_DATA_FOLDER: where.webview,
    SKEIN_ID: where.id,
  });
  /* A key under this lab's own identifier unless asked for the installed
     wall's by name — see `flyway::key::OWN_TARGET` for what the default
     exists to stop. With a peer, the lab comes up holding the peer's key and
     dials it; without one it mints its own. */
  if (peer) {
    env.VOLERY_LAB_PEER = identifierOf(peer);
    env.VOLERY_FLYWAY_PEER = flywayHost(peer, MACHINE);
  }
  if (real) {
    env.VOLERY_LAB_ON_INSTALLED_FLYWAY = "1";
    say(LOUD);
  }
  /* A lab is a wall to be driven, so the control surface is on unless the
     shell already chose a port for it; and it keeps painting while covered, so
     a capture of it is never stale (control.md, "Capturing a driven wall"). */
  env.SKEIN_CONTROL ||= "1";
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS ||=
    "--disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows";

  exeChild = spawn(exe, [], { cwd: REPO, env, stdio: "inherit" });
  const record: Record = {
    name,
    card: ME,
    launcher: process.pid,
    exe: exeChild.pid,
    port,
    host,
    frozen,
    real,
    started: new Date().toISOString(),
  };
  writeFileSync(where.record, JSON.stringify(record, null, 2));
  say(`${name} is up — ${where.id}, ${frozen ? "frozen front end" : "vite with hot reload"} on :${port}, flyway host ${host} on ${real ? "the INSTALLED WALL's flyway" : peer ? `${peer}'s lab key` : "a lab key of its own"}`);
  say(`drive it:    $env:SKEIN_ID="${where.id}"; bun tools/ctl.ts health`);
  say(`take it down: bun run lab down ${name}`);

  exeChild.on("exit", (code) => {
    if (dllMissing(code)) {
      console.error(
        `lab: ${name} exited ${code}, which is STATUS_DLL_NOT_FOUND — a DLL beside ${exe} is missing. ` +
          `Rebuild (drop --no-build) so target\\debug has them all.`,
      );
    } else say(`${name} exited (${code ?? "killed"})`);
    end(code ?? 1);
  });
}

/** Delete a lab's own flyway key from the vault. Only ever
 *  `dev.skein.lab.<name>/flyway-key` for a name `badName` passed — never the
 *  studio's, which is a person's membership. */
function forgetKey(name: string): boolean {
  if (badName(name)) return false;
  const r = spawnSync("cmdkey", [`/delete:${identifierOf(name)}/flyway-key`], { encoding: "utf8" });
  return r.status === 0;
}

/** Delete one of the two folders a lab owns — and only ever one of those. */
async function wipe(path: string, name: string): Promise<boolean> {
  if (!deletable(path, name, ROAMING, LOCAL)) {
    refuse(`refusing to delete ${path}: it is not one of ${name}'s two folders`);
  }
  if (!existsSync(path)) return false;
  /* A wall's folder stays locked for several seconds after its process is
     gone — measured 2026-10-09: `skein.db` and its WAL still EBUSY past a 5s
     retry with no process of the lab's left alive, which is a handle being
     released after the fact (this machine's endpoint scanner reads files as
     they close). So keep asking for half a minute before calling it held. */
  let last: unknown = null;
  for (let i = 0; i < 60; i++) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (e) {
      last = e;
    }
    if (!existsSync(path)) return true;
    await Bun.sleep(500);
  }
  refuse(`could not delete ${path} after 30s; something still holds it (${(last as Error)?.message ?? "unknown"})`);
}

async function down(names: string[] | "all", force: boolean) {
  const targets =
    names === "all"
      ? labs()
          .map((l) => l.record.name)
          .filter((n): n is string => !!n)
      : names;
  if (names === "all") {
    /* A lab whose launcher died before it wrote a record still has folders. */
    for (const root of [LOCAL, ROAMING]) {
      if (!root || !existsSync(root)) continue;
      for (const d of readdirSync(root)) {
        const n = d.startsWith(LAB_PREFIX) ? d.slice(LAB_PREFIX.length) : null;
        if (n && !badName(n) && !targets.includes(n)) targets.push(n);
      }
    }
  }
  if (targets.length === 0) return say("no named labs to take down");
  for (const name of targets) {
    const where = places(name);
    const record = readRecord(where.record);
    const no = mayTakeDown(name, record?.card, !!record && (alive(record.launcher) || alive(record.exe)), ME, force);
    if (no) {
      /* `--all` is "everything of mine", so somebody else's is passed over;
         a name asked for by name is refused, since that was a mistake. */
      if (names === "all") {
        say(`left ${no.split(" — ")[0]}`);
        continue;
      }
      refuse(no);
    }
    if (record) {
      killTree(record.launcher);
      killTree(record.exe);
      for (let i = 0; i < 40 && (alive(record.launcher) || alive(record.exe)); i++) await Bun.sleep(250);
      if (alive(record.launcher) || alive(record.exe)) refuse(`${name} is still running after taskkill`);
    }
    const gone: string[] = [];
    for (const p of [where.roaming, where.local]) if (await wipe(p, name)) gone.push(p);
    if (forgetKey(name)) gone.push(`its flyway key ${identifierOf(name)}/flyway-key`);
    say(`${name} is down${record ? ` (was :${record.port}, ${record.host})` : ""}; removed ${gone.length ? gone.join(" and ") : "nothing — it had left nothing"}`);
  }
}

function list() {
  const all = labs();
  if (all.length === 0) return say("no labs");
  for (const { record, up } of all) {
    console.log(
      `${(record.name ?? "(bare)").padEnd(17)} ${up ? "up  " : "gone"} :${record.port}  ${record.host}` +
        `${record.frozen ? "  frozen" : ""}${record.real ? "  ON THE INSTALLED WALL'S FLYWAY" : ""}  ${record.card ? `card ${record.card}` : "a terminal"}  since ${record.started}`,
    );
  }
}

if (import.meta.main) {
  const p = plan(process.argv.slice(2));
  switch (p.kind) {
    case "refused":
      refuse(p.why);
    case "help":
      console.log(readFileSync(import.meta.path, "utf8").split("*/")[0].replace(/^\/\* ?/, ""));
      break;
    case "bare":
      await bare(p.passthrough, p.real);
      break;
    case "up":
      if (process.platform !== "win32") refuse("named labs are Windows-only, like the wall they test");
      await up(p.name, p.frozen, p.build, p.peer, p.real);
      break;
    case "down":
      await down(p.names, p.force);
      break;
    case "list":
      list();
      break;
  }
}
