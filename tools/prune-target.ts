/* Take this crate's superseded builds out of `src-tauri/target/debug`.
 *
 *     bun tools/prune-target.ts            prune, and say what went
 *     bun tools/prune-target.ts --dry-run  say what would go, touch nothing
 *     bun tools/prune-target.ts --days 7   keep a week rather than three days
 *
 * `bun run lab` and `bun run gate` call `pruneTarget()` before they build, so a
 * card that builds the app prunes without having to know this exists.
 *
 * ### Why it is needed, measured 2026-10-25 (sink `b3300e79`)
 *
 * `target/debug` was 155 GB, and 106 GB seventeen days earlier. Cargo names
 * every artifact of a crate by a hash of its metadata, and **this crate's
 * version is part of that hash** — so every release (`skein: X.Y.Z`, several a
 * day) starts a fresh set of `skein_lib-<hash>.*` and leaves the last one
 * behind. Cargo never collects an old hash. On that day `deps/` held 68 test
 * harnesses — 24.6 GB of `.pdb` at ~435 MB each, 23.1 GB of leftover `.o`
 * files, 1.5 GB of `.exe` — plus 308 `build/skein-<hash>` directories (~40 MB
 * each) and a `incremental/skein_lib-<hash>` of up to 2 GB per hash. Nothing
 * else in the tree grows like that: third-party crates rebuild under a new
 * hash only when their features or the toolchain change.
 *
 * ### What it takes, and what it never takes
 *
 * Only artifacts of this crate's own targets — `skein_lib`, `skein`, the
 * examples — in `deps/`, `build/`, `examples/`, `incremental/` and
 * `.fingerprint/`, grouped by (name, hash). For each name:
 *
 *  - **the newest group is kept, whatever its age** — the build a lift borrows
 *    from (`lift-scan.ts::newestRlib` picks by mtime too) and the one the next
 *    `cargo` invocation will most likely reuse;
 *  - **anything touched within `days` is kept** — another card on an older
 *    checkout, a worktree built yesterday;
 *  - the rest goes.
 *
 * **Never while a cargo or rustc is running**, on this tree or any other: a
 * build holds files it may be about to link, and the cheapest correct test is
 * the one `lab.ts` already makes before it builds. Skipped, it says so, and the
 * next pass picks it up.
 *
 * What a wrong guess costs is a rebuild, never a loss: everything here is
 * regenerable by `cargo`, which is why a script may do it without a click —
 * `mcp__skein__remove` exists for paths whose loss is a person's decision, and
 * a stale hash of a build cache whose newest copy is kept is not one.
 *
 * ### Why not `[profile.dev] debug = "line-tables-only"` instead
 *
 * Measured the same day, each variant cold on a private target dir with the
 * repository at `d7515d0` (`cargo test --lib --no-run`, then `cargo build`):
 *
 *                              full debug    line-tables-only
 *     skein_lib test .pdb        365 MB          77 MB
 *     skein.pdb (the app)        603 MB         248 MB
 *     target/debug, both built    15 GB         6.6 GB
 *     cold test build             352 s          331 s
 *
 * (The shared tree's own test pdbs run ~435 MB.) Roughly a fifth to a half of
 * the rate. But the growth is in the *count* of hashes, and
 * a smaller file times an unbounded count is still unbounded; it also costs
 * every card a one-off rebuild and takes variable inspection out of a debugger.
 * So the prune is what bounds the tree and the setting is left as the user's
 * call — the numbers are in the commit that landed this.
 */

import { readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO = join(import.meta.dir, "..");
export const TARGET = join(REPO, "src-tauri", "target", "debug");
export const DEFAULT_DAYS = 3;

/** The places one hash's artifacts land. */
const PLACES = ["deps", "build", "examples", "incremental", ".fingerprint"] as const;

/** One entry under `target/debug`, as the planner sees it. */
export type Entry = { place: string; name: string; mtimeMs: number; bytes: number };

/** The crate's own target names, as cargo spells them in file names. Examples
 *  are read off `src-tauri/examples` so a new one is covered without a list. */
export function ownNames(): string[] {
  const names = ["skein_lib", "skein", "build_script_build"];
  try {
    for (const f of readdirSync(join(REPO, "src-tauri", "examples"))) {
      if (f.endsWith(".rs")) names.push(f.slice(0, -3).replace(/-/g, "_"));
    }
  } catch {}
  return names;
}

/** `(name, hash)` for an artifact of one of `names`, or null for anything else.
 *
 *  Cargo writes the hash after the last `-` of the stem: `skein_lib-<16 hex>`
 *  with any extension or `.cgu.rcgu.o` tail in `deps/`, `libskein_lib-<hash>.rlib`
 *  for the library, `skein-<hash>` directories in `build/` and `.fingerprint/`
 *  (where the package name `skein` stands for the build script too), and
 *  `skein_lib-<base36>` in `incremental/`. A name is compared with dashes
 *  folded to underscores, since `build/` and `.fingerprint/` use the package
 *  spelling and `deps/` the crate's. */
export function identify(name: string, names: string[]): { stem: string; hash: string } | null {
  const m = /^(?:lib)?([A-Za-z0-9_-]+?)-([0-9a-z]{13,16})(?:\..*)?$/.exec(name);
  if (!m) return null;
  const stem = m[1]!.replace(/-/g, "_");
  return names.includes(stem) ? { stem, hash: m[2]! } : null;
}

/** What to delete, and what it frees. Pure: the whole decision. */
export function plan(
  entries: Entry[],
  names: string[],
  now: number,
  days = DEFAULT_DAYS,
): { doomed: Entry[]; kept: number; bytes: number } {
  type Group = { stem: string; newest: number; items: Entry[] };
  const byHash = new Map<string, Group>();
  for (const e of entries) {
    const id = identify(e.name, names);
    if (!id) continue;
    /* The place is part of the stem: `build/skein-<h>` and `deps/skein-<h>`
       are different targets that share a spelling, and the newest of one must
       not shelter or doom the other. */
    const key = `${e.place}/${id.stem}#${id.hash}`;
    const g = byHash.get(key) ?? { stem: `${e.place}/${id.stem}`, newest: 0, items: [] };
    g.newest = Math.max(g.newest, e.mtimeMs);
    g.items.push(e);
    byHash.set(key, g);
  }
  /* And so is the kind. `deps/` holds the library (`libskein_lib-<h>.rlib`) and
     the test harness (`skein_lib-<h>.exe`) under one name, rebuilt on different
     days — a fresh test build must not make the current library "superseded". */
  const groups = [...byHash.values()].map((g) => ({
    ...g,
    stem: `${g.stem}:${g.items.some((e) => e.name.startsWith("lib")) ? "lib" : "bin"}`,
  }));
  const newestOf = new Map<string, number>();
  for (const g of groups) newestOf.set(g.stem, Math.max(newestOf.get(g.stem) ?? 0, g.newest));

  const floor = now - days * 86_400_000;
  const doomed: Entry[] = [];
  let kept = 0;
  for (const g of groups) {
    if (g.newest >= newestOf.get(g.stem)! || g.newest >= floor) {
      kept += g.items.length;
      continue;
    }
    doomed.push(...g.items);
  }
  return { doomed, kept, bytes: doomed.reduce((n, e) => n + e.bytes, 0) };
}

/** A cargo or rustc on this machine, any tree. */
export function cargoRunning(): boolean {
  const r = spawnSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
  return /^"(cargo|rustc)\.exe"/im.test(r.stdout ?? "");
}

function sizeOf(path: string): number {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return st.size;
    let n = 0;
    for (const f of readdirSync(path)) n += sizeOf(join(path, f));
    return n;
  } catch {
    return 0;
  }
}

/** The entries under `target`, sized only where they are this crate's. */
function read(target: string, names: string[]): Entry[] {
  const out: Entry[] = [];
  for (const place of PLACES) {
    const dir = join(target, place);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!identify(name, names)) continue;
      const path = join(dir, name);
      try {
        const st = statSync(path);
        out.push({ place, name, mtimeMs: st.mtimeMs, bytes: st.isDirectory() ? sizeOf(path) : st.size });
      } catch {}
    }
  }
  return out;
}

function gb(n: number): string {
  return `${(n / 2 ** 30).toFixed(1)} GB`;
}

/** Prune, or say why not. Returns the line it printed. Never throws: a prune
 *  that fails costs disk, and a lab or a gate that fails over it costs a turn. */
export function pruneTarget(opts: { dryRun?: boolean; days?: number; target?: string } = {}): string {
  const target = opts.target ?? TARGET;
  try {
    if (!existsSync(target)) return "prune: no target/debug, nothing to do";
    if (!opts.dryRun && cargoRunning()) return "prune: skipped — a cargo or rustc is running, so nothing in target/debug was touched";
    const names = ownNames();
    const p = plan(read(target, names), names, Date.now(), opts.days ?? DEFAULT_DAYS);
    if (!p.doomed.length) return `prune: nothing superseded in target/debug (${p.kept} current entries kept)`;
    if (opts.dryRun) return `prune: would free ${gb(p.bytes)} in ${p.doomed.length} superseded entries`;
    let freed = 0;
    let failed = 0;
    for (const e of p.doomed) {
      try {
        rmSync(join(target, e.place, e.name), { recursive: true, force: true });
        freed += e.bytes;
      } catch {
        failed++;
      }
    }
    return (
      `prune: freed ${gb(freed)} of superseded builds in target/debug` +
      (failed ? ` (${failed} entries in use, left for next time)` : "")
    );
  } catch (e) {
    return `prune: skipped — ${e instanceof Error ? e.message : String(e)}`;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--days");
  const days = at >= 0 ? Number(args[at + 1]) : undefined;
  if (days !== undefined && !(days >= 0)) {
    console.error("prune: --days takes a number of days");
    process.exit(2);
  }
  console.log(pruneTarget({ dryRun: args.includes("--dry-run"), days }));
}
