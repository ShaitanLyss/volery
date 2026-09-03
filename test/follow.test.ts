import { expect, test, describe } from "bun:test";
import {
  GESTURE_MS,
  Tail,
  gestureLive,
  hearGrowth,
  slack,
  stillFollowing,
  STICK_PX,
} from "../src/lib/follow";

describe("holding the tail through a scroll event", () => {
  /* A panel writes `scrollTop = scrollHeight` to follow a growing column, and
     that write's scroll event arrives a beat later. Everything here is about what
     the handler is allowed to conclude from an event whose cause it cannot see. */
  const view = (over: Partial<Parameters<typeof stillFollowing>[0]> = {}) => ({
    scrollTop: 9400,
    scrollHeight: 10000,
    clientHeight: 600,
    pinned: -1,
    following: true,
    /* Every case in this block was written about a hand on the wheel, back when
       that was the only kind of scroll event the judgement believed in. The
       block below is the other kind. */
    gestured: true,
    ...over,
  });

  test("parked at the bottom is following", () => {
    expect(stillFollowing(view())).toBe(true);
  });

  test("a line of slack still counts as the bottom", () => {
    /* Mid-stream rounding must not read as a hand on the wheel. */
    expect(stillFollowing(view({ scrollTop: 9400 - STICK_PX }))).toBe(true);
    expect(stillFollowing(view({ scrollTop: 9400 - STICK_PX - 1 }))).toBe(false);
  });

  test("scrolling up lets go of it", () => {
    expect(stillFollowing(view({ scrollTop: 4000 }))).toBe(false);
  });

  /* The bug this exists for. The follow wrote 9400 — the bottom as it was — and
     by the time the event arrived a burst of deltas had made the column 40000
     tall. Asking "are we at the bottom?" answers about the growth, not about the
     reader, and answering it cost the panel the tail for the rest of the turn. */
  test("our own write is not a letting go, even when the bottom has moved", () => {
    expect(
      stillFollowing(view({ scrollTop: 9400, pinned: 9400, scrollHeight: 40000 })),
    ).toBe(true);
  });

  test("a stale pin does not hold the tail against you", () => {
    /* Same pin, but the view is somewhere we never put it — so it is a hand on
       the wheel and the column's own arithmetic decides. */
    expect(
      stillFollowing(view({ scrollTop: 4000, pinned: 9400, scrollHeight: 40000 })),
    ).toBe(false);
  });

  test("a step landing exactly on the tail is read as yours", () => {
    /* `pinned` is cleared by every deliberate gesture, so a keyboard step that
       lands on the very pixel the follow last wrote is still measured, not
       assumed — and being at the bottom, it takes the tail back up. */
    expect(stillFollowing(view({ scrollTop: 9400, pinned: -1 }))).toBe(true);
  });

  test("a column shorter than its panel is always at the bottom", () => {
    expect(stillFollowing(view({ scrollTop: 0, scrollHeight: 300, clientHeight: 600 }))).toBe(true);
  });

  /* ── the scroll event nobody made ──────────────────────────────────────────
     The bug this block exists for, reported as: park a card at the end, look at
     another card, come back once it has spoken, and sometimes the reading is way
     up its own transcript instead of at the bottom.

     `pinned` identifies the follow's own writes and nothing else's, and the
     follow is not the only thing that moves a scroller. The browser clamps
     `scrollTop` when a column gets shorter, and Chromium's scroll anchoring
     adjusts it to hold content above the fold still — both ordinary scroll
     events, both reporting numbers the follow never wrote, both delivered in the
     scroll steps that run *before* animation-frame callbacks and therefore in
     front of the frame the follow queued to re-pin. */
  test("a column that moved on its own does not let go of the tail", () => {
    /* The exact shape of the failure: following, nowhere near the bottom of a
       column that has just grown out from under the view, and no hand anywhere.
       Before the gate this answered `false`, the queued re-pin then declined,
       and the reading stayed 50000px above the tail for the rest of the turn. */
    expect(
      stillFollowing(view({ scrollTop: 9400, scrollHeight: 60000, gestured: false })),
    ).toBe(true);
  });

  test("and it does not take the tail back either, once you have let go", () => {
    /* The asymmetry has to hold in both directions or it is not a gate, it is a
       preference. A reader who scrolled up must not be dragged down by a clamp. */
    expect(
      stillFollowing(
        view({ scrollTop: 9400, scrollHeight: 60000, following: false, gestured: false }),
      ),
    ).toBe(false);
  });

  test("but landing on the tail re-arms with no gesture at all", () => {
    /* Which is what keeps `unfolded`'s promise in the panel: closing a fold while
       parked at the bottom shortens the column, the clamp puts the view back on
       the tail, and the follow takes it up again with nothing touched. Arriving
       at the bottom is a claim about where the view *is*, not about what you
       want, so it needs no hand to vouch for it. */
    expect(stillFollowing(view({ following: false, gestured: false }))).toBe(true);
  });

  test("a hand is what lets go, and only a hand", () => {
    const stranded = { scrollTop: 4000, scrollHeight: 60000 };
    expect(stillFollowing(view({ ...stranded, gestured: true }))).toBe(false);
    expect(stillFollowing(view({ ...stranded, gestured: false }))).toBe(true);
  });

  test("a gesture is spent after GESTURE_MS", () => {
    expect(gestureLive(-1, 0)).toBe(false);
    expect(gestureLive(-1, 1e9)).toBe(false);
    expect(gestureLive(1000, 1000)).toBe(true);
    expect(gestureLive(1000, 1000 + GESTURE_MS)).toBe(true);
    expect(gestureLive(1000, 1000 + GESTURE_MS + 1)).toBe(false);
  });

  test("slack is what is left below the fold", () => {
    expect(slack({ scrollTop: 9400, scrollHeight: 10000, clientHeight: 600 })).toBe(0);
    expect(slack({ scrollTop: 0, scrollHeight: 10000, clientHeight: 600 })).toBe(9400);
    /* Over-scrolled, which a browser will not do but a resize can leave behind. */
    expect(slack({ scrollTop: 0, scrollHeight: 300, clientHeight: 600 })).toBe(-300);
  });
});

describe("one scroller's follow state", () => {
  /* The three numbers a real element would have given it, at the bottom of a
     10000px column in a 600px box. */
  const bottom = { scrollTop: 9400, scrollHeight: 10000, clientHeight: 600 };

  test("a log opens on its tail", () => {
    expect(new Tail().following).toBe(true);
  });

  test("scrolling away stops the follow, scrolling back resumes it", () => {
    const t = new Tail();
    t.gestured();
    t.scrolled({ ...bottom, scrollTop: 2000 });
    expect(t.following).toBe(false);
    /* No control to click: being at the bottom again *is* asking to follow. */
    t.scrolled(bottom);
    expect(t.following).toBe(true);
  });

  /* The whole sequence the panel actually lives through, which neither the
     console nor the servers panel survived. A group prints; the follow writes;
     the group prints ten more lines before the event for that write arrives. */
  test("a burst landing between the write and its event keeps the tail", () => {
    const t = new Tail();
    t.landed(9400);
    t.scrolled({ ...bottom, scrollTop: 9400, scrollHeight: 40000 });
    expect(t.following).toBe(true);
  });

  test("and the pin is spent, so the next event is judged on its own", () => {
    const t = new Tail();
    t.landed(9400);
    /* Ours, reported late — pin held. */
    t.scrolled({ ...bottom, scrollTop: 9400, scrollHeight: 40000 });
    /* Then a hand on the wheel, from a place that is nowhere near the new
       bottom. Without clearing the pin the second event would be read as ours
       too and the reader would be dragged back down. */
    t.gestured();
    t.scrolled({ ...bottom, scrollTop: 20000, scrollHeight: 40000 });
    expect(t.following).toBe(false);
  });

  test("a pin the reader moved off is cleared", () => {
    const t = new Tail();
    t.landed(9400);
    t.gestured();
    t.scrolled({ ...bottom, scrollTop: 2000 });
    expect(t.following).toBe(false);
    /* The pin is gone with it: landing back on 9400 later must be measured
       rather than mistaken for the write we made before you scrolled — and 9400
       is nowhere near the bottom of a 40000px column, so it stays released. */
    t.scrolled({ ...bottom, scrollTop: 9400, scrollHeight: 40000 });
    expect(t.following).toBe(false);
  });

  test("released stays released until something asks for the tail", () => {
    const t = new Tail();
    t.release();
    expect(t.following).toBe(false);
    t.resume();
    expect(t.following).toBe(true);
  });

  test("resuming forgets where the follow last wrote", () => {
    const t = new Tail();
    t.landed(9400);
    t.resume();
    /* A sent command jumps to the tail and re-arms; the stale pin must not then
       vouch for a position the reader could have scrolled to. */
    t.gestured();
    t.scrolled({ ...bottom, scrollTop: 9400, scrollHeight: 40000 });
    expect(t.following).toBe(false);
  });

  /* ── and the gate, from the wiring's side ────────────────────────────────
     `Tail` is what `stickToTail` hands the shell's scrollback and every dev
     server log, so the gate has to hold through the bookkeeping and not only in
     the judgement. The clock is injected because a spent gesture otherwise costs
     the suite a real `GESTURE_MS` of waiting. */
  test("a log whose column moved on its own keeps following", () => {
    const t = new Tail();
    /* No gesture has ever touched this scroller. A build that prints a burst,
       gets its window slid, and has `scrollTop` clamped for it by the browser is
       the console's version of the panel's card switch. */
    t.scrolled({ ...bottom, scrollTop: 2000, scrollHeight: 40000 });
    expect(t.following).toBe(true);
  });

  test("a wheel over the same log lets go of it", () => {
    const t = new Tail();
    t.gestured();
    t.scrolled({ ...bottom, scrollTop: 2000, scrollHeight: 40000 });
    expect(t.following).toBe(false);
  });

  test("a gesture does not vouch for events that arrive long after it", () => {
    let now = 1000;
    const t = new Tail(() => now);
    t.gestured();
    /* You scrolled back to read a stack trace, then sat still for a second while
       the build went on printing. The clamp when its log window slid must not be
       charged to the wheel you turned a second ago. */
    now += GESTURE_MS + 1;
    t.scrolled({ ...bottom, scrollTop: 2000, scrollHeight: 40000 });
    expect(t.following).toBe(true);
  });

  test("resuming spends the gesture that came before it", () => {
    let now = 1000;
    const t = new Tail(() => now);
    /* Scrolled back to read the last command's output, then sent another one —
       which snaps to the tail and re-arms. The snap's own scroll event lands
       inside the window that scroll opened, and if the column grew in between it
       is off the tail with your gesture still vouching for it. */
    t.gestured();
    t.resume();
    now += 10;
    t.scrolled({ ...bottom, scrollTop: 9400, scrollHeight: 40000 });
    expect(t.following).toBe(true);
  });
});

describe("hearing a column change shape", () => {
  /* The observers are wiring rather than judgement, but *what they are asked to
     watch* is the load-bearing part and it is one object literal: the panel spent
     its whole life declaring its own growth instead, and every kind of change it
     forgot to declare was a view stranded above the tail. So the options are
     asserted, with the two observers stubbed — bun has neither. */
  type Watch = { target: unknown; options?: MutationObserverInit };

  function stub(withResize: boolean) {
    const watched: Watch[] = [];
    let disconnects = 0;
    const before = {
      m: globalThis.MutationObserver,
      r: globalThis.ResizeObserver,
    };
    class M {
      constructor(readonly cb: () => void) {}
      observe(target: unknown, options?: MutationObserverInit) {
        watched.push({ target, options });
      }
      disconnect() {
        disconnects++;
      }
    }
    class R {
      constructor(readonly cb: () => void) {}
      observe(target: unknown) {
        watched.push({ target });
      }
      disconnect() {
        disconnects++;
      }
    }
    (globalThis as Record<string, unknown>).MutationObserver = M;
    (globalThis as Record<string, unknown>).ResizeObserver = withResize
      ? R
      : undefined;
    return {
      watched,
      seen: () => disconnects,
      restore: () => {
        (globalThis as Record<string, unknown>).MutationObserver = before.m;
        (globalThis as Record<string, unknown>).ResizeObserver = before.r;
      },
    };
  }

  test("text rewritten in place is heard, not only lines appended", () => {
    const s = stub(true);
    try {
      const el = {} as Element;
      hearGrowth(el, () => {});
      const mutations = s.watched[0];
      expect(mutations.target).toBe(el);
      /* All three, and each for its own case: an appended line is `childList`,
         a streaming answer rewrites the block it is inside (`characterData`,
         `subtree`), and a `!` run writes into a line that already exists. */
      expect(mutations.options).toEqual({
        childList: true,
        subtree: true,
        characterData: true,
      });
      /* And the element itself, for the change nothing in the app announces:
         dragged narrower is a taller column. */
      expect(s.watched[1]?.target).toBe(el);
    } finally {
      s.restore();
    }
  });

  test("both observers are let go of together", () => {
    const s = stub(true);
    try {
      const stop = hearGrowth({} as Element, () => {});
      expect(s.seen()).toBe(0);
      stop();
      expect(s.seen()).toBe(2);
    } finally {
      s.restore();
    }
  });

  test("no ResizeObserver is not a broken follow", () => {
    /* Every consumer is in the app, where it exists — but `stickToTail` guarded
       for its absence and losing that would turn a missing global into a panel
       that never follows anything at all. */
    const s = stub(false);
    try {
      const stop = hearGrowth({} as Element, () => {});
      expect(s.watched.length).toBe(1);
      stop();
      expect(s.seen()).toBe(1);
    } finally {
      s.restore();
    }
  });
});
