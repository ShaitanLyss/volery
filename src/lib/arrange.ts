/* Screen arrangements: the shape of the room the glass lives in.
 *
 * Where you put something on the glass is a fact about the screens in front of
 * you, and the wall has two quite different sets of them. Unspread, the glass
 * is one screen's worth of window. Spread (`span.ts`), it is every monitor at
 * once — which is not the same room with more furniture in it, it is a
 * different room, and an arrangement made for one of them read back in the
 * other is a pile in the corner. So a glass spot is stored *per arrangement*,
 * and this file is the whole of what an arrangement is and which known one a
 * new one is most like.
 *
 * **It is about disposition and orientation, not about which monitor is which.**
 * Two 1920×1080 panels side by side are the same arrangement whoever made them,
 * and the same two with the left one turned portrait are not. So the rects are
 * normalised to their own top-left and sorted before anything is said about
 * them: nothing here can see a monitor's name, its handle, or where the set as
 * a whole sits in the desktop's coordinates.
 *
 * Physical pixels throughout, because that is the unit a monitor is described
 * in (`window.rs` makes the same argument about `window_frame`) and the one
 * thing about a screen that does not change when the page is zoomed. The scale
 * factor rides along in the fingerprint but takes no part in the similarity:
 * the same desk at 100% and at 150% is the same *shape*, so one should be
 * seeded from the other — and still be its own arrangement, since every spot
 * on the glass is in CSS pixels and those two rooms are different sizes.
 *
 * Pure — no runes, no Tauri, no DOM — so all of it is tested directly.
 */

/** One screen, in physical pixels, as a monitor describes itself.
 *
 *  `work` is the part of it a maximised window gets — the screen less the
 *  taskbar — and is only ever read for the one screen the glass is on
 *  (`frameOf`). It is in nothing that names or compares a screen: moving the
 *  taskbar is not a different screen. */
export type Screen = {
  x: number;
  y: number;
  w: number;
  h: number;
  scale?: number;
  work?: { w: number; h: number };
};

/** A known arrangement: its fingerprint, its shape, and when it was last in
 *  front of somebody — which is the tie-break when two are equally alike —
 *  and, for a room on one screen, the pane its spots are laid out in. `null`
 *  for a spread room and for every room stored before frames were. */
export type Known = { key: string; screens: Screen[]; seenAt?: number; frame?: Frame | null };

/** A pane's size, in CSS pixels. */
export type Frame = { w: number; h: number };

/** The arrangement nothing has been stored against yet.
 *
 *  Not a valid fingerprint — `fingerprint` never returns it, because it always
 *  has at least one rect to say something about — so it cannot collide with a
 *  real one. It is what the front end has before the monitors have answered,
 *  and asking the store to adopt it is a no-op rather than an error. */
export const NO_ARRANGEMENT = "";

/** The screens, moved to their own origin, rounded, and put in one order.
 *
 *  The three things that make this *disposition* rather than *these monitors*.
 *  Rounding first and translating second, so a desktop whose origin is at a
 *  fractional offset cannot leave a 1px difference behind in every rect.
 *
 *  Degenerate rects are dropped: a monitor reporting zero in either dimension
 *  is a monitor mid-handshake, and letting one into the fingerprint would make
 *  a transient state its own arrangement — with its own copy of the whole
 *  glass, left behind for ever once the real answer arrived. */
export function normalise(screens: Screen[]): Screen[] {
  const live = screens
    .map((s) => ({
      x: Math.round(s.x),
      y: Math.round(s.y),
      w: Math.round(s.w),
      h: Math.round(s.h),
      scale: s.scale,
    }))
    .filter((s) => s.w > 0 && s.h > 0);
  if (!live.length) return [];
  const ox = Math.min(...live.map((s) => s.x));
  const oy = Math.min(...live.map((s) => s.y));
  return live
    .map((s) => ({ ...s, x: s.x - ox, y: s.y - oy }))
    /* Total, down to the scale: two monitors on the same rect (a duplicated
       display) differing only in scale would otherwise keep whatever order
       they were enumerated in, and the fingerprint would follow it. */
    .sort(
      (a, b) =>
        a.y - b.y || a.x - b.x || a.w - b.w || a.h - b.h || Number(scaleOf(a)) - Number(scaleOf(b)),
    );
}

/** Two decimals, as a string, with no exponent and no negative zero. Scale
 *  factors are 1, 1.25, 1.5, 1.75, 2 in practice; a float straight into a
 *  primary key is the sort of thing that works until it does not. */
function scaleOf(s: Screen): string {
  const k = typeof s.scale === "number" && Number.isFinite(s.scale) && s.scale > 0 ? s.scale : 1;
  return (Math.round(k * 100) / 100).toFixed(2);
}

/** What identifies an arrangement, as one short string.
 *
 *  Readable on purpose — it is a primary key in SQLite and the thing anybody
 *  debugging this will be looking at — and total: every arrangement with at
 *  least one live screen in it gets one, and no two different shapes share one.
 *  `NO_ARRANGEMENT` for a set with nothing usable in it, which is the one case
 *  that must not be given a key of its own. */
export function fingerprint(screens: Screen[]): string {
  const ns = normalise(screens);
  if (!ns.length) return NO_ARRANGEMENT;
  return ns.map((s) => `${s.w}x${s.h}+${s.x}+${s.y}@${scaleOf(s)}`).join(" ");
}

/** The room one screen's worth of window is in, whichever screen that is.
 *
 *  Unspread, the glass is the window and the window is on one screen. Which
 *  one, how big it is, its scale, and how many others are plugged in beside it
 *  are all facts about the *desk*, and none of them is a fact about the room:
 *  Volery on the laptop panel alone and Volery on the same panel with two more
 *  monitors attached is the same window in front of the same person. It was
 *  keyed on `fingerprint` of that one screen — its exact size and scale — so
 *  the laptop panel and the external one beside it were two rooms with two
 *  glasses, each going stale while you worked in the other, and "my glass did
 *  not carry" was the whole of what anybody could see of it.
 *
 *  Orientation is the one thing kept, because it is the one thing that makes a
 *  different room: a portrait pane is tall where a landscape one is wide, and
 *  an arrangement made for one is a column squeezed against the edge of the
 *  other. A different size is the same room *scaled*: every spot keeps its
 *  share of the pane when the screen under it changes (`framePlan`, and
 *  `arrange.rs::travel` for the arithmetic), and `glassAt`'s clamp is left to
 *  catch only what cannot fit at all.
 *
 *  Readable, and unable to collide with a `fingerprint`, which always starts
 *  with a size. */
export const ONE_LANDSCAPE = "one landscape screen";
export const ONE_PORTRAIT = "one portrait screen";

/** Whether one screen's glass is one layout for every screen of its shape,
 *  scaled to each — or one layout per screen size, in pixels.
 *
 *  Both are wanted, and the person who wants them said why: one glass that
 *  follows you between screens is the point, and on a bigger screen you may
 *  want more on it, or the same things put elsewhere. So it is a choice, one
 *  for the whole wall, and **scaled** unless somebody says otherwise.
 *
 *  The two are two *rooms* rather than two readings of one, which is what
 *  makes the switch lossless: flipping it selects which room's spots are
 *  drawn, and converts nothing. Going to per-size and back finds the scaled
 *  glass exactly as it was left, because nothing touched it in between. */
export type GlassScale = "scaled" | "per-size";

/** Where the choice is kept. Per machine, like the other settings the ground
 *  menu carries — it is about the screens on this desk. */
export const GLASS_SCALE_KEY = "skein.glass-scale";

/** A stored value, made into the setting. Anything but `"per-size"` is scaled,
 *  so a machine never asked gets the default and a value written by a newer
 *  build degrades to it rather than to nothing — `reawakenFor`'s bargain. */
export function glassScaleFor(stored: unknown): GlassScale {
  return stored === "per-size" ? "per-size" : "scaled";
}

/** The ground menu's two rows: what each one does, not a knob's name. */
export const GLASS_SCALES: { id: GlassScale; label: string }[] = [
  { id: "scaled", label: "one glass, scaled to fit any screen" },
  { id: "per-size", label: "a glass of its own for each screen size" },
];

/** What the chord says it has just made true (`<space> w g`). The glass may
 *  well not move at all — on a screen it was laid out on, both rooms hold the
 *  same thing — so the line says what will happen next time rather than
 *  leaving a flip nobody could see. */
export function glassScaleSaid(scale: GlassScale): string {
  return scale === "scaled"
    ? "one glass for every screen — scaled to fit whichever screen it is on"
    : "each screen size keeps a glass of its own — what you arrange here stays here";
}

/** Which room the glass is in: every screen's shape while spread, and only the
 *  window's own screen's orientation otherwise — or, per size, its exact size
 *  and scale.
 *
 *  **Spread, nothing about which monitor is which may reach the key** — not
 *  which is the Windows primary (that only moves the desktop's origin, which
 *  `normalise` takes out), and not which one the window was spread from (that
 *  is where the chrome goes, and nothing the monitors report). `NO_ARRANGEMENT`
 *  for a set with nothing usable in it, as `fingerprint` answers.
 *
 *  **Per size puts the size back, and only the size.** Which screen, how many
 *  and which is primary still reach nothing; the panel and the monitor beside
 *  it become two rooms again because that is what was asked for. Spelt apart
 *  from the per-monitor keys walls carried before orientation-only rooms
 *  (`1920x1200+0+0@1.50`): those rows are this morning's glass, and the first
 *  flip should find the glass you have rather than revive one from then. The
 *  spread key is not touched by the choice at all — a desk is a shape. */
export function roomKey(screens: Screen[], spread: boolean, scale: GlassScale = "scaled"): string {
  if (spread) return fingerprint(screens);
  /* One screen is all `look` hands over unspread; the first of a canonical
     order if somebody hands over more, so the answer still cannot depend on
     the order they arrived in. */
  const [one] = normalise(screens);
  if (!one) return NO_ARRANGEMENT;
  if (scale === "per-size") return `one screen ${one.w}x${one.h}@${scaleOf(one)}`;
  return one.h > one.w ? ONE_PORTRAIT : ONE_LANDSCAPE;
}

/** The one screen's size, and nothing about where it is. Two answers equal
 *  is "the same screen" as far as a glass can tell — the screen's own size
 *  and scale, which is what a frame is a share of. */
export function screenOf(screens: Screen[]): string {
  return screens.length === 1 ? fingerprint(screens) : NO_ARRANGEMENT;
}

/** A screen in CSS pixels, which is what everything on the glass is in. */
function cssOf(s: Screen): Frame {
  const k = typeof s.scale === "number" && Number.isFinite(s.scale) && s.scale > 0 ? s.scale : 1;
  return { w: s.w / k, h: s.h / k };
}

function sane(f: Frame | null | undefined): f is Frame {
  return !!f && Number.isFinite(f.w) && Number.isFinite(f.h) && f.w > 0 && f.h > 0;
}

/** The pane the glass has on this screen, as a share of which its spots are
 *  laid out — in CSS pixels.
 *
 *  **The screen's, not the window's.** It is the work area — the screen less
 *  the taskbar, which is what a maximised window gets — less `chrome`, which is
 *  whatever the window draws that the pane is not: the title bar and the dock
 *  *at rest* (`restChrome`). So un-maximising the window changes nothing here,
 *  and a narrower window goes on being absorbed the way it always was, by
 *  `glassAt` clamping into the pane it has; only a change of *screen*
 *  re-expresses the glass. A frame that moved with the window would make every
 *  resize slide the whole glass — and a frame that moved with the pane would
 *  make it breathe as the dock grows under a long draft.
 *
 *  Null when there is nothing sensible to say, which is never a reason to move
 *  anything. */
export function frameOf(screen: Screen | undefined, chrome: Frame): Frame | null {
  if (!screen) return null;
  const k = typeof screen.scale === "number" && Number.isFinite(screen.scale) && screen.scale > 0 ? screen.scale : 1;
  const work = screen.work && screen.work.w > 0 && screen.work.h > 0 ? screen.work : screen;
  const out = { w: work.w / k - Math.max(0, chrome.w), h: work.h / k - Math.max(0, chrome.h) };
  return sane(out) ? out : null;
}

/** A frame for a room nobody recorded one for — every room stored before
 *  frames were — off the one screen it was last seen on.
 *
 *  What a pane is short of its screen (the taskbar, the title bar, the dock) is
 *  a fact about the live window that no stored row carries, so it is taken to
 *  be what it is *now*: the live frame, moved by however much bigger or smaller
 *  that screen is than this one. Exact when the two are the same screen, and
 *  a few pixels out at worst otherwise. Null for anything that was not one
 *  screen, since a spread room's spots are not a share of any one pane. */
export function estimateFrame(was: Screen[], now: Screen, live: Frame): Frame | null {
  if (was.length !== 1) return null;
  const a = cssOf(was[0]);
  const b = cssOf(now);
  const out = { w: live.w + a.w - b.w, h: live.h + a.h - b.h };
  return sane(out) ? out : null;
}

/** The least height the window has been seen to draw besides the pane, per
 *  place the dock is moored — `bottom`, `top`, `float` — in CSS pixels.
 *
 *  What a frame subtracts from the work area, and the reason it is a memory
 *  rather than a reading: the pane is `main.wall`, which shrinks under the dock
 *  whenever the dock grows — a long draft, a question waiting in it — and a
 *  fault bar takes its share too. Read at the moment a screen changes, all of
 *  that was baked into the frame the room's spots were carried onto, and a
 *  question open at the wrong moment squeezed the whole glass three hundred
 *  pixels short for good. The chrome at rest is the *least* it ever is, so the
 *  least seen is the honest estimate of it: everything that grows only grows
 *  it. Per mooring, because a floating dock is no chrome at all and a moored
 *  one is, and a minimum carried from one to the other would be a lie about
 *  the other. Kept across launches, since the first settle of a launch is the
 *  one most likely to find something open in the dock. */
export type Chromes = Partial<Record<string, number>>;

/** Where `Chromes` are kept. Per machine, like the choice beside it. */
export const GLASS_CHROME_KEY = "skein.glass-chrome";

/** A stored set, made safe: anything but a finite, positive number is dropped,
 *  so a hand-edited or newer value degrades to "never seen" rather than to a
 *  frame built on a NaN. */
export function chromesFor(stored: unknown): Chromes {
  let v: unknown = stored;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Chromes = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n === "number" && Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

/** Fold one reading in: the chrome to frame by is the least seen at this
 *  mooring, and never more than what is measured now. A reading that is not a
 *  positive number is not a reading — the window always draws its title bar,
 *  so nothing is a pane caught mid-way out of being spread, where it covers
 *  the whole window — and leaves the memory as it was. */
export function restChrome(seen: Chromes, site: string, now: number): { chrome: number | null; seen: Chromes } {
  const was = seen[site];
  if (!(Number.isFinite(now) && now >= 1)) return { chrome: was ?? null, seen };
  if (was !== undefined && was <= now) return { chrome: was, seen };
  return { chrome: now, seen: { ...seen, [site]: now } };
}

/** Which known room a room seen for the first time is copied from.
 *
 *  `nearest` for everything but one case: a **per-size** room for a screen size
 *  never seen per size starts from the glass you have — the scaled room of its
 *  orientation, carried onto this screen — rather than from whichever stored
 *  room is the same size. On a wall that predates orientation-only rooms the
 *  same size is one of the old per-monitor rows (`1920x1200+0+0@1.50`), which
 *  scores a perfect 1 and is the glass as it stood before them: things taken
 *  off the glass since would reappear, and things put up since would be
 *  missing. Per size is "this screen keeps its own from here on", and from here
 *  on starts from what is in front of you.
 *
 *  Everything else is unchanged — including the scaled room's own first
 *  sighting, which *should* find this panel's old per-monitor row: on a wall
 *  updating straight past orientation-only rooms that row is its glass. */
export function ancestorFor(at: {
  key: string;
  screens: Screen[];
  spread: boolean;
  scale: GlassScale;
  known: Known[];
}): Known | null {
  const { key, screens, spread, scale, known } = at;
  if (!spread && scale === "per-size") {
    const shared = roomKey(screens, false, "scaled");
    const scaled = known.find((k) => k.key === shared && k.key !== key);
    if (scaled) return scaled;
  }
  return nearest(screens, known, key);
}

/** What `adopt_arrangement` is told about frames: the one to record against
 *  the room (`frame`, null for "keep what it has"), and what to carry its spots
 *  — or the copy of its ancestor's — from (`fromFrame`, `cloneFrame`, null for
 *  "they are already in this one"). */
export type FramePlan = { frame: Frame | null; fromFrame: Frame | null; cloneFrame: Frame | null };

const NO_PLAN: FramePlan = { frame: null, fromFrame: null, cloneFrame: null };

/** Whether, and from what, the glass is re-expressed as a room is adopted.
 *
 *  **Only a change of screen moves anything.** A room whose spots were laid out
 *  on the screen in front of you is in this screen's frame already, whatever
 *  the pane measures today — a dock grown under a long draft, a window not
 *  maximised — and re-expressing it off a measurement like that would creep
 *  every spot each time you came back. So the test is the screen
 *  (`screenOf`, size and scale), and the frame recorded on arrival is kept
 *  until the screen changes again.
 *
 *  A copy follows the same rule: an ancestor laid out on this very screen —
 *  which is the room you were just in, the first time the choice is flipped —
 *  arrives as it was, so flipping moves nothing. One laid out on another screen
 *  arrives scaled to this one.
 *
 *  Nothing for a spread room, whose spots are about the desk rather than a share
 *  of one pane, or before the pane has been measured. */
export function framePlan(at: {
  key: string;
  spread: boolean;
  screens: Screen[];
  live: Frame | null;
  known: Known[];
  ancestor: Known | null;
}): FramePlan {
  const { key, spread, screens, live, known, ancestor } = at;
  if (spread || screens.length !== 1 || !sane(live)) return NO_PLAN;
  const here = screenOf(screens);
  const recorded = (k: Known) => (sane(k.frame) ? k.frame : null);
  const laidOut = (k: Known) => recorded(k) ?? estimateFrame(k.screens, screens[0], live);
  const room = known.find((k) => k.key === key);
  if (room) {
    if (screenOf(room.screens) === here) {
      return { frame: recorded(room) ? null : live, fromFrame: null, cloneFrame: null };
    }
    return { frame: live, fromFrame: laidOut(room), cloneFrame: null };
  }
  if (ancestor && ancestor.key !== key) {
    if (screenOf(ancestor.screens) === here) {
      return { frame: recorded(ancestor) ?? live, fromFrame: null, cloneFrame: null };
    }
    return { frame: live, fromFrame: null, cloneFrame: laidOut(ancestor) };
  }
  return { frame: live, fromFrame: null, cloneFrame: null };
}

/** How much of the two rects is in both of them — intersection over union.
 *
 *  1 for the same rect, 0 for two that do not meet. The reason the metric is
 *  this rather than "same size" is that it answers position and size in one
 *  number, which is what makes an L-shaped desk with its portrait screen on the
 *  left score badly against the same desk with it on the right. */
function iou(a: Screen, b: Screen): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** The best pairing of two sets of rects, as a share of both of them.
 *
 *  Each screen on one side is paired with its best remaining match on the
 *  other — greedy, best pair first, so the obvious correspondences are made
 *  before the leftovers are — and the score is what that pairing covers of
 *  *both* sides. A screen with no partner costs, which is what keeps a
 *  three-screen desk from scoring a perfect match for one of its screens: an
 *  arrangement that merely contains another is not the same room. */
function pairUp(left: Screen[], right: Screen[]): number {
  const pairs: { i: number; j: number; s: number }[] = [];
  for (let i = 0; i < left.length; i++) {
    for (let j = 0; j < right.length; j++) {
      const s = iou(left[i], right[j]);
      if (s > 0) pairs.push({ i, j, s });
    }
  }
  pairs.sort((p, q) => q.s - p.s || p.i - q.i || p.j - q.j);
  const usedL = new Set<number>();
  const usedR = new Set<number>();
  let total = 0;
  for (const p of pairs) {
    if (usedL.has(p.i) || usedR.has(p.j)) continue;
    usedL.add(p.i);
    usedR.add(p.j);
    total += p.s;
  }
  /* Twice the matched weight over the two counts: a perfect pairing of equal
     sets is 1, and an unmatched screen on either side pulls it down. */
  return (2 * total) / (left.length + right.length);
}

/** How alike two arrangements are, from 0 to 1.
 *
 *  Normalising both sides to their own top-left is what makes an arrangement a
 *  shape rather than a place on the desktop — but it is *not* enough to compare
 *  two shapes by, and trusting it got the first version of this wrong. Drop a
 *  screen from the L-shaped desk and the remaining two slide to a new origin,
 *  so nothing lines up with where it was and the two-screen room scored better
 *  against a single laptop panel than against the desk it is literally part of.
 *
 *  So the comparison tries every alignment that puts one screen of each side on
 *  top of the other and keeps the best — which is translation-invariant for the
 *  same reason normalising is, and additionally finds the correspondence rather
 *  than assuming the origins are it. At most six screens a side, so the cost of
 *  being right here is nothing anybody can measure.
 *
 *  Both sides are normalised first, so a caller holding raw monitor rects
 *  cannot get a wrong answer quietly. */
export function similarity(a: Screen[], b: Screen[]): number {
  const left = normalise(a);
  const right = normalise(b);
  if (!left.length || !right.length) return 0;
  let best = 0;
  for (const anchorL of left) {
    for (const anchorR of right) {
      const dx = anchorL.x - anchorR.x;
      const dy = anchorL.y - anchorR.y;
      const shifted = right.map((s) => ({ ...s, x: s.x + dx, y: s.y + dy }));
      const score = pairUp(left, shifted);
      if (score > best) best = score;
    }
  }
  return best;
}

/** Which known arrangement a new one should be copied from.
 *
 *  "Duplicated from the most similar setup when a new one is identified" — so
 *  the first time you spread over the desk, the glass you had arranged on one
 *  screen is what you find there, rather than an empty pane. Null when there is
 *  nothing to copy from at all, which is the genuinely first run and is the
 *  store's business rather than this file's.
 *
 *  Ties go to whichever was in front of you most recently, then to the key, so
 *  the answer is stable across calls rather than depending on the order the
 *  rows came back in. A score of zero is still an answer: two arrangements that
 *  share no geometry at all are still more use as a starting point than a blank
 *  pane, and every spot gets clamped onto the pane it lands on anyway.
 *
 *  `key` is the room being furnished, which is never its own ancestor. It is
 *  `roomKey`'s answer rather than `fingerprint`'s: unspread they differ, and
 *  the one-screen rooms a wall stored under the old per-monitor keys are
 *  exactly what a first sighting of `ONE_LANDSCAPE` should be copied from — the
 *  one whose screen *is* this one scores 1, so the glass you had survives the
 *  key it was stored under changing. */
export function nearest(to: Screen[], among: Known[], key: string = fingerprint(to)): Known | null {
  let best: Known | null = null;
  let bestScore = -1;
  for (const k of among) {
    if (k.key === key) continue;
    const s = similarity(to, k.screens);
    if (
      s > bestScore ||
      (s === bestScore &&
        best !== null &&
        ((k.seenAt ?? 0) > (best.seenAt ?? 0) ||
          ((k.seenAt ?? 0) === (best.seenAt ?? 0) && k.key < best.key)))
    ) {
      best = k;
      bestScore = s;
    }
  }
  return best;
}
