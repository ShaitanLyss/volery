/* What each core of this machine is doing, as a thing you can look at.
 *
 * The performance meter one file over answers *what is costing me this* — a row
 * per thing on the wall, its whole process tree folded into it. This answers a
 * different question and deliberately knows nothing about processes: **is the
 * machine busy, and is it busy everywhere or in one place.** A build pinned to
 * one core and a build using twelve read identically on a single number and are
 * two different afternoons.
 *
 * Task Manager is the reference, and what is taken from it is its *information
 * design* and none of its look: one small graph per core, a grid that reflows as
 * the box changes, one shared vertical scale so the cores are comparable at a
 * glance, and the newest sample at the right. What is not taken is the saturated
 * green fill on a printed grid — this wall is achromatic and **colour is
 * reserved for status** (celadon working, amber asking, rust failed). A core at
 * 90% is not a failure and must not be drawn as one, so a lane is ink and the
 * only thing that varies is how much of it there is.
 *
 * ### The history, and why it is stamped rather than counted
 *
 * The samples come off the one shared `Meter` — the same poller the performance
 * widget uses, at the same two-second tick, and nothing here opens a second one.
 * That poller is bounded by attachment (one sampler however many readers,
 * started by the first that asks and stopped by the last that stops), so a wall
 * with none of these on it costs nothing at all, and this file inherits the
 * whole of that argument by not having an argument of its own.
 *
 * Each reading is kept with the instant it was taken, and every span below is a
 * duration rather than a number of samples. That costs one field and buys three
 * things:
 *
 * - **A skipped tick draws as a gap**, because x is a function of age. A graph
 *   that spaced samples evenly would quietly redraw a stall as a healthy line.
 * - **Nothing here has to know the meter's interval.** A span in samples would
 *   be a label saying "the last minute" that becomes a lie the day `EVERY`
 *   changes, in a different file, for an unrelated reason.
 * - **A meter that stopped and started again cannot glue the two together**,
 *   since the old readings are simply too old to be inside the span.
 *
 * `KEEP` is the memory bound and is a count, because that is what memory is
 * measured in: sixteen cores at 240 readings is under four thousand floats,
 * which is the size of a small image and is held for as long as somebody is
 * looking at a widget.
 *
 * Pure — no runes, no DOM. `meter.svelte.ts` folds the samples in and
 * `Cores.svelte` draws them. */

/** One reading of every core, and when it was taken. */
export type Reading = { at: number; load: number[] };

/** How many readings are kept, whatever they span.
 *
 * The bound is on memory rather than on time, so it has to hold for the longest
 * span offered: 240 readings at the meter's two-second tick is eight minutes,
 * comfortably past the five the longest span asks for, and a tick that slows
 * down makes the ring cover *more* time rather than less. */
export const KEEP = 240;

/** Add a reading, and drop whatever no longer fits.
 *
 * Returns a new array rather than mutating: the holder keeps this in a
 * `$state.raw`, and reassignment is the dependency. A `$state` deep proxy over
 * an array of arrays would be a proxy per reading per tick for data nothing
 * ever writes to.
 *
 * A reading with no cores in it is refused. That is what an empty `per_core`
 * from an older build looks like, and a lane of zeroes drawn from one would be
 * this widget reporting an idle machine it never actually read. */
export function add(history: Reading[], at: number, load: number[]): Reading[] {
  if (!load.length) return history;
  const next = [...history, { at, load: load.map(clampPct) }];
  return next.length > KEEP ? next.slice(next.length - KEEP) : next;
}

function clampPct(v: number): number {
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0;
}

/* ── how far back it goes ──────────────────────────────────────────────── */

/** The spans on offer, as durations.
 *
 * Two, not four. A menu is a poor slider (the catalogue's own rule) and these
 * are two genuinely different readings rather than two speeds: a minute is what
 * a core is doing *now*, five minutes is whether the build has been going the
 * whole time. Anything between them is the same picture slightly wider. */
export const SPANS: { value: string; label: string; ms: number }[] = [
  { value: "minute", label: "the last minute", ms: 60_000 },
  { value: "long", label: "the last five minutes", ms: 5 * 60_000 },
];

export const DEFAULT_SPAN = "minute";

export function spanOf(value: string): number {
  return (SPANS.find((s) => s.value === value) ?? SPANS[0]).ms;
}

/* ── the reading ───────────────────────────────────────────────────────── */

/** How many cores the history is about — the newest reading's, since that is
 *  the only one that is certainly about this machine as it is now. Zero for a
 *  history with nothing in it, which is a widget that has not been sampled yet
 *  and draws a sentence rather than a grid. */
export function coreCount(history: Reading[]): number {
  return history.length ? history[history.length - 1].load.length : 0;
}

/** Every core's current load, or an empty list before the first sample. */
export function currentOf(history: Reading[]): number[] {
  return history.length ? history[history.length - 1].load : [];
}

/** One point of a lane, in a 0–100 box: `x` runs left to right with **now at
 *  the right edge**, `y` is the load. Not flipped for SVG here — the drawing
 *  owns which way is up, and a y that meant "down the screen" in a pure file
 *  would be this module knowing about screens. */
export type Point = { x: number; y: number };

/** One core's history across the span, oldest first.
 *
 * x is age, so a reading taken thirty seconds into a one-minute span sits at
 * the halfway mark whatever else did or did not arrive. A partial history
 * therefore fills the *right* of the box and leaves the left empty, which is
 * exactly what a graph that has only been running for ten seconds should look
 * like — and is what Task Manager does on the same evidence. */
export function laneOf(
  history: Reading[],
  core: number,
  span: number,
  now: number,
): Point[] {
  const out: Point[] = [];
  for (const r of history) {
    const age = now - r.at;
    if (age < 0 || age > span) continue;
    const v = r.load[core];
    if (v === undefined) continue;
    out.push({ x: 100 - (age / span) * 100, y: v });
  }
  return out;
}

/** The machine as a whole, over the same span — the mean of the cores in each
 *  reading rather than a figure taken separately, so the total and the lanes
 *  under it can never disagree about a moment. */
export function meanLaneOf(history: Reading[], span: number, now: number): Point[] {
  const out: Point[] = [];
  for (const r of history) {
    const age = now - r.at;
    if (age < 0 || age > span || !r.load.length) continue;
    out.push({ x: 100 - (age / span) * 100, y: mean(r.load) });
  }
  return out;
}

/** The busiest core in each reading, drawn behind the mean.
 *
 * The whole of what a single-figure CPU reading cannot say. A machine at 25%
 * with one core pinned and a machine at 25% spread over eight are the same
 * number and different problems, and the gap between these two lines is which
 * one you are looking at. */
export function peakLaneOf(history: Reading[], span: number, now: number): Point[] {
  const out: Point[] = [];
  for (const r of history) {
    const age = now - r.at;
    if (age < 0 || age > span || !r.load.length) continue;
    out.push({ x: 100 - (age / span) * 100, y: Math.max(...r.load) });
  }
  return out;
}

export function mean(load: number[]): number {
  return load.length ? load.reduce((n, v) => n + v, 0) / load.length : 0;
}

/** Which core is working hardest, or null for a machine that is doing nothing
 *  worth pointing at. The floor is what stops the label wandering between four
 *  cores at 0.3% while the machine is idle — a busiest core is only news when
 *  there is something to be busy about. */
export function busiest(load: number[]): number | null {
  let at = -1;
  let most = BUSY_FLOOR;
  load.forEach((v, i) => {
    if (v > most) {
      most = v;
      at = i;
    }
  });
  return at < 0 ? null : at;
}

const BUSY_FLOOR = 8;

/** A percentage, in the register the rest of the wall prints one.
 *
 * Whole numbers: a core reading `37.4%` is four characters of noise in a cell
 * thirty pixels wide, and the sample it came from is a two-second average of
 * something that changes a thousand times a second. `perf.ts::pct` is the same
 * judgement for a different denominator. */
export function say(v: number): string {
  return `${Math.round(clampPct(v))}%`;
}

/* ── the grid ──────────────────────────────────────────────────────────── */

/** How a box of this shape divides into `n` cells.
 *
 * The reflow, which is the half of Task Manager's design worth taking: sixteen
 * lanes are 4×4 in a square widget, 8×2 in a wide one and 2×8 in a tall one,
 * and you never choose which — the box you drag it to is the setting, the same
 * rule `rowsFor` and `linesFor` already answer to.
 *
 * Cells are wanted a little wider than tall (`AIM`), because a lane is a time
 * series and a time series in a narrow column is a squiggle. Ties go to the
 * arrangement with fewer empty cells: 6 cores in a square box is 3×2 rather
 * than 4×2 with two holes in it.
 *
 * A box too small for legible cells is answered honestly rather than by
 * shrinking them further — `FLOOR` is the smallest cell that still reads as a
 * graph, and past it the face draws the bars variant's question instead of
 * pretending. That decision is the caller's; what this returns is how few
 * columns it would take. */
const AIM = 1.5;
const FLOOR = { w: 26, h: 18 };

export function gridOf(n: number, w: number, h: number): { cols: number; rows: number } {
  if (n <= 0 || w <= 0 || h <= 0) return { cols: 1, rows: 1 };
  let best = { cols: 1, rows: n };
  let score = Infinity;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = w / cols;
    const ch = h / rows;
    if (cw < FLOOR.w || ch < FLOOR.h) continue;
    /* Two terms: how far the cell is from the shape a lane wants, and how many
       holes the arrangement leaves. The second is small on purpose — it breaks
       ties and does not overrule a genuinely better shape. */
    const shape = Math.abs(Math.log(cw / ch / AIM));
    const holes = (cols * rows - n) * 0.08;
    if (shape + holes < score) {
      score = shape + holes;
      best = { cols, rows };
    }
  }
  return best;
}

/** Whether a grid of `n` lanes can be drawn in this box at all.
 *
 * The bars variant is the answer when it cannot: one lane per core with no
 * history is legible at a fraction of the size, because a bar needs a height
 * and a graph needs a width as well. Said out loud rather than silently
 * degrading, so a widget dragged small does not look like one that has
 * broken. */
export function fits(n: number, w: number, h: number): boolean {
  const g = gridOf(n, w, h);
  return g.cols * g.rows >= n && w / g.cols >= FLOOR.w && h / g.rows >= FLOOR.h;
}

/* ── drawing ───────────────────────────────────────────────────────────── */

/** A lane as an SVG polyline, in a 0–100 viewBox with y flipped for the screen.
 *
 * `INSET` is why this is here rather than inline in the component: a flat lane
 * at 0 drawn at exactly y=100 loses its lower half to the clip and reads as a
 * hairline that has been cut, which looks like a rendering fault rather than
 * like an idle core. `Speedo.svelte` learned the same at 216×196 and set it to
 * two.
 *
 * **Five here, and the difference is the cell size rather than taste.** These
 * lanes are drawn `preserveAspectRatio="none"` into cells about thirty pixels
 * tall, so a unit of the viewBox is a third of a pixel and Speedo's two units
 * are 0.6px — less than half of the 1.2px non-scaling stroke, so a core at 100%
 * had the top half of its line clipped away and read as a *filled block* rather
 * than as a lane against its ceiling. Seen in a render of sixteen cores under
 * load, not reasoned about. Five units is a pixel and a half at that size,
 * which is enough for the line to sit on the ceiling rather than disappear into
 * it, and is still under a twentieth of the scale. */
export const INSET = 5;

export function polyline(points: Point[]): string {
  return points
    .map((p) => `${p.x.toFixed(2)},${(100 - INSET - (p.y / 100) * (100 - 2 * INSET)).toFixed(2)}`)
    .join(" ");
}

/** The same lane closed down to the baseline, so the area under it can be
 *  filled. A load is a proportion of a thing and the filled area is how much of
 *  it there was, which a bare line does not say — and it is what makes a wall of
 *  sixteen small graphs readable at a glance rather than sixteen squiggles. */
export function area(points: Point[]): string {
  if (points.length < 2) return "";
  const base = (100 - INSET).toFixed(2);
  const first = points[0].x.toFixed(2);
  const last = points[points.length - 1].x.toFixed(2);
  return `${first},${base} ${polyline(points)} ${last},${base}`;
}
