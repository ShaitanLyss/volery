/* What do the file names agents write in prose resolve to?
 *
 *     bun tools/probe-prose-names.ts
 *     bun tools/probe-prose-names.ts C--atelier-skein 60 C:\atelier\skein
 *
 * A bare `App.svelte` or `queue.ts::settleHold` in an agent's answer is a link
 * when exactly one file in the project has that name (`soleMatch` over what
 * `find::resolve_names` walks — `.claude/rules/finding.md`). Whether that is a
 * good rule is a question about real prose rather than about the pattern, so
 * this reads the assistant text in this machine's transcripts, takes every
 * candidate `namedPath` offers with no separator in it, and resolves each
 * against one project's file list the way the app does.
 *
 * Three buckets, and the eye is the test for each: **unique** is what becomes
 * a link, so anything there that is not a file somebody meant is a false
 * positive; **several** is refused, so a name there somebody clearly meant is
 * the price of not guessing; **none** is text, and costs one ripgrep glob the
 * first time it is seen.
 *
 * Nothing here is a test — it reads whatever transcripts this machine holds.
 * Its findings go into the comments that depend on them.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { isBareName, namedPath, pathsIn, soleMatch, splitPath } from "../src/lib/finding";

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? "";
const project = process.argv[2] ?? "C--atelier-skein";
const want = Number(process.argv[3] ?? 40);
const root = process.argv[4] ?? process.cwd();
const dir = join(HOME, ".claude", "projects", project);

/** The project's files the way `resolve_names` walks them. */
const rg = spawnSync("rg", ["--files", "--hidden", "--glob", "!.git", "--glob", "!.git/**"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
});
const files = rg.stdout.split(/\r?\n/).filter(Boolean).map((f) => f.replace(/\\/g, "/"));
const byName = new Map<string, string[]>();
for (const f of files) {
  const n = splitPath(f).name.toLowerCase();
  byName.set(n, [...(byName.get(n) ?? []), f]);
}

/** Every assistant text block, newest sessions first. */
function speech(): string[] {
  const out: string[] = [];
  const logs = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .reverse()
    .slice(0, want);
  for (const f of logs) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.includes('"assistant"')) continue;
      try {
        const rec = JSON.parse(line);
        for (const b of rec?.message?.content ?? []) if (b?.type === "text") out.push(b.text);
      } catch {}
    }
  }
  return out;
}

const tally = { unique: new Map<string, number>(), several: new Map<string, number>(), none: new Map<string, number>() };
let candidates = 0;
for (const text of speech()) {
  /* Code spans whole, the rest tokenised — what `Inlines.svelte` does. */
  const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => namedPath(m[1]));
  const rest = pathsIn(text.replace(/`[^`\n]+`/g, " "));
  for (const at of [...spans, ...rest]) {
    if (!at || !isBareName(at.path)) continue;
    candidates++;
    const hits = byName.get(at.path.toLowerCase()) ?? [];
    const bucket = soleMatch(at.path, hits) ? "unique" : hits.length > 1 ? "several" : "none";
    tally[bucket].set(at.path, (tally[bucket].get(at.path) ?? 0) + 1);
  }
}

console.log(`${files.length} files under ${root}; ${candidates} bare candidates in ${want} sessions of ${project}\n`);
for (const [bucket, map] of Object.entries(tally)) {
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((n, [, c]) => n + c, 0);
  console.log(`${bucket}: ${total} mentions, ${rows.length} names`);
  for (const [name, n] of rows.slice(0, Number(process.env.ROWS ?? 40))) {
    const where = bucket === "several" ? `  (${(byName.get(name.toLowerCase()) ?? []).length} files)` : "";
    console.log(`  ${String(n).padStart(5)}  ${name}${where}`);
  }
  console.log("");
}
