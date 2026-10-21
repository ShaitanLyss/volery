/* The marks a relay wears: a swallow landing, and a swallow taking off.
 *
 * The arrows they replace said the wrong thing twice. They were not anything —
 * a chevron is the chrome of every app ever made — and the one on a received
 * message pointed *out*, left, so a message arriving read as one leaving (Lyss,
 * 2026-10-21: "something that evokes a bird landing coming from top left for
 * received, and something evoking bird taking off going top right for sent").
 *
 * Chosen from pictures over three rounds. Single-weight icons were turned down
 * as plain; of three ink drawings — a sumi-e gull, a flock of three, this — she
 * took the swallow. So each mark is two things: **a swash**, a brush stroke
 * that swells and runs out, which is the line of flight; and **the bird**, a
 * forked-tail swallow in silhouette with both wings raised. Received, the swash
 * comes down from the top left and the bird is at its foot, nose up, settling.
 * Sent, the swash rises from the bottom left and the bird is past its end,
 * climbing hard to the top right.
 *
 * Ink rather than line, which is why this is a module of its own beside
 * `icons.ts` rather than two more entries in its table: those are 16-unit
 * strokes `Icon.svelte` draws with `stroke`, these are filled outlines on a 32
 * grid that `RelayMark.svelte` draws with `fill`, and a shape list that could be
 * either is one nobody can draw without asking which.
 *
 * Computed, not pasted. The swash is a few dozen sampled points and the bird is
 * placed by a transform; a table of the results would be the one thing here
 * nobody could change. Pure — no runes — so `test/marks.test.ts` can hold what
 * makes it read: one swash and one bird each, inside the frame, the swash on
 * the side the bird came from and the bird on the side it is going. */

export type Pt = [number, number];
export type Dir = "in" | "out";

const r1 = (n: number) => Math.round(n * 10) / 10;

function bez(p: readonly Pt[], t: number): Pt {
  const u = 1 - t;
  return [0, 1].map(
    (k) => u * u * u * p[0][k] + 3 * u * u * t * p[1][k] + 3 * u * t * t * p[2][k] + t * t * t * p[3][k],
  ) as Pt;
}

/** A brush stroke along one cubic: an outline whose width follows `prof(t)`
 *  across the stroke, sampled `n` times a side. */
export function brush(p: readonly Pt[], w: number, prof: (t: number) => number, n = 28): Pt[] {
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = bez(p, Math.max(0, t - 0.01));
    const b = bez(p, Math.min(1, t + 0.01));
    const c = bez(p, t);
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const m = Math.hypot(dx, dy) || 1;
    dx /= m;
    dy /= m;
    const hw = (w * prof(t)) / 2;
    left.push([c[0] - dy * hw, c[1] + dx * hw]);
    right.push([c[0] + dy * hw, c[1] - dx * hw]);
  }
  return [...left, ...right.reverse()];
}

/* A swash swells from nothing and thins toward its tail end, so it reads as a
   stroke made in one movement rather than a line drawn between two points. */
const SWASH = (t: number) => Math.sin(Math.PI * t) * (1 - t * 0.45);

/** A swallow heading right, wings raised, drawn full size on the 32 grid: the
 *  body with the near wing and the forked tail as one closed outline of cubic
 *  segments, and the far wing behind it as a second. Each outline is its start
 *  point and then `[c1, c2, end]` per segment. */
const SWALLOW: { start: Pt; segs: [Pt, Pt, Pt][] }[] = [
  {
    start: [29.8, 14.6],
    segs: [
      [[29, 13.2], [27.2, 12.4], [25.4, 12.8]],
      [[23.6, 13.2], [22, 14.2], [20.2, 15]],
      [[18.6, 10.6], [14.2, 5.8], [8.4, 3]],
      [[12.8, 7.8], [14.8, 12.4], [16.2, 15.9]],
      [[14.8, 16.2], [13.6, 16.4], [12.6, 16.6]],
      [[9.5, 16.2], [6, 15.4], [2.5, 14.8]],
      [[5.8, 16.8], [8, 17.6], [9.8, 18.1]],
      [[7.6, 19.6], [5.4, 21], [3.4, 22.4]],
      [[8, 21], [13, 19.2], [18, 18.4]],
      [[22.4, 17.8], [26.8, 17.2], [29.8, 14.6]],
    ],
  },
  {
    start: [21.2, 14.8],
    segs: [
      [[20.6, 10.8], [18.8, 7.2], [15.6, 4.4]],
      [[19.8, 6.6], [22.4, 10.2], [23.4, 14.2]],
      [[22.6, 14.4], [21.9, 14.6], [21.2, 14.8]],
    ],
  },
];

/** Where the bird stands: scaled about the frame's centre, turned, moved. */
export type Place = { s: number; dx: number; dy: number; rot: number };

function placer({ s, dx, dy, rot }: Place): (p: Pt) => Pt {
  const r = (rot * Math.PI) / 180;
  const c = Math.cos(r);
  const sn = Math.sin(r);
  return ([x, y]) => {
    const ox = x - 16;
    const oy = y - 16;
    return [16 + (ox * c - oy * sn) * s + dx, 16 + (ox * sn + oy * c) * s + dy];
  };
}

/** Each mark: the line of flight and where the bird is on it. */
export const MARK: Record<Dir, { swash: Pt[]; bird: Place }> = {
  /* Down from the top left; the bird at the foot of it, nose lifted to land. */
  in: {
    swash: [[1.5, 1.5], [3, 9], [7, 15], [13.5, 18.6]],
    bird: { s: 0.66, rot: -12, dx: 6, dy: 6.5 },
  },
  /* Up from the bottom left; the bird past its end, climbing to the top right.
     The stroke runs the other way round, so it is thickest where it leaves the
     ground and runs out toward the bird. */
  out: {
    swash: [[2, 30.5], [6, 28], [10, 25], [13.6, 19.6]],
    bird: { s: 0.66, rot: -38, dx: 6, dy: -6 },
  },
};

/** The two filled pieces of a mark, as outlines of points — for the tests,
 *  which ask about where things are rather than about a string. The bird's
 *  points are its segment ends and control points, which bound it. */
export function piecesOf(dir: Dir): { swash: Pt[]; bird: Pt[] } {
  const m = MARK[dir];
  const prof = dir === "in" ? SWASH : (t: number) => SWASH(1 - t);
  const at = placer(m.bird);
  return {
    swash: brush(m.swash, 2.1, prof),
    bird: SWALLOW.flatMap((o) => [o.start, ...o.segs.flat()]).map(at),
  };
}

const xy = ([x, y]: Pt) => `${r1(x)} ${r1(y)}`;

function pathOf(dir: Dir): string {
  const prof = dir === "in" ? SWASH : (t: number) => SWASH(1 - t);
  const swash = "M" + brush(MARK[dir].swash, 2.1, prof).map(xy).join("L") + "Z";
  const at = placer(MARK[dir].bird);
  const bird = SWALLOW.map(
    (o) => `M${xy(at(o.start))}` + o.segs.map((s) => `C${s.map((p) => xy(at(p))).join(" ")}`).join("") + "Z",
  ).join("");
  return swash + bird;
}

/** The `d` of each mark, on a 32-unit frame, filled. */
export const RELAY_MARKS: Record<Dir, string> = { in: pathOf("in"), out: pathOf("out") };
