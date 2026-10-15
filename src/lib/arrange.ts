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

/** One screen, in physical pixels, as a monitor describes itself. */
export type Screen = { x: number; y: number; w: number; h: number; scale?: number };

/** A known arrangement: its fingerprint, its shape, and when it was last in
 *  front of somebody — which is the tie-break when two are equally alike. */
export type Known = { key: string; screens: Screen[]; seenAt?: number };

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
 *  other. Everything else is absorbed where the glass is drawn — `glassAt`
 *  clamps a spot onto whatever pane it lands on, which is the same bargain a
 *  narrower window already strikes.
 *
 *  Readable, and unable to collide with a `fingerprint`, which always starts
 *  with a size. */
export const ONE_LANDSCAPE = "one landscape screen";
export const ONE_PORTRAIT = "one portrait screen";

/** Which room the glass is in: every screen's shape while spread, and only the
 *  window's own screen's orientation otherwise.
 *
 *  **Spread, nothing about which monitor is which may reach the key** — not
 *  which is the Windows primary (that only moves the desktop's origin, which
 *  `normalise` takes out), and not which one the window was spread from (that
 *  is where the chrome goes, and nothing the monitors report). `NO_ARRANGEMENT`
 *  for a set with nothing usable in it, as `fingerprint` answers. */
export function roomKey(screens: Screen[], spread: boolean): string {
  if (spread) return fingerprint(screens);
  /* One screen is all `look` hands over unspread; the first of a canonical
     order if somebody hands over more, so the answer still cannot depend on
     the order they arrived in. */
  const [one] = normalise(screens);
  if (!one) return NO_ARRANGEMENT;
  return one.h > one.w ? ONE_PORTRAIT : ONE_LANDSCAPE;
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
