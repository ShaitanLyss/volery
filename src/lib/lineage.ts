/* The root a spawned card stands on.
 *
 * `spawn.rs` records parentage in a table that is never swept, because the value
 * of a lineage is answering "was this opened by an agent" months later. Until
 * now nothing drew it: `spawned_by` was a command with no reader, and a card an
 * agent had opened looked exactly like one you opened yourself.
 *
 * ### Why a standing line is honest here, when `flow.ts` refuses one
 *
 * `relay.md` is explicit that a *message* must not be drawn as a wire: a line
 * between two cards claims a relationship, and a message is an event. That
 * argument is the reason a strand exists only while light is travelling on it.
 *
 * Parentage is the case it excludes. It **is** a relationship — a row written
 * before the child exists and kept after both cards are closed — so a mark that
 * stays is the truth about the wall rather than a decoration on it. The two
 * drawings are deliberately not the same shape, and the difference is legible
 * as depth:
 *
 * - **A relay strand is light in the air**, braided, celadon, transient, and
 *   drawn *above* the cards (`Flow.svelte`, `z-index: 3`).
 * - **A root is in the ground**, opaque, achromatic, permanent, and drawn
 *   *behind* them — a sibling of `Backdrop` inside `.surface`, under the whole
 *   transformed wall.
 *
 * So above the cards is traffic and below them is structure. Nothing had to be
 * said in prose for that to read; it is the layer order.
 *
 * ### Colour is status, so the root has none
 *
 * `tokens.css` reserves colour for status — celadon working, amber asking, rust
 * failed — and parentage is not a status: it is as true of a card that finished
 * yesterday as of one streaming now. So the root is drawn in `--edge`, the tone
 * the wall's own furniture is drawn in, and it is the one thing on the wall that
 * is *structural* rather than either chrome or status.
 *
 * The moving light people reach for first — an arc, a spark, electricity — is
 * available only by making it mean something, and there is exactly one thing it
 * can honestly mean: **a charge runs a root only while that child is working**,
 * in `--st-work`, because that is work moving between two cards and it is the
 * colour this wall already spends on it. At rest the root does not move at all,
 * which is also what keeps a permanent mark from becoming permanent motion.
 *
 * ### One trunk, forking
 *
 * A card may have four children, and since `spawn` grew a `project` argument
 * they can be in four different territories — so four independent strands from
 * one card is a real prospect and it is spaghetti. What is drawn instead is a
 * trunk that forks:
 *
 * - **Children are clustered by bearing** (`clusters`). One cluster is one
 *   trunk. Two children east and one west is two trunks out of two edges of the
 *   card, rather than one meaningless mean direction with a limb doubling back
 *   along it.
 * - **A cluster's limbs share their first control point** (`fork`), so every
 *   one of them leaves the card along the same tangent and separates smoothly.
 *   The trunk is therefore *emergent*: no trunk geometry is computed anywhere,
 *   the limbs simply coincide until they don't.
 * - **They are filled as one path**, so the coincident part unions into a single
 *   shape instead of stacking alpha. That is also why the base widens with the
 *   number of children — a fatter trunk splitting into thin branches is the
 *   whole reading, and it is lost if the trunk is exactly one limb wide.
 * - **Direction needs no arrowhead**: the taper is monotonic, thick where the
 *   work came from and a hair where it arrived.
 *
 * Everything here is pure and in screen pixels. `Lineage.svelte` owns the
 * canvas and the clock and decides nothing.
 */

import {
  centreOf,
  ease,
  pointOn,
  rimPoint,
  samples as curveSamples,
  seatDepth,
  tangentOn,
  type Box,
  type Pt,
} from "./flow";

/** One recorded parentage. `born` is set only for a card opened in *this*
 *  session, and it is what the growth animation is timed off — a wall restored
 *  from disk draws its roots already grown, because they were. */
export type Kin = { parent: string; child: string; born?: number | null };

/** A card and where it is, in screen pixels. */
export type Kid = { id: string; box: Box; born?: number | null };

/* ── the knobs ─────────────────────────────────────────────────────────────
 *
 * Screen pixels, like `flow.ts`, but the *widths* are scaled by the wall's zoom
 * and clamped at both ends — which is a deliberate departure from a strand and
 * the one place the two disagree. A strand keeps its width at every zoom
 * because it is light crossing a room. A root is a thing on the ground beside
 * the cards, so at `field` density a 6px trunk against a 60px card reads as a
 * cable somebody left on the wall; and at no zoom may it thin to nothing, or
 * the structure disappears exactly when you zoom out to see it.
 */

/** Half-width where the root leaves the parent, at 1:1. */
export const BASE = 5.5;
/** Half-width where it reaches the child. Never zero: a limb that came to a
 *  point would flicker in and out along its last few pixels as the wall moves. */
export const TIP = 1.1;
export const BASE_MIN = 1.6;
export const TIP_MIN = 0.6;
/** What each child past the first adds to the shared base, so the fork reads. */
export const PER_CHILD = 0.2;

/* ── under the card ────────────────────────────────────────────────────────
 *
 * A limb is a filled polygon (`outline`), so it closes with a flat chord at each
 * end — perpendicular to the tangent there, `2 × base` across at the parent and
 * `2 × tip` at the child. Roots are drawn *behind* the cards, so a chord inside
 * a card's footprint is invisible and one outside it is a sliced tab lying on
 * the ground: the taper says "this comes out from under the card" and the cut
 * end says "this is a shape next to the card".
 *
 * It was eyeballed due east, where the chord is parallel to the edge it exits
 * and the eye forgives it. Measured over a full turn against a 208×78 card, the
 * outboard endpoint stood **4.0px** proud at the two flush bearings and **6.8px**
 * at the diagonals — so even the case it was checked at was wrong, just wrong
 * parallel to the edge. (The 4px floor is `rimPoint`'s `gap`, which stands the
 * whole limb clear of the card: right for a strand, which is drawn *over* the
 * cards and must not look like a border, and exactly backwards for a root.)
 *
 * The fix is to carry the outline past its last sample, along the tangent there
 * and at the same width, until the chord is under the card — `seat` at the
 * parent, `tuck` at the child. A straight run along the tangent is both
 * tangent- and width-continuous with the curve, so it adds a rectangle and no
 * seam, and every limb of a cluster shares one, so the trunk still unions.
 * Nothing else moves: the width profile is still read from the rim, `reach`
 * still measures the visible limb, and `fork`, the bow and the sheen are
 * untouched.
 *
 * Rejected: rounding the base, which shows a cap rather than a cut; and
 * clipping the polygon against the card, which is a boolean op per card per
 * frame on a path meant to be cheap.
 */

/** What the seat has to clear beyond the chord itself, in screen pixels.
 *
 *  A card's corner is rounded (`Card.svelte`, 4px) and its border is drawn on
 *  the inside of that box, so a chord seated *exactly* on the rect is a chord
 *  the card does not quite cover. The radius is in card pixels, which the wall's
 *  `zoom` scales — but a card stuck to the glass is drawn 1:1 whatever the wall
 *  is at, and `limbsFor` cannot tell the two apart, so this takes the larger of
 *  the two readings. It is generous on purpose: every pixel of it is under a
 *  card, so being wrong in this direction costs nothing to see and being wrong
 *  in the other direction is the whole bug. */
export const SEAT_CLEAR = 5;

/** How wide a fan of children counts as one trunk. Two cards in roughly the
 *  same direction share a root; one across the wall gets its own. */
export const SPREAD_DEG = 78;

/** Where the limbs of a cluster stop coinciding, as a fraction of the distance
 *  to the *nearest* child — the nearest, because a fork past a child is a
 *  branch that leaves after it has arrived. */
export const FORK_AT = 0.32;
export const FORK_MIN = 22;
export const FORK_MAX = 150;

/** How far a limb bows off the straight line, and it is signed by which side of
 *  its cluster's mean the child is on rather than by the perpendicular — so a
 *  fan of children splays apart instead of every limb bowing the same way. A
 *  tenth of the distance where a strand takes near a fifth (`flow.bowOf`): a
 *  root is laid, not thrown. */
export const BOW_AT = 0.1;
export const BOW_MIN = 8;
export const BOW_MAX = 46;

/** How long a new root takes to grow out to its child. */
export const GROW_MS = 620;

/** The charge, when a child is working. Linear and not `ease`d, which is the
 *  opposite of a pulse and for a reason: `flow.ease` is the shape of a thing
 *  thrown, and this is a current. */
export const CHARGE_MS = 2400;
export const CHARGE_SPAN = 0.13;

/** How finely a limb is sampled. Its outline is two of these plus the caps. */
export const STEPS = 26;

/* ── the alphas ────────────────────────────────────────────────────────────
 *
 * The fill is nearly opaque rather than fully: the ambience drifts behind the
 * wall and a hard cut-out reads as a hole in the ground rather than a thing
 * lying on it. Nearly, because `ambience.md`'s rule — nothing standing on the
 * wall may be transparent — is about cards, and a leaf crossing *under* a root
 * at a tenth of its weight is the ground showing through, which is what a root
 * is on.
 */
export const FILL_ALPHA = 0.9;
/** A hairline along the centre, lighter than the fill, on the parent half only:
 *  the highlight is what makes it read as raised rather than as a hole. */
export const SHEEN_ALPHA = 0.16;
export const CHARGE_ALPHA = 0.85;
export const HALO_ALPHA = 0.22;

/** A limb, resolved. The cubic is `[from, fork, into, to]` — `fork` shared with
 *  every other limb of the cluster, which is what makes the trunk. */
export type Limb = {
  child: string;
  spine: [Pt, Pt, Pt, Pt];
  /** Half-width at the parent and at the child. */
  base: number;
  tip: number;
  /** How far past each end of the spine the outline is carried, so that the flat
   *  chord closing it lands under the card there rather than on the ground
   *  beside it. Screen pixels, along the tangent at that end. See "under the
   *  card" above. */
  seat: number;
  tuck: number;
  /** How much of it exists yet, 0..1. */
  reach: number;
  /** How many limbs share this limb's trunk, for anything that wants to know
   *  whether the fork is real. */
  siblings: number;
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function unit(from: Pt, to: Pt): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

/** Which way one card lies from another, in radians. `-PI..PI`, y down, the
 *  frame the whole wall is in. */
export function bearing(from: Pt, to: Pt): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/** The signed gap between two bearings, in radians, taking the short way
 *  round. Wrapping is the whole reason this is a function: two cards at 175°
 *  and -175° are 10° apart, and a naive subtraction puts them at 350°. */
export function bearingGap(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Children grouped into trunks by which way they lie.
 *
 *  Sorted by bearing and cut wherever the gap to the next one is wider than
 *  `spread`, then the first and last groups are joined if they are neighbours
 *  the long way round — which is the case a sort alone always gets wrong, since
 *  the seam of the sort falls at due west and a fan can sit across it.
 *
 *  Order within a group is by bearing, and that is load-bearing: `limbsFor`
 *  reads it to decide which side of the trunk each limb bows to. */
export function clusters(parent: Box, kids: readonly Kid[], spreadDeg = SPREAD_DEG): Kid[][] {
  if (kids.length === 0) return [];
  const c = centreOf(parent);
  const spread = (spreadDeg * Math.PI) / 180;
  const sorted = kids
    .map((k) => ({ k, b: bearing(c, centreOf(k.box)) }))
    .sort((p, q) => p.b - q.b);
  const groups: { k: Kid; b: number }[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    if (Math.abs(bearingGap(prev.b, sorted[i].b)) <= spread) {
      groups[groups.length - 1].push(sorted[i]);
    } else {
      groups.push([sorted[i]]);
    }
  }
  /* The seam, which a sort alone cannot see: it falls at due west, and a fan
     sitting across it comes back as two groups at opposite ends of the list.
     Joining is a neighbour test like every other cut here, so a group can end
     up spanning more than `spread` in total — three children at 70° apart chain
     into one trunk — and that is the intended reading rather than a leak. A fan
     of neighbours is one fan; what `spread` forbids is a *gap*. */
  if (groups.length > 1) {
    const first = groups[0];
    const last = groups[groups.length - 1];
    if (Math.abs(bearingGap(last[last.length - 1].b, first[0].b)) <= spread) {
      groups[0] = [...last, ...first];
      groups.pop();
    }
  }
  return groups.map((g) => g.map((e) => e.k));
}

/** The two half-widths a cluster's limbs taper between.
 *
 *  `kids` is the size of the cluster and only widens the base: a trunk carrying
 *  three children is thicker than one carrying a single child, which is what
 *  makes a fork read as one thing dividing rather than as two things touching. */
export function halfWidths(scale: number, kids = 1): { base: number; tip: number } {
  const spread = 1 + PER_CHILD * Math.max(0, kids - 1);
  return {
    base: clamp(BASE * scale, BASE_MIN, BASE) * spread,
    tip: clamp(TIP * scale, TIP_MIN, TIP),
  };
}

/** How much of a limb exists, given when it was recorded and what time it is.
 *
 *  A root with no `born` is one restored from the database, and it is drawn
 *  whole from the first frame — the alternative is a wall that grows twenty
 *  roots at launch as though every card had just been opened. `still` is
 *  `prefers-reduced-motion`, where the answer is the finished state rather than
 *  no state. */
export function reachOf(born: number | null | undefined, now: number, still = false): number {
  if (born == null || still) return 1;
  return ease(clamp((now - born) / GROW_MS, 0, 1));
}

/** Every limb one parent's children are drawn as.
 *
 *  Sorted by cluster and then by bearing, so what comes back is stable frame to
 *  frame — the canvas fills it as one path and a reordering would change which
 *  subpath is on top of which, visibly, for nothing. */
export function limbsFor(
  parent: Box,
  kids: readonly Kid[],
  opts: { scale: number; now: number; still?: boolean },
): Limb[] {
  const c = centreOf(parent);
  const out: Limb[] = [];
  for (const group of clusters(parent, kids)) {
    const dirs = group.map((k) => unit(c, centreOf(k.box)));
    /* The mean direction, which is what the trunk leaves along. A group whose
       vectors cancel cannot happen under `SPREAD_DEG` — but it must not divide
       by zero if `spread` is ever widened past a half turn, so the first
       child's own direction is the fallback. */
    const sum = dirs.reduce((a, d) => ({ x: a.x + d.x, y: a.y + d.y }), { x: 0, y: 0 });
    const mlen = Math.hypot(sum.x, sum.y);
    const dir = mlen < 1e-6 ? dirs[0] : { x: sum.x / mlen, y: sum.y / mlen };
    const from = rimPoint(parent, { x: c.x + dir.x * 1e5, y: c.y + dir.y * 1e5 });

    const tos = group.map((k) => rimPoint(k.box, from));
    const near = Math.min(...tos.map((t) => Math.hypot(t.x - from.x, t.y - from.y)));
    const forkLen = clamp(FORK_AT * near, FORK_MIN, FORK_MAX);
    const fork = { x: from.x + dir.x * forkLen, y: from.y + dir.y * forkLen };
    const { base, tip } = halfWidths(opts.scale, group.length);
    /* Backwards along the trunk's own bearing, since the tangent at `t = 0` is
       exactly `dir` — `fork` lies along it. Shared by every limb of the cluster,
       which is what keeps the buried stub part of the same union. */
    const clear = SEAT_CLEAR * Math.max(1, opts.scale);
    const seat = seatDepth(parent, from, { x: -dir.x, y: -dir.y }, base + clear);

    group.forEach((k, i) => {
      const to = tos[i];
      const u = unit(from, to);
      const len = Math.hypot(to.x - from.x, to.y - from.y);
      /* Which side of the trunk this child is on. The cross product of the
         mean and this child's direction, so a fan splays and a lone child does
         not bow at all — its own direction *is* the mean. */
      const side = dir.x * u.y - dir.y * u.x;
      const bow = Math.sign(side) * clamp(BOW_AT * len, BOW_MIN, BOW_MAX) * Math.min(1, Math.abs(side) * 3);
      const into = {
        x: to.x - (u.x * len) / 3 - u.y * bow,
        y: to.y - (u.y * len) / 3 + u.x * bow,
      };
      /* The tangent at `t = 1` is `to - into`, which is not the bearing the rim
         point was found along: the bow tilts the arrival by up to a quarter
         turn's worth of `BOW_MAX`. So the tuck follows the curve in, not the
         line between the cards. */
      out.push({
        child: k.id,
        spine: [from, fork, into, to],
        base,
        tip,
        seat,
        tuck: seatDepth(k.box, to, unit(into, to), tip + clear),
        reach: reachOf(k.born, opts.now, opts.still),
        siblings: group.length,
      });
    });
  }
  return out;
}

/** Half the limb's width at `p`, where `p` runs 0..1 over *what exists*.
 *
 *  The profile is read against the grown length rather than the whole, so a
 *  root part-way out looks like a complete short root rather than a truncated
 *  long one — a thing extending, which is what happened, instead of a thing
 *  being revealed. The exponent is what keeps the trunk full for its first
 *  third; a linear taper reads as a wedge. */
export function halfWidthAt(p: number, base: number, tip: number): number {
  const u = clamp(p, 0, 1);
  return base + (tip - base) * Math.pow(u, 0.85);
}

/** The closed outline of one limb, ready to be filled.
 *
 *  Down one side and back the other, offset along the normal of the tangent —
 *  a variable-width stroke, which canvas has no primitive for. An empty array
 *  for a limb that has not grown enough to have a shape yet: two points and a
 *  fill is a stray pixel at the card's rim on the first frame of every spawn.
 *
 *  Both ends are carried past the last sample by `seat` and `tuck`, so that the
 *  chords which close the polygon are under the cards rather than on the ground
 *  — see "under the card" above. The far end only once the limb has *arrived*:
 *  before that it is a growing head in mid-air with no card to hide under, and
 *  pushing it forward would be a root reaching past where it has got to. */
export function outline(limb: Limb, steps = STEPS): Pt[] {
  if (limb.reach <= 0.02) return [];
  const [a, c1, c2, b] = limb.spine;
  const n = Math.max(2, Math.round(steps));
  const up: Pt[] = [];
  const down: Pt[] = [];
  for (let i = 0; i <= n; i += 1) {
    const p = i / n;
    const t = p * limb.reach;
    const at = pointOn(a, c1, c2, b, t);
    const tan = tangentOn(a, c1, c2, b, t);
    const hw = halfWidthAt(p, limb.base, limb.tip);
    const past = i === 0 ? -limb.seat : i === n && limb.reach >= 1 ? limb.tuck : 0;
    const x = at.x + tan.x * past;
    const y = at.y + tan.y * past;
    up.push({ x: x - tan.y * hw, y: y + tan.x * hw });
    down.push({ x: x + tan.y * hw, y: y - tan.x * hw });
  }
  return [...up, ...down.reverse()];
}

/** The centreline, for the sheen and for a charge to run along. */
export function spine(limb: Limb, from = 0, to = 1, steps = STEPS): Pt[] {
  const [a, c1, c2, b] = limb.spine;
  return curveSamples(a, c1, c2, b, from * limb.reach, to * limb.reach, steps);
}

/** Where the charge is along a root this millisecond, or `null` in the gap
 *  between one and the next.
 *
 *  It runs past the end and shortens into the card rather than stopping dead at
 *  the rim — the same landing `flow.pulseAt` draws, for the same reason: light
 *  absorbed reads as arriving, a dot deleted reads as a bug. */
export function chargeAt(age: number, period = CHARGE_MS): { head: number; tail: number } | null {
  if (age < 0) return null;
  const u = ((age % period) / period) * (1 + CHARGE_SPAN);
  const head = Math.min(u, 1);
  const tail = clamp(u - CHARGE_SPAN, 0, 1);
  if (head - tail <= 0.002) return null;
  return { head, tail };
}

/* ── going home ────────────────────────────────────────────────────────────
 *
 * A card can be closed by the agent that opened it (`spawn::close`), and it
 * leaves the wall the instant the gesture is made — `Skein.close` takes it out
 * of `convs` before it awaits anything, because the part of a gesture the eye is
 * owed must not be downstream of an await (`restore.md`).
 *
 * So the root cannot retract *with* its card: by the time we know the card is
 * gone, its box is gone too and there is nothing to draw the far end from. What
 * is drawn instead is the last geometry the limb had, reeled back in — the
 * mirror of growth, using the same profile, so what withdraws is a complete
 * tapering root getting shorter rather than a shape being clipped.
 *
 * **It is anchored to the parent, not to the screen.** The frozen spine is kept
 * beside the parent's centre *at the moment it left*, and every frame it is
 * shifted by however far that card has moved since. Without it, a retreat during
 * a pan would stay glued to the glass while the wall slid under it — half a
 * second of a root pointing at the wrong card. If the parent has gone too (the
 * whole family closing at once), there is nothing to anchor to and the frozen
 * coordinates are used as they are.
 */

/** How long a root takes to go home. Shorter than `GROW_MS`: arriving is an
 *  event worth watching and leaving is a thing being tidied away. */
export const RETREAT_MS = 480;

/** A limb whose card has left the wall, kept until it has withdrawn. */
export type Departing = {
  /** The last live geometry, in the screen coordinates of the frame it left in. */
  limb: Limb;
  /** The card it hangs off, and where that card's centre was then. */
  parent: string;
  anchor: Pt;
  at: number;
};

/** How far in it has been reeled, 0 → 1.
 *
 *  Smoothstep, and the shape is the decision. Linear read as a marker being
 *  dragged back down the line; `flow.ease` (the shape of a thing thrown) starts
 *  at full speed, which for a withdrawal reads as the root being yanked. Slow,
 *  quick, slow is a thing letting go and then going home. */
export function reeled(u: number): number {
  const t = clamp(u, 0, 1);
  return t * t * (3 - 2 * t);
}

/** What is left of it, 0 → 1 down to nothing.
 *
 *  Held high and dropped late, deliberately: an even fade spends half the
 *  animation on a root too faint to see withdrawing, which is the whole thing
 *  there is to watch. This way it is still legible most of the way back and
 *  snuffs out as it reaches the card. */
export function fading(u: number): number {
  const t = clamp(u, 0, 1);
  return 1 - t * t * t;
}

/** One retreating limb this millisecond, or `null` once it is home.
 *
 *  `parentNow` is the parent's box if it is still on the wall — see the note
 *  above on why the retreat is anchored to a card rather than to the glass. A
 *  zoom mid-retreat is not corrected for: the shift is a translation, and half a
 *  second of a fading root at the wrong scale is not worth carrying the view
 *  through here to fix. */
export function withdrawing(
  dep: Departing,
  now: number,
  parentNow: Box | null,
): { limb: Limb; alpha: number } | null {
  const u = (now - dep.at) / RETREAT_MS;
  if (u >= 1 || u < 0) return null;
  const reach = dep.limb.reach * (1 - reeled(u));
  if (reach <= 0) return null;
  const at = parentNow ? centreOf(parentNow) : dep.anchor;
  const dx = at.x - dep.anchor.x;
  const dy = at.y - dep.anchor.y;
  const spine = dep.limb.spine.map((p) => ({ x: p.x + dx, y: p.y + dy })) as [Pt, Pt, Pt, Pt];
  return { limb: { ...dep.limb, spine, reach }, alpha: fading(u) };
}

/** Whether anything is moving, and therefore whether the canvas owes a frame
 *  loop at all.
 *
 *  `Backdrop`'s rule and `Flow`'s: an idle wall runs no frames. A root that is
 *  neither growing nor charged is a static shape, redrawn only when the wall
 *  itself moves — which is a reactive read rather than a clock.
 *
 *  **Asked of the rows and the time, never of the limbs**, and that is the whole
 *  reason it takes what it takes. Limbs are computed from the card boxes, so an
 *  effect that read them would re-run on every frame of every pan and tear the
 *  loop down and rebuild it each time — which is exactly the hazard `Flow` names
 *  about tracking a list instead of a boolean. The cost of asking the cheaper
 *  question is that a working child whose *parent* has been closed keeps the
 *  loop alive while drawing nothing, since `familiesOf` has dropped it by then.
 *  One idle loop in that case is the better side of the trade. */
export function stirring(
  kin: readonly Kin[],
  charged: ReadonlySet<string>,
  now: number,
): boolean {
  return kin.some(
    (k) => charged.has(k.child) || (k.born != null && now - k.born < GROW_MS),
  );
}

/** The parentage worth drawing: pairs where both ends are on the wall.
 *
 *  A closed card leaves its rows behind on purpose (`store::migrate_v20`), and
 *  a card whose parent has been closed is not half a root — it is a card, so
 *  the pair is simply dropped. Grouped by parent because that is how a trunk is
 *  worked out, and a child with two parents is not a thing the table can hold. */
export function familiesOf(
  kin: readonly Kin[],
  boxes: ReadonlyMap<string, Box>,
  /** `id` comes back beside the box because a retreat is anchored to the parent
   *  *card* rather than to where it was — see `withdrawing`, which needs to look
   *  that card up again on every frame of the way home. */
): { id: string; parent: Box; kids: Kid[] }[] {
  const byParent = new Map<string, Kid[]>();
  for (const k of kin) {
    const pb = boxes.get(k.parent);
    const cb = boxes.get(k.child);
    if (!pb || !cb) continue;
    const kids = byParent.get(k.parent) ?? [];
    kids.push({ id: k.child, box: cb, born: k.born });
    byParent.set(k.parent, kids);
  }
  return [...byParent.entries()].map(([id, kids]) => ({
    id,
    parent: boxes.get(id)!,
    kids,
  }));
}
