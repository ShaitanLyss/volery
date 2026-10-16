/* A picture in the conversation: what a `show` call came to, and the bounds on
 * holding the pictures the transcript draws.
 *
 * `show.rs` is the agent's half — it validates the file, keeps a copy of a
 * picture under the studio's `shown/` and answers with a sentence naming the
 * copy. This is the panel's half of reading that sentence back, which has to
 * come out the same live and off disk: both folds land the same tool result on
 * the same call (`toolcall.ts::landed`), so `shownOf` is asked of the call and
 * of nothing else, and a card read back after a restart draws the same figure
 * it drew before.
 *
 * Pure, so it is tested directly — see test/showing.test.ts. Everything that
 * reads a file or watches the viewport is `InlinePicture.svelte`'s.
 */

import { clip } from "./classify";
import type { ToolCall } from "./toolcall";

/** The words `show.rs` puts in front of the copy's name, and the words it says
 *  a file with. Read out of the Rust by the test, so a reworded result fails
 *  there rather than drawing every figure as a refusal. */
export const KEPT_MARK = "kept as `";
export const FILE_MARK = "shown as a file";
/** Between a kept picture's width and height, in the parenthesis after its
 *  name — `kept as \`….png\` (640×360)`. The size rides in the sentence so a
 *  figure's box is exact from its first frame, live and after a restart. */
export const SIZE_MARK = "×";

export type Dims = { w: number; h: number };

/** What a figure is drawn from. A `kept` picture is the copy `show` made; the
 *  `path` beside it is the agent's own, kept so a copy the budget has since
 *  swept can fall back to the file it came from. */
export type Shown =
  /** The call has not landed yet. */
  | { state: "pending"; path: string; caption: string }
  | { state: "picture"; path: string; caption: string; kept: string; size?: Dims }
  /** Not a picture: drawn as a plate that opens it. */
  | { state: "file"; path: string; caption: string }
  /** The tool said no, and `why` is its sentence. */
  | { state: "refused"; path: string; caption: string; why: string };

/** How much of a caption is drawn. A caption is a line under a picture, and a
 *  paragraph put there is the agent's reply in the wrong place — it is still
 *  in the call's arguments, whole, for anybody who opens them. */
export const CAPTION_MOST = 280;

/** The name `show.rs::keep` gives a copy: a v4 uuid and a picture's extension,
 *  and nothing else — which is also what keeps `read_shown` in its directory. */
const KEPT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpe?g|gif|webp|bmp|avif|svg)$/;

export const isKeptName = (id: string): boolean => KEPT.test(id);

/** What one `show` call came to. */
export function shownOf(call: ToolCall): Shown {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const path = typeof input.path === "string" ? input.path.trim() : "";
  const caption =
    typeof input.caption === "string" ? clip(input.caption, CAPTION_MOST) : "";
  const result = call.result;
  if (!result) return { state: "pending", path, caption };
  const text = result.text ?? "";
  if (!result.failed) {
    /* The copy's name is on a line of its own at the very end of a success,
       and that is the only place it is looked for. A file's name is in the
       sentence above it and a name can be written to look like a mark, so a
       mark found anywhere else in the text is not believed (found in review). */
    const last = text.trimEnd().split("\n").pop() ?? "";
    /* `KEPT_MARK` holds nothing a pattern treats specially, which the test
       that reads it out of the Rust also holds it to. */
    const m = new RegExp(`^${KEPT_MARK}([^\`]+)\`(?: \\((\\d{1,5})${SIZE_MARK}(\\d{1,5})\\))?$`).exec(
      last.trim(),
    );
    if (m && isKeptName(m[1])) {
      const w = Number(m[2]);
      const h = Number(m[3]);
      return w > 0 && h > 0
        ? { state: "picture", path, caption, kept: m[1], size: { w, h } }
        : { state: "picture", path, caption, kept: m[1] };
    }
    if (text.startsWith(FILE_MARK)) return { state: "file", path, caption };
  }
  return { state: "refused", path, caption, why: text.trim() || "nothing was said" };
}

/** A file's own name, for a plate and for a sentence about it. */
export function nameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/* ── holding pictures ─────────────────────────────────────────────────────
 *
 * A picture in a transcript is always open, unlike one in a tool call's fold —
 * so the fold's argument (decoding is paid for by a click) does not reach it,
 * and the bound has to come from somewhere else. It comes from two places:
 * `InlinePicture` holds bytes only while it is near the part of the column you
 * can see, and what it lets go of is kept here up to a budget, so scrolling
 * back over a figure is not a read every time. */

/** Characters of `data:` URL the cache may hold — about 24 MB of pictures.
 *  Spent on kept copies only: a copy never changes, so a cached one is never
 *  stale. A picture read from a path is not cached, because the file at a path
 *  does change — an agent writes `chart.png` again and shows it in its next
 *  message, and a cache keyed on the path would draw the old render there. */
export const CACHE_CHARS = 24_000_000;

/** Least recently used goes first, by characters held rather than by count —
 *  one 4K screenshot outweighs a hundred charts. A value bigger than the whole
 *  budget is not held at all, rather than emptying the cache to fit. */
export class PictureCache {
  #map = new Map<string, string>();
  #used = 0;
  constructor(readonly budget: number = CACHE_CHARS) {}

  get used(): number {
    return this.#used;
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: string): string | undefined {
    const v = this.#map.get(key);
    if (v === undefined) return undefined;
    // Touched: to the back of the line.
    this.#map.delete(key);
    this.#map.set(key, v);
    return v;
  }

  put(key: string, url: string): void {
    const had = this.#map.get(key);
    if (had !== undefined) {
      this.#map.delete(key);
      this.#used -= had.length;
    }
    if (url.length > this.budget) return;
    this.#map.set(key, url);
    this.#used += url.length;
    for (const [k, v] of this.#map) {
      if (this.#used <= this.budget) break;
      this.#map.delete(k);
      this.#used -= v.length;
    }
  }
}

/** What a picture measured the last time it was drawn, so a figure that lets
 *  go of its bytes — or is drawn again after the column is rebuilt — keeps the
 *  box it had. Without it every figure re-entering the view would arrive at
 *  zero height and grow, which moves everything under it and the scroll anchor
 *  with it: the reading sliding about for no reason anybody could see. Bounded,
 *  since it is keyed on every picture a wall left up for a week has drawn. */
export const SIZES_MOST = 2_000;

export class Sizes {
  #map = new Map<string, { w: number; h: number }>();
  constructor(readonly most: number = SIZES_MOST) {}

  get(key: string): { w: number; h: number } | undefined {
    return this.#map.get(key);
  }

  set(key: string, w: number, h: number): void {
    if (!(w > 0 && h > 0)) return;
    this.#map.delete(key);
    this.#map.set(key, { w, h });
    while (this.#map.size > this.most) {
      const first = this.#map.keys().next().value;
      if (first === undefined) break;
      this.#map.delete(first);
    }
  }
}

/** How tall a picture may stand in the column before it is drawn smaller, in
 *  ems of the reading — so it scales with the reading size like everything
 *  else in the panel. A tall screenshot drawn at the column's full width would
 *  otherwise be several screens of one picture with the conversation pushed
 *  off both ends of it. */
export const TALLEST_EM = 28;

/** The width a picture is drawn at, as CSS: never wider than it is, than the
 *  column, or than would make it taller than `TALLEST_EM`. With the ratio
 *  beside it this is a box that is right before a single byte has arrived.
 *
 *  **"Wider than it is" is measured in device pixels.** A raster picture is
 *  drawn at most one of its pixels per pixel of the screen — `w / dpr` CSS
 *  pixels — so on a 150% display a 640-pixel chart stands 427 CSS pixels wide
 *  and every one of its pixels lands on one of the screen's: sharp, where the
 *  browser's default of one picture pixel per CSS pixel would have blown it up
 *  by half and smeared it. Never upscaled, only ever brought down to fit; the
 *  full-size view (`Lightbox.svelte`) is where a picture is looked at closer.
 *  An svg is the exception and is passed `dpr` 1: its size *is* CSS pixels by
 *  definition, and it is sharp at any scale. */
export function frameWidth(w: number, h: number, dpr = 1): string {
  const px = w / (dpr > 0 ? dpr : 1);
  return `min(${Math.round(px * 100) / 100}px, 100%, calc(${TALLEST_EM}em * ${(w / h).toFixed(4)}))`;
}

/** How a figure says a size, for the sentence that says why it was not drawn. */
export function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
