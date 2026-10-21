import { describe, expect, test } from "bun:test";
import {
  DEFAULT_GROUP,
  SOURCE_NAME,
  checkLine,
  groupOf,
  nameFault,
  readSources,
  sourceReading,
  step,
  whereLine,
  type SourceRow,
} from "../src/lib/sources";

const row = (over: Partial<SourceRow> = {}): SourceRow => ({
  name: "nova-feedback",
  kind: "eventhub",
  consumer_group: "$Default",
  namespace: "ns-nova.servicebus.windows.net",
  entity: "es_nova_feedback",
  held: true,
  subscribers: 0,
  state: "idle",
  fault: "",
  ...over,
});

describe("what a source may be called", () => {
  test("a word a card can type, and the tail of a vault target", () => {
    for (const ok of ["nova-feedback", "a", "0x", "fabric.events_2", "a".repeat(64)]) expect(SOURCE_NAME.test(ok)).toBe(true);
    for (const bad of ["", "Nova", "-lead", ".lead", "has space", "a/b", "a".repeat(65), "é"]) {
      expect(SOURCE_NAME.test(bad)).toBe(false);
    }
  });

  test("the add form refuses a bad name, an empty one, and one that is already a source", () => {
    expect(nameFault("", [])).toContain("needs a name");
    expect(nameFault("Nova Feedback", [])).toContain("lowercase");
    expect(nameFault("nova-feedback", ["nova-feedback"])).toContain("already a source");
    expect(nameFault("  nova-feedback ", [])).toBe(null);
  });

  test("an empty consumer group means Event Hubs' default", () => {
    expect(groupOf("")).toBe(DEFAULT_GROUP);
    expect(groupOf("  ")).toBe("$Default");
    expect(groupOf(" volery ")).toBe("volery");
  });
});

describe("what a row says", () => {
  test("idle is not a fault: nothing subscribed, so not connected", () => {
    expect(sourceReading(row())).toEqual({ line: "idle — nothing subscribed, so not connected", tone: "rest" });
  });

  test("connected is celadon, connecting and retrying are amber", () => {
    expect(sourceReading(row({ state: "connected", subscribers: 1 })).tone).toBe("work");
    expect(sourceReading(row({ state: "connecting", subscribers: 1 })).tone).toBe("soft");
    const failing = sourceReading(row({ state: "failing", subscribers: 1, fault: "Unauthorized: token invalid" }));
    expect(failing).toEqual({ line: "failing, retrying — Unauthorized: token invalid", tone: "ask" });
  });

  test("no connection string is grey, until cards lean on it", () => {
    expect(sourceReading(row({ held: false }))).toEqual({ line: "no connection string held", tone: "rest" });
    expect(sourceReading(row({ held: false, subscribers: 2, state: "failing" }))).toEqual({
      line: "no connection string — the 2 subscriptions on it cannot be woken",
      tone: "fail",
    });
  });

  test("a check says what it reached, and a refusal in its own words", () => {
    expect(checkLine({ at: "unasked" })).toBe(null);
    expect(checkLine({ at: "asking" })?.line).toBe("checking…");
    expect(checkLine({ at: "good", who: "4 partitions on es_nova_feedback", when: 1 })).toEqual({
      line: "reachable — 4 partitions on es_nova_feedback",
      tone: "rest",
    });
    expect(checkLine({ at: "bad", said: "401 — the key was refused", when: 1 })?.tone).toBe("fail");
  });

  test("where it points, which group reads it, and who listens", () => {
    expect(whereLine(row())).toBe("es_nova_feedback on ns-nova.servicebus.windows.net · consumer group $Default · nothing subscribed");
    expect(whereLine(row({ subscribers: 1, consumer_group: "" }))).toContain("consumer group $Default · 1 subscription");
    expect(whereLine(row({ subscribers: 3, entity: "", namespace: "" }))).toBe("consumer group $Default · 3 subscriptions");
  });
});

describe("reading the list off the wire", () => {
  test("sorted by name, nameless rows dropped, an unknown state read as idle", () => {
    const got = readSources([
      { ...row({ name: "zeta" }) },
      { name: "" },
      null,
      { name: "alpha", state: "exploded", subscribers: "many", held: "yes" },
    ]);
    expect(got.map((r) => r.name)).toEqual(["alpha", "zeta"]);
    expect(got[0]).toMatchObject({ state: "idle", subscribers: 0, held: false, consumer_group: "" });
  });

  test("not a list is no rows", () => {
    expect(readSources(undefined)).toEqual([]);
    expect(readSources({ rows: [] })).toEqual([]);
  });
});

describe("j and k", () => {
  test("clamped at both ends, never wrapping", () => {
    expect(step(0, 1, 3)).toBe(1);
    expect(step(2, 1, 3)).toBe(2);
    expect(step(0, -1, 3)).toBe(0);
  });
  test("from nowhere, down lands on the first and up on the last", () => {
    expect(step(-1, 1, 3)).toBe(0);
    expect(step(-1, -1, 3)).toBe(2);
    expect(step(-1, 1, 0)).toBe(-1);
  });
});
