import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GONE, handleTip, isCardAddress, shortHandle, whoIs } from "../src/lib/whois";
import {
  describeTool,
  NAMES_A_CARD,
  SKEIN_CLOSE_TOOL,
  SKEIN_RECALL_TOOL,
  SKEIN_SEND_TOOL,
  SKEIN_TIMELINE_TOOL,
} from "../src/lib/classify";

describe("what a card named by its handle is called", () => {
  test("the wall's sighting first, by its current title", () => {
    expect(whoIs({ title: "NOVA Coordinator" }, "an old name")).toBe("NOVA Coordinator");
    expect(whoIs({ title: "  the build ", closed: true })).toBe("the build");
  });

  test("an untitled card the wall knows is still a card, not a handle", () => {
    const n = whoIs({ title: "untitled" });
    expect(n).not.toMatch(/[0-9a-f]{8}/);
    expect(n).not.toBe(GONE);
  });

  test("then the name its source carried, then gone — never the handle", () => {
    expect(whoIs(null, "NOVA Coordinator")).toBe("NOVA Coordinator");
    expect(whoIs(null, "  ")).toBe(GONE);
    expect(whoIs(null)).toBe(GONE);
    expect(GONE).toBe("a card no longer on the wall");
  });

  test("the handle is the tooltip's", () => {
    expect(handleTip("6f90401a")).toBe("card 6f90401a");
  });

  test("a handle from this wall's id and from another wall's key", () => {
    expect(shortHandle("6f90401a-1111-2222-3333-444455556666")).toBe("6f90401a");
    expect(shortHandle("elsewhere:AU-LT-288:abcdef01-0000-0000-0000-000000000000")).toBe("abcdef01");
  });

  test("an address is a card's id or handle, never a title or a broadcast word", () => {
    for (const a of ["6f90401a", "6F90401A", "6f90401a-1111", "6f90401a-1111-2222-3333-444455556666"]) {
      expect(isCardAddress(a)).toBe(true);
    }
    for (const a of ["project", "skein", "NOVA Coordinator", "6f9040", "deadbeefcafe-and-more-than-36-chars-long"]) {
      expect(isCardAddress(a)).toBe(false);
    }
  });

  test("a tool line names the card it addressed through the resolver it is given", () => {
    const nameOf = (a: string) => (a === "6f90401a" ? "NOVA Coordinator" : a);
    expect(describeTool("mcp__skein__send", { to: "6f90401a" }, nameOf)).toBe("messaged NOVA Coordinator");
    expect(describeTool("mcp__skein__send", { to: ["6f90401a"] }, nameOf)).toBe("messaged NOVA Coordinator");
    expect(describeTool("mcp__skein__recall", { card: "6f90401a" }, nameOf)).toBe("read NOVA Coordinator's words");
    expect(describeTool("mcp__skein__close", { card: "6f90401a" }, nameOf)).toBe("closed NOVA Coordinator");
    expect(describeTool("mcp__skein__send", { to: "project" }, nameOf)).toBe("told the project");
  });

  /* The set a surface re-describes at draw time, because the fold ran before a
     closed card's name could be known. It must be exactly the tools whose line
     goes through `nameOf` — one missing is a line frozen with GONE about a
     card the store knows, which is what the lab showed before it existed. */
  test("the tools re-described at draw time are the ones whose line names a card", () => {
    expect([...NAMES_A_CARD].sort()).toEqual(
      [SKEIN_SEND_TOOL, SKEIN_RECALL_TOOL, SKEIN_CLOSE_TOOL, SKEIN_TIMELINE_TOOL].sort(),
    );
    const marker = () => "NAMED";
    for (const name of NAMES_A_CARD) {
      const input = { to: "6f90401a", card: "6f90401a" };
      expect(describeTool(name, input, marker)).toContain("NAMED");
    }
  });
});

/* The guard, in the shape of `test/finding.test.ts`: a capability every surface
   should have is not something each surface remembers. A handle drawn as text
   is the omission this file exists to make impossible to commit quietly —
   Lyss, 2026-10-21, "some ids are still showing raw", after five surfaces had
   each drawn one their own way.

   Every `.svelte` file's markup is walked as markup: text outside tags, and the
   `{…}` expressions in it, brace- and quote-aware so an attribute holding an
   arrow function cannot hide a `>` (the trap `finding.test.ts` records falling
   into twice). An expression in *visible text* that reaches for a handle fails.
   Attributes are deliberately not checked: a `title` is where the handle
   belongs — the copyable detail, `handleTip`. */

const SRC = join(import.meta.dir, "..", "src");

function svelteFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) svelteFiles(p, out);
    else if (e.name.endsWith(".svelte")) out.push(p);
  }
  return out;
}

/** The `{…}` expressions written in a template's text, outside every tag. */
export function textExpressions(source: string): string[] {
  const tpl = source
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const out: string[] = [];
  let i = 0;
  /* Read a balanced `{…}` starting at `i`, quote-aware. */
  const block = (at: number): [string, number] => {
    let depth = 0;
    let q: string | null = null;
    for (let j = at; j < tpl.length; j++) {
      const c = tpl[j];
      if (q) {
        if (c === "\\") j++;
        else if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") q = c;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return [tpl.slice(at + 1, j), j + 1];
    }
    return [tpl.slice(at + 1), tpl.length];
  };
  while (i < tpl.length) {
    const c = tpl[i];
    if (c === "<" && /[A-Za-z/!]/.test(tpl[i + 1] ?? "")) {
      /* Skip a tag whole: quotes and `{…}` inside it are attributes. */
      let j = i + 1;
      let q: string | null = null;
      while (j < tpl.length) {
        const d = tpl[j];
        if (q) {
          if (d === q) q = null;
          j++;
        } else if (d === '"' || d === "'") {
          q = d;
          j++;
        } else if (d === "{") j = block(j)[1];
        else if (d === ">") break;
        else j++;
      }
      i = j + 1;
    } else if (c === "{") {
      const [expr, next] = block(i);
      /* Logic blocks and declarations are not text; `{@html}` would be. */
      if (!/^\s*[#/:]/.test(expr) && !/^\s*@(const|render|debug|attach)\b/.test(expr)) out.push(expr.trim());
      i = next;
    } else i++;
  }
  return out;
}

/** An expression that draws a card's handle, or an id cut down to one. */
const REACHES_FOR_A_HANDLE = /(?:^|[^\w$])(?:\w+\.)?handle\b|\.slice\(\s*0\s*,\s*8\s*\)|\b(?:handleOf|shortHandle|cardHandle)\(/;

describe("no surface draws a card's handle as text", () => {
  test("the scanner finds text expressions and skips tags, blocks and attributes", () => {
    const src = `<script>const handle = "x";</script>
<b title={handle} onclick={() => a > b}>{name}</b>{#if handle}{handle}{/if}
<i>{c.id.slice(0, 8)}</i>{@const h = handle}{@render x(handle)}`;
    expect(textExpressions(src)).toEqual(["name", "handle", "c.id.slice(0, 8)"]);
    expect(textExpressions(src).filter((e) => REACHES_FOR_A_HANDLE.test(e))).toEqual([
      "handle",
      "c.id.slice(0, 8)",
    ]);
  });

  for (const f of svelteFiles(SRC)) {
    test(f.slice(SRC.length + 1), () => {
      const hits = textExpressions(readFileSync(f, "utf8")).filter((e) => REACHES_FOR_A_HANDLE.test(e));
      expect(hits).toEqual([]);
    });
  }
});

/* The other road a handle took to the screen: a string built in a `.ts` file
   and drawn by a component that never sees the id — `board.ts::author` fell
   back to `notice.from.slice(0, 8)`, `Gatehouse` to `r.card.slice(0, 8)`. So
   cutting an id down to a handle is allowed in exactly the places that define
   what a handle is, and the one place it is the useful answer: a refusal saying
   another wall has no such card, where there is no name to give. */
describe("an id is cut to a handle only where a handle is the point", () => {
  const ALLOWED = new Map([
    ["lib/relay.ts", "handleOf — the definition, must agree with relay::handle_of"],
    ["lib/whois.ts", "shortHandle — the definition the resolver keys on"],
    ["lib/shadows.svelte.ts", "a refusal naming a card this wall does not have"],
  ]);
  const all: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|svelte)$/.test(e.name)) all.push(p);
    }
  };
  walk(SRC);
  test("nowhere else", () => {
    const strays = all
      .filter((f) => /\.slice\(\s*0\s*,\s*8\s*\)/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(SRC.length + 1).replaceAll("\\", "/"))
      .filter((f) => !ALLOWED.has(f));
    expect(strays).toEqual([]);
  });
});
