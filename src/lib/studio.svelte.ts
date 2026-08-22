/* The canvas viewport: where you are looking, and what you have pinned.
 * The placement rules themselves are pure and live in ./layout.ts. */

import {
  MAX_SCALE,
  MIN_SCALE,
  clamp,
  fitViewport,
  lodFor,
  readingScale,
  type Lod,
  type Placement,
  type Region,
} from "./layout";
import { spotOf } from "./glass";
import {
  dedupe,
  has as hasPick,
  idsOf,
  keyOf,
  withoutKind,
  type Kind,
  type Pick,
} from "./pick";

export * from "./layout";

const STORE_KEY = "skein.studio.v1";

export class Studio {
  /* viewport, in screen pixels */
  x = $state(0);
  y = $state(0);
  scale = $state(1);

  /** How wide the reading panel has been dragged, in screen pixels, or null
   *  while nobody has touched it — see `panelWidth`. Kept here because it is
   *  the other half of how the window is divided, and because it is the same
   *  kind of thing as the viewport: per-machine, disposable, and no business
   *  being in the database. */
  panelW = $state<number | null>(null);

  /** How large the transcript is drawn, as a multiplier, or null while nobody
   *  has changed it — see `readingScale`. Here for exactly the reasons
   *  `panelW` is: it is how this window has been set up to be read from,
   *  per-machine and disposable, and not a thing you made. Independent of the
   *  width on purpose — see the note in layout.ts. */
  readScale = $state<number | null>(null);

  /** Placements by conversation id. Only pinned entries actually matter —
   *  unpinned cards are recomputed by the layout every time. */
  placements = $state<Record<string, Placement>>({});

  /** Semantic zoom. One continuous gesture, three densities: the constellation
   *  you take in at a glance, the working wall, and a card opened far enough
   *  to read. */
  lod = $derived<Lod>(lodFor(this.scale));

  /** Everything picked on the wall, in the order it was picked.
   *
   *  **One selection, spanning all four kinds** — a card, a project's
   *  territory, a widget, a reference image. It was three: this list held card
   *  ids alone, `Board.selected` held one image, `Widgets.selected` held one
   *  widget, and the two singletons deliberately cleared each other so Delete
   *  had an unambiguous target. Three selections none of which could hold two
   *  things of different kinds, so "these two cards and that reference, moved
   *  together" was not a sentence the wall could say. The algebra — what each
   *  modifier means, what a marquee replaces, what a drag carries — is pure and
   *  lives in `pick.ts`; this is only where it is kept.
   *
   *  An array rather than a Set because Svelte's reactivity tracks assignment,
   *  and the order is the order you picked things in, which is the order the
   *  dock lists the gathering in.
   *
   *  A pick naming something that has since gone is harmless and is not swept:
   *  every reader asks the wall for the thing and finds nothing, which is what
   *  a closed card's id has always done to the gathering. */
  picks = $state<Pick[]>([]);

  /** The picked cards — the gathering a prompt is aimed at.
   *
   *  Derived rather than stored, so there is one selection and not two that can
   *  drift. Everything that read this before reads it unchanged: the dock's
   *  targets, the cards that wear the draft as their name-to-be, and
   *  `snapshot.selected`. */
  selected = $derived(idsOf(this.picks, "card"));

  isSelected(id: string): boolean {
    return this.isPicked("card", id);
  }

  isPicked(kind: Kind, id: string): boolean {
    return hasPick(this.picks, { kind, id });
  }

  /** The ids of everything held of one kind, in the order it was picked.
   *  `selected` is this for cards, named as the dock has always named it. */
  pickedOf(kind: Kind): string[] {
    return idsOf(this.picks, kind);
  }

  selectOnly(id: string) {
    this.only("card", id);
  }

  /** Pick exactly these cards and nothing else. The control surface's
   *  `card.select` op, which used to assign the list directly. */
  pickCards(ids: string[]) {
    this.picks = dedupe(ids.map((id) => ({ kind: "card" as const, id })));
  }

  clearSelection() {
    this.picks = [];
  }

  /* ── the `Picker` the wall's other two registries are handed ──────────────
   *
   * `Board` and `Widgets` each need to say "the thing I have just put up is
   * what is selected now", and neither may own the wall's selection or import
   * this file. So `Studio` satisfies `pick.ts`'s `Picker` and is injected as a
   * field, exactly the arrangement `scribe` and `others` already have in both
   * of those classes. */

  /** Pick one thing and drop everything else. */
  only(kind: Kind, id: string) {
    this.picks = [{ kind, id }];
  }

  drop(kind: Kind, id: string) {
    const k = keyOf({ kind, id });
    this.picks = this.picks.filter((p) => keyOf(p) !== k);
  }

  /** Let go of every thing of one kind. Escape backs out one kind at a time,
   *  innermost first, which is what it always did with the two singletons. */
  dropKind(kind: Kind) {
    this.picks = withoutKind(this.picks, kind);
  }

  /** Replace the whole selection. What a gesture in `pick.ts` hands back. */
  pick(sel: Pick[]) {
    this.picks = sel;
  }

  constructor() {
    this.#load();
  }

  #load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (typeof s.x === "number") this.x = s.x;
      if (typeof s.y === "number") this.y = s.y;
      if (typeof s.scale === "number") {
        this.scale = clamp(s.scale, MIN_SCALE, MAX_SCALE);
      }
      /* Not clamped here: what it is worth depends on the window it is read
         back into, which `panelWidth` is asked on every paint anyway. */
      if (typeof s.panelW === "number") this.panelW = s.panelW;
      /* Clamped on read, unlike the width: what it is worth does not depend on
         the window, so `readingScale` is the whole of the answer and there is
         no reason to carry an out-of-range number around. */
      if (typeof s.readScale === "number") {
        this.readScale = readingScale(s.readScale);
      }
    } catch {
      /* a corrupt viewport is not worth failing to start over */
    }
  }

  /** Only the viewport lives here — and the panel's edge, which is the same
   *  kind of thing.
   *
   *  Placements are studio data and belong in SQLite alongside the
   *  conversations they key on — keeping a copy in localStorage too would give
   *  us two sources of truth and a guaranteed drift. Where you are *looking*,
   *  by contrast, is pure UI state: per-machine, disposable, and not worth a
   *  database round trip on every frame of a pan. How wide you like the column
   *  you read in is a property of this screen and this pair of eyes, not of the
   *  wall, so it belongs on the same side of that line. */
  save() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          x: this.x,
          y: this.y,
          scale: this.scale,
          panelW: this.panelW,
          readScale: this.readScale,
        }),
      );
    } catch {}
  }

  pin(id: string, x: number, y: number) {
    const p = this.placements[id];
    /* The glass rides along untouched. A card can be stuck to the glass *and*
       pinned on the wall — the two answer different questions ("where is it
       drawn" and "where does it belong"), and dropping one while writing the
       other is how a territory drag would silently un-stick every card in it. */
    this.placements = {
      ...this.placements,
      [id]: { x, y, pinned: true, glassX: p?.glassX ?? null, glassY: p?.glassY ?? null },
    };
  }

  unpin(id: string) {
    const g = spotOf(this.placements[id]);
    const next = { ...this.placements };
    /* "Let it flow again" is a statement about the wall. A card on the glass
       keeps its spot there — otherwise the one menu item would quietly do two
       things, one of which nothing on screen asked for. */
    if (g) next[id] = { x: 0, y: 0, pinned: false, glassX: g.x, glassY: g.y };
    else delete next[id];
    this.placements = next;
  }

  /** Put a card's whole placement back, exactly as given.
   *
   *  The one writer here that is not a gesture, and `forget` below is the other
   *  half of it. `pin`, `unpin` and `stick` each set one side of the record and
   *  leave the other standing, which is right for the things a person does —
   *  sticking a card to the glass is not a statement about where it belongs on
   *  the wall — and wrong for putting a record back, where both sides are known
   *  and there is no intention to respect. Undo is the caller. */
  place(id: string, p: Placement) {
    this.placements = { ...this.placements, [id]: { ...p } };
  }

  /** Take a card's placement away entirely — the wall position and the glass
   *  spot together.
   *
   *  Not `unpin`, which deliberately leaves the glass spot standing, because
   *  "let it flow again" is a statement about the wall alone. Undo has no such
   *  intention to respect: it is restoring the record to *absent*, and absent
   *  means there was never a spot either. Half a record put back is a card
   *  flowing on the wall and still stuck to the pane — which is precisely what
   *  dragging a card out of a stuck territory creates, and therefore precisely
   *  what undoing that has to undo. */
  forget(id: string) {
    if (!(id in this.placements)) return;
    const next = { ...this.placements };
    delete next[id];
    this.placements = next;
  }

  /** Stick a card to the glass at a point in glass pixels, or take it off with
   *  `null`. Its wall placement is left exactly as it was, which is the whole
   *  bargain — see the note at the top of `glass.ts`. */
  stick(id: string, at: { x: number; y: number } | null) {
    const p = this.placements[id];
    if (!p && !at) return;
    const base = p ?? { x: 0, y: 0, pinned: false };
    this.placements = {
      ...this.placements,
      [id]: { ...base, glassX: at?.x ?? null, glassY: at?.y ?? null },
    };
  }

  zoomAt(screenX: number, screenY: number, factor: number) {
    const next = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
    if (next === this.scale) return;
    /* Keep the point under the cursor fixed while the world scales around it. */
    const worldX = (screenX - this.x) / this.scale;
    const worldY = (screenY - this.y) / this.scale;
    this.scale = next;
    this.x = screenX - worldX * next;
    this.y = screenY - worldY * next;
  }

  fit(regions: Region[], viewW: number, viewH: number) {
    const v = fitViewport(regions, viewW, viewH);
    this.x = v.x;
    this.y = v.y;
    this.scale = v.scale;
  }
}
