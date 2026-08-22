/* Reference images pinned to the wall.
 *
 * Deliberately not tied to a project. A reference board is personal and spans
 * everything you are working on — a colour study sits next to a UI screenshot
 * next to a photo of a real object, and none of them belong to a repo.
 *
 * Unlike a card, an image is never auto-placed. It carries its own size and
 * rotation because *you* put it there, at that angle, at that size, and that
 * arrangement is the information. */

import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  type Box,
  DROP_MAX_EDGE,
  nextBackZ,
  nextFrontZ,
  pinSpot,
} from "./layout";
import { NO_SCRIBE, type Scribe } from "./undo";
import { NO_PICKS, type Picker } from "./pick";

/** A point in canvas space. */
type Spot = { x: number; y: number };

export type RefImage = {
  id: string;
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  z: number;
  /** Where it is drawn if it has been stuck to the glass, in screen pixels, or
   *  null for one that is on the wall. Never a substitute for `x`/`y` — see the
   *  note at the top of `glass.ts`. */
  glassX: number | null;
  glassY: number | null;
  /** The card that pinned it, or null for one you put up yourself.
   *
   *  A permission rather than a provenance note: it is what says whether a
   *  `repin` from an agent may touch this row. See `store::migrate_v21`. */
  pinnedBy: string | null;
};

export class Board {
  images = $state<RefImage[]>([]);
  fault = $state<string | null>(null);

  /** The z of everything else hand-placed on the wall — the widgets.
   *
   *  There is one stacking order for the whole wall (`layout.ts`), so "bring to
   *  front" has to mean in front of everything rather than in front of the
   *  other images. Injected because neither list may own the other. */
  others: () => number[] = () => [];

  /** Where an undoable change is written down — the same arrangement `Widgets`
   *  has, and for the same reason: recorded from in here, so every route to an
   *  image is undoable by existing. See `undo.svelte.ts`. */
  scribe: Scribe = NO_SCRIBE;

  /** What is picked on the wall. Injected for the reason `scribe` is: an image
   *  that has just been put up is the thing you are holding, and there is one
   *  selection for the whole wall rather than one per registry â€” see the note
   *  over `Studio.picks`. */
  picks: Picker = NO_PICKS;

  #saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async load() {
    try {
      this.images = await invoke<RefImage[]>("list_images");
      /* And now that the rows have been read, the files that no row claims can
         go. `delete_image` deliberately leaves the copy on disk so a removal is
         undoable, and the undo stack does not survive a restart — so this is
         exactly the moment nothing can want them back. Fire and forget: a sweep
         that fails is some wasted disk, not a wall that will not paint. */
      void invoke("sweep_references").catch(() => {});
    } catch (err) {
      this.fault = String(err);
    }
  }

  /** Where the file actually lives, as something an <img> can load. */
  src(img: RefImage): string {
    return convertFileSrc(img.path);
  }

  /** Read the intrinsic size so a dropped image arrives at its own aspect
   *  ratio rather than a guessed box. */
  async #measure(src: string): Promise<{ w: number; h: number }> {
    return new Promise((resolve) => {
      const el = new Image();
      el.onload = () => resolve({ w: el.naturalWidth, h: el.naturalHeight });
      el.onerror = () => resolve({ w: DROP_MAX_EDGE, h: DROP_MAX_EDGE });
      el.src = src;
    });
  }

  /** Import a file from disk and place it at a point in canvas space. */
  async add(srcPath: string, atX: number, atY: number): Promise<RefImage | null> {
    try {
      const stored = await invoke<string>("import_image", { src: srcPath });
      return await this.#place(stored, { x: atX, y: atY });
    } catch (err) {
      this.fault = String(err);
      return null;
    }
  }

  /** Pin up bytes that came off the clipboard rather than out of a file.
   *
   *  A screenshot is the case this exists for: Windows' capture tools leave a
   *  bitmap on the clipboard and nothing on disk, so there is no path for `add`
   *  to copy. Rust writes the bytes into the same `references` directory and
   *  hands back a path, so from there on this *is* `add`. */
  async paste(
    bytes: ArrayBuffer,
    atX: number,
    atY: number,
  ): Promise<RefImage | null> {
    try {
      /* The bytes are the whole payload rather than a field in one — that is
         what puts them on Tauri's raw-body path instead of through a JSON array
         of numbers, which for a screenshot is millions of characters. */
      const stored = await invoke<string>("paste_image", bytes);
      return await this.#place(stored, { x: atX, y: atY });
    } catch (err) {
      this.fault = String(err);
      return null;
    }
  }

  /** Put up an image an *agent* made, already copied into storage by `pin.rs`.
   *
   *  Through the same `#place` as everything else, which is the whole point of
   *  it being a separate method rather than a branch: a pinned image, a dropped
   *  file and a pasted screenshot arrive at the same size, in the same z-band,
   *  and on the same undo stack. Rust does the copying and cannot do the sizing
   *  — only the webview knows how big a PNG is without decoding one — so this
   *  is the other half of that split, and the note at the top of `pin.rs` is the
   *  argument for it.
   *
   *  Unlike a drop it is given a **card** rather than a point, and picks the
   *  point itself once the size is known. Nobody aimed at anything here, so
   *  there is a spot to choose, and choosing it needs the box: every pin used to
   *  land on the card's corner plus a gap and therefore on top of the last one.
   *  `pinSpot` is the walk and the argument for its shape. */
  async pinned(
    stored: string,
    cardX: number,
    cardY: number,
    mark: { id: string; by: string },
  ): Promise<RefImage | null> {
    try {
      return await this.#place(
        stored,
        (w, h) => pinSpot({ x: cardX, y: cardY }, this.#boxes(), { w, h }),
        mark,
      );
    } catch (err) {
      this.fault = String(err);
      return null;
    }
  }

  /** What every image on the wall occupies, for a pin to be placed clear of.
   *
   *  Every one of them, not only the ones an agent pinned: something you dragged
   *  into the gap beside a card is exactly as much in the way as something the
   *  wall put there. An image stuck to the glass is included too — it is drawn
   *  in screen space but it still holds the ground it came from, which is the
   *  rule `glass.ts` states for everything else on the wall. */
  #boxes(): Box[] {
    return this.images.map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h }));
  }

  /** Everything after "there is now a file in our own storage": size it, put it
   *  on the wall, write the row. Shared, or a pasted image and a dropped one
   *  would arrive at different sizes and in different bands. */
  async #place(
    stored: string,
    at: Spot | ((w: number, h: number) => Spot),
    mark?: { id: string; by: string },
  ): Promise<RefImage> {
    const url = convertFileSrc(stored);
    const nat = await this.#measure(url);
    const scale = DROP_MAX_EDGE / Math.max(nat.w, nat.h);
    const w = Math.round(nat.w * Math.min(1, scale));
    const h = Math.round(nat.h * Math.min(1, scale));
    /* A point for a drop, which aimed at one, and a function for a pin, which
       did not and needs the box to work out where there is room. Resolved here
       rather than by the caller because here is the first moment the size is
       known — see `pinSpot`. */
    const spot = typeof at === "function" ? at(w, h) : at;

    const img: RefImage = {
      /* An agent's pin arrives already named, because `pin.rs` minted the id in
         order to *say* it — which is what lets the same card change this image
         later rather than putting up a second copy of it. Anything you dropped
         or pasted is named here, as it always was. */
      id: mark?.id ?? crypto.randomUUID(),
      pinnedBy: mark?.by ?? null,
      path: stored,
      /* Drop centred on the cursor — you aimed at a spot, not a corner. */
      x: spot.x - w / 2,
      y: spot.y - h / 2,
      w,
      h,
      rotation: 0,
      /* On the wall, like everything else that arrives. The glass is somewhere
         you put a thing on purpose, never somewhere a thing lands. */
      glassX: null,
      glassY: null,
      /* A reference lands behind the work by default — it is something to
         look at while you do the work, not something over it. */
      z: nextBackZ(this.#stack()),
    };
    this.images = [...this.images, img];
    /* An edit from nothing, recorded before the write for the reason
       `Widgets.add` is: a save that fails still leaves something on the wall,
       and it should be something you can take back. */
    this.scribe.did("pinning up an image", [
      { at: "image", id: img.id, was: null, now: { ...img } },
    ]);
    await invoke("save_image", { image: img });
    this.picks.only("image", img.id);
    return img;
  }

  /** Apply what an agent asked to change about an image it pinned.
   *
   *  Whether it *may* is settled before this is called: `pin.rs` refuses a row
   *  whose `pinned_by` is not the calling card, so what arrives here is a change
   *  to something that card put up. This is only the doing of it, which is the
   *  same division `pinned` draws and the same one `pin.rs`'s module note argues
   *  for.
   *
   *  A new file is **re-measured**, and that is the whole reason this cannot be
   *  a `save_image` from Rust: a newer render is very often a different shape,
   *  and reusing the old box would stretch it. Kept centred where it was, so an
   *  image that changes aspect ratio grows or shrinks about its middle instead of
   *  walking across the wall a version at a time.
   *
   *  Every arm goes through `update` or `remove`, so all of it is undoable and
   *  all of it saves the same way a drag does. An agent changing the wall must be
   *  as takeable-back as you changing it. */
  async repinned(
    id: string,
    change: {
      path: string | null;
      place: string | null;
      remove: boolean;
      card: Spot;
    },
  ) {
    const img = this.images.find((i) => i.id === id);
    /* Gone between the ask and the answer — the user took it down while the
       agent was mid-turn. Nothing to say to the card: the tool has already
       answered it, and the wall is the user's. */
    if (!img) return;
    if (change.remove) {
      await this.remove(id);
      return;
    }

    let box = { w: img.w, h: img.h };
    if (change.path) {
      const nat = await this.#measure(convertFileSrc(change.path));
      const scale = DROP_MAX_EDGE / Math.max(nat.w, nat.h);
      box = {
        w: Math.round(nat.w * Math.min(1, scale)),
        h: Math.round(nat.h * Math.min(1, scale)),
      };
    }

    const patch: Partial<RefImage> = {};
    if (change.path) {
      const midX = img.x + img.w / 2;
      const midY = img.y + img.h / 2;
      patch.path = change.path;
      patch.w = box.w;
      patch.h = box.h;
      patch.x = midX - box.w / 2;
      patch.y = midY - box.h / 2;
    }
    if (change.place === "beside the card") {
      /* Clear of everything except itself: an image asked to go back beside its
         card must not be told the spot it is standing in is taken. */
      const others = this.images
        .filter((i) => i.id !== id)
        .map((i) => ({ x: i.x, y: i.y, w: i.w, h: i.h }));
      const spot = pinSpot(change.card, others, box);
      patch.x = spot.x - box.w / 2;
      patch.y = spot.y - box.h / 2;
      /* And off the glass, or it would be moved somewhere it is not drawn —
         which is the trap the note at the top of `glass.ts` describes. */
      patch.glassX = null;
      patch.glassY = null;
    } else if (change.place === "to the front") {
      patch.z = nextFrontZ(this.#stack());
    } else if (change.place === "to the back") {
      patch.z = nextBackZ(this.#stack());
    }
    this.update(id, patch);
    this.picks.only("image", id);
  }

  update(id: string, patch: Partial<RefImage>) {
    const i = this.images.findIndex((x) => x.id === id);
    if (i < 0) return;
    const was = $state.snapshot(this.images[i]);
    const next = { ...this.images[i], ...patch };
    this.images[i] = next;
    this.#saveSoon(next);
    this.scribe.note("image", id, was, $state.snapshot(next), patch);
  }

  /** Put one back exactly as it was — what undo needs, and the one write that
   *  has to cope with the image no longer being on the wall (an undone
   *  removal). Never recorded: this *is* the recording being played. */
  put(img: RefImage) {
    const i = this.images.findIndex((x) => x.id === img.id);
    if (i < 0) this.images = [...this.images, { ...img }];
    else this.images[i] = { ...img };
    this.#saveSoon(img);
  }

  /** In front of everything on the wall — cards, territory chips and widgets
   *  included, which it could not manage while it only outranked other
   *  images. */
  bringToFront(id: string) {
    this.update(id, { z: nextFrontZ(this.#stack()) });
  }

  #stack(): number[] {
    return [...this.images.map((i) => i.z), ...this.others()];
  }

  /** Manipulating an image fires continuously; the database only needs the
   *  place it came to rest. */
  #saveSoon(img: RefImage) {
    clearTimeout(this.#saveTimers.get(img.id));
    this.#saveTimers.set(
      img.id,
      setTimeout(() => {
        void invoke("save_image", { image: $state.snapshot(img) }).catch(() => {});
      }, 250),
    );
  }

  async remove(id: string) {
    /* Drop any queued save first, or it lands *after* the delete and puts the
       row straight back — pointing at a file we have just removed. Selecting an
       image is itself an update (it comes to the front), so "click an image,
       press Delete" was enough: the image vanished, then came back as a broken
       rectangle on the next launch, and deleting it again did the same thing. */
    clearTimeout(this.#saveTimers.get(id));
    this.#saveTimers.delete(id);

    /* Undoable, which is why `delete_image` no longer takes the file with the
       row — see the note over `load`'s sweep. */
    const was = this.images.find((i) => i.id === id);
    if (was) {
      this.scribe.did("removing an image", [
        { at: "image", id, was: $state.snapshot(was), now: null },
      ]);
    }
    this.images = this.images.filter((i) => i.id !== id);
    this.picks.drop("image", id);
    try {
      await invoke("delete_image", { id });
    } catch (err) {
      this.fault = String(err);
    }
  }
}
