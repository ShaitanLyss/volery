import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { echoOf, type Carried } from "../src/lib/attach";
import { textOf } from "../src/lib/classify";
import {
  HELD_MARK,
  NO_ACCOUNT_HELD,
  QUEUED_LINE,
  admit,
  composeRound,
  cutsRound,
  handedBackNote,
  heldDivider,
  heldHeader,
  nextRound,
  withoutMissing,
  type HeldItem,
} from "../src/lib/holding";
import { isRelayPrompt } from "../src/lib/relay";
import { isResumePrompt } from "../src/lib/rousing";
import { isPickUp, isCarryOn } from "../src/lib/classify";

let n = 0;
const yours = (text: string, pictures: string[] = []): HeldItem => ({
  key: `k${++n}`,
  text,
  pictures,
});
const heals = (text: string): HeldItem => ({ key: `k${++n}`, text, pictures: [], composed: true });

/** A picture as the store hands it back: a PNG's first bytes, which is all
 *  `compose` needs to place it. */
const png = (name: string): Carried => ({ name, mediaType: "image/png", data: "iVBORw0KGgo=" });

/** The round as the CLI would replay it: one `user` event carrying the blocks,
 *  read by the same fold `Conversation`'s user arm reads it with. */
const replayOf = (round: ReturnType<typeof composeRound>) => textOf(round.content);

describe("a held card keeps everything typed into it (sink 864ccaae)", () => {
  test("a second message into a held card is kept, behind the first", () => {
    /* The bug: the hold was one slot, and the second message was refused,
       marked failed and kept nowhere. Now it joins the queue. */
    let queue: HeldItem[] = [];
    queue = admit(queue, yours("rebase onto main and push"));
    queue = admit(queue, yours("actually, don't push yet"));
    queue = admit(queue, yours("and run the gate first"));
    expect(queue.map((h) => h.text)).toEqual([
      "rebase onto main and push",
      "actually, don't push yet",
      "and run the gate first",
    ]);
  });

  test("and all of them go out as ONE round, in the order they were written", () => {
    const queue = [yours("rebase onto main and push"), yours("actually, don't push yet")];
    const { round, rest } = nextRound(queue);
    expect(round.map((h) => h.text)).toEqual(queue.map((h) => h.text));
    expect(rest).toEqual([]);

    const out = composeRound(round.map((h) => ({ text: h.text, pictures: [] })));
    /* One prompt, so one turn — and each message verbatim under its own
       divider, the first before the second. */
    expect(out.content).toHaveLength(1);
    const said = out.echo;
    const first = said.indexOf("rebase onto main and push");
    const second = said.indexOf("actually, don't push yet");
    expect(said.startsWith(heldHeader(2))).toBe(true);
    expect(said.indexOf(heldDivider(1, 2))).toBeLessThan(first);
    expect(first).toBeLessThan(said.indexOf(heldDivider(2, 2)));
    expect(said.indexOf(heldDivider(2, 2))).toBeLessThan(second);
  });

  test("the one replay that comes back is the echo every line of the round is claimed on", () => {
    const out = composeRound([
      { text: "one", pictures: [] },
      { text: "two", pictures: [] },
    ]);
    expect(replayOf(out)).toBe(out.echo.trim());
  });

  test("one message goes exactly as it would have with nothing held", () => {
    const out = composeRound([{ text: "carry on", pictures: [] }]);
    expect(out.content).toEqual([{ type: "text", text: "carry on" }]);
    expect(out.echo).toBe("carry on");
  });

  test("a heal's re-ask goes to the front, since it is the turn that broke", () => {
    const queue = admit([yours("next thing")], heals("the broken turn, again"));
    expect(queue.map((h) => h.text)).toEqual(["the broken turn, again", "next thing"]);
  });

  test("the same words twice are two messages, not one", () => {
    const queue = admit(admit([], yours("go")), yours("go"));
    expect(queue).toHaveLength(2);
    expect(new Set(queue.map((h) => h.key)).size).toBe(2);
  });
});

describe("a slash command cannot ride inside other words", () => {
  test("rounds are cut at commands, and order is never changed", () => {
    let queue = [yours("a"), yours("b"), yours("/model sonnet"), yours("c")];
    const rounds: string[][] = [];
    while (queue.length) {
      const { round, rest } = nextRound(queue);
      rounds.push(round.map((h) => h.text));
      queue = rest;
    }
    expect(rounds).toEqual([["a", "b"], ["/model sonnet"], ["c"]]);
  });

  test("a command at the head goes alone", () => {
    const { round, rest } = nextRound([yours("/compact"), yours("then this")]);
    expect(round.map((h) => h.text)).toEqual(["/compact"]);
    expect(rest.map((h) => h.text)).toEqual(["then this"]);
  });

  test("only the leading slash counts", () => {
    expect(cutsRound("  /effort high")).toBe(true);
    expect(cutsRound("look in src/lib")).toBe(false);
  });

  test("a heal's re-ask and skein's own words go alone, and are never combined with yours", () => {
    /* Found in review: a resume prompt restored behind your held messages was
       combined with them under a header saying each was typed. */
    const own: HeldItem = { ...yours("you were part-way through a turn when skein closed"), own: true };
    let queue = [heals("the broken turn"), yours("a"), yours("b"), own, yours("c")];
    const rounds: string[][] = [];
    while (queue.length) {
      const { round, rest } = nextRound(queue);
      rounds.push(round.map((h) => h.text));
      queue = rest;
    }
    expect(rounds).toEqual([
      ["the broken turn"],
      ["a", "b"],
      ["you were part-way through a turn when skein closed"],
      ["c"],
    ]);
  });

  test("a round never carries more pictures than one prompt may", () => {
    const names = (n: number, at: string) => Array.from({ length: n }, (_, i) => `${at} ${i}`);
    const queue = [yours("a", names(12, "a")), yours("b", names(12, "b")), yours("c")];
    const first = nextRound(queue);
    expect(first.round.map((h) => h.text)).toEqual(["a"]);
    expect(nextRound(first.rest).round.map((h) => h.text)).toEqual(["b", "c"]);
    /* And one message over the cap on its own still goes — it was checked
       against the cap when it was attached, not here. */
    expect(nextRound([yours("big", names(25, "x"))]).round).toHaveLength(1);
  });

  test("an empty queue is no round", () => {
    expect(nextRound([])).toEqual({ round: [], rest: [] });
  });
});

describe("pictures ride with the message that names them", () => {
  test("each picture sits where its sentence put it, inside its own message", () => {
    const out = composeRound([
      { text: "the header is wrong", pictures: [] },
      { text: "like this [shot 1] — fix it", pictures: [png("shot 1")] },
    ]);
    expect(out.content.map((b) => b.type)).toEqual(["text", "image", "text"]);
    const before = out.content[0]!;
    expect(before.type === "text" && before.text.endsWith("like this ")).toBe(true);
    /* And the echo is `echoOf` the very blocks that go, tokens gone — the fold
       every pictured prompt is claimed by. */
    expect(out.echo).toBe(echoOf(out.content));
    expect(out.echo).not.toContain("[shot 1]");
  });

  test("a picture that could not be found again comes out of the words handed back", () => {
    expect(withoutMissing("see [shot 1] and [photo.png]", ["shot 1"])).toBe("see and [photo.png]");
    expect(withoutMissing("nothing missing", [])).toBe("nothing missing");
  });
});

describe("what a held message says", () => {
  test("held is told apart from not sent, and only not sent alarms", () => {
    expect(HELD_MARK).toContain("held — will send when allowance returns");
    expect(HELD_MARK).not.toContain("not sent");
    const css = readFileSync("src/lib/Transcript.svelte", "utf8");
    /* The transcript draws exactly these words … */
    expect(css).toContain(`content: "${HELD_MARK}"`);
    /* … and achromatic, where a failed line is rust. */
    const held = css.slice(css.indexOf(".line.you.held::after"));
    const rule = held.slice(0, held.indexOf("}"));
    expect(rule).not.toContain("--st-fail");
  });

  test("all of it is lowercase, like the rest of the wall's prose", () => {
    for (const s of [HELD_MARK, QUEUED_LINE, NO_ACCOUNT_HELD, handedBackNote(2, "left it", 1)]) {
      expect(s).toBe(s.toLowerCase());
    }
  });

  test("the hand-back note says where the words went, and what needs redoing", () => {
    expect(handedBackNote(1, "left it", 0)).toBe("left it — the held message is back in this card's draft");
    expect(handedBackNote(3, "cleared", 0)).toContain("the 3 held messages are back");
    expect(handedBackNote(1, "left it", 1)).toContain("needs attaching afresh");
  });

  test("the round's header is not mistaken for one of the wall's own envelopes", () => {
    /* Every recogniser here anchors on a prompt's first words, so a header that
       read as a relay, a resume or a pick-up would fold your words away as
       Skein's. */
    const said = composeRound([
      { text: "a", pictures: [] },
      { text: "b", pictures: [] },
    ]).echo;
    expect(isRelayPrompt(said)).toBe(false);
    expect(isResumePrompt(said)).toBe(false);
    expect(isPickUp(said)).toBe(false);
    expect(isCarryOn(said)).toBe(false);
    expect(cutsRound(said)).toBe(false);
  });
});
