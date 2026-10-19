import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { countSaid, gistOf, type GistSource } from "../src/lib/gist";
import { digestOf, GIST_KEYS, readDigest, readGist, wireGist, type DigestSource } from "../src/lib/shadow";

/* Lyss, 2026-10-19: "remote cards report 0 tok and 0 turns, it shouldn't have
   been possible, we need a structural fix." The structure is `gist.ts`: what a
   surface draws about a conversation is one shape, a card here and a card
   elsewhere produce it, and the digest is that shape spread whole. These hold
   the three ways it could come apart again — the digest leaving a fact out, a
   shadow answering one with a constant, a surface reaching past the shape into
   a `Conversation` a card on another wall does not have. */

const source = (over: Partial<DigestSource> = {}): DigestSource => ({
  id: "c1",
  title: "t",
  project: "skein",
  territory: "skein",
  kind: "chat",
  tier: "work",
  ending: null,
  dormant: false,
  working: true,
  aside: false,
  gear: "planning",
  model: "claude-haiku-4-5",
  effort: "high",
  accountLabel: "tx-team",
  bypassCaps: true,
  activity: "reading",
  held: { why: "every account is spent", until: 9_000, waiting: "allowance", queue: [1, 2] },
  stalled: false,
  unacknowledged: false,
  restingSince: null,
  ctx: 0.25,
  ctxTokens: 50_000,
  turns: 12,
  costUsd: 3.456,
  compactFrac: 0.42,
  turnSince: 4_000,
  holding: { excess: 2, fleet: 5 },
  lines: [],
  jobs: [],
  pendingWakes: [],
  asks: [],
  ...over,
});

describe("the digest carries every fact a surface draws", () => {
  test("a digest holds every key of the gist, and reads back to the same gist", () => {
    const d = digestOf(source());
    for (const k of GIST_KEYS) expect(Object.keys(d)).toContain(k);
    const back = readDigest(JSON.parse(JSON.stringify(d)))!;
    const sent = wireGist(gistOf(source()));
    for (const k of GIST_KEYS) expect([k, back[k]]).toEqual([k, sent[k]]);
    expect(back).toMatchObject({ ctxTokens: 50_000, turns: 12, costUsd: 3.46, kind: "chat", planning: true });
  });

  test("the reader covers exactly what gistOf makes — no key made and not read, none read and not made", () => {
    expect(Object.keys(gistOf(source())).sort()).toEqual([...GIST_KEYS].sort());
  });

  test("a wall from before a fact sends nothing, and that reads as unknown — never as zero", () => {
    /* What a 0.65 wall's digest has, and nothing of the gist past it. */
    const old = readGist({ kind: "project", planning: false, model: "opus", ctx: 0.3 });
    expect(old.ctxTokens).toBeNull();
    expect(old.turns).toBeNull();
    expect(old.costUsd).toBeNull();
    expect(old.turnSince).toBeNull();
    expect(old.held).toBeNull();
    expect(countSaid(old.turns)).toBe("—");
    expect(countSaid(0)).toBe("0");
  });

  test("a value off the wire is held to its shape", () => {
    const g = readGist({ ctxTokens: -5, turns: "7", costUsd: Infinity, compactFrac: 3, held: { why: 4, queue: 1e9 } });
    expect([g.ctxTokens, g.turns, g.costUsd, g.compactFrac]).toEqual([null, null, null, 1]);
    expect(g.held).toEqual({ why: "", until: null, waiting: "allowance", queue: 99 });
  });

  test("a turn's moment is a fact only while it works", () => {
    expect(gistOf(source({ working: false })).turnSince).toBeNull();
  });

  test("what changes every token or every second is rounded before it is sent", () => {
    const a = wireGist(gistOf(source({ compactFrac: 0.41, costUsd: 3.4561 })));
    const b = wireGist(gistOf(source({ compactFrac: 0.42, costUsd: 3.4569 })));
    expect([a.compactFrac, a.costUsd]).toEqual([b.compactFrac, b.costUsd]);
  });
});

const LIB = join(import.meta.dir, "../src/lib");
const read = (f: string) => readFileSync(join(LIB, f), "utf8");

/* The fields a surface could reach a `Conversation` for, by both spellings:
   the gist's own keys, and the two a `Conversation` names differently. */
const FIELDS = [...GIST_KEYS, "gear", "accountLabel"];
const reach = new RegExp(String.raw`\.conv\??\.(${FIELDS.join("|")})\b`);

describe("a surface reads the gist, never past it", () => {
  /* Every component, since a new surface is exactly the one nobody would
     think to add to a list. `.conv` is still the road for a gesture — a send,
     a selection, a path on this disk — and none of those is a field here. */
  const components = [...readdirSync(LIB).filter((f) => f.endsWith(".svelte")).map((f) => [f, read(f)] as const),
    ["App.svelte", readFileSync(join(import.meta.dir, "../src/App.svelte"), "utf8")] as const];

  test("no component reads a drawn fact through `.conv`", () => {
    const hits = components.flatMap(([f, src]) =>
      src.split("\n").flatMap((line, i) => (reach.test(line) ? [`${f}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(hits).toEqual([]);
  });

  test("nor through a name it gave `.conv`", () => {
    /* `const conv = $derived(card?.conv ?? null)` and `{@const conv =
       card.conv}` — ModelMenu drew a card's model through the first, and a card
       elsewhere then drew no model chip at all. */
    const hits: string[] = [];
    for (const [f, src] of components) {
      const names = [
        ...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*\$derived\(\s*\w+\??\.conv\b[^;\n]*\)/g),
        ...src.matchAll(/\{@const\s+(\w+)\s*=\s*\w+\??\.conv\s*\}/g),
      ].map((m) => m[1]);
      for (const name of names) {
        const via = new RegExp(String.raw`\b${name}\??\.(${FIELDS.join("|")})\b`);
        src.split("\n").forEach((line, i) => {
          if (via.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("a shadow answers a drawn fact from its gist, never with a constant", () => {
  test("no field of the gist is a constant on `Shadow`", () => {
    /* `readonly turns = 0` was the bug: a card on another wall drawing "0
       turns" about a conversation that had taken forty. */
    const src = read("shadows.svelte.ts");
    const shadow = src.slice(src.indexOf("export class Shadow"), src.indexOf("export class Elsewhere"));
    const consts = FIELDS.filter((k) => new RegExp(String.raw`^\s*readonly ${k}\s*=`, "m").test(shadow));
    expect(consts).toEqual([]);
  });
});
