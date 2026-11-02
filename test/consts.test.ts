import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/* `{@const held = unfinished}` reads like a copy and is not one. Svelte 5
   compiles it to `$.derived(() => $.get(unfinished))`, so a handler that lets
   go of the state and then reads the const reads it afresh — as null:

     onclose={() => { unfinished = null; void held.card.do("close", …) }}

   threw `Cannot read properties of null (reading 'card')`. The plate went away
   and the card stayed — so on 2026-11-02 no card with a plan in flight, or with
   work in hand, could be closed from its ✕ at all, and Lyss reported it as a
   card that "won't let me close it". The move-all plate had the same line.
   Nothing failed anywhere a test or the type checker could see: `held` is typed
   as never null inside the `{#if}`.

   The rule: inside a block, a handler that writes the state a `{@const}` is
   made from must read what it needs *before* that write.

   What this scan sees: a `{@const name = state}` whose right side is a name or
   a dotted path (`a.b`, with or without a trailing `!`), any plain assignment
   to that state later in the same block (nested blocks included), and any read
   of `name` after it in the same handler — found by counting brackets, not by
   looking for a closing pair. What it cannot see: a write made inside a
   function the handler calls (`dismiss(); held.card…`). Read every const a
   handler needs on its first line and that case is covered too.

   Checked to fail with both of App.svelte's lines put back as they were. */

const SRC = "src";

function components(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...components(p));
    else if (e.name.endsWith(".svelte")) out.push(p);
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where the block that `from` sits in ends: the `{/…}` that closes it, with
 *  every block opened in between closed first. The end of the text if none. */
function blockEnd(text: string, from: number): number {
  let depth = 0;
  for (const m of text.slice(from).matchAll(/\{([#/])/g)) {
    if (m[1] === "#") depth++;
    else if (depth-- === 0) return from + m.index!;
  }
  return text.length;
}

/** What runs after `from` in the handler it is inside: up to the bracket that
 *  closes the handler's own `{`, `(` or `[` — counted, with quoted strings
 *  skipped, so a nested object or a call in a template is not mistaken for the
 *  end. A handler with no brackets of its own (`() => x = null`) ends at the
 *  attribute's `}`. */
function restOfHandler(text: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if ("{([".includes(ch)) depth++;
    else if ("})]".includes(ch) && depth-- === 0) return text.slice(from, i);
  }
  return text.slice(from);
}

export type Scan = { found: string[]; writes: { name: string; state: string }[] };

export function scanConsts(source: string): Scan {
  const found: string[] = [];
  const writes: Scan["writes"] = [];
  for (const m of source.matchAll(/\{@const\s+(\w+)\s*=\s*([\w$]+(?:\.[\w$]+)*)!?\s*\}/g)) {
    const [, name, state] = m;
    const start = m.index! + m[0].length;
    const block = source.slice(start, blockEnd(source, start));
    /* An assignment, not a comparison or an arrow, to the state itself and not
       to a longer name that ends in it. */
    const write = new RegExp(`(?<![\\w$.])${escape(state)}\\s*=(?![=>])`, "g");
    const read = new RegExp(`(?<![\\w$.])${escape(name)}\\b`);
    for (const w of block.matchAll(write)) {
      writes.push({ name, state });
      if (read.test(restOfHandler(block, w.index! + w[0].length))) {
        found.push(`${name} (of ${state}) read after writing \`${state}\``);
      }
    }
  }
  return { found, writes };
}

const plate = (handler: string, keep = "onkeep={() => (unfinished = null)}", between = "") => `{#if unfinished}
    {@const held = unfinished}
    ${between}
    <Unfinished ${keep} onclose={() => {
        ${handler}
      }} />
  {/if}`;

describe("a {@const} is a derived, not a copy", () => {
  test("the shape that broke the close plate is found, and the fix is not", () => {
    expect(scanConsts(plate(`unfinished = null;\n void held.card.do("close", { sure: true });`)).found).toEqual([
      "held (of unfinished) read after writing `unfinished`",
    ]);
    expect(scanConsts(plate(`const card = held.card;\n unfinished = null;\n void card.do("close", { sure: true });`)).found).toEqual([]);
  });

  test("whatever the state is set to, and however the block is shaped", () => {
    const bad = (h: string, keep?: string, between?: string) => scanConsts(plate(h, keep, between)).found.length;
    expect(bad(`unfinished = undefined; held.card.go();`)).toBe(1);
    expect(bad(`unfinished = false; held.card.go();`)).toBe(1);
    /* A nested block between the const and the handler. */
    expect(bad(`unfinished = null; held.card.go();`, undefined, `{#if held.t}<p>{held.t}</p>{/if}`)).toBe(1);
    /* Brackets after the write that close something else first. */
    expect(bad(`unfinished = null; go({ a: { b: 1 }}); say(\`x \${f()}\`); held.card.go();`)).toBe(1);
    /* A dotted state, and a non-null assertion. */
    expect(scanConsts(`{#if a.b}{@const held = a.b}<X on={() => { a.b = null; held.go(); }} />{/if}`).found.length).toBe(1);
    expect(scanConsts(`{#if u}{@const held = u!}<X on={() => { u = null; held.go(); }} />{/if}`).found.length).toBe(1);
  });

  test("what is not the shape is not reported", () => {
    const bad = (h: string, keep?: string) => scanConsts(plate(h, keep)).found;
    /* A bare arrow that only lets go, next to a handler that reads first. */
    expect(bad(`const c = held.card; unfinished = null; c.go();`, "onkeep={() => unfinished = null}")).toEqual([]);
    /* A property of the same name, a comparison, and a longer name. */
    expect(bad(`unfinished = null; skein.held.clear();`)).toEqual([]);
    expect(bad(`if (unfinished == null) held.go();`)).toEqual([]);
    expect(bad(`notunfinished = null; held.go();`)).toEqual([]);
  });

  test("no component reads a const after letting go of what it is made from", () => {
    const bad: string[] = [];
    const examined: string[] = [];
    for (const file of components(SRC)) {
      const scan = scanConsts(readFileSync(file, "utf8"));
      for (const f of scan.found) bad.push(`${file}: ${f}`);
      for (const w of scan.writes) examined.push(`${file.replaceAll("\\", "/")}: ${w.name} of ${w.state}`);
    }
    expect(bad).toEqual([]);
    /* And the two plates this was written for are among what it looked at, so
       a rewrite into a shape the scan cannot read fails here instead of
       passing on nothing. */
    expect(examined).toContain("src/App.svelte: held of unfinished");
    expect(examined).toContain("src/App.svelte: going of exodus");
  });
});
