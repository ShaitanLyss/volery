/* What is picked on the wall, and what a gesture does to it. Pure — no runes —
 * so the whole of the selection algebra is testable without a DOM, which is
 * where nearly all of the judgement in this feature is.
 *
 * There is **one** selection and it spans all four kinds of thing that stand on
 * this wall: a card, a project's territory, a widget, a reference image. It did
 * not used to be one. `studio.selected` was a list of card ids (the gathering a
 * broadcast is aimed at), `Board.selected` was a single image and
 * `Widgets.selected` a single widget, and the two singletons deliberately
 * cleared each other so that Delete had one unambiguous target. Three
 * selections, none of which could hold two things of different kinds — so
 * "select these two cards and that reference and move them together" was not a
 * sentence the wall could say. `Studio.picks` is the one selection now, and
 * `studio.selected` is a reading of it: the picked *cards*, in the order they
 * were picked, which is exactly what the dock has always meant by the
 * gathering. */

import { contains, touches, type Box } from "./layout";

/** The four things that stand on the wall. `region` is a project's territory,
 *  keyed by its `root_path` — the same id `Region.cwd` carries, because that is
 *  what a project is identified by everywhere else. */
export type Kind = "card" | "image" | "widget" | "region";

export type Pick = { kind: Kind; id: string };

/** Which modifiers a gesture was made with.
 *
 *  `ctrl` is "the toggle modifier" rather than literally the Control key: the
 *  caller ORs in `metaKey`, the way `cycleTab`'s own binding does, so this file
 *  never has to know which platform it is on. */
export type Mods = { shift?: boolean; ctrl?: boolean };

/** One key per thing, so a selection can be compared and deduped without
 *  caring that two kinds might mint the same id. */
export function keyOf(p: Pick): string {
  return `${p.kind}:${p.id}`;
}

export function has(sel: readonly Pick[], p: Pick): boolean {
  const k = keyOf(p);
  return sel.some((q) => keyOf(q) === k);
}

/** The ids of everything picked of one kind, in the order it was picked. */
export function idsOf(sel: readonly Pick[], kind: Kind): string[] {
  return sel.filter((p) => p.kind === kind).map((p) => p.id);
}

/** First wins, so the order a selection was assembled in survives a merge —
 *  which is what the dock lists the gathering in. */
export function dedupe(sel: readonly Pick[]): Pick[] {
  const seen = new Set<string>();
  const out: Pick[] = [];
  for (const p of sel) {
    const k = keyOf(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ kind: p.kind, id: p.id });
  }
  return out;
}

/* ── the two modifiers ──────────────────────────────────────────────────────
 *
 * **Ctrl toggles one thing. Shift adds one and never removes. Either one makes
 * a marquee add to the selection instead of replacing it.**
 *
 * That is what desktop applications actually do, rather than what would be
 * symmetrical. In a *list* — Explorer, a mail client — ctrl+click toggles one
 * row and shift+click extends a **range** from the anchor, and the range is the
 * whole reason shift is there. This wall has a reading order (`wallOrder`) and
 * it covers cards only: an image, a widget and a territory are nowhere in it.
 * So a shift that meant "range" would mean it for one of the four kinds and
 * quietly mean something else for the other three, which is worse than not
 * offering a range at all.
 *
 * On a *canvas* — Figma, Illustrator, Blender — shift+click is therefore an
 * add, and that is what this is. It is still worth having beside ctrl, because
 * the two are genuinely different gestures rather than two spellings of one:
 * shift is how you gather things up and can never cost you something you
 * already had, and ctrl is how you take back the one you picked by mistake. One
 * modifier doing both means every shift-click across a dense territory risks
 * dropping a card you had already caught, which is the failure that makes
 * people stop using the modifier.
 *
 * Neither modifier makes a marquee *toggle*, which is what symmetry would ask
 * for. You cannot see what is already selected underneath a band you are
 * drawing, so a rectangle that toggled would be a gesture whose result you
 * could not predict while making it — and Explorer and Figma both add here too.
 *
 * And a plain press on something that is **already** picked leaves the
 * selection alone. That is the subtlety the whole feature rests on: collapsing
 * to the one thing on the *press* makes it impossible to drag a group by one of
 * its members, which is the thing multi-select is for. It collapses on the
 * release instead, and only if the press never travelled — which is why there
 * are two functions here rather than one, and it is the same shape as
 * "the press is a click until it has travelled" everywhere else in this app. */

/** What is picked once the press has landed on `on`, before anybody knows
 *  whether it is a click or a drag. */
export function pressed(sel: readonly Pick[], on: Pick, m: Mods = {}): Pick[] {
  if (m.ctrl) {
    const k = keyOf(on);
    return has(sel, on)
      ? sel.filter((p) => keyOf(p) !== k).map((p) => ({ ...p }))
      : [...dedupe(sel), { ...on }];
  }
  if (m.shift) return has(sel, on) ? dedupe(sel) : [...dedupe(sel), { ...on }];
  /* Plain, and already in hand: left exactly as it is, because this press may
     be about to carry the whole group. `tapped` collapses it if it turns out
     to have been a click after all. */
  return has(sel, on) ? dedupe(sel) : [{ ...on }];
}

/** What is picked after a press on `on` that never travelled.
 *
 *  A modified click has already had its whole effect on the press — ctrl
 *  toggled, shift added — and doing either again here would undo it. */
export function tapped(sel: readonly Pick[], on: Pick, m: Mods = {}): Pick[] {
  if (m.ctrl || m.shift) return dedupe(sel);
  return [{ ...on }];
}

/** What is picked when a marquee is let go over `hit`. */
export function marqueed(
  sel: readonly Pick[],
  hit: readonly Pick[],
  m: Mods = {},
): Pick[] {
  return m.ctrl || m.shift ? dedupe([...sel, ...hit]) : dedupe(hit);
}

/* ── what a rectangle covers ──────────────────────────────────────────────── */

/** A thing standing on the wall, as the marquee sees it: what it is, and the
 *  box it occupies in **canvas** units.
 *
 *  `area` marks the one kind that is a region of the wall rather than an object
 *  standing on it — see `covered`. */
export type Standing = Pick & { box: Box; area?: boolean };

/** Everything a rectangle in canvas units picks up.
 *
 *  **Touched, not contained**, for anything you can pick up: a lasso you have
 *  to draw perfectly is a lasso you stop using. That is the rule the shift-
 *  marquee has always followed and it is kept.
 *
 *  **Except for a territory, which has to be enclosed.** A territory is an
 *  *area* — `REGION_W` wide and as tall as its cards reach — so a band drawn
 *  inside one to gather two of its cards touches it as well, and a selection
 *  that quietly included the project would move the whole thing on the next
 *  drag. An area you have merely reached into is one you were reaching into to
 *  get at what is standing in it; an area you have drawn a box right around is
 *  one you meant. Same call Figma makes about a frame, and it leaves the
 *  territory's own name — which is already the handle you drag it by — as the
 *  precise way to pick one. */
export function covered(rect: Box, on: readonly Standing[]): Pick[] {
  return on
    .filter((s) => (s.area ? contains(rect, s.box) : touches(rect, s.box)))
    .map((s) => ({ kind: s.kind, id: s.id }));
}

/* ── carrying a selection ─────────────────────────────────────────────────── */

/** Where one thing stood when the press landed. Every frame of a drag is
 *  computed from these rather than accumulated onto the last frame, which is
 *  the bargain `cardMove` and `terrMove` already struck: an accumulated drag
 *  drifts, and a re-entrant one doubles. */
export type Origin = { id: string; x: number; y: number };

/** Everything one drag moves, by kind, with where each thing started.
 *
 *  A territory carries the pinned cards standing in it by hand — flowing ones
 *  follow by arithmetic, since their slots are measured off the region's origin
 *  — which is the arrangement `terrDown` already had for a single territory. */
export type Haul = {
  cards: Origin[];
  images: Origin[];
  widgets: Origin[];
  regions: (Origin & { pins: Origin[] })[];
};

/** The wall as `haulOf` needs to see it: where everything stands right now.
 *  A region's `id` is its `cwd`, and a card's `x`/`y` are where the layout has
 *  it — its slot if it flows, its placement if it is pinned. */
export type World = {
  cards: { id: string; cwd: string; x: number; y: number; pinned: boolean }[];
  images: readonly Origin[];
  widgets: readonly Origin[];
  regions: readonly Origin[];
};

const originsOf = (sel: readonly Pick[], kind: Kind, all: readonly Origin[]) => {
  const want = new Set(idsOf(sel, kind));
  return all.filter((o) => want.has(o.id)).map((o) => ({ ...o }));
};

/** What a drag of any member of `sel` has to move, and from where.
 *
 *  The grabbed thing is not passed in, because `pressed` has already put it in
 *  the selection — that is the whole reason the press writes the selection
 *  before the slop is reached.
 *
 *  **A card standing in a territory that is coming along is not moved in its
 *  own right**, and that is the one rule in here worth stating. A pinned card
 *  counted twice would land in the same place, since both writes are computed
 *  from the origin the press recorded — but a *flowing* one would be pinned
 *  where it stands and then have its territory's flow move out from under it,
 *  which tears the territory in exactly the way carrying the pins by hand
 *  exists to prevent. */
export function haulOf(sel: readonly Pick[], world: World): Haul {
  const carried = new Set(idsOf(sel, "region"));
  const regions = world.regions
    .filter((r) => carried.has(r.id))
    .map((r) => ({
      ...r,
      pins: world.cards
        .filter((c) => c.cwd === r.id && c.pinned)
        .map((c) => ({ id: c.id, x: c.x, y: c.y })),
    }));
  const cards = world.cards
    .filter((c) => !carried.has(c.cwd) && has(sel, { kind: "card", id: c.id }))
    .map((c) => ({ id: c.id, x: c.x, y: c.y }));
  return {
    cards,
    images: originsOf(sel, "image", world.images),
    widgets: originsOf(sel, "widget", world.widgets),
    regions,
  };
}

/** How many separate things a haul is about — a territory counts as one,
 *  however many cards it carries, because that is what letting go of it says
 *  happened. */
export function haulSize(h: Haul): number {
  return h.cards.length + h.images.length + h.widgets.length + h.regions.length;
}

const ONE: Record<Kind, string> = {
  card: "a card",
  image: "an image",
  widget: "a widget",
  region: "a territory",
};

/** What the undo menu says about a drag.
 *
 *  One thing keeps the sentence it always had — "moving a card", "moving a
 *  territory on the glass" — so nothing about undoing a single move reads
 *  differently than it did. More than one is *counted* rather than listed:
 *  "moving a card, an image and two widgets" is a label nobody reads to the end
 *  of, and the four kinds do not usefully name themselves in a group. */
export function haulLabel(h: Haul, on: Pick, glass = false): string {
  const n = haulSize(h);
  const what = n > 1 ? `${n} things` : ONE[on.kind];
  return glass ? `moving ${what} on the glass` : `moving ${what}`;
}

/** A selection with everything of one kind taken out of it. */
export function withoutKind(sel: readonly Pick[], kind: Kind): Pick[] {
  return sel.filter((p) => p.kind !== kind).map((p) => ({ ...p }));
}

/** A selection with one thing taken out of it. */
export function without(sel: readonly Pick[], p: Pick): Pick[] {
  const k = keyOf(p);
  return sel.filter((q) => keyOf(q) !== k).map((q) => ({ ...q }));
}

/** Where an undoable change is written down, as the wall's selection looks to
 *  the two classes that have to reach it.
 *
 *  `Board` and `Widgets` each need to say "the thing I have just put up is what
 *  is selected now" and "the thing I have just taken down is not". Neither may
 *  own the wall's selection, and neither may import `Studio` — so it is
 *  injected as a field with a no-op default, exactly the arrangement `scribe`
 *  and `others` already have in both of those classes. */
export type Picker = {
  only(kind: Kind, id: string): void;
  drop(kind: Kind, id: string): void;
};

export const NO_PICKS: Picker = { only() {}, drop() {} };
