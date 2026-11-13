import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/* Svelte's template has no block comments. A C-style block comment written
   between elements — or a line that opens with two slashes — is not a comment
   to be stripped: it is literal text in the component, and the component draws
   it. That happened in `Thread.svelte`'s `letter` snippet, where the note
   explaining gate attribution sat between `{@const}` lines in the markup. Every
   relay letter, nudge and billboard row then carried the note as a paragraph
   above the card, in every transcript, from 0.127.0 until a screenshot showed
   a letter whose own body did not contain it.

   Two things keep this scan honest, and both are why it is not a plain grep:
   a block comment *inside* `{ … }` is JavaScript and is exactly where such a
   note belongs, so the walk tracks brace depth; and a glob like `src/lib/**`
   in prose is not a comment, so an opening marker that touches a word is
   skipped.

   The invariant: at template level — outside `<script>`, `<style>` and
   `<!-- … -->` — no component under `src` carries a block-comment marker or a
   line that opens with two slashes. Comments belong in a script block, a style
   block, or an HTML comment. */

const SRC = "src";

function blank(text: string, from: number, to: number): string {
  return text.slice(from, to).replace(/[^\n]/g, " ");
}

/** One file's markup, with every script and style block blanked out. */
export function markupOf(text: string): string {
  let out = "";
  let at = 0;
  for (const m of text.matchAll(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi)) {
    const start = m.index ?? 0;
    out += text.slice(at, start);
    out += blank(text, start, start + m[0].length);
    at = start + m[0].length;
  }
  return out + text.slice(at);
}

/** Comment-shaped text a template would draw, as `line: what` — empty if clean. */
export function strayComments(text: string): string[] {
  const markup = markupOf(text);
  const found: string[] = [];
  let depth = 0;
  let line = 1;
  for (let i = 0; i < markup.length; i++) {
    if (markup.startsWith("<!--", i)) {
      const end = markup.indexOf("-->", i + 4);
      const stop = end === -1 ? markup.length : end + 3;
      line += (markup.slice(i, stop).match(/\n/g) ?? []).length;
      i = stop - 1;
      continue;
    }
    const c = markup[i];
    if (c === "\n") line++;
    else if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && markup.startsWith("/*", i)) {
      const after = markup[i + 2] ?? "";
      const before = i > 0 ? markup[i - 1] : "";
      const opensLikeComment = after === "" || " \t\n*".includes(after);
      const touchesWord = /[A-Za-z0-9_./-]/.test(before);
      if (opensLikeComment && !touchesWord) found.push(`${line}: block comment at template level`);
    } else if (depth === 0 && markup.startsWith("*/", i)) {
      const before = i > 0 ? markup[i - 1] : "";
      if (before === "" || " \t\n".includes(before)) found.push(`${line}: block-comment close at template level`);
    }
  }
  let d = 0;
  markup.split("\n").forEach((l, n) => {
    if (d === 0 && l.trimStart().startsWith("//")) found.push(`${n + 1}: slash-slash line at template level`);
    d = Math.max(0, d + (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length);
  });
  return found;
}

/** Every component and page under `src`, at any depth. */
function templates(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...templates(p));
    else if (e.name.endsWith(".svelte") || e.name.endsWith(".html")) out.push(p);
  }
  return out.sort();
}

describe("no source comment is drawn as text", () => {
  test("every template is free of comment markers at template level", () => {
    const files = templates(SRC);
    /* A scan that found no files passes over nothing; the tree is 160+. */
    expect(files.length).toBeGreaterThan(100);
    const bad: string[] = [];
    for (const f of files) {
      for (const line of strayComments(readFileSync(f, "utf8"))) bad.push(`${f}:${line}`);
    }
    expect(bad).toEqual([]);
  });

  test("the scan catches the bug it was written for", () => {
    /* Checked by putting the bug back by hand: this is the form `Thread.svelte`
       carried — a note between two `{@const}` lines in the snippet's markup. */
    const broken = [
      "<script>const x = 1;</script>",
      "{#snippet letter(a: string)}",
      "  /* a note about the snippet */",
      "  {@const of = a}",
      "  <div>{of}</div>",
      "{/snippet}",
    ].join("\n");
    expect(strayComments(broken)).toHaveLength(2);

    const commented = broken.replace(
      "/* a note about the snippet */",
      "<!-- a note about the snippet -->",
    );
    expect(strayComments(commented)).toEqual([]);

    /* Inside an expression a block comment is JavaScript, and a glob in prose
       is a glob: neither is the bug. */
    expect(strayComments("{@const of = (() => { /* fine */ return 1 })()}")).toEqual([]);
    expect(strayComments("<span>src/billing/**</span>")).toEqual([]);

    const slashes = "<div>\n  // not a comment here\n</div>";
    expect(strayComments(slashes)).toHaveLength(1);
  });
});
