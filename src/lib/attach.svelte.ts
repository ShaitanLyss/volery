import { invoke } from "@tauri-apps/api/core";
import {
  MAX_ATTACHED,
  MAX_BYTES,
  MAX_SIDE,
  THUMB_SIDE,
  encodeAs,
  mediaTypeOf,
  nameFromFile,
  pastedName,
  scaleTo,
  stillIn,
  tokenFor,
  uniqueName,
  type Attachment,
  type MediaType,
} from "./attach";

/** The images hanging off one draft — the bytes, the decoding, and the scaling.
 *
 *  The pure half is `attach.ts` and holds everything that is a fold over a draft
 *  and a list. This is the half that needs a DOM: an image is decoded to learn
 *  how big it is, scaled if it is over the ceiling, and re-encoded — none of
 *  which anything on this machine can do without a canvas. It is the same split
 *  `images.svelte.ts` already makes for a picture pinned to the wall, and for
 *  the same stated reason: **the only thing here that knows how big a PNG is
 *  without decoding one is the webview.**
 *
 *  ## One list, parked with the draft it belongs to
 *
 *  An attachment belongs to the sentence it is written into, so it is parked
 *  and handed back exactly as the text is (`drafts.ts`). That is not a
 *  convenience — the dock is one field over a wall of cards, and an image left
 *  behind by a card switch would be sent to whoever you landed on next, which
 *  is the failure `Drafts` exists to prevent, made worse by being a picture.
 *
 *  ## Two ways in, one path afterwards
 *
 *  A paste arrives as bytes (a screen capture writes nothing to disk, which is
 *  the whole reason this feature exists); a drop arrives as a path, because
 *  Tauri hands the webview real filesystem paths and there is no `fs` plugin
 *  here to read one with. `read_attachment` in `attach.rs` is the bridge, and
 *  from `#take` onwards the two are the same. */
export class Attachments {
  /** What is attached to the draft in the field right now. */
  list = $state<Attachment[]>([]);

  /** Why the last intake refused something, for one reading in the dock. Set on
   *  a refusal and cleared by the next successful one — a message about a file
   *  you dropped a minute ago is noise. */
  refused = $state<string | null>(null);

  /** True while bytes are being decoded. A 4K capture takes a beat to scale, and
   *  a dock that shows nothing in that beat reads as a paste that did not
   *  land. */
  busy = $state(false);

  #seq = 0;

  get names(): string[] {
    return this.list.map((a) => a.name);
  }

  get any(): boolean {
    return this.list.length > 0;
  }

  /** Hand the whole list over — a card switch parking it, or handing it back. */
  take(): Attachment[] {
    const held = this.list;
    this.list = [];
    this.refused = null;
    return held;
  }

  put(list: Attachment[]) {
    this.list = list;
    this.refused = null;
  }

  /** Drop everything, for a send that has left or a draft that was cleared. */
  clear() {
    this.list = [];
    this.refused = null;
    this.busy = false;
  }

  /** Forget attachments the draft no longer mentions.
   *
   *  Deleting a token *is* the detach gesture, so this runs off the text rather
   *  than off a button. Called on every keystroke, so it must not allocate a new
   *  array when nothing changed — a fresh array each time is a `$state` write
   *  each time, and everything reading the strip would redraw on every
   *  character typed. */
  prune(text: string) {
    const kept = stillIn(text, this.list);
    if (kept.length !== this.list.length) this.list = kept;
  }

  /** Take images off a paste. Returns the tokens to write into the draft, in
   *  the order they arrived. */
  async fromFiles(files: readonly File[]): Promise<string[]> {
    const out: string[] = [];
    this.busy = true;
    try {
      for (const f of files) {
        const media = mediaTypeOf(f.type, f.name);
        if (!media) {
          /* Said rather than skipped. A `bmp` on the clipboard is a perfectly
             ordinary thing to have copied, and it *can* be pinned to the wall —
             the API is what will not take it (`attach.ts::MEDIA`). Passing over
             it in silence would read as the paste having failed to register at
             all, which is the one thing a gesture must never look like. */
          this.refused = `${f.name || "that image"} is a kind the agent cannot be sent (${f.type || "unknown"})`;
          continue;
        }
        if (!this.#room()) break;
        const token = await this.#take(f, media, f.name ? nameFromFile(f.name) : "");
        if (token) out.push(token);
      }
    } finally {
      this.busy = false;
    }
    return out;
  }

  /** Take images off a drop, which arrives as filesystem paths. */
  async fromPaths(paths: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    this.busy = true;
    try {
      for (const path of paths) {
        if (!this.#room()) break;
        let read: { media_type: string; data: string };
        try {
          read = await invoke("read_attachment", { path });
        } catch (err) {
          this.refused = String(err);
          continue;
        }
        const media = mediaTypeOf(read.media_type, path);
        if (!media) continue;
        /* Rust already answered in base64, so it is handed straight through as
           `ready` — decoding it here only to encode it again would cost two
           passes over a multi-megabyte string for a file that usually needs no
           re-encoding at all. The blob is still needed, to be decoded for its
           dimensions and its thumbnail. */
        const token = await this.#take(
          new Blob([bytesOf(read.data) as BlobPart], { type: media }),
          media,
          nameFromFile(path),
          read.data,
        );
        if (token) out.push(token);
      }
    } finally {
      this.busy = false;
    }
    return out;
  }

  /** Is there room for one more? Says so once, rather than per file, so a folder
   *  dropped by accident produces one sentence instead of eighty. */
  #room(): boolean {
    if (this.list.length < MAX_ATTACHED) return true;
    this.refused = `${MAX_ATTACHED} images is the most one prompt carries — the rest were left`;
    return false;
  }

  /** Decode, scale if it is over the ceiling, re-encode, and keep a thumbnail.
   *
   *  Returns the token to write into the draft, or null if it could not be
   *  used — a corrupt file, or one still over `MAX_BYTES` after scaling. */
  async #take(
    source: Blob,
    media: MediaType,
    suggested: string,
    ready?: string,
  ): Promise<string | null> {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(source);
    } catch {
      /* The one honest thing to say. A file the webview cannot decode is not
         one the API is going to do better with, and sending it would spend an
         upload to be told the same thing in a 400. */
      this.refused = `${suggested || "that image"} could not be read`;
      return null;
    }

    try {
      const fit = scaleTo(bitmap.width, bitmap.height, MAX_SIDE);
      const out = encodeAs(media);
      let data: string;
      let w = bitmap.width;
      let h = bitmap.height;
      let size = source.size;

      if (fit) {
        /* Re-encoded only because it is too big. Everything under the ceiling
           is sent exactly as it arrived — a re-encode that changes nothing is
           still a generation of quality spent, and for a GIF it is the
           animation. */
        const blob = await draw(bitmap, fit.w, fit.h, out);
        data = await base64Of(blob);
        w = fit.w;
        h = fit.h;
        size = blob.size;
      } else {
        data = ready ?? (await base64Of(source));
      }

      if (size > MAX_BYTES) {
        this.refused = `${suggested || "that image"} is too large to send (${Math.round(size / (1024 * 1024))} MB)`;
        return null;
      }

      const name = uniqueName(
        this.names,
        suggested || pastedName(this.names),
      );
      const attachment: Attachment = {
        id: `a${++this.#seq}`,
        name,
        mediaType: fit ? out : media,
        data,
        thumb: await thumbOf(bitmap, media),
        w,
        h,
        bytes: size,
        scaled: fit !== null,
      };
      this.list = [...this.list, attachment];
      this.refused = null;
      return tokenFor(name);
    } finally {
      bitmap.close();
    }
  }
}

/** A canvas the right way up, at a given size. */
async function draw(
  bitmap: ImageBitmap,
  w: number,
  h: number,
  type: MediaType,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  /* The default is already `high` in every engine this ships on, and saying so
     is free — a downscale done with the fast filter puts aliasing on exactly the
     thin UI lines a screen capture was taken to show. */
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  return await new Promise<Blob>((res, rej) =>
    canvas.toBlob(
      (b) => (b ? res(b) : rej(new Error("could not encode"))),
      type,
      /* Only read for JPEG and WebP. 0.9 rather than the 0.92 default: at this
         size the difference is invisible and the file is a fifth smaller. */
      0.9,
    ),
  );
}

/** A small data URL for the chip and for the panel.
 *
 *  Always JPEG unless the source could have transparency, in which case PNG —
 *  a screenshot with a transparent corner drawn on white is a chip with a white
 *  corner, which reads as part of the picture. */
async function thumbOf(bitmap: ImageBitmap, media: MediaType): Promise<string> {
  const fit = scaleTo(bitmap.width, bitmap.height, THUMB_SIDE) ?? {
    w: bitmap.width,
    h: bitmap.height,
  };
  const alpha = media === "image/png" || media === "image/webp" || media === "image/gif";
  const blob = await draw(bitmap, fit.w, fit.h, alpha ? "image/png" : "image/jpeg");
  return `data:${blob.type};base64,${await base64Of(blob)}`;
}

/** Base64 without the data-URL preamble, which is what the wire wants.
 *
 *  Through `FileReader` rather than a chunked loop over the bytes: it is the
 *  one path that does not build a multi-megabyte intermediate string, and a
 *  `String.fromCharCode(...bytes)` spread over a 5 MB array overflows the call
 *  stack outright. */
function base64Of(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      res(url.slice(url.indexOf(",") + 1));
    };
    r.onerror = () => rej(r.error ?? new Error("could not read"));
    r.readAsDataURL(blob);
  });
}

function bytesOf(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
