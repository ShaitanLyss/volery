import { describe, expect, test } from "bun:test";

import { NOT, dimsOf, matches, type UsageRow } from "../src/lib/analytics";
import {
  ALL,
  MORE,
  RAIL,
  activeOf,
  bare,
  chipSaid,
  countOf,
  dropped,
  excluded,
  filterSaid,
  labelOf,
  order,
  said,
  stored,
  toggled,
  valuesOf,
  withDimension,
} from "../src/lib/filterrail";

const T0 = Date.UTC(2026, 10, 12, 14, 0, 0);

function row(over: Partial<Record<string, string>> = {}): UsageRow {
  return {
    at: T0,
    host: "this-machine",
    session: "s1",
    agent: "a1",
    parentAgent: "",
    depth: 0,
    model: "claude-opus-5-5",
    effort: "high",
    cli: "2.1.301",
    source: "card",
    account: "personal",
    accountIdentity: "id-1",
    provider: "anthropic",
    project: "volery",
    provenance: "transcript",
    inTok: 10,
    outTok: 10,
    cacheRead: 100,
    write5m: 0,
    write1h: 0,
    requests: 1,
    usdReported: 0,
    ...over,
  } as unknown as UsageRow;
}

describe("the dimensions the rail offers", () => {
  test("the row of six and the four behind more do not overlap or repeat", () => {
    expect(RAIL).toHaveLength(6);
    expect(MORE).toHaveLength(4);
    expect(new Set(ALL.map((d) => d.dim)).size).toBe(ALL.length);
    expect(ALL).toHaveLength(10);
  });

  test("every dimension the rail offers is one a usage row actually carries", () => {
    /* A rail row for `card` or `branch` would be a picker with no values ever,
       because those are resolved through a join rather than carried. */
    const carried = Object.keys(dimsOf(row()));
    for (const { dim } of ALL) expect(carried).toContain(dim);
  });

  test("a dimension is named the way the wall names it", () => {
    expect(labelOf("host")).toBe("machine");
    expect(labelOf("subagent")).toBe("agent");
    expect(labelOf("provider")).toBe("provider");
    /* A dimension from a newer build keeps its own name rather than vanishing. */
    expect(labelOf("card" as never)).toBe("card");
  });
});

describe("the values a window holds", () => {
  test("distinct, sorted, and taken from the rows themselves", () => {
    const rows = [
      row({ project: "volery" }),
      row({ project: "nova" }),
      row({ project: "volery" }),
      row({ project: "" }),
    ];
    expect(valuesOf(rows, "project")).toEqual(["nova", "volery"]);
  });

  test("a dimension this tier does not carry has no values, and so is not offered", () => {
    /* An hourly row has no session, which is how the rail hides a fine-only
       dimension over a long span without a rule of its own. */
    const hourly = { hour: T0, host: "h", account: "a", provider: "p", model: "m", effort: "", cli: "", source: "s", project: "volery", provenance: "transcript", inTok: 1, outTok: 1, cacheRead: 0, write5m: 0, write1h: 0, requests: 1, usdReported: 0 } as unknown as UsageRow;
    expect(valuesOf([hourly], "session")).toEqual([]);
    expect(valuesOf([hourly], "project")).toEqual(["volery"]);
    expect(valuesOf([row()], "session")).toEqual(["s1"]);
  });
});

describe("writing a choice down", () => {
  test("the prefix is the storage format and nothing else spells it", () => {
    expect(NOT).toBe("!");
    expect(stored("deepseek", true)).toBe("!deepseek");
    expect(stored("deepseek")).toBe("deepseek");
    expect(excluded("!deepseek")).toBe(true);
    expect(excluded("deepseek")).toBe(false);
    expect(bare("!deepseek")).toBe("deepseek");
    expect(bare("deepseek")).toBe("deepseek");
  });

  test("including and excluding the same value cannot both be true", () => {
    let values = toggled([], "deepseek", true);
    expect(values).toEqual(["!deepseek"]);
    values = toggled(values, "deepseek", false);
    expect(values).toEqual(["deepseek"]);
    values = toggled(values, "deepseek", true);
    expect(values).toEqual(["!deepseek"]);
  });

  test("a toggle keeps the order readable and stable", () => {
    const values = toggled(toggled(toggled([], "volery"), "nova"), "deepseek", true);
    expect(values).toEqual(["nova", "volery", "!deepseek"]);
    /* Same filter, different press order, same value: `viewMatches` compares
       these, and a chip must not reorder under the pointer. */
    const other = toggled(toggled(toggled([], "deepseek", true), "volery"), "nova");
    expect(other).toEqual(values);
  });

  test("dropping removes both spellings of a value", () => {
    expect(dropped(["volery", "!volery"], "volery")).toEqual([]);
    expect(dropped(["volery", "nova"], "volery")).toEqual(["nova"]);
  });
});

describe("a dimension with nothing chosen is removed, never stored empty", () => {
  test("an empty list would mean none, which is a different question", () => {
    const withOne = withDimension({}, "provider", ["!deepseek"]);
    expect(withOne).toEqual({ provider: ["!deepseek"] });
    expect(withDimension(withOne, "provider", [])).toEqual({});
  });

  test("setting one dimension leaves the others alone", () => {
    const filter = withDimension(withDimension({}, "provider", ["!deepseek"]), "project", ["volery"]);
    expect(filter).toEqual({ provider: ["!deepseek"], project: ["volery"] });
    expect(withDimension(filter, "project", [])).toEqual({ provider: ["!deepseek"] });
  });
});

describe("the chips", () => {
  test("the active dimensions come in the rail's order, not insertion order", () => {
    const filter = withDimension(withDimension({}, "project", ["volery"]), "provider", ["!deepseek"]);
    expect(activeOf(filter).map((a) => a.dim)).toEqual(["provider", "project"]);
    expect(countOf(filter)).toBe(2);
  });

  test("a dimension the rail cannot render is kept and shown last", () => {
    /* A spec from a newer build, or one written by hand. A surface that dropped
       it would draw rows its filter says were excluded. */
    const active = activeOf({ card: ["c-1"] });
    expect(active).toHaveLength(1);
    expect(active[0].dim).toBe("card");
    expect(active[0].label).toBe("card");
  });

  test("a choice reads as a person says it", () => {
    expect(said(["!deepseek"])).toBe("not deepseek");
    expect(said(["volery"])).toBe("volery");
    expect(said(["volery", "!deepseek"])).toBe("volery, not deepseek");
    expect(chipSaid("provider", ["!deepseek"])).toBe("provider · not deepseek");
    expect(chipSaid("host", ["this-machine"])).toBe("machine · this-machine");
  });

  test("past three values it counts the rest rather than becoming a paragraph", () => {
    expect(said(["a", "b", "c"])).toBe("a, b, c");
    expect(said(["a", "b", "c", "d"])).toBe("a, b and 2 more");
  });

  test("a whole filter is one sentence, and no filters is said out loud", () => {
    expect(filterSaid({})).toBe("no filters");
    expect(filterSaid(withDimension(withDimension({}, "project", ["volery"]), "provider", ["!deepseek"]))).toBe(
      "provider is not deepseek, project is volery",
    );
  });
});

describe("matching, with exclusions", () => {
  const dims = { provider: "anthropic", project: "volery", model: "opus-5" };

  test("an allow-list still means one of these", () => {
    expect(matches({ project: ["volery"] }, dims)).toBe(true);
    expect(matches({ project: ["nova"] }, dims)).toBe(false);
    expect(matches({ project: ["nova", "volery"] }, dims)).toBe(true);
  });

  test("an exclusion means everything but these", () => {
    /* The whole point of the change: "hide deepseek" has to be sayable without
       enumerating every other provider. */
    expect(matches({ provider: ["!deepseek"] }, dims)).toBe(true);
    expect(matches({ provider: ["!anthropic"] }, dims)).toBe(false);
    expect(matches({ provider: ["!deepseek", "!openai"] }, dims)).toBe(true);
  });

  test("inclusions and exclusions in one list are both honoured", () => {
    expect(matches({ model: ["opus-5", "!opus-6"] }, { model: "opus-5" })).toBe(true);
    expect(matches({ model: ["opus-6", "!opus-6"] }, { model: "opus-6" })).toBe(false);
    expect(matches({ model: ["opus-6", "!opus-5"] }, { model: "opus-5" })).toBe(false);
    expect(matches({ model: ["opus-6", "!opus-5"] }, { model: "opus-4" })).toBe(false);
  });

  test("every dimension still has to pass, and an unnamed one is unfiltered", () => {
    expect(matches({ provider: ["!deepseek"], project: ["nova"] }, dims)).toBe(false);
    expect(matches({ provider: ["!deepseek"] }, dims)).toBe(true);
    expect(matches({}, dims)).toBe(true);
  });

  test("`*` still settles a dimension, and an empty list still means none", () => {
    /* The star is the one value that overrides the rest of its list, which is
       the contract the query layer has had since the first phase. "Everything
       but deepseek" is written as the exclusion alone. */
    expect(matches({ provider: ["*"] }, dims)).toBe(true);
    expect(matches({ provider: ["*", "!anthropic"] }, dims)).toBe(true);
    expect(matches({ provider: [] }, dims)).toBe(false);
  });

  test("a value somebody typed half of excludes nothing", () => {
    expect(matches({ provider: ["!"] }, dims)).toBe(true);
  });
});

describe("a filter round-trips through a saved view", () => {
  test("what the rail writes is what the query layer reads", () => {
    const filter = withDimension({}, "provider", ["!deepseek"]);
    const rows = [row({ provider: "anthropic" }), row({ provider: "deepseek" })];
    const kept = rows.filter((r) => matches(filter, dimsOf(r)));
    expect(kept).toHaveLength(1);
    expect(kept[0].provider).toBe("anthropic");
  });
});
