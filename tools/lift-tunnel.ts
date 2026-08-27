/* Actually run the Spotify tunnel's pure assertions on a machine with no MSVC.
 *
 * `cargo test` does not exist here — `.claude/rules/build.md` has the whole of
 * why, and the short version is that rustc reaches for a bare `link.exe` and
 * finds GNU coreutils' `link`. So `bash tools/check-gnu.sh --profile test`
 * *typechecks* the assertions in `tunnel.rs` and cannot execute one of them,
 * which is worth saying out loud because a green `--profile test` reads exactly
 * like a green test run and is not one.
 *
 *     bun tools/lift-tunnel.ts
 *
 * **It regenerates from `tunnel.rs` on every run and keeps nothing**, for the
 * reason every other `lift-*.ts` here says at length: a copy that can go stale
 * will, and it goes on passing while it does.
 *
 * Simpler than its siblings in one way — the two functions under test reach for
 * nothing but `std`, so there is no `--extern` and no borrowing out of the
 * target directory. That also means this runs when the dependency graph is
 * broken, which for a Spotify file is not hypothetical: `librespot-core`'s
 * `vergen` conflict had the cargo gate red for every card on this wall for a
 * stretch on 2026-08-27.
 *
 * ### What is worth executing here rather than merely compiling
 *
 * **`prefer_ipv4` is the entire fix**, so it is the thing to actually run. The
 * bug it answers is that librespot takes `to_socket_addrs()?.next()` and never
 * another address, and on this network every `ap-*.spotify.com` AAAA times out
 * while the A record beside it opens in 30-46ms. The half a typecheck cannot
 * see is that it **sorts rather than filters**: drop the IPv6 addresses instead
 * of demoting them and a host with no A record stops working altogether —
 * `dealer.spotify.com` is exactly that case on the very network this was found
 * on. `an_ipv6_only_host_is_left_alone` is that, and it is a one-character edit
 * away from being wrong.
 *
 * **`split_target` is `rsplit_once` for a reason a typecheck also cannot see.**
 * An IPv6 literal target is mostly colons, so splitting forwards reads
 * `[::1]:4070` as host `[` and port `:1]:4070` — which compiles, and then
 * refuses every connection at runtime with "bad target".
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const TUNNEL = "src-tauri/src/tunnel.rs";

/** The pure declarations, in the order they have to be declared.
 *
 *  Everything in `tunnel.rs` that touches no socket. Listing what comes *in*
 *  rather than what stays out is deliberate, the same way `lift-selector.ts`
 *  argues it: a new pure function added to that file and not added here is
 *  simply untested, which is quiet — where a new *impure* one would break this
 *  script loudly, which is the safer direction to fail in. */
const ITEMS: string[] = ["fn split_target", "fn prefer_ipv4"];

const TESTS: string[] = [
  /* The fix, and the half of it that a filter would have broken. */
  "ipv4_comes_first_and_nothing_is_dropped",
  "an_ipv6_only_host_is_left_alone",
  /* The request line librespot's `proxytunnel.rs` actually sends. */
  "a_target_is_split_on_its_last_colon",
  "a_malformed_target_is_refused_rather_than_guessed",
];

const lines = readFileSync(TUNNEL, "utf8").split(/\r?\n/);

/** Where a declaration starts, including the doc comments and attributes above
 *  it — a lift that dropped an attribute would compile into a different thing
 *  and say so only at the assertion. */
function startOf(i: number): number {
  let from = i;
  while (from > 0) {
    const prev = lines[from - 1].trim();
    if (prev.startsWith("///") || prev.startsWith("//") || prev.startsWith("#[")) {
      from--;
      continue;
    }
    break;
  }
  return from;
}

/** From a declaration line to its closing brace, by depth. */
function block(i: number): string {
  const head = lines[i];
  if (/;\s*$/.test(head) && !head.includes("{")) {
    return lines.slice(startOf(i), i + 1).join("\n");
  }
  let depth = 0;
  let seen = false;
  for (let j = i; j < lines.length; j++) {
    for (const ch of lines[j]) {
      if (ch === "{") {
        depth++;
        seen = true;
      } else if (ch === "}") depth--;
    }
    if (seen && depth === 0) return lines.slice(startOf(i), j + 1).join("\n");
  }
  throw new Error(`unterminated block at ${TUNNEL}:${i + 1}`);
}

/** Where the test module begins, so the file proper and the tests are searched
 *  separately — a fixture sharing a name with a function would otherwise be the
 *  same match. */
function testsAt(): number {
  const at = lines.findIndex((l) => /^\s*mod tests\s*\{/.test(l));
  if (at < 0) throw new Error(`no test module in ${TUNNEL}`);
  return at;
}

function find(what: string): string {
  const stop = testsAt();
  const re = new RegExp(`^\\s*(pub(\\([a-z]+\\))?\\s+)?${what.replace(/ /g, "\\s+")}\\b`);
  for (let i = 0; i < stop; i++) {
    if (re.test(lines[i])) return block(i);
  }
  throw new Error(`could not find "${what}" in ${TUNNEL} — has it been renamed?`);
}

function findTest(name: string): string {
  for (let i = testsAt(); i < lines.length; i++) {
    if (new RegExp(`^\\s*fn ${name}\\s*\\(`).test(lines[i])) return block(i);
  }
  throw new Error(`could not find test "${name}" in ${TUNNEL} — has it been renamed?`);
}

const body = [
  "//! GENERATED by tools/lift-tunnel.ts — do not edit, do not keep.",
  "use std::net::{IpAddr, SocketAddr};",
  ...ITEMS.map(find),
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  ...TESTS.map(findTest),
  "}",
].join("\n\n");

const dir = mkdtempSync(join(tmpdir(), "lift-tunnel-"));
const file = join(dir, "lifted.rs");
const exe = join(dir, "lifted.exe");
writeFileSync(file, body);

try {
  const build = spawnSync(
    "rustc",
    ["--test", "--edition", "2021", "-A", "dead_code", file, "-o", exe],
    /* Load-bearing: bare `rustc` takes the msvc default toolchain and dies on
       `link: extra operand`, which names nothing that points at the cause.
       Two cards found this independently — sink b282b54c and 276f26ca. */
    { encoding: "utf8", env: { ...process.env, RUSTUP_TOOLCHAIN: "stable-x86_64-pc-windows-gnu" } },
  );
  if (build.status !== 0) {
    console.error(build.stderr || build.stdout);
    console.error(`\nthe lift is at ${file} — it was NOT removed, so you can read it.`);
    process.exit(1);
  }
  const run = spawnSync(exe, ["--test-threads", "1"], { encoding: "utf8" });
  console.log(run.stdout);
  if (run.stderr) console.error(run.stderr);
  process.exit(run.status ?? 1);
} finally {
  /* Nothing is kept on success. A `lifted.rs` left on disk is the stale copy
     this script exists to make impossible. */
  try {
    rmSync(exe, { force: true });
  } catch {
    /* the exe may still be held; the temp dir goes either way */
  }
}
