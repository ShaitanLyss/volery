import { describe, expect, test } from "bun:test";
import { COST, VERBS, refusal, verbsFor, type Remote } from "../src/lib/handle";
import { menuFor } from "../src/lib/menu";

const lab = (over: Partial<Remote> = {}): Remote => ({
  host: "lab",
  unheard: false,
  acts: new Set(),
  closes: true,
  ...over,
});
const ids = (t: Parameters<typeof menuFor>[0]) =>
  menuFor(t).flatMap((i) => (i.kind === "item" || i.kind === "more" ? [i.id] : []));

describe("which verbs a card can be asked", () => {
  test("a card on this wall has them all, which is the answer its menu always had", () => {
    expect(verbsFor(null)).toBeNull();
    expect(refusal(null, "clear")).toBeNull();
  });

  /* Today's shadow: nothing announced, so the two it has always had. */
  test("a wall announcing no verbs gets the glass and the close", () => {
    expect([...verbsFor(lab())!].sort()).toEqual(["close", "glass"]);
  });

  test("an announced verb is offered, an unannounced one is not", () => {
    const v = verbsFor(lab({ acts: new Set(["aside", "clear"]) }))!;
    expect(v.has("aside")).toBe(true);
    expect(v.has("clear")).toBe(true);
    expect(v.has("wake")).toBe(false);
  });

  /* Account and ignore-caps are `work`: the owner's money. Allowed remotely
     (Lyss: "i am the owner everywhere") but gated like a prompt. */
  test("account, bypass and clear can be asked remotely once announced", () => {
    const v = verbsFor(lab({ acts: new Set(["account", "bypass", "clear"]) }))!;
    for (const k of ["account", "bypass", "clear"] as const) expect(v.has(k)).toBe(true);
  });

  /* A wall that has gone quiet is offered nothing that would have to reach it,
     whatever it once announced — never queued for a lid to lift. */
  test("an unheard wall offers nothing that has to reach it", () => {
    const v = verbsFor(lab({ unheard: true, acts: new Set(VERBS) }))!;
    expect([...v].sort()).toEqual(["close", "glass"]);
    expect(refusal(lab({ unheard: true }), "aside")).toBe("lab has not been heard from");
  });

  test("what is local by nature is never offered, and says where it is", () => {
    const v = verbsFor(lab({ acts: new Set(VERBS) }))!;
    for (const k of VERBS.filter((k) => COST[k] === "local")) {
      expect(v.has(k)).toBe(false);
      expect(refusal(lab(), k)).toBe("that is on lab");
    }
  });

  test("a verb the wall has not been updated for says so", () => {
    expect(refusal(lab(), "clear")).toBe("lab needs updating to do that from here");
  });

  /* The table is complete: every verb has a cost, so a verb added to `Verb`
     cannot slip through ungated. */
  test("every verb has a cost", () => {
    for (const v of VERBS) expect(COST[v]).toBeDefined();
  });
});

describe("the menu a shadow gets is the card's, filtered", () => {
  test("unannounced: glass and close, as before", () => {
    expect(ids({ kind: "shadow", host: "lab", verbs: verbsFor(lab()) })).toEqual(["glass", "close"]);
  });

  test("announced verbs reach the same rows a local card has", () => {
    const verbs = verbsFor(lab({ acts: new Set(["aside", "bypass", "account", "clear", "wake"]) }));
    const got = ids({
      kind: "shadow",
      host: "lab",
      verbs,
      dormant: true,
      spoken: true,
      accounts: true,
      accountPicks: [
        { id: "a", label: "a", on: true },
        { id: "b", label: "b", on: false },
      ],
    });
    expect(got).toEqual(["wake", "aside", "bypass", "account", "glass", "clear", "close"]);
  });

  test("a local card is untouched by any of it", () => {
    expect(ids({ kind: "card" })).toEqual(ids({ kind: "card", verbs: null }));
    expect(ids({ kind: "card" })).toContain("copy-resume");
  });
});
