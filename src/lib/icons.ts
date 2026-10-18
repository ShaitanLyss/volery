/* The chat view's icons, as data.

   Drawn from `docs/chat-mode/src/sprite.html`, the approved mockups' own set:
   a 16-unit grid, 1.5 stroke, round caps, no fill. Kept as the markup it was
   drawn in and read into shapes once, rather than poured into the page with
   `{@html}` — which this codebase keeps off every path on purpose
   (`Markdown.svelte`), and a static table is no reason to make an exception.
   `Icon.svelte` draws a shape list. */

export type Shape = { tag: "path" | "circle" | "rect" | "ellipse"; attrs: Record<string, string> };

const RAW = {
  "plus": `<path d="M8 3.2v9.6M3.2 8h9.6"/>`,
  "search": `<circle cx="7" cy="7" r="4.3"/><path d="m10.2 10.2 3.3 3.3"/>`,
  "side": `<rect x="2.3" y="3" width="11.4" height="10" rx="2"/><path d="M6.3 3v10"/>`,
  "pane": `<rect x="2.3" y="3" width="11.4" height="10" rx="2"/><path d="M9.7 3v10"/>`,
  "folder": `<path d="M2.4 4.6c0-.6.5-1.1 1.1-1.1h2.9l1.5 1.5h4.6c.6 0 1.1.5 1.1 1.1v5.8c0 .6-.5 1.1-1.1 1.1H3.5c-.6 0-1.1-.5-1.1-1.1z"/>`,
  "globe": `<circle cx="8" cy="8" r="5.6"/><ellipse cx="8" cy="8" rx="2.3" ry="5.6"/><path d="M2.6 8h10.8"/>`,
  "chev-r": `<path d="m6.2 4 4 4-4 4"/>`,
  "chev-d": `<path d="m4 6.2 4 4 4-4"/>`,
  "up": `<path d="M8 12.8V3.4M4.2 7.2 8 3.4l3.8 3.8"/>`,
  "stop": `<rect x="3.5" y="3.5" width="9" height="9" rx="2"/>`,
  "mic": `<rect x="6" y="2.4" width="4" height="7.2" rx="2"/><path d="M3.8 7.9a4.2 4.2 0 0 0 8.4 0M8 12.2v1.6"/>`,
  "clip": `<path d="m10.6 5.4-4.7 4.7a1.3 1.3 0 0 0 1.9 1.9l4.8-4.8a2.7 2.7 0 0 0-3.8-3.8L3.9 8.3a4 4 0 0 0 5.7 5.7l3.3-3.3"/>`,
  "eye": `<path d="M1.8 8S4.1 4 8 4s6.2 4 6.2 4-2.3 4-6.2 4S1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.8"/>`,
  "pen": `<path d="m10.4 3.1 2.5 2.5-7 7H3.4v-2.5z"/>`,
  "term": `<rect x="2.2" y="3" width="11.6" height="10" rx="2"/><path d="m5 6.8 2 1.5-2 1.5M8.6 10.1h2.6"/>`,
  "check": `<path d="m3.6 8.4 2.9 2.9 5.9-6.6"/>`,
  "copy": `<rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5V4c0-.8-.7-1.5-1.5-1.5H4c-.8 0-1.5.7-1.5 1.5v5c0 .8.7 1.5 1.5 1.5h1.5"/>`,
  "quote": `<path d="M3 4.5h10M3 8h6M3 11.5h8"/><path d="M11.5 7.2v4.3"/>`,
  "pin": `<path d="M8 13.8V10M4.8 10h6.4l-1.2-2.2V4.4h.9V2.8H5.1v1.6H6v3.4z"/>`,
  "more": `<circle cx="3.6" cy="8" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="12.4" cy="8" r=".6"/>`,
  "wall": `<rect x="2.3" y="2.8" width="4.8" height="4.2" rx="1.1"/><rect x="8.9" y="2.8" width="4.8" height="4.2" rx="1.1"/><rect x="2.3" y="9" width="4.8" height="4.2" rx="1.1"/><rect x="8.9" y="9" width="4.8" height="4.2" rx="1.1"/>`,
  "chat": `<path d="M2.6 4.6c0-1.1.9-2 2-2h6.8c1.1 0 2 .9 2 2v4.6c0 1.1-.9 2-2 2H7.2l-3 2.4v-2.5c-.9-.2-1.6-1-1.6-1.9z"/>`,
  "gear": `<circle cx="8" cy="8" r="2.1"/><path d="M8 1.9v1.7M8 12.4v1.7M14.1 8h-1.7M3.6 8H1.9M12.3 3.7l-1.2 1.2M4.9 11.1l-1.2 1.2M12.3 12.3l-1.2-1.2M4.9 4.9 3.7 3.7"/>`,
  "x": `<path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6"/>`,
  "branch": `<circle cx="4.6" cy="3.9" r="1.5"/><circle cx="4.6" cy="12.1" r="1.5"/><circle cx="11.4" cy="5.6" r="1.5"/><path d="M4.6 5.4v5.2M11.4 7.1c0 2.6-2.8 2.6-6.4 3.6"/>`,
  "image": `<rect x="2.3" y="3" width="11.4" height="10" rx="2"/><circle cx="6" cy="6.6" r="1.2"/><path d="m2.8 11.9 3.4-3.3 2.6 2.4 1.9-1.8 2.6 2.4"/>`,
  "file": `<path d="M4.2 2.4h4.9l3 3v7.9c0 .6-.5 1.1-1.1 1.1H4.2c-.6 0-1.1-.5-1.1-1.1V3.5c0-.6.5-1.1 1.1-1.1z"/><path d="M9 2.5v3h3"/>`,
  "list": `<path d="M6.2 4.5h6.8M6.2 8h6.8M6.2 11.5h6.8"/><circle cx="3.4" cy="4.5" r=".5"/><circle cx="3.4" cy="8" r=".5"/><circle cx="3.4" cy="11.5" r=".5"/>`,
  "arrow-r": `<path d="M3 8h9.6M8.8 4.2 12.6 8l-3.8 3.8"/>`,
  "clock": `<circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.2l2.1 1.4"/>`,
  "min": `<path d="M3.5 8h9"/>`,
  "max": `<rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1"/>`,
  "bell": `<path d="M4.2 10.8V7.4a3.8 3.8 0 0 1 7.6 0v3.4l1 1.3H3.2zM6.6 13.4a1.5 1.5 0 0 0 2.8 0"/>`,
  "plan": `<path d="M3 3.5h10v9H3z" stroke-dasharray="2 1.6"/><path d="M5.5 6.5h5M5.5 9.5h3.2"/>`,
  "down": `<path d="M8 3.2v9.4M4.2 8.8 8 12.6l3.8-3.8"/>`,
  "back": `<path d="M13 8H3.4M7.2 4.2 3.4 8l3.8 3.8"/>`,
  "menu": `<path d="M2.8 4.5h10.4M2.8 8h10.4M2.8 11.5h10.4"/>`,
  "wave": `<path d="M2.5 8h1M5 5.5v5M7.5 3.5v9M10 5.5v5M12.5 7v2"/>`,
  "brain": `<path d="M8 3.2v9.6M5.6 3.4A2.2 2.2 0 0 0 3.5 6a2.3 2.3 0 0 0 .2 4.3A2.3 2.3 0 0 0 8 12.6M10.4 3.4A2.2 2.2 0 0 1 12.5 6a2.3 2.3 0 0 1-.2 4.3A2.3 2.3 0 0 1 8 12.6"/>`,
} as const;

export type IconName = keyof typeof RAW;

/** One element of a sprite's markup, as a tag and its attributes. Only the four
 *  shapes the set uses; anything else is dropped rather than drawn. */
export function shapesOf(markup: string): Shape[] {
  const out: Shape[] = [];
  for (const m of markup.matchAll(/<(path|circle|rect|ellipse)\s([^>]*?)\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    out.push({ tag: m[1] as Shape["tag"], attrs });
  }
  return out;
}

export const ICONS: Record<IconName, Shape[]> = Object.fromEntries(
  Object.entries(RAW).map(([k, v]) => [k, shapesOf(v)]),
) as Record<IconName, Shape[]>;
