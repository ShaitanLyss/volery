/** Boost's look, running: one renderer for the look the wall wears, drawing
 *  into the two canvases the wall hands it — the field behind the cards and the
 *  air above them — and turning the wall's moments into light.
 *
 *  `boostfield.ts` is what a look draws; this is when. Three things decide it:
 *
 *  - **The motion setting, read where every stylesheet reads it**
 *    (`document.documentElement.dataset.motion`, `motion.svelte.ts`). `full`
 *    draws at `FPS`, `spare` at `SPARE_FPS`, and `still` — or the system's
 *    reduced-motion — draws the field once and stops, which is the setting's
 *    whole promise (`motion.md`: the cost is the present rate, and an
 *    animation with no end holds it up for ever). A moment is a one-shot, so it
 *    still plays under `still`, and the air canvas runs for exactly as long as
 *    one is in flight.
 *  - **A hidden window draws nothing.** The frame is skipped while
 *    `document.hidden`, so a minimised wall in boost costs no GPU at all.
 *  - **Only while the field is mounted**, which `Canvas.svelte` does only while
 *    boost is on. Unmounting stops the loop and lets go of the renderer.
 *
 *  Plain attachments rather than a component, so the wall's markup gains two
 *  canvases and nothing else: `{@attach boostView.ground}` and
 *  `{@attach boostView.air}`. */

import { boost } from "./boost.svelte";
import { createField, FPS, SPARE_FPS, type Field, type LookId } from "./boostfield";

/** How long the air canvas keeps drawing after a moment — the longest one
 *  (the ignition's rings and its flash) is under this. */
const MOMENT_MS = 2_400;

/** How late a field may mount and still play the ignition that mounted it. */
const IGNITE_MEMORY_MS = 2_500;

class BoostView {
  #ground: HTMLCanvasElement | null = null;
  #air: HTMLCanvasElement | null = null;
  #gctx: CanvasRenderingContext2D | null = null;
  #actx: CanvasRenderingContext2D | null = null;
  #field: Field | null = null;
  #look: LookId | null = null;
  #raf = 0;
  #t0 = 0;
  #last = 0;
  #acc = 0;
  #w = 0;
  #h = 0;
  #ro: ResizeObserver | null = null;
  #unlisten: (() => void) | null = null;
  #stillDrawn = false;
  #momentUntil = 0;
  #airDirty = false;
  /** The ignition waiting for a field to play on, by the moment it was marked
   *  (0 for none), and the last one played. */
  #pendingIgnite = 0;
  #playedIgnite = 0;

  /** Bumped on every ignition, so the title card (`BoostIgnition.svelte`) can
   *  key itself on it and play once per switch. */
  ignitions = $state(0);

  /** The canvas behind the work. Starts the loop; its box is the field's.
   *
   *  Two rooms hand one over — the wall's surface and chat view's sheet — and
   *  only the one in front mounts it, so there is one field at a time. A
   *  switch can attach the new one before the old one's teardown runs, so a
   *  teardown lets go only of the canvas it was given. */
  ground = (canvas: HTMLCanvasElement) => {
    if (this.#ground) this.#stop();
    this.#ground = canvas;
    this.#gctx = canvas.getContext("2d");
    this.#start();
    return () => {
      if (this.#ground !== canvas) return;
      this.#stop();
      this.#ground = null;
      this.#gctx = null;
    };
  };

  /** The canvas above the work, where the moments play. */
  air = (canvas: HTMLCanvasElement) => {
    this.#air = canvas;
    this.#actx = canvas.getContext("2d");
    this.#airDirty = false;
    this.#size();
    return () => {
      if (this.#air !== canvas) return;
      this.#air = null;
      this.#actx = null;
    };
  };

  #start() {
    if (!this.#ground) return;
    this.#t0 = performance.now();
    this.#last = this.#t0;
    this.#ro = new ResizeObserver(() => this.#size());
    this.#ro.observe(this.#ground);
    this.#unlisten = boost.listen((m) => {
      if (m.kind === "ignite") {
        this.#pendingIgnite = m.at;
        return;
      }
      if (!this.#field || m.kind !== "limit") return;
      const at = this.#cardCentre(m.card);
      if (!at) return;
      this.#momentUntil = performance.now() + MOMENT_MS;
      this.#field.burst(at.x, at.y, this.#now());
    });
    /* The switch that turned boost on marked the ignition before this canvas
       existed — it is mounted *because* boost is on — so the moment that
       mounted the field is asked after rather than waited for. Once: a field
       remounted by a switch between the wall and chat view a second later
       must not play it again. */
    const at = boost.ignitedAt;
    this.#pendingIgnite = at !== null && at !== this.#playedIgnite && Date.now() - at < IGNITE_MEMORY_MS ? at : 0;
    this.#size();
    this.#raf = requestAnimationFrame(this.#frame);
  }

  #stop() {
    cancelAnimationFrame(this.#raf);
    this.#ro?.disconnect();
    this.#ro = null;
    this.#unlisten?.();
    this.#unlisten = null;
    this.#field = null;
    this.#look = null;
  }

  #now() {
    return (performance.now() - this.#t0) / 1000;
  }

  /** Where a card is, in the air canvas's own pixels, and the first of these
   *  that is drawn: the conversation open in chat view (its message box,
   *  `data-boost-anchor`), the card on the wall or its copy on the glass, or
   *  its row in chat view's sidebar. The wall is still mounted under chat view,
   *  at no size, which is why a card measuring nothing is passed over rather
   *  than answered. A row beside the sheet is pulled in to the sheet's edge, so
   *  the shockwave comes in from the side it is on. */
  #cardCentre(card: string): { x: number; y: number } | null {
    const box = this.#air?.getBoundingClientRect() ?? this.#ground?.getBoundingClientRect();
    if (!box || box.width === 0) return null;
    const id = CSS.escape(card);
    for (const sel of [`[data-boost-anchor="${id}"]`, `[data-conv="${id}"]`, `[data-row="${id}"]`]) {
      for (const el of document.querySelectorAll<HTMLElement>(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        const x = r.left + r.width / 2 - box.left;
        const y = r.top + r.height / 2 - box.top;
        return { x: Math.max(0, Math.min(box.width, x)), y: Math.max(0, Math.min(box.height, y)) };
      }
    }
    return null;
  }

  #size() {
    const g = this.#ground;
    if (!g) return;
    const w = g.clientWidth, h = g.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    for (const [c, ctx] of [[g, this.#gctx], [this.#air, this.#actx]] as const) {
      if (!c || !ctx) continue;
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.#w = w;
    this.#h = h;
    this.#ensureField();
    this.#field?.resize(w, h);
    this.#stillDrawn = false;
  }

  #ensureField() {
    if (this.#look === boost.lookId && this.#field) return;
    this.#look = boost.lookId;
    this.#field = createField(this.#look);
    if (this.#w) this.#field.resize(this.#w, this.#h);
    this.#stillDrawn = false;
  }

  #frame = (now: number) => {
    this.#raf = requestAnimationFrame(this.#frame);
    if (document.hidden || !this.#gctx || !this.#ground) return;
    this.#ensureField();
    const field = this.#field;
    if (!field) return;
    if (this.#pendingIgnite) {
      /* Played on the first frame with a field to play it on, whatever the
         rate cap says, so the flash and the title card land together. */
      this.#playedIgnite = this.#pendingIgnite;
      this.#pendingIgnite = 0;
      field.ignite(this.#now());
      this.#momentUntil = now + MOMENT_MS;
      this.ignitions += 1;
    }
    const mode = document.documentElement.dataset.motion;
    const still = mode === "still" || matchMedia("(prefers-reduced-motion: reduce)").matches;
    const momentary = now < this.#momentUntil;
    const dt = Math.min(0.1, (now - this.#last) / 1000);
    this.#last = now;
    this.#acc += dt;
    const fps = mode === "spare" ? SPARE_FPS : FPS;
    if (this.#acc < 1 / fps) return;
    const step = this.#acc;
    this.#acc = 0;
    const t = this.#now();
    if (!still) field.frame(this.#gctx, t, step);
    else if (!this.#stillDrawn) {
      /* One frame of the look, a little way in so its particles are spread
         rather than all at their seeds — and then nothing until something
         moves the window or the look. */
      field.frame(this.#gctx, 6, 0);
      this.#stillDrawn = true;
    }
    /* The air is empty between moments, so it is drawn only while one is in
       flight and cleared once after — an idle wall in boost pays for one
       canvas, not two. */
    if (this.#actx) {
      if (momentary) {
        field.overlay(this.#actx, t, step);
        this.#airDirty = true;
      } else if (this.#airDirty) {
        this.#actx.clearRect(0, 0, this.#w, this.#h);
        this.#airDirty = false;
      }
    }
  };
}

export const boostView = new BoostView();
