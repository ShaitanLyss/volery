/* What do real tool results actually look like, and does the transcript find
 * the places in them?
 *
 *     bun tools/probe-places.ts
 *     bun tools/probe-places.ts C--atelier-skein 40
 *
 * The counterpart to `probe-context.ts`, pointed at the transcripts on this
 * machine rather than at the CLI. A path in a tool call is clickable into the
 * file viewer (`.claude/rules/finding.md`), and two of the pieces that makes
 * possible are guesses until they are checked against real output:
 *
 * 1. **Does `placesIn` fire on the results people actually get?** It is written
 *    against `path:line:col:text`, which is what `find.rs` asks ripgrep for —
 *    but the `Grep` *tool* formats its own output, and a pattern that matches a
 *    format nobody emits is a feature that never appears.
 *
 * 2. **Does it invent places?** A false positive is a dead link in the middle of
 *    an agent's output, which is worse than no link. So this prints what it
 *    found in every result, and the eye is the test: anything in the list that
 *    is not a file and a line is a bug in the pattern.
 *
 * Nothing here is a test — it reads whatever transcripts this machine happens to
 * hold, so it is run by hand and its findings go into the comments that depend
 * on them.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { insideRoot, placesIn } from "../src/lib/finding";

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? "";
const PROJECTS = join(HOME, ".claude", "projects");

const project = process.argv[2] ?? "C--atelier-skein";
const want = Number(process.argv[3] ?? 25);
const dir = join(PROJECTS, project);

/** Every `tool_result` body in these transcripts, with the tool that made it. */
function results(dir: string): { tool: string; text: string }[] {
  const out: { tool: string; text: string }[] = [];
  /* Newest first, so a run bounded by `want` sees current formats rather than
     whatever the oldest session on disk was doing. */
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .sort()
    .reverse();

  /** tool_use id -> tool name, so a result can say which tool produced it. */
  const names = new Map<string, string>();

  for (const f of files) {
    let lines: string[];
    try {
      lines = readFileSync(f, "utf8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const content = rec?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === "tool_use" && block.id) names.set(block.id, block.name);
        if (block?.type !== "tool_result") continue;
        const body =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .filter((c: any) => c?.type === "text")
                  .map((c: any) => c.text)
                  .join("\n")
              : "";
        if (body) out.push({ tool: names.get(block.tool_use_id) ?? "?", text: body });
      }
    }
    if (out.length > want * 40) break;
  }
  return out;
}

const ROOT = "C:\\atelier\\skein";
const all = results(dir);
console.log(`read ${all.length} tool results from ${project}\n`);

/* Which tools produce results with places in them at all — the answer to
   question 1, and the thing that says whether this feature ever shows up. */
const byTool = new Map<string, { results: number; withPlaces: number; places: number }>();
const samples: { tool: string; text: string; found: string[] }[] = [];

for (const r of all) {
  const found = placesIn(r.text);
  const tally = byTool.get(r.tool) ?? { results: 0, withPlaces: 0, places: 0 };
  tally.results += 1;
  if (found.length) {
    tally.withPlaces += 1;
    tally.places += found.length;
    if (samples.length < want) {
      samples.push({
        tool: r.tool,
        text: r.text.slice(0, 100).replace(/\n/g, "\\n"),
        found: found
          .slice(0, 4)
          .map((p) => `${p.path}:${p.line}${p.col === null ? "" : ":" + p.col} -> ${insideRoot(p.path, ROOT) ?? "OUTSIDE"}`),
      });
    }
  }
  byTool.set(r.tool, tally);
}

console.log("tool                results  with places  places");
for (const [tool, t] of [...byTool.entries()].sort((a, b) => b[1].places - a[1].places)) {
  console.log(
    `${tool.padEnd(20)}${String(t.results).padStart(7)}${String(t.withPlaces).padStart(13)}${String(t.places).padStart(8)}`,
  );
}

console.log(`\n── what was found, ${samples.length} samples ──`);
for (const s of samples) {
  console.log(`\n[${s.tool}] ${s.text}`);
  for (const f of s.found) console.log(`    ${f}`);
}
