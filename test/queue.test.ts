import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  nextItem,
  queueOrder,
  settleHold,
  shownItem,
  steady,
  type Hold,
  type Waiting,
} from "../src/lib/queue";
import { textUnder, withReply, type Replies } from "../src/lib/replies";

/* Every kind of thing the dock's queue holds, as `Front.items` builds them —
   a question or a notice, from a card here or on another wall: the key is the
   one the panel keeps its reply under. A new kind belongs in this list, and
   the matrix below then covers it without another line. The far two are the
   same items on a card elsewhere — the same item from a different handle
   (`cards.svelte.ts`), and since 2026-10-19 nothing in the item says so. */
const KINDS = {
  ask: { tier: 0, prefix: "ask" },
  notice: { tier: 1, prefix: "notice" },
  "far-ask": { tier: 0, prefix: "ask" },
  "far-notice": { tier: 1, prefix: "notice" },
} as const;
type Kind = keyof typeof KINDS;
const kinds = Object.keys(KINDS) as Kind[];

type Item = Waiting & { kind: Kind };
const item = (kind: Kind, id: string, card: string, since = 0): Item => ({
  kind,
  key: `${KINDS[kind].prefix}:${id}`,
  card,
  tier: KINDS[kind].tier,
  since,
});

/** The dock's effect, as a function of what it is shown: the ring it last saw
 *  is its own memory, and a ring that differs from it is the one change that
 *  is you choosing. Returns the key drawn. */
function dock() {
  let hold: Hold | null = null;
  let ringed: string | null = null;
  return (items: readonly Item[], ring: string | null = ringed): string | null => {
    const moved = ring !== ringed;
    ringed = ring;
    hold = settleHold(items, ring, hold, moved);
    return shownItem(items, ring, hold)?.key ?? null;
  };
}

/** A queue re-read from scratch: equal items, new objects, another order. */
const refetched = (items: readonly Item[]): Item[] => [...items].reverse().map((t) => ({ ...t }));

describe("the item in front of you never changes because something arrived", () => {
  /* The invariant, stated over every pair of kinds rather than per kind — the
     bug this replaced was a hold written for questions that a *notice* fell
     through, and a test written per kind is how the next one would ship. For
     each kind held, and a reply typed into it, every kind arrives: on the card
     in the ring, on the held item's own card, on a card nobody is looking at,
     and on another wall — then all at once, then the queue re-read in another
     order. The held item stays drawn and the reply stays under its key. */
  for (const held of kinds) {
    for (const ringOn of ["mine", "ring"] as const) {
      test(`holding a ${held} (ring on ${ringOn === "mine" ? "its card" : "another card"})`, () => {
        const card = held.startsWith("far") ? "far-a" : "a";
        const ring = ringOn === "mine" ? card : "r";
        const on = item(held, "held", card);
        const view = dock();
        expect(view([on], ring)).toBe(on.key);
        let replies: Replies = withReply({}, `${on.key}:0`, "half a sentence", 1, {
          item: on.key,
          about: `the ${held}`,
          card,
        });

        let queue: Item[] = [on];
        let n = 0;
        for (const arriving of kinds) {
          for (const where of [card, ring, "z", "far-z"]) {
            queue = [item(arriving, `new-${n++}`, where), ...queue];
            expect(view(queue)).toBe(on.key);
            queue = [...queue, item(arriving, `new-${n++}`, where)];
            expect(view(queue)).toBe(on.key);
          }
        }
        /* Re-read whole, in reverse, as fresh objects — what a queue rebuilt
           off a notice re-read or a far wall's digest looks like. */
        expect(view(refetched(queue))).toBe(on.key);
        /* And whatever re-rendering does to the panel, the reply is under the
           item's key — the queue moving cannot reach it. */
        replies = withReply(replies, "notice:new-0", "somebody else's", 2, {
          item: "notice:new-0",
          about: "another",
          card: "z",
        });
        expect(textUnder(replies, view(refetched(queue))!)).toBe("half a sentence");
      });
    }
  }

  test("the reported case: a question arriving while a notice is being answered", () => {
    /* Lyss, 2026-10-14. Under the old pair of holds this drew the question:
       a question outranked every notice, so holding the notice did nothing
       once one arrived. */
    const view = dock();
    const notice = item("notice", "n1", "a");
    expect(view([notice], "a")).toBe("notice:n1");
    expect(view([item("ask", "q1", "a"), notice])).toBe("notice:n1");
    expect(view([item("ask", "q2", "b"), item("ask", "q1", "a"), notice])).toBe("notice:n1");
    expect(view([item("far-ask", "q3", "far-c"), item("ask", "q1", "a"), notice])).toBe("notice:n1");
  });

  test("an arrival with nothing in front of you is drawn, and is then what is held", () => {
    const view = dock();
    expect(view([], "a")).toBe(null);
    const first = item("far-notice", "f", "far-b");
    expect(view([first])).toBe(first.key);
    /* A question now outranks it in the order, and changes nothing. */
    expect(view([item("ask", "q", "a"), first])).toBe(first.key);
  });
});

describe("only you change it", () => {
  test("moving the ring onto a card with something waiting draws that card's", () => {
    const view = dock();
    const a = item("notice", "a", "x");
    const b = item("ask", "b", "y");
    expect(view([a, b], "x")).toBe(a.key);
    expect(view([a, b], "y")).toBe(b.key);
  });

  test("onto a card with nothing waiting changes nothing", () => {
    /* You went to read a transcript — likely the one you are answering about. */
    const view = dock();
    const a = item("notice", "a", "x");
    const b = item("ask", "b", "y");
    expect(view([a, b], "x")).toBe(a.key);
    expect(view([a, b], "quiet")).toBe(a.key);
  });

  test("onto the held item's own card keeps it, even with a question there", () => {
    /* "select it" on a notice whose card is also asking: you went there to
       answer the notice. */
    const view = dock();
    const n = item("notice", "n", "x");
    expect(view([n], "elsewhere")).toBe(n.key);
    expect(view([item("ask", "q", "x"), n], "x")).toBe(n.key);
  });

  test("the ring going to nothing — its card closed under it — changes nothing", () => {
    const view = dock();
    const n = item("notice", "n", "x");
    expect(view([n, item("ask", "q", "y")], "x")).toBe(n.key);
    expect(view([n, item("ask", "q", "y")], null)).toBe(n.key);
  });
});

describe("when the held item goes", () => {
  test("the next is from the same card first — the question queued behind it", () => {
    const view = dock();
    const first = item("ask", "1", "x");
    const other = item("ask", "o", "y");
    expect(view([other, first], "x")).toBe(first.key);
    expect(view([other, item("ask", "2", "x")])).toBe("ask:2");
  });

  test("then by the queue's order: questions, the ring's first, then whatever waited longest, wherever it runs", () => {
    const view = dock();
    const gone = item("notice", "gone", "x");
    expect(view([gone], "r")).toBe(gone.key);
    const rest = [
      item("far-notice", "fn", "far-a", 100),
      item("notice", "n", "b", 200),
      item("far-ask", "fq", "far-c", 300),
      item("ask", "q", "d", 400),
    ];
    expect(view(rest)).toBe("ask:fq");
  });

  test("an empty queue holds nothing, and the next arrival is drawn", () => {
    const view = dock();
    expect(view([item("ask", "q", "x")], "x")).toBe("ask:q");
    expect(view([])).toBe(null);
    expect(view([item("notice", "n", "y")])).toBe("notice:n");
  });
});

describe("queueOrder", () => {
  test("tier, then the ring's card, then oldest first wherever it runs, then as given", () => {
    const q = [
      item("notice", "n1", "a", 10),
      item("far-ask", "fq", "far", 5),
      item("ask", "q1", "a", 20),
      item("notice", "n2", "r", 30),
      item("ask", "q2", "b", 20),
    ];
    expect(queueOrder(q, "r").map((t) => t.key)).toEqual([
      "ask:fq",
      "ask:q1",
      "ask:q2",
      "notice:n2",
      "notice:n1",
    ]);
    expect(queueOrder(q, "far")[0].key).toBe("ask:fq");
  });

  test("a card on another wall is not ranked behind this wall's: the item has no word for where it runs", () => {
    /* Lyss, 2026-10-19: "all conversations should be considered the same
       regardless of if they're shadow or not". It used to carry `far`, and an
       older question elsewhere waited behind every newer one here. */
    const here = item("ask", "here", "a", 2_000);
    const there = item("far-ask", "there", "elsewhere:lab:b", 1_000);
    expect(queueOrder([here, there], null).map((t) => t.key)).toEqual(["ask:there", "ask:here"]);
    expect(Object.keys(here)).not.toContain("far");
  });
});

describe("nextItem", () => {
  test("steps through every item and back round, never standing still", () => {
    const q = [item("ask", "1", "x"), item("ask", "2", "y"), item("notice", "3", "z")];
    const seen: string[] = [];
    let at: string | null = "ask:1";
    for (let i = 0; i < 3; i++) {
      at = nextItem(q, at)!.key;
      seen.push(at);
    }
    /* Ring-independent, so stepping onto a card does not hand the next press
       straight back — two cards ping-ponging and the third never reached. */
    expect(seen).toEqual(["ask:2", "notice:3", "ask:1"]);
    expect(nextItem([item("ask", "1", "x")], "ask:1")).toBe(null);
  });
});

describe("steady", () => {
  test("an item nothing about which changed is the same object as last time", () => {
    /* The panel is handed an item's parts as props, and a rebuilt object for
       the same question re-ran its per-question effects — the step reset and
       the gallery closed on any traffic anywhere on the wall. */
    const ask = { askId: "q" };
    const first = [{ ...item("ask", "q", "x"), ask }, { ...item("notice", "n", "y"), ask: null }];
    const was = new Map(first.map((t) => [t.key, t]));
    const again = steady(was, [{ ...item("notice", "n", "y"), ask: null }, { ...item("ask", "q", "x"), ask }]);
    expect(again[0]).toBe(first[1]);
    expect(again[1]).toBe(first[0]);
    /* A changed field is a new item — the sheet redrawn whole, say. */
    const redrawn = steady(was, [{ ...item("ask", "q", "x"), ask: { askId: "q" } }]);
    expect(redrawn[0]).not.toBe(first[0]);
  });
});

/* The caret survives an arrival only if the field it is in is never torn
   down, and the panel is torn down whenever the branch drawing it changes.
   Before this, a far question had two branches (ahead of this wall's when its
   card was in the ring, behind otherwise) and a far notice two more — so an
   item could be remounted mid-sentence without the hold having moved at all.
   No DOM runs in this suite, so this is asserted on the source, and it fails if
   a kind grows a second branch or the panel is put under a `{#key}`. */
describe("the dock draws each kind from exactly one branch", () => {
  const dockSource = readFileSync(join(import.meta.dir, "../src/lib/Dock.svelte"), "utf8");
  const markup = dockSource.slice(dockSource.indexOf("</script>"));
  /* A question and a notice, wherever their card runs: one branch each, and
     no third and fourth for a card on another wall — those were a branch and a
     snippet apiece until the card handle, and the drift between them is what
     it removed. */
  for (const kind of ["ask", "notice"]) {
    test(kind, () => {
      const branches = markup.split(`shown?.kind === "${kind}"`).length - 1;
      expect(branches).toBe(1);
    });
  }
  test("and a card elsewhere is no kind of its own", () => {
    expect(dockSource).not.toMatch(/"far-(ask|notice)"/);
  });
  test("and nothing re-keys the panel", () => {
    expect(markup).not.toMatch(/\{#key[^}]*(shown|hold|items)/);
  });
});

/* The other way a held question was reset without being remounted: its panel's
   per-question effects read `ask.askId` straight off the prop, and the prop is
   handed over again whenever the queue is rebuilt — any traffic anywhere — so
   the step jumped back and the gallery closed mid-answer. They key on a
   derived string instead, which stops at an unchanged value. */
describe("the question panel's per-question effects key on a derived id", () => {
  const askSource = readFileSync(join(import.meta.dir, "../src/lib/Ask.svelte"), "utf8");
  const script = askSource.slice(0, askSource.indexOf("</script>"));
  test("the id is derived", () => {
    expect(script).toMatch(/const id = \$derived\(ask\.askId\)/);
  });
  test("and no effect reads the prop for it", () => {
    expect(script).not.toMatch(/^\s*(void\s+)?ask\.askId;?\s*$/m);
  });
});
