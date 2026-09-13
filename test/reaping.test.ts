import { describe, expect, test } from "bun:test";

import {
  AMPLE_BYTES,
  REST_DEFAULT,
  REST_FLOOR_S,
  RESTS,
  TIGHT_BYTES,
  keptFrom,
  quietFor,
  restDetail,
  restFor,
  restMark,
  restNote,
  saidFor,
  toRest,
  waitFor,
  waitOf,
  worthAsking,
  type Around,
  type Restable,
} from "../src/lib/reaping";

const HOUR = 3600;

/** A card nothing is wrong with, four hours quiet and four hours up. Every test
 *  below is this with one thing changed, which is the only way a gate with nine
 *  arms can be read. */
const card = (over: Partial<Restable> = {}): Restable => ({
  dormant: false,
  retiring: false,
  working: false,
  pendingAsk: null,
  busy: false,
  unwoken: null,
  aside: false,
  restingSince: 1,
  idleSeconds: 4 * HOUR,
  awakeSeconds: 4 * HOUR,
  ...over,
});

const FREE: Around = { wake: false, children: false };

describe("the choices", () => {
  test("the default is one of them", () => {
    expect(RESTS.some((r) => r.id === REST_DEFAULT)).toBe(true);
  });

  test("three hours is the default, as chosen with lyss", () => {
    expect(waitOf(REST_DEFAULT)).toBe(3 * HOUR);
  });

  test("a value from somewhere else degrades to the default rather than to off", () => {
    /* The direction matters. A stored value a newer build wrote, or a hand-edit,
       must not be able to leave the wall with no policy — but it also must not
       silently turn the reaper *on* for somebody who had turned it off, which is
       why `never` is a real stored value and not the absence of one. */
    expect(restFor("nonsense")).toBe(REST_DEFAULT);
    expect(restFor(undefined)).toBe(REST_DEFAULT);
    expect(restFor(null)).toBe(REST_DEFAULT);
    expect(restFor("never")).toBe("never");
  });

  test("off is off", () => {
    expect(waitOf("never")).toBe(null);
  });

  test("every label says what it does without a heading over it", () => {
    /* They sit in the ground menu under no heading, beside the motion picks.
       A label reading "3h" would be marked on in a list of four bare numbers. */
    for (const r of RESTS) expect(r.label).toContain("idle cards");
  });
});

describe("waitFor", () => {
  test("plenty of memory leaves the setting alone", () => {
    expect(waitFor(3 * HOUR, AMPLE_BYTES)).toBe(3 * HOUR);
    expect(waitFor(3 * HOUR, AMPLE_BYTES * 4)).toBe(3 * HOUR);
  });

  test("no reading at all shortens nothing", () => {
    /* A survey that failed is ignorance, not pressure. Guessing the other way
       would stand every card on the wall down the first time a command errored. */
    expect(waitFor(3 * HOUR, null)).toBe(3 * HOUR);
  });

  test("a machine with nothing left comes all the way in to the floor", () => {
    expect(waitFor(3 * HOUR, TIGHT_BYTES)).toBe(REST_FLOOR_S);
    expect(waitFor(8 * HOUR, 0)).toBe(REST_FLOOR_S);
  });

  test("the wall as measured — 1.5 GB free — is about twenty minutes", () => {
    /* The case the item was filed about: 15.4 GB physical, 1.5 available, nine
       idle cards holding ~6 GB, and a Nova build needing 2-4 that could not run. */
    const got = waitFor(3 * HOUR, 1.5 * 1024 * 1024 * 1024);
    expect(got).toBeGreaterThan(15 * 60);
    expect(got).toBeLessThan(30 * 60);
  });

  test("it only ever shortens, never lengthens", () => {
    /* The one-sidedness is the whole reason the menu line can be believed: it is
       the longest you will ever wait, whatever the machine is doing. */
    for (const free of [0, TIGHT_BYTES, 2e9, 3e9, AMPLE_BYTES, 9e9, 4e10]) {
      for (const base of [HOUR, 3 * HOUR, 8 * HOUR]) {
        expect(waitFor(base, free)).toBeLessThanOrEqual(base);
      }
    }
  });

  test("it never goes under the floor", () => {
    for (const free of [0, 1, TIGHT_BYTES, 2e9, 3.9e9]) {
      expect(waitFor(8 * HOUR, free)).toBeGreaterThanOrEqual(REST_FLOOR_S);
    }
  });

  test("it moves the right way as memory runs out", () => {
    const a = waitFor(3 * HOUR, 3.5e9);
    const b = waitFor(3 * HOUR, 2e9);
    const c = waitFor(3 * HOUR, 1.2e9);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  test("a baseline under the floor is not lengthened by the floor", () => {
    /* No menu entry is this short, but `waitFor` is arithmetic and must not be
       able to answer "wait longer than you were told to" if one ever is. */
    expect(waitFor(5 * 60, 0)).toBe(5 * 60);
    expect(waitFor(5 * 60, AMPLE_BYTES)).toBe(5 * 60);
  });
});

describe("quietFor — the two clocks", () => {
  test("the shorter of them wins", () => {
    expect(quietFor(card({ idleSeconds: 12 * HOUR, awakeSeconds: 30 }))).toBe(30);
    expect(quietFor(card({ idleSeconds: 30, awakeSeconds: 12 * HOUR }))).toBe(30);
  });

  test("a card stirred after twelve idle hours is not quiet at all", () => {
    /* The bug this exists to prevent, stated as a test. `stir` gives a card back
       its process on the first keystroke and deliberately does not touch the
       neglect clock, so on `idleSeconds` alone the pass would stand the process
       down a second after spawning it, while the sentence was still being typed. */
    const stirred = card({ idleSeconds: 12 * HOUR, awakeSeconds: 2 });
    expect(keptFrom(stirred, FREE, 3 * HOUR)).toBe("recent");
  });

  test("a card that never rested is read by the age of its process", () => {
    /* Spawned by a keystroke and then abandoned mid-sentence: `restingSince` is
       null and `idleSeconds` therefore reads zero, which is not a card anybody is
       using — it is 660 MB nobody has ever said a word to. */
    const never = card({ restingSince: null, idleSeconds: 0, awakeSeconds: 5 * HOUR });
    expect(quietFor(never)).toBe(5 * HOUR);
    expect(keptFrom(never, FREE, 3 * HOUR)).toBe(null);
  });
});

describe("keptFrom — what must not be reaped", () => {
  test("an ordinary long-idle card goes", () => {
    expect(keptFrom(card(), FREE, 3 * HOUR)).toBe(null);
  });

  test("a card mid-turn is left alone", () => {
    expect(keptFrom(card({ working: true }), FREE, 3 * HOUR)).toBe("working");
  });

  test("a card holding a parked question is left alone", () => {
    /* The `tools/call` is being held open by the very process this would kill,
       so the answer would go into a pipe with nothing on the other end. */
    expect(keptFrom(card({ pendingAsk: { id: "q" } }), FREE, 3 * HOUR)).toBe("asking");
  });

  test("a card waiting on background work is left alone", () => {
    /* Lyss named this one first. The notification comes down the stream this
       would close, and `markExited` would report the jobs as orphaned. */
    expect(keptFrom(card({ busy: true }), FREE, 3 * HOUR)).toBe("jobs");
  });

  test("a card whose job landed and never stirred is left alone", () => {
    /* One beat later than the case above and the same fact: the news is sitting
       in the CLI's own queue undelivered, and killing the process throws it away
       with nothing left to say it existed. */
    expect(keptFrom(card({ unwoken: { at: 1, count: 1 } }), FREE, 3 * HOUR)).toBe(
      "unheard",
    );
  });

  test("a card with an armed wake_me is left alone", () => {
    /* The exclusion the filing item thought might not be needed. It is:
       `later::serve_due` delivers through `supervisor::deliver`, which fails for
       a card with no process, and the wake then waits in the inbox until somebody
       next speaks to the card — which is not what "wake me in eight minutes"
       means. See the module note. */
    expect(keptFrom(card(), { wake: true, children: false }, 3 * HOUR)).toBe("wake");
  });

  test("a card with a live child on the wall is left alone", () => {
    /* A parent waiting to be reported to is holding background work one level
       out, and the report is a relay — which queues for a dormant card. */
    expect(keptFrom(card(), { wake: false, children: true }, 3 * HOUR)).toBe(
      "children",
    );
  });

  test("a card set aside is left alone", () => {
    /* Setting a card aside is you saying you are coming back to it. `close`
       refuses one and the rousing queue skips one; this is the third place that
       has to hear the same instruction. */
    expect(keptFrom(card({ aside: true }), FREE, 3 * HOUR)).toBe("aside");
  });

  test("and being set aside outranks being long idle, however long", () => {
    const old = card({ aside: true, idleSeconds: 400 * HOUR, awakeSeconds: 400 * HOUR });
    expect(keptFrom(old, FREE, REST_FLOOR_S)).toBe("aside");
  });

  test("a dormant card has nothing to put down", () => {
    expect(keptFrom(card({ dormant: true }), FREE, 3 * HOUR)).toBe("dormant");
  });

  test("a card already being killed is not killed twice", () => {
    expect(keptFrom(card({ retiring: true }), FREE, 3 * HOUR)).toBe("retiring");
  });

  test("a card quiet for less than the wait stays", () => {
    const fresh = card({ idleSeconds: HOUR, awakeSeconds: HOUR });
    expect(keptFrom(fresh, FREE, 3 * HOUR)).toBe("recent");
  });

  test("exactly the wait is long enough", () => {
    const exact = card({ idleSeconds: 3 * HOUR, awakeSeconds: 3 * HOUR });
    expect(keptFrom(exact, FREE, 3 * HOUR)).toBe(null);
  });
});

describe("worthAsking — the bound that keeps the pass free", () => {
  test("a wall with nothing quiet asks the machine nothing", () => {
    const busyWall = [
      card({ idleSeconds: 60, awakeSeconds: 60 }),
      card({ working: true }),
      card({ dormant: true }),
    ];
    expect(worthAsking(busyWall)).toBe(false);
  });

  test("one card past the floor is enough", () => {
    expect(
      worthAsking([
        card({ idleSeconds: 30, awakeSeconds: 30 }),
        card({ idleSeconds: REST_FLOOR_S, awakeSeconds: REST_FLOOR_S }),
      ]),
    ).toBe(true);
  });

  test("nothing under the floor can be reaped under any pressure, which is why", () => {
    /* The two have to agree or the bound is wrong in the expensive direction:
       a wall that asks nothing while something could still go is a wall whose
       reaper silently does not run. */
    for (const free of [0, 1, TIGHT_BYTES, 2e9, AMPLE_BYTES]) {
      expect(waitFor(8 * HOUR, free)).toBeGreaterThanOrEqual(REST_FLOOR_S);
      expect(waitFor(HOUR, free)).toBeGreaterThanOrEqual(REST_FLOOR_S);
    }
  });

  test("a dormant card past the floor is not a reason to ask", () => {
    /* Every dormant card on a restored wall is "quiet" by years. Asking about
       them would make the survey fire once a minute forever on a wall nobody is
       using, which is the whole thing this bound exists to stop. */
    expect(worthAsking([card({ dormant: true, idleSeconds: 99 * HOUR })])).toBe(false);
  });
});

describe("toRest", () => {
  const named = (id: string, over: Partial<Restable> = {}) => ({
    ...card(over),
    id,
  });

  test("longest quiet first", () => {
    const going = toRest(
      [
        named("middling", { idleSeconds: 5 * HOUR, awakeSeconds: 5 * HOUR }),
        named("oldest", { idleSeconds: 11 * HOUR, awakeSeconds: 11 * HOUR }),
        named("newest", { idleSeconds: 4 * HOUR, awakeSeconds: 4 * HOUR }),
      ],
      () => FREE,
      3 * HOUR,
    );
    expect(going.map((c) => c.id)).toEqual(["oldest", "middling", "newest"]);
  });

  test("the kept are not in it", () => {
    const going = toRest(
      [
        named("busy", { busy: true, idleSeconds: 11 * HOUR, awakeSeconds: 11 * HOUR }),
        named("plain"),
        named("parked", { aside: true }),
      ],
      () => FREE,
      3 * HOUR,
    );
    expect(going.map((c) => c.id)).toEqual(["plain"]);
  });

  test("the surroundings are asked per card", () => {
    const going = toRest(
      [named("timer"), named("plain")],
      (c) => ({ wake: c.id === "timer", children: false }),
      3 * HOUR,
    );
    expect(going.map((c) => c.id)).toEqual(["plain"]);
  });
});

describe("what it says about itself", () => {
  test("a span reads as a span", () => {
    expect(saidFor(0)).toBe("0m");
    expect(saidFor(20 * 60)).toBe("20m");
    expect(saidFor(3 * HOUR)).toBe("3h");
    expect(saidFor(4 * HOUR + 12 * 60)).toBe("4h 12m");
  });

  test("the card's own line says nothing else went", () => {
    /* The whole risk of a card whose transcript ends "its process was stood
       down" is that it reads as a card that broke. */
    const said = restNote(4 * HOUR, 3 * HOUR, 3 * HOUR);
    expect(said).toContain("4h");
    expect(said).toContain("transcript");
    expect(said).toContain("resumes where it left off");
  });

  test("and names the shortened wait when pressure shortened it", () => {
    /* The answer to "a threshold you cannot read off the menu": the menu carries
       the promise and this line carries what actually happened. */
    const said = restNote(40 * 60, 20 * 60, 3 * HOUR);
    expect(said).toContain("short of memory");
    expect(said).toContain("3h");
    expect(said).toContain("20m");
  });

  test("and says nothing about memory when nothing was short", () => {
    expect(restNote(4 * HOUR, 3 * HOUR, 3 * HOUR)).not.toContain("short of memory");
  });

  test("one card is named, several are counted", () => {
    expect(restMark(["nova · gondola"])).toContain("nova · gondola");
    expect(restMark(["a", "b", "c"])).toContain("3 idle cards");
  });

  test("the detail names who, while there is room", () => {
    const said = restDetail(
      [
        { name: "one", quiet: 11 * HOUR },
        { name: "two", quiet: 4 * HOUR },
      ],
      3 * HOUR,
      3 * HOUR,
    );
    expect(said).toContain("one (11h)");
    expect(said).toContain("two (4h)");
  });

  test("and counts the rest beyond four", () => {
    const said = restDetail(
      ["a", "b", "c", "d", "e", "f"].map((name) => ({ name, quiet: 4 * HOUR })),
      3 * HOUR,
      3 * HOUR,
    );
    expect(said).toContain("and 2 more");
    expect(said).not.toContain("f (");
  });
});
