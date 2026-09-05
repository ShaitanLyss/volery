import { describe, expect, test } from "bun:test";
import {
  ARRIVE_MS,
  FILAMENTS,
  FLIGHT_MS,
  MAX_STRANDS,
  PULSES,
  PULSE_SPAN,
  PULSE_STAGGER_MS,
  TRAVEL_MS,
  arrival,
  bowOf,
  centreOf,
  clampInto,
  controls,
  departure,
  done,
  ease,
  fanFor,
  luminance,
  filamentPoint,
  filamentSamples,
  filamentTone,
  paletteFor,
  pointOn,
  tangentOn,
  weaveAt,
  pulseAt,
  retire,
  rimPoint,
  samples,
  screenBox,
  seatDepth,
  stillAlpha,
  wakeAlpha,
  type Pt,
  type Strand,
} from "../src/lib/flow";
import { CARD_BOX } from "../src/lib/layout";

const strand = (over: Partial<Strand> = {}): Strand => ({
  id: "s1",
  from: "a",
  to: "b",
  at: 0,
  delivered: true,
  broadcast: false,
  ...over,
});

describe("screenBox", () => {
  test("is the same arithmetic the glass does, so both ends of a strand agree", () => {
    const box = { x: 100, y: 40, w: 208, h: 78 };
    expect(screenBox(box, { x: 0, y: 0, scale: 1 })).toEqual(box);
    expect(screenBox(box, { x: 30, y: -10, scale: 0.5 })).toEqual({
      x: 80,
      y: 10,
      w: 104,
      h: 39,
    });
  });
});

describe("rimPoint", () => {
  const box = { x: 0, y: 0, w: 200, h: 100 };

  test("leaves through the side the target is on", () => {
    /* Straight right: out through the right edge, a little clear of it. */
    const p = rimPoint(box, { x: 1000, y: 50 });
    expect(p.y).toBeCloseTo(50, 5);
    expect(p.x).toBeGreaterThan(200);
    expect(p.x).toBeLessThan(210);

    /* Straight down: through the bottom, not the right. */
    const q = rimPoint(box, { x: 100, y: 1000 });
    expect(q.x).toBeCloseTo(100, 5);
    expect(q.y).toBeGreaterThan(100);
  });

  test("never starts inside the card, so light never crosses its title", () => {
    const c = centreOf(box);
    for (const to of [
      { x: 400, y: 50 },
      { x: -400, y: 50 },
      { x: 100, y: -300 },
      { x: -50, y: 300 },
    ]) {
      const p = rimPoint(box, to);
      const outside = Math.abs(p.x - c.x) > box.w / 2 || Math.abs(p.y - c.y) > box.h / 2;
      expect(outside).toBe(true);
    }
  });

  test("a target on top of the card is the card, rather than a NaN", () => {
    expect(rimPoint(box, centreOf(box))).toEqual(centreOf(box));
  });
});

/* The other half of the same question, and the mirror of `rimPoint`: that one
   answers where a thing stops *short* of a card, this one how far past it you
   must go for something of a given size to be hidden by it. `lineage.ts` is the
   caller — a root closes with a flat chord and it has to be under the card. */
describe("seating a thing under a card", () => {
  const box = { x: 0, y: 0, w: 200, h: 100 };
  const c = centreOf(box);
  const inside = (p: Pt, r: number) =>
    Math.abs(p.x - c.x) <= box.w / 2 - r + 1e-9 && Math.abs(p.y - c.y) <= box.h / 2 - r + 1e-9;
  const walk = (p: Pt, dir: Pt, a: number) => ({ x: p.x + dir.x * a, y: p.y + dir.y * a });

  test("it stops the moment the whole disc is inside, and not before", () => {
    const p = { x: 260, y: 50 };
    const dir = { x: -1, y: 0 };
    const a = seatDepth(box, p, dir, 8);
    /* 260 → the edge is 60 away, and 8 more buries a disc of radius 8. */
    expect(a).toBeCloseTo(68, 9);
    expect(inside(walk(p, dir, a), 8)).toBe(true);
    expect(inside(walk(p, dir, a - 0.01), 8)).toBe(false);
  });

  test("a point already deep enough needs no travel at all", () => {
    expect(seatDepth(box, c, { x: 1, y: 0 }, 8)).toBe(0);
  });

  /* The case the whole helper exists for: coming in at an angle, where the
     binding axis is whichever runs out first — and for a card, which is much
     wider than it is tall, that is nearly always the short one. */
  test("the tighter of the two axes is the one that decides", () => {
    const dir = { x: -Math.cos(0.5), y: -Math.sin(0.5) };
    const p = { x: 400, y: 300 };
    const a = seatDepth(box, p, dir, 8);
    const at = walk(p, dir, a);
    expect(inside(at, 8)).toBe(true);
    /* On the boundary of the shrunken box rather than somewhere past it: this
       must not bury more than it has to, since the stub it seats is drawn. */
    const slack = Math.min(
      box.w / 2 - 8 - Math.abs(at.x - c.x),
      box.h / 2 - 8 - Math.abs(at.y - c.y),
    );
    expect(slack).toBeCloseTo(0, 6);
  });

  /* A box too thin to hold the disc is a real configuration rather than a
     curiosity — a card at field density is 40px tall before the zoom has
     touched it. The answer has to be finite either way: an Infinity here would
     put a root's base somewhere on the far side of the wall. */
  const thin = { x: 0, y: 0, w: 200, h: 6 };

  test("an axis that cannot be satisfied does not stop the one that can", () => {
    /* Dead along the thin box's own centre line: nothing will ever hide the
       disc vertically, and travelling further than it takes to hide it
       horizontally would bury the stub for nothing. */
    expect(seatDepth(thin, { x: 260, y: 3 }, { x: -1, y: 0 }, 8)).toBeCloseTo(68, 9);
  });

  test("and when neither can, it seats at the box's own centre", () => {
    /* As deep as this box goes, which is the most hiding there is to be had. */
    expect(seatDepth(thin, { x: 260, y: 5 }, { x: -1, y: 0 }, 8)).toBeCloseTo(160, 9);
  });

  test("a direction pointing away from the card never gets there", () => {
    /* Not an error and not an infinity: nought, so the caller draws what it
       would have drawn before. */
    expect(seatDepth(box, { x: 260, y: 50 }, { x: 1, y: 0 }, 8)).toBe(0);
  });

  test("a direction of no length is nought, not a NaN", () => {
    expect(seatDepth(box, { x: 260, y: 50 }, { x: 0, y: 0 }, 8)).toBe(0);
  });
});

describe("the bow", () => {
  test("grows with the distance, between a floor and a ceiling", () => {
    const near = bowOf({ x: 0, y: 0 }, { x: 40, y: 0 });
    const mid = bowOf({ x: 0, y: 0 }, { x: 400, y: 0 });
    const far = bowOf({ x: 0, y: 0 }, { x: 4000, y: 0 });
    expect(near).toBe(24);
    expect(mid).toBeCloseTo(72, 5);
    expect(far).toBe(120);
  });

  /* The whole of how direction is readable with no arrowhead anywhere: a reply
     runs down the other side of the same pair of cards. */
  test("a reply arcs the other way from the message it answers", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 300, y: 0 };
    const there = controls(a, b, bowOf(a, b));
    const back = controls(b, a, bowOf(b, a));
    expect(Math.sign(there[0].y)).toBe(-Math.sign(back[0].y));
    expect(there[0].y).not.toBe(0);
  });

  test("a second message to the same card is drawn beside the first", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 300, y: 0 };
    expect(Math.abs(bowOf(a, b, 1))).toBeGreaterThan(Math.abs(bowOf(a, b, 0)));
    /* Beside, never mirrored: a fan that flipped the sign would buy the
       separation by making half the strands lie about their direction. */
    expect(Math.sign(controls(a, b, bowOf(a, b, 1))[0].y)).toBe(
      Math.sign(controls(a, b, bowOf(a, b, 0))[0].y),
    );
  });
});

describe("the curve", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 300, y: 100 };
  const [c1, c2] = controls(a, b, bowOf(a, b));

  test("starts and ends on the two cards", () => {
    expect(pointOn(a, c1, c2, b, 0)).toEqual(a);
    expect(pointOn(a, c1, c2, b, 1)).toEqual(b);
  });

  test("bulges off the straight line between them", () => {
    const mid = pointOn(a, c1, c2, b, 0.5);
    const straight = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    expect(Math.hypot(mid.x - straight.x, mid.y - straight.y)).toBeGreaterThan(10);
  });

  test("samples a stretch of it, inclusive at both ends", () => {
    const pts = samples(a, c1, c2, b, 0.25, 0.75, 8);
    expect(pts).toHaveLength(9);
    expect(pts[0]).toEqual(pointOn(a, c1, c2, b, 0.25));
    expect(pts[8]).toEqual(pointOn(a, c1, c2, b, 0.75));
  });
});

describe("ease", () => {
  test("is bounded and monotonic, so a pulse never runs backwards", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(-3)).toBe(0);
    expect(ease(9)).toBe(1);
    let last = -1;
    for (let t = 0; t <= 1.0001; t += 0.02) {
      const v = ease(t);
      expect(v).toBeGreaterThanOrEqual(last);
      last = v;
    }
  });

  test("leaves faster than it arrives, which is what reads as *sent*", () => {
    expect(ease(0.1)).toBeGreaterThan(0.1 * 0.1);
    expect(1 - ease(0.9)).toBeLessThan(0.1);
  });
});

describe("a pulse", () => {
  test("has not started before its stagger, and is gone after its span", () => {
    expect(pulseAt(0, 0)).toBeNull();
    expect(pulseAt(PULSE_STAGGER_MS - 1, 1)).toBeNull();
    expect(pulseAt(FLIGHT_MS + 1000, 0)).toBeNull();
  });

  test("keeps its head ahead of its tail all the way across", () => {
    for (let age = 10; age < TRAVEL_MS; age += 25) {
      const p = pulseAt(age, 0);
      if (!p) continue;
      expect(p.head).toBeGreaterThan(p.tail);
      expect(p.head).toBeLessThanOrEqual(1);
      expect(p.tail).toBeGreaterThanOrEqual(0);
    }
  });

  /* Landing has to be light being absorbed rather than a dot being deleted, so
     the pulse shortens into the rim instead of stopping there. */
  test("shortens into the recipient rather than stopping dead", () => {
    const crossing = pulseAt(TRAVEL_MS * 0.5, 0)!;
    const landing = pulseAt(TRAVEL_MS + PULSE_SPAN * TRAVEL_MS * 0.5, 0)!;
    expect(landing.head).toBe(1);
    expect(landing.head - landing.tail).toBeLessThan(crossing.head - crossing.tail);
  });

  test("all three are in the air at once part-way across", () => {
    const mid = TRAVEL_MS / 2 + PULSE_STAGGER_MS * (PULSES - 1);
    const live = Array.from({ length: PULSES }, (_, i) => pulseAt(mid, i)).filter(Boolean);
    expect(live).toHaveLength(PULSES);
  });
});

describe("the envelopes", () => {
  test("the wake rises behind the first pulse and drains after the last", () => {
    expect(wakeAlpha(0)).toBe(0);
    expect(wakeAlpha(300)).toBe(1);
    expect(wakeAlpha(FLIGHT_MS)).toBe(0);
    /* And empty *before* the strand goes, so the route is never switched off
       with light still on it. */
    expect(wakeAlpha(FLIGHT_MS - 60)).toBe(0);
    /* The last stretch is the route emptying after the light has landed, which
       is what makes the end read as finishing rather than switching off. */
    expect(wakeAlpha(TRAVEL_MS)).toBeGreaterThan(0);
    expect(wakeAlpha(TRAVEL_MS)).toBeLessThanOrEqual(1);
  });

  test("something leaves the sender and nothing does later", () => {
    const d = departure(40)!;
    expect(d.alpha).toBeGreaterThan(0);
    expect(departure(400)).toBeNull();
    expect(departure(40)!.radius).toBeLessThan(departure(110)!.radius);
  });

  test("an arrival opens where the light lands, and only if it landed", () => {
    expect(arrival(TRAVEL_MS - 50, true)).toEqual([]);
    expect(arrival(TRAVEL_MS + 100, true).length).toBeGreaterThan(0);
    /* Both rings, including the lagging one, are finished before the strand is
       taken down — the arithmetic `FLIGHT_MS` is derived from. */
    expect(arrival(FLIGHT_MS, true)).toEqual([]);
    expect(arrival(FLIGHT_MS - 60, true).length).toBeGreaterThan(0);
  });

  /* A queued message reached nobody. Drawing an arrival for one would be the
     wall claiming a delivery that has not happened — the same honesty
     `Conversation.echo`'s pending mark keeps one surface over. */
  test("a queued message never arrives", () => {
    for (let age = 0; age <= FLIGHT_MS; age += 50) {
      expect(arrival(age, false)).toEqual([]);
    }
  });

  test("nothing is left after the flight", () => {
    expect(done(FLIGHT_MS - 1)).toBe(false);
    expect(done(FLIGHT_MS)).toBe(true);
  });

  /* Reduced motion still says who told whom — the same curve, the same bow,
     held and faded. Drawing nothing would leave a message with no sign on the
     wall that it happened, which is a worse answer than a moving line. */
  test("held still, it still fades in and out", () => {
    expect(stillAlpha(0)).toBe(0);
    expect(stillAlpha(600)).toBe(1);
    expect(stillAlpha(FLIGHT_MS)).toBe(0);
  });
});

describe("the edge of the window", () => {
  test("an endpoint off the pane is pulled in and marked", () => {
    const view = { w: 1000, h: 600 };
    expect(clampInto({ x: 500, y: 300 }, view)).toEqual({
      pt: { x: 500, y: 300 },
      beyond: false,
    });
    const off = clampInto({ x: 4000, y: 300 }, view);
    expect(off.beyond).toBe(true);
    expect(off.pt.x).toBe(988);
  });

  test("a pane nobody has measured yet is not a pane with no room in it", () => {
    const p = { x: 40, y: 40 };
    expect(clampInto(p, { w: 0, h: 0 })).toEqual({ pt: p, beyond: false });
  });
});

describe("colour", () => {
  test("Skein's own wall is dark, so the light is added", () => {
    const p = paletteFor("#7fb8a4", "#151210");
    expect(p.additive).toBe(true);
    expect(luminance(p.core)).toBeGreaterThan(luminance([127, 184, 164]));
  });

  /* Additive white on pale paper is a strand that gets lighter than the wall
     and vanishes at the moment it is brightest. */
  test("a pale theme gets a saturated line instead of a brighter one", () => {
    const p = paletteFor("#7fb8a4", "#f4f1eb");
    expect(p.additive).toBe(false);
    expect(luminance(p.core)).toBeLessThan(luminance([127, 184, 164]));
  });

  test("an unreadable token falls back to celadon rather than to black", () => {
    const p = paletteFor("var(--nope)", "#151210");
    expect(p.core).not.toEqual([0, 0, 0]);
    expect(p.additive).toBe(true);
  });
});

describe("what is in the air", () => {
  test("a strand leaves the list when its flight is over", () => {
    const s = [strand({ id: "old", at: 0 }), strand({ id: "new", at: 900 })];
    expect(retire(s, FLIGHT_MS + 1).map((x) => x.id)).toEqual(["new"]);
  });

  /* A broadcast to a wall of twenty is twenty strands in one tick. The oldest
     go rather than the newest being refused: a cap that dropped the new ones
     would make a big broadcast look like a small one. */
  test("past the cap the oldest are cut short, not the newest refused", () => {
    const many = Array.from({ length: MAX_STRANDS + 4 }, (_, i) =>
      strand({ id: `s${i}`, at: i }),
    );
    const kept = retire(many, MAX_STRANDS + 4);
    expect(kept).toHaveLength(MAX_STRANDS);
    expect(kept[kept.length - 1].id).toBe(`s${MAX_STRANDS + 3}`);
    expect(kept.some((s) => s.id === "s0")).toBe(false);
  });

  test("a second strand to the same card fans off the first, a reply does not", () => {
    const live = [strand({ from: "a", to: "b" })];
    expect(fanFor(live, "a", "b")).toBe(1);
    /* The reply already bows the other way, so it needs no separation. */
    expect(fanFor(live, "b", "a")).toBe(0);
  });
});

describe("the braid", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 400, y: 0 };
  const [c1, c2] = controls(a, b, bowOf(a, b));

  /* Both threads have to *land on the cards*. A braid that kept its width to
     the end would arrive as two lines striking either side of the card it was
     meant to be reaching. */
  test("both threads leave and arrive on the shared route exactly", () => {
    for (let f = 0; f < FILAMENTS.length; f += 1) {
      expect(filamentPoint(a, c1, c2, b, 0, f, 300)).toEqual(a);
      expect(filamentPoint(a, c1, c2, b, 1, f, 300)).toEqual(b);
      expect(weaveAt(0, f, 300)).toBeCloseTo(0, 10);
      expect(weaveAt(1, f, 300)).toBeCloseTo(0, 10);
    }
  });

  test("and are apart in between", () => {
    const p0 = filamentPoint(a, c1, c2, b, 0.3, 0, 0);
    const p1 = filamentPoint(a, c1, c2, b, 0.3, 1, 0);
    expect(Math.hypot(p0.x - p1.x, p0.y - p1.y)).toBeGreaterThan(2);
  });

  /* The whole point of the pair: they are a half turn apart, so wherever one
     is on the left the other is on the right, and every zero between them is a
     crossing rather than a place they touch. */
  test("they are in antiphase, so they genuinely cross", () => {
    let crossings = 0;
    let last = 0;
    for (let t = 0.02; t < 0.99; t += 0.005) {
      const d = weaveAt(t, 0, 0) - weaveAt(t, 1, 0);
      if (last !== 0 && Math.sign(d) !== Math.sign(last)) crossings += 1;
      last = d;
    }
    expect(crossings).toBeGreaterThanOrEqual(2);
  });

  test("the braid turns as the message travels, rather than being a texture", () => {
    const early = weaveAt(0.5, 0, 0);
    const late = weaveAt(0.5, 0, 800);
    expect(early).not.toBeCloseTo(late, 3);
  });

  /* Each thread has its own clock. If they moved as a unit the pair would be
     one thick line with a gap down it. */
  test("one thread leads and the other laps into it", () => {
    const lead = pulseAt(500, 0, 0)!;
    const trail = pulseAt(500, 0, 1)!;
    expect(lead.head).toBeGreaterThan(trail.head);
    /* The slower one smears longer, which is what keeps it reading as the same
       strand rather than as a second, later message. */
    expect(trail.head - trail.tail).toBeGreaterThan(0);
  });

  test("the slower thread still finishes before the strand is taken down", () => {
    for (let f = 0; f < FILAMENTS.length; f += 1) {
      expect(pulseAt(FLIGHT_MS, PULSES - 1, f)).toBeNull();
    }
  });

  test("samples a stretch of one thread, inclusive at both ends", () => {
    const pts = filamentSamples(a, c1, c2, b, 0.2, 0.8, 1, 120, 10);
    expect(pts).toHaveLength(11);
    expect(pts[0]).toEqual(filamentPoint(a, c1, c2, b, 0.2, 1, 120));
  });

  test("the tangent is a unit vector, and never a NaN on a flat curve", () => {
    const t = tangentOn(a, c1, c2, b, 0.5);
    expect(Math.hypot(t.x, t.y)).toBeCloseTo(1, 6);
    expect(tangentOn(a, a, a, a, 0.5)).toEqual({ x: 0, y: 0 });
  });

  /* Two tones, both celadon: the crossings only read as crossings if you can
     tell which thread is in front. */
  test("the two threads take the two tones", () => {
    const p = paletteFor("#7fb8a4", "#151210");
    expect(filamentTone(p, 0)).toEqual(p.core);
    expect(filamentTone(p, 1)).toEqual(p.halo);
    expect(filamentTone(p, 0)).not.toEqual(filamentTone(p, 1));
  });
});

describe("against the wall's own geometry", () => {
  /* A strand is drawn in screen pixels at every zoom, which is what keeps it
     legible at the density where you can actually see the whole wall. */
  test("a card's rim is found at field density as well as open", () => {
    for (const lod of ["field", "wall", "open"] as const) {
      const box = screenBox(
        { x: 0, y: 0, w: CARD_BOX[lod].w, h: CARD_BOX[lod].h },
        { x: 0, y: 0, scale: 0.2 },
      );
      const p = rimPoint(box, { x: 900, y: 20 });
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });
});
