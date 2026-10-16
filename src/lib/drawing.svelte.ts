/* The one frame diagrams are drawn in.
 *
 * Mermaid parses untrusted text — an agent's, and through an agent whatever it
 * read — and builds DOM in whatever document runs it. So it runs in a frame
 * behind `sandbox.ts`'s wall: an opaque origin with no parent DOM, no storage
 * and no reach to the IPC, under a policy that lets nothing in from the
 * network. A bug in mermaid or in the sanitiser it carries lands there, with
 * nothing to touch. What comes back is a string, and `diagram.ts::readDrawn` is
 * all that is believed of it.
 *
 * - **One frame for the window, made the first time a diagram is near the
 *   view**, and mermaid with it: 5.5 MB of script that a window with no diagram
 *   in it never loads. It is imported as text, inlined into the frame's
 *   document, and kept — a second diagram costs a message, not a load.
 * - **One render at a time.** A layout can hold the renderer for as long as it
 *   takes, and two at once only share that out more slowly.
 * - **Cached on the theme and the text.** A closed fence's text never changes
 *   — the stream settles it and nothing reaches back past that — so a fence
 *   moving from the streaming tail into the settled column, a card read back,
 *   a panel drawn again, all find the drawing already made. The theme is in the
 *   key because a diagram is drawn in the page's own ink, so a change of theme
 *   or brightness is a different drawing.
 * - **The theme is heard, not asked.** A theme paints the root element's style
 *   and so does the brightness, so one observer on the root's attributes is
 *   every way the ink can change — the shape CLAUDE.md prefers: fold an event
 *   that already exists rather than poll. */

import { SANDBOX, freshNonce, sandboxDoc } from "./sandbox";
import {
  BOOT,
  DIAGRAM_MOST,
  diagramConfig,
  readDrawn,
  type Drawn,
  type Ink,
} from "./diagram";

/** How long a render may take before the frame is thought wedged, and made
 *  again. Generous: the first one includes reading mermaid. */
const WEDGED_MS = 20_000;

/** Characters of drawing the cache may hold, by the `data:` URLs it keeps — a
 *  diagram is a few kilobytes to a few hundred, but a count is no bound on
 *  what each one weighs (found in review). */
const KEPT_CHARS = 16_000_000;

/** A failure that says nothing about the fence — the renderer slow to start
 *  on a loaded machine, or wedged — and so is not kept: the next time the
 *  fence comes near it is tried again, where mermaid's own refusal of the text
 *  would only be refused again (found in review). */
type Passing = Drawn & { passing?: true };

class Diagrams {
  /** The page's ink as last read — what the cache is keyed on, and what a
   *  diagram watches to know it should be drawn again. */
  ink = $state("");
  #frame: HTMLIFrameElement | null = null;
  #ready: Promise<HTMLIFrameElement> | null = null;
  #next = 1;
  #waiting = new Map<number, (reply: unknown) => void>();
  #line: Promise<unknown> = Promise.resolve();
  #drawn = new Map<string, Drawn>();
  #held = 0;
  #heard = false;

  /** Start listening — the frame's answers and the page's ink. Called as a
   *  diagram is set up rather than from inside a reading of state, since the
   *  first call writes `ink`. */
  begin(): void {
    this.#hear();
  }

  /** A drawing already made for this fence in this ink, or `undefined`. */
  known(text: string): Drawn | undefined {
    return this.#drawn.get(`${this.ink}\n${text}`);
  }

  /** Draw one fence. Settles with a drawing or with the reason there is none —
   *  never throws, since a fence that cannot be drawn is still a fence. */
  draw(text: string): Promise<Drawn> {
    this.#hear();
    const ink = this.ink;
    const key = `${ink}\n${text}`;
    const had = this.#drawn.get(key);
    if (had) return Promise.resolve(had);
    if (text.length > DIAGRAM_MOST)
      return Promise.resolve({ error: `it is longer than the ${DIAGRAM_MOST.toLocaleString()} characters a diagram may be` });
    const run = this.#line.then(() => this.#render(text, ink));
    this.#line = run.catch(() => {});
    return run.then((drawn: Passing) => {
      if (drawn.passing) {
        const { passing: _, ...said } = drawn;
        return said as Drawn;
      }
      this.#keep(key, drawn);
      return drawn;
    });
  }

  #keep(key: string, drawn: Drawn) {
    const weigh = (d: Drawn | undefined) => (d && "picture" in d ? d.picture.url.length : 64);
    if (this.#drawn.has(key)) this.#held -= weigh(this.#drawn.get(key));
    this.#drawn.delete(key);
    this.#drawn.set(key, drawn);
    this.#held += weigh(drawn);
    for (const [k, d] of this.#drawn) {
      if (this.#held <= KEPT_CHARS || k === key) break;
      this.#drawn.delete(k);
      this.#held -= weigh(d);
    }
  }

  async #render(text: string, ink: string): Promise<Passing> {
    let frame: HTMLIFrameElement;
    try {
      frame = await this.#open();
    } catch (e) {
      return {
        error: `the renderer could not start — ${String(e).replace(/^Error:\s*/, "")}`,
        passing: true,
      };
    }
    const id = this.#next++;
    const reply = await new Promise<unknown>((resolve) => {
      const timer = window.setTimeout(() => {
        this.#waiting.delete(id);
        /* Wedged, or gone: the next fence gets a fresh frame. */
        this.#close();
        resolve({ error: "it took too long to lay out", passing: true });
      }, WEDGED_MS);
      this.#waiting.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      frame.contentWindow?.postMessage(
        { id, text, config: diagramConfig(JSON.parse(ink) as Ink) },
        "*",
      );
    });
    const passing = (reply as { passing?: unknown } | null)?.passing === true;
    const drawn = readDrawn(reply);
    return passing ? { ...drawn, passing: true } : drawn;
  }

  #open(): Promise<HTMLIFrameElement> {
    if (this.#ready) return this.#ready;
    this.#ready = (async () => {
      const { default: mermaid } = await import("mermaid/dist/mermaid.min.js?raw");
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", SANDBOX);
      frame.setAttribute("aria-hidden", "true");
      frame.tabIndex = -1;
      frame.title = "diagram renderer";
      /* On the screen, a pixel square and invisible, rather than off it: a
         frame entirely out of the viewport is one the browser may stop giving
         time to, and a render would then crawl. */
      Object.assign(frame.style, {
        position: "fixed",
        left: "0",
        top: "0",
        width: "1px",
        height: "1px",
        border: "0",
        opacity: "0",
        pointerEvents: "none",
        zIndex: "-1",
      });
      /* A nonce, so the two tags written here are the only script that runs —
         not an event handler a renderer bug left in the DOM it built. See
         `sandboxPolicy`. */
      frame.srcdoc = sandboxDoc({
        scripts: [mermaid, BOOT],
        head: `<style>html,body{margin:0;background:transparent}</style>`,
        nonce: freshNonce(),
      });
      /* The frame loads exactly once. A second load is the frame having
         navigated itself — which a sandbox allows and a policy cannot stop —
         to a page with none of this one's policy, still answering to the same
         `contentWindow`; so it is thrown away rather than trusted, and the next
         fence gets a fresh one (found in review). */
      let loads = 0;
      frame.addEventListener("load", () => {
        if (++loads > 1 && this.#frame === frame) this.#close();
      });
      const ready = new Promise<void>((resolve, reject) => {
        const t = window.setTimeout(() => reject(new Error("it did not answer")), WEDGED_MS);
        this.#onReady = () => {
          clearTimeout(t);
          resolve();
        };
      });
      document.body.appendChild(frame);
      this.#frame = frame;
      await ready;
      return frame;
    })();
    this.#ready.catch(() => this.#close());
    return this.#ready;
  }

  #onReady: (() => void) | null = null;

  #close() {
    this.#frame?.remove();
    this.#frame = null;
    this.#ready = null;
    this.#onReady = null;
    /* Whatever was waiting on that frame will hear nothing from it now. */
    for (const [id, done] of this.#waiting) {
      this.#waiting.delete(id);
      done({ error: "the renderer was reset", passing: true });
    }
  }

  /** The message listener and the ink observer, made once. Messages are
   *  believed only from the frame itself — by identity, since its origin is
   *  opaque and reads as `"null"`, which any sandboxed frame shares. */
  #hear() {
    if (this.#heard) return;
    this.#heard = true;
    window.addEventListener("message", (e) => {
      if (!this.#frame || e.source !== this.#frame.contentWindow) return;
      const m = e.data as { ready?: unknown; id?: unknown } | null;
      if (m && m.ready === true) {
        this.#onReady?.();
        return;
      }
      if (m && typeof m.id === "number") {
        const done = this.#waiting.get(m.id);
        this.#waiting.delete(m.id);
        done?.(m);
      }
    });
    const read = () => {
      const next = JSON.stringify(readInk());
      if (next !== this.ink) this.ink = next;
    };
    read();
    new MutationObserver(read).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style", "class", "data-theme", "data-brightness"],
    });
  }
}

/** The page's ink, resolved to `rgb(…)` — a token may be any colour syntax,
 *  and the frame and mermaid's colour library can read none of this window's
 *  custom properties. Through a probe for the token, then painted onto a canvas
 *  and read back as the pixel it is: a computed colour is `rgb(…)` for a hex
 *  token but `oklch(…)` or `color(srgb …)` for one written that way, which
 *  neither the mix below nor mermaid can read, and every diagram failed under a
 *  theme that used one (found in review). */
function readInk(): Ink {
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.appendChild(probe);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const pen = canvas.getContext("2d", { willReadFrequently: true });
  const at = (token: string, fallback: string) => {
    probe.style.color = fallback;
    probe.style.color = `var(${token}, ${fallback})`;
    const css = getComputedStyle(probe).color || fallback;
    if (!pen) return css;
    pen.clearRect(0, 0, 1, 1);
    pen.fillStyle = fallback;
    pen.fillStyle = css;
    pen.fillRect(0, 0, 1, 1);
    const [r, g, b] = pen.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  };
  const ink = {
    ink: at("--ink", "rgb(21, 18, 16)"),
    surface: at("--surface", "rgb(30, 26, 24)"),
    paper: at("--paper", "rgb(237, 228, 216)"),
    dim: at("--paper-dim", "rgb(180, 168, 156)"),
    mute: at("--paper-mute", "rgb(138, 126, 116)"),
    faint: at("--paper-faint", "rgb(97, 88, 80)"),
    edge: at("--edge", "rgb(60, 54, 49)"),
  };
  probe.remove();
  return ink;
}

export const diagrams = new Diagrams();
