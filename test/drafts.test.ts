import { describe, expect, test } from "bun:test";

import type { Attachment, FileRef } from "../src/lib/attach";
import {
  Drafts,
  KEEP_BUDGET,
  decodeKept,
  decodeKeptFiles,
  decodeOutbox,
  encodeKept,
  KEPT_FILES,
  withoutGoneFiles,
  mergeDraft,
  withOutbox,
  type Draft,
} from "../src/lib/drafts";

/** A draft of nothing but words, which is what every test here was written
 *  against and is still the ordinary case. */
const words = (text: string): Draft => ({ text, shots: [] });

/** An attachment with only the fields this file cares about. The bytes are not
 *  the subject: what is being asserted is that a picture goes where its sentence
 *  goes. */
const shot = (name: string): Attachment => ({
  kind: "picture",
  id: name,
  name,
  mediaType: "image/png",
  data: "",
  thumb: "",
  w: 1,
  h: 1,
  bytes: 1,
  scaled: false,
});

describe("switchTo", () => {
  test("a draft stays with the card it was written at", () => {
    const d = new Drafts();
    /* Landing on the first card with an empty field: nothing to carry. */
    expect(d.switchTo("a", words("")).text).toBe("");
    /* Type at it, then click another — the field comes back empty rather than
       pointing what you wrote at whoever you landed on. */
    expect(d.switchTo("b", words("half a prompt")).text).toBe("");
    /* And come back to it. */
    expect(d.switchTo("a", words("")).text).toBe("half a prompt");
  });

  test("both cards keep their own", () => {
    const d = new Drafts();
    d.switchTo("a", words(""));
    d.switchTo("b", words("for a"));
    d.switchTo("a", words("for b"));
    expect(d.peek("a").text).toBe("for a");
    expect(d.peek("b").text).toBe("for b");
  });

  test("landing where you already are changes nothing", () => {
    const d = new Drafts();
    d.switchTo("a", words(""));
    expect(d.switchTo("a", words("still typing")).text).toBe("still typing");
    expect(d.holds("a")).toBe(true);
  });

  test("the wall keeps one of its own", () => {
    const d = new Drafts();
    /* A marquee gathering: several cards selected, none focused, and the field
       live and aimed at all of them. */
    expect(d.switchTo(null, words("")).text).toBe("");
    expect(d.switchTo("a", words("say this to all five")).text).toBe("");
    expect(d.switchTo(null, words("")).text).toBe("say this to all five");
  });

  test("the field starts on the wall", () => {
    const d = new Drafts();
    expect(d.holds(null)).toBe(true);
    /* So the first card focused takes the field rather than inheriting it. */
    expect(d.switchTo("a", words("typed with nothing in hand")).text).toBe("");
    expect(d.peek(null).text).toBe("typed with nothing in hand");
  });

  test("an emptied draft is not kept", () => {
    const d = new Drafts();
    d.switchTo("a", words(""));
    d.switchTo("b", words("said and sent"));
    /* The send cleared the field; coming back parks the truth over the copy. */
    d.switchTo("a", words(""));
    expect(d.peek("b").text).toBe("");
    expect(d.switchTo("b", words("")).text).toBe("");
  });
});

describe("release", () => {
  test("a line still being written survives the card it was written at", () => {
    const d = new Drafts();
    d.switchTo("a", words(""));
    /* Closing the card is not a statement about the sentence, so the wall takes
       the line on and the field goes on showing it. */
    expect(d.release("a", words("mid sentence")).text).toBe("mid sentence");
    expect(d.holds(null)).toBe(true);
    /* The focus landing on the next card parks it on the wall rather than
       carrying it in — which is the whole point. */
    expect(d.switchTo("b", words("mid sentence")).text).toBe("");
    expect(d.peek(null).text).toBe("mid sentence");
    expect(d.peek("b").text).toBe("");
  });

  test("what the card had parked goes with the card", () => {
    const d = new Drafts();
    d.switchTo("a", words(""));
    d.switchTo("b", words("for a"));
    /* `a` is closed from the wall while `b` holds the field. There is nowhere
       left that its draft could ever be shown, and the field is not `a`'s to
       disturb. */
    expect(d.release("a", words("for b")).text).toBe("for b");
    expect(d.peek("a").text).toBe("");
    expect(d.holds("b")).toBe(true);
  });

  test("an empty field does not clear the wall's own draft", () => {
    const d = new Drafts();
    d.switchTo(null, words(""));
    d.switchTo("a", words("for the gathering"));
    /* Nothing was being written at `a`, so there is nothing to hand over — and
       the field is given the wall's own to show rather than wiping it. */
    expect(d.release("a", words("")).text).toBe("for the gathering");
    expect(d.switchTo("b", words("for the gathering")).text).toBe("");
    expect(d.peek(null).text).toBe("for the gathering");
  });

  test("but a line in it wins, being the newer of the two", () => {
    const d = new Drafts();
    d.switchTo(null, words(""));
    d.switchTo("a", words("for the gathering"));
    expect(d.release("a", words("mid sentence")).text).toBe("mid sentence");
    expect(d.peek(null).text).toBe("mid sentence");
  });
});

describe("the pictures go where the words go", () => {
  /* The whole reason a draft is one value. Parked apart, an image written into
     one card's sentence would be handed to whichever card you clicked next —
     and silently, since that card's own text would not have the token in it. */
  test("an attachment is parked and handed back with its sentence", () => {
    const d = new Drafts();
    d.switchTo("a", words(""));
    const held: Draft = { text: "look at [shot 1]", shots: [shot("shot 1")] };
    expect(d.switchTo("b", held).shots).toEqual([]);
    const back = d.switchTo("a", words(""));
    expect(back.text).toBe("look at [shot 1]");
    expect(back.shots.map((s) => s.name)).toEqual(["shot 1"]);
  });

  test("a closed card's pictures go with it", () => {
    const d = new Drafts();
    d.switchTo("a", words(""));
    /* The field's contents belong to whoever is *holding* it, so this parks the
       picture under `a` on the way to `b`. */
    d.switchTo("b", { text: "[shot 1]", shots: [shot("shot 1")] });
    expect(d.peek("a").shots.map((s) => s.name)).toEqual(["shot 1"]);
    /* Closing `a` from the wall while `b` holds the field: there is nowhere left
       that picture could ever be shown, and `b`'s draft is not `a`'s to
       disturb. */
    expect(d.release("a", words("still at b")).text).toBe("still at b");
    expect(d.peek("a").shots).toEqual([]);
  });

  test("a draft holding only a picture is still a draft", () => {
    /* Cannot arise while `prune` holds its invariant — an attachment lives by
       its token, so no text means no shots. Asserted anyway, because the bucket
       silently dropping one would be a picture lost with nothing to show for
       it. */
    const d = new Drafts();
    d.switchTo("a", words(""));
    d.switchTo("b", { text: "", shots: [shot("shot 1")] });
    expect(d.peek("a").shots.map((s) => s.name)).toEqual(["shot 1"]);
  });
});

/* Sink `b7a08d5e`: Lyss's machine crashed while she was typing a long prompt
   into a card and the text was gone. An unsent line now outlives the window. */
describe("what survives the window", () => {
  test("the one in your hand is kept, and it is kept first", () => {
    const d = new Drafts();
    d.switchTo("a", words(""));
    d.switchTo("b", words("left at a"));
    const kept = decodeKept(encodeKept(d.keeping(words("writing at b"))));
    expect(kept).toEqual({ b: "writing at b", a: "left at a" });
    /* First, because the budget drops from the end and the held one is the
       sentence with the keystroke in it. */
    expect(Object.keys(kept)[0]).toBe("b");
  });

  test("the wall's own line is kept too", () => {
    const d = new Drafts();
    expect(decodeKept(encodeKept(d.keeping(words("no card in hand"))))).toEqual({
      "": "no card in hand",
    });
  });

  test("a round trip hands the words back where they were written", () => {
    const d = new Drafts();
    d.switchTo("a", words(""));
    d.switchTo("b", words("for a"));
    const raw = encodeKept(d.keeping(words("for b")));
    const back = new Drafts();
    back.restore(decodeKept(raw));
    expect(back.peek("a").text).toBe("for a");
    expect(back.peek("b").text).toBe("for b");
  });

  /* The images do not go to disk — `attach.md` — so neither may their tokens:
     a restored `look at [shot 1]` is a prompt naming something the agent will
     never be sent, which is the one failure `prune` exists to prevent arriving
     from the other side. */
  test("a picture does not travel, and takes its token with it", () => {
    const d = new Drafts();
    const held: Draft = {
      text: "look at [shot 1] and tell me",
      shots: [shot("shot 1")],
    };
    expect(decodeKept(encodeKept(d.keeping(held)))).toEqual({
      "": "look at and tell me",
    });
  });

  test("a draft that was only a picture is not kept as a blank", () => {
    const d = new Drafts();
    const held: Draft = { text: "[shot 1]", shots: [shot("shot 1")] };
    expect(decodeKept(encodeKept(d.keeping(held)))).toEqual({});
  });

  /* Nothing is truncated: a half-kept paragraph that reads as whole is worse
     than one that is plainly absent, because you would send it. */
  test("past the budget whole drafts go, and never the held one", () => {
    const d = new Drafts();
    const long = "x".repeat(KEEP_BUDGET);
    d.switchTo("a", words(""));
    /* Parks `long` under "a" and leaves the field holding "b". */
    d.switchTo("b", words(long));
    const kept = decodeKept(encodeKept(d.keeping(words(long))));
    expect(kept.b).toHaveLength(KEEP_BUDGET);
    expect(kept.a).toBeUndefined();
  });

  test("a keeping larger than the budget on its own is still kept whole", () => {
    const d = new Drafts();
    const huge = "x".repeat(KEEP_BUDGET * 2);
    expect(decodeKept(encodeKept(d.keeping(words(huge))))[""]).toHaveLength(huge.length);
  });

  /* Read before the wall is drawn, so anything that threw here would be a
     window that did not open because of a half-written draft. */
  test("nonsense in the store is not a draft and is not a crash", () => {
    expect(decodeKept(null)).toEqual({});
    expect(decodeKept("")).toEqual({});
    expect(decodeKept("{oh no")).toEqual({});
    expect(decodeKept("[1,2]")).toEqual({});
    expect(decodeKept('{"a":17,"b":"real","c":""}')).toEqual({ b: "real" });
  });

  test("a restore will not land over a wall already being typed into", () => {
    const d = new Drafts();
    d.switchTo("a", words(""));
    d.switchTo("b", words("from this session"));
    d.restore({ a: "from last week" });
    expect(d.peek("a").text).toBe("from this session");
  });

  test("a card that is gone takes its draft, and the wall keeps its own", () => {
    const d = new Drafts();
    d.restore({ "": "the wall's", gone: "nobody's", here: "still a card" });
    d.prune(new Set(["here"]));
    expect(d.peek("gone").text).toBe("");
    expect(d.peek("here").text).toBe("still a card");
    expect(d.peek(null).text).toBe("the wall's");
  });
});

describe("words the wall could not send, handed back to the draft", () => {
  /* Sink 864ccaae: held messages cancelled, cleared or closed, and a send that
     failed outright, go back where they were written rather than nowhere. */
  test("they go in front of what is there, since they were written first", () => {
    expect(mergeDraft(words("held one"), words("typing now"))).toEqual(
      words("held one\n\ntyping now"),
    );
    expect(mergeDraft(words("held one"), words(""))).toEqual(words("held one"));
    expect(mergeDraft(words(""), words("typing now"))).toEqual(words("typing now"));
  });

  test("a picture coming back under a name already in use is renamed, token and all", () => {
    const back: Draft = { text: "look at [shot 1]", shots: [shot("shot 1")] };
    const into: Draft = { text: "and [shot 1] too", shots: [shot("shot 1")] };
    const out = mergeDraft(back, into);
    expect(out.text).toBe("look at [shot 1 2]\n\nand [shot 1] too");
    expect(out.shots.map((a) => a.name)).toEqual(["shot 1 2", "shot 1"]);
  });

  test("two held messages folded back keep their order and both their pictures", () => {
    const first: Draft = { text: "see [shot 1]", shots: [shot("shot 1")] };
    const second: Draft = { text: "and [shot 1]", shots: [shot("shot 1")] };
    const folded = [first, second].reduceRight((into, b) => mergeDraft(b, into), words(""));
    expect(folded.text).toBe("see [shot 1 2]\n\nand [shot 1]");
    expect(new Set(folded.shots.map((a) => a.name)).size).toBe(2);
  });

  test("give parks them under a card the field is not holding, ahead of its draft", () => {
    const d = new Drafts();
    d.switchTo("b", words(""));
    /* Leaving b for a parks what was in the field under b. */
    d.switchTo("a", words("half a thought"));
    d.give("b", words("held one"));
    expect(d.peek("b").text).toBe("held one\n\nhalf a thought");
    /* And the wall's own bucket, for a card that has just been closed. */
    d.give(null, words("from a closed card"));
    expect(d.peek(null).text).toBe("from a closed card");
  });
});

/* A file attached by its path is the one attachment a crash-restored draft
   keeps (sink c2f56f0d): a path writes nothing private, and dropping it would
   take a word out of the sentence. Pictures and pasted bytes still go. */
describe("a file attached by its path survives the keeping", () => {
  const file = (name: string, path: string, over: Partial<FileRef> = {}): FileRef => ({
    kind: "file",
    id: name,
    name,
    path,
    dir: false,
    size: 10,
    ...over,
  });

  test("it is kept beside the words and comes back as a chip", () => {
    const d = new Drafts();
    const held: Draft = {
      text: "read [r.pdf] and [shot 1] in [src]",
      shots: [file("r.pdf", "C:\\r.pdf"), shot("shot 1"), file("src", "C:\\src", { dir: true })],
    };
    const raw = encodeKept(d.keeping(held));
    expect(decodeKept(raw)).toEqual({ "": "read [r.pdf] and in [src]" });
    expect(decodeKeptFiles(raw)).toEqual({
      "": [
        { name: "r.pdf", path: "C:\\r.pdf", dir: false },
        { name: "src", path: "C:\\src", dir: true },
      ],
    });
    const back = new Drafts();
    back.restore(decodeKept(raw), decodeKeptFiles(raw));
    const got = back.peek(null);
    expect(got.text).toBe("read [r.pdf] and in [src]");
    expect(got.shots.map((a) => (a.kind === "file" ? [a.name, a.path, a.dir] : a.kind))).toEqual([
      ["r.pdf", "C:\\r.pdf", false],
      ["src", "C:\\src", true],
    ]);
  });

  test("a staged browser drag does not travel: its folder is swept at load", () => {
    const d = new Drafts();
    const raw = encodeKept(d.keeping({ text: "see [p.png]", shots: [file("p.png", "C:\\w\\_dropped\\p.png", { staged: true })] }));
    expect(decodeKept(raw)).toEqual({ "": "see" });
    expect(decodeKeptFiles(raw)).toEqual({});
  });

  test("a file whose path is gone comes out of the sentence, counted", () => {
    const d = new Drafts();
    d.restore(
      { a: "compare [old.txt] with [new.txt]" },
      { a: [{ name: "old.txt", path: "C:\\old.txt", dir: false }, { name: "new.txt", path: "C:\\new.txt", dir: false }] },
    );
    expect(d.paths().sort()).toEqual(["C:\\new.txt", "C:\\old.txt"]);
    expect(d.dropMissing((p) => p === "C:\\old.txt")).toBe(1);
    expect(d.peek("a").text).toBe("compare with [new.txt]");
    expect(d.peek("a").shots.map((s) => s.name)).toEqual(["new.txt"]);
    expect(withoutGoneFiles(d.peek("a"), () => false).dropped).toBe(0);
  });

  test("an older build reads the words and passes over the files", () => {
    const raw = encodeKept(new Drafts().keeping({ text: "[a.txt] please", shots: [file("a.txt", "C:\\a.txt")] }));
    /* What `decodeKept` has always done: keep string values, skip the rest. */
    const old = Object.fromEntries(Object.entries(JSON.parse(raw)).filter(([, v]) => typeof v === "string"));
    expect(old).toEqual({ "": "[a.txt] please" });
  });

  test("a hand-edited keeping cannot conjure a chip with no token, nor a malformed file", () => {
    const raw = JSON.stringify({ x: "no token here", [KEPT_FILES]: { x: [{ name: "a", path: "C:\\a", dir: false }, { name: 3 }] } });
    expect(decodeKeptFiles(raw)).toEqual({ x: [{ name: "a", path: "C:\\a", dir: false }] });
    const d = new Drafts();
    d.restore(decodeKept(raw), decodeKeptFiles(raw));
    expect(d.peek("x").shots).toEqual([]);
  });
});

/* The outbox: a send the app died holding comes back as that card's draft. */
describe("the outbox", () => {
  test("a send left behind goes back in front of the card's draft", () => {
    const back = withOutbox(
      { a: "typed after", b: "untouched" },
      { t1: { card: "a", text: "sent while frozen", at: 2 } },
    );
    expect(back).toEqual({ a: "sent while frozen\n\ntyped after", b: "untouched" });
  });

  test("several come back oldest first, and a card with no draft gets one", () => {
    const back = withOutbox(
      {},
      {
        late: { card: "c", text: "second", at: 20 },
        early: { card: "c", text: "first", at: 10 },
      },
    );
    expect(back).toEqual({ c: "first\n\nsecond" });
  });

  test("an empty outbox changes nothing", () => {
    const kept = { a: "x" };
    expect(withOutbox(kept, {})).toEqual(kept);
  });

  test("a damaged outbox is no outbox rather than a wall that will not open", () => {
    expect(decodeOutbox(null)).toEqual({});
    expect(decodeOutbox("{not json")).toEqual({});
    expect(decodeOutbox("[1,2]")).toEqual({});
    expect(
      decodeOutbox(JSON.stringify({ ok: { card: "a", text: "hi", at: 1 }, blank: { card: "a", text: "  " }, junk: 3 })),
    ).toEqual({ ok: { card: "a", text: "hi", at: 1 } });
  });
});
