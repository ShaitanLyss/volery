/* Taking a picture out of the transcript: onto the clipboard as a bitmap, or
 * into a file. See `.claude/rules/showing.md`, *Taking one out*.
 *
 * The figure already holds the bytes it draws as a `data:` URL, read from the
 * kept copy `show` made — never from the agent's path, which may be gone — so
 * both gestures start from that and neither reads the disk again.
 *
 * **A bitmap, so that Teams, Outlook and Paint paste an image** and not a path
 * or a URL. `navigator.clipboard.write` with an `image/png` item does that in
 * WebView2, and PNG is the one type it accepts, so anything else is drawn onto
 * a canvas and re-encoded. An svg is drawn onto one for the same reason (Teams
 * cannot paste svg), on white, since a foreign svg is nearly always drawn for a
 * white page and a transparent png pastes as black in some of them.
 *
 * `rasterTarget` and `saveName` are pure and tested; the rest needs a webview. */

import type { Dims } from "./showing";

/** What a surface that draws a picture says about it, for the menu and the
 *  hover button — read at the moment of the gesture, because the bytes arrive
 *  after the figure is drawn and are let go of when it scrolls away. */
export type PictureHandle = {
  /** The bytes as a `data:` URL, or null while none are held. */
  url: () => string | null;
  svg: boolean;
  /** The file's name, or what stands in for one. */
  name: string;
  dims: () => Dims | undefined;
  /** Open the file it came from, or null where there is none to open — a
   *  picture that carries its own bytes, a chat card, a card on another wall. */
  go: (() => ((how: "open" | "reveal") => void) | null) | null;
  /** The figure's own word that it was copied, so the menu and the hover
   *  button say the same thing. */
  copied?: () => void;
};

/** Which handle a drawn picture answers with. A weak map on the element, so the
 *  window's one right-click handler can ask any picture without being handed a
 *  prop, and nothing outlives the node (the ambient shape CLAUDE.md asks for). */
const handles = new WeakMap<Element, PictureHandle>();

export function offerPicture(el: Element, h: PictureHandle): () => void {
  handles.set(el, h);
  return () => handles.delete(el);
}

export function pictureAt(el: Element | null): PictureHandle | null {
  const hit = el?.closest?.("[data-picture]");
  return (hit && handles.get(hit)) || null;
}

/** The longest side a pasted raster may have. A 3200×2053 png is pasted as it
 *  is; this only bounds what an svg with a huge declared size is drawn at. */
const MAX_SIDE = 4096;
/** An svg is vector, so it is drawn at least this wide: a 300-pixel diagram
 *  pasted into a document is otherwise a blur. */
const SVG_MIN_WIDTH = 1600;

/** The pixel size an svg is rasterised at. A raster is never resized. */
export function rasterTarget(w: number, h: number, svg: boolean): { w: number; h: number } {
  if (!(w > 0 && h > 0)) return { w: 0, h: 0 };
  let k = svg ? Math.max(1, SVG_MIN_WIDTH / w) : 1;
  k = Math.min(k, MAX_SIDE / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** The name a save dialog opens with: the picture's own, in the format that
 *  will be written — a data url is a png or whatever its media type says. */
export function saveName(name: string, url: string): string {
  const mime = /^data:image\/([a-z0-9.+-]+)/i.exec(url)?.[1]?.toLowerCase() ?? "png";
  const ext = mime === "svg+xml" ? "svg" : mime === "jpeg" ? "jpg" : mime;
  const base = name.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[\\/:*?"<>|]+/g, "-").trim() || "picture";
  return `${base}.${ext}`;
}

const isPng = (url: string) => /^data:image\/png[;,]/i.test(url);

function decode(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, no) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => no(new Error("the picture could not be decoded"));
    img.src = url;
  });
}

/** The picture as png bytes. A png is the bytes it already is. */
export async function pngOf(url: string, svg: boolean, dims?: Dims): Promise<Blob> {
  if (isPng(url)) return await (await fetch(url)).blob();
  const img = await decode(url);
  const nw = img.naturalWidth || dims?.w || 0;
  const nh = img.naturalHeight || dims?.h || 0;
  /* An svg with no intrinsic size decodes to 0×0 or 150×150; its declared size
     is the better word. */
  const w0 = svg && dims ? dims.w : nw;
  const h0 = svg && dims ? dims.h : nh;
  const { w, h } = rasterTarget(w0, h0, svg);
  if (!w || !h) throw new Error("the picture has no size to draw");
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  if (!g) throw new Error("no canvas to draw the picture on");
  if (svg) {
    g.fillStyle = "#fff";
    g.fillRect(0, 0, w, h);
  }
  g.drawImage(img, 0, 0, w, h);
  return await new Promise((ok, no) =>
    c.toBlob((b) => (b ? ok(b) : no(new Error("the picture could not be encoded"))), "image/png"),
  );
}

/** Put it on the clipboard as an image. The blob is handed over as a promise
 *  so the click's user activation is still alive when a slow encode finishes. */
export async function copyPicture(h: PictureHandle): Promise<void> {
  const url = h.url();
  if (!url) throw new Error("the picture is not loaded yet");
  const item = new ClipboardItem({ "image/png": pngOf(url, h.svg, h.dims()) });
  await navigator.clipboard.write([item]);
  h.copied?.();
}

/** Ask where, and write it. Resolves to the file's name, or null if the
 *  dialog was dismissed. */
export async function savePicture(h: PictureHandle): Promise<string | null> {
  const url = h.url();
  if (!url) throw new Error("the picture is not loaded yet");
  const [{ save }, { invoke }] = await Promise.all([
    import("@tauri-apps/plugin-dialog"),
    import("@tauri-apps/api/core"),
  ]);
  const name = saveName(h.name, url);
  const ext = name.split(".").pop() ?? "png";
  const picked = await save({
    title: "Save image as",
    defaultPath: name,
    filters: [{ name: "image", extensions: [ext] }],
  });
  if (typeof picked !== "string") return null;
  await invoke("save_picture", { path: picked, dataUrl: url });
  return picked.split(/[\\/]/).pop() ?? picked;
}

const dataUrlOf = (b: Blob) =>
  new Promise<string>((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => no(new Error("the picture could not be read"));
    r.readAsDataURL(b);
  });

/** Write the picture to a file of its own and say where — what a drag out
 *  carries, since another app is handed a file. An svg goes as the png it is
 *  rasterised to, for the reason a copy does. */
export async function stagePicture(h: PictureHandle): Promise<string> {
  const url = h.url();
  if (!url) throw new Error("the picture is not loaded yet");
  const png = h.svg || !/^data:image\//i.test(url) ? await dataUrlOf(await pngOf(url, h.svg, h.dims())) : url;
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<string>("stage_picture", { name: saveName(h.name, png), dataUrl: png });
}

/** How far the pointer travels before a press becomes a drag — the 4px slop the
 *  wall's own gestures use, a little over, so a click that wobbles stays one. */
export const DRAG_SLOP = 5;

/** Start the shell's drag for a staged file; resolves when it ends. */
export async function dragOut(path: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("drag_file", { path });
}
