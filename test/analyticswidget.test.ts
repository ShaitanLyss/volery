import { describe, expect, test } from "bun:test";

import { normalizeView } from "../src/lib/analytics";
import {
  SIZE,
  SIZES,
  SPEC,
  SNAPSHOT,
  VIEW,
  boardPanels,
  changeAgainst,
  changeSaid,
  configOf,
  defaultSpec,
  forkedOf,
  pathOf,
  resolveOf,
  shareSaid,
  sizeOf,
  snapshotOf,
  spanMsFor,
  seriesPath,
  statOf,
  type AnalyticsConfig,
} from "../src/lib/analyticswidget";
import type { SavedView } from "../src/lib/analyticpage";
import { VARIANT, WIDGETS } from "../src/lib/widgets";

const T0 = Date.UTC(2026, 10, 12, 14, 0, 0);

function saved(over: Partial<SavedView> = {}): SavedView {
  return {
    id: "v1",
    name: "weekly allowance",
    view: normalizeView({ name: "weekly allowance", span: "7d" }),
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function cfg(over: Partial<AnalyticsConfig> = {}): AnalyticsConfig {
  return { size: "chart", view: "", spec: "", snapshot: "", ...over };
}

describe("a size intent is one of three, and anything else is the chart", () => {
  test("the three the menu offers are the three the face draws", () => {
    expect(SIZES.map((s) => s.key)).toEqual(["stat", "chart", "board"]);
  });

  test("the size knob is the catalogue's own variant key, not a second one", () => {
    /* Two spellings of one key is a widget whose menu row writes a field its
       face never reads. `widgets.ts` imports `SIZES` from here and cannot
       import the key back without a cycle, so the two literals are held
       together here instead. */
    expect(SIZE).toBe(VARIANT);
    const spec = WIDGETS.find((w) => w.kind === "analytics");
    expect(spec?.params[0]?.key).toBe(VARIANT);
    expect(spec?.params[0]?.options.map((o) => o.value)).toEqual(SIZES.map((s) => s.key));
  });

  test("an older build's word, or nothing, degrades rather than throwing", () => {
    expect(sizeOf("stat")).toBe("stat");
    expect(sizeOf("board")).toBe("board");
    expect(sizeOf("chart")).toBe("chart");
    expect(sizeOf("huge")).toBe("chart");
    expect(sizeOf(undefined)).toBe("chart");
    expect(sizeOf(7)).toBe("chart");
  });
});

describe("a config, read defensively", () => {
  test("a real config comes through whole", () => {
    const config = { [SIZE]: "stat", [VIEW]: "v1", [SPEC]: "{}", [SNAPSHOT]: "{}", frame: "bare" };
    expect(configOf(config)).toEqual({ size: "stat", view: "v1", spec: "{}", snapshot: "{}" });
  });

  test("the keys the wall does not hold read as empty, not undefined", () => {
    expect(configOf({})).toEqual({ size: "chart", view: "", spec: "", snapshot: "" });
    expect(configOf({ view: 7 as unknown as string })).toEqual(cfg());
  });
});

describe("what a widget reads, and whether it is a reading or a copy", () => {
  /* The distinction §12 draws, and the one a snapshot exists for. */
  test("a shared id draws the library's spec, under the library's name", () => {
    const one = saved();
    const reading = resolveOf(cfg({ view: "v1" }), [one]);
    expect(reading?.shared).toBe("v1");
    expect(reading?.gone).toBe(false);
    expect(reading?.name).toBe("weekly allowance");
    expect(reading?.spec).toEqual(one.view);
  });

  test("a saved view that is gone draws the snapshot and says so", () => {
    const kept = normalizeView({ name: "weekly allowance", span: "30d" });
    const reading = resolveOf(cfg({ view: "v1", snapshot: JSON.stringify(kept) }), []);
    expect(reading?.shared).toBe("v1");
    expect(reading?.gone).toBe(true);
    expect(reading?.spec.span).toBe("30d");
    expect(shareSaid(reading!)).toBe("shared: weekly allowance · that view is gone");
  });

  test("one that is gone and never drew has nothing to draw, and is left off", () => {
    expect(resolveOf(cfg({ view: "v1" }), [])).toBe(null);
    expect(resolveOf(cfg({ view: "v1", snapshot: "not json" }), [])).toBe(null);
  });

  test("a library nobody has read yet is not a library without the view in it", () => {
    /* The second between a launch and the library's answer. Claiming the view
       was deleted there is a false statement about the user's data, so an
       unread library draws the snapshot and says nothing. */
    const kept = normalizeView({ name: "weekly allowance", span: "30d" });
    const quiet = resolveOf(cfg({ view: "v1", snapshot: JSON.stringify(kept) }), [], false);
    expect(quiet?.gone).toBe(false);
    expect(quiet?.spec.span).toBe("30d");
    expect(shareSaid(quiet!)).toBe("shared: weekly allowance");
    const known = resolveOf(cfg({ view: "v1", snapshot: JSON.stringify(kept) }), [], true);
    expect(known?.gone).toBe(true);
  });

  test("an inline spec is a copy, named by itself", () => {
    const spec = normalizeView({ name: "my own", span: "24h" });
    const reading = resolveOf(cfg({ spec: JSON.stringify(spec) }), [saved()]);
    expect(reading?.shared).toBe(null);
    expect(reading?.name).toBe("my own");
    expect(reading?.spec.span).toBe("24h");
    expect(shareSaid(reading!)).toBe("this widget only");
  });

  test("a widget just hung up has no spec, and opens on the overlay's default", () => {
    const reading = resolveOf(cfg(), []);
    expect(reading?.spec).toEqual(defaultSpec());
    expect(reading?.gone).toBe(false);
  });

  test("a spec that was written and will not parse is refused, not defaulted", () => {
    /* The two cases are genuinely different: nothing written is a new widget,
       something written that cannot be read is a widget from a build this one
       does not understand, and drawing a default in its place would invent a
       reading. */
    expect(resolveOf(cfg({ spec: "{oops" }), [])).toBe(null);
    expect(resolveOf(cfg({ spec: "null" }), [])).toBe(null);
    expect(resolveOf(cfg({ spec: "[1,2]" }), [])).toBe(null);
    expect(resolveOf(cfg({ spec: "   " }), [])?.spec).toEqual(defaultSpec());
  });

  test("a retired field inside a parseable spec degrades, as every opaque config does", () => {
    const reading = resolveOf(cfg({ spec: JSON.stringify({ span: "7d", panels: [{ measure: "euros" }] }) }), []);
    expect(reading?.spec.span).toBe("7d");
    expect(reading?.spec.panels[0].measure).toBe("usd_modeled");
  });
});

describe("a shared widget keeps what it last drew", () => {
  test("a successful read of a shared view writes its spec beside the id", () => {
    const reading = resolveOf(cfg({ view: "v1" }), [saved()])!;
    const next = snapshotOf(cfg({ view: "v1" }), reading);
    expect(next).toBe(JSON.stringify(reading.spec));
  });

  test("an unchanged spec writes nothing, so a widget cannot update itself forever", () => {
    const reading = resolveOf(cfg({ view: "v1" }), [saved()])!;
    const settled = cfg({ view: "v1", snapshot: JSON.stringify(reading.spec) });
    expect(snapshotOf(settled, reading)).toBe(null);
  });

  test("a copy writes nothing, and neither does a snapshot already being read", () => {
    const spec = JSON.stringify(defaultSpec());
    const copy = resolveOf(cfg({ spec }), [])!;
    expect(snapshotOf(cfg({ spec }), copy)).toBe(null);
    /* A widget reading its own snapshot is drawing the view it was left with,
       so there is nothing new to write and the face must not write on frame. */
    const gone = resolveOf(cfg({ view: "v1", snapshot: spec }), [])!;
    expect(snapshotOf(cfg({ view: "v1", snapshot: spec }), gone)).toBe(null);
  });

  test("forking turns the snapshot into an inline copy and drops the id", () => {
    const reading = resolveOf(cfg({ view: "v1", snapshot: JSON.stringify(normalizeView({ span: "90d" })) }), [])!;
    const forked = forkedOf(
      { size: "board", [VIEW]: "v1", [SNAPSHOT]: "{}" } as Record<string, string | number | boolean>,
      reading,
    );
    expect(forked[VIEW]).toBe("");
    expect(forked[SNAPSHOT]).toBe("");
    expect(JSON.parse(forked[SPEC] as string).span).toBe("90d");
    /* Everything else the widget was told survives: a fork is about what it
       reads, not about how it is drawn. */
    expect(forked.size).toBe("board");
    expect(resolveOf(configOf(forked), [])?.shared).toBe(null);
  });
});

describe("the figure and what it is compared with", () => {
  test("a change is against the window before, as a share of it", () => {
    const stat = statOf({ value: 120, unpriced: 0 }, { value: 100, unpriced: 0 });
    expect(stat.change).toBeCloseTo(20, 10);
    expect(changeSaid(stat)).toBe("up 20%");
    expect(changeSaid(statOf({ value: 80, unpriced: 0 }, { value: 100, unpriced: 0 }))).toBe("down 20%");
  });

  test("nothing before is not a change of zero", () => {
    /* The one reading this widget must not invent: a first week drawn as
       "level" says a comparison happened and neither window was empty. */
    const stat = statOf({ value: 120, unpriced: 0 }, null);
    expect(stat.change).toBe(null);
    expect(changeSaid(stat)).toBe("");
    const quiet = statOf({ value: 120, unpriced: 0 }, { value: 0, unpriced: 0 });
    expect(quiet.change).toBe(null);
    expect(changeSaid(quiet)).toBe("");
  });

  test("an unpriceable window has no figure at all", () => {
    const stat = statOf({ value: null, unpriced: 12 }, { value: 100, unpriced: 0 });
    expect(stat.value).toBe(null);
    expect(stat.change).toBe(null);
  });

  test("a movement under half a percent is level, not +0%", () => {
    expect(changeSaid(statOf({ value: 100, unpriced: 0 }, { value: 100, unpriced: 0 }))).toBe("about level");
    expect(changeSaid(statOf({ value: 100.2, unpriced: 0 }, { value: 100, unpriced: 0 }))).toBe("about level");
  });

  test("the comparison names a duration, not a control's literal", () => {
    expect(changeAgainst("7d")).toBe("against the last 7 days before it");
    expect(changeAgainst("2h")).toBe("against the last 2h before it");
  });

  test("the span a widget asks for is the one the overlay asks for", () => {
    expect(spanMsFor("24h")).toBe(24 * 3_600_000);
    expect(spanMsFor("7d")).toBe(7 * 24 * 3_600_000);
    /* A span this build cannot name falls back to the overlay's own default
       rather than to a window nobody chose. */
    expect(spanMsFor("nonsense")).toBe(7 * 24 * 3_600_000);
  });
});

describe("a sparkline", () => {
  const p = (at: number, value: number) => ({ at, value });

  test("two points draw a line between them", () => {
    const d = pathOf([p(0, 0), p(100, 10)], 100, 20, 2);
    expect(d).toBe("M2.0 18.0L98.0 2.0");
  });

  test("a flat window draws along the floor rather than at the top", () => {
    /* A series whose values are all zero has no top to scale against, and a
       line pinned to the top of the box would draw a spike that is not there. */
    expect(pathOf([p(0, 0), p(100, 0)], 100, 20, 2)).toBe("");
  });

  test("one point is not a line", () => {
    expect(pathOf([p(0, 5)], 100, 20, 2)).toBe("");
    expect(pathOf([], 100, 20, 2)).toBe("");
  });

  test("a box with no size draws nothing rather than NaN", () => {
    expect(pathOf([p(0, 1), p(10, 2)], 0, 20, 2)).toBe("");
    expect(pathOf([p(0, 1), p(10, 2)], 100, 0, 2)).toBe("");
  });

  test("a gap in the record is a gap in the x axis, not a closed-up line", () => {
    const d = pathOf([p(0, 1), p(10, 2), p(1000, 3)], 100, 20, 0);
    expect(d).toBe("M0.0 13.3L1.0 6.7L100.0 0.0");
  });

  test("a point that is not a number is left out rather than drawn as NaN", () => {
    expect(pathOf([p(0, 1), p(Number.NaN, 2), p(10, 3)], 100, 20, 0)).toBe("M0.0 13.3L100.0 0.0");
  });

  test("a chart's axis is the window's, not each series' own", () => {
    /* Two series on one plot must be drawn against one scale, or a series worth
       a tenth of another reaches the top of the box beside it. */
    const small = seriesPath([p(0, 5), p(10, 5)], 0, 10, 10, 100, 20, 0);
    expect(small).toBe("M0.0 10.0L100.0 10.0");
    expect(seriesPath([p(0, 10), p(10, 10)], 0, 10, 10, 100, 20, 0)).toBe("M0.0 0.0L100.0 0.0");
  });

  test("a series with nothing in it draws nothing at all", () => {
    expect(seriesPath([], 0, 10, 10, 100, 20, 0)).toBe("");
    expect(seriesPath([p(0, 1)], 0, 10, 10, 100, 20, 0)).toBe("");
    expect(seriesPath([p(0, 1), p(10, 2)], 0, 10, 0, 100, 20, 0)).toBe("");
  });
});

describe("the board's panels", () => {
  test("a split spends the third panel on the split", () => {
    expect(boardPanels("project").map((p) => p.id)).toEqual(["trend", "split"]);
    expect(boardPanels("project")[1].title).toBe("by project");
  });

  test("with nothing to divide, the panel says the numbers instead", () => {
    expect(boardPanels(null).map((p) => p.id)).toEqual(["trend", "numbers"]);
  });
});
