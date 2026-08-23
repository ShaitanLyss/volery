import { expect, test, describe } from "bun:test";
import {
  parseInline,
  parseMarkdown,
  runIn,
  safeHref,
  StreamedMarkdown,
  type Block,
  type Inline,
} from "../src/lib/markdown";

/** Flatten a tree back to its words, so a test can say what a block *reads* as
 *  without spelling out every node. */
function words(kids: Inline[]): string {
  return kids
    .map((k) =>
      k.t === "text" ? k.v : k.t === "code" ? k.v : words((k as any).kids),
    )
    .join("");
}

const p = (b: Block) => (b.t === "p" ? words(b.kids) : `«${b.t}»`);

describe("blocks", () => {
  test("plain prose is one paragraph", () => {
    const [b] = parseMarkdown("just a sentence.");
    expect(b).toMatchObject({ t: "p" });
    expect(p(b)).toBe("just a sentence.");
  });

  test("a blank line separates paragraphs", () => {
    const bs = parseMarkdown("one\n\ntwo");
    expect(bs.map(p)).toEqual(["one", "two"]);
  });

  test("a single newline stays inside the paragraph", () => {
    /* GFM's `breaks`: an agent's own line breaks carry meaning in a chat
       transcript, so they survive rather than collapsing to a space. */
    const bs = parseMarkdown("one\ntwo");
    expect(bs).toHaveLength(1);
    expect(p(bs[0])).toBe("one\ntwo");
  });

  test("atx headings carry their level", () => {
    const bs = parseMarkdown("# one\n\n### three");
    expect(bs[0]).toMatchObject({ t: "h", level: 1 });
    expect(bs[1]).toMatchObject({ t: "h", level: 3 });
    expect(words((bs[1] as any).kids)).toBe("three");
  });

  test("a closing run of hashes is decoration", () => {
    const [b] = parseMarkdown("## title ##");
    expect(words((b as any).kids)).toBe("title");
  });

  test("#hashtag is not a heading", () => {
    expect(parseMarkdown("#nope")[0].t).toBe("p");
  });

  test("thematic breaks", () => {
    expect(parseMarkdown("---")[0]).toEqual({ t: "hr" });
    expect(parseMarkdown("***")[0]).toEqual({ t: "hr" });
    expect(parseMarkdown("- - -")[0]).toEqual({ t: "hr" });
  });

  test("a fenced block keeps its text verbatim", () => {
    const [b] = parseMarkdown("```ts\nconst a = 1;\n*not em*\n```");
    expect(b).toEqual({
      t: "code",
      lang: "ts",
      text: "const a = 1;\n*not em*",
      open: false,
    });
  });

  test("an unclosed fence is a code block already, and says so", () => {
    /* Mid-stream this is the ordinary state. Waiting for the closer would make
       every code block appear first as a paragraph of literal backticks. */
    const [b] = parseMarkdown("```\nhalf a fun");
    expect(b).toMatchObject({ t: "code", text: "half a fun", open: true });
  });

  test("a fence is de-indented by its own margin", () => {
    const [b] = parseMarkdown("  ```\n  indented\n  ```");
    expect((b as any).text).toBe("indented");
  });

  test("tildes fence too, and backticks inside them are text", () => {
    const [b] = parseMarkdown("~~~\n```\n~~~");
    expect(b).toMatchObject({ t: "code", text: "```", open: false });
  });

  test("blockquotes nest their own blocks", () => {
    const [b] = parseMarkdown("> quoted **hard**\n> still");
    expect(b.t).toBe("quote");
    expect(p((b as any).kids[0])).toBe("quoted hard\nstill");
  });
});

describe("lists", () => {
  test("bullets become items", () => {
    const [b] = parseMarkdown("- one\n- two\n- three");
    expect(b).toMatchObject({ t: "list", ordered: false, tight: true });
    expect((b as any).items.map((it: Block[]) => p(it[0]))).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  test("an ordered list remembers where it starts", () => {
    const [b] = parseMarkdown("3. three\n4. four");
    expect(b).toMatchObject({ t: "list", ordered: true, start: 3 });
    expect((b as any).items).toHaveLength(2);
  });

  test("blank lines between items make it loose", () => {
    const [b] = parseMarkdown("- one\n\n- two");
    expect(b).toMatchObject({ t: "list", tight: false });
    expect((b as any).items).toHaveLength(2);
  });

  test("an indented list is nested inside its item", () => {
    const [b] = parseMarkdown("- outer\n  - inner\n  - also\n- next");
    const items = (b as any).items as Block[][];
    expect(items).toHaveLength(2);
    expect(p(items[0][0])).toBe("outer");
    expect(items[0][1]).toMatchObject({ t: "list" });
    expect((items[0][1] as any).items).toHaveLength(2);
  });

  test("a wrapped item keeps its continuation", () => {
    const [b] = parseMarkdown("- one that runs\n  on a bit\n- two");
    expect(p((b as any).items[0][0])).toBe("one that runs\non a bit");
  });

  test("switching marker kind starts a new list", () => {
    const bs = parseMarkdown("- a\n1. b");
    expect(bs.map((x) => x.t)).toEqual(["list", "list"]);
    expect(bs[1]).toMatchObject({ ordered: true });
  });

  test("a fence inside an item is that item's code", () => {
    const [b] = parseMarkdown("- run this:\n  ```\n  bun test\n  ```\n- then that");
    const items = (b as any).items as Block[][];
    expect(items).toHaveLength(2);
    expect(items[0][1]).toMatchObject({ t: "code", text: "bun test" });
  });

  test("prose after a list is not swallowed by it", () => {
    const bs = parseMarkdown("- a\n- b\n\nafter");
    expect(bs.map((x) => x.t)).toEqual(["list", "p"]);
    expect(p(bs[1])).toBe("after");
  });
});

describe("tables", () => {
  const src = [
    "| file | what |",
    "| --- | ---: |",
    "| `a.ts` | one |",
    "| b.ts | two |",
  ].join("\n");

  test("a delimiter row makes the rows above and below a table", () => {
    const [b] = parseMarkdown(src);
    expect(b.t).toBe("table");
    const t = b as any;
    expect(t.head.map(words)).toEqual(["file", "what"]);
    expect(t.align).toEqual([null, "right"]);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0].map(words)).toEqual(["a.ts", "one"]);
  });

  test("cells are inline-parsed", () => {
    const [b] = parseMarkdown(src);
    expect((b as any).rows[0][0][0]).toEqual({ t: "code", v: "a.ts" });
  });

  test("outer pipes are optional and ragged rows are padded", () => {
    const [b] = parseMarkdown("a | b\n--- | ---\n1");
    expect(b.t).toBe("table");
    expect((b as any).rows[0]).toHaveLength(2);
  });

  test("a pipe in prose is not a table", () => {
    expect(parseMarkdown("run a | b and see")[0].t).toBe("p");
  });

  test("a table interrupts the paragraph above it", () => {
    const bs = parseMarkdown("here:\n| a |\n| --- |\n| 1 |");
    expect(bs.map((x) => x.t)).toEqual(["p", "table"]);
  });
});

describe("inline", () => {
  test("emphasis and strong", () => {
    expect(parseInline("*a*")).toEqual([{ t: "em", kids: [{ t: "text", v: "a" }] }]);
    expect(parseInline("**a**")).toEqual([
      { t: "strong", kids: [{ t: "text", v: "a" }] },
    ]);
    expect(parseInline("***a***")).toEqual([
      { t: "strong", kids: [{ t: "em", kids: [{ t: "text", v: "a" }] }] },
    ]);
  });

  test("strong nests inside emphasis without tearing", () => {
    const [em] = parseInline("*a **b** c*");
    expect(em.t).toBe("em");
    expect((em as any).kids[1]).toMatchObject({ t: "strong" });
  });

  test("strikethrough", () => {
    expect(parseInline("~~gone~~")[0]).toMatchObject({ t: "del" });
    expect(parseInline("~one~")[0]).toEqual({ t: "text", v: "~one~" });
  });

  test("underscores do not fire inside a word", () => {
    /* Every file the agent names would otherwise go half-italic. */
    expect(parseInline("read_ai_title runs")).toEqual([
      { t: "text", v: "read_ai_title runs" },
    ]);
    expect(parseInline("_yes_ it does")[0]).toMatchObject({ t: "em" });
  });

  test("an asterisk with space around it is arithmetic, not emphasis", () => {
    expect(parseInline("2 * 3 * 4")).toEqual([{ t: "text", v: "2 * 3 * 4" }]);
  });

  test("an unmatched marker stays literal", () => {
    expect(parseInline("**half typed")).toEqual([{ t: "text", v: "**half typed" }]);
    expect(parseInline("a ` b")).toEqual([{ t: "text", v: "a ` b" }]);
  });

  test("code spans win over everything inside them", () => {
    expect(parseInline("`a *b* _c_`")).toEqual([{ t: "code", v: "a *b* _c_" }]);
  });

  test("a code span may hold backticks", () => {
    expect(parseInline("`` a ` b ``")).toEqual([{ t: "code", v: "a ` b" }]);
  });

  test("escapes", () => {
    expect(parseInline("\\*not em\\*")).toEqual([{ t: "text", v: "*not em*" }]);
  });

  test("links", () => {
    expect(parseInline("[docs](https://example.com/x)")).toEqual([
      {
        t: "link",
        href: "https://example.com/x",
        kids: [{ t: "text", v: "docs" }],
      },
    ]);
  });

  test("a link title is dropped, not printed", () => {
    const [l] = parseInline('[a](https://e.com "why")');
    expect(l).toMatchObject({ t: "link", href: "https://e.com" });
  });

  test("a bare url is clickable and stops before the full stop", () => {
    const kids = parseInline("see https://example.com/a. thanks");
    expect(kids[1]).toMatchObject({ t: "link", href: "https://example.com/a" });
    expect(kids[2]).toEqual({ t: "text", v: ". thanks" });
  });

  test("an autolink in angle brackets", () => {
    expect(parseInline("<https://e.com>")[0]).toMatchObject({
      t: "link",
      href: "https://e.com",
    });
  });

  test("an image renders as its alt text, never as a fetch", () => {
    const kids = parseInline("![a cat](https://e.com/cat.png)");
    expect(kids).toEqual([
      { t: "link", href: "https://e.com/cat.png", kids: [{ t: "text", v: "a cat" }] },
    ]);
  });

  test("an unsafe destination is not a link at all", () => {
    expect(parseInline("[click](javascript:alert(1))")).toEqual([
      { t: "text", v: "click" },
    ]);
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("www.example.com")).toBe("https://www.example.com");
  });
});

describe("streaming", () => {
  /* Every prefix of a real answer has to parse into something showable — the
     panel re-parses the streaming line on every text delta. */
  const answer = [
    "Here is **the** plan:",
    "",
    "1. read `store.rs`",
    "2. add a migration",
    "",
    "```rust",
    "let x = 1;",
    "```",
    "",
    "> and then stop",
  ].join("\n");

  test("no prefix throws, and none is empty", () => {
    for (let n = 1; n <= answer.length; n++) {
      const bs = parseMarkdown(answer.slice(0, n));
      expect(Array.isArray(bs)).toBe(true);
      expect(bs.length).toBeGreaterThan(0);
    }
  });

  test("the whole thing folds into the blocks it looks like", () => {
    expect(parseMarkdown(answer).map((b) => b.t)).toEqual([
      "p",
      "list",
      "code",
      "quote",
    ]);
  });
});

/* The heading an agent actually writes. `##` is the exception in practice —
   a section's name arrives in bold at the head of its paragraph. */
describe("run-in headings", () => {
  const lead = (src: string) => runIn(parseMarkdown(src)[0].kids as Inline[]);

  test("a bold opening is the paragraph's name", () => {
    expect(lead("**1. The impact pipeline.** The largest unbuilt system left.")).toBe(
      "1. The impact pipeline.",
    );
  });

  test("a whole paragraph in bold is a label too", () => {
    expect(lead("**My pick: #1.**")).toBe("My pick: #1.");
  });

  test("bold in the middle of a sentence is emphasis, and starts no section", () => {
    expect(lead("it is the **deepest** unbuilt thing.")).toBe(null);
  });

  test("a plain paragraph has no label", () => {
    expect(lead("six, ordered by what I'd pick.")).toBe(null);
  });

  /* Bold used for weight rather than as a name: a rail entry that is the
     paragraph again is not a table of contents. */
  test("a first sentence written in bold is not a label", () => {
    expect(
      lead(
        "**every card is a long-lived child process and there is no terminal emulator anywhere on the path.** that is the whole design.",
      ),
    ).toBe(null);
  });

  test("the marks inside the label come off — a rail draws words", () => {
    expect(lead("**`SetTargetAlpha` has no caller.** The natural one is nearby.")).toBe(
      "SetTargetAlpha has no caller.",
    );
  });

  test("an indented paragraph still opens with its bold", () => {
    expect(lead(" **3. Seamless travel.** small, mechanical.")).toBe(
      "3. Seamless travel.",
    );
  });

  /* Mid-stream every prefix of an answer has to parse into something showable,
     and half a bold opening is not a heading yet. */
  test("a half-written label is not one", () => {
    expect(lead("**4. Moving parts")).toBe(null);
  });
});

/* ── the answer as it is being written ───────────────────────────────────── */

/** One of everything that decides a boundary: a fence holding blank lines and
 *  lines that look like other blocks, a bullet list a numbered one interrupts,
 *  a loose list whose blanks are *inside* it, a table, a quote, a rule, and
 *  prose either side of the lot. */
const ANSWER = [
  "# the plan",
  "",
  "Two things, and the second is the one that matters.",
  "A second line of the same paragraph.",
  "",
  "## first",
  "",
  "- one",
  "- two",
  "  - nested",
  "",
  "1. numbered",
  "",
  "2. loose, and the blank line above it is inside the list",
  "",
  "   a continuation of the second item",
  "",
  "Prose after the list.",
  "",
  "```ts",
  "const a = 1;",
  "",
  "// a blank line, a heading and a bullet, and all of them are code",
  "# not a heading",
  "- not a bullet",
  "",
  "const b = 2;",
  "```",
  "",
  "> a quote",
  "> that runs on",
  "",
  "| a | b |",
  "|---|--:|",
  "| 1 | 2 |",
  "",
  "---",
  "",
  "**Last.** and a word after it",
].join("\n");

/** The whole contract: every prefix of `src`, fed in `step`-character pieces,
 *  reads exactly as a fresh parse of that prefix does. */
function agrees(src: string, step: number) {
  const s = new StreamedMarkdown();
  for (let n = 0; n <= src.length; n += step) {
    const at = src.slice(0, n);
    const { settled, tail } = s.read("card", at);
    expect([...settled, ...tail]).toEqual(parseMarkdown(at));
  }
  const { settled, tail } = s.read("card", src);
  expect([...settled, ...tail]).toEqual(parseMarkdown(src));
}

describe("streaming markdown", () => {
  test("every prefix reads as a fresh parse of it, a character at a time", () => {
    agrees(ANSWER, 1);
  });

  test("…and in pieces of every size, which is how deltas actually arrive", () => {
    for (const step of [2, 3, 7, 13, 64]) agrees(ANSWER, step);
  });

  /* The case the whole scanner exists for. Settle inside a fence and the code
     above the blank line becomes a paragraph of its own, then a code block
     again once the fence closes — a block flickering into prose mid-stream. */
  test("a blank line inside an open fence is not a boundary", () => {
    const src = [
      "prose",
      "",
      "```",
      "one",
      "",
      "two",
      "```",
      "",
      "after",
    ].join("\n");
    const s = new StreamedMarkdown();
    for (let n = 0; n <= src.length; n++) {
      const at = src.slice(0, n);
      const { settled, tail } = s.read("f", at);
      expect([...settled, ...tail]).toEqual(parseMarkdown(at));
      // Nothing that is still being written has been settled.
      expect(settled.some((b) => b.t === "code" && b.open)).toBe(false);
    }
  });

  test("a tilde fence, and a run of backticks inside a longer one", () => {
    const src = ["~~~", "```", "still code", "", "~~~", "", "after"].join("\n");
    const s = new StreamedMarkdown();
    for (let n = 0; n <= src.length; n++) {
      const at = src.slice(0, n);
      const { settled, tail } = s.read("f", at);
      expect([...settled, ...tail]).toEqual(parseMarkdown(at));
    }
  });

  /* A blank line does not end a list — `readList` counts them and carries on —
     so settling at one drops the items written after it out of the list. */
  test("a blank line inside a loose list is not a boundary either", () => {
    const src = [
      "- one",
      "",
      "- two",
      "",
      "  a continuation",
      "",
      "after",
    ].join("\n");
    const s = new StreamedMarkdown();
    for (let n = 0; n <= src.length; n++) {
      const at = src.slice(0, n);
      const { settled, tail } = s.read("l", at);
      expect([...settled, ...tail]).toEqual(parseMarkdown(at));
    }
  });

  test("a table's rule line arriving turns a paragraph into a table", () => {
    /* `readTable`'s one line of lookahead is why a boundary has to be a blank
       line: until the rule lands, the head is an ordinary paragraph line. */
    const src = ["intro", "", "| a | b |", "|---|---|", "| 1 | 2 |"].join("\n");
    const s = new StreamedMarkdown();
    for (let n = 0; n <= src.length; n++) {
      const at = src.slice(0, n);
      const { settled, tail } = s.read("t", at);
      expect([...settled, ...tail]).toEqual(parseMarkdown(at));
    }
  });

  test("what has settled is parsed once and handed back as the same array", () => {
    const s = new StreamedMarkdown();
    let first: Block | null = null;
    let last: Block[] | null = null;
    let unchanged = 0;
    for (let n = 1; n <= ANSWER.length; n++) {
      const { settled } = s.read("card", ANSWER.slice(0, n));
      if (!settled.length) continue;
      first ??= settled[0];
      // The first block was parsed on the delta it settled on, and never again.
      expect(settled[0]).toBe(first);
      if (settled === last) unchanged++;
      last = settled;
    }
    // And the array's identity only moves when one more block settles, so a
    // panel redrawing per delta has nothing to redraw for nearly all of them.
    expect(unchanged).toBeGreaterThan(ANSWER.length / 2);
  });

  test("a shorter source is a new one", () => {
    const s = new StreamedMarkdown();
    s.read("c", "one\n\ntwo\n\n");
    const { settled, tail } = s.read("c", "fresh");
    expect(settled).toEqual([]);
    expect([...settled, ...tail]).toEqual(parseMarkdown("fresh"));
  });

  test("another card is another source, however long this one got", () => {
    /* Length is all a source that only grows can be told by, and moving to
       another card mid-turn is exactly what it cannot see. */
    const s = new StreamedMarkdown();
    s.read("a", "one\n\ntwo\n\n");
    const next = "a different answer\n\nand a longer one than that was";
    const { settled, tail } = s.read("b", next);
    expect([...settled, ...tail]).toEqual(parseMarkdown(next));
  });

  test("a \\r\\n split across two fragments is one line break", () => {
    const src = "one\r\ntwo\r\n\r\nthree";
    for (const step of [1, 2, 3]) agrees(src, step);
  });

  test("being asked twice for the same string answers the same object", () => {
    const s = new StreamedMarkdown();
    s.read("c", "one\n\ntw");
    const a = s.read("c", "one\n\ntwo");
    const b = s.read("c", "one\n\ntwo");
    expect(b).toBe(a);
  });

  /* Documents shuffled out of every line that can decide a boundary, in orders
     nobody would think to write down. A hand-written case tests the boundary
     you had in mind; this tests the ones you did not — it is what a rule about
     "the last place nothing after it can reach" is actually worth. Seeded, so a
     failure is a failure you can run again. */
  test("random documents agree with a fresh parse at every prefix", () => {
    const POOL = [
      "",
      "   ",
      "prose line",
      "prose with `code` and **bold**",
      "# heading",
      "### deeper",
      "---",
      "***",
      "> quote",
      "lazy quote continuation",
      "- bullet",
      "  - nested",
      "  continuation",
      "1. one",
      "2. two",
      "1) paren",
      "```",
      "```ts",
      "~~~",
      "``` `inline` ```",
      "code line",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "|:--|--:|",
      "\ttab indented",
      "    four spaces",
      "  ``` ",
      "- ```",
      "> ```",
    ];
    let seed = 20260823;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };

    for (let doc = 0; doc < 150; doc++) {
      const lines: string[] = [];
      const n = 3 + rand(24);
      for (let i = 0; i < n; i++) lines.push(POOL[rand(POOL.length)]);
      const src = lines.join("\n") + (rand(2) ? "\n" : "");

      const s = new StreamedMarkdown();
      for (let k = 0; k <= src.length; k++) {
        const at = src.slice(0, k);
        const { settled, tail } = s.read(String(doc), at);
        const got = [...settled, ...tail];
        const want = parseMarkdown(at);
        /* Compared as JSON and only *asserted* on a mismatch: `toEqual` on a
           hundred thousand prefixes is the slow half of this suite, and the
           message when one does differ wants the whole document anyway. */
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          throw new Error(
            `settled wrongly after ${JSON.stringify(at)}\n` +
              `  document: ${JSON.stringify(src)}\n` +
              `  got:  ${JSON.stringify(got)}\n` +
              `  want: ${JSON.stringify(want)}`,
          );
        }
      }
    }
  });
});
