import { describe, expect, test } from "bun:test";
import {
  REPLIES_BUDGET,
  REPLY_KEEP_MS,
  decodeReplies,
  encodeReplies,
  noted,
  orphans,
  replyKey,
  textUnder,
  under,
  withReply,
  without,
  type About,
  type Replies,
} from "../src/lib/replies";

const to = (item: string, over: Partial<About> = {}): About => ({
  item,
  about: `the thing ${item}`,
  card: "c",
  ...over,
});
const yes = () => true;

describe("keys", () => {
  test("an item, and its parts", () => {
    expect(replyKey("notice:a")).toBe("notice:a");
    expect(replyKey("ask:q", 2)).toBe("ask:q:2");
  });
});

describe("writing", () => {
  test("only an empty string takes a field out — whitespace is kept as typed", () => {
    const all = withReply({}, "notice:a", "hello", 1, to("notice:a"));
    expect(all["notice:a"]).toMatchObject({ text: "hello", at: 1, item: "notice:a" });
    /* A field bound to the store would otherwise eat the space just pressed. */
    expect(withReply(all, "notice:a", " ", 2, to("notice:a"))["notice:a"].text).toBe(" ");
    expect(withReply(all, "notice:a", "", 2, to("notice:a"))).toEqual({});
  });

  test("an item's fields read in step order and go together, by the item they name", () => {
    let all = withReply({}, "ask:q:10", "tenth", 1, to("ask:q"));
    all = withReply(all, "ask:q:2", "second", 1, to("ask:q"));
    all = withReply(all, "ask:q:3", "   ", 1, to("ask:q"));
    all = withReply(all, "ask:qq:0", "not this one", 1, to("ask:qq"));
    expect(under(all, "ask:q").map(([k]) => k)).toEqual(["ask:q:2", "ask:q:3", "ask:q:10"]);
    expect(textUnder(all, "ask:q")).toBe("second\n\ntenth");
    expect(Object.keys(without(all, "ask:q"))).toEqual(["ask:qq:0"]);
  });

  test("a far notice's colons do not make it anybody else's part", () => {
    const far = "notice:elsewhere:host:card:n1";
    const all = withReply(withReply({}, far, "far", 1, to(far)), "notice:elsewhere", "x", 1, to("notice:elsewhere"));
    expect(textUnder(all, "notice:elsewhere")).toBe("x");
    expect(textUnder(all, far)).toBe("far");
  });

  test("a reason is cleared by the next keystroke", () => {
    let all = noted(withReply({}, "notice:a", "hi", 1, to("notice:a")), "notice:a", "did not go through");
    expect(all["notice:a"].why).toBe("did not go through");
    all = withReply(all, "notice:a", "hi!", 2, to("notice:a"));
    expect(all["notice:a"].why).toBeUndefined();
  });
});

describe("orphans — the replies the dock hands back", () => {
  const all: Replies = [
    ["notice:gone", "my reply", to("notice:gone")],
    ["notice:here", "still waiting", to("notice:here")],
    ["ask:q:0", "first half", to("ask:q")],
    ["ask:q:1", "second half", to("ask:q")],
    ["ask:pile:0", "in the pile", to("ask:pile", { pile: true })],
    ["notice:flying", "on its way", to("notice:flying")],
  ].reduce<Replies>((a, [k, t, ab], i) => withReply(a, k as string, t as string, i, ab as About), {});

  test("a reply to something no longer waiting, and never sent", () => {
    const got = orphans(all, new Set(["notice:here"]), ["notice:flying"], yes);
    expect(got.map((o) => o.item)).toEqual(["notice:gone", "ask:q"]);
    expect(got[1].text).toBe("first half\n\nsecond half");
    expect(got[0].about).toBe("the thing notice:gone");
  });

  test("not before the queue it would be found in has been read", () => {
    /* At launch everything looks gone — notices unread, other walls unheard. */
    expect(orphans(all, new Set(), [], () => false)).toEqual([]);
  });

  test("never one from the away pile, which draws its own back in place", () => {
    expect(orphans(all, new Set(), [], yes).some((o) => o.item === "ask:pile")).toBe(false);
  });

  test("and it carries why, when something said", () => {
    const got = orphans(noted(all, "notice:gone", "did not go through"), new Set(), [], yes);
    expect(got.find((o) => o.item === "notice:gone")?.why).toBe("did not go through");
  });
});

describe("a reload", () => {
  test("keeps what was typed, and what it was for", () => {
    const all = withReply(
      withReply({}, "notice:a", "half a sentence", 100, to("notice:a")),
      "ask:q:0",
      "maybe",
      100,
      to("ask:q", { pile: true }),
    );
    expect(decodeReplies(encodeReplies(all), 200)).toEqual(all);
  });

  test("ages out a reply nobody came back to", () => {
    const all = withReply({}, "notice:a", "old", 0, to("notice:a"));
    expect(decodeReplies(encodeReplies(all), REPLY_KEEP_MS + 1)).toEqual({});
    expect(decodeReplies(encodeReplies(all), REPLY_KEEP_MS - 1)).toEqual(all);
  });

  test("drops the oldest whole past the budget, never cutting one", () => {
    const big = "x".repeat(REPLIES_BUDGET - 10);
    let all = withReply({}, "notice:old", "older words", 1, to("notice:old"));
    all = withReply(all, "notice:new", big, 2, to("notice:new"));
    const back = decodeReplies(encodeReplies(all), 3);
    expect(Object.keys(back)).toEqual(["notice:new"]);
    expect(back["notice:new"].text).toBe(big);
  });

  test("degrades rather than refuses", () => {
    expect(decodeReplies(null, 0)).toEqual({});
    expect(decodeReplies("{not json", 0)).toEqual({});
    expect(decodeReplies("[1,2]", 0)).toEqual({});
    const back = decodeReplies(JSON.stringify({ a: { text: 3 }, b: { text: "kept" }, c: { text: "  " } }), 0);
    expect(Object.keys(back)).toEqual(["b"]);
    /* An entry from before items were named names itself. */
    expect(back.b.item).toBe("b");
  });
});
