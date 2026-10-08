/* The `PreToolUse` matcher's shape, asserted without cargo.
 *
 * `hooks::settings_carry_the_hook_in_exec_form` already asserts all of this, and
 * on a machine with MSVC that is where it belongs. This exists because **this
 * machine has no MSVC**, so those assertions cannot be run here — and on
 * 2026-10-02 that cost a red release build: the matcher narrowing landed, the
 * test still asserted `matcher.is_none()` from the design it replaced, and
 * nothing local could say so. `tools/check-gnu.sh` type-checks the test body but
 * cannot execute it. See `.claude/rules/build.md`, "writing an assertion nobody
 * can run".
 *
 * So this lifts the two facts out of `hooks.rs` — the exclusion list and the
 * format string that becomes the matcher — and re-asserts the properties that
 * make narrowing safe at all:
 *
 *   1. anchored at both ends, because an unanchored negative lookahead fails
 *      **open** and reads as correct;
 *   2. the list is non-empty, because an empty alternation builds `^(?!()$).*$`
 *      and quietly reverts to firing on everything;
 *   3. no shell tool and no browser tool is excluded, which is the one edit that
 *      turns this back into the 2026-08-25 bug — the guards stop running and
 *      nothing says so;
 *   4. and then it *runs the regex*, which the Rust test deliberately does not:
 *      every excluded name must not match, and a shell/browser/unknown name
 *      must. JS is the right place for that, because the CLI evaluating this
 *      matcher is JS (probed — `tools/probe-matcher.ts`).
 *
 *   bun tools/lift-matcher.ts
 *
 * No API turn, no cargo, no network.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOOKS_RS = join(process.cwd(), "src-tauri", "src", "hooks.rs");
const src = readFileSync(HOOKS_RS, "utf8");

let passes = 0;
const fail: string[] = [];
function ok(what: string, cond: boolean) {
  if (cond) passes++;
  else fail.push(what);
}

/* ── lift the list ──────────────────────────────────────────────────────── */

const listBlock = src.match(/pub const UNHOOKED_TOOLS: &\[&str\] = &\[([\s\S]*?)\];/);
if (!listBlock) {
  console.error("lift-matcher: UNHOOKED_TOOLS not found in hooks.rs — fix this extraction.");
  process.exit(1);
}
const TOOLS = [...listBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

/* ── lift the matcher's construction, rather than re-spelling it here ────── */

const fmt = src.match(/fn unhooked_matcher\(\) -> String \{\s*format!\("([^"]+)",\s*UNHOOKED_TOOLS\.join\("([^"]+)"\)\s*\)/);
if (!fmt) {
  console.error(
    "lift-matcher: could not read unhooked_matcher's format!. If it was reshaped,\n" +
      "  fix this extraction — re-spelling the pattern here is what makes a lift rot.",
  );
  process.exit(1);
}
const MATCHER = fmt[1].replace("{}", TOOLS.join(fmt[2]));

console.log(`UNHOOKED_TOOLS (${TOOLS.length}): ${TOOLS.join(", ")}`);
console.log(`matcher: ${MATCHER}\n`);

/* ── the shape ──────────────────────────────────────────────────────────── */

ok("list is non-empty", TOOLS.length > 0);
ok("anchored + negative at the start", MATCHER.startsWith("^(?!("));
ok("anchored at the end", MATCHER.endsWith(")$).*$"));
for (const t of TOOLS) ok(`matcher names ${t}`, MATCHER.includes(t));

/* The one that matters most. */
for (const forbidden of ["Bash", "PowerShell", "mcp__browser__"]) {
  ok(`${forbidden} is NOT unhooked`, !TOOLS.includes(forbidden));
}

/* ── and the behaviour, which is what the shape is a proxy for ───────────── */

const re = new RegExp(MATCHER);
for (const t of TOOLS) {
  ok(`${t} does not reach the hook`, !re.test(t));
}
for (const t of ["Bash", "PowerShell", "mcp__browser__browser_click", "mcp__skein__sink", "SomeToolShippedNextMonth"]) {
  ok(`${t} still reaches the hook`, re.test(t));
}

/* The fail-open trap, stated as a test so nobody re-derives it: the same list
   without anchors lets an excluded name through at a later offset. */
const unanchored = new RegExp(`(?!(${TOOLS.join("|")})$).*`);
ok(
  "unanchored would fail open (so the anchors are load-bearing)",
  unanchored.test(TOOLS[0]) && !re.test(TOOLS[0]),
);

/* ── report ─────────────────────────────────────────────────────────────── */

if (fail.length) {
  console.error(`FAILED (${fail.length}):`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
/* A pass *count*, because a lift that finds nothing to assert exits 0 and that
   is how four of these rotted red unnoticed (sink ce72b16b). */
const expected = 1 + 2 + TOOLS.length * 2 + 3 + 5 + 1;
if (passes !== expected) {
  console.error(`lift-matcher: asserted ${passes}, expected ${expected} — the lift itself drifted.`);
  process.exit(1);
}
console.log(`lift-matcher: ${passes} assertions pass.`);
/* The line `tools/lifts.ts` greps for. Without it the runner reads this lift as red, however
   many assertions held — it asks for a count, and an unparseable success is not one. */
console.log(`test result: ok. ${passes} passed; 0 failed;`);
