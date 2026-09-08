import { describe, expect, test } from "bun:test";

import {
  MAX_SIDE,
  compose,
  dropToken,
  echoOf,
  encodeAs,
  insertAt,
  isEmpty,
  mediaTypeOf,
  nameFromFile,
  pastedName,
  runsOf,
  scaleTo,
  sizeNote,
  stillIn,
  tokenFor,
  uniqueName,
  type Attachment,
} from "../src/lib/attach";

/** An attachment with the fields these tests care about; the bytes stand in for
 *  themselves so a block can be traced back to the picture it came from. */
const shot = (name: string, over: Partial<Attachment> = {}): Attachment => ({
  id: name,
  name,
  mediaType: "image/png",
  data: `<${name}>`,
  thumb: "",
  w: 100,
  h: 80,
  bytes: 2048,
  scaled: false,
  ...over,
});

describe("what may be sent", () => {
  test("the four the API takes are taken", () => {
    expect(mediaTypeOf("image/png")).toBe("image/png");
    expect(mediaTypeOf("image/jpeg")).toBe("image/jpeg");
    expect(mediaTypeOf("image/gif")).toBe("image/gif");
    expect(mediaTypeOf("image/webp")).toBe("image/webp");
  });

  /* `image/jpg` is not a media type and is what half the world writes. It comes
     off real clipboards, so refusing it would refuse ordinary images. */
  test("the spelling nobody gets right is corrected rather than refused", () => {
    expect(mediaTypeOf("image/jpg")).toBe("image/jpeg");
    expect(mediaTypeOf("IMAGE/PNG")).toBe("image/png");
  });

  /* A drag out of some applications leaves `type` empty — so the extension is
     the fallback, and the fallback is what makes a drop work at all. */
  test("an empty type falls back to the extension", () => {
    expect(mediaTypeOf("", "diagram.PNG")).toBe("image/png");
    expect(mediaTypeOf("", "holiday.jpg")).toBe("image/jpeg");
    expect(mediaTypeOf("", "notes.txt")).toBe(null);
    expect(mediaTypeOf("", "no-extension")).toBe(null);
  });

  test("anything else is refused at the door rather than sent and rejected", () => {
    expect(mediaTypeOf("application/pdf", "a.pdf")).toBe(null);
    expect(mediaTypeOf("image/bmp", "a.bmp")).toBe(null);
    expect(mediaTypeOf("video/mp4", "clip.mp4")).toBe(null);
  });
});

describe("what an image is called in the draft", () => {
  test("a file keeps its own name, extension included", () => {
    expect(nameFromFile(String.raw`C:\Users\me\pics\diagram.png`)).toBe("diagram.png");
    expect(nameFromFile("/home/me/shot.jpg")).toBe("shot.jpg");
  });

  /* A bracket inside a name would end the token early, so `[a]b].png]` would
     match `[a]` and leave the rest as prose — one image split into two things,
     neither of which is what was meant. */
  test("a bracket in the name cannot break its own token", () => {
    expect(nameFromFile("shot [1].png")).toBe("shot 1.png");
  });

  test("a very long name is cut but keeps its extension", () => {
    const out = nameFromFile(`${"x".repeat(60)}.png`);
    expect(out.length).toBeLessThanOrEqual(32);
    expect(out.endsWith(".png")).toBe(true);
  });

  /* Two files called `screenshot.png` out of two folders is the ordinary case,
     and one token spelling both would send the first twice and the second
     never — a wrong answer with a draft that looks exactly right. */
  test("a name already in the draft is made unique", () => {
    expect(uniqueName([], "shot.png")).toBe("shot.png");
    expect(uniqueName(["shot.png"], "shot.png")).toBe("shot 2.png");
    expect(uniqueName(["shot.png", "shot 2.png"], "shot.png")).toBe("shot 3.png");
    expect(uniqueName(["notes"], "notes")).toBe("notes 2");
  });

  test("a pasted image is numbered from what the draft holds", () => {
    expect(pastedName([])).toBe("image 1");
    expect(pastedName(["image 1"])).toBe("image 2");
    /* Not `image 1 2`, which is what `uniqueName` would have said — the two do
       different jobs and this is the one that would read as a bug. */
    expect(pastedName(["image 1", "image 2"])).toBe("image 3");
    /* A cleared draft starts at one again rather than carrying a counter. */
    expect(pastedName(["a.png"])).toBe("image 1");
  });
});

describe("compose", () => {
  test("a prompt with no images is one text block, as it always was", () => {
    expect(compose("do the thing", [])).toEqual([{ type: "text", text: "do the thing" }]);
  });

  /* The whole feature. `tools/probe-image.ts` established that the CLI takes
     this shape and that the model reads position off it. */
  test("an image sits where it was written, between the words", () => {
    const a = shot("shot 1");
    const out = compose("look at [shot 1] please", [a]);
    expect(out).toEqual([
      { type: "text", text: "look at " },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "<shot 1>" } },
      { type: "text", text: " please" },
    ]);
  });

  test("two images keep their order and their identities", () => {
    const a = shot("a.png");
    const b = shot("b.png", { data: "<b>" });
    const out = compose("[a.png] should look more like [b.png]", [a, b]);
    expect(out.map((x) => x.type)).toEqual(["image", "text", "image"]);
    expect((out[0] as { source: { data: string } }).source.data).toBe("<a.png>");
    expect((out[2] as { source: { data: string } }).source.data).toBe("<b>");
  });

  /* A name that is a prefix of another must not claim the longer one's token —
     `[shot]` inside `[shot 2]` would send the wrong picture and leave a stray
     `2]` in the sentence. */
  test("a name that is a prefix of another does not steal its token", () => {
    const a = shot("shot");
    const b = shot("shot 2", { data: "<second>" });
    const out = compose("[shot 2]", [a, b]);
    expect(out).toHaveLength(1);
    expect((out[0] as { source: { data: string } }).source.data).toBe("<second>");
  });

  /* The API refuses an empty text block, and two adjacent tokens produce one. */
  test("no empty text block is ever emitted", () => {
    const out = compose("[a.png][b.png]", [shot("a.png"), shot("b.png")]);
    expect(out.map((x) => x.type)).toEqual(["image", "image"]);
  });

  test("whitespace alone between two images is not a text block either", () => {
    const out = compose("[a.png]   [b.png]", [shot("a.png"), shot("b.png")]);
    expect(out.map((x) => x.type)).toEqual(["image", "image"]);
  });

  /* Deleting a token is the detach gesture — there is no button, and an image
     whose token you typed over is one you plainly did not mean to send. */
  test("an attachment the draft no longer mentions is not sent", () => {
    const out = compose("never mind", [shot("shot 1")]);
    expect(out).toEqual([{ type: "text", text: "never mind" }]);
    expect(stillIn("never mind", [shot("shot 1")])).toEqual([]);
    expect(stillIn("see [shot 1]", [shot("shot 1")]).map((s) => s.name)).toEqual(["shot 1"]);
  });

  test("the same token twice sends the picture twice, which is what it says", () => {
    const out = compose("[a.png] vs [a.png]", [shot("a.png")]);
    expect(out.map((x) => x.type)).toEqual(["image", "text", "image"]);
  });

  /* A draft that is nothing but a stale token composes to nothing, and an empty
     `content` is a 400 rather than a quiet no-op. */
  test("a draft that composes to nothing says so", () => {
    expect(isEmpty(compose("", []))).toBe(true);
    expect(isEmpty(compose("   ", []))).toBe(true);
    expect(isEmpty(compose("[gone]", []))).toBe(false); // plain text, nothing attached
    expect(isEmpty(compose("hi", [shot("a.png")]))).toBe(false);
  });
});

describe("echoOf", () => {
  /* Measured, not assumed: `tools/probe-image.ts` sent five blocks and the
     replay's extractable text was exactly the three text ones joined. Get this
     wrong and the line is never claimed — the card reads `sent, not picked up`
     for ever and burns its nudge budget. */
  test("it is the text blocks joined, with the images contributing nothing", () => {
    const blocks = compose("look at [shot 1] please", [shot("shot 1")]);
    expect(echoOf(blocks)).toBe("look at  please");
  });

  test("an ordinary prompt echoes as itself", () => {
    expect(echoOf(compose("do the thing", []))).toBe("do the thing");
  });

  test("a prompt of nothing but images echoes as nothing", () => {
    expect(echoOf(compose("[a.png]", [shot("a.png")]))).toBe("");
  });
});

describe("runsOf", () => {
  /* The tint is drawn *behind* a transparent textarea whose caret is the real
     one, so one dropped character puts every glyph after it over the wrong
     place and the caret lands mid-word. `bang.ts::tokens` carries the same rule
     for the same layer; this is the same test. */
  test("the runs concatenate back to exactly what went in", () => {
    for (const text of [
      "look at [a.png] please",
      "[a.png]",
      "[a.png][b.png]",
      "  leading and trailing  ",
      "nothing attached here",
      "",
      "a [a.png] b [b.png] c",
    ]) {
      const runs = runsOf(text, [shot("a.png"), shot("b.png")]);
      expect(runs.map((r) => r.text).join("")).toBe(text);
    }
  });

  test("a token of an attached image is a chip and the prose is not", () => {
    expect(runsOf("look at [a.png] please", [shot("a.png")])).toEqual([
      { text: "look at ", chip: false },
      { text: "[a.png]", chip: true },
      { text: " please", chip: false },
    ]);
  });

  /* Brackets are ordinary punctuation and people write them. Only a token of
     something really attached may be drawn as a chip, or a draft would light up
     around a markdown link. */
  test("brackets that are not an attachment stay prose", () => {
    expect(runsOf("see [the docs](x) and [nope]", [shot("a.png")])).toEqual([
      { text: "see [the docs](x) and [nope]", chip: false },
    ]);
  });

  test("an empty draft has no runs at all", () => {
    expect(runsOf("", [shot("a.png")])).toEqual([]);
  });

  /* The drawing and the sending must never disagree about what a token is, so
     both ask `stillIn` and both prefer the longer name. */
  test("a name that is a prefix of another does not steal its chip", () => {
    const runs = runsOf("[shot 2]", [shot("shot"), shot("shot 2")]);
    expect(runs).toEqual([{ text: "[shot 2]", chip: true }]);
  });
});

describe("dropToken", () => {
  /* Removing an image and backspacing over its token are the same act: an
     attachment exists by being mentioned, so a remove that left `[shot 1]` in
     the sentence would leave the prompt referring to something the agent never
     receives. */
  test("the token goes and the gap closes", () => {
    expect(dropToken("look at [a.png] please", "a.png")).toBe("look at please");
  });

  test("a token at either end leaves no stray space", () => {
    expect(dropToken("[a.png] please", "a.png")).toBe("please");
    expect(dropToken("look at [a.png]", "a.png")).toBe("look at");
    expect(dropToken("[a.png]", "a.png")).toBe("");
  });

  test("every mention goes, since one image mentioned twice is one image", () => {
    expect(dropToken("[a.png] vs [a.png]", "a.png")).toBe("vs");
  });

  /* A draft somebody laid out is not this function's to tidy. */
  test("newlines are left alone", () => {
    expect(dropToken("first\n\nsecond [a.png]", "a.png")).toBe("first\n\nsecond");
  });

  test("a name not in the draft changes nothing", () => {
    expect(dropToken("look at [b.png]", "a.png")).toBe("look at [b.png]");
  });
});

describe("scaling", () => {
  /* Most things pasted here are already under the ceiling, and re-encoding one
     costs a generation of quality for nothing. */
  test("anything within the ceiling is left alone", () => {
    expect(scaleTo(800, 600)).toBe(null);
    expect(scaleTo(MAX_SIDE, MAX_SIDE)).toBe(null);
  });

  test("the long edge is what is fitted, and the ratio is kept", () => {
    const fit = scaleTo(3840, 2160)!;
    expect(fit.w).toBe(MAX_SIDE);
    /* An aspect ratio that drifts is a screenshot that arrives subtly stretched,
       which is the one thing nobody would think to look for. */
    expect(Math.abs(fit.h / fit.w - 2160 / 3840)).toBeLessThan(0.01);
  });

  test("a tall image is fitted on its height", () => {
    const fit = scaleTo(1000, 4000)!;
    expect(fit.h).toBe(MAX_SIDE);
    expect(fit.w).toBe(Math.round(1000 * (MAX_SIDE / 4000)));
  });

  /* An extreme aspect ratio must not round its short edge to zero — a canvas of
     width 0 throws, and the picture would be lost with no message. */
  test("the short edge never rounds away to nothing", () => {
    const fit = scaleTo(20000, 3)!;
    expect(fit.w).toBe(MAX_SIDE);
    expect(fit.h).toBeGreaterThanOrEqual(1);
  });

  test("a zero-sized image asks for no scaling rather than dividing by it", () => {
    expect(scaleTo(0, 0)).toBe(null);
  });

  /* A PNG screen capture re-encoded as JPEG picks up ringing on exactly what it
     was captured to show: text and thin UI lines. */
  test("a scaled image is re-encoded as itself, except a gif which cannot be", () => {
    expect(encodeAs("image/png")).toBe("image/png");
    expect(encodeAs("image/jpeg")).toBe("image/jpeg");
    expect(encodeAs("image/webp")).toBe("image/webp");
    expect(encodeAs("image/gif")).toBe("image/png");
  });
});

describe("putting a token into the sentence", () => {
  test("it lands at the caret with the spacing you would have typed", () => {
    expect(insertAt("look at", 7, "[a]")).toEqual({ text: "look at [a]", caret: 11 });
  });

  test("an empty draft does not begin with a space", () => {
    expect(insertAt("", null, "[a]")).toEqual({ text: "[a]", caret: 3 });
  });

  test("a token dropped mid-sentence is spaced on both sides", () => {
    expect(insertAt("look atplease", 7, "[a]")).toEqual({
      text: "look at [a] please",
      caret: 11,
    });
  });

  test("spacing already there is not doubled", () => {
    expect(insertAt("look at ", 8, "[a]")).toEqual({ text: "look at [a]", caret: 11 });
  });

  test("a caret past the end lands at the end rather than throwing", () => {
    expect(insertAt("hi", 99, "[a]").text).toBe("hi [a]");
    expect(insertAt("hi", -5, "[a]").text).toBe("[a] hi");
  });

  test("the token is the name in brackets", () => {
    expect(tokenFor("shot 1")).toBe("[shot 1]");
  });
});

describe("the reading under a chip", () => {
  test("it says the size and whether we changed it", () => {
    expect(sizeNote(shot("a", { w: 800, h: 600, bytes: 40960 }))).toBe("800×600 · 40 KB");
    expect(sizeNote(shot("a", { w: 1568, h: 882, bytes: 2 * 1024 * 1024, scaled: true }))).toBe(
      "1568×882 · 2.0 MB · scaled",
    );
  });

  /* Never `0 KB`, which reads as an empty file rather than a small one. */
  test("a tiny image still has a size", () => {
    expect(sizeNote(shot("a", { bytes: 200 }))).toBe("100×80 · 1 KB");
  });
});
