<script lang="ts">
  /* The wall's ambience, painted.
   *
   * One canvas behind everything on the surface, and a frame loop that does
   * nothing but call into `ambience.ts` — the geometry of a flourish, the
   * envelope that draws it and fades it, where a leaf is a moment later, which
   * rings of a ripple are still alive, where somebody's next footprint lands.
   * Nothing here decides anything you could assert; that is all next door.
   *
   * Four things about it are deliberate:
   *
   * - **Screen space, not canvas space.** Panning the wall does not drag the
   *   weather with it. This is the light in the room rather than something pinned
   *   up, and it means an effect never has to answer where to spawn on a surface
   *   that has no edges.
   *
   * - **The loop stops when nothing is drawing.** Nothing on this wall polls, and
   *   a requestAnimationFrame that clears a canvas sixty times a second to show
   *   an empty profile is a poll. `living()` decides; the effect below starts and
   *   stops on it and on nothing else.
   *
   * - **A parameter change must not restart anything.** The frame reads the
   *   profile untracked, so dragging `size` re-shapes the next flourish and
   *   leaves the ones already on the wall alone. Only `living()` is tracked.
   *
   * - **Colour is status, so there is none here.** Every layer draws in one tone
   *   mixed between `--well` and `--paper`, both read off the document, so
   *   tokens.css stays the only palette. */

  import {
    due,
    hexRgb,
    leaf,
    leafStep,
    living,
    mix,
    pickName,
    rgba,
    ripple,
    rippleDone,
    rippleRadius,
    stepOn,
    strokeEnvelope,
    swirlPoints,
    walkIn,
    walkedOut,
    windAt,
    wrapLeaf,
    type Layer,
    type Leaf,
    type Print,
    type Profile,
    type Rgb,
    type StrokePoint,
    type Walk,
  } from "./ambience";
  import { skin } from "./palette.svelte";

  let {
    profile,
    /** Whose footprints these are. The cards on the wall — see the note on
     *  footsteps in ambience.ts about not inventing names. */
    names = [],
  }: { profile: Profile | null; names?: string[] } = $props();

  let el: HTMLCanvasElement | undefined = $state();

  /* ── per-layer runtime ──────────────────────────────────────────────────
   *
   * Keyed by layer id, which is why a duplicated profile re-mints them: two
   * layers sharing an id would share a flock of leaves. Pruned each frame
   * against the profile, so switching profiles drops what the old one had. */

  type Flourish = { pts: StrokePoint[]; x: number; y: number; age: number };
  type Drop = { x: number; y: number; age: number; phase: number };
  type Walker = {
    walk: Walk;
    name: string | null;
    prints: Print[];
    pace: number;
    gone: boolean;
  };

  type Runtime = {
    rnd: () => number;
    acc: number;
    strokes: Flourish[];
    flock: Leaf[];
    drops: Drop[];
    walkers: Walker[];
  };

  const runtimes = new Map<string, Runtime>();

  /* Caps, so a slider at the top of its range cannot drown a frame. The wall is
     a working surface: ambience that costs paint is a bug however it looks. */
  const MAX_STROKES = 26;
  const MAX_DROPS = 24;
  const MAX_WALKERS = 8;

  function runtime(id: string): Runtime {
    let r = runtimes.get(id);
    if (!r) {
      r = {
        /* Seeded off the clock rather than deterministically: two leaf layers in
           one profile should not tumble in lockstep. */
        rnd: seeded(Math.floor(Math.random() * 2 ** 31)),
        acc: 0,
        strokes: [],
        flock: [],
        drops: [],
        walkers: [],
      };
      runtimes.set(id, r);
    }
    return r;
  }

  /** The same generator `ambience.ts` uses, kept local so the renderer does not
   *  need a seed argument on every call. */
  function seeded(seed: number): () => number {
    let a = (seed | 0) + 0x6d2b79f5;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ── the surface ────────────────────────────────────────────────────────── */

  let w = 0;
  let h = 0;
  let dark: Rgb = [15, 13, 12];
  let paper: Rgb = [237, 228, 216];
  let util = "system-ui, sans-serif";

  /** The box to fill: the surface the canvas is stretched over.
   *
   *  Measured off the *parent*, never off the canvas. A canvas is a replaced
   *  element, so `width: auto` resolves to its attribute size rather than to the
   *  box `inset: 0` describes — measuring itself and then writing that back as
   *  `el.width` multiplied the size by the device pixel ratio on every observed
   *  resize, and the observer fired on each one. It reached twenty-two million
   *  pixels across before anything looked wrong on screen. The CSS below pins
   *  the element to 100% for the same reason. */
  function box(): HTMLElement | undefined {
    return el?.parentElement ?? el;
  }

  function measure() {
    const parent = box();
    if (!el || !parent) return;
    const dpr = window.devicePixelRatio || 1;
    w = parent.clientWidth;
    h = parent.clientHeight;
    /* The context is scaled to CSS pixels once per resize, so every effect works
       in the units its parameters are written in. */
    el.width = Math.max(1, Math.round(w * dpr));
    el.height = Math.max(1, Math.round(h * dpr));
    const ctx = el.getContext("2d");
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function readTokens() {
    if (!el) return;
    const cs = getComputedStyle(el);
    /* Below the ground and bone, the two ends of the `ink` knob. Read rather
       than hardcoded: the theme is defined in tokens.css and only there. */
    dark = hexRgb(cs.getPropertyValue("--well"), dark);
    paper = hexRgb(cs.getPropertyValue("--paper"), paper);
    util = cs.fontFamily || util;
  }

  $effect(() => {
    const parent = box();
    if (!el || !parent) return;
    measure();
    /* The parent, not the canvas — observing the canvas while resizing it is the
       feedback loop described above. */
    const ro = new ResizeObserver(() => measure());
    ro.observe(parent);
    return () => ro.disconnect();
  });

  /* The tokens are re-read whenever the skin repaints the root, not only at
     mount: a canvas cannot see a custom property change, and a wall switched to
     a light skin kept drawing its leaves in studio's bone on cream. A separate
     effect from the one above, so a skin change does not rebuild the observer.
     No redraw is owed: the frame loop reads `dark` and `paper` every frame, and
     a bare profile draws nothing to be stale. */
  $effect(() => {
    void skin.painted;
    if (!el) return;
    readTokens();
  });

  /* ── the loop ───────────────────────────────────────────────────────────── */

  let raf = 0;
  let last = 0;
  /** The ambience clock, in seconds. Only the wind reads it. */
  let clock = 0;

  /** Whether anything is drawing at all — and deliberately a *boolean*.
   *
   *  Calling `living(profile)` inside the effect below would have tracked every
   *  layer's `on` and `opacity`, so the effect re-ran on each one — and an
   *  effect re-running means its teardown first, which is `stop()`. Dragging a
   *  layer's opacity would have wiped every flourish on the wall and re-rolled
   *  the whole flock. A derived only notifies when its value actually changes, so
   *  this re-runs when the wall goes bare or comes back and at no other time. */
  const alive = $derived(living(profile));

  $effect(() => {
    if (!alive || !el) {
      stop();
      return;
    }
    start();
    return stop;
  });

  function start() {
    if (raf) return; // already running: a toggled layer must not restart the wall
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    const ctx = el?.getContext("2d");
    if (ctx && w && h) ctx.clearRect(0, 0, w, h);
    /* Everything in flight goes with it. Coming back to a profile should look
       like arriving, not like resuming a paused film. */
    runtimes.clear();
  }

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const p = profile; // untracked: this is not a reaction
    const ctx = el?.getContext("2d");
    if (!ctx || !p) return;

    /* Capped: a stall, a dragged window or a laptop lid must not teleport
       everything a minute forward on the next frame. */
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    clock += dt;

    ctx.clearRect(0, 0, w, h);

    const live = new Set<string>();
    for (const l of p.layers) {
      if (!l.on || l.opacity <= 0) continue;
      live.add(l.id);
      const r = runtime(l.id);
      ctx.save();
      if (l.kind === "swirls") swirls(ctx, l, r, dt);
      else if (l.kind === "leaves") leaves(ctx, l, r, dt);
      else if (l.kind === "ripples") ripples(ctx, l, r, dt);
      else if (l.kind === "footsteps") footsteps(ctx, l, r, dt);
      ctx.restore();
    }
    /* A layer switched off, removed, or belonging to a profile no longer showing
       keeps nothing alive. */
    for (const id of [...runtimes.keys()]) if (!live.has(id)) runtimes.delete(id);
  }

  /** The tone a layer draws in. */
  function tone(l: Layer): Rgb {
    return mix(dark, paper, l.params.ink ?? 0.5);
  }

  /* ── swirls ─────────────────────────────────────────────────────────────
   *
   * A flourish is generated once, from a seed, and then redrawn for as long as it
   * lives — re-rolling it per frame would boil the line rather than draw it. */

  function swirls(ctx: CanvasRenderingContext2D, l: Layer, r: Runtime, dt: number) {
    const q = l.params;
    const spawn = due(r.acc, q.rate, dt);
    r.acc = spawn.acc;
    for (let i = 0; i < spawn.n && r.strokes.length < MAX_STROKES; i += 1) {
      r.strokes.push({
        pts: swirlPoints(Math.floor(r.rnd() * 2 ** 31), {
          size: q.size,
          curl: q.curl,
          wobble: q.wobble,
          width: q.width,
          taper: q.taper,
        }),
        /* Started somewhere on the wall with room to travel — a flourish that
           begins in the corner spends most of itself off the edge. */
        x: q.size * 0.3 + r.rnd() * Math.max(1, w - q.size * 0.6),
        y: q.size * 0.3 + r.rnd() * Math.max(1, h - q.size * 0.6),
        age: 0,
      });
    }

    const colour = tone(l);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const alive: Flourish[] = [];
    for (const s of r.strokes) {
      s.age += dt;
      const env = strokeEnvelope(s.age, q.draw, q.hold, q.fade);
      if (env.done) continue;
      alive.push(s);
      ctx.strokeStyle = rgba(colour, env.alpha * l.opacity * 0.8);
      ctx.save();
      ctx.translate(s.x, s.y);
      tapered(ctx, s.pts, env.drawn, q.width);
      ctx.restore();
    }
    r.strokes = alive;
  }

  /** Stroke a polyline whose width varies along it.
   *
   *  Canvas has one `lineWidth` per path, so a tapered line means either a path
   *  per segment — which is thousands of `stroke()` calls a frame once a few
   *  flourishes are up — or grouping segments by width and stroking each group
   *  once. Round caps hide the steps between groups. */
  function tapered(
    ctx: CanvasRenderingContext2D,
    pts: StrokePoint[],
    upto: number,
    base: number,
  ) {
    const n = pts.length - 1;
    const end = Math.max(0, Math.min(n, upto * n));
    const step = Math.max(0.3, base / 5);
    const groups = new Map<number, Path2D>();
    const seg = (a: StrokePoint, b: StrokePoint) => {
      const k = Math.max(1, Math.round(((a.w + b.w) / 2) / step));
      let path = groups.get(k);
      if (!path) {
        path = new Path2D();
        groups.set(k, path);
      }
      path.moveTo(a.x, a.y);
      path.lineTo(b.x, b.y);
    };

    const whole = Math.floor(end);
    for (let i = 0; i < whole; i += 1) seg(pts[i], pts[i + 1]);
    /* The nib is mid-segment most of the time; without this the line advances in
       visible jumps at anything but a very slow draw. */
    const frac = end - whole;
    if (whole < n && frac > 0.001) {
      const a = pts[whole];
      const b = pts[whole + 1];
      seg(a, {
        x: a.x + (b.x - a.x) * frac,
        y: a.y + (b.y - a.y) * frac,
        w: a.w + (b.w - a.w) * frac,
      });
    }
    for (const [k, path] of groups) {
      ctx.lineWidth = k * step;
      ctx.stroke(path);
    }
  }

  /* ── leaves ─────────────────────────────────────────────────────────────── */

  function leaves(ctx: CanvasRenderingContext2D, l: Layer, r: Runtime, dt: number) {
    const q = l.params;
    const want = Math.round(q.count);
    /* Reconciled rather than respawned: turning the count up adds leaves and
       leaves the ones already drifting exactly where they are. */
    while (r.flock.length < want) r.flock.push(leaf(r.rnd, w, h));
    while (r.flock.length > want) r.flock.pop();
    if (!r.flock.length) return;

    const wind = windAt(clock, q.wind, q.gust, q.period);
    const margin = q.size * 3;
    const colour = tone(l);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    const motion = {
      wind: q.wind,
      gust: q.gust,
      period: q.period,
      fall: q.fall,
      sway: q.sway,
      spin: q.spin,
    };
    for (let i = 0; i < r.flock.length; i += 1) {
      /* `wrapLeaf` hands back the same leaf when it is still in the room, so the
         edge case costs nothing on the frames where nothing has left. */
      const next = wrapLeaf(leafStep(r.flock[i], dt, wind, motion), w, h, margin, r.rnd);
      r.flock[i] = next;
      drawLeaf(ctx, next, q.size * next.scale, q.curl, colour, l.opacity);
    }
  }

  /** A drawn leaf: two curves meeting at the tips, with a rib.
   *
   *  Filled faintly and outlined, because a solid shape at this size reads as a
   *  blob and an outline alone reads as a hole. `curl` bends one edge more than
   *  the other, which is what stops a leaf looking like an eye. */
  function drawLeaf(
    ctx: CanvasRenderingContext2D,
    lf: Leaf,
    size: number,
    curl: number,
    colour: Rgb,
    opacity: number,
  ) {
    const L = size / 2;
    const W = size * 0.34 * (1 + curl * 0.4);
    ctx.save();
    ctx.translate(lf.x, lf.y);
    ctx.rotate(lf.a);
    ctx.beginPath();
    ctx.moveTo(-L, 0);
    ctx.quadraticCurveTo(-L * 0.2, -W, L, 0);
    ctx.quadraticCurveTo(-L * 0.2, W * (1 - curl * 0.55), -L, 0);
    ctx.closePath();
    ctx.fillStyle = rgba(colour, 0.34 * opacity * lf.scale);
    ctx.fill();
    ctx.strokeStyle = rgba(colour, 0.7 * opacity);
    ctx.lineWidth = Math.max(0.5, size * 0.045);
    ctx.stroke();
    /* The rib. One line, and the difference between a leaf and a lens. */
    ctx.beginPath();
    ctx.moveTo(-L, 0);
    ctx.quadraticCurveTo(0, -W * 0.22 * (1 + curl), L, 0);
    ctx.strokeStyle = rgba(colour, 0.45 * opacity);
    ctx.lineWidth = Math.max(0.4, size * 0.03);
    ctx.stroke();
    ctx.restore();
  }

  /* ── ripples ────────────────────────────────────────────────────────────── */

  function ripples(ctx: CanvasRenderingContext2D, l: Layer, r: Runtime, dt: number) {
    const q = l.params;
    const spawn = due(r.acc, q.rate, dt);
    r.acc = spawn.acc;
    for (let i = 0; i < spawn.n && r.drops.length < MAX_DROPS; i += 1) {
      r.drops.push({
        x: r.rnd() * w,
        y: r.rnd() * h,
        age: 0,
        phase: r.rnd() * Math.PI * 2,
      });
    }

    const colour = tone(l);
    const shape = { rings: q.rings, speed: q.speed, max: q.max };
    const alive: Drop[] = [];
    for (const d of r.drops) {
      d.age += dt;
      if (rippleDone(d.age, shape)) continue;
      alive.push(d);
      for (const ring of ripple(d.age, shape)) {
        ctx.beginPath();
        /* A polyline rather than `arc`, because a ring exactly round reads as a
           target. The wobble needs points to happen at. */
        const steps = Math.max(24, Math.min(96, Math.round(ring.radius / 3)));
        for (let s = 0; s <= steps; s += 1) {
          const a = (s / steps) * Math.PI * 2;
          const rad = rippleRadius(ring.radius, a, q.wobble, d.phase);
          const x = d.x + Math.cos(a) * rad;
          const y = d.y + Math.sin(a) * rad;
          if (s === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = rgba(colour, ring.alpha * l.opacity * 0.85);
        ctx.lineWidth = q.width;
        ctx.stroke();
      }
    }
    r.drops = alive;
  }

  /* ── footsteps ──────────────────────────────────────────────────────────── */

  function footsteps(ctx: CanvasRenderingContext2D, l: Layer, r: Runtime, dt: number) {
    const q = l.params;
    const spawn = due(r.acc, q.rate, dt);
    r.acc = spawn.acc;
    const margin = Math.max(40, q.stride * 2);
    for (let i = 0; i < spawn.n && r.walkers.length < MAX_WALKERS; i += 1) {
      r.walkers.push({
        walk: walkIn(r.rnd, w, h, margin),
        name: q.names > 0.5 ? pickName(r.rnd, names) : null,
        prints: [],
        pace: 0,
        gone: false,
      });
    }

    const colour = tone(l);
    const shape = { stride: q.stride, spread: q.spread, wander: q.wander };
    const alive: Walker[] = [];

    for (const man of r.walkers) {
      if (!man.gone) {
        man.pace += q.pace * dt;
        /* Whole steps only, and at most a handful in one frame — a long frame
           must not lay down a whole trail at once. */
        let steps = Math.min(4, Math.floor(man.pace));
        man.pace -= Math.floor(man.pace);
        while (steps-- > 0) {
          const s = stepOn(man.walk, shape, r.rnd);
          man.walk = s.walk;
          man.prints.push({ ...s.print, age: 0 });
          if (walkedOut(man.walk, w, h, margin)) {
            man.gone = true;
            break;
          }
        }
      }

      /* Prints go on fading where they were left, so a walker who has gone is
         kept until the last of their trail has. */
      const prints: Print[] = [];
      let newest: { print: Print; alpha: number } | null = null;
      for (const pr of man.prints) {
        pr.age += dt;
        /* Pressed in rather than drawn: the same envelope with a very short
           draw, and `drawn` used as the press instead of a nib position. */
        const env = strokeEnvelope(pr.age, 0.12, q.hold, q.fade);
        if (env.done) continue;
        prints.push(pr);
        const a = env.alpha * l.opacity;
        drawPrint(ctx, pr, q.size * (0.55 + 0.45 * env.drawn), colour, a);
        if (!newest || pr.age < newest.print.age) newest = { print: pr, alpha: a };
      }
      man.prints = prints;

      if (man.name && newest) {
        /* Beside the leading pair, upright however the walk is going: a name
           that rotates with the heading is unreadable half the time. */
        ctx.font = `${Math.max(9, q.size * 0.78)}px ${util}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = rgba(colour, newest.alpha * 0.85);
        ctx.fillText(man.name, newest.print.x, newest.print.y - q.size * 1.1);
      }

      if (!man.gone || man.prints.length) alive.push(man);
    }
    r.walkers = alive;
  }

  /** One footprint: a ball, a heel, and a couple of toes.
   *
   *  Three shapes rather than one oval — an oval at this size is a bean, and the
   *  whole point of the effect is that you can tell which way somebody went. */
  function drawPrint(
    ctx: CanvasRenderingContext2D,
    pr: Print,
    size: number,
    colour: Rgb,
    alpha: number,
  ) {
    ctx.save();
    ctx.translate(pr.x, pr.y);
    ctx.rotate(pr.a);
    /* Left and right are the same print mirrored across the direction of
       travel, which is what makes the toes splay outwards on both sides. */
    ctx.scale(1, pr.foot === 0 ? 1 : -1);
    ctx.fillStyle = rgba(colour, alpha);

    ctx.beginPath();
    ctx.ellipse(size * 0.12, 0, size * 0.3, size * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.ellipse(-size * 0.34, size * 0.03, size * 0.16, size * 0.14, 0, 0, Math.PI * 2);
    ctx.fill();

    for (let i = 0; i < 3; i += 1) {
      ctx.beginPath();
      ctx.ellipse(
        size * (0.46 - i * 0.04),
        size * (0.16 - i * 0.09),
        size * 0.055,
        size * 0.05,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    ctx.restore();
  }
</script>

<canvas class="backdrop" bind:this={el} aria-hidden="true"></canvas>

<style>
  .backdrop {
    position: absolute;
    inset: 0;
    /* Explicit, not implied by `inset`. A canvas is a replaced element: with
       `width: auto` it draws at its attribute size and the offsets are ignored,
       which is how the element once grew to twenty-two million pixels across. */
    width: 100%;
    height: 100%;
    /* The wall pans and the cards are pressed; nothing here may take an event.
       It is also why this is one canvas rather than elements. */
    pointer-events: none;
    /* No z-index on purpose: `.pan` follows it in the DOM, so everything on
       the wall — including a reference image in the back band — draws over it.
       One stacking order for the wall, described in layout.ts. */
    display: block;
    /* Read back by the renderer for the footstep names, so the one place the
       fonts are named stays tokens.css. */
    font-family: var(--util);
  }
</style>
