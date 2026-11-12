import { describe, expect, test } from "bun:test";

import {
  bucketOf,
  dimsOf,
  filterRows,
  fold,
  money,
  normalizeView,
  type Fact,
  type Filter,
  type UsageRow,
} from "../src/lib/analytics";
import {
  bucketLabel,
  roomBucket,
  splitSeries,
  windowTier,
  type AnalyticsWindow,
  type RoomMeasure,
  type RoomSplit,
} from "../src/lib/analyticsroom";
import {
  asSavedViews,
  coverOf,
  figureOf,
  naturalFor,
  otherPresentation,
  pageModel,
  panelNote,
  presentationFor,
  refusalOf,
  surfaceOfView,
  viewMatches,
  viewOfSurface,
  PRESENTATION_STORE,
  type SurfaceInput,
} from "../src/lib/analyticpage";
import { fixtureWindow } from "../src/lib/analyticsfixture";
import { dateLine } from "../src/lib/clock";
import { windowRequest } from "../src/lib/analyticsroom";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);

function fact(over: Partial<Fact> = {}): Fact {
  return {
    at: T0,
    host: "here",
    session: "s1",
    agent: "",
    parentAgent: "",
    depth: 0,
    model: "claude-opus-5-5",
    effort: "high",
    cli: "2.1.288",
    source: "card",
    account: "lyss",
    accountIdentity: "",
    provider: "anthropic",
    project: "volery",
    provenance: "transcript",
    inTok: 1000,
    outTok: 500,
    cacheRead: 10_000,
    write5m: 0,
    write1h: 0,
    requests: 1,
    usdReported: 0,
    ...over,
  };
}

function windowOf(rows: UsageRow[], over: Partial<AnalyticsWindow> = {}): AnalyticsWindow {
  return {
    tier: "fine",
    since: T0,
    until: T0 + 7 * DAY,
    rows,
    cards: 2,
    first: T0 - 30 * DAY,
    recorded: 500,
    ...over,
  };
}

/** The room's side of the same call, computed here rather than borrowed, so
 *  the comparison below is between two implementations and not one. */
function roomSeries(win: AnalyticsWindow, measure: RoomMeasure, split: RoomSplit, bucket: "5m" | "1h" | "1d" | "1w", filter: Filter = {}) {
  const rows = filterRows(win.rows, filter, dimsOf);
  return splitSeries(rows, measure, bucket, split, new Map());
}

/* ── the page and the room must draw one set of numbers ────────────────────*/

describe("the page draws what the room draws", () => {
  const win = fixtureWindow(windowRequest("7d", T0 + 7 * DAY), "normal");
  const spanMs = 7 * DAY;
  const bucket = roomBucket(spanMs, windowTier(spanMs));

  for (const [measure, split] of [
    ["usd_modeled", null],
    ["usd_modeled", "project"],
    ["tokens", "account"],
    ["tokens", "model"],
  ] as [RoomMeasure, RoomSplit][]) {
    test(`${measure}${split ? ` by ${split}` : ""} agrees, point for point`, () => {
      const page = pageModel({ window: win, measure, split, bucket, span: "7d" });
      const room = roomSeries(win, measure, split, bucket);

      expect(page.series.length).toBe(room.length);
      page.series.forEach((s, i) => {
        expect(s.key).toBe(room[i].key);
        expect(s.label).toBe(room[i].label);
        expect(s.slot).toBe(room[i].slot);
        expect(s.color).toBe(room[i].color);
        expect(s.total).toBe(room[i].total);
        expect(s.unpriced).toBe(room[i].unpriced);
        expect(s.points).toEqual(room[i].points);
      });

      /* And the figure is the same total, against the query layer's own fold:
         the skin must not have become a data change (§11.15). */
      const folded = fold(filterRows(win.rows, {}, dimsOf), measure);
      expect(page.figure.total).toBe(folded.value);
      if (folded.value !== null) {
        expect(page.figure.total).toBeCloseTo(
          page.series.reduce((a, s) => a + (s.points.length ? s.total : 0), 0),
          9,
        );
      }
      expect(page.figure.unpriced).toBe(folded.unpriced);
    });
  }

  test("a filter cuts the rows the page draws, and the room with it", () => {
    const filter = { project: ["volery"] };
    const page = pageModel({ window: win, filter, measure: "usd_modeled", split: "account", bucket, span: "7d" });
    const room = roomSeries(win, "usd_modeled", "account", bucket, filter);
    expect(page.series.map((s) => [s.key, s.total])).toEqual(room.map((s) => [s.key, s.total]));
    const total = page.series.reduce((a, s) => a + s.total, 0);
    expect(total).toBeCloseTo(page.figure.total ?? 0, 9);
  });
});

/* ── the figure ────────────────────────────────────────────────────────────*/

describe("the figure", () => {
  test("the peak is the heaviest recorded bucket, and the total is every band", () => {
    const rows = [
      fact({ at: T0, inTok: 100, outTok: 0, cacheRead: 0 }),
      fact({ at: T0, inTok: 200, outTok: 0, cacheRead: 0 }),
      fact({ at: T0 + HOUR, inTok: 5000, outTok: 0, cacheRead: 0 }),
      fact({ at: T0 + 2 * HOUR, inTok: 50, outTok: 0, cacheRead: 0 }),
    ];
    const list = splitSeries(rows, "tokens", "1h", null);
    const fig = figureOf(rows, list, fold(rows, "tokens"), "tokens", "1h", T0, T0 + 4 * HOUR);
    expect(fig.total).toBe(5350);
    expect(fig.peak?.at).toBe(T0 + HOUR);
    expect(fig.peak?.value).toBe(5000);
    expect(fig.peak?.label).toBe(bucketLabel(T0 + HOUR, "1h"));
    expect(fig.peak?.share).toBeCloseTo((5000 / 5350) * 100, 6);
    expect(fig.recorded).toBe(3);
    expect(fig.gaps).toBe(0);
  });

  test("a hole is a gap, not a zero, and is counted as one", () => {
    const rows = [fact({ at: T0 }), fact({ at: T0 + HOUR }), fact({ at: T0 + 8 * HOUR })];
    const list = splitSeries(rows, "tokens", "1h", null);
    const fig = figureOf(rows, list, fold(rows, "tokens"), "tokens", "1h", T0, T0 + 9 * HOUR);
    expect(fig.recorded).toBe(3);
    expect(fig.gaps).toBe(1);
    expect(fig.total).toBe(3 * 11_500);
  });

  test("nothing priceable is null, never zero", () => {
    const rows = [fact({ account: "@deepseek", provider: "deepseek", model: "deepseek-flash" })];
    const list = splitSeries(rows, "usd_modeled", "1h", null);
    const fig = figureOf(rows, list, fold(rows, "usd_modeled"), "usd_modeled", "1h", T0, T0 + HOUR);
    expect(fig.total).toBeNull();
    expect(fig.mean).toBeNull();
    expect(fig.unpriced).toBe(1);
    expect(fig.peak).toBeNull();
  });

  test("an empty series has no peak and no mean", () => {
    const fig = figureOf([], [], { value: null, unpriced: 0 }, "usd_modeled", "1h", T0, T0 + HOUR);
    expect(fig).toMatchObject({ total: null, peak: null, day: null, recorded: 0, mean: null, gaps: 0 });
  });

  /* §11.8's sentence is about a day; the rung a week is drawn at is an hour.
     The two are different readings and the figure holds both. */
  test("the day is a day, even when the drawn rung is an hour", () => {
    const day1 = T0;
    const day2 = T0 + DAY;
    const rows = [
      fact({ at: day1, inTok: 100, outTok: 0, cacheRead: 0 }),
      fact({ at: day1 + HOUR, inTok: 100, outTok: 0, cacheRead: 0 }),
      fact({ at: day1 + 2 * HOUR, inTok: 100, outTok: 0, cacheRead: 0 }),
      fact({ at: day2, inTok: 200, outTok: 0, cacheRead: 0 }),
    ];
    const list = splitSeries(rows, "tokens", "1h", null);
    const fig = figureOf(rows, list, fold(rows, "tokens"), "tokens", "1h", day1, day2 + DAY);
    expect(fig.peak?.value).toBe(200);
    expect(fig.day?.value).toBe(300);
    expect(fig.day?.at).toBe(bucketOf(day1, "1d"));
    expect(fig.day?.label).toBe(dateLine(day1));
    expect(fig.day?.share).toBeCloseTo(60, 6);
    expect(fig.days).toBe(2);
    expect(fig.dayMean).toBe(250);
  });
});

/* ── the prose, from the template table ────────────────────────────────────*/

describe("the story", () => {
  const page = (win: AnalyticsWindow, measure: RoomMeasure = "usd_modeled", extra = {}) =>
    pageModel({ window: win, measure, split: "project", bucket: "1d" as const, span: "7d", ...extra });

  test("a normal week says its total, its requests, and its heaviest day", () => {
    const win = windowOf([fact({ at: T0 }), fact({ at: T0 + DAY, inTok: 9000 }), fact({ at: T0 + 2 * DAY })]);
    const p = page(win);
    expect(p.story.lede.startsWith("The last 7 days cost ")).toBe(true);
    expect(p.story.lede).toContain(money(p.figure.total ?? 0));
    expect(p.story.lede).toContain("across 3 requests");
    expect(p.story.lede).toContain("the heaviest day");
    expect(p.story.empty).toBe(false);
    expect(p.story.sections.map((s) => s.id)).toEqual(["changed", "went", "worked"]);
  });

  /* The breaks prove only what is between readings: an empty bucket is equally
     "no request" and "nobody was recording", so the prose claims nothing about
     the window's two edges. */
  test("a window whose readings stop before its end does not claim completeness", () => {
    const rows = [fact({ at: T0 }), fact({ at: T0 + HOUR })];
    const win = windowOf(rows, { until: T0 + 8 * HOUR });
    const changed = page(win).story.sections.find((s) => s.id === "changed")!;
    expect(changed.body).toContain("every bucket between the first reading and the last");
    expect(changed.body).not.toContain("every bucket in the window");
  });

  test("a day the measure cannot price is not a divisor for the average day", () => {
    const priced = fact({ at: T0 });
    const unpriced = fact({ at: T0 + DAY, account: "@deepseek", provider: "deepseek", model: "deepseek-flash" });
    const p = page(windowOf([priced, unpriced]));
    expect(p.figure.days).toBe(1);
    expect(p.figure.dayMean).toBeCloseTo(p.figure.day?.value ?? 0, 9);
  });

  test("the plan is only mentioned when there is a plan reading", () => {
    const win = windowOf([fact()]);
    expect(page(win).story.lede).not.toContain("weekly limit");
    expect(page(win, "usd_modeled", { plan: { limit: 100, used: 40, resetsAt: null } }).story.lede).toContain(
      "well inside the weekly limit",
    );
    expect(page(win, "usd_modeled", { plan: { limit: 100, used: 90, resetsAt: null } }).story.lede).toContain(
      "a little ahead of plan",
    );
    expect(page(win, "usd_modeled", { plan: { limit: 100, used: 140, resetsAt: null } }).story.lede).toContain(
      "past the weekly limit",
    );
  });

  test("the residual is said once a reading exists, and quiet when it is nothing", () => {
    const win = windowOf([fact()]);
    expect(page(win, "usd_modeled", { residualPoints: 0 }).story.lede).toContain("nothing is unaccounted for");
    expect(page(win, "usd_modeled", { residualPoints: 12 }).story.lede).toContain("not yet accounted for");
    expect(page(win).story.lede).not.toContain("accounted for");
  });

  test("a store that has never recorded says so instead of a cheerful sentence", () => {
    const p = page(windowOf([], { first: null, recorded: 0, cards: 0 }));
    expect(p.story.empty).toBe(true);
    expect(p.story.sections).toEqual([]);
    expect(p.story.lede.startsWith("nothing has been recorded yet.")).toBe(true);
    expect(p.story.lede).not.toContain("$");
  });

  test("a quiet week on a working wall is a different nothing", () => {
    const p = page(windowOf([], { first: T0 - 30 * DAY, recorded: 184_920 }));
    expect(p.story.empty).toBe(true);
    expect(p.story.lede).toContain("nothing was recorded in the last 7 days");
    expect(p.story.lede).toContain("185k requests are on record");
    expect(p.story.sections).toEqual([]);
  });

  test("rows with no price are said to be unpriced rather than drawn as zero", () => {
    const rows = [fact({ account: "@deepseek", provider: "deepseek", model: "deepseek-flash" })];
    const p = page(windowOf(rows));
    expect(p.figure.total).toBeNull();
    expect(p.story.lede).toContain("not one of them has a price");
    expect(p.story.lede).toContain("waiting on a rate");
  });

  test("a token view speaks tokens and never dollars", () => {
    const p = page(windowOf([fact()]), "tokens");
    expect(p.story.lede).toContain("moved");
    expect(p.story.lede).toContain("tokens");
    expect(p.story.lede).not.toContain("$");
  });

  /* The copy rules `showcase.md` states for the tour, applied to the page: no
     em dash and no en dash anywhere a person reads. */
  test("no em or en dashes reach the page", () => {
    const worlds = [
      page(windowOf([fact()])),
      page(windowOf([fact()]), "tokens"),
      page(windowOf([], { first: null })),
      page(windowOf([], {})),
      page(windowOf([fact({ account: "@deepseek", provider: "deepseek", model: "deepseek-flash" })])),
    ];
    for (const p of worlds) {
      const text = [p.story.lede, ...p.story.sections.map((s) => s.body), ...p.story.facts.flatMap((f) => [f.label, f.note])].join(" ");
      expect(text).not.toContain("—");
      expect(text).not.toContain("–");
    }
  });
});

/* ── the presentation, remembered per mode ─────────────────────────────────*/

describe("which presentation is in front", () => {
  test("the native one is the default, per mode", () => {
    expect(naturalFor("wall")).toBe("room");
    expect(naturalFor("chat")).toBe("page");
    expect(presentationFor("wall", null)).toBe("room");
    expect(presentationFor("chat", null)).toBe("page");
    expect(PRESENTATION_STORE.wall).not.toBe(PRESENTATION_STORE.chat);
  });

  test("a stored choice wins over the default, and nonsense falls back", () => {
    expect(presentationFor("wall", "page")).toBe("page");
    expect(presentationFor("chat", "room")).toBe("room");
    expect(presentationFor("wall", "sideways")).toBe("room");
    expect(presentationFor("chat", "")).toBe("page");
  });

  test("the swap is its own inverse", () => {
    expect(otherPresentation("room")).toBe("page");
    expect(otherPresentation("page")).toBe("room");
  });
});

/* ── a spec and a surface ──────────────────────────────────────────────────*/

describe("the spec a view is saved as", () => {
  const surface: SurfaceInput = {
    span: "30d",
    measure: "tokens",
    split: "project",
    filter: { host: ["here"] },
  };

  test("the surface becomes a §9.2 spec with no presentation in it", () => {
    const spec = viewOfSurface(surface, "  a month of tokens  ");
    expect(spec).toMatchObject({ v: 1, name: "a month of tokens", span: "30d", bucket: "auto", filter: { host: ["here"] } });
    expect(spec.panels[0]).toMatchObject({ form: "area", measure: "tokens", split: "project" });
    expect(Object.keys(spec)).not.toContain("presentation");
  });

  test("a spec comes back as the four controls", () => {
    const spec = viewOfSurface(surface, "x");
    expect(surfaceOfView(spec)).toEqual(surface);
  });

  test("a measure or a split this surface cannot draw degrades to one it can", () => {
    const odd = viewOfSurface(surface, "odd");
    odd.panels[0] = { ...odd.panels[0], measure: "cost_per_merged_pr", split: "skill" };
    const back = surfaceOfView(odd);
    expect(back.measure).toBe("usd_modeled");
    expect(back.split).toBeNull();
    expect(back.span).toBe("30d");
  });
});

describe("the library as it comes off the store", () => {
  const good = {
    id: "a",
    name: "the week",
    configJson: JSON.stringify({ v: 1, span: "7d", panels: [{ measure: "tokens", split: "model" }] }),
    createdAt: 100,
    updatedAt: 300,
  };

  test("a row becomes a saved view, named by the row rather than the config", () => {
    const [v] = asSavedViews([good]);
    expect(v.id).toBe("a");
    expect(v.name).toBe("the week");
    expect(v.view.span).toBe("7d");
    expect(v.view.panels[0].measure).toBe("tokens");
    expect(v.view.name).toBe("the week");
  });

  test("a row with no id is dropped, and a config that will not parse becomes the default", () => {
    const rows = asSavedViews([
      { ...good, id: "" },
      { ...good, id: "b", name: "broken", configJson: "{not json" },
    ]);
    expect(rows.map((v) => v.id)).toEqual(["b"]);
    expect(rows[0].view.span).toBe("7d");
    expect(rows[0].view.panels.length).toBe(1);
    expect(rows[0].name).toBe("broken");
  });

  test("what is not a list is an empty library, not a throw", () => {
    expect(asSavedViews(null)).toEqual([]);
    expect(asSavedViews({})).toEqual([]);
    expect(asSavedViews([null, 3, "x"])).toEqual([]);
  });

  test("newest change first, and a tie falls back to the name", () => {
    const rows = asSavedViews([
      { ...good, id: "old", name: "old", updatedAt: 100 },
      { ...good, id: "new", name: "new", updatedAt: 900 },
      { ...good, id: "tie", name: "aaa", updatedAt: 900 },
    ]);
    expect(rows.map((v) => v.id)).toEqual(["tie", "new", "old"]);
  });

  test("a missing clock reads as nothing rather than NaN", () => {
    const [v] = asSavedViews([{ id: "z", name: "z", configJson: "{}" }]);
    expect(v.createdAt).toBe(0);
    expect(v.updatedAt).toBe(0);
    expect(Number.isNaN(v.updatedAt)).toBe(false);
  });
});

describe("what a surface cannot honour about a spec", () => {
  const T = Date.UTC(2026, 10, 12, 14, 0, 0);
  const spec = (over: Record<string, unknown> = {}) =>
    normalizeView({ span: "7d", panels: [{ measure: "usd_modeled", split: null }], ...over });

  test("a spec this surface can answer owes no sentence", () => {
    expect(refusalOf(spec(), T)).toBe(null);
    expect(panelNote(spec())).toBe(null);
  });

  test("a fine-only split over a year is refused with the tier named", () => {
    /* §9.1: the refusal has to name the tier that answered and could not,
       because a silent degrade is a chart of a different question. */
    const said = refusalOf(spec({ span: "1y", panels: [{ measure: "usd_modeled", split: "session" }] }), T);
    expect(said).toContain("session");
    expect(said).toContain("hourly");
  });

  test("a fine-only filter dimension is refused the same way", () => {
    const said = refusalOf(spec({ span: "1y", filter: { session: ["s1"] } }), T);
    expect(said).toContain("session");
    expect(said).toContain("hourly");
  });

  test("a bucket finer than the grain behind it is refused", () => {
    const said = refusalOf(spec({ span: "1y", bucket: "1m" }), T);
    expect(said).toContain("1m");
  });

  test("more panels than are drawn is said, and is not a refusal", () => {
    const two = spec({ panels: [{ measure: "usd_modeled" }, { measure: "tokens" }] });
    expect(refusalOf(two, T)).toBe(null);
    expect(panelNote(two)).toBe("this view asks for 2 panels; one is drawn here");
  });
});

/* ── a report's cover ──────────────────────────────────────────────────────*/

describe("a report's cover describes what the report includes", () => {
  test("its hosts and accounts are the filtered rows', not the whole window's", () => {
    const win = fixtureWindow(windowRequest("7d", T0 + 7 * DAY), "normal");
    const all = coverOf(win);
    expect(all.accounts.length).toBeGreaterThan(1);
    const one = coverOf(win, { account: [all.accounts[0]] });
    expect(one.accounts).toEqual([all.accounts[0]]);
    expect(one.hosts.length).toBeGreaterThan(0);
    expect(one.hosts.every((h) => all.hosts.includes(h))).toBe(true);
    expect(one.claude).not.toBeNull();
  });
});
