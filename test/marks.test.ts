import { describe, expect, test } from "bun:test";
import { birdsOf, RELAY_MARKS, type Dir, type Pt } from "../src/lib/marks";

const box = (pts: Pt[]) => {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};
const centre = (bird: Pt[][]) => {
  const b = box(bird.flat());
  return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, span: b.x1 - b.x0 };
};

describe("the relay marks", () => {
  for (const dir of ["in", "out"] as Dir[]) {
    test(`${dir}: three birds, each two wings, every point a number inside the frame`, () => {
      const birds = birdsOf(dir);
      expect(birds).toHaveLength(3);
      for (const bird of birds) {
        expect(bird).toHaveLength(2);
        for (const [x, y] of bird.flat()) {
          expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(32);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(32);
        }
      }
    });

    /* Her correction, and what makes three birds read as movement: they grow
       toward where the flock is going, so the leader is the biggest. */
    test(`${dir}: each bird is bigger than the one behind it`, () => {
      const spans = birdsOf(dir).map((b) => centre(b).span);
      expect(spans[0]).toBeLessThan(spans[1]);
      expect(spans[1]).toBeLessThan(spans[2]);
    });
  }

  test("received comes down from the top left: the leader is lowest and furthest right", () => {
    const [far, , lead] = birdsOf("in").map(centre);
    expect(lead.x).toBeGreaterThan(far.x);
    expect(lead.y).toBeGreaterThan(far.y);
  });

  test("sent climbs to the top right: the leader is highest and furthest right", () => {
    const [far, , lead] = birdsOf("out").map(centre);
    expect(lead.x).toBeGreaterThan(far.x);
    expect(lead.y).toBeLessThan(far.y);
  });

  test("the two marks are different drawings, each one path of six closed outlines", () => {
    expect(RELAY_MARKS.in).not.toBe(RELAY_MARKS.out);
    for (const d of Object.values(RELAY_MARKS)) {
      expect(d.match(/M/g)).toHaveLength(6);
      expect(d.match(/Z/g)).toHaveLength(6);
      expect(d).not.toMatch(/NaN|Infinity/);
    }
  });
});
