import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  BUCKETS,
  SERIES_CEILING,
  SERIES_FOLD,
  bucketOf,
  seriesColor,
  type Fact,
  type HourFact,
  type UsageRow,
} from "../src/lib/analytics";
import {
  DEFAULT_SPAN,
  FINE_WINDOW_MS,
  SPANS,
  asWindow,
  bucketLabel,
  emptinessOf,
  kpisOf,
  measureText,
  nearestAt,
  niceAxis,
  readingsOf,
  roomBucket,
  runsOf,
  runsOfTimes,
  shareText,
  sparkPoints,
  splitSeries,
  spreadLabels,
  stepAt,
  tickLabel,
  tickText,
  tierSaid,
  timesOf,
  windowRequest,
  windowTier,
} from "../src/lib/analyticsroom";
import { fixtureWindow } from "../src/lib/analyticsfixture";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A five-minute fact. The defaults are a normal priced request on one card. */
function fact(over: Partial<Fact> = {}): Fact {
  return {
    at: 0,
    host: "here",
    session: "s1",
    agent: "",
    parentAgent: "",
    depth: 0,
    model: "claude-opus-5-5",
    effort: "high",
    cli: "2.1",
    source: "card",
    account: "lyss",
    accountIdentity: "",
    provider: "anthropic",
    project: "volery",
    provenance: "transcript",
    inTok: 1000,
    outTok: 500,
    cacheRead: 4000,
    write5m: 0,
    write1h: 0,
    requests: 1,
    usdReported: 0,
    ...over,
  };
}

function hourFact(over: Partial<HourFact> = {}): HourFact {
  return {
    hour: 0,
    host: "here",
    account: "lyss",
    provider: "anthropic",
    model: "claude-opus-5-5",
    effort: "high",
    cli: "2.1",
    source: "card",
    project: "volery",
    provenance: "transcript",
    inTok: 1000,
    outTok: 500,
    cacheRead: 0,
    write5m: 0,
    write1h: 0,
    requests: 1,
    usdReported: 0,
    ...over,
  };
}

describe("which tier answers", () => {
  test("five-minute facts up to two days, the hourly rollup past it", () => {
    expect(windowTier(HOUR)).toBe("fine");
    expect(windowTier(24 * HOUR)).toBe("fine");
    expect(windowTier(FINE_WINDOW_MS)).toBe("fine");
    expect(windowTier(FINE_WINDOW_MS + 1)).toBe("hourly");
    expect(windowTier(365 * DAY)).toBe("hourly");
  });

  test("a span becomes two instants and one tier", () => {
    const now = 1_700_000_000_000;
    expect(windowRequest("7d", now)).toEqual({ since: now - 7 * DAY, until: now, fine: false });
    expect(windowRequest("24h", now)).toEqual({ since: now - DAY, until: now, fine: true });
  });

  test("a span that is not a span falls back to the week rather than to nothing", () => {
    const now = 1_700_000_000_000;
    expect(windowRequest("banana", now)).toEqual({ since: now - 7 * DAY, until: now, fine: false });
    expect(DEFAULT_SPAN).toBe("7d");
  });

  test("every span the room offers is one the tier can answer", () => {
    for (const s of SPANS) {
      const req = windowRequest(s.span, 1_700_000_000_000);
      expect(req.until).toBeGreaterThan(req.since);
      /* A fine request is never wider than the fine tier's window. */
      if (req.fine) expect(req.until - req.since).toBeLessThanOrEqual(FINE_WINDOW_MS);
    }
  });
});

describe("the rung the chart draws", () => {
  test("clamped to the grain the answering tier recorded", () => {
    expect(roomBucket(24 * HOUR, "fine")).toBe("15m");
    expect(roomBucket(HOUR, "fine")).toBe("5m");
    expect(roomBucket(7 * DAY, "hourly")).toBe("1h");
    expect(roomBucket(30 * DAY, "hourly")).toBe("1d");
    expect(roomBucket(365 * DAY, "hourly")).toBe("1w");
  });

  test("a fine decision and an hourly one agree about the coarse end", () => {
    /* Above the fine window the two cannot disagree, because `auto` has already
       gone coarser than the hourly grain. */
    for (const span of [3 * DAY, 30 * DAY, 365 * DAY]) {
      expect(roomBucket(span, "fine")).toBe(roomBucket(span, "hourly"));
    }
  });
});

describe("a window off the wire", () => {
  test("junk becomes an empty hourly window rather than a throw", () => {
    for (const junk of [null, 42, "x", [], { rows: "nope" }]) {
      const w = asWindow(junk);
      expect(w.tier).toBe("hourly");
      expect(w.rows).toEqual([]);
      expect(w.first).toBeNull();
      expect(w.recorded).toBe(0);
      expect(Number.isFinite(w.since)).toBe(true);
    }
  });

  test("a row with no clock is dropped, not folded as a zero", () => {
    const w = asWindow({
      tier: "fine",
      since: 0,
      until: 1,
      rows: [fact({ at: 10 }), { at: "nope" }, null, { hour: Number.NaN }],
      cards: 2,
      first: 5,
      recorded: 9,
    });
    expect(w.tier).toBe("fine");
    expect(w.rows.length).toBe(1);
    expect(w.cards).toBe(2);
  });

  test("an unknown tier degrades to the one that cannot overstate resolution", () => {
    expect(asWindow({ tier: "daily", rows: [] }).tier).toBe("hourly");
  });

  test("a NaN in a token count does not survive the boundary", () => {
    const w = asWindow({ tier: "hourly", since: 0, until: 1, rows: [{ hour: 0, inTok: Number.NaN, requests: 3 }] });
    const row = w.rows[0] as HourFact;
    expect(row.inTok).toBe(0);
    expect(row.requests).toBe(3);
    expect(Number.isFinite(row.cacheRead)).toBe(true);
  });
});

describe("a window into series", () => {
  const rows = [
    fact({ at: 0, project: "volery", inTok: 3000, outTok: 0, cacheRead: 0 }),
    fact({ at: 0, project: "nova", inTok: 1000, outTok: 0, cacheRead: 0 }),
    fact({ at: 300_000, project: "volery", inTok: 2000, outTok: 0, cacheRead: 0 }),
  ];

  test("one series with no split, in the first slot", () => {
    const list = splitSeries(rows, "tokens", "5m", null);
    expect(list.length).toBe(1);
    expect(list[0].slot).toBe(0);
    expect(list[0].color).toBe(seriesColor(0));
    expect(list[0].points).toEqual([
      { at: 0, value: 4000 },
      { at: 300_000, value: 2000 },
    ]);
    expect(list[0].total).toBe(6000);
  });

  test("split by a dimension, biggest first, and each keeps its slot by identity", () => {
    const list = splitSeries(rows, "tokens", "5m", "project");
    expect(list.map((s) => s.label)).toEqual(["volery", "nova"]);
    expect(list[0].slot).toBe(0);
    expect(list[1].slot).toBe(1);
    expect(list[0].color).toBe(seriesColor(0));
    expect(list[1].color).toBe(seriesColor(1));
    expect(list[0].total).toBe(5000);
    expect(list[1].total).toBe(1000);
  });

  test("an empty dimension value is named rather than drawn as a blank", () => {
    const list = splitSeries([fact({ at: 0, project: "" })], "tokens", "5m", "project");
    expect(list[0].label).toBe("unnamed");
  });

  test("past the palette the tail folds into one series in a text token", () => {
    /* Five hues is the ceiling, and the fold is not a sixth: it is a text
       token, so the chart may carry five identities plus `other` and no two
       marks are asked to be told apart by a colour (§10.1). */
    const many: UsageRow[] = [];
    for (let i = 0; i < SERIES_CEILING + 3; i += 1) {
      many.push(fact({ at: 0, project: `p${i}`, inTok: (i + 1) * 1000, outTok: 0, cacheRead: 0 }));
    }
    const list = splitSeries(many, "tokens", "5m", "project");
    expect(list.length).toBe(SERIES_CEILING + 1);
    expect(list[list.length - 1].key).toBe("other");
    expect(list[list.length - 1].slot).toBeNull();
    expect(list[list.length - 1].color).toBe(SERIES_FOLD);
    /* Every hue is used, and nothing is lost from the total. */
    expect(list.slice(0, -1).map((s) => s.slot)).toEqual([0, 1, 2, 3, 4]);
    expect(list.slice(0, -1).map((s) => s.label)).toEqual(["p7", "p6", "p5", "p4", "p3"]);
    const total = list.reduce((a, s) => a + s.total, 0);
    expect(total).toBe(many.reduce((a, r) => a + r.inTok, 0));
  });

  test("a survivor keeps its slot when the window changes, whatever the ranks", () => {
    /* §10.1: a filter that changes the series count does not repaint the
       survivors. Two spans, one book: the same project is the same colour, and
       the one that overtakes keeps its own slot rather than inheriting. */
    const book = new Map<string, number>();
    const monday = [
      fact({ at: 0, project: "nova", inTok: 900, outTok: 0, cacheRead: 0 }),
      fact({ at: 0, project: "volery", inTok: 100, outTok: 0, cacheRead: 0 }),
    ];
    const tuesday = [
      fact({ at: 0, project: "nova", inTok: 100, outTok: 0, cacheRead: 0 }),
      fact({ at: 0, project: "volery", inTok: 900, outTok: 0, cacheRead: 0 }),
    ];
    const first = splitSeries(monday, "tokens", "5m", "project", book);
    const second = splitSeries(tuesday, "tokens", "5m", "project", book);
    const slotOf = (l: typeof first, label: string) => l.find((s) => s.label === label)?.slot;
    expect(slotOf(first, "nova")).toBe(0);
    expect(slotOf(first, "volery")).toBe(1);
    /* volery is now the biggest, and it is still slot 1. */
    expect(second[0].label).toBe("volery");
    expect(slotOf(second, "nova")).toBe(0);
    expect(slotOf(second, "volery")).toBe(1);
  });

  test("a new identity takes the lowest slot still free, and the sixth folds", () => {
    const book = new Map<string, number>();
    const rows = (labels: string[]) =>
      labels.map((p, i) => fact({ at: 0, project: p, inTok: (i + 1) * 100, outTok: 0, cacheRead: 0 }));
    /* The first reading hands hues out in its own size order: biggest, first
       slot. That is the only reading rank is allowed to decide. */
    splitSeries(rows(["a", "b", "c"]), "tokens", "5m", "project", book);
    expect([...book.entries()]).toEqual([
      ["c", 0],
      ["b", 1],
      ["a", 2],
    ]);
    /* `d` arrives alone: it takes 3, the lowest free. */
    expect(splitSeries(rows(["d"]), "tokens", "5m", "project", book)[0].slot).toBe(3);
    /* One more fills the palette, and everything after it folds. */
    expect(splitSeries(rows(["e"]), "tokens", "5m", "project", book)[0].slot).toBe(4);
    const last = splitSeries(rows(["f", "g"]), "tokens", "5m", "project", book);
    expect(last.map((s) => s.key)).toEqual(["other"]);
    expect(last[0].slot).toBeNull();
    expect(last[0].unpriced).toBe(0);
  });

  test("a group the measure cannot price has no points and says how many rows", () => {
    /* A sentinel account is unpriced under `usd_modeled` by design (§3.5): the
       series is empty, and the count is what stops the legend printing $0. */
    const list = splitSeries(
      [fact({ at: 0, project: "nova", account: "@deepseek", model: "deepseek-flash" })],
      "usd_modeled",
      "5m",
      "project",
    );
    expect(list[0].points).toEqual([]);
    expect(list[0].unpriced).toBe(1);
  });
});

describe("gaps", () => {
  test("adjacent buckets are one run; a hole breaks it", () => {
    const points = [
      { at: 0, value: 1 },
      { at: 300_000, value: 2 },
      { at: 600_000, value: 3 },
      { at: 1_800_000, value: 4 },
    ];
    const runs = runsOf(points, "5m");
    expect(runs.length).toBe(2);
    expect(runs[0].length).toBe(3);
    expect(runs[1].length).toBe(1);
  });

  test("the same rule over instants, which is what the chart holds", () => {
    /* `runsOfTimes` is the one the room calls: the axis is the union of every
       series' buckets, not one series' points. A rule written twice is a rule
       fixed once, so the two are the same function. */
    expect(runsOfTimes([0, 300_000, 600_000, 1_800_000], "5m")).toEqual([[0, 300_000, 600_000], [1_800_000]]);
    expect(runsOfTimes([], "5m")).toEqual([]);
    expect(runsOfTimes([0], "5m")).toEqual([[0]]);
  });

  test("a day rung across a DST change is still one run", () => {
    /* The nominal width is a day; the step is 23 or 25 hours. The half-bucket
       of slack is what keeps a local day from reading as a gap. */
    const points = [
      { at: 0, value: 1 },
      { at: 25 * HOUR, value: 2 },
    ];
    expect(runsOf(points, "1d").length).toBe(1);
  });

  test("no points is no runs, never one empty one", () => {
    expect(runsOf([], "1h")).toEqual([]);
  });
});

describe("reading a bucket", () => {
  const rows = [
    fact({ at: 0, project: "volery", inTok: 3000, outTok: 0, cacheRead: 0 }),
    fact({ at: 0, project: "nova", inTok: 1000, outTok: 0, cacheRead: 0 }),
    fact({ at: 300_000, project: "volery", inTok: 2000, outTok: 0, cacheRead: 0 }),
  ];
  const list = splitSeries(rows, "tokens", "5m", "project");

  test("the axis is every instant any series saw, in order", () => {
    expect(timesOf(list)).toEqual([0, 300_000]);
  });

  test("a bucket's parts keep the series order, and the total adds them", () => {
    const readings = readingsOf(list);
    const first = readings.get(0)!;
    expect(first.total).toBe(4000);
    expect(first.parts.map((p) => p.label)).toEqual(["volery", "nova"]);
    expect(readings.get(300_000)!.parts.length).toBe(1);
  });

  test("the nearest bucket to a pointer, and null on an empty axis", () => {
    expect(nearestAt([0, 300_000, 600_000], 290_000)).toBe(300_000);
    expect(nearestAt([0, 300_000], 900_000)).toBe(300_000);
    expect(nearestAt([], 1)).toBeNull();
  });

  test("stepping clamps at the ends rather than wrapping", () => {
    const times = [0, 300_000, 600_000];
    expect(stepAt(times, null, 1)).toBe(0);
    expect(stepAt(times, null, -1)).toBe(600_000);
    expect(stepAt(times, 0, -1)).toBe(0);
    expect(stepAt(times, 600_000, 1)).toBe(600_000);
    expect(stepAt(times, 300_000, 1)).toBe(600_000);
    expect(stepAt([], 0, 1)).toBeNull();
    /* A selection whose bucket went away lands on the nearest survivor. */
    expect(stepAt(times, 400_000, 0)).toBe(300_000);
  });
});

describe("the axis", () => {
  test("rounds up to numbers a person reads", () => {
    expect(niceAxis(1)).toEqual({ top: 1, ticks: [0, 0.25, 0.5, 0.75, 1] });
    const axis = niceAxis(412);
    expect(axis.top).toBe(800);
    expect(axis.ticks).toEqual([0, 200, 400, 600, 800]);
    expect(axis.ticks[axis.ticks.length - 1]).toBe(axis.top);
  });

  test("no data is no axis, never a division by zero", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(niceAxis(bad)).toEqual({ top: 0, ticks: [] });
    }
  });

  test("every tick is a finite number", () => {
    for (const max of [0.0003, 7, 1949, 250_000, 4.2e9]) {
      for (const t of niceAxis(max).ticks) expect(Number.isFinite(t)).toBe(true);
    }
  });
});

describe("saying it", () => {
  test("money through the query layer, tokens with their unit", () => {
    expect(measureText("usd_modeled", 4.25)).toBe("$4.25");
    expect(measureText("usd_modeled", 12.5)).toBe("$13");
    expect(measureText("tokens", 1_400_000)).toBe("1.4M tokens");
  });

  test("a value that does not exist is blank, never a zero", () => {
    expect(measureText("usd_modeled", null)).toBe("");
    expect(measureText("tokens", Number.NaN)).toBe("");
  });

  test("an axis tick drops the unit the axis title carries", () => {
    expect(tickText("usd_modeled", 200)).toBe("$200");
    expect(tickText("tokens", 1_400_000)).toBe("1.4M");
  });

  test("a share with no denominator is blank", () => {
    expect(shareText(null)).toBe("");
    expect(shareText(42.7)).toBe("42%");
    expect(shareText(0)).toBe("0%");
  });

  test("a bucket is named by its rung", () => {
    const t = new Date(2026, 10, 4, 13, 5).getTime();
    expect(bucketLabel(t, "5m")).toBe("wed 4 nov 13:05");
    expect(bucketLabel(t, "1d")).toBe("wed 4 nov");
    expect(bucketLabel(t, "1w")).toStartWith("week of ");
    expect(tickLabel(t, "5m")).toBe("wed 13:05");
    expect(tickLabel(t, "1d")).toBe("4 nov");
    /* Every rung has a label, so no bucket can be drawn nameless. */
    for (const bucket of BUCKETS) expect(bucketLabel(bucketOf(t, bucket), bucket).length).toBeGreaterThan(3);
  });

  test("the tier says which rows answered", () => {
    expect(tierSaid("fine")).toBe("five-minute facts");
    expect(tierSaid("hourly")).toBe("hourly rollups");
  });
});

describe("the strip", () => {
  test("nothing recorded is no numbers at all, not zeros", () => {
    const k = kpisOf([], 0);
    expect(k.spend).toBeNull();
    expect(k.tokens).toBeNull();
    expect(k.requests).toBe(0);
    expect(k.cacheShare).toBeNull();
    expect(k.leading).toBeNull();
  });

  test("spend, tokens, requests and the cache share come off the rows", () => {
    const rows = [
      fact({ at: 0, inTok: 1000, outTok: 500, cacheRead: 3500, requests: 2 }),
      fact({ at: 300_000, inTok: 1000, outTok: 500, cacheRead: 0, requests: 1 }),
    ];
    const k = kpisOf(rows, 3);
    expect(k.spend).toBeGreaterThan(0);
    expect(k.tokens).toBe(6500);
    expect(k.requests).toBe(3);
    expect(k.cacheShare).toBeCloseTo((3500 / 6500) * 100, 6);
    expect(k.cards).toBe(3);
  });

  test("a row the price table cannot answer is counted, not folded as free", () => {
    const rows = [fact({ at: 0, account: "@deepseek", model: "deepseek-flash" })];
    const k = kpisOf(rows, 1);
    expect(k.spend).toBeNull();
    expect(k.unpriced).toBe(1);
    expect(k.tokens).toBe(5500);
  });

  test("the leading project is the one that saw the most tokens", () => {
    const rows = [
      fact({ at: 0, project: "nova", inTok: 100, outTok: 0, cacheRead: 0 }),
      fact({ at: 0, project: "volery", inTok: 900, outTok: 0, cacheRead: 0 }),
    ];
    const k = kpisOf(rows, 2);
    expect(k.leading?.project).toBe("volery");
    expect(k.leading?.share).toBe(90);
  });

  test("a share never divides by zero, and says so rather than printing a nought", () => {
    const k = kpisOf([fact({ at: 0, inTok: 0, outTok: 0, cacheRead: 0, write5m: 0, write1h: 0 })], 1);
    expect(k.cacheShare).toBeNull();
    /* A project can lead a window of no tokens; its share of them is null, not
       0% (§9.1), and the tile prints nothing. */
    expect(k.leading?.project).toBe("volery");
    expect(k.leading?.share).toBeNull();
    expect(shareText(k.leading?.share ?? null)).toBe("");
  });
});

describe("the empty state", () => {
  const base = { tier: "fine" as const, since: 0, until: 1, cards: 0, recorded: 0 };

  test("a store that has never recorded is waiting on the collector", () => {
    const said = emptinessOf({ ...base, rows: [], first: null })!;
    expect(said.title).toBe("recording starts within a minute");
  });

  test("a quiet window on a working wall says since when, and how much", () => {
    const first = new Date(2026, 10, 4, 13, 5).getTime();
    const said = emptinessOf({ ...base, rows: [], first, recorded: 12_400 })!;
    expect(said.title).toBe("nothing recorded in this window");
    expect(said.note).toContain("recording since wed 4 nov");
    expect(said.note).toContain("12k requests");
  });

  test("rows are not empty, however few", () => {
    expect(emptinessOf({ ...base, rows: [fact({ at: 0 })], first: 0, recorded: 1 })).toBeNull();
  });
});

describe("direct labels", () => {
  test("two labels wanting the same line are pushed apart", () => {
    const out = spreadLabels([{ y: 100 }, { y: 101 }, { y: 102 }], 13, 0, 500);
    expect(out.map((e) => e.y)).toEqual([100, 113, 126]);
  });

  test("the set is lifted rather than run off the bottom", () => {
    const out = spreadLabels([{ y: 490 }, { y: 495 }], 13, 0, 500);
    expect(out[out.length - 1].y).toBe(500);
    expect(out[0].y).toBeLessThanOrEqual(out[1].y);
  });

  test("nothing is pushed above the top", () => {
    const out = spreadLabels([{ y: -50 }, { y: -40 }], 13, 14, 500);
    expect(Math.min(...out.map((e) => e.y))).toBe(14);
  });

  test("no labels is no layout, never a throw", () => {
    expect(spreadLabels([], 13, 0, 1)).toEqual([]);
  });
});

describe("the fixture", () => {
  const now = new Date(2026, 10, 4, 18, 0).getTime();

  test("a fine request draws five-minute facts, an hourly one hourly rows", () => {
    const fine = fixtureWindow(windowRequest("24h", now));
    const wide = fixtureWindow(windowRequest("7d", now));
    expect(fine.tier).toBe("fine");
    expect(wide.tier).toBe("hourly");
    expect(fine.rows.length).toBeGreaterThan(0);
    expect(wide.rows.length).toBeGreaterThan(0);
    for (const row of fine.rows) expect("at" in row).toBe(true);
    for (const row of wide.rows) expect("hour" in row).toBe(true);
  });

  test("it is deterministic, so two screenshots differ only by the clock", () => {
    const a = fixtureWindow(windowRequest("7d", now));
    const b = fixtureWindow(windowRequest("7d", now));
    expect(a.rows.length).toBe(b.rows.length);
    expect(a.rows[0]).toEqual(b.rows[0]);
  });

  test("it has a hole in it, which is the whole reason to draw one", () => {
    const w = fixtureWindow(windowRequest("7d", now));
    const bucket = roomBucket(7 * DAY, w.tier);
    const list = splitSeries(w.rows, "usd_modeled", bucket, "project");
    const times = timesOf(list);
    const broken = times.some((t, i) => i > 0 && t - times[i - 1] > 1.5 * 3_600_000);
    expect(broken).toBe(true);
    /* And the mapping produces real series: a couple of projects, positive. */
    expect(list.length).toBeGreaterThan(1);
    expect(list[0].total).toBeGreaterThan(0);
  });

  test("the two empty modes are the two nothings", () => {
    const never = fixtureWindow(windowRequest("24h", now), "empty");
    expect(emptinessOf(never)?.title).toBe("recording starts within a minute");
    const quiet = fixtureWindow(windowRequest("24h", now), "quiet");
    expect(emptinessOf(quiet)?.title).toBe("nothing recorded in this window");
    expect(quiet.recorded).toBeGreaterThan(0);
  });
});

describe("the fixture cannot reach an installer", () => {
  const root = join(import.meta.dir, "..");

  function files(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...files(p));
      else if (/\.(ts|js|svelte|html)$/.test(e.name)) out.push(p);
    }
    return out;
  }

  test("nothing in src imports the fixture except the preview entry", () => {
    const importers = files(join(root, "src")).filter((f) => readFileSync(f, "utf8").includes("analyticsfixture"));
    expect(importers.map((f) => f.replace(/\\/g, "/").split("/src/")[1])).toEqual(["analytics-preview.ts"]);
  });

  test("index.html does not offer it, and vite names no second input", () => {
    expect(readFileSync(join(root, "index.html"), "utf8")).not.toContain("analytics-preview");
    const vite = readFileSync(join(root, "vite.config.ts"), "utf8");
    expect(vite).not.toContain("analytics.html");
    expect(vite).not.toContain("rollupOptions");
  });

  test("the preview page exists and mounts the room", () => {
    const html = readFileSync(join(root, "analytics.html"), "utf8");
    expect(html).toContain("/src/analytics-preview.ts");
  });
});

describe("a tile's sparkline", () => {
  test("a flat series draws a line across the middle, not at the floor", () => {
    expect(sparkPoints([4, 4, 4])).toBe("1.5,11 50,11 98.5,11");
  });

  test("one point is a horizontal line, because there is no shape to draw", () => {
    expect(sparkPoints([9])).toBe("1.5,11 98.5,11");
    expect(sparkPoints([])).toBe("");
  });

  test("a value that is not a number is dropped rather than emitted as NaN", () => {
    const line = sparkPoints([1, Number.NaN, 3, Number.POSITIVE_INFINITY]);
    expect(line).not.toContain("NaN");
    expect(line.split(" ").length).toBe(2);
  });

  test("the series' own maximum is the top of the box, so the shape is the reading", () => {
    expect(sparkPoints([0, 10])).toBe("1.5,20.5 98.5,1.5");
  });
});
