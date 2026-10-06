import { arrangements } from "./arrange.svelte";
import { NO_ARRANGEMENT } from "./arrange";
import {
  DOCK_SITES,
  PANEL_SITES,
  moorings,
  mooringsOf,
  nextSite,
  roomsOf,
  type Berth,
  type DockSite,
  type Moorings,
  type PanelSite,
} from "./berth";

/* Where the panel and the dock are moored, per screen arrangement.
 *
 * One for the window, so a module-level instance — the same shape as `span`
 * and `arrangements`, and for the same reason: the surfaces that lay themselves
 * out by this and the gestures that change it are not parent and child.
 *
 * **`localStorage`, not SQLite**, and that is a deliberate difference from a
 * glass spot. `studio.svelte.ts` already keeps the panel's *width* there, with
 * the argument written beside it: how this window is divided is per-machine,
 * disposable, and no business being in the database. Which edge it is divided
 * along is the same kind of fact, and splitting a berth's site from its width
 * across two stores would be the worse answer by some way.
 *
 * Keyed by arrangement for the reason a glass spot is — the edge you want the
 * transcript on is a fact about the screens in front of you — with one guard
 * the glass does not need: `last`. The real key arrives a moment after launch,
 * once the monitors have answered, and without somewhere to look in the
 * meantime the studio would draw in the default berths and then visibly jump
 * into yours. The room you were last in is very nearly always the room you are
 * in, so that is what it draws first.
 */

const STORE_KEY = "skein.berths.v1";

class Berths {
  #rooms = $state<Record<string, Moorings>>({});
  /** The arrangement whose berths were last written, for the launch frame
   *  before the monitors have answered. */
  #last = $state(NO_ARRANGEMENT);

  constructor() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const blob = JSON.parse(raw) as { rooms?: unknown; last?: unknown };
        this.#rooms = roomsOf(blob.rooms);
        this.#last = typeof blob.last === "string" ? blob.last : NO_ARRANGEMENT;
      }
    } catch {
      /* A corrupt blob is not worth failing to start over, and the default
         berths are exactly where this app has always drawn them. */
    }
  }

  /** The room being drawn: the one in front of you, or the one you were last
   *  in while that is still being worked out. */
  get key(): string {
    return arrangements.key || this.#last;
  }

  get now(): Moorings {
    return this.#rooms[this.key] ?? this.#seed();
  }

  get panel(): Berth<PanelSite> {
    return this.now.panel;
  }

  get dock(): Berth<DockSite> {
    return this.now.dock;
  }

  /** What a room that has never been moored into starts from.
   *
   *  The room you were last in rather than the defaults, which is the same
   *  "duplicated from the most similar setup" the glass does — with a cruder
   *  notion of similar, because there are two enums and a rectangle here
   *  rather than a wall's worth of arrangement, and being told your transcript
   *  is on the left when you had it on the left is the whole of the win. */
  #seed(): Moorings {
    const prev = this.#rooms[this.#last];
    return prev ? mooringsOf(JSON.parse(JSON.stringify(prev))) : moorings();
  }

  #write(m: Moorings) {
    const key = this.key;
    if (!key) {
      /* Before the monitors have answered there is no room to write to, and
         inventing one would leave a bucket under the empty key that nothing
         ever reads again. The gesture still lands — `now` reads through to the
         seed — it simply is not remembered until the arrangement settles. */
      return;
    }
    this.#rooms = { ...this.#rooms, [key]: m };
    this.#last = key;
  }

  /** Put it on the shelf.
   *
   *  Separate from the write because a mooring drag sets a berth on every
   *  pointer move, and serialising every room's moorings to `localStorage`
   *  sixty times a second to record a gesture that is not finished is the sort
   *  of thing that makes a drag feel heavy for no reason anybody asked for.
   *  Called when a gesture ends, which is the same bargain `gripUp` strikes
   *  with `studio.save`. */
  save() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({ rooms: this.#rooms, last: this.#last }),
      );
    } catch {
      /* A full or refused store costs the memory of this gesture and nothing
         else. The berth is already applied. */
    }
  }

  setPanel(patch: Partial<Berth<PanelSite>>) {
    const m = this.now;
    this.#write({ ...m, panel: { ...m.panel, ...patch } });
  }

  setDock(patch: Partial<Berth<DockSite>>) {
    const m = this.now;
    this.#write({ ...m, dock: { ...m.dock, ...patch } });
  }

  /** The keyboard's whole vocabulary: round the ring. See `nextSite`. */
  cyclePanel(): PanelSite {
    const site = nextSite(PANEL_SITES, this.panel.site);
    this.setPanel({ site });
    this.save();
    return site;
  }

  cycleDock(): DockSite {
    const site = nextSite(DOCK_SITES, this.dock.site);
    this.setDock({ site });
    this.save();
    return site;
  }
}

export const berths = new Berths();
