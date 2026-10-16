/* The one wall a frame of somebody else's markup stands behind.
 *
 * Two things in this window run text an agent wrote as a document: a design
 * preview in a question (`Gallery.svelte`), and a mermaid diagram in an answer
 * (`drawing.svelte.ts`). Both stand behind the same two containments, and they
 * live here so there is one place the posture is stated and one place to fix
 * it — a second copy would be a second thing to keep in step, and the copy
 * that drifted would be the one nobody was looking at.
 *
 * - **The `sandbox` attribute (`SANDBOX`)**, which the component sets and a
 *   document cannot. `allow-scripts` *without* `allow-same-origin` puts the
 *   frame on an opaque origin: no parent DOM, no reaching `window.__TAURI__`
 *   through `window.parent`, no storage, no top-level navigation, no modals.
 *   That is the wall, and it is spec-guaranteed. It matters here more than in
 *   a browser, because the invoke bridge is the app's whole surface and a
 *   project card's agent runs with `--dangerously-skip-permissions`.
 * - **The CSP (`sandboxPolicy`)**, which closes network egress and gates
 *   scripts. `tauri.conf.json` has `"csp": null`, so nothing at the app level
 *   stops a frame fetching from the internet, and `default-src 'none'` is the
 *   whole of what does. A `<meta>` CSP applies to its own document by spec and
 *   a srcdoc inherits its parent's (here, none).
 *
 * Pure, so it is tested directly (test/showing.test.ts holds the shape). */

/** The frame's `sandbox` attribute. Never add `allow-same-origin` beside it:
 *  the two together hand the frame this document's origin back, and with it
 *  the IPC. */
export const SANDBOX = "allow-scripts";

/** The frame's content security policy. Nothing from the network; pictures and
 *  fonts only as `data:`; styles inline; scripts inline or not at all.
 *
 *  **A `nonce` narrows the scripts to the tags this window wrote.** The diagram
 *  frame runs a renderer over untrusted text, and the commonest way such a
 *  renderer goes wrong is leaving an event-handler attribute in the DOM it
 *  builds — which `'unsafe-inline'` allows, so against exactly that class the
 *  policy added nothing beyond the sandbox (found in review). With a nonce the
 *  two script tags run and nothing else does: no `onerror=`, no `javascript:`.
 *  A design preview keeps `'unsafe-inline'`, because its script *is* the
 *  author's markup. */
export function sandboxPolicy(scripts: boolean, nonce?: string): string {
  return [
    "default-src 'none'",
    "img-src data:",
    "font-src data:",
    "style-src 'unsafe-inline'",
    /* One gate for scripts wherever they are written, so a `<script>` typed
       into the markup is refused exactly as a script field is. */
    !scripts ? "script-src 'none'" : nonce ? `script-src 'nonce-${nonce}'` : "script-src 'unsafe-inline'",
  ].join("; ");
}

/** A nonce for one frame's life: sixteen random bytes as hex. */
export function freshNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** A closing tag inside the text ends the element early. Not a security
 *  boundary — the CSP and the sandbox are — but a stylesheet that silently
 *  loses its second half because it contained `</style` is a bug that reads as
 *  the author's. */
export function neuter(source: string): string {
  return source.replace(/<\/(script|style)/gi, "<\\/$1");
}

/** A whole document behind the wall: the policy first, so nothing in `head`
 *  or `body` can run or load before it applies. `scripts` are appended after
 *  the body, each neutered. */
export function sandboxDoc(opts: {
  scripts: string[] | false;
  head?: string;
  body?: string;
  /** Only these script tags may run — see `sandboxPolicy`. Hex, so it can
   *  close neither the attribute nor the policy it is written into. */
  nonce?: string;
}): string {
  const allowed = opts.scripts !== false;
  const nonce = opts.nonce && /^[0-9a-f]{16,64}$/.test(opts.nonce) ? opts.nonce : undefined;
  const open = nonce ? `<script nonce="${nonce}">` : "<script>";
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${sandboxPolicy(allowed, nonce)}">`,
    opts.head ?? "",
    "</head><body>",
    opts.body ?? "",
    ...(allowed ? (opts.scripts as string[]).map((s) => `${open}${neuter(s)}</script>`) : []),
    "</body></html>",
  ].join("");
}
