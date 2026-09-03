import { describe, expect, test } from "bun:test";
import {
  MAX_SCALE,
  STEP,
  canPan,
  centreOf,
  clampView,
  fitScale,
  fitView,
  isActual,
  isFit,
  panBy,
  readout,
  scaleBounds,
  wheelFactor,
  zoomBy,
  zoomTo,
} from "../src/lib/zoom";

/** The composed viewport every preview is written against. */
const VP = { w: 1280, h: 800 };
/** A stage roughly the shape one of three side-by-side panels gets. */
const BOX = { w: 400, h: 500 };
/** And one that is wider than it is tall, so the other axis binds. */
const WIDE = { w: 1600, h: 500 };

describe("fitting", () => {
  test("contains rather than covers, so nothing is decided about a cropped design", () => {
    // 400/1280 = 0.3125 binds; 500/800 = 0.625 would crop the width away.
    expect(fitScale(BOX, VP)).toBeCloseTo(0.3125, 6);
    expect(fitScale(WIDE, VP)).toBeCloseTo(0.625, 6);
  });

  test("a box with no size yet does not produce a scale of zero", () => {
    // The stage is measured after mount, so the first render asks with 0×0 —
    // and a zero scale is a frame translated to NaN by the first anchored zoom.
    expect(fitScale({ w: 0, h: 0 }, VP)).toBe(1);
    expect(fitScale(BOX, { w: 0, h: 0 })).toBe(1);
  });

  test("the fit view centres the design rather than pinning it to a corner", () => {
    const v = fitView(WIDE, VP);
    expect(v.scale).toBeCloseTo(0.625, 6);
    // 1280 * 0.625 = 800 wide in a 1600 box → 400 either side.
    expect(v.x).toBeCloseTo(400, 6);
    // 800 * 0.625 = 500, exactly the box height → nothing left over.
    expect(v.y).toBeCloseTo(0, 6);
  });

  test("fit is the floor, and it wins over the ceiling on a stage bigger than the composition", () => {
    expect(scaleBounds(BOX, VP).min).toBeCloseTo(fitScale(BOX, VP), 6);
    expect(scaleBounds(BOX, VP).max).toBe(MAX_SCALE);

    // A stage 6× the composed viewport: clamping to MAX_SCALE here would leave
    // the design unable to fill its own stage.
    const huge = { w: 1280 * 6, h: 800 * 6 };
    expect(scaleBounds(huge, VP).min).toBeCloseTo(6, 6);
    expect(scaleBounds(huge, VP).max).toBeCloseTo(6, 6);
  });

  test("there is no reading below fit", () => {
    const v = clampView({ scale: 0.01, x: 0, y: 0 }, BOX, VP);
    expect(v.scale).toBeCloseTo(fitScale(BOX, VP), 6);
  });
});

describe("holding the design on its own stage", () => {
  test("content larger than the box never lets an edge come inside one", () => {
    const zoomed = { scale: 1, x: 0, y: 0 };
    // Dragged hard right: x may not go positive, or the backdrop shows on the left.
    expect(panBy(zoomed, 9999, 0, BOX, VP).x).toBe(0);
    // Dragged hard left: stops when the right edge reaches the box's right edge.
    expect(panBy(zoomed, -9999, 0, BOX, VP).x).toBeCloseTo(400 - 1280, 6);
  });

  test("content smaller than the box is centred on both axes, whatever it is told", () => {
    const v = clampView({ scale: 0.1, x: -900, y: 620 }, WIDE, VP);
    // 0.1 is below fit for this box, so it clamps up to fit first…
    expect(v.scale).toBeCloseTo(0.625, 6);
    // …and then centres, ignoring the offsets entirely.
    expect(v.x).toBeCloseTo(400, 6);
    expect(v.y).toBeCloseTo(0, 6);
  });

  test("a view that was already legal is left alone", () => {
    const v = { scale: 1, x: -100, y: -200 };
    expect(clampView(v, BOX, VP)).toEqual(v);
  });
});

describe("zooming at a point", () => {
  test("whatever is under the anchor stays under it", () => {
    const box = { w: 1280, h: 800 };
    const start = fitView(box, VP); // scale 1, x 0, y 0
    const anchor = { x: 300, y: 200 };
    const next = zoomTo(start, 2, anchor, box, VP);

    // The content coordinate under the anchor before and after must agree.
    const before = { x: (anchor.x - start.x) / start.scale, y: (anchor.y - start.y) / start.scale };
    const after = { x: (anchor.x - next.x) / next.scale, y: (anchor.y - next.y) / next.scale };
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  test("the clamp still wins near an edge, because honouring the anchor there shows the backdrop", () => {
    const box = { w: 640, h: 400 };
    // Anchored hard in the top-left corner and magnified: an edge must not come
    // inside the stage, whatever the anchor asked for.
    const next = zoomTo({ scale: 1, x: -200, y: -100 }, 2, { x: 0, y: 0 }, box, VP);
    expect(next.x).toBeLessThanOrEqual(0);
    expect(next.y).toBeLessThanOrEqual(0);

    // And zooming back out past fit is where the anchor would genuinely put the
    // design off-centre: the clamp takes it instead, which is the centring rule
    // doing the work rather than a special case for shrinking.
    const out = zoomTo({ scale: 2, x: -900, y: -700 }, 0.01, { x: 0, y: 0 }, box, VP);
    expect(out).toEqual(fitView(box, VP));
  });

  test("a view with no scale is recovered rather than divided by", () => {
    // The first frame after mount, before the stage has been measured.
    const v = zoomTo({ scale: 0, x: 0, y: 0 }, 2, { x: 10, y: 10 }, BOX, VP);
    expect(Number.isFinite(v.x)).toBe(true);
    expect(Number.isFinite(v.y)).toBe(true);
    expect(v.scale).toBeGreaterThan(0);
  });

  test("stepping up and back down returns to where it started", () => {
    // Half the composed size, so at scale 1 there is genuine room to be panned
    // within — on a stage the size of the composition the start view would be
    // centred by the clamp and there would be nothing to round-trip.
    const box = { w: 640, h: 400 };
    const start = { scale: 1, x: -200, y: -100 };
    const at = centreOf(box);
    const there = zoomBy(start, STEP, at, box, VP);
    const back = zoomBy(there, 1 / STEP, at, box, VP);
    expect(back.scale).toBeCloseTo(start.scale, 6);
    expect(back.x).toBeCloseTo(start.x, 6);
    expect(back.y).toBeCloseTo(start.y, 6);
  });

  test("the ceiling holds however hard it is pushed", () => {
    let v = fitView(BOX, VP);
    for (let i = 0; i < 60; i++) v = zoomBy(v, STEP, centreOf(BOX), BOX, VP);
    expect(v.scale).toBe(MAX_SCALE);
  });
});

describe("the wheel", () => {
  test("scrolling up magnifies and scrolling down reduces", () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1);
    expect(wheelFactor(100)).toBeLessThan(1);
    expect(wheelFactor(0)).toBeCloseTo(1, 6);
  });

  test("a mouse reporting lines is not treated as three pixels", () => {
    // deltaMode 1 is lines. Three lines must be worth much more than three px.
    const lines = wheelFactor(-3, 1);
    const pixels = wheelFactor(-3, 0);
    expect(lines).toBeGreaterThan(pixels);
    expect(lines).toBeCloseTo(wheelFactor(-48, 0), 6);
  });

  test("one trackpad flick cannot jump the whole range", () => {
    // Capped, or a single event is a ~45% scale change and the design flinches.
    expect(wheelFactor(-4000)).toBeCloseTo(wheelFactor(-120), 6);
    expect(wheelFactor(4000)).toBeCloseTo(wheelFactor(120), 6);
  });
});

describe("what the chrome reads off it", () => {
  test("the percentage is against the composed viewport, not against fit", () => {
    expect(readout(1)).toBe("100%");
    expect(readout(0.3125)).toBe("31%");
    expect(readout(4)).toBe("400%");
  });

  test("fit and actual size are recognised so their buttons can be drawn pressed", () => {
    expect(isFit(fitView(BOX, VP), BOX, VP)).toBe(true);
    expect(isFit({ scale: 1, x: 0, y: 0 }, BOX, VP)).toBe(false);
    expect(isActual({ scale: 1, x: 0, y: 0 })).toBe(true);
    expect(isActual(fitView(BOX, VP))).toBe(false);
  });

  test("a stage exactly the composed size is both at once, and that is not a contradiction", () => {
    const box = { w: 1280, h: 800 };
    const v = fitView(box, VP);
    expect(isFit(v, box, VP)).toBe(true);
    expect(isActual(v)).toBe(true);
  });

  test("there is nowhere to pan until the design is bigger than its stage", () => {
    expect(canPan(fitView(BOX, VP), BOX, VP)).toBe(false);
    expect(canPan({ scale: 1, x: 0, y: 0 }, BOX, VP)).toBe(true);
    // Fit on a wide box fills the height exactly — still nothing to drag.
    expect(canPan(fitView(WIDE, VP), WIDE, VP)).toBe(false);
  });
});
