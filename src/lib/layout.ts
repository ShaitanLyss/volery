/* Where every card sits. Pure — no runes — so the placement rules can be
 * tested directly.
 *
 * The design's argument is that position should be *memory*. A fixed grid
 * reflows every time a conversation opens or closes, so you re-read the wall
 * instead of glancing at it. Here, cards auto-place into their project's
 * territory — a working wall on day one with zero arranging — and dragging one
 * pins it forever. Unpinned cards flow around pinned ones.
 *
 * Territories work the same way one level up: they flow onto a grid of cells
 * until one is dragged, and a dragged one holds its ground. */

import { offsetBy, spotOf, type Spot } from "./glass";

export type { Spot } from "./glass";

/** Where a card sits, and — if it has been stuck to the glass — where it is
 *  drawn instead.
 *
 *  `glassX`/`glassY` never replace `x`/`y`. A card on the glass keeps its wall
 *  position and its slot, so taking it off puts it back exactly where it was
 *  and nothing else on the wall moves; see the note at the top of `glass.ts`. */
export type Placement = {
  x: number;
  y: number;
  pinned: boolean;
  glassX?: number | null;
  glassY?: number | null;
};
export type Lod = "field" | "wall" | "open";

/** The minimum a thing needs to be placeable. `Conversation` satisfies it
 *  structurally, which keeps this file free of Svelte. */
export type Placeable = { id: string; cwd: string; project: string };

/** A project as the store knows it. `Project` satisfies it structurally.
 *
 *  `x`/`y` are where the territory has been *put*, if it ever was. Null means
 *  "let the grid place it", exactly as a card with no placement flows.
 *
 *  `glassX`/`glassY` are where it is drawn if it has been stuck to the glass,
 *  and are independent of the first pair for the reason a card's are: a stuck
 *  territory still flows on the wall, still consumes its cell, and still holds
 *  its ground against the others. Only the paint moves. */
export type Territory = {
  name: string;
  root_path: string;
  x?: number | null;
  y?: number | null;
  glassX?: number | null;
  glassY?: number | null;
};

/** Canvas-space geometry. Slots stay a constant size across zoom levels so
 *  cards never collide when the level-of-detail changes. */
export const CARD_W = 208;
export const SLOT_W = 248;
export const SLOT_H = 116;
export const REGION_COLS = 2;
export const REGION_PAD = 18;
export const REGION_HEAD = 30;
export const REGION_GAP = 52;
export const REGION_W = REGION_COLS * SLOT_W + REGION_PAD * 2 - (SLOT_W - CARD_W);

/* ── where the territories themselves go ───────────────────────────────────
 *
 * They used to run along one line: the first project at the origin, the next
 * beside it, forever rightwards. Six projects made a wall three thousand units
 * wide and five hundred tall, so the zoom that fitted it left every card a
 * smudge with the whole lower half of the screen unused. Territories now settle
 * into `TERRITORY_COLS` columns, in the order `territoryColumn` gives, each one
 * `REGION_GAP` below whatever is already standing in the column it drops into.
 *
 * A territory stuck to the glass is packed here exactly like any other, and so
 * is a card that has been: the wall is laid out as though nothing were on the
 * glass at all, and only the paint moves. See the note at the top of `glass.ts`.
 *
 * They are packed against their *real* heights, so there is no air on the wall
 * that nothing is standing in. That is only safe because a settled position is
 * written down (`Skein.#settlePlaces`): the packing runs when a project first
 * appears, or when you ask for it, and never again — so the wall does not
 * reshuffle itself as conversations open and close, which is the thing
 * position-as-memory rules out. A project that later outgrows the space packed
 * for it reaches into its neighbour rather than pushing it; drag either of them,
 * or tidy the territories, and the wall is packed afresh.
 *
 * The column count is a constant. Deriving it from how many projects there are
 * (√n, say) would move every territory the moment a folder was opened. */
export const TERRITORY_COLS = 3;
export const TERRITORY_W = REGION_W + REGION_GAP;

/** Which column the `n`th flowing territory drops into.
 *
 * Filling a row across and then wrapping is the obvious order and reads badly:
 * three projects make a wall three territories wide and one tall, so the zoom
 * that fits it is already the zoom for the whole width while the lower two
 * thirds of the screen hold nothing. The wall grows sideways, then all at once
 * downwards.
 *
 * So it grows a *square* instead — 1×1, then 2×2, then 3×3 — taking the new
 * right-hand column from the top down and then the new bottom row left to
 * right. For nine territories that is
 *
 *     1 2 5
 *     3 4 6
 *     7 8 9
 *
 * which keeps what is on the wall roughly as tall as it is wide at every count,
 * so each new project lands beside what is already there rather than extending
 * the wall in one direction. Past the last square the rows simply continue left
 * to right: with the column count fixed there is no further out to grow into.
 *
 * Only the *column* is decided here. Where a territory lands inside it is still
 * `settleY` against real heights, so "row" is a reading of the wall rather than
 * a pitch anything reserves — the third territory sits directly under the first,
 * however tall the first happens to be. */
export function territoryColumn(n: number, cols = TERRITORY_COLS): number {
  if (cols <= 1) return 0;
  let i = 0;
  for (let k = 0; k < cols; k += 1) {
    /* The shell's new column, above its corner. */
    for (let r = 0; r < k; r += 1) if (i++ === n) return k;
    /* Then its new row, corner included. */
    for (let c = 0; c <= k; c += 1) if (i++ === n) return c;
  }
  return (n - cols * cols) % cols;
}

export const MIN_SCALE = 0.34;
export const MAX_SCALE = 2.2;

/* ── how wide the reading panel is ─────────────────────────────────────────
 *
 * Not the wall, but it takes its width from the same window, so it belongs
 * beside the viewport rather than in a component.
 *
 * The panel is a *fixed* column that you set: it must never size itself to its
 * contents. It used to, by accident — `.detail` was a flex item with no
 * `min-width: 0`, so a code fence's min-content width became a floor and the
 * panel grew past its column and off the right edge of the window. Growing to
 * fit is also wrong on purpose: an answer streaming a wide table in would
 * re-measure the paragraph you were halfway through reading. Wide content
 * scrolls inside itself; the column is yours.
 *
 * Never dragged, it is what it always was — a third of the window, between 300
 * and 460. Dragged, it is what you dragged it to, and the only thing that
 * overrules you is the window getting small enough that there would be no wall
 * left to have a conversation on. */
export const PANEL_MIN = 300;
export const PANEL_MAX = 900;
/** The widest it settles at on its own, before anybody drags it. */
export const PANEL_REST = 460;
/** How much wall survives however far the panel is pulled open. */
export const WALL_MIN = 320;

/** The panel's width in px. `stored` is null until it has been dragged. */
export function panelWidth(stored: number | null, windowW: number): number {
  const want = stored ?? clamp(windowW * 0.32, PANEL_MIN, PANEL_REST);
  /* A narrow window still gets a usable panel: the floor wins over the wall's
     share, or shrinking the window would eventually leave a sliver too thin to
     read and no way to widen it back. */
  const room = Math.max(PANEL_MIN, Math.min(PANEL_MAX, windowW - WALL_MIN));
  return Math.round(clamp(want, PANEL_MIN, room));
}

/* ── how big the reading is ────────────────────────────────────────────────
 *
 * The panel's other dimension, and independent of its width: a narrow column
 * of large type is an ordinary way to read, and so is a wide one of small.
 * Width is a place in the window; this is how large the words in it are drawn,
 * and neither should be derived from the other.
 *
 * A multiplier rather than a size in points, because the transcript is already
 * proportional to itself — a heading, a fence, a table and a meta note are all
 * `em` off the line, and `78ch` means seventy-eight characters at whatever
 * size those characters happen to be. One number therefore moves the whole
 * column and nothing inside it changes shape.
 *
 * The range is what stays readable rather than what is technically drawable:
 * below 0.7 the meta notes (0.64 of a line) fall under seven pixels, and above
 * 2 a 78-character measure no longer fits a panel that has a wall to leave
 * room for. */
export const READ_MIN = 0.7;
export const READ_MAX = 2;
/** Untouched, it is the size it always was. */
export const READ_REST = 1;
/** One notch of the wheel. Five percent is small enough that overshooting is
 *  cheap and large enough to be worth a notch. */
export const READ_STEP = 0.05;

/** The reading scale. `stored` is null until it has been changed. Rounded to
 *  the notch, so a long accumulation of `+ 0.05` cannot drift into a scale
 *  that prints as `114.99999%`. */
export function readingScale(stored: number | null): number {
  return Math.round(clamp(stored ?? READ_REST, READ_MIN, READ_MAX) * 100) / 100;
}

/** A notch, in the direction the wheel turned. `deltaY` is the browser's:
 *  negative is away from you, which is larger — the same sense the wall's zoom
 *  reads it in. A zero delta (a trackpad reporting only the other axis) is not
 *  a notch and must not round the scale off its current value. */
export function nudgeReading(stored: number | null, deltaY: number): number {
  const from = readingScale(stored);
  if (!deltaY) return from;
  return readingScale(from + (deltaY < 0 ? READ_STEP : -READ_STEP));
}

/* ── how the wall stacks ───────────────────────────────────────────────────
 *
 * One order for everything on it, in one place, because "in front" has to mean
 * the same thing to a card, a territory's chips and a reference image. It did
 * not: cards were pinned at 1000 and chips at 1001 in CSS, while an image's
 * z-index was its own small `z`, so the front-most image on the wall still
 * drew behind every card and every `+` — `bringToFront` could only reorder
 * images among themselves.
 *
 * So images stack in two bands. Below the cards is where a reference usually
 * wants to be — something to work from, not something in the way. Above
 * everything is what "bring to front" now means, and it means it literally. */
export const Z_CARD = 1000;
export const Z_CHIP = 1001;
export const Z_FRONT = 2000;

/** The next z for an image that should stay behind the wall's furniture. */
export function nextBackZ(zs: number[]): number {
  const top = zs.filter((z) => z < Z_CARD).reduce((m, z) => Math.max(m, z), 0);
  /* Never past the cards: a wall of references that had each crept up one at a
     time would eventually start covering the work. */
  return Math.min(top + 1, Z_CARD - 1);
}

/** The next z for an image that should be in front of everything. */
export function nextFrontZ(zs: number[]): number {
  return Math.max(Z_FRONT, ...zs) + 1;
}

/** How big a card actually is at each density, in canvas units.
 *
 * These follow Card.svelte's `[data-lod]` rules. Two things depend on them:
 *
 * 1. Hit-testing has to ask for the current density rather than assume the wall.
 *    A marquee fixed at 208×76 selected cards it never touched at `field`, which
 *    is 38 units shorter.
 *
 * 2. Every box must fit inside a slot, which is the invariant above — and is
 *    asserted in layout.test.ts, because it did not hold. `open` used to draw a
 *    288-wide card on a 248 pitch, so each card covered the 40 units of its
 *    neighbour where the ring sits, and the row below covered its speech. Open
 *    now grows downwards only, and only within the slot.
 *
 * **Every density is `CARD_W` wide.** Semantic zoom takes things *away* — at
 * `field` a card is its ring and nothing else — and it used to take the width
 * with them, shrinking to 58 so the card was a ring-sized square. That reads as
 * the wall rearranging itself rather than as the same wall seen from further
 * off: the columns pull in towards their left edges, and every card changes
 * shape at the moment you are trying to keep your place among them. The pitch is
 * fixed at every zoom, so the space a narrow card gave back was never used for
 * anything. So density is now height and content only, in both directions —
 * `field` drops to 40 and `open` grows to 105, and the left and right edges of
 * every card on the wall stay exactly where they were.
 *
 * Measured off the running app through the control surface — `dom` at a known
 * `scale`, divided back — rather than worked out from the CSS by hand.
 *
 * They are *nominal*, and slightly low at the extremes, because the wall is
 * zoomed rather than scaled (see the note over `.pan` in Canvas.svelte): `zoom`
 * re-lays-out, so a card's height in canvas units is no longer exactly linear in
 * the scale. Measured 2026-08-13 against the release build: 42.2 units at 0.45,
 * 79.0 at 0.62, 78.0 at 1.0, 105.5 at 2.2. Nearly all of it is the 1px border,
 * which Chromium clamps to one *device* pixel and therefore never draws thinner
 * — `border-top-width` computes to 2.22px at 0.45 and 0.909px at 2.2. So a card
 * is relatively fatter the further out you go, which is why the widest drift is
 * at `field`, and why it is harmless: 42 units of card in a 116 pitch. Keep the
 * invariant's headroom in mind before trimming SLOT_H. */
export const CARD_BOX: Record<Lod, { w: number; h: number }> = {
  field: { w: CARD_W, h: 40 },
  wall: { w: CARD_W, h: 78 },
  open: { w: CARD_W, h: 105 },
};

export type Region = {
  project: string;
  cwd: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Where it is drawn, if it has been stuck to the glass — screen pixels, and
   *  never a substitute for `x`/`y`, which stay what the wall says. */
  glass: Spot | null;
};

export type Laid<T> = {
  conv: T;
  x: number;
  y: number;
  pinned: boolean;
  /** As `Region.glass`. Either the card's own spot, or — for a card standing in
   *  a territory that has been stuck — the same offset from its region's glass
   *  origin that it has from the region's wall origin. */
  glass: Spot | null;
};

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** How tall a territory holding `cards` conversations stands, in canvas units.
 *
 * What the packing reserves for it, and what its region draws unless a card has
 * been pinned deeper than the flow reaches. Counted off the cards rather than
 * measured off the region, because the region's own height depends on where its
 * pinned cards sit, which depends on where the territory ended up. */
function territoryHeight(cards: number): number {
  const rows = Math.max(1, Math.ceil(cards / REGION_COLS));
  return REGION_HEAD + rows * SLOT_H + REGION_PAD;
}

/** A rectangle in canvas space. Exported because `images.svelte.ts` builds
 *  them to hand to `pinSpot`. */
export type Box = { x: number; y: number; w: number; h: number };

/** Do two boxes overlap at all? Edges touching is not an overlap: two cards on
 *  adjacent slots share no area, and a marquee dragged to exactly a card's left
 *  edge has not reached it yet.
 *
 *  Public because the marquee is the other reader — `pick.ts::covered` asks it
 *  of everything standing on the wall, at boxes this file already defines
 *  (`CARD_BOX` at the current density, a region's own `w`/`h`). It was private
 *  while the packing was the only caller. */
export function touches(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Is `b` wholly inside `a`? The stricter test, for the one thing a marquee
 *  must not pick up by being drawn *inside* it — see `pick.ts::covered`. */
export function contains(a: Box, b: Box): boolean {
  return (
    b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h
  );
}

/** The first free y at or below `from` in a column, given what is already there.
 *
 * `blocked` is every territory that has been *placed* — including ones dragged
 * off the columns entirely, since the only question that matters is whether the
 * boxes touch. y only ever moves down, and only to the underside of something it
 * hit, so this settles in at most one step per obstacle. */
function settleY(x: number, from: number, h: number, blocked: Box[]): number {
  let y = from;
  for (;;) {
    const under = blocked.filter((b) => touches({ x, y, w: REGION_W, h }, b));
    if (!under.length) return y;
    y = Math.max(...under.map((b) => b.y + b.h)) + REGION_GAP;
  }
}

/** Where slot `i` of a territory sits, in canvas units. */
function slotAt(x: number, y: number, i: number): { x: number; y: number } {
  return {
    x: x + REGION_PAD + (i % REGION_COLS) * SLOT_W,
    y: y + REGION_HEAD + Math.floor(i / REGION_COLS) * SLOT_H,
  };
}

/** Which slot a pinned card is sitting on, or null if it is off the grid.
 *
 * The inverse of `slotAt`, with half a slot of tolerance: a card is dropped by
 * hand and never lands exactly on the pitch, but if it is close enough to
 * *look* like it occupies a slot then that slot is occupied. Anything further
 * out — dragged off to one side, or below the columns — reserves nothing. */
function slotUnder(
  p: Placement,
  x: number,
  y: number,
): number | null {
  const col = Math.round((p.x - x - REGION_PAD) / SLOT_W);
  const row = Math.round((p.y - y - REGION_HEAD) / SLOT_H);
  if (col < 0 || col >= REGION_COLS || row < 0) return null;
  const at = slotAt(x, y, row * REGION_COLS + col);
  if (Math.abs(p.x - at.x) > SLOT_W / 2 || Math.abs(p.y - at.y) > SLOT_H / 2) {
    return null;
  }
  return row * REGION_COLS + col;
}

/** Assign every territory and every card a canvas position.
 *
 * The same bargain twice over. A territory that has been dragged somewhere stays
 * exactly there; one that never has flows into the next cell of the territory
 * grid — `territoryColumn`'s order, in project order.
 *
 * Pinned cards keep exactly where they were dropped. Unpinned cards flow into
 * the free slots of their project's territory, in open order — so a new
 * conversation always lands somewhere sensible without ever displacing
 * something you deliberately placed.
 *
 * "Free" is the part that was only ever a claim: the flow used to number its
 * own slots and ignore the pinned cards entirely, so a card pinned near the top
 * of its territory — which is where most of them end up, since dragging one a
 * short way pins it about where it already was — kept its slot in the grid as
 * well. Every new conversation then opened underneath it, in the same corner,
 * looking like the wall had no idea where to put anything. */
export function layout<T extends Placeable>(
  convs: T[],
  placements: Record<string, Placement>,
  projects: Territory[] = [],
): { regions: Region[]; laid: Laid<T>[] } {
  const groups = new Map<string, T[]>();
  for (const c of convs) {
    const g = groups.get(c.cwd);
    if (g) g.push(c);
    else groups.set(c.cwd, [c]);
  }

  /* Territories come from the projects, not from the cards standing in them.
     Deriving them from cards meant closing the last conversation in a project
     took the project with it — and with it the `+` that would have started the
     next one, which is a normal thing to want: finish everything, then begin
     again in the same place.

     Ordering follows the project list (created_at), which is stable whatever
     opens and closes. Anything with cards but no project row — nothing today,
     but a cwd is not required to be one — keeps its place at the end rather
     than being dropped. */
  type Entry = {
    cwd: string;
    name?: string;
    x?: number | null;
    y?: number | null;
    glass?: Spot | null;
  };
  const order: Entry[] = projects.map((p) => ({
    cwd: p.root_path,
    name: p.name,
    x: p.x,
    y: p.y,
    glass: spotOf(p),
  }));
  const known = new Set(order.map((o) => o.cwd));
  for (const cwd of groups.keys()) {
    if (!known.has(cwd)) order.push({ cwd });
  }

  /* Where the placed territories stand, before anything is settled around them:
     one that has been put somewhere holds its ground against every territory in
     the list, not only the ones after it in project order. */
  const blocked: Box[] = order
    .filter((o) => o.x != null && o.y != null)
    .map((o) => ({
      x: o.x!,
      y: o.y!,
      w: REGION_W,
      h: territoryHeight((groups.get(o.cwd) ?? []).length),
    }));

  /* How far down each column has been filled, and how many territories have
     flowed — which is not the same as how many have been *placed*, since one
     that has been dragged somewhere consumes no cell. */
  const columns = Array.from({ length: TERRITORY_COLS }, () => 0);
  let flowed = 0;

  const regions: Region[] = [];
  const laid: Laid<T>[] = [];

  for (const { cwd, name, x: px, y: py, glass: rg } of order) {
    const members = groups.get(cwd) ?? [];
    let x: number;
    let y: number;
    if (px != null && py != null) {
      x = px;
      y = py;
    } else {
      const h = territoryHeight(members.length);
      const col = territoryColumn(flowed);
      flowed += 1;
      x = col * TERRITORY_W;
      y = settleY(x, columns[col], h, blocked);
      columns[col] = y + h + REGION_GAP;
    }

    /* Reserve first, place second — a pinned card holds its slot against every
       flowing card, not only the ones that come after it in open order. */
    const taken = new Set<number>();
    for (const c of members) {
      const p = placements[c.id];
      if (!p?.pinned) continue;
      const s = slotUnder(p, x, y);
      if (s !== null) taken.add(s);
    }

    /* Where a card in this territory is drawn, given where it sits on the wall.
       Its own spot if it has one; otherwise the region's, if the whole
       territory is stuck — at the same offset from the glass origin that the
       card has from the wall origin, which is what carries a territory's cards
       across with it and costs nothing to do. Neither reads `x`/`y` back. */
    const drawnAt = (p: Placement | undefined, at: Spot): Spot | null => {
      const own = spotOf(p);
      if (own) return own;
      return rg ? offsetBy(at, { x, y }, rg) : null;
    };

    let deepest = 0;
    let next = 0;
    for (const conv of members) {
      const p = placements[conv.id];
      if (p?.pinned) {
        laid.push({
          conv,
          x: p.x,
          y: p.y,
          pinned: true,
          glass: drawnAt(p, { x: p.x, y: p.y }),
        });
        continue;
      }
      while (taken.has(next)) next += 1;
      taken.add(next);
      const at = slotAt(x, y, next);
      deepest = Math.max(deepest, Math.floor(next / REGION_COLS) + 1);
      next += 1;
      laid.push({ conv, x: at.x, y: at.y, pinned: false, glass: drawnAt(p, at) });
    }
    /* The territory has to reach whatever it holds, including a card pinned
       further down its own columns than anything flowing. */
    for (const s of taken) {
      deepest = Math.max(deepest, Math.floor(s / REGION_COLS) + 1);
    }

    regions.push({
      /* The project's own name when the store has one. Falling back to a
         member's is only for a cwd with no project row — and reading it off a
         card is lossy anyway, since a worktree card calls itself "skein · fix". */
      project: name ?? members[0]?.project ?? cwd,
      cwd,
      x,
      y,
      w: REGION_W,
      h: REGION_HEAD + Math.max(1, deepest) * SLOT_H + REGION_PAD,
      glass: rg ?? null,
    });
  }

  return { regions, laid };
}

/** How far a card has to travel to reach its new slot, in **canvas** units, and
 * how long that should take.
 *
 * The FLIP arithmetic behind the animation on `.node`: closing a conversation
 * moves every flowing card after it up a slot, and the wall should show that as
 * a move rather than as a wall that was suddenly always like this. Position on
 * this wall is memory, and a card that arrives without travelling is one you
 * have to find again.
 *
 * `from`/`to` are what a browser measures, which is **screen** pixels; the
 * transform that plays them back is applied inside `.layer`, whose units are
 * canvas units. Hence the divide, and hence `scale` rather than a reading off
 * the DOM — the same bargain `toCanvas`, the drag deltas and `reveal` make.
 *
 * This is why the animation is not `svelte/animate`'s own `flip`, which knows
 * about zoom and divides by it **twice**. Its scale factor is
 * `clientWidth / rect.width / currentCSSZoom`, and probed 2026-08-14 against
 * Chromium 151 (`tools/probe-zoom.html`) a 200px-wide box under `zoom: 0.6`
 * reports `clientWidth` 200, `getBoundingClientRect().width` 120 and
 * `currentCSSZoom` 0.6 — so the first two already *are* the zoom and the factor
 * comes out at 1/zoom², not 1/zoom. Chromium's client dimensions used to carry
 * the zoom, which is presumably what that line was written against. Probed the
 * same day end to end, one card closed out of a column of four at `zoom: 0.5`:
 * `flip` starts its neighbours 232 units away and this starts them at 116, which
 * is the slot they were actually standing in. So it would be a card flying in
 * from 1/scale times too far at `field`, and starting halfway to its destination
 * at `open`.
 *
 * Duration by distance, so a card that shuffles up one slot is not on screen as
 * long as one crossing a territory, and something that did not move at all
 * (every pinned card, on every close) gets no animation rather than a 200ms
 * transform that does nothing. Capped, because the wall is not the subject. */
export function settle(
  from: { left: number; top: number },
  to: { left: number; top: number },
  scale: number,
): { dx: number; dy: number; duration: number } {
  const s = Math.max(scale, 0.01);
  const dx = (from.left - to.left) / s;
  const dy = (from.top - to.top) / s;
  return {
    dx,
    dy,
    duration: Math.min(360, Math.sqrt(Math.hypot(dx, dy)) * 16),
  };
}

/** The longest a walk can run — the cap `settle` applies. Named so the fade
 *  below can be stated against it rather than against a number. */
export const WALK_CAP_MS = 360;

/** How long a card an agent closed stays on the wall, fading.
 *
 *  **Your own close is instant and this is not**, and that asymmetry is the
 *  whole point rather than a nicety: you closed it, so you already know it went
 *  and a delay is the wall arguing with your hand. An agent closed it while you
 *  were reading something else, and a card that vanishes between two glances is
 *  indistinguishable from one you had misremembered being there. The fade is
 *  what makes it a departure you can catch out of the corner of an eye.
 *
 *  Longer than `WALK_CAP_MS` on purpose. Removing a card reflows the ones after
 *  it, and those walk into place over at most a walk's length; a fade that
 *  finished first would leave the wall still visibly rearranging around a gap
 *  whose cause had already gone, which reads as the wall moving on its own. This
 *  way the thing that left is still there — dimmer each frame — for the whole of
 *  the closing-over, and the last thing to finish is the last thing to be seen.
 *  Not much longer: the card is not the subject and neither is its exit. */
export const LEAVE_MS = 520;

/** The order a next/previous gesture walks the wall in.
 *
 * Territory by territory, in the order the regions were laid out, and within one
 * top row first, left to right — what you would read off the wall with your
 * eyes. Open order would have done for the flowing cards, since that is the
 * order they flow in, but a pinned card keeps its place in that list while
 * sitting anywhere on the wall, so Tab would jump backwards up the territory for
 * reasons nothing on screen explains. `laid` is already grouped by territory —
 * regions are placed one at a time — so grouping by `cwd` preserves that.
 *
 * Rows are banded to the slot pitch rather than compared by raw y: nothing
 * dropped by hand lands on the pitch exactly, and two cards side by side must
 * not order by whichever sits a pixel higher. */
export function wallOrder<T extends Placeable>(laid: Laid<T>[]): T[] {
  const groups = new Map<string, Laid<T>[]>();
  for (const n of laid) {
    const g = groups.get(n.conv.cwd);
    if (g) g.push(n);
    else groups.set(n.conv.cwd, [n]);
  }
  const out: T[] = [];
  for (const g of groups.values()) {
    /* A copy: `laid` is the wall's own array and its order means something to
       the paint (stacking among equal z, and Svelte's keyed blocks). */
    const rows = [...g].sort(
      (a, b) => Math.round(a.y / SLOT_H) - Math.round(b.y / SLOT_H) || a.x - b.x,
    );
    for (const n of rows) out.push(n.conv);
  }
  return out;
}

/** Frame everything with a comfortable margin. */
export function fitViewport(
  regions: Region[],
  viewW: number,
  viewH: number,
): { x: number; y: number; scale: number } {
  if (regions.length === 0) return { x: 0, y: 0, scale: 1 };
  const minX = Math.min(...regions.map((r) => r.x));
  const minY = Math.min(...regions.map((r) => r.y));
  const maxX = Math.max(...regions.map((r) => r.x + r.w));
  const maxY = Math.max(...regions.map((r) => r.y + r.h));
  const pad = 56;
  const scale = clamp(
    Math.min(
      (viewW - pad * 2) / Math.max(1, maxX - minX),
      (viewH - pad * 2) / Math.max(1, maxY - minY),
    ),
    MIN_SCALE,
    1.15,
  );
  return {
    scale,
    x: (viewW - (maxX - minX) * scale) / 2 - minX * scale,
    y: (viewH - (maxY - minY) * scale) / 2 - minY * scale,
  };
}

export function lodFor(scale: number): Lod {
  return scale < 0.62 ? "field" : scale < 1.24 ? "wall" : "open";
}


/* ── where a pinned image goes ────────────────────────
 *
 * An agent that has made something to look at puts it on the wall through
 * `pin.rs`, which copies the file and leaves the placing to the wall — the
 * argument for that split is at the top of that file. This is the placing.
 *
 * It used to be one line: the card's corner plus a gap, every time. Which is
 * right for the first image and wrong for the second, because the second landed
 * on top of the first, and the third on top of both. A card that pinned six
 * frames of a render put up one visible rectangle with five invisible ones
 * underneath it — which from the wall reads as the app having thrown five of
 * them away. Reported as images spawning on top of each other at a random
 * location, and the "random" half is the same fact seen from further off: a
 * picture arriving at a spot nobody chose, indistinguishable from the last one.
 *
 * **The size has to be known before the spot is chosen**, and that is the one
 * structural thing here. Nothing on this machine knows how big a PNG is without
 * decoding one except the webview, so this cannot run in Rust and it cannot run
 * in `Skein.spotBeside` either — both of those would have to reserve a
 * nominal square of the largest edge an image is scaled to, which is wider than
 * the step between two landscape images and therefore rejects every candidate
 * next to a taken one. Tried, and it walked in a way nobody could predict. So
 * `Board.#place` measures first and hands the real box down to this, which
 * makes both the collision test and the step exact.
 */

/** The gap between a card and the first thing pinned beside it, and between two
 *  pinned images. Enough that neither pair touches at any density and small
 *  enough that the pairing is obvious. */
export const PIN_GAP = 32;

/** Longest edge a freshly dropped, pasted or pinned image is scaled to.
 *
 *  Big enough to read, small enough that dropping a 6000px photo does not
 *  swallow the studio. Here rather than in `images.svelte.ts`, where it lived,
 *  because it bounds the step `pinSpot` takes and the two must be one number. */
export const DROP_MAX_EDGE = 420;

/** How many pins go in a row beside a card before one starts underneath.
 *
 *  Three, so a card that keeps pinning builds a block that stays roughly square
 *  instead of a line. One column would march straight down through every row of
 *  cards beneath it, and an unbounded row would end up a screen away from the
 *  card it belongs to at any zoom that shows the wall.
 *
 *  It does not keep the pins clear of other territories, and no number would:
 *  a territory is `REGION_W` wide and a single image is nearly that on its own,
 *  so the first pin already reaches past the edge of the one it stands in. That
 *  is accepted rather than solved — references live in the z-band below the
 *  work (`nextBackZ`), so a pin over somebody else's cards is behind them, and
 *  the wall is yours to drag. */
export const PIN_COLS = 3;

/** How many candidates are tried before it gives up and stacks after all.
 *
 *  Bounded so that a wall with three hundred images on it cannot make a pin
 *  take a noticeable moment. Six rows is eighteen tries, which is more than
 *  `pin.rs`'s rate limit allows a card to put up in four minutes. */
const PIN_TRIES = PIN_COLS * 6;

/** Where to put an image down beside a card, clear of what is already there.
 *
 *  Returns the **centre**, because that is what the drop path takes: an image
 *  is dropped centred on the point you aimed at, and a pin goes through the same
 *  path as a drop for the reasons `images.svelte.ts` gives.
 *
 *  The first candidate is the card's corner plus a gap, which is exactly where
 *  a pin has always landed — so nothing about a wall with one image on it
 *  moves. The walk from there is rightwards, because directly below a card is
 *  the next row of cards and to its left is where the territory's next column
 *  opens.
 *
 *  Gives up after `PIN_TRIES` and returns the last candidate rather than
 *  refusing. Same judgement `spotBeside` already makes about a card the layout
 *  does not know: a visible wrong answer is worth more than a file in storage
 *  with nothing drawn, because a wrong answer can be dragged. */
export function pinSpot(
  card: { x: number; y: number },
  taken: Box[],
  size: { w: number; h: number },
): { x: number; y: number } {
  const first = {
    x: card.x + CARD_W + PIN_GAP + size.w / 2,
    y: card.y + PIN_GAP + size.h / 2,
  };
  let last = first;
  for (let i = 0; i < PIN_TRIES; i += 1) {
    const at = {
      x: first.x + (i % PIN_COLS) * (size.w + PIN_GAP),
      y: first.y + Math.floor(i / PIN_COLS) * (size.h + PIN_GAP),
    };
    last = at;
    /* The candidate is a centre and the boxes are corners, so what is tested is
       the rectangle this image will actually occupy. */
    const box: Box = {
      x: at.x - size.w / 2,
      y: at.y - size.h / 2,
      w: size.w,
      h: size.h,
    };
    if (!taken.some((t) => touches(box, t))) return at;
  }
  return last;
}
