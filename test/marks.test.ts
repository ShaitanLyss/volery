import { describe, expect, test } from "bun:test";
import { piecesOf, RELAY_MARKS, type Dir, type Pt } from "../src/lib/marks";

const centre = (pts: Pt[]) => ({
  x: pts.reduce((a, p) => a + p[0], 0) / pts.length,
  y: pts.reduce((a, p) => a + p[1], 0) / pts.length,
});

describe("the relay marks", () => {
  for (const dir of ["in", "out"] as Dir[]) {
    test(`${dir}: a swash and a bird, every point a number inside the frame`, () => {
      const { swash, bird } = piecesOf(dir);
      expect(swash.length).toBeGreaterThan(20);
      expect(bird.length).toBeGreaterThan(20);
      for (const [x, y] of [...swash, ...bird]) {
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(32);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(32);
      }
    });

    /* The swash is where the bird came from and the bird is where it is going,
       and both marks fly rightward: that is the whole of the direction. */
    test(`${dir}: the swash is behind the bird`, () => {
      const { swash, bird } = piecesOf(dir);
      expect(centre(swash).x).toBeLessThan(centre(bird).x);
    });
  }

  test("received comes down from the top left: the swash is above the bird", () => {
    const { swash, bird } = piecesOf("in");
    expect(centre(swash).y).toBeLessThan(centre(bird).y);
  });

  test("sent climbs to the top right: the swash is below the bird", () => {
    const { swash, bird } = piecesOf("out");
    expect(centre(swash).y).toBeGreaterThan(centre(bird).y);
  });

  test("the two marks are different drawings, each one swash and a two-piece bird", () => {
    expect(RELAY_MARKS.in).not.toBe(RELAY_MARKS.out);
    for (const d of Object.values(RELAY_MARKS)) {
      expect(d.match(/M/g)).toHaveLength(3);
      expect(d.match(/Z/g)).toHaveLength(3);
      expect(d).not.toMatch(/NaN|Infinity/);
    }
  });
});
