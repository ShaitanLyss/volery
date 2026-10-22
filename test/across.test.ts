/* A card on another wall counts its paths from a root that names it, and the
 * few places that act on a root send its questions there (`src/lib/across.ts`).
 * The first half of this file is that arithmetic. The second half is the
 * reason it exists: Lyss's "by construction, with no omission possible" is a
 * claim about *where* the decision is made, so these read the components and
 * fail the day a surface works out its own root again, or the day knowing
 * about another wall spreads past the files allowed to know. Each guard was
 * watched to fail with the old code put back by hand. */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afarRoot, isHere, readAfar } from "../src/lib/across";
import { keptSource, placeOf, proseSource, sourceKey } from "../src/lib/showing";

describe("a root naming a card on another wall", () => {
  test("comes back as the wall and the card it was made from", () => {
    expect(readAfar(afarRoot("lab-b.queerisfreedom", "c1"))).toEqual({ host: "lab-b.queerisfreedom", card: "c1" });
    /* A host is free text: a slash or a colon in it is not a separator. */
    const odd = afarRoot("AU/LT:288 ü", "x/y");
    expect(readAfar(odd)).toEqual({ host: "AU/LT:288 ü", card: "x/y" });
  });

  test("is never a directory here, and a directory is never one of it", () => {
    for (const here of ["C:\\atelier\\skein", "/home/x", "\\\\host\\share", "relative/dir"]) {
      expect(readAfar(here)).toBeNull();
      expect(isHere(here)).toBe(true);
    }
    const far = afarRoot("lab", "c1");
    expect(isHere(far)).toBe(false);
    /* Mangled: neither a card to ask nor a directory to read. */
    for (const bad of ["volery-afar:", "volery-afar:lab", "volery-afar:lab/c/d", "volery-afar:%E0/c"]) {
      expect(readAfar(bad)).toBeNull();
      expect(isHere(bad)).toBe(false);
    }
    expect(isHere(null)).toBe(false);
    expect(isHere("")).toBe(false);
  });
});

describe("where a picture is read from", () => {
  const far = afarRoot("lab", "c1");

  test("prose under a root here is a file here, made whole", () => {
    expect(proseSource("C:\\p", "shots\\a.png")).toEqual({ kind: "file", path: "C:\\p\\shots\\a.png" });
    expect(proseSource(null, "a.png")).toBeNull();
    expect(proseSource(null, "data:image/png;base64,AAAA")).toEqual({ kind: "data", url: "data:image/png;base64,AAAA" });
  });

  test("prose under a far root is asked of that wall, as the card wrote it", () => {
    expect(proseSource(far, "shots\\a.png")).toEqual({ kind: "afar", host: "lab", card: "c1", kept: null, path: "shots\\a.png" });
    /* Never made whole here: this disk's spelling of that wall's path is
       exactly the wrong file of the right name. */
    expect(JSON.stringify(proseSource(far, "a.png"))).not.toContain("volery-afar");
  });

  test("a kept copy is this studio's here and that wall's there", () => {
    const id = "0b6f3b0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b.png";
    expect(keptSource("C:\\p", id, "a.png")).toEqual({ kind: "kept", id, path: "C:\\p\\a.png" });
    /* No root still reads the copy — it never needed one. */
    expect(keptSource(null, id, "a.png")).toEqual({ kind: "kept", id, path: "a.png" });
    expect(keptSource(far, id, "a.png")).toEqual({ kind: "afar", host: "lab", card: "c1", kept: id, path: "a.png" });
  });

  test("a figure's plate names the path its card wrote, whole only here", () => {
    expect(placeOf("C:\\p", "a.pdf")).toBe("C:\\p\\a.pdf");
    expect(placeOf(far, "a.pdf")).toBe("a.pdf");
    expect(placeOf(null, "a.pdf")).toBe("a.pdf");
  });

  test("two walls' or two cards' pictures of one name are two pictures", () => {
    const a = proseSource(afarRoot("lab", "c1"), "a.png")!;
    const b = proseSource(afarRoot("lab", "c2"), "a.png")!;
    const c = proseSource(afarRoot("box", "c1"), "a.png")!;
    expect(new Set([sourceKey(a), sourceKey(b), sourceKey(c)]).size).toBe(3);
  });
});

/* ── the guards ────────────────────────────────────────────────────────── */

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p, ext));
    else if (ext.test(e.name)) out.push(p.replaceAll("\\", "/"));
  }
  return out;
}

/** The whole of an expression starting at `from`, braces balanced — the
 *  argument of a call written across several lines. */
function balanced(src: string, from: number): string {
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "{") depth++;
    else if (c === ")" || c === "}") {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return src.slice(from);
}

/** A component's opening tag, braces and all (`finding.test.ts`'s scanner,
 *  for its reason: an arrow function's `>` walks through a regex). */
function tags(src: string, tag: string): string[] {
  const out: string[] = [];
  const open = new RegExp(`<${tag}\\b`, "g");
  for (let m = open.exec(src); m; m = open.exec(src)) {
    let depth = 0;
    for (let i = m.index; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) {
        out.push(src.slice(m.index, i + 1));
        break;
      }
    }
  }
  return out;
}

const components = files("src", /\.svelte$/);
const modules = files("src", /\.ts$/);
const read = (p: string) => readFileSync(p, "utf8");

describe("a surface says whose words it draws, and never works out where they are", () => {
  test("every file scope is a card's own root, or one of the three that are not about a card", () => {
    expect(components.length).toBeGreaterThan(20);
    /* Not about a card: the finder's project, a list whose rows each name a
       root, and nothing else. */
    const notACard = new Set(["src/lib/Spyglass.svelte", "src/lib/FileScope.svelte"]);
    let checked = 0;
    for (const c of components) {
      const src = read(c);
      for (let i = src.indexOf("scopeFiles("); i >= 0; i = src.indexOf("scopeFiles(", i + 1)) {
        if (src.slice(Math.max(0, i - 9), i).includes("import")) continue;
        const call = balanced(src, i + "scopeFiles".length);
        /* A comment that names the function is not a call. */
        if (/^\(\)\s*$/.test(call) || call.length < 4) continue;
        checked++;
        /* The old spelling — a directory worked out off `cwd` and `kind`, which
           a card on another wall had no answer to. */
        expect(`${c}: ${call}`).not.toMatch(/\bcwd\b/);
        if (!notACard.has(c)) expect(`${c}: ${call}`).toMatch(/\.root\b/);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(6);
  });

  test("a picture has its own scope only in a document, whose pictures count from its folder", () => {
    const using = components.filter((c) => /\bscopePictures\(\s*\(/.test(read(c)));
    expect(using).toEqual(["src/lib/Leaf.svelte"]);
  });

  test("a figure and a picture in prose are told where to read by one function each", () => {
    const fig = read("src/lib/Figure.svelte");
    const pics = tags(fig, "InlinePicture");
    expect(pics.length).toBe(1);
    expect(pics[0]).toMatch(/source=\{keptSource\(/);
    /* The refusal it used to draw for a card on another wall. */
    expect(fig).not.toMatch(/its copy is kept\s+there/);
    expect(fig).not.toMatch(/state === "picture" && !root/);
    expect(read("src/lib/Inlines.svelte")).toMatch(/proseSource\(pictureRoot\(\), src\)/);
  });

  test("only the picture reads a picture", () => {
    const reads = /invoke(?:<[^>]*>)?\(\s*"(read_shown|read_picture|measure_picture|flyway_see_picture|flyway_see_measure)"/;
    const readers = [...components, ...modules].filter((f) => reads.test(read(f)));
    expect(readers).toEqual(["src/lib/InlinePicture.svelte"]);
  });

  test("a tool call is handed neither a root nor a way to open a file", () => {
    const call = read("src/lib/ToolCall.svelte");
    const props = call.slice(call.indexOf("$props()") - 1200, call.indexOf("$props()"));
    expect(props).not.toMatch(/^\s*(root|onfile)\??:/m);
    let checked = 0;
    for (const c of components) {
      for (const t of tags(read(c), "ToolCall")) {
        checked++;
        expect(t).not.toMatch(/\b(root|onfile)=/);
      }
    }
    expect(checked).toBeGreaterThan(0);
    /* And the card has nothing to hand one: the gesture is the file scope's. */
    expect(read("src/lib/cards.svelte.ts")).not.toMatch(/\blook\??:\s*\(/);
  });
});

describe("knowing a card is on another wall stays in the few places that act on a root", () => {
  test("a far root is read only where a question is sent", () => {
    const allowed = new Set([
      "src/lib/across.ts", // the spelling
      "src/lib/showing.ts", // where a picture is read from
      "src/lib/paths.svelte.ts", // is it a file, which file is that name, the pull
      "src/App.svelte", // opening one
    ]);
    const readers = [...components, ...modules].filter((f) => /\breadAfar\(/.test(read(f)));
    expect(readers.length).toBeGreaterThan(2);
    for (const f of readers) expect(allowed.has(f) ? f : `${f} reads a far root`).toBe(f);
    const makers = [...components, ...modules].filter((f) => /\bafarRoot\(/.test(read(f)));
    for (const f of makers) expect(["src/lib/across.ts", "src/lib/shadows.svelte.ts"]).toContain(f);
  });
});
