import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/* Chat view's tokens (`docs/chat-mode.md` §8.1, §9.1): `--cv-*`, and the
   motion vocabulary `--dur-*` / `--ease-*`. What `test/theme.test.ts` asserts
   of the reading knobs, asserted of these — it iterates the registered `KNOBS`
   only, so it never saw them:

   - **declared** in `tokens.css`, so every skin reaches them;
   - **consumed** by some component's rule, so none is a token nobody draws
     with (the ones a later phase draws are declared with it, not ahead);
   - **never read bare**: every `var(--cv-x)` in a component carries a
     fallback, so the component draws correctly with no `tokens.css` in front
     of it — the same bargain every reading knob already strikes. */

const SRC = "src";
const PREFIX = /--(cv|dur|ease)-[a-z0-9-]+/;

function components(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...components(p));
    else if (e.name.endsWith(".svelte")) out.push(p);
  }
  return out.sort();
}

const tokens = readFileSync(join(SRC, "lib", "tokens.css"), "utf8");
const declared = [
  ...new Set(
    [...tokens.matchAll(/^\s*(--(?:cv|dur|ease)-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]),
  ),
];
const sheets = components(SRC).map((f) => ({ f, src: readFileSync(f, "utf8") }));

describe("chat view's tokens", () => {
  test("there are some to check", () => {
    expect(declared.length).toBeGreaterThan(15);
    expect(declared).toContain("--cv-sheet");
    expect(declared).toContain("--dur-stage");
  });

  for (const t of declared) {
    test(`${t} is drawn with somewhere`, () => {
      const used = sheets.some(({ src }) => src.includes(`var(${t},`) || src.includes(`var(${t})`));
      expect(used).toBe(true);
    });
  }

  test("every read in a component carries a fallback", () => {
    const bare: string[] = [];
    for (const { f, src } of sheets) {
      for (const m of src.matchAll(/var\((--(?:cv|dur|ease)-[a-z0-9-]+)\)/g)) bare.push(`${f}: ${m[1]}`);
    }
    expect(bare).toEqual([]);
  });

  test("every token a component reads is declared", () => {
    const missing = new Set<string>();
    for (const { src } of sheets) {
      for (const m of src.matchAll(/var\((--(?:cv|dur|ease)-[a-z0-9-]+)/g)) {
        if (!declared.includes(m[1]) && PREFIX.test(m[1])) missing.add(m[1]);
      }
    }
    expect([...missing]).toEqual([]);
  });
});
