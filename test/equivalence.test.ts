import { describe, expect, test } from "bun:test";
import {
  CONFOUNDED_ABOVE,
  binsOf,
  readingOf,
  MIN_HOURS,
  bandSaid,
  bootBand,
  confoundingOf,
  hourOf,
  isRated,
  mixSaid,
  weekGrid,
  weekdayOf,
  windowSaid,
  worthOf,
  worthSaid,
  verdictOf,
  verdictSaid,
  type RateBin,
} from "../src/lib/equivalence";
import type { AllowanceSample } from "../src/lib/allowancesamples";
import type { HourFact } from "../src/lib/analytics";

const H = 60 * 60 * 1000;
/** 2026-11-02 is a Monday. Built from **local** calendar parts, because the
 *  reading groups by the reader's own clock: a UTC-anchored helper would make
 *  every hour assertion below depend on the machine's timezone, which is the
 *  bug the local getters exist to avoid. */
function at(day: number, hour: number): number {
  return new Date(2026, 10, 2 + day, hour).getTime();
}

function bin(over: Partial<RateBin> & { at: number }): RateBin {
  return {
    account: "lyss",
    kind: "session",
    scope: "",
    points: 4,
    usd: 0.04,
    tokens: 40_000,
    mix: { "claude-sonnet-5-5": 1 },
    ...over,
  };
}

/** A deterministic stream, so a "no real effect" test is the same data on every
 *  run and a failure is reproducible. */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("what a point is worth", () => {
  test("the rate is a ratio of sums, and a whole window is a hundred of it", () => {
    const w = worthOf(
      [
        bin({ at: at(0, 9), points: 4, usd: 0.04, tokens: 40_000 }),
        bin({ at: at(0, 10), points: 6, usd: 0.09, tokens: 90_000 }),
      ],
      "lyss",
      "session",
      at(0, 0),
      at(1, 0),
    );
    expect(w.points).toBe(10);
    expect(w.hours).toBe(2);
    expect(w.usdPerPoint).toBeCloseTo(0.013);
    expect(w.tokensPerPoint).toBe(13_000);
    expect(w.wholeUsd).toBeCloseTo(1.3);
    expect(w.wholeTokens).toBe(1_300_000);
  });

  test("another account's and another window's hours are not this one's", () => {
    const w = worthOf(
      [
        bin({ at: at(0, 9) }),
        bin({ at: at(0, 10), account: "alizee" }),
        bin({ at: at(0, 11), kind: "weekly_all" }),
      ],
      "lyss",
      "session",
      at(0, 0),
      at(1, 0),
    );
    expect(w.hours).toBe(1);
  });

  test("a rate is absent, never zero, when nothing moved or nothing was priced", () => {
    const still = worthOf([bin({ at: at(0, 9), points: 0 })], "lyss", "session", at(0, 0), at(1, 0));
    expect(still.usdPerPoint).toBeNull();
    expect(still.tokensPerPoint).toBeNull();
    expect(still.wholeUsd).toBeNull();
    const unpriced = worthOf([bin({ at: at(0, 9), usd: 0 })], "lyss", "session", at(0, 0), at(1, 0));
    expect(unpriced.usdPerPoint).toBeNull();
  });

  test("an hour below the movement floor is not a measurement", () => {
    expect(isRated(bin({ at: at(0, 9), points: 0.2 }))).toBe(false);
    expect(isRated(bin({ at: at(0, 9), points: 1 }))).toBe(true);
    expect(isRated(bin({ at: at(0, 9), usd: 0 }))).toBe(false);
  });

  test("malformed bins are dropped rather than folded in", () => {
    const w = worthOf(
      [
        bin({ at: at(0, 9) }),
        bin({ at: at(0, 10), points: Number.NaN }),
        bin({ at: at(0, 11), usd: -1 }),
      ],
      "lyss",
      "session",
      at(0, 0),
      at(1, 0),
    );
    expect(w.hours).toBe(1);
    expect(w.points).toBe(4);
  });

  test("the mix is what was measured at, largest first", () => {
    const w = worthOf(
      [bin({ at: at(0, 9), usd: 10, mix: { opus: 0.75, sonnet: 0.25 } })],
      "lyss",
      "session",
      at(0, 0),
      at(1, 0),
    );
    expect(w.mix).toEqual([
      { model: "opus", share: 0.75 },
      { model: "sonnet", share: 0.25 },
    ]);
  });

  test("the interval is seeded, so it does not flicker, and it brackets the rate", () => {
    const bins = Array.from({ length: 20 }, (_, i) =>
      bin({ at: at(0, i), points: 2 + (i % 5), usd: (2 + (i % 5)) * (0.01 + (i % 3) * 0.001) }),
    );
    const one = bootBand(bins, 7, 200);
    const two = bootBand(bins, 7, 200);
    expect(one).toEqual(two);
    expect(one).not.toBeNull();
    const rate = bins.reduce((n, b) => n + b.usd, 0) / bins.reduce((n, b) => n + b.points, 0);
    expect(one![0]).toBeLessThanOrEqual(rate);
    expect(one![1]).toBeGreaterThanOrEqual(rate);
  });

  test("one hour is not enough to resample", () => {
    expect(bootBand([bin({ at: at(0, 9) })])).toBeNull();
  });
});

describe("whether the rate holds still", () => {
  /** A working day for one account: every hour of every day, at one rate and
   *  one mix. The flat case, and the base every other case is a change to. */
  function month(usdOf: (day: number, hour: number) => number, days = 14): RateBin[] {
    const out: RateBin[] = [];
    for (let d = 0; d < days; d++) {
      for (let i = 0; i < 24; i++) {
        out.push(bin({ at: at(d, i), points: 4, usd: usdOf(d, i) }));
      }
    }
    return out;
  }

  test("a rate with too few hours is few, not unmeasured", () => {
    const handful = Array.from({ length: MIN_HOURS - 1 }, (_, i) => bin({ at: at(0, i) }));
    const w = worthOf(handful, "lyss", "session", at(0, 0), at(1, 0));
    const v = verdictOf(handful, "lyss", "session", w.usdPerPoint, at(0, 0), at(1, 0));
    /* The figures above it are real, so it says the steadiness cannot be read
       rather than that the rate is not measured. */
    expect(v.kind).toBe("few");
    expect(verdictSaid(v)).toContain("too few");
  });

  test("no rate at all is unmeasured", () => {
    const v = verdictOf([], "lyss", "session", null, at(0, 0), at(1, 0));
    expect(v.kind).toBe("unmeasured");
  });

  test("a flat rate is steady", () => {
    const bins = month(() => 0.04);
    const w = worthOf(bins, "lyss", "session", at(0, 0), at(14, 0));
    expect(verdictOf(bins, "lyss", "session", w.usdPerPoint, at(0, 0), at(14, 0)).kind).toBe("steady");
  });

  test("noise does not become a clock pattern, even on a day or two", () => {
    /* The correction that matters: 24 bins grouped by 24 hours fits perfectly
       by construction, so raw variance explained would call one afternoon a
       time-of-day effect at full confidence. */
    for (const days of [1, 2, 3, 7, 28]) {
      const next = noise(days * 7919);
      const bins = month(() => 0.04 + next() * 0.004, days);
      const w = worthOf(bins, "lyss", "session", at(0, 0), at(days, 0));
      const v = verdictOf(bins, "lyss", "session", w.usdPerPoint, at(0, 0), at(days, 0));
      expect(v.kind).toBe("steady");
    }
  });

  /** Fourteen days, alternating class by day and hour, so every hour of the day
   *  and every weekday holds both classes: the shape that lets a rate difference
   *  be attributed to what ran rather than to when it ran. */
  function alternating(usdOf: (opus: boolean, hour: number) => number): RateBin[] {
    const out: RateBin[] = [];
    for (let d = 0; d < 14; d++) {
      for (let i = 0; i < 24; i++) {
        const opus = (d + i) % 2 === 0;
        out.push(
          bin({
            at: at(d, i),
            points: 4,
            usd: usdOf(opus, i),
            mix: opus ? { "claude-opus-5-5": 1 } : { "claude-haiku-5-5": 1 },
          }),
        );
      }
    }
    return out;
  }

  test("hours that differ with what ran are reported as the mix", () => {
    const bins = alternating((opus) => (opus ? 0.2 : 0.04));
    const w = worthOf(bins, "lyss", "session", at(0, 0), at(14, 0));
    const v = verdictOf(bins, "lyss", "session", w.usdPerPoint, at(0, 0), at(14, 0));
    expect(v.kind).toBe("mix");
    if (v.kind === "mix") {
      /* $0.05 a point on the cheap hours and $0.25 on the dear ones, against an
         average of $0.15: the dearest is 400% dearer than the cheapest. */
      expect(v.low).toBeCloseTo(-2 / 3, 3);
      expect(v.high).toBeCloseTo(2 / 3, 3);
      expect(verdictSaid(v)).toContain("400%");
    }
  });

  test("the same mix at hours that differ is the clock, and says which clock", () => {
    const bins = month((_, i) => (i >= 9 && i < 17 ? 0.06 : 0.04));
    const w = worthOf(bins, "lyss", "session", at(0, 0), at(14, 0));
    const v = verdictOf(bins, "lyss", "session", w.usdPerPoint, at(0, 0), at(14, 0));
    expect(v.kind).toBe("clock");
    if (v.kind === "clock") {
      expect(v.which).toBe("hour");
      expect(verdictSaid(v)).toContain("some hours of the day");
    }
  });

  test("a weekday effect is called a weekday effect", () => {
    /* Weekends dear at every hour, weekdays flat: the two clock groupings both
       carry it, and the panel must not call this an hour of the day. */
    const bins = month((d) => (dayOfWeek(d) >= 5 ? 0.06 : 0.04));
    const w = worthOf(bins, "lyss", "session", at(0, 0), at(14, 0));
    const v = verdictOf(bins, "lyss", "session", w.usdPerPoint, at(0, 0), at(14, 0));
    expect(v.kind).toBe("clock");
    if (v.kind === "clock") {
      expect(v.which).toBe("weekday");
      expect(verdictSaid(v)).toContain("some days of the week");
    }
  });

  function dayOfWeek(offset: number): number {
    return (new Date(2026, 10, 2 + offset).getDay() + 6) % 7;
  }

  test("a class that follows the hour is confounded, and says so", () => {
    const bins: RateBin[] = [];
    for (let d = 0; d < 14; d++) {
      for (let i = 0; i < 24; i++) {
        const busy = i >= 9 && i < 17;
        bins.push(
          bin({
            at: at(d, i),
            points: 4,
            usd: busy ? 0.06 : 0.04,
            mix: busy ? { opus: 1 } : { sonnet: 1 },
          }),
        );
      }
    }
    const w = worthOf(bins, "lyss", "session", at(0, 0), at(14, 0));
    expect(verdictOf(bins, "lyss", "session", w.usdPerPoint, at(0, 0), at(14, 0)).kind).toBe(
      "confounded",
    );
  });

  test("two separable effects are reported as two", () => {
    // A balanced factorial over the same alternating shape: each class appears
    // in every hour and every weekday, and on top of that the morning is dearer
    // within each class. Neither grouping is a proxy for the other.
    const bins = alternating((opus, hour) => (opus ? 0.07 : 0.05) + (hour < 12 ? 0.01 : -0.01));
    const w = worthOf(bins, "lyss", "session", at(0, 0), at(14, 0));
    expect(verdictOf(bins, "lyss", "session", w.usdPerPoint, at(0, 0), at(14, 0)).kind).toBe("mixed");
  });

  test("confounding is measured, not assumed", () => {
    const follows: RateBin[] = [];
    for (let d = 0; d < 14; d++) {
      for (let i = 0; i < 24; i++) {
        follows.push(
          bin({ at: at(d, i), mix: i >= 9 && i < 17 ? { opus: 1 } : { sonnet: 1 } }),
        );
      }
    }
    expect(confoundingOf(follows, (b) => String(hourOf(b.at)))).toBeGreaterThanOrEqual(
      CONFOUNDED_ABOVE,
    );
    const both = alternating(() => 0.04);
    expect(confoundingOf(both, (b) => String(hourOf(b.at)))).toBeLessThan(CONFOUNDED_ABOVE);
  });
});

describe("the week", () => {
  test("the weekday is Monday first, in the reading's own clock", () => {
    expect(weekdayOf(at(0, 9))).toBe(0);
    expect(weekdayOf(at(4, 9))).toBe(4);
    expect(weekdayOf(at(6, 9))).toBe(6);
    expect(hourOf(at(0, 9))).toBe(9);
  });

  test("every hour of the week is a cell, and one with no reading is blank", () => {
    const grid = weekGrid([bin({ at: at(0, 9) }), bin({ at: at(7, 9) })], "lyss", "session", at(0, 0), at(14, 0), 4);
    expect(grid).toHaveLength(7 * 24);
    const monday9 = grid.find((c) => c.weekday === 0 && c.hour === 9)!;
    expect(monday9.usdPerPoint).toBeCloseTo(0.01);
    expect(monday9.weeks).toBe(2);
    const monday10 = grid.find((c) => c.weekday === 0 && c.hour === 10)!;
    expect(monday10.usdPerPoint).toBeNull();
    expect(monday10.points).toBe(0);
  });

  test("a cell's weeks cannot exceed the span's", () => {
    const bins = Array.from({ length: 7 }, (_, w) => bin({ at: at(w * 7, 9) }));
    const cell = weekGrid(bins, "lyss", "session", at(0, 0), at(49, 0), 4).find((c) => c.weekday === 0 && c.hour === 9)!;
    expect(cell.weeks).toBe(4);
  });

  test("an hour below the floor leaves its cell blank rather than cheap", () => {
    const grid = weekGrid([bin({ at: at(0, 9), points: 0.1, usd: 0.001 })], "lyss", "session", at(0, 0), at(7, 0), 4);
    expect(grid.find((c) => c.weekday === 0 && c.hour === 9)!.usdPerPoint).toBeNull();
  });
});

describe("saying it", () => {
  const w = worthOf(
    [
      bin({ at: at(0, 9), points: 4, usd: 0.04, tokens: 40_000 }),
      bin({ at: at(0, 10), points: 6, usd: 0.09, tokens: 90_000 }),
    ],
    "lyss",
    "session",
    at(0, 0),
    at(1, 0),
  );

  test("one percent and a whole window, both currencies, no dash", () => {
    expect(worthSaid(w)).toBe("1% ≈ 13k tok ≈ $0.013");
    expect(windowSaid(w)).toContain("100% ≈ 1.3M tok");
    expect(worthSaid(w)).not.toContain("—");
    expect(windowSaid(w)).not.toContain("—");
  });

  test("a reading with nothing measured says so rather than zero", () => {
    const empty = worthOf([], "lyss", "session", at(0, 0), at(1, 0));
    expect(worthSaid(empty)).toBe("not measured");
    expect(windowSaid(empty)).toBe("not measured");
  });

  test("the mix names what it can and counts the rest", () => {
    const many = worthOf(
      [
        bin({
          at: at(0, 9),
          usd: 10,
          mix: { opus: 0.6, sonnet: 0.35, haiku: 0.03, "deepseek-v4": 0.02 },
        }),
      ],
      "lyss",
      "session",
      at(0, 0),
      at(1, 0),
    );
    expect(mixSaid(many)).toBe("measured at opus 60%, sonnet 35% and 2 more");
  });

  test("the interval is a range in dollars per point", () => {
    const banded = worthOf(
      Array.from({ length: 10 }, (_, i) => bin({ at: at(0, i), usd: 0.02 + i * 0.01 })),
      "lyss",
      "session",
      at(0, 0),
      at(1, 0),
    );
    expect(bandSaid(banded)).toMatch(/^\$\d.* to \$\d.* per point$/);
    /* An interval narrower than the text can show says nothing rather than
       printing the same number twice. */
    expect(
      bandSaid(
        worthOf(
          Array.from({ length: 10 }, (_, i) => bin({ at: at(0, i), usd: 0.04 + i * 0.00001 })),
          "lyss",
          "session",
          at(0, 0),
          at(1, 0),
        ),
      ),
    ).toBe("");
  });

  test("every verdict is a sentence, and none of them uses an em dash", () => {
    const bins = Array.from({ length: 24 }, (_, i) =>
      bin({ at: at(0, i), usd: i < 12 ? 0.05 : 0.04 }),
    );
    const w24 = worthOf(bins, "lyss", "session", at(0, 0), at(1, 0));
    const verdicts = [
      verdictOf([], "lyss", "session", null, at(0, 0), at(1, 0)),
      verdictOf(bins.slice(0, 3), "lyss", "session", 0.04, at(0, 0), at(1, 0)),
      verdictOf(bins.map((b) => ({ ...b, usd: 0.04 })), "lyss", "session", 0.04, at(0, 0), at(1, 0)),
      verdictOf(bins, "lyss", "session", w24.usdPerPoint, at(0, 0), at(1, 0)),
      verdictOf(
        Array.from({ length: 24 }, (_, i) =>
          bin({ at: at(0, i), usd: 0.04, mix: { [i < 12 ? "opus" : "sonnet"]: 1 } }),
        ),
        "lyss",
        "session",
        0.04,
        at(0, 0),
        at(1, 0),
      ),
    ];
    for (const v of verdicts) {
      const said = verdictSaid(v);
      expect(said.length).toBeGreaterThan(10);
      expect(said).not.toContain("—");
    }
  });
});

describe("from the two reads to the hours", () => {
  function sample(over: Partial<AllowanceSample> & { at: number; used: number }): AllowanceSample {
    return {
      host: "desk",
      account: "lyss",
      kind: "session",
      scope: "",
      resetsAt: at(0, 5),
      severity: "normal",
      plan: "max_20x",
      source: "poll",
      ...over,
    };
  }

  function row(over: Partial<HourFact> & { hour: number }): HourFact {
    return {
      host: "desk",
      account: "lyss",
      provider: "",
      model: "claude-sonnet-5-5",
      effort: "",
      cli: "",
      source: "",
      project: "volery",
      provenance: "transcript",
      inTok: 1000,
      outTok: 2000,
      cacheRead: 10_000,
      write5m: 0,
      write1h: 0,
      requests: 1,
      usdReported: 0,
      ...over,
    };
  }

  test("an interval that straddles an hour boundary splits its points by time", () => {
    const bins = binsOf(
      [
        sample({ at: at(0, 9) + 45 * 60 * 1000, used: 10 }),
        sample({ at: at(0, 10) + 15 * 60 * 1000, used: 14 }),
      ],
      [row({ hour: at(0, 9) }), row({ hour: at(0, 10) })],
      "lyss",
    );
    const nine = bins.find((b) => b.at === at(0, 9))!;
    const ten = bins.find((b) => b.at === at(0, 10))!;
    // Fifteen minutes of a thirty-minute interval, four points.
    expect(nine.points).toBeCloseTo(2);
    expect(ten.points).toBeCloseTo(2);
    expect(bins).toHaveLength(2);
  });

  test("the money and the movement are joined on the hour, and only for this account", () => {
    const bins = binsOf(
      [sample({ at: at(0, 9), used: 4 }), sample({ at: at(0, 10), used: 8 })],
      [
        row({ hour: at(0, 9) }),
        row({ hour: at(0, 10), account: "alizee" }),
      ],
      "lyss",
    );
    expect(bins).toHaveLength(1);
    expect(bins[0].usd).toBeGreaterThan(0);
    expect(bins[0].tokens).toBe(13_000);
    expect(bins[0].mix["claude-sonnet-5-5"]).toBeCloseTo(1);
  });

  test("a model the price table cannot place is counted apart, on neither side of the ratio", () => {
    const bins = binsOf(
      [sample({ at: at(0, 9), used: 4 }), sample({ at: at(0, 10), used: 8 })],
      [row({ hour: at(0, 9), model: "not-a-model-anywhere" })],
      "lyss",
    );
    expect(bins[0].usd).toBe(0);
    expect(bins[0].tokens).toBe(0);
    expect(bins[0].unpriced).toBe(13_000);
    expect(isRated(bins[0])).toBe(false);
  });

  test("a turn row is dropped where a transcript row stands for the same hour", () => {
    const bins = binsOf(
      [sample({ at: at(0, 9), used: 4 }), sample({ at: at(0, 10), used: 8 })],
      [row({ hour: at(0, 9) }), row({ hour: at(0, 9), provenance: "turn", inTok: 50_000 })],
      "lyss",
    );
    expect(bins[0].tokens).toBe(13_000);
  });

  test("a turn row with no transcript beside it counts", () => {
    const bins = binsOf(
      [sample({ at: at(0, 9), used: 4 }), sample({ at: at(0, 10), used: 8 })],
      [row({ hour: at(0, 9), provenance: "turn" })],
      "lyss",
    );
    expect(bins[0].tokens).toBe(13_000);
  });

  test("every window the account has is read off the same money", () => {
    const bins = binsOf(
      [
        sample({ at: at(0, 9), used: 4 }),
        sample({ at: at(0, 10), used: 8 }),
        sample({ at: at(0, 9), kind: "weekly_all", used: 2 }),
        sample({ at: at(0, 10), kind: "weekly_all", used: 3 }),
      ],
      [row({ hour: at(0, 9) })],
      "lyss",
    );
    expect(bins.map((b) => b.kind).sort()).toEqual(["session", "weekly_all"]);
    // The same dollars advance both windows, so both bins carry them.
    expect(bins[0].usd).toBe(bins[1].usd);
    expect(bins[0].points).toBeCloseTo(4);
    expect(bins[1].points).toBeCloseTo(1);
  });

  test("a provider sentinel has no window to price", () => {
    expect(binsOf([sample({ at: at(0, 9), used: 4, account: "@deepseek" })], [], "@deepseek")).toEqual(
      [],
    );
  });

  test("one scoping answers the figure, the verdict and the grid", () => {
    const bins = Array.from({ length: 30 }, (_, i) =>
      bin({ at: at(Math.floor(i / 24), i % 24), points: 4, usd: 0.04 }),
    );
    const inside = readingOf(bins, "lyss", "session", at(0, 0), at(1, 0));
    const outside = readingOf(bins, "lyss", "session", at(1, 0), at(2, 0));
    expect(inside.worth.hours).toBe(24);
    expect(inside.verdict.kind).toBe("steady");
    expect(inside.grid.filter((c) => c.usdPerPoint !== null)).toHaveLength(24);
    expect(outside.worth.hours).toBe(6);
    expect(outside.grid.filter((c) => c.usdPerPoint !== null)).toHaveLength(6);
  });
});
