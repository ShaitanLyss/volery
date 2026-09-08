import { describe, expect, test } from "bun:test";

import type { Attachment } from "../src/lib/attach";
import { Drafts, type Draft } from "../src/lib/drafts";

/** A draft of nothing but words, which is what every test here was written
 *  against and is still the ordinary case. */
const words = (text: string): Draft => ({ text, shots: [] });

/** An attachment with only the fields this file cares about. The bytes are not
 *  the subject: what is being asserted is that a picture goes where its sentence
 *  goes. */
const shot = (name: string): Attachment => ({
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
