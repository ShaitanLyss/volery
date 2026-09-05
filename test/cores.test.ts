import { describe, expect, test } from "bun:test";
import {
  add,
  area,
  busiest,
  coreCount,
  currentOf,
  DEFAULT_SPAN,
  fits,
  gridOf,
  INSET,
  KEEP,
  laneOf,
  mean,
  meanLaneOf,
  peakLaneOf,
  polyline,
  say,
  SPANS,
  spanOf,
  type Reading,
} from "../src/lib/cores";

/* The per-core reading, on a made-up machine. Eight cores unless a test says
   otherwise, because eight is the smallest count where the grid has an
   interesting answer and the spread has something to spread. */

const NOW = 1_700_000_000_000;

/** A history at a steady two-second tick, oldest first, ending `at` — which is
 *  what the meter produces and therefore what every lane below is drawn from. */
function history(loads: number[][], at = NOW, every = 2000): Reading[] {
  return loads.map((load, i) => ({ at: at - (loads.length - 1 - i) * every, load }));
}

const flat = (n: number, v: number) => Array.from({ length: n }, () => v);

/* ── keeping the readings ──────────────────────────────────────────────── */

describe("the ring the meter folds into", () => {
  test("a reading is kept with the instant it was taken", () => {
    const h = add([], NOW, [10, 20]);
    expect(h).toEqual([{ at: NOW, load: [10, 20] }]);
  });

  test("the oldest goes when it is full, and the newest is always last", () => {
    let h: Reading[] = [];
    for (let i = 0; i < KEEP + 30; i++) h = add(h, NOW + i, [0]);
    expect(h).toHaveLength(KEEP);
    expect(h[h.length - 1].at).toBe(NOW + KEEP + 29);
    expect(h[0].at).toBe(NOW + 30);
  });

  /* An older Rust answers with no `per_core` at all, and `Sample` types the
     field optional for exactly that. A lane of zeroes drawn from an empty
     reading would be this widget reporting an idle machine it never read. */
  test("a reading with no cores in it is refused rather than drawn as idle", () => {
    expect(add([], NOW, [])).toEqual([]);
    const h = add([], NOW, [50]);
    expect(add(h, NOW + 2000, [])).toBe(h);
  });

  /* sysinfo has been seen to answer slightly over 100 on a core, and a NaN
     anywhere in a polyline takes the whole path with it. */
  test("a percentage is clamped into the scale it is drawn against", () => {
    expect(add([], NOW, [120, -3, NaN])[0].load).toEqual([100, 0, 0]);
  });

  test("a new array every time, since the holder's dependency is the identity", () => {
    const h = add([], NOW, [1]);
    expect(add(h, NOW + 1, [2])).not.toBe(h);
  });
});

describe("what the newest reading says", () => {
  test("how many cores this machine has, from the reading that is about now", () => {
    expect(coreCount(history([[1, 2], [3, 4, 5]]))).toBe(3);
    expect(coreCount([])).toBe(0);
  });

  test("nothing sampled yet is an empty reading, not a machine at zero", () => {
    expect(currentOf([])).toEqual([]);
  });

  test("the machine is the mean of its cores", () => {
    expect(mean([0, 50, 100, 50])).toBe(50);
    expect(mean([])).toBe(0);
  });

  test("the busiest core is the one carrying it", () => {
    expect(busiest([2, 91, 4])).toBe(1);
  });

  /* Otherwise the label wanders between four cores at 0.4% while the machine is
     asleep, which reads as something happening. A busiest core is only news
     when there is something to be busy about. */
  test("an idle machine has no busiest core to point at", () => {
    expect(busiest([1, 3, 0, 2])).toBeNull();
    expect(busiest([])).toBeNull();
  });

  test("a percentage is whole, because the sample is a two-second average", () => {
    expect(say(37.4)).toBe("37%");
    expect(say(99.6)).toBe("100%");
    expect(say(-2)).toBe("0%");
  });
});

/* ── how far back it goes ──────────────────────────────────────────────── */

describe("the spans, which are durations rather than counts of samples", () => {
  test("the default is one the table knows", () => {
    expect(SPANS.some((s) => s.value === DEFAULT_SPAN)).toBe(true);
  });

  test("an unknown span falls to the first rather than to zero", () => {
    expect(spanOf("whenever")).toBe(SPANS[0].ms);
  });

  test("every span is labelled in the wall's own register", () => {
    for (const s of SPANS) expect(s.label).toBe(s.label.toLowerCase());
  });

  /* The memory bound has to cover the longest window at the meter's own tick,
     or the widest span would be a label promising history the ring never
     kept. */
  test("the ring holds the longest span at a two-second tick", () => {
    const longest = Math.max(...SPANS.map((s) => s.ms));
    expect(KEEP * 2000).toBeGreaterThanOrEqual(longest);
  });
});

/* ── the lanes ─────────────────────────────────────────────────────────── */

describe("one core's lane, with now at the right", () => {
  test("the newest reading sits at the right edge", () => {
    const lane = laneOf(history([[10], [90]]), 0, 60_000, NOW);
    expect(lane[lane.length - 1]).toEqual({ x: 100, y: 90 });
  });

  /* x is age, so a graph that has only been running ten seconds fills the right
     of the box and leaves the left empty — which is what it should look like,
     and what Task Manager does on the same evidence. */
  test("a partial history fills the right and leaves the left alone", () => {
    const lane = laneOf(history([[40], [50], [60]]), 0, 60_000, NOW);
    expect(lane).toHaveLength(3);
    expect(lane[0].x).toBeCloseTo(100 - (4000 / 60_000) * 100, 5);
    expect(lane.every((p) => p.x > 50)).toBe(true);
  });

  test("anything older than the span is not in it", () => {
    const h = history([[10], [20], [30]], NOW, 40_000);
    expect(laneOf(h, 0, 60_000, NOW).map((p) => p.y)).toEqual([20, 30]);
  });

  /* A skipped tick has to draw as a gap. A lane spaced evenly by index would
     quietly redraw a stall as a healthy line, which is the one thing an
     instrument about load must not do. */
  test("a gap in the sampling is a gap in the lane", () => {
    const h: Reading[] = [
      { at: NOW - 60_000, load: [10] },
      { at: NOW - 2_000, load: [90] },
      { at: NOW, load: [95] },
    ];
    const lane = laneOf(h, 0, 60_000, NOW);
    expect(lane[1].x - lane[0].x).toBeGreaterThan(90);
    expect(lane[2].x - lane[1].x).toBeLessThan(10);
  });

  test("a core the reading does not have is simply absent", () => {
    expect(laneOf(history([[10]]), 3, 60_000, NOW)).toEqual([]);
  });

  test("a reading from the future is not drawn", () => {
    const h: Reading[] = [{ at: NOW + 5_000, load: [50] }];
    expect(laneOf(h, 0, 60_000, NOW)).toEqual([]);
  });
});

describe("the machine and its busiest core, on one pair of axes", () => {
  const h = history([
    [0, 0, 0, 100],
    [50, 50, 50, 50],
  ]);

  /* The two together are the whole point of the spread reading: both of these
     machines are at 50%, and one of them has a core pinned. */
  test("the mean and the peak part company when the work is not spread", () => {
    expect(meanLaneOf(h, 60_000, NOW)[0].y).toBe(25);
    expect(peakLaneOf(h, 60_000, NOW)[0].y).toBe(100);
  });

  test("and meet when it is", () => {
    expect(meanLaneOf(h, 60_000, NOW)[1].y).toBe(50);
    expect(peakLaneOf(h, 60_000, NOW)[1].y).toBe(50);
  });

  /* Taken from the same reading rather than sampled apart, so the two lines
     cannot disagree about a moment. */
  test("a reading with no cores in it lands in neither lane", () => {
    const odd: Reading[] = [{ at: NOW, load: [] }];
    expect(meanLaneOf(odd, 60_000, NOW)).toEqual([]);
    expect(peakLaneOf(odd, 60_000, NOW)).toEqual([]);
  });
});

/* ── the grid ──────────────────────────────────────────────────────────── */

describe("how a box of cells reflows", () => {
  test("a wide box lays the cores out in a row or two", () => {
    const g = gridOf(16, 640, 120);
    expect(g.cols).toBeGreaterThan(g.rows);
    expect(g.cols * g.rows).toBeGreaterThanOrEqual(16);
  });

  test("a tall box stacks them", () => {
    const g = gridOf(16, 140, 620);
    expect(g.rows).toBeGreaterThan(g.cols);
    expect(g.cols * g.rows).toBeGreaterThanOrEqual(16);
  });

  test("a square box comes out square", () => {
    expect(gridOf(16, 320, 240)).toEqual({ cols: 4, rows: 4 });
  });

  /* Ties go to the arrangement with fewer holes in it: six cores want 3×2, not
     4×2 with two empty cells. */
  test("an awkward count is laid out without leaving holes where it need not", () => {
    const g = gridOf(6, 300, 180);
    expect(g.cols * g.rows).toBe(6);
  });

  test("every core gets a cell, whatever the shape", () => {
    for (const n of [1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 32]) {
      for (const [w, h] of [
        [300, 180],
        [640, 120],
        [140, 620],
        [900, 700],
      ]) {
        const g = gridOf(n, w, h);
        expect(g.cols * g.rows).toBeGreaterThanOrEqual(n);
      }
    }
  });

  test("nothing to draw is still a grid rather than a division by zero", () => {
    expect(gridOf(0, 300, 180)).toEqual({ cols: 1, rows: 1 });
    expect(gridOf(8, 0, 0)).toEqual({ cols: 1, rows: 1 });
  });

  /* The floor is what makes the bars reading the honest fallback rather than a
     preference: past it the cells are smudges, and a graph needs width as well
     as height where a bar needs only height. */
  test("a box too small for legible cells says so", () => {
    expect(fits(16, 300, 180)).toBe(true);
    expect(fits(16, 120, 62)).toBe(false);
  });

  test("the catalogue's own default box fits the machine it was sized for", () => {
    /* `box` is 300×180 and the face takes the header and padding off the top —
       see `HEAD`/`PAD` in `Cores.svelte`. Sixteen lanes have to fit in what is
       left, or the widget arrives already degraded to bars. */
    expect(fits(16, 300 - 10, 180 - 32)).toBe(true);
  });
});

/* ── drawing ───────────────────────────────────────────────────────────── */

describe("a lane as something an SVG can take", () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 100, y: 100 },
  ];

  test("y is flipped for the screen, and held off both edges", () => {
    expect(polyline(pts)).toBe(`0.00,${(100 - INSET).toFixed(2)} 100.00,${INSET.toFixed(2)}`);
  });

  /* A flat lane at zero drawn at exactly 100 loses its lower half to the clip
     and reads as a hairline that has been cut — a rendering fault rather than an
     idle core. `Speedo.svelte` learned this at 216×196 and the inset is the same
     number. */
  test("an idle core still has a line under it", () => {
    const idle = polyline([{ x: 0, y: 0 }]);
    expect(idle).toBe(`0.00,${(100 - INSET).toFixed(2)}`);
    expect(idle).not.toContain("100.00\n");
  });

  test("the area closes down to the baseline at both ends", () => {
    const a = area(pts);
    expect(a.startsWith(`0.00,${(100 - INSET).toFixed(2)}`)).toBe(true);
    expect(a.endsWith(`100.00,${(100 - INSET).toFixed(2)}`)).toBe(true);
  });

  test("one point is not an area, and does not draw as a spike", () => {
    expect(area([{ x: 100, y: 50 }])).toBe("");
    expect(area([])).toBe("");
  });

  test("nothing anywhere in a path is ever NaN", () => {
    const lane = laneOf(history([flat(4, 0), flat(4, 100)]), 2, 60_000, NOW);
    expect(polyline(lane)).not.toContain("NaN");
    expect(area(lane)).not.toContain("NaN");
  });
});
