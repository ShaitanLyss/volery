import { invoke } from "@tauri-apps/api/core";
import {
  DOCUMENT,
  MAX_ATTACHED,
  MAX_BYTES,
  MAX_FILE_BYTES,
  MAX_SIDE,
  THUMB_SIDE,
  encodeAs,
  isDocument,
  mediaTypeOf,
  nameFromFile,
  pastedName,
  planFor,
  scaleTo,
  stillIn,
  tokenFor,
  turnOf,
  uniqueName,
  type Attachment,
  type Bytes,
  type Carried,
  type FileRef,
  type Picture,
  type MediaType,
  type Reach,
  type Turn,
} from "./attach";

/** What `inspect_paths` answers for one path (`attachments.rs`). */
type Inspected = { path: string; name: string; dir: boolean; size: number | null; picture: boolean; staged: boolean };

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

  /** Names other drafts already use that this one's must not repeat — the
   *  other steps of one question's sheet, whose answers are sent as one reply
   *  and whose tokens therefore share one sentence. */
  #others: () => string[];

  constructor(others: () => string[] = () => []) {
    this.#others = others;
  }

  get names(): string[] {
    return this.list.map((a) => a.name);
  }

  /** Every name a new attachment here must not take. */
  #taken(): string[] {
    return [...this.names, ...this.#others()];
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

  /** Take files off a paste, or off anything else that hands over bytes with
   *  no path: a picture is decoded and attached inline as it always was, and
   *  anything else is kept as bytes, written into the card's folder only when
   *  the prompt is sent (`ready`). Returns the tokens to write into the draft,
   *  in the order they arrived. */
  async fromFiles(files: readonly File[]): Promise<string[]> {
    const out: string[] = [];
    this.busy = true;
    try {
      for (const f of files) {
        if (!this.#room()) break;
        const media = mediaTypeOf(f.type, f.name);
        const token = media
          ? await this.#take(f, media, f.name ? nameFromFile(f.name) : "")
          : await this.#keepBytes(f);
        if (token) out.push(token);
      }
    } finally {
      this.busy = false;
    }
    return out;
  }

  /** Take whatever a drop or an Explorer copy names, which arrives as
   *  filesystem paths: a picture is read and attached inline, as the dock
   *  always did, and every other file — and a folder (decided 2026-10-18) — is
   *  attached as its path, which is what the agent is handed. */
  async fromPaths(paths: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    this.busy = true;
    try {
      let seen: Inspected[];
      try {
        seen = await invoke<Inspected[]>("inspect_paths", { paths });
      } catch (err) {
        this.refused = String(err);
        return out;
      }
      for (const it of seen) {
        if (!this.#room()) break;
        const token = it.picture ? await this.#readPicture(it.path) : this.#keepPath(it);
        if (token) out.push(token);
      }
      /* Said after the rest landed, so a success beside it does not wipe it. */
      const missing = paths.length - seen.length;
      if (missing > 0) this.refused = `${missing === 1 ? "one of those is" : `${missing} of those are`} not there any more`;
    } finally {
      this.busy = false;
    }
    return out;
  }

  /** What a paste puts in the draft: the words that came with it, and the
   *  tokens of what is attached, in that order.
   *
   *  **Read the event before anything awaits**: `clipboardData` is only valid
   *  during the event, so whatever is taken after the first `await` is gone.
   *  Then the clipboard is asked for paths (`CF_HDROP`), because a file copied
   *  in Explorer arrives in the event as a `File` with bytes and no path — and
   *  the same file dragged is passed by its path (Lyss, 2026-10-16), so pasting
   *  it must be too. Only where the clipboard names none are the bytes kept.
   *
   *  Null when the paste carries no file at all, so the caller leaves it to the
   *  field — an ordinary text paste is the browser's to do. */
  takePaste(e: ClipboardEvent): Promise<{ said: string; tokens: string[] }> | null {
    const data = e.clipboardData;
    if (!data || !data.files.length) return null;
    const files = [...data.files];
    const said = data.getData("text/plain");
    e.preventDefault();
    return (async () => {
      let paths: string[] = [];
      try {
        paths = await invoke<string[]>("clipboard_paths");
      } catch {
        /* Not knowing the paths costs a copy of the bytes, never the paste. */
      }
      /* The clipboard is read after the event, so it is asked whether it still
         holds what was pasted: as many files, by the same names. Anything else
         means it changed under us, and the bytes in hand are the truth. */
      const named = (p: string) => p.split(/[\\/]/).pop() ?? p;
      const same =
        paths.length === files.length && files.every((f, i) => !f.name || named(paths[i]!) === f.name);
      const tokens = same ? await this.fromPaths(paths) : await this.fromFiles(files);
      /* Explorer can write the copied files' names as the text beside them;
         typing those into the sentence beside their own tokens says each one
         twice. Text that came from anywhere else is kept. */
      const echoes = said.trim() !== "" && files.every((f) => f.name && said.includes(f.name));
      return { said: echoes ? "" : said, tokens };
    })();
  }

  /** The list this draft would be sent with to one target — bytes written into
   *  the card's own folder for a project card, a PDF read in to go inline for a
   *  chat card — or why it cannot go. The draft's own list is not touched, so a
   *  refusal (or a broadcast, where each card gets a folder of its own) leaves
   *  the draft exactly as it was. */
  ready(text: string, reach: Reach, card: string): Promise<Attachment[] | { refused: string }> {
    return readyFor(text, this.list, reach, card);
  }

  /** The turn this draft makes for one target: `ready`, then cut once. */
  turnFor(text: string, reach: Reach, card: string): Promise<Turn | { refused: string }> {
    return turnFrom(text, this.list, reach, card);
  }

  /** Take the pictures a prompt from another wall carried — the owning wall's
   *  half of a picture crossing the flyway (`attach.md`).
   *
   *  Through the same `#take` a paste goes through, so a picture from another
   *  machine is decoded, held to `MAX_BYTES`, scaled if it is over the edge and
   *  given its thumbnail here exactly as one pasted here would be — and one the
   *  webview cannot decode is refused for the reason it would be refused here.
   *  Rust has already checked the shape (`attach::carried_fit`); this is the
   *  check that the bytes are a picture at all.
   *
   *  Each keeps the name it was sent under, because that name is the token in
   *  the sentence that came with it. Returns why not, naming the picture, or
   *  null when every one is attached — all or nothing, since a sentence handed
   *  over with one of its pictures missing is the one thing this must not do. */
  async fromCarried(carried: readonly Carried[]): Promise<string | null> {
    this.busy = true;
    try {
      for (const c of carried) {
        const media = mediaTypeOf(c.mediaType);
        if (!media) return `${c.name} is not an image this can send`;
        if (!this.#room()) return this.refused;
        const token = await this.#take(new Blob([bytesOf(c.data) as BlobPart], { type: media }), media, c.name, c.data);
        if (!token) return this.refused ?? `${c.name} could not be read`;
        if (token !== tokenFor(c.name)) return `two pictures are both called ${c.name}`;
      }
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** Is there room for one more? Says so once, rather than per file, so a folder
   *  dropped by accident produces one sentence instead of eighty. */
  #room(): boolean {
    if (this.list.length < MAX_ATTACHED) return true;
    this.refused = `${MAX_ATTACHED} attachments is the most one prompt carries — the rest were left`;
    return false;
  }

  /** A picture named by a path: read through `attach.rs`, then decoded and
   *  scaled like a paste. Rust answers in base64 already, so it is handed
   *  straight through as `ready` — decoding it only to encode it again would
   *  cost two passes over a multi-megabyte string for a file that usually needs
   *  no re-encoding at all. */
  async #readPicture(path: string): Promise<string | null> {
    let read: { media_type: string; data: string };
    try {
      read = await invoke("read_attachment", { path });
    } catch (err) {
      this.refused = String(err);
      return null;
    }
    const media = mediaTypeOf(read.media_type, path);
    if (!media) return null;
    return this.#take(new Blob([bytesOf(read.data) as BlobPart], { type: media }), media, nameFromFile(path), read.data);
  }

  /** A file or folder, attached as its path. Nothing is read: the agent opens
   *  it with its own tools. */
  #keepPath(it: Inspected): string {
    const name = uniqueName(this.#taken(), nameFromFile(it.path) || "file");
    const file: FileRef = {
      kind: "file",
      id: `a${++this.#seq}`,
      name,
      path: it.path,
      dir: it.dir,
      size: it.size,
      ...(it.staged ? { staged: true } : {}),
    };
    this.list = [...this.list, file];
    this.refused = null;
    return tokenFor(name);
  }

  /** Bytes with no path, held in memory until the send — the rule pictures
   *  already keep: an unsent draft never touches the disk. */
  async #keepBytes(f: Blob, called = ""): Promise<string | null> {
    const label = called || (f instanceof File ? f.name : "") || "file";
    if (f.size > MAX_FILE_BYTES) {
      this.refused = `${label} is ${Math.round(f.size / (1024 * 1024))} MB — the most one attachment may be is ${MAX_FILE_BYTES / (1024 * 1024)} MB`;
      return null;
    }
    const data = await base64Of(f);
    const name = uniqueName(this.#taken(), nameFromFile(label) || "file");
    const kept: Bytes = {
      kind: "bytes",
      id: `a${++this.#seq}`,
      name,
      mediaType: f.type || (isDocument("", name) ? DOCUMENT : ""),
      data,
      bytes: f.size,
    };
    this.list = [...this.list, kept];
    this.refused = null;
    return tokenFor(name);
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
        this.#taken(),
        suggested || pastedName(this.#taken()),
      );
      const attachment: Picture = {
        kind: "picture",
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

/** A list made ready for one target — what `Attachments.ready` does for its
 *  own list, for a reply whose attachments are spread over several fields (a
 *  question's sheet). Bytes are written into the card's own folder for a
 *  project card, a PDF read in to go inline for a chat card, or the reason it
 *  cannot go is returned. The list handed in is never changed. */
export async function readyFor(
  text: string,
  list: readonly Attachment[],
  reach: Reach,
  card: string,
): Promise<Attachment[] | { refused: string }> {
  const plan = planFor(text, list, reach);
  if (plan.refused) return { refused: plan.refused };
  const swap = new Map<string, Attachment>();
  if (plan.write.length) {
    let paths: string[];
    try {
      paths = await invoke<string[]>("write_attachments", {
        card,
        files: plan.write.map((b) => ({ name: b.name, data: b.data })),
      });
    } catch (err) {
      return { refused: String(err) };
    }
    plan.write.forEach((b, i) => {
      swap.set(b.id, { kind: "file", id: b.id, name: b.name, path: paths[i]!, dir: false, size: b.bytes });
    });
  }
  if (plan.claim.length) {
    let paths: string[];
    try {
      paths = await invoke<string[]>("claim_dropped", { card, paths: plan.claim.map((f) => f.path) });
    } catch (err) {
      return { refused: String(err) };
    }
    plan.claim.forEach((f, i) => swap.set(f.id, { ...f, path: paths[i]!, staged: false }));
  }
  for (const f of plan.read) {
    try {
      const data = await invoke<string>("read_document", { path: f.path });
      swap.set(f.id, {
        kind: "bytes",
        id: f.id,
        name: f.name,
        mediaType: DOCUMENT,
        data,
        bytes: Math.floor((data.length * 3) / 4),
      });
    } catch (err) {
      return { refused: String(err) };
    }
  }
  return list.map((a) => swap.get(a.id) ?? a);
}

/** The turn a sentence and a list make for one target: ready, then cut once. */
export async function turnFrom(
  text: string,
  list: readonly Attachment[],
  reach: Reach,
  card: string,
): Promise<Turn | { refused: string }> {
  const ready = await readyFor(text, list, reach, card);
  return "refused" in ready ? ready : turnOf(text, ready, reach);
}

/* ── where a drop lands ──────────────────────────────────────────────────────
 *
 * Every input that sends text to an agent is a `PromptBox`, and a `PromptBox`
 * says it can take a drop by being mounted: it registers its root here. So the
 * drop handler asks one question of the DOM — which box is under the point —
 * and no surface wires a drop of its own. A new input gets drops by existing,
 * which is the rule CLAUDE.md states about a capability every surface should
 * have (`test/attaching.test.ts` holds it).
 *
 * The hit test is off the DOM because a Tauri drag is not a DOM drag: an OS
 * file drag fires no `dragenter` on any element — the webview swallows them so
 * the payload can carry real paths — so nothing under the cursor is told it is
 * hovered, and `elementFromPoint` is the only way to ask.
 *
 * Three ways a point reaches a box, in order:
 *
 * - **On the box itself**: the token goes in at its caret.
 * - **In an area that holds boxes** (`data-attach-area`, the dock): the first
 *   box in it, which is the one in front — a question or a notice drawn above
 *   the field comes before the field. A drop on the dock's chrome used to land
 *   in the prompt field even with a question in front of it, which is a picture
 *   meant for an answer going to a different conversation.
 * - **On a surface that stands for a named box** (`data-attach-to`, the panel,
 *   which *is* the conversation the dock's field speaks to): the token goes on
 *   the end, since a drop on the transcript aims at no word (`attach.md`). */

/** Where in the sentence a dropped thing goes. */
export type Landing = "caret" | "end";

/** What a box does with a drop. */
export type DropTarget = {
  /** `links` land as their text — a link dragged out of a browser is never
   *  fetched (`dropzone.rs`) — and `refused` is said beside the box. */
  take(paths: string[], where: Landing, links?: string[], refused?: string[]): Promise<void>;
  /** Whether a drop here means anything right now — a dock aimed at no card
   *  does not, and the drop falls through to the wall. */
  accepts?(): boolean;
};

const boxes = new WeakMap<Element, DropTarget>();
const named = new Map<string, Element>();

/** Which box a drag is over, for the one piece of feedback a drag gets. */
class Hovered {
  over = $state<Element | null>(null);
}
export const dropping = new Hovered();

/** Register a box. Returns the unregistration, so it is an attachment's whole
 *  body: `{@attach (el) => registerBox(el, target, name)}`. */
export function registerBox(el: Element, target: DropTarget, name?: string): () => void {
  boxes.set(el, target);
  if (name) named.set(name, el);
  return () => {
    boxes.delete(el);
    if (name && named.get(name) === el) named.delete(name);
    if (dropping.over === el) dropping.over = null;
  };
}

/** The box a drop at this point lands in, and where in its sentence. */
export function boxAt(x: number, y: number): { el: Element; target: DropTarget; where: Landing } | null {
  const at = document.elementFromPoint(x, y);
  if (!at) return null;
  const ok = (el: Element | null | undefined) => {
    const t = el ? boxes.get(el) : undefined;
    return t && (t.accepts?.() ?? true) ? t : null;
  };
  const own = at.closest("[data-attach]") ?? at.closest("[data-attach-area]")?.querySelector("[data-attach]") ?? null;
  const t = ok(own);
  if (own && t) return { el: own, target: t, where: "caret" };
  const to = at.closest("[data-attach-to]")?.getAttribute("data-attach-to");
  const el = to ? named.get(to) : undefined;
  const n = ok(el);
  return el && n ? { el, target: n, where: "end" } : null;
}

/* ── the drafts that are not the dock's ──────────────────────────────────────
 *
 * A question's answer and a notice's reply keep their words in `replies`,
 * keyed by the field (`replies.svelte.ts`), because the panel that draws one
 * comes and goes with the dock's queue — and the same notice can be drawn twice
 * at once, in the dock and in the away pile. Their attachments are kept the
 * same way and for the same reason: by the same key, outside any component, one
 * list per field however many panels draw it. In memory only, as every
 * attachment in a draft is (`attach.md`). */
const keptLists = new Map<string, Attachments>();

/** The attachments of the field kept under `key`. `family` is the reply they
 *  go out in together — a question's whole sheet — so a name is unique across
 *  it and the one sentence they are cut from never holds two tokens alike. */
export function attachmentsOf(key: string, family = key): Attachments {
  let a = keptLists.get(key);
  if (!a) {
    a = new Attachments(() =>
      [...keptLists].filter(([k]) => k !== key && (k === family || k.startsWith(`${family}:`))).flatMap(([, l]) => l.names),
    );
    keptLists.set(key, a);
  }
  return a;
}

/** Everything attached across one reply's fields, for the cut. */
export function attachedIn(family: string): Attachment[] {
  return [...keptLists]
    .filter(([k]) => k === family || k.startsWith(`${family}:`))
    .flatMap(([, l]) => l.list);
}

/** Let a reply's attachments go: it was sent, or taken down. */
export function forgetAttachments(family: string): void {
  for (const k of [...keptLists.keys()]) {
    if (k === family || k.startsWith(`${family}:`)) keptLists.delete(k);
  }
}

/* ── hearing a drop ──────────────────────────────────────────────────────────
 *
 * Tauri's own drag events, the ones every platform emits, heard here rather
 * than through `onDragDropEvent` for one reason: that wrapper rebuilds the
 * payload and keeps only `paths` and `position`, and on Windows the drop target
 * is Volery's own (`dropzone.rs`), which also says what a *browser* drag
 * carried — `links`, and anything it could not take (`refused`). Elsewhere the
 * two fields are simply absent. Still one path: the same four events, one
 * handler. */
export type Drag =
  | { type: "over"; position: { x: number; y: number } }
  | { type: "leave" }
  | {
      type: "drop";
      paths: string[];
      position: { x: number; y: number };
      links: string[];
      refused: string[];
    };

export async function listenDrops(handler: (d: Drag) => void): Promise<() => void> {
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  const w = getCurrentWebview();
  type Raw = { paths?: string[]; position?: { x: number; y: number }; links?: string[]; refused?: string[] };
  const offs = await Promise.all([
    w.listen<Raw>("tauri://drag-enter", (e) => handler({ type: "over", position: e.payload.position ?? { x: 0, y: 0 } })),
    w.listen<Raw>("tauri://drag-over", (e) => handler({ type: "over", position: e.payload.position ?? { x: 0, y: 0 } })),
    w.listen<Raw>("tauri://drag-drop", (e) =>
      handler({
        type: "drop",
        paths: e.payload.paths ?? [],
        position: e.payload.position ?? { x: 0, y: 0 },
        links: e.payload.links ?? [],
        refused: e.payload.refused ?? [],
      }),
    ),
    w.listen("tauri://drag-leave", () => handler({ type: "leave" })),
  ]);
  return () => offs.forEach((f) => f());
}
