import { describe, expect, test } from "bun:test";
import { HOUR, MINUTE, WEEK_MS, type Slice } from "../src/lib/usage";
import {
  BUCKET_MS,
  FLOOR_PER_MINUTE,
  SWEEP_DEG,
  START_DEG,
  WINDOW_MS,
  angleFor,
  busyPace,
  busyRates,
  fracOf,
  fullScale,
  idleFor,
  lastAt,
  over,
  perOf,
  quantile,
  rateAt,
  sayIdle,
  sayRate,
  sayTick,
  saidUnit,
  shortUnit,
  snapUp,
  ticksOf,
  tokensOf,
  trace,
} from "../src/lib/rate";

/* A bucket carrying `n` tokens, all as cache reads unless said otherwise — the
   kind does not matter to a rate, only the total, and one field keeps the
   fixtures readable. */
function at(ms: number, n: number, model = "claude-opus-5"): Slice {
  return {
    at: ms,
    model,
    input: 0,
    output: 0,
    cacheRead: n,
    write5m: 0,
    write1h: 0,
  };
}

/** A time that is exactly on a bucket boundary, so a fixture says what it
 *  means. Chosen well clear of the epoch so a week back is still positive. */
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % BUCKET_MS);

describe("the unit", () => {
  test("a unit nothing recognises reads as the one the data argues for", () => {
    expect(perOf("minute")).toBe("minute");
    expect(perOf("second")).toBe("second");
    expect(perOf("hour")).toBe("hour");
    /* Total both ways round: an older build's spelling and a knob that came
       back off disk as something else both land on the default rather than
       drawing a face with no unit. */
    expect(perOf("fortnight")).toBe("minute");
    expect(perOf("")).toBe("minute");
  });

  test("every unit has both a short and a spoken form", () => {
    for (const p of ["second", "minute", "hour"] as const) {
      expect(shortUnit(p).startsWith("/")).toBe(true);
      expect(saidUnit(p)).toContain("tokens");
    }
  });
});

describe("the reading", () => {
  test("a bucket's tokens are all five kinds", () => {
    expect(
      tokensOf({
        at: 0,
        model: "m",
        input: 1,
        output: 2,
        cacheRead: 4,
        write5m: 8,
        write1h: 16,
      }),
    ).toBe(31);
  });

  test("a steady wall reads its own steady rate", () => {
    /* Two full buckets of 500k each, and `now` exactly on the boundary after
       them: the window is precisely those two, a million tokens over ten
       minutes, so a hundred thousand a minute. */
    const slices = [at(T0 - 2 * BUCKET_MS, 500_000), at(T0 - BUCKET_MS, 500_000)];
    expect(rateAt(slices, T0, "minute")).toBeCloseTo(100_000, 5);
  });

  test("the same reading in each unit is the same reading", () => {
    const slices = [at(T0 - 2 * BUCKET_MS, 500_000), at(T0 - BUCKET_MS, 500_000)];
    const perMin = rateAt(slices, T0, "minute");
    expect(rateAt(slices, T0, "second")).toBeCloseTo(perMin / 60, 5);
    expect(rateAt(slices, T0, "hour")).toBeCloseTo(perMin * 60, 5);
  });

  /* The bug this whole arithmetic is arranged around. Everything in the current
     bucket has already happened, so apportioning it by how much of the *bucket*
     the window covers would scale live activity down to nothing right after a
     boundary and ramp it back over five minutes — a needle sawtoothing on the
     clock rather than on the work. */
  test("the bucket now is inside counts whole, however new it is", () => {
    const slices = [at(T0, 600_000)];
    /* One second into the bucket and four minutes into it read the same, and
       both read the whole 600k against the ten-minute window. */
    expect(rateAt(slices, T0 + 1000, "minute")).toBeCloseTo(60_000, 5);
    expect(rateAt(slices, T0 + 4 * MINUTE, "minute")).toBeCloseTo(60_000, 5);
  });

  test("the bucket at the far edge is apportioned by how much of it is inside", () => {
    /* `now` is two and a half minutes into a bucket, so the window reaches back
       to halfway through the bucket three ago. That bucket's 400k counts half. */
    const now = T0 + BUCKET_MS / 2;
    const slices = [at(T0 - 2 * BUCKET_MS, 400_000)];
    expect(rateAt(slices, now, "minute")).toBeCloseTo(200_000 / 10, 5);
  });

  test("a bucket wholly behind the window contributes nothing", () => {
    const slices = [at(T0 - 4 * BUCKET_MS, 9_000_000)];
    expect(rateAt(slices, T0, "minute")).toBe(0);
  });

  test("a bucket dated after now is ignored rather than counted", () => {
    /* A clock put back, not a burst. Folding it in would draw a spike out of a
       machine that had merely been resynchronised. */
    const slices = [at(T0 + 3 * BUCKET_MS, 5_000_000)];
    expect(rateAt(slices, T0, "minute")).toBe(0);
  });

  test("an empty wall reads zero rather than a NaN", () => {
    expect(rateAt([], T0, "minute")).toBe(0);
    expect(Number.isFinite(rateAt([], T0, "hour"))).toBe(true);
  });

  /* The half that makes the needle move between the ledger's twenty-second
     beats: the window's far edge slides with `now`, so a lull decays the
     reading continuously instead of stepping it every five minutes. */
  test("a lull decays the reading rather than stepping it", () => {
    const slices = [at(T0 - 2 * BUCKET_MS, 1_000_000)];
    const a = rateAt(slices, T0, "minute");
    const b = rateAt(slices, T0 + MINUTE, "minute");
    const c = rateAt(slices, T0 + 2 * MINUTE, "minute");
    expect(b).toBeLessThan(a);
    expect(c).toBeLessThan(b);
    /* And it is smooth: the two steps are the same size, since a fifth of a
       bucket leaves the window each minute. */
    expect(a - b).toBeCloseTo(b - c, 5);
  });

  test("the window is ten minutes and nothing older is in it", () => {
    expect(WINDOW_MS).toBe(10 * MINUTE);
    const slices = [at(T0 - WINDOW_MS - BUCKET_MS, 5_000_000)];
    expect(rateAt(slices, T0, "minute")).toBe(0);
  });
});

describe("when the wall was last busy", () => {
  test("the last instant is the end of the last bucket, not its start", () => {
    /* A bucket's stamp is when it opened; anything in it may have happened up
       to five minutes later, so a face saying "nothing for 5m" the moment a
       turn finished would be wrong by exactly a bucket. */
    expect(lastAt([at(T0 - BUCKET_MS, 10)])).toBe(T0);
  });

  test("a wall that has never spent a token has no last instant", () => {
    expect(lastAt([])).toBeNull();
    expect(idleFor([], T0)).toBeNull();
  });

  test("idle time is never negative, however fresh the bucket", () => {
    expect(idleFor([at(T0, 10)], T0 + 1000)).toBe(0);
    expect(idleFor([at(T0 - 3 * HOUR, 10)], T0)).toBe(3 * HOUR - BUCKET_MS);
  });

  test("quiet is said in words that change about once a minute", () => {
    expect(sayIdle(30_000)).toBe("just now");
    expect(sayIdle(7 * MINUTE)).toBe("7m");
    expect(sayIdle(3 * HOUR + 20 * MINUTE)).toBe("3h");
    expect(sayIdle(50 * HOUR)).toBe("2d");
  });
});

describe("what the dial is marked to", () => {
  test("the ladder is one, two and five through every decade", () => {
    expect(snapUp(1)).toBe(1);
    expect(snapUp(1.5)).toBe(2);
    expect(snapUp(2)).toBe(2);
    expect(snapUp(2.1)).toBe(5);
    expect(snapUp(5)).toBe(5);
    expect(snapUp(5.1)).toBe(10);
    expect(snapUp(1_730_000)).toBe(2_000_000);
    expect(snapUp(2_500_000)).toBe(5_000_000);
    expect(snapUp(0)).toBe(0);
    expect(snapUp(-4)).toBe(0);
  });

  test("a percentile of nothing is nothing", () => {
    expect(quantile([], 0.9)).toBe(0);
    expect(quantile([7], 0.9)).toBe(7);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(10);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(6);
  });

  test("only the busy five minutes of the past week are counted", () => {
    const slices = [
      at(T0 - WEEK_MS - HOUR, 5_000_000), // older than the week
      at(T0 - HOUR, 500_000), // 100k/min
      at(T0 - 2 * HOUR, 1_000_000), // 200k/min
    ];
    expect(busyRates(slices, T0, "minute").sort((a, b) => a - b)).toEqual([
      100_000, 200_000,
    ]);
  });

  test("a bucket carrying nothing is not a busy five minutes", () => {
    expect(busyRates([at(T0 - HOUR, 0)], T0, "minute")).toEqual([]);
  });

  /* The measured design decision, as a test. Scaling to the *peak* was tried
     and thrown out: this machine's peak is about 6.9M/min against a median busy
     pace of 550k, so a peak-scaled needle spends 92% of its working life in the
     bottom seventh of the dial. The ninetieth percentile puts normal work at
     about a quarter and hard work at half or better. */
  test("full scale is the busy pace, not the peak", () => {
    const slices = [
      /* Nineteen ordinary five-minutes at 500k tokens — 100k/min. */
      ...Array.from({ length: 19 }, (_, i) => at(T0 - (i + 2) * BUCKET_MS, 500_000)),
      /* And one spike thirty times bigger. */
      at(T0 - 30 * BUCKET_MS, 15_000_000),
    ];
    /* The peak is 3M/min and would mark the dial to 5M, leaving every ordinary
       reading at a fiftieth of it. The busy pace is the ordinary one. */
    expect(busyPace(slices, T0, "minute")).toBe(100_000);
    expect(fullScale(slices, T0, "minute")).toBe(FLOOR_PER_MINUTE);
  });

  test("a wall with real history is marked off its own habits", () => {
    /* Ten busy five-minutes: nine at 1.5M/min and one at 5M/min. The ninetieth
       percentile is the 5M one by nearest rank — a dial marked to 5M. */
    const slices = [
      ...Array.from({ length: 9 }, (_, i) => at(T0 - (i + 2) * BUCKET_MS, 7_500_000)),
      at(T0 - 20 * BUCKET_MS, 25_000_000),
    ];
    expect(fullScale(slices, T0, "minute")).toBe(5_000_000);
  });

  test("a fresh machine is marked to the floor rather than to nothing", () => {
    /* A dial marked to zero has no needle position at all, and one marked below
       a single reply is pegged by the first thing that happens. */
    expect(fullScale([], T0, "minute")).toBe(FLOOR_PER_MINUTE);
    expect(fullScale([], T0, "second")).toBe(snapUp(FLOOR_PER_MINUTE / 60));
    expect(fullScale([], T0, "hour")).toBe(snapUp(FLOOR_PER_MINUTE * 60));
  });

  /* A scale that grew to hold whatever the needle was doing would re-mark the
     face mid-sweep — every numeral changing and the needle falling back from
     the top — which reads as the instrument rescaling reality rather than as
     the wall going fast. Pegging is what a speedometer does. */
  test("one fast reading does not re-mark the dial under the needle", () => {
    const week = Array.from({ length: 40 }, (_, i) =>
      at(T0 - (i + 3) * BUCKET_MS, 500_000),
    );
    const calm = fullScale(week, T0, "minute");
    /* A burst thirty times the usual pace, in the bucket now in progress. */
    const burst = [...week, at(T0, 15_000_000)];
    expect(rateAt(burst, T0 + 1000, "minute")).toBeGreaterThan(calm);
    /* One bucket in forty does not move a ninetieth percentile, so the face is
       unchanged and the needle is simply past the end. */
    expect(fullScale(burst, T0 + 1000, "minute")).toBe(calm);
    expect(over(rateAt(burst, T0 + 1000, "minute"), calm)).toBe(true);
  });

  /* The case that argued for widening the scale to fit the needle, and the
     reason it needs no special case: the bucket in progress is in the sample,
     so a machine with no history re-marks itself off its own first session
     rather than staying pegged to the floor. */
  test("a wall with no history is re-marked by its own first session", () => {
    const fresh = [at(T0 - BUCKET_MS, 15_000_000), at(T0, 15_000_000)];
    expect(fullScale(fresh, T0, "minute")).toBe(5_000_000);
    expect(fullScale(fresh, T0, "minute")).toBeGreaterThan(FLOOR_PER_MINUTE);
  });

  test("every scale is a ladder step, whatever went in", () => {
    for (const n of [1, 999, 173_000, 1_730_000, 4_000_001, 9e8]) {
      const slices = [at(T0 - BUCKET_MS, n)];
      expect(snapUp(fullScale(slices, T0, "minute"))).toBe(
        fullScale(slices, T0, "minute"),
      );
    }
  });
});

describe("the face of a dial", () => {
  test("the sweep runs from about seven o'clock to about five", () => {
    expect(angleFor(0)).toBe(START_DEG);
    expect(angleFor(1)).toBe(START_DEG + SWEEP_DEG);
    expect(angleFor(0.5)).toBe(0);
    /* Clamped at both ends — a needle swung past the peg is a broken dial, and
       `over` is what carries the rest of the reading. */
    expect(angleFor(-3)).toBe(START_DEG);
    expect(angleFor(9)).toBe(START_DEG + SWEEP_DEG);
    /* Symmetric about straight up, which is what makes it read as an
       instrument rather than as an arc that happens to be there. */
    expect(START_DEG + SWEEP_DEG).toBe(-START_DEG);
  });

  test("a fraction is clamped and a scale of nothing is not a division", () => {
    expect(fracOf(500, 1000)).toBe(0.5);
    expect(fracOf(5000, 1000)).toBe(1);
    expect(fracOf(-1, 1000)).toBe(0);
    expect(fracOf(500, 0)).toBe(0);
    expect(Number.isFinite(fracOf(500, 0))).toBe(true);
  });

  test("running past the end is reported apart from the needle", () => {
    expect(over(1200, 1000)).toBe(true);
    expect(over(1000, 1000)).toBe(false);
    expect(over(1200, 0)).toBe(false);
  });

  test("a dial marked to two is quartered and one marked to five is fifthed", () => {
    const twos = ticksOf(2_000_000).filter((t) => t.major);
    expect(twos.map((t) => t.at)).toEqual([0, 500_000, 1_000_000, 1_500_000, 2_000_000]);
    const fives = ticksOf(5_000_000).filter((t) => t.major);
    expect(fives.map((t) => t.at)).toEqual([
      0, 1_000_000, 2_000_000, 3_000_000, 4_000_000, 5_000_000,
    ]);
    const ones = ticksOf(1_000_000).filter((t) => t.major);
    expect(ones.map((t) => t.at)).toEqual([
      0, 200_000, 400_000, 600_000, 800_000, 1_000_000,
    ]);
  });

  test("every major is cut into five", () => {
    const ticks = ticksOf(2_000_000);
    expect(ticks).toHaveLength(21);
    expect(ticks.filter((t) => t.major)).toHaveLength(5);
  });

  test("the marks run the whole sweep and no further", () => {
    const ticks = ticksOf(1_000_000);
    expect(ticks[0]!.deg).toBe(START_DEG);
    expect(ticks[ticks.length - 1]!.deg).toBe(START_DEG + SWEEP_DEG);
    for (const t of ticks) {
      expect(t.deg).toBeGreaterThanOrEqual(START_DEG);
      expect(t.deg).toBeLessThanOrEqual(START_DEG + SWEEP_DEG);
    }
  });

  test("a dial marked to nothing draws no marks rather than dividing by zero", () => {
    expect(ticksOf(0)).toEqual([]);
    expect(ticksOf(-1)).toEqual([]);
  });
});

describe("the reading over time", () => {
  test("a trace is the same reading, drawn where it was", () => {
    const slices = [at(T0 - 2 * BUCKET_MS, 1_000_000)];
    const t = trace(slices, T0, "minute", 4, HOUR);
    expect(t).toHaveLength(4);
    /* Oldest first, and the last sample is the needle's own reading. */
    expect(t[3]).toBeCloseTo(rateAt(slices, T0, "minute"), 5);
    expect(t[0]).toBeCloseTo(rateAt(slices, T0 - HOUR, "minute"), 5);
  });

  test("a trace of one point is the reading now", () => {
    const slices = [at(T0 - BUCKET_MS, 500_000)];
    expect(trace(slices, T0, "minute", 1)).toEqual([rateAt(slices, T0, "minute")]);
  });

  test("a trace over an empty wall is flat rather than absent", () => {
    const t = trace([], T0, "minute", 8);
    expect(t).toHaveLength(8);
    expect(t.every((v) => v === 0)).toBe(true);
  });
});

describe("saying it", () => {
  /* The reason this is not `usage.ts::count`: a rate sits under a needle and
     moves, so a numeral that drops a digit as it grows reflows the line the eye
     is resting on. Three significant figures throughout. */
  test("a rate keeps its shape as it grows", () => {
    expect(sayRate(0)).toBe("0");
    expect(sayRate(-5)).toBe("0");
    expect(sayRate(842)).toBe("842");
    expect(sayRate(1000)).toBe("1.00k");
    expect(sayRate(9_990)).toBe("9.99k");
    expect(sayRate(42_400)).toBe("42.4k");
    expect(sayRate(551_000)).toBe("551k");
    expect(sayRate(1_730_000)).toBe("1.73M");
    expect(sayRate(24_600_000)).toBe("24.6M");
    expect(sayRate(1_200_000_000)).toBe("1.20B");
  });

  /* Every threshold compares before it rounds, and these are the three values
     that catch it not doing so: they format to six characters under the obvious
     arithmetic (`10.00k`, `100.0k`, `1000k`) and to five under the right one.
     The same trap `usage.ts::money` is shaped around — found here by asserting
     the width rather than the value, which is the assertion that catches it. */
  test("a rate's numeral never grows past five characters", () => {
    for (const v of [
      0, 1, 999, 999.6, 1000, 9999, 10_500, 99_950, 999_000, 999_500, 1e6, 9.9e8,
      5e9,
    ]) {
      expect(sayRate(v).length).toBeLessThanOrEqual(5);
    }
    expect(sayRate(9999)).toBe("10.0k");
    expect(sayRate(99_950)).toBe("100k");
    expect(sayRate(999_500)).toBe("1.00M");
  });

  test("a scale's numerals are coarser, because a scale is read past", () => {
    expect(sayTick(0)).toBe("0");
    expect(sayTick(500_000)).toBe("500k");
    expect(sayTick(1_500_000)).toBe("1.5M");
    expect(sayTick(2_000_000)).toBe("2M");
    expect(sayTick(200_000)).toBe("200k");
  });
});
