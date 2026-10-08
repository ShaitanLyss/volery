<script lang="ts">
  /* The roots, painted.
   *
   * One canvas in screen space, behind the whole wall, and a frame loop that
   * only exists while something is growing or charged. Everything it draws is
   * worked out in `lineage.ts`; nothing here decides anything you could assert.
   *
   * Five things about it are deliberate:
   *
   * - **Behind the cards, and that is the feature.** A sibling of `Backdrop`
   *   inside `.surface` and *before* `.pan` in the document, so it draws over
   *   the ambience and under the territories, the images and the cards. The
   *   relay strand is the mirror of this one layer up: above the cards is
   *   traffic, below them is structure. It also means a root arriving at a card
   *   passes under it rather than across its title.
   *
   * - **Screen space, canvas-space widths.** Endpoints come from `rootBoxes`,
   *   which is `Flow`'s `cardBoxes` with the shadows added, already in screen
   *   pixels; the widths are scaled by `studio.scale` and clamped, because a
   *   root is a thing on the ground beside
   *   the cards rather than light crossing a room. See the note over `BASE`.
   *
   * - **One fill for all of it.** Every limb of every family goes into a single
   *   `Path2D` and is filled once, so the coincident trunk of a fork unions
   *   instead of stacking its alpha into a dark seam. This is the only reason
   *   the fork can be emergent rather than computed.
   *
   * - **Endpoints are read fresh.** A card dragged takes its root with it, and
   *   so does a pan and a zoom — the root is between two *cards*. Static frames
   *   are redrawn from a reactive read of the boxes; only motion of our own
   *   costs a loop.
   *
   * - **Colour is status, so the root has none.** `--edge`, the tone the wall's
   *   own furniture is in. The one moving light is celadon and means the child
   *   is working — see the module note in `lineage.ts` for why that is the only
   *   honest way to have it.
   */

  import { hexRgb, rgba, type Rgb } from "./ambience";
  import { centreOf, type Box, type Pt } from "./flow";
  import {
    CHARGE_ALPHA,
    CHARGE_MS,
    FILL_ALPHA,
    HALO_ALPHA,
    SHEEN_ALPHA,
    STRAY_FADE,
    chargeAt,
    familiesOf,
    limbsFor,
    outline,
    spine,
    stirring,
    stitches,
    strayFor,
    straysOf,
    withdrawing,
    type Departing,
    type Kin,
    type Limb,
  } from "./lineage";

  let {
    kin,
    boxes,
    scale,
    charged,
  }: {
    /** Every recorded parentage the wall knows, whichever machine each end
     *  runs on (`Elsewhere.kin`). Pairs whose ends are not both on the wall are
     *  dropped by `familiesOf` and `unseen` ones drawn by `straysOf`, so this
     *  needs no filtering. */
    kin: readonly Kin[];
    /** Every card's box in screen pixels, by id, and every shadow's —
     *  `Canvas`'s `rootBoxes`, which is `cardBoxes` (the map `Flow` is given)
     *  with the other walls' cards added. */
    boxes: ReadonlyMap<string, Box>;
    /** The wall's zoom, which the widths follow. */
    scale: number;
    /** Which children are working this second. The only thing that moves. */
    charged: ReadonlySet<string>;
  } = $props();

  /* One clock, and it is the wall clock rather than `performance.now()`.
     `born` is stamped by `Skein` off `Date.now()`, because it mirrors a row Rust
     wrote with a unix timestamp — and two clocks in one animation is a root
     whose growth is measured against an epoch it never started from, which
     leaves `reachOf` clamped at zero and nothing drawn at all. */
  let el = $state<HTMLCanvasElement | undefined>();
  let w = 0;
  let h = 0;
  let root: Rgb = [51, 44, 41];
  let sheen: Rgb = [97, 88, 80];
  let work: Rgb = [127, 184, 164];
  /* Read once at mount, per `Flow`: a preference changing mid-growth should not
     change how a root already on the wall behaves. */
  let still = false;

  function measure() {
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const dpr = window.devicePixelRatio || 1;
    w = parent.clientWidth;
    h = parent.clientHeight;
    el.width = Math.max(1, Math.round(w * dpr));
    el.height = Math.max(1, Math.round(h * dpr));
    const ctx = el.getContext("2d");
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function readTheme() {
    if (!el) return;
    const cs = getComputedStyle(el);
    /* The wall's own furniture tone and the faintest ink on it. Read rather
       than hardcoded: the theme lives in tokens.css and only there, so a
       derived theme moves the roots with everything else. */
    root = hexRgb(cs.getPropertyValue("--edge"), root);
    sheen = hexRgb(cs.getPropertyValue("--paper-faint"), sheen);
    work = hexRgb(cs.getPropertyValue("--st-work"), work);
  }

  /** What the last frame had, per child, so a card leaving the wall can be
   *  noticed at all. A card is taken out of `convs` the instant it is closed
   *  (`restore.md`), so this map is the only place its geometry still exists by
   *  the time we find out. Plain `let` rather than `$state`: it is written from
   *  inside the paint, and a reactive write there is a loop. */
  let seen = new Map<string, { limb: Limb; parent: string; anchor: Pt }>();
  /** Roots on their way home. */
  let going = new Map<string, Departing>();

  /** Everything to draw, this frame, with the departures worked out on the way.
   *
   *  The diff is the whole mechanism: whatever was in `seen` and is no longer
   *  drawable has had its card closed, so it is moved into `going` with the
   *  geometry it had when we last saw it. Removed from `seen` in the same step,
   *  or it would be re-detected every frame and its retreat would start over
   *  forever. */
  function shape(now: number): { limb: Limb; alpha: number }[] {
    const live: { limb: Limb; alpha: number }[] = [];
    const fresh = new Map<string, { limb: Limb; parent: string; anchor: Pt }>();
    for (const family of familiesOf(kin, boxes)) {
      const anchor = centreOf(family.parent);
      for (const limb of limbsFor(family.parent, family.kids, { scale, now, still })) {
        live.push({ limb, alpha: 1 });
        fresh.set(limb.child, { limb, parent: family.id, anchor });
        /* Back on the wall — it cannot happen today, since a closed card stays
           closed, but a retreat left running for a card that is drawing again
           would be two of the same root. */
        going.delete(limb.child);
      }
    }
    /* A card whose parent is on a wall this one cannot see. There is no parent
       box to anchor its retreat to, so it is filed under the parent's shadow
       id — which is not on the wall, and `withdrawing` reads that as "use the
       coordinates it left with". */
    for (const kid of straysOf(kin, boxes)) {
      const limb = strayFor(kid, { scale, now, still });
      live.push({ limb, alpha: 1 });
      fresh.set(limb.child, { limb, parent: kid.parent, anchor: centreOf(kid.box) });
      going.delete(limb.child);
    }
    for (const [child, was] of seen) {
      if (fresh.has(child) || going.has(child)) continue;
      /* Nothing to animate under `prefers-reduced-motion`: the finished state of
         a departure is the absence of it. */
      if (!still) {
        going.set(child, { limb: was.limb, parent: was.parent, anchor: was.anchor, at: now });
      }
    }
    seen = fresh;

    const out = [...live];
    for (const [child, dep] of going) {
      const home = withdrawing(dep, now, boxes.get(dep.parent) ?? null);
      if (!home) {
        going.delete(child);
        continue;
      }
      out.push(home);
    }
    return out;
  }

  function trace(
    ctx: CanvasRenderingContext2D,
    limbs: readonly { limb: Limb; alpha: number }[],
    now: number,
  ) {
    ctx.clearRect(0, 0, w, h);
    if (limbs.length === 0) return;

    /* One path per weight, filled once — the union is what makes a trunk out of
       limbs that merely coincide, and it only works between limbs drawn at the
       same alpha. Live roots are all one group; a family closed together shares
       a departure time and is therefore one group as well, which is the case
       that matters — filling those separately would darken the trunk they still
       share on the way home. `nonzero` rather than `evenodd`: overlapping
       subpaths have to add up, not cancel out. */
    const bodies = new Map<number, Path2D>();
    /* A root between two machines is laid in stitches (`lineage.ts`, "across
       walls"): the same outline cut into stretches, each a subpath of the same
       body — so a stitched limb sharing a trunk with a solid one still unions
       into it instead of darkening where they coincide. A stray is filled on
       its own with its free end faded out, since a gradient belongs to a fill
       and the rest of the body must not wear it. */
    const loose: { body: Path2D; limb: Limb; alpha: number }[] = [];
    for (const { limb, alpha } of limbs) {
      const spans: [number, number][] = limb.across ? stitches(limb, scale) : [[0, 1]];
      const body = limb.loose ? new Path2D() : (bodies.get(alpha) ?? new Path2D());
      let drew = false;
      for (const [from, to] of spans) {
        const ring = outline(limb, undefined, from, to);
        if (ring.length === 0) continue;
        body.moveTo(ring[0].x, ring[0].y);
        for (let i = 1; i < ring.length; i += 1) body.lineTo(ring[i].x, ring[i].y);
        body.closePath();
        drew = true;
      }
      if (!drew) continue;
      if (limb.loose) loose.push({ body, limb, alpha });
      else bodies.set(alpha, body);
    }
    for (const [alpha, body] of bodies) {
      ctx.fillStyle = rgba(root, FILL_ALPHA * alpha);
      ctx.fill(body, "nonzero");
    }
    for (const { body, limb, alpha } of loose) {
      const [a, , , b] = limb.spine;
      const fade = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      fade.addColorStop(0, rgba(root, 0));
      fade.addColorStop(STRAY_FADE, rgba(root, FILL_ALPHA * alpha));
      fade.addColorStop(1, rgba(root, FILL_ALPHA * alpha));
      ctx.fillStyle = fade;
      ctx.fill(body, "nonzero");
    }

    /* The sheen, on the parent half only, which is where the root is thick
       enough to have a top. Drawn per limb rather than into one path because it
       is a stroke and strokes do not union. */
    ctx.lineCap = "round";
    for (const { limb, alpha } of limbs) {
      /* Not on a stitched root: a stroke is continuous, so it would bridge the
         very gaps that say the root crosses between machines. */
      if (limb.reach <= 0.05 || limb.across) continue;
      const pts = spine(limb, 0, 0.55, 10);
      ctx.strokeStyle = rgba(sheen, SHEEN_ALPHA * alpha);
      ctx.lineWidth = Math.max(0.7, limb.base * 0.34);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }

    /* The charge. Only on a root whose child is working, only once it has
       finished growing — a card's first turn opens while its root is still on
       its way out, and a charge running a root that is not there yet is light
       arriving before the thing it travelled along. */
    for (const { limb, alpha } of limbs) {
      /* Never on a root going home: the card at the far end has gone, so there
         is nothing for a charge to be arriving at. `alpha` is the test rather
         than a second flag — a limb drawn at anything less than its full weight
         is one that is leaving. */
      if (alpha < 1 || !charged.has(limb.child) || limb.reach < 1) continue;
      /* Nor on a stray: a charge is work moving between two cards, and one of
         them is on a wall this one cannot see. The card's own colour still says
         it is working. */
      if (limb.loose) continue;
      /* Held rather than absent under `prefers-reduced-motion`, per `Flow`: what
         a charge says is that this child is working, and none of that is in the
         movement. A wall that answers the preference by drawing nothing has
         answered a different question. */
      const at = chargeAt(still ? CHARGE_MS * 0.42 : now);
      if (!at) continue;
      const pts = spine(limb, at.tail, at.head, 12);
      const width = Math.max(1.2, limb.base * 0.5);
      /* Halo first, wide and soft, then the core over it. Two strokes rather
         than a shadow: `shadowBlur` on a path this long is measurably slower
         and this loop runs while an agent is streaming. */
      ctx.strokeStyle = rgba(work, HALO_ALPHA);
      ctx.lineWidth = width * 3.4;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.strokeStyle = rgba(work, still ? CHARGE_ALPHA * 0.6 : CHARGE_ALPHA);
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
  }

  $effect(() => {
    const parent = el?.parentElement;
    if (!parent) return;
    still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    measure();
    readTheme();
    const ro = new ResizeObserver(() => {
      measure();
      paint(Date.now());
    });
    ro.observe(parent);
    return () => ro.disconnect();
  });

  function paint(now: number) {
    const ctx = el?.getContext("2d");
    /* `shape` either way: it is what notices a departure, and a frame with no
       context to draw into must not be a frame that loses one. */
    const limbs = shape(now);
    if (ctx) trace(ctx, limbs, now);
  }

  /** Anything still moving? Growth and the charge are asked of the rows, which
   *  is `stirring`'s own argument; a retreat is asked of the map it lives in. */
  function moving(now: number): boolean {
    return going.size > 0 || stirring(kin, charged, now);
  }

  /* The loop is owned by the component rather than by an effect, which is a
     departure from `Flow` and the retreat is why.
     
     A root going home is not visible in any of this component's inputs: `kin` is
     only ever appended to, and a card closing takes its box out of `boxes` —
     which is the same shape a *pan* has. So the only place a departure can be
     noticed is the paint, and if the clock were held by an effect keyed on the
     inputs there would be nothing to re-run it: the departure would be detected
     and then sit there, one frame in, until the wall happened to move again.
     
     So: every paint asks for a loop, and the loop stops itself. `ensureLoop` is
     idempotent, so the reactive paint below can call it on every frame of a pan
     without tearing anything down — the churn `flow.md` warns about, avoided by
     not making the loop reactive at all rather than by choosing dependencies
     carefully. */
  let raf = 0;
  function ensureLoop() {
    if (raf || still) return;
    raf = requestAnimationFrame(step);
  }
  function step() {
    raf = 0;
    const now = Date.now();
    paint(now);
    /* Re-asked every frame rather than once, because every reason to be here
       ends on its own: growth finishes, a card stops working, a root gets
       home. An idle wall runs no frames — `Backdrop`'s rule and `Flow`'s. */
    if (moving(now)) ensureLoop();
  }

  /* The wall moved, or the parentage changed, or a child started working, or one
     went away: one frame, off a reactive read. This is what makes a static root
     free — the roots are not animated, they are simply *there*, and there is
     redrawn only when there is a different answer. */
  $effect(() => {
    void kin;
    void boxes;
    void scale;
    void charged;
    if (!el) return;
    paint(Date.now());
    ensureLoop();
  });

  /* Teardown only. It reads nothing, so it never re-runs — which is the point:
     an effect that owned the loop *and* read the inputs would cancel it on every
     pan frame. */
  $effect(() => () => cancelAnimationFrame(raf));
</script>

<canvas class="lineage" bind:this={el}></canvas>

<style>
  /* Behind everything on the wall and in front of the weather.
     `Backdrop`'s canvas is the layer under this one and `.pan` — the whole
     transformed wall, territories and cards and all — is the layer over it, by
     document order rather than by a z-index anybody has to keep winning. A card
     is opaque (`ambience.md`), so a root reaching one goes under it.

     Pinned to 100% of `.surface` rather than measured from itself, per
     `measure()`: a canvas sized from its own box cannot grow. */
  .lineage {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
</style>
