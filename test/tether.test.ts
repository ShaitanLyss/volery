import { expect, test, describe } from "bun:test";
import {
  TETHER,
  closingOf,
  goneFrom,
  pinOfGone,
  strayed,
  strays,
  wentFrom,
  tetherHost,
  tetherOf,
  tetheredTo,
} from "../src/lib/tether";
import { newWidget, normalizeWidget, specFor } from "../src/lib/widgets";
import { shadowKey } from "../src/lib/shadow";

const pin = (id: string, card: string | undefined) => ({
  id,
  config: card === undefined ? {} : { [TETHER]: card },
});

/* ── what a pin points at ──────────────────────────────────────────────── */

describe("a pin knows its card, and nothing else does", () => {
  test("the card rides in the config, and an empty one is no card", () => {
    expect(tetherOf(pin("w", "c1"))).toBe("c1");
    expect(tetherOf(pin("w", ""))).toBeNull();
    expect(tetherOf(pin("w", undefined))).toBeNull();
    expect(tetherOf({ config: { [TETHER]: 42 } })).toBeNull();
  });

  test("closing a card finds every view of it and no other", () => {
    const ws = [pin("a", "c1"), pin("b", "c2"), pin("c", "c1"), pin("d", undefined)];
    expect(tetheredTo(ws, "c1").map((w) => w.id)).toEqual(["a", "c"]);
    expect(tetheredTo(ws, "c3")).toEqual([]);
  });

  test("the wall a far card runs on is read back off its key, colons and all", () => {
    expect(tetherHost(shadowKey("lab", "abc-123"))).toBe("lab");
    expect(tetherHost(shadowKey("desk:2", "abc-123"))).toBe("desk:2");
    expect(tetherHost("c1")).toBeNull();
  });
});

/* ── when one comes down ──────────────────────────────────────────────── */

describe("a pin outlives nothing", () => {
  /* The launch's backstop behind the close path: a pin whose card here did not
     come back. A card on another wall is never answered here — its wall has
     not been heard yet. */
  test("at launch, a pin of a card here that is gone is a stray", () => {
    const far = shadowKey("lab", "x");
    const ws = [pin("a", "c1"), pin("b", "gone"), pin("c", far), pin("d", undefined)];
    expect(strays(ws, new Set(["c1"])).map((w) => w.id)).toEqual(["b"]);
  });

  test("a wall with no cards left makes every pin of a card here a stray", () => {
    /* The case a guard of "only once there are cards" would never reach. */
    expect(strays([pin("a", "c1"), pin("b", "c2")], new Set()).map((w) => w.id)).toEqual(["a", "b"]);
  });

  test("a wall just heard takes down the pins of its cards it no longer carries", () => {
    const keep = shadowKey("lab", "kept");
    const gone = shadowKey("lab", "closed");
    const other = shadowKey("desk", "closed");
    const ws = [pin("a", keep), pin("b", gone), pin("c", other), pin("d", "local")];
    expect(goneFrom(ws, "lab", new Set([keep])).map((w) => w.id)).toEqual(["b"]);
  });

  /* Quiet is not closed: `goneFrom` is only ever asked of a wall that has just
     spoken, and what it is asked is only about that wall's own cards. */
  test("another wall's pins are not that wall's to take down", () => {
    const ws = [pin("a", shadowKey("desk", "x")), pin("b", "local")];
    expect(goneFrom(ws, "lab", new Set())).toEqual([]);
  });
});

/* ── what the undo stack lets go of ──────────────────────────────────── */

describe("a closed card's pins leave the undo stack too", () => {
  const rec = (card: string | null) => (card === null ? null : { id: "w", kind: "said", config: { card } });

  /* Either side of the record: a take-down is `was` the pin, a hang-up is
     `now` the pin, and both would hang a view of nothing back up. */
  test("a record of a pin of a gone card is recognised whichever side holds it", () => {
    const gone = (c: string) => c === "c1";
    expect(pinOfGone({ at: "widget", was: rec("c1"), now: null }, gone)).toBe(true);
    expect(pinOfGone({ at: "widget", was: null, now: rec("c1") }, gone)).toBe(true);
    expect(pinOfGone({ at: "widget", was: rec("c2"), now: rec("c2") }, gone)).toBe(false);
  });

  test("nothing that is not a widget, and no widget that is not a pin", () => {
    const all = () => true;
    expect(pinOfGone({ at: "placement", was: rec("c1"), now: null }, all)).toBe(false);
    expect(pinOfGone({ at: "widget", was: { config: { variant: "x" } }, now: null }, all)).toBe(false);
    expect(pinOfGone({ at: "widget", was: { x: 1 }, now: 7 }, all)).toBe(false);
  });

  test("the per-card questions are the list questions, one card at a time", () => {
    const far = shadowKey("lab", "x");
    expect(strayed("gone", new Set())).toBe(true);
    expect(strayed("here", new Set(["here"]))).toBe(false);
    expect(strayed(far, new Set())).toBe(false);
    expect(wentFrom(far, "lab", new Set())).toBe(true);
    expect(wentFrom(far, "lab", new Set([far]))).toBe(false);
    expect(wentFrom(far, "desk", new Set())).toBe(false);
  });
});

/* ── how it ended ─────────────────────────────────────────────────────── */

describe("the closing paragraph", () => {
  test("is what the last blank line opens onto", () => {
    expect(closingOf("I changed three files.\n\nShall I push it?")).toBe("Shall I push it?");
  });

  test("a message with no blank line is its own last paragraph", () => {
    expect(closingOf("one line\nand another")).toBe("one line\nand another");
  });

  test("trailing blank lines are not a paragraph", () => {
    expect(closingOf("first\n\nsecond\n\n\n")).toBe("second");
  });

  /* Splitting inside a fence would hand back the bottom half of a code block
     with no fence round it, which reads as prose. */
  test("a blank line inside a fence is code, not a paragraph break", () => {
    const text = "Here it is:\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```";
    expect(closingOf(text)).toBe("```ts\nconst a = 1;\n\nconst b = 2;\n```");
  });

  test("a tilde fence closes only on its own mark", () => {
    const text = "intro\n\n~~~\n```\n\nstill code\n~~~";
    expect(closingOf(text)).toBe("~~~\n```\n\nstill code\n~~~");
  });

  test("windows line endings read the same", () => {
    expect(closingOf("a\r\n\r\nb")).toBe("b");
  });

  test("nothing said is nothing", () => {
    expect(closingOf("")).toBe("");
    expect(closingOf("\n\n")).toBe("");
  });
});

/* ── the catalogue's half ─────────────────────────────────────────────── */

describe("a card's last message, as a widget", () => {
  test("it is tethered, and hung up from its card", () => {
    expect(specFor("said")?.tether).toBe(true);
    const w = newWidget("said", 0, 0, 0, "c1");
    expect(tetherOf(w)).toBe("c1");
  });

  test("its card survives the round trip off disk", () => {
    const w = newWidget("said", 100, 50, 3, "c1");
    const back = normalizeWidget(JSON.parse(JSON.stringify(w)))!;
    expect(tetherOf(back)).toBe("c1");
    expect(back.config.variant).toBe("whole");
  });

  /* A view of nothing has no default that could stand in for it — the next
     card along would be somebody else's words under this one's frame. */
  test("one that names no card is left off the wall", () => {
    const w = newWidget("said", 0, 0);
    expect(tetherOf(w)).toBeNull();
    expect(normalizeWidget(JSON.parse(JSON.stringify(w)))).toBeNull();
    expect(normalizeWidget({ ...w, config: { [TETHER]: "" } })).toBeNull();
  });

  test("a card is ignored by every kind that is not tethered", () => {
    expect(tetherOf(newWidget("clock", 0, 0, 0, "c1"))).toBeNull();
  });
});
