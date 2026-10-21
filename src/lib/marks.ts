/* The marks a relay wears: a flock landing, and a flock taking off.
 *
 * The arrows they replace said the wrong thing twice. They were not anything —
 * a chevron is the chrome of every app ever made — and the one on a received
 * message pointed *out*, left, so a message arriving read as one leaving (Lyss,
 * 2026-10-21: "something that evokes a bird landing coming from top left for
 * received, and something evoking bird taking off going top right for sent").
 * A volery is a flock in flight, so the mark is one: three gulls in ink, and
 * **the biggest bird leads**, which is what makes it read as movement rather
 * than as a pattern — on a message received it is the one nearest the bottom
 * right, arriving; on one sent it is the one furthest up and right, already
 * gone (her correction to the first drawing, which had it trailing).
 *
 * Ink rather than line. Two rounds of single-weight icons were turned down as
 * plain; what was chosen is a brush: each wing a stroke that swells from a fine
 * tip to its full width at the shoulder, so a bird is two crescents meeting
 * under its body. That is why this is a module of its own beside `icons.ts`
 * rather than two more entries in its table — those are 16-unit strokes
 * `Icon.svelte` draws with `stroke`, these are filled outlines on a 32 grid
 * that `RelayMark.svelte` draws with `fill`, and a shape list that could be
 * either would be a shape list nobody can draw without asking which.
 *
 * Computed, not pasted. The outlines are a few hundred coordinates each, and a
 * table of them would be the one thing in the codebase nobody could change: the
 * geometry below is the drawing, and the numbers are what it costs to run once
 * at module load. Pure — no runes — so `test/marks.test.ts` can hold the
 * properties that make it read: three birds, inside the frame, the leader
 * biggest and where the movement is going. */

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

/** Where a bird stands: scaled about the frame's centre, turned, moved. */
export type Place = { s: number; dx: number; dy: number; rot: number };

function place(pts: Pt[], { s, dx, dy, rot }: Place): Pt[] {
  const r = (rot * Math.PI) / 180;
  const c = Math.cos(r);
  const sn = Math.sin(r);
  return pts.map(([x, y]) => {
    const ox = x - 16;
    const oy = y - 16;
    return [16 + (ox * c - oy * sn) * s + dx, 16 + (ox * sn + oy * c) * s + dy];
  });
}

/* A wing swells from the shoulder and runs out to a fine tip — the `min` keeps
   it from opening at a point under the body, where the two would pinch. */
const WING = (t: number) => Math.pow(1 - t, 0.8) * Math.min(1, t * 6 + 0.35);

/** One gull as two wings, drawn at full size in the middle of the frame. */
export function gull(at: Place): Pt[][] {
  return [
    place(brush([[16, 17], [13.5, 10], [8, 8.5], [2.5, 12]], 3.9, WING), at),
    place(brush([[16, 17], [18.5, 10], [24, 8.5], [29.5, 12]], 3.9, WING), at),
  ];
}

/** The three birds of each mark, far to near along the line of flight: the
 *  last is the leader and the largest. Received comes down from the top left;
 *  sent climbs to the top right. Each bird banks a little into the line. */
export const FLOCK: Record<Dir, readonly Place[]> = {
  in: [
    { s: 0.3, dx: -10, dy: -10, rot: 12 },
    { s: 0.42, dx: -3.4, dy: -2.4, rot: 10 },
    { s: 0.58, dx: 6.6, dy: 7.6, rot: 8 },
  ],
  out: [
    { s: 0.3, dx: -10, dy: 10, rot: -12 },
    { s: 0.42, dx: -3.4, dy: 2.4, rot: -10 },
    { s: 0.58, dx: 6.6, dy: -7.6, rot: -8 },
  ],
};

function pathOf(outlines: Pt[][]): string {
  return outlines.map((o) => "M" + o.map(([x, y]) => `${r1(x)} ${r1(y)}`).join("L") + "Z").join("");
}

/** Every outline of a mark, bird by bird — for the tests, which ask about the
 *  birds rather than about a string. */
export function birdsOf(dir: Dir): Pt[][][] {
  return FLOCK[dir].map(gull);
}

/** The `d` of each mark, on a 32-unit frame, filled. */
export const RELAY_MARKS: Record<Dir, string> = {
  in: pathOf(birdsOf("in").flat()),
  out: pathOf(birdsOf("out").flat()),
};
