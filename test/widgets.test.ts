import { expect, test, describe } from "bun:test";
import {
  COMMON,
  FRAME,
  PACE,
  VARIANT,
  WIDGETS,
  allows,
  defaultConfig,
  frameOf,
  newWidget,
  normalizeWidget,
  onOf,
  optionFor,
  optionsOf,
  paceIn,
  paramsOf,
  rowsFor,
  specFor,
  variantOf,
  variantsOf,
  offersOf,
  FAMILIES,
} from "../src/lib/widgets";
import {
  arcPath,
  dateLine,
  digital,
  handAngles,
  isMad,
  LURCH_MS,
  MAD_RATE,
  madAt,
  onFace,
  paceOf,
  partOfDay,
  reading,
  ticks,
  turns,
  words,
} from "../src/lib/clock";
import {
  bytes,
  fold,
  leftover,
  pct,
  share,
  top,
  type Proc,
  type Sample,
} from "../src/lib/perf";

/* ── the catalogue ─────────────────────────────────────────────────────── */

describe("a widget describes itself well enough to be offered blind", () => {
  /* The menu builds itself off the catalogue and the store holds the config
     without understanding it, so a spec that lies about its own defaults is a
     widget that comes back off disk as something undrawable. */
  test("every parameter's default is a value that parameter accepts", () => {
    for (const w of WIDGETS) {
      for (const p of paramsOf(w)) {
        if (p.kind === "choice") {
          expect(p.options.map((o) => o.value)).toContain(p.def);
          /* A choice offering one thing is a menu entry that does nothing —
             except where the rest of its options are resolved at menu time from
             a `from` source, in which case one literal option is the design and
             not a spec that forgot the others. The default still has to be in
             the literal list, which is the half that matters here: it is what a
             widget comes back as when nothing resolves. */
          if (!p.from) expect(p.options.length).toBeGreaterThan(1);
        } else if (p.kind === "number") {
          expect(p.min).toBeLessThan(p.max);
          expect(p.def).toBeGreaterThanOrEqual(p.min);
          expect(p.def).toBeLessThanOrEqual(p.max);
          expect(p.step).toBeGreaterThan(0);
        }
      }
    }
  });

  /* Asked of the joined list, not of `spec.params`: a spec that defined a knob
     of its own called `frame` would shadow the shared one, and the menu would
     offer the same key twice with different wording. */
  test("no widget lists the same knob twice", () => {
    for (const w of WIDGETS) {
      const keys = paramsOf(w).map((p) => p.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  /* The variant is the one knob the right-click menu offers directly, and the
     component switches on it. A widget whose first parameter is something else
     would appear on the wall with no way to change what it is. */
  test("every widget's first parameter is its variant", () => {
    for (const w of WIDGETS) {
      expect(w.params[0]?.key).toBe(VARIANT);
      expect(variantsOf(w.kind).length).toBeGreaterThan(1);
    }
  });

  test("a widget arrives no smaller than it is allowed to be dragged", () => {
    for (const w of WIDGETS) {
      expect(w.box.w).toBeGreaterThanOrEqual(w.min.w);
      expect(w.box.h).toBeGreaterThanOrEqual(w.min.h);
    }
  });

  test("the clock offers the faces it is meant to", () => {
    const faces = variantsOf("clock").map((v) => v.value);
    expect(faces).toEqual(["analog", "digital", "words", "artistic", "abstract"]);
  });

  /* A parameter with no way to reach it is a parameter that does not exist, so
     every knob in the catalogue has to turn up in the menu the widget offers —
     unless it is guarded, in which case it turns up once its guard is
     satisfied. `test/timing.test.ts` covers that half, since the only guarded
     knob today is the countdown's length. */
  test("every knob a widget has is reachable by hand", () => {
    /* Sourced knobs are reachable only once their source resolves — that is
       the third case beside "guarded", and the invariant is still that a knob
       with no way to reach it does not exist. So the source is supplied here
       rather than the knob being excused: what is being asserted is that it
       *does* appear once there is something to choose between. */
    const SOURCES = {
      accounts: [
        { value: "a", label: "a" },
        { value: "b", label: "b" },
      ],
      groups: [
        { value: "g1", label: "skein · dev" },
        { value: "g2", label: "nova · api" },
      ],
      projects: [
        { value: "C:\\atelier\\skein", label: "skein" },
        { value: "C:\\dev\\Caravan", label: "Caravan" },
      ],
      editors: [
        { value: "C:\\dev\\Caravan", label: "Caravan" },
        { value: "C:\\dev\\Other", label: "Other" },
      ],
      boards: [
        { value: "1201", label: "Nova" },
        { value: "1202", label: "RISE" },
      ],
      /* The shared browser's open pages. Two, because the invariant below is
         that every knob is reachable and a sourced knob resolving to nothing is
         deliberately dropped from the menu — one page is not a choice. */
      pages: [
        { value: "AB12", label: "[Local] NOVA" },
        { value: "CD34", label: "localhost:8081" },
      ],
    };
    for (const spec of WIDGETS) {
      const w = newWidget(spec.kind, 0, 0);
      const ids = optionsOf(w, SOURCES).map((o) => o.id);
      for (const p of paramsOf(spec)) {
        if (p.key === VARIANT) continue;
        if (!allows(w, p)) continue;
        expect(ids.some((id) => id.startsWith(`cfg:${p.key}`))).toBe(true);
      }
      /* Exactly one of a choice's values is marked, and a toggle's mark says
         what it is now rather than what clicking would make it. */
      const scope = optionsOf(w, SOURCES).filter((o) => o.id.startsWith("cfg:scope:"));
      if (scope.length) expect(scope.filter((o) => o.on)).toHaveLength(1);
    }
  });

  test("a toggle flips and a choice is set", () => {
    const w = newWidget("clock", 0, 0);
    expect(onOf(w, "seconds")).toBe(true);
    expect(optionFor(w, "cfg:seconds")).toEqual({ key: "seconds", value: false });

    const perf = newWidget("performance", 0, 0);
    expect(optionFor(perf, "cfg:scope:machine")).toEqual({
      key: "scope",
      value: "machine",
    });
    expect(optionFor(perf, "front")).toBeNull();
  });

  /* ── the frame every widget wears ──────────────────────────────────────
   *
   * `COMMON` is joined on by `paramsOf` rather than written into each spec, so
   * what these guard is that the join actually happens everywhere it has to:
   * a knob offered but not persisted, or persisted but not offered, is the
   * failure this shape exists to prevent. */

  test("every kind of widget can be told what frame to wear", () => {
    for (const spec of WIDGETS) {
      const w = newWidget(spec.kind, 0, 0);
      const items = optionsOf(w).filter((o) => o.id.startsWith(`cfg:${FRAME}:`));
      expect(items).toHaveLength(3);
      /* Exactly one lit, and it is the one the config holds. */
      expect(items.filter((o) => o.on).map((o) => o.id)).toEqual([
        `cfg:${FRAME}:framed`,
      ]);
      expect(optionFor(w, `cfg:${FRAME}:bare`)).toEqual({
        key: FRAME,
        value: "bare",
      });
    }
  });

  /* The default is the wall as it was before the knob existed. Anything else
     and adding this would have quietly restyled every widget already hung up. */
  test("a widget arrives framed, whatever it is", () => {
    for (const spec of WIDGETS) {
      expect(frameOf(newWidget(spec.kind, 0, 0))).toBe("framed");
      expect(defaultConfig(spec.kind)[FRAME]).toBe("framed");
    }
  });

  /* The three values are an ordered retreat, and the order is the argument: an
     outline with the wall showing through it is a hole cut in the wall rather
     than an instrument, so that fourth state is not reachable — which is only
     true while this is one choice and not two toggles. */
  test("the frame is one knob with three values, not two toggles", () => {
    const frame = COMMON.find((p) => p.key === FRAME);
    expect(frame?.kind).toBe("choice");
    expect(frame?.kind === "choice" && frame.options.map((o) => o.value)).toEqual([
      "framed",
      "plate",
      "bare",
    ]);
  });

  /* The box you drag it to is the setting: a number in a menu that disagreed
     with the height would be the widget arguing with itself. */
  test("a meter shows what its own height has room for", () => {
    expect(rowsFor(210)).toBeGreaterThan(rowsFor(120));
    expect(rowsFor(96)).toBeGreaterThanOrEqual(1);
    /* Never zero, however small it is dragged — an empty instrument. */
    expect(rowsFor(0)).toBe(1);
  });
});

/* ── coming back off disk ──────────────────────────────────────────────── */

describe("a widget read back is always drawable", () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    id: "w1",
    kind: "clock",
    x: 10,
    y: 20,
    w: 200,
    h: 200,
    z: 5,
    config: { variant: "digital", seconds: false, h24: true, date: false },
    ...over,
  });

  test("a whole config survives the round trip", () => {
    const w = normalizeWidget(stored())!;
    expect(w.kind).toBe("clock");
    expect(variantOf(w)).toBe("digital");
    expect(onOf(w, "seconds", true)).toBe(false);
    expect(w.z).toBe(5);
  });

  /* The whole point of the opaque column: the widget outlives the vocabulary it
     was written against. A retired variant must not leave a blank plate on the
     wall with no menu entry lit. */
  test("a variant this build has never heard of falls back to the default", () => {
    const w = normalizeWidget(stored({ config: { variant: "lava-lamp" } }))!;
    expect(variantOf(w)).toBe("analog");
  });

  test("a config missing knobs is filled in rather than left with holes", () => {
    const w = normalizeWidget(stored({ config: {} }))!;
    expect(Object.keys(w.config).sort()).toEqual(
      paramsOf(specFor("clock")!)
        .map((p) => p.key)
        .sort(),
    );
  });

  /* Every widget on the wall predates this knob, so the read back off disk is
     the only thing standing between "an optional frame" and "every instrument
     you had has quietly lost its edges". */
  test("a widget stored before the frame existed comes back framed", () => {
    const w = normalizeWidget(stored({ config: { variant: "digital" } }))!;
    expect(frameOf(w)).toBe("framed");
  });

  test("a frame this build cannot draw falls back rather than blanking", () => {
    const w = normalizeWidget(stored({ config: { frame: "hovering" } }))!;
    expect(frameOf(w)).toBe("framed");
  });

  test("a frame that was chosen survives the round trip", () => {
    for (const value of ["plate", "bare"]) {
      const w = normalizeWidget(stored({ config: { frame: value } }))!;
      expect(frameOf(w)).toBe(value);
    }
  });

  /* `frameOf` is what the node's `data-frame` is built from, so it has to answer
     for a widget nothing has normalized — a config from a hand-built object, or
     one whose key is the wrong type, must still name a frame the CSS has a rule
     for rather than leave the attribute empty. */
  test("frameOf always names a frame the wall can draw", () => {
    expect(frameOf({ ...newWidget("clock", 0, 0), config: {} })).toBe("framed");
    expect(frameOf({ ...newWidget("clock", 0, 0), config: { frame: 3 } })).toBe(
      "framed",
    );
  });

  test("a knob that no longer exists is dropped rather than carried", () => {
    /* `rows` was a parameter until the widget's own height answered it better.
       A config still carrying one must not put it back on the widget. */
    const w = normalizeWidget({
      id: "w2",
      kind: "performance",
      x: 0,
      y: 0,
      w: 300,
      h: 200,
      z: 0,
      config: { rows: 900, scope: "machine" },
    })!;
    expect(w.config.rows).toBeUndefined();
    expect(w.config.scope).toBe("machine");
  });

  test("a knob of the wrong type is the default, not a NaN on the wall", () => {
    const w = normalizeWidget(
      stored({ config: { seconds: "yes", variant: 3 } }),
    )!;
    expect(onOf(w, "seconds")).toBe(true);
    expect(variantOf(w)).toBe("analog");
  });

  /* A kind from a newer build is left off rather than guessed at: drawing it as
     a clock would be worse than an empty patch of wall. */
  test("a kind nothing can draw is left off the wall", () => {
    expect(normalizeWidget(stored({ kind: "lava-lamp" }))).toBeNull();
    expect(normalizeWidget(null)).toBeNull();
    expect(normalizeWidget("clock")).toBeNull();
  });

  test("a size below the floor is raised to it", () => {
    const w = normalizeWidget(stored({ w: 4, h: 4 }))!;
    expect(w.w).toBe(specFor("clock")!.min.w);
    expect(w.h).toBe(specFor("clock")!.min.h);
  });

  /* You aimed at a spot on the wall, not at a corner. */
  test("a new widget lands centred on where it was asked for", () => {
    const w = newWidget("clock", 500, 300);
    expect(w.x + w.w / 2).toBe(500);
    expect(w.y + w.h / 2).toBe(300);
    expect(w.config).toEqual(defaultConfig("clock"));
  });
});

/* ── the clock ─────────────────────────────────────────────────────────── */

/** Built through the local Date so the tests say nothing about the machine's
 *  zone — the same way the clock itself reads it. */
const at = (h: number, m: number, s = 0, ms = 0) =>
  new Date(2026, 7, 13, h, m, s, ms).getTime();

describe("the hands point where they should", () => {
  test("noon is straight up on every hand", () => {
    const a = handAngles(reading(at(12, 0, 0)));
    expect(a.hour % 360).toBe(0);
    expect(a.minute).toBe(0);
    expect(a.second).toBe(0);
  });

  test("quarter past three", () => {
    const a = handAngles(reading(at(15, 15)));
    expect(a.minute).toBe(90);
    /* The hour hand is a quarter of the way from three to four, which is the
       whole reason it is not `hour * 30`. */
    expect(a.hour).toBeCloseTo(97.5, 5);
  });

  test("the minute hand carries its seconds", () => {
    const a = handAngles(reading(at(1, 30, 30)));
    expect(a.minute).toBeCloseTo(183, 5);
  });

  /* Without a sweep every hand lands on a whole second, which is what a
     once-a-second tick can actually keep up with. */
  test("milliseconds move nothing unless a sweep is asked for", () => {
    const still = handAngles(reading(at(1, 0, 10, 500)));
    const swept = handAngles(reading(at(1, 0, 10, 500)), true);
    expect(still.second).toBe(60);
    expect(swept.second).toBeCloseTo(63, 5);
  });

  test("the rings run 0 to 1 over their own period", () => {
    const t = turns(reading(at(18, 45, 30)));
    expect(t.hour).toBeCloseTo(0.5632, 3);
    expect(t.minute).toBeCloseTo(0.7583, 3);
    expect(t.second).toBe(0.5);
  });

  test("twelve o'clock is up and three o'clock is right", () => {
    const up = onFace(100, 100, 50, 0);
    expect(up.x).toBeCloseTo(100, 6);
    expect(up.y).toBeCloseTo(50, 6);
    const right = onFace(100, 100, 50, 90);
    expect(right.x).toBeCloseTo(150, 6);
    expect(right.y).toBeCloseTo(100, 6);
  });

  test("a face has the marks it was asked for, and the long ones are quarters", () => {
    const m = ticks(100, 100, 90, 12, 10);
    expect(m.length).toBe(12);
    expect(m.filter((t) => t.major).length).toBe(4);
  });

  /* A full turn drawn as one arc has coincident ends and renders as nothing —
     a ring that vanishes for one second in sixty. */
  test("a complete arc still draws", () => {
    expect(arcPath(100, 100, 50, 360)).toContain("A");
    expect(arcPath(100, 100, 50, 360)).not.toBe(arcPath(100, 100, 50, 0));
    expect(arcPath(100, 100, 50, 200)).toContain(" 1 1 ");
    expect(arcPath(100, 100, 50, 90)).toContain(" 0 1 ");
  });
});

describe("the digital face", () => {
  test("24-hour pads the hour and 12-hour does not", () => {
    expect(digital(reading(at(9, 4, 7)), { h24: true }).time).toBe("09:04");
    expect(digital(reading(at(9, 4, 7)), { h24: false }).time).toBe("9:04");
  });

  test("noon and midnight read as twelve, not as zero", () => {
    expect(digital(reading(at(0, 5)), { h24: false }).time).toBe("12:05");
    expect(digital(reading(at(12, 5)), { h24: false }).time).toBe("12:05");
  });

  test("the half of the day is only said when the hour does not say it", () => {
    expect(digital(reading(at(15, 0)), { h24: false }).suffix).toBe("pm");
    expect(digital(reading(at(15, 0)), { h24: true }).suffix).toBe("");
  });

  test("seconds are a separate field, so they can be sized down or dropped", () => {
    expect(digital(reading(at(1, 2, 3)), { seconds: true }).seconds).toBe("03");
    expect(digital(reading(at(1, 2, 3)), { seconds: false }).seconds).toBe("");
  });
});

describe("the worded face says what a person would say", () => {
  const said = (h: number, m: number) => words(reading(at(h, m))).time;

  test("the named minutes use their names", () => {
    expect(said(3, 15)).toBe("quarter past three");
    expect(said(3, 30)).toBe("half past three");
    expect(said(3, 45)).toBe("quarter to four");
  });

  test("past the half hour it names the hour it is heading for", () => {
    expect(said(3, 40)).toBe("twenty to four");
    expect(said(3, 20)).toBe("twenty past three");
  });

  /* Rounding to the nearest five would make this "half past three", and a
     clock you have to check against another clock is not a clock. */
  test("every minute has a word of its own", () => {
    expect(said(3, 32)).toBe("twenty-eight to four");
    expect(said(15, 7)).toBe("seven past three");
  });

  test("noon and midnight are themselves, but only on the hour", () => {
    expect(said(0, 0)).toBe("midnight");
    expect(said(12, 0)).toBe("noon");
    expect(said(0, 1)).toBe("one past twelve");
  });

  test("the hour rolls over the top of the day rather than off it", () => {
    expect(said(23, 50)).toBe("ten to twelve");
    expect(said(11, 50)).toBe("ten to twelve");
  });

  test("the part of the day is carried alongside", () => {
    expect(partOfDay(2)).toBe("night");
    expect(partOfDay(9)).toBe("morning");
    expect(partOfDay(15)).toBe("afternoon");
    expect(partOfDay(20)).toBe("evening");
    expect(partOfDay(23)).toBe("night");
  });

  test("the date is in the wall's own lowercase voice", () => {
    expect(dateLine(at(9, 0))).toBe("thu 13 aug");
  });
});

/* ── a clock that is not telling the time ──────────────────────────────────
 *
 * The whole of the madness is one function from the real epoch to a made-up
 * one, which is what lets all five faces have it without knowing. So these are
 * about that function only: that it lies, that it lies *smoothly* where it
 * claims to and jumps where it claims to, and that the same instant asked twice
 * answers the same — a re-render must not be a reshuffle. */

describe("a mad clock", () => {
  const t0 = at(9, 0);

  test("an honest clock is the identity, whatever it is handed", () => {
    expect(madAt("real", t0, t0 - 5000)).toBe(t0);
    expect(madAt("real", 0, 99)).toBe(0);
  });

  test("a pace nothing knows reads as the truth", () => {
    expect(paceOf("racing")).toBe("racing");
    expect(paceOf("sideways")).toBe("real");
    expect(paceOf("")).toBe("real");
    expect(isMad(paceOf("deranged"))).toBe(true);
    expect(isMad(paceOf("real"))).toBe(false);
  });

  test("racing and unwinding are the same distance in either direction", () => {
    const fwd = madAt("racing", t0 + 1000, t0);
    const back = madAt("unwinding", t0 + 1000, t0);
    expect(fwd - t0).toBe(MAD_RATE * 1000);
    expect(t0 - back).toBe(MAD_RATE * 1000);
  });

  test("it starts where it went mad rather than jumping on the first frame", () => {
    expect(madAt("racing", t0, t0)).toBe(t0);
    expect(madAt("unwinding", t0, t0)).toBe(t0);
  });

  /* The frame that notices the knob has moved may still be holding the
     timestamp from before it, and a negative elapsed would send a racing clock
     backwards for one frame. */
  test("a timestamp from before the bout does not run it in reverse", () => {
    expect(madAt("racing", t0 - 4000, t0)).toBe(t0);
    expect(madAt("deranged", t0 - 4000, t0)).toBe(madAt("deranged", t0, t0));
  });

  test("racing glides — every frame of a bout is a step in one direction", () => {
    let last = madAt("racing", t0, t0);
    for (let ms = 16; ms < 4000; ms += 16) {
      const next = madAt("racing", t0 + ms, t0);
      expect(next).toBeGreaterThan(last);
      last = next;
    }
  });

  test("the same instant twice is the same time — a redraw is not a reshuffle", () => {
    for (const ms of [0, 40, 2599, 2600, 9000]) {
      for (const pace of ["racing", "unwinding", "deranged"] as const) {
        expect(madAt(pace, t0 + ms, t0)).toBe(madAt(pace, t0 + ms, t0));
      }
    }
  });

  /* Discontinuous on purpose: a clock off its hinges lurches, and a smooth
     random walk reads as a clock that is merely wrong. Each bout lands
     somewhere of its own, so consecutive bouts must not agree. */
  test("deranged lands somewhere else every bout", () => {
    const lands = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
      madAt("deranged", t0 + i * LURCH_MS, t0),
    );
    expect(new Set(lands).size).toBe(lands.length);
    /* And within one bout it runs, rather than sitting on the number it
       landed on. */
    expect(madAt("deranged", t0 + 1300, t0)).not.toBe(madAt("deranged", t0, t0));
  });

  test("deranged goes both ways over enough bouts", () => {
    const dirs = new Set<boolean>();
    for (let i = 0; i < 64; i += 1) {
      const from = t0 + i * LURCH_MS;
      dirs.add(madAt("deranged", from + 400, t0) > madAt("deranged", from, t0));
    }
    expect(dirs.size).toBe(2);
  });

  /* Every face reads the epoch through `reading`, so a made-up instant has to
     be one a `Date` can hold — hours a face can point at, and a date line that
     is a date. Hours after a real day of racing is the loosest bound that
     still catches an overflow. */
  test("what it invents is still a time", () => {
    for (const pace of ["racing", "unwinding", "deranged"] as const) {
      for (const ms of [0, 5000, 3600_000, 86_400_000]) {
        const r = reading(madAt(pace, t0 + ms, t0));
        expect(r.h).toBeGreaterThanOrEqual(0);
        expect(r.h).toBeLessThan(24);
        expect(Number.isNaN(r.m)).toBe(false);
        expect(dateLine(madAt(pace, t0 + ms, t0))).toMatch(/^[a-z]{3} \d{1,2} [a-z]{3}$/);
      }
    }
  });

  /* A knob with no way to reach it is a knob that does not exist, and this one
     has to be reachable on a clock and offered on nothing else — the meter and
     the logs have no time to be mad about. */
  test("the pace is a clock's knob and a clock's alone", () => {
    const w = newWidget("clock", 0, 0);
    expect(paceIn(w)).toBe("real");
    const items = optionsOf(w).filter((o) => o.id.startsWith(`cfg:${PACE}:`));
    expect(items).toHaveLength(4);
    expect(items.filter((o) => o.on).map((o) => o.id)).toEqual([`cfg:${PACE}:real`]);
    expect(optionFor(w, `cfg:${PACE}:deranged`)).toEqual({
      key: PACE,
      value: "deranged",
    });

    for (const spec of WIDGETS) {
      if (spec.kind === "clock") continue;
      expect(paramsOf(spec).map((p) => p.key)).not.toContain(PACE);
    }
  });

  test("a pace that came off disk unreadable is a clock telling the time", () => {
    expect(paceIn({ ...newWidget("clock", 0, 0), config: {} })).toBe("real");
    expect(paceIn({ ...newWidget("clock", 0, 0), config: { pace: 7 } })).toBe("real");
    const w = normalizeWidget({
      id: "w1",
      kind: "clock",
      x: 0,
      y: 0,
      w: 190,
      h: 190,
      z: 0,
      config: { pace: "sideways" },
    });
    expect(w?.config[PACE]).toBe("real");
  });
});

/* ── the performance meter ─────────────────────────────────────────────── */

const proc = (over: Partial<Proc> = {}): Proc => ({
  pid: 1,
  ppid: null,
  name: "thing.exe",
  cpu: 0,
  mem: 0,
  role: "other",
  reference: null,
  own: true,
  ...over,
});

const sample = (procs: Proc[], over: Partial<Sample> = {}): Sample => ({
  at: 0,
  scope: "machine",
  cores: 4,
  cpu: 20,
  mem_used: 8e9,
  mem_total: 32e9,
  counted: procs.length,
  other_cpu: 0,
  other_mem: 0,
  procs,
  ...over,
});

describe("a sample folds into things rather than processes", () => {
  /* The truth about a dev server is spread across five node processes, and a
     flat list of them never adds up to an answer — which is exactly what a
     meter inside Skein is for. */
  test("a whole process tree is one line", () => {
    const rows = fold(
      sample([
        proc({ pid: 1, role: "server", reference: "g1", cpu: 10, mem: 100, own: true }),
        proc({ pid: 2, role: "server", reference: "g1", cpu: 5, mem: 50, own: false }),
        proc({ pid: 3, role: "server", reference: "g1", cpu: 1, mem: 10, own: false }),
      ]),
      () => "web dev",
    );
    expect(rows.length).toBe(1);
    expect(rows[0].label).toBe("web dev");
    expect(rows[0].cpu).toBe(16);
    expect(rows[0].count).toBe(3);
  });

  test("two conversations stay two lines", () => {
    const rows = fold(
      sample([
        proc({ pid: 1, role: "conversation", reference: "a", cpu: 3 }),
        proc({ pid: 2, role: "conversation", reference: "b", cpu: 9 }),
      ]),
      (_r, ref) => `card ${ref}`,
    );
    expect(rows.map((r) => r.label)).toEqual(["card b", "card a"]);
  });

  /* A meter that says "conversation 5f3c…" has done nothing a task manager
     could not; the naming is the entire reason it lives on this wall. */
  test("a role with no name falls back to what kind of thing it is", () => {
    const rows = fold(
      sample([proc({ role: "conversation", reference: "gone" })]),
      () => null,
    );
    expect(rows[0].label).toBe("conversation");
  });

  test("strangers fold by executable, the way a browser's windows do", () => {
    const rows = fold(
      sample([
        proc({ pid: 1, name: "msedgewebview2.exe", cpu: 2 }),
        proc({ pid: 2, name: "msedgewebview2.exe", cpu: 3 }),
        proc({ pid: 3, name: "explorer.exe", cpu: 1 }),
      ]),
    );
    expect(rows.length).toBe(2);
    expect(rows[0].label).toBe("msedgewebview2.exe");
    expect(rows[0].count).toBe(2);
  });

  /* One sample serves every widget on the wall, so the studio-scoped ones read
     the same rows and ignore what they did not ask about. */
  test("the studio's scope drops what the studio did not spawn", () => {
    const s = sample([
      proc({ pid: 1, role: "conversation", reference: "a", cpu: 5 }),
      proc({ pid: 2, name: "chrome.exe", cpu: 90 }),
    ]);
    expect(fold(s, () => "card", "skein").length).toBe(1);
    expect(fold(s, () => "card", "machine").length).toBe(2);
  });

  test("costliest first, and by cpu before memory", () => {
    const rows = fold(
      sample([
        proc({ pid: 1, name: "a.exe", cpu: 1, mem: 9e9 }),
        proc({ pid: 2, name: "b.exe", cpu: 40, mem: 1e6 }),
      ]),
    );
    expect(rows.map((r) => r.label)).toEqual(["b.exe", "a.exe"]);
  });
});

describe("what a widget has room for", () => {
  const rows = (n: number) =>
    fold(
      sample(
        Array.from({ length: n }, (_, i) =>
          proc({ pid: i, name: `p${i}.exe`, cpu: n - i, mem: 1e6 }),
        ),
      ),
    );

  test("everything below the cut becomes one honest line", () => {
    const cut = top(rows(10), 3);
    expect(cut.shown.length).toBe(3);
    expect(cut.rest?.count).toBe(7);
    expect(cut.rest?.cpu).toBe(7 + 6 + 5 + 4 + 3 + 2 + 1);
  });

  test("nothing left over means no line about it", () => {
    expect(top(rows(3), 7).rest).toBeNull();
  });

  /* A meter whose lines sum to less than the total printed beside them is a
     meter nobody trusts twice, so the sampler's own cap is carried too. */
  test("the sampler's leftovers are carried into the tail", () => {
    const s = sample([proc({ name: "a.exe", cpu: 1 })], {
      counted: 300,
      other_cpu: 55,
      other_mem: 4e9,
    });
    const cut = top(fold(s), 5, leftover(s, "machine"));
    expect(cut.rest?.cpu).toBe(55);
    expect(cut.rest?.count).toBe(299);
  });

  /* One sample serves both scopes, so a studio-scoped widget must not inherit
     a machine-scoped sample's leftovers — those are a hundred strangers. */
  test("leftovers from a wider sample belong to nobody narrower", () => {
    const s = sample([proc({ role: "conversation", reference: "a" })], {
      scope: "machine",
      counted: 300,
      other_cpu: 55,
    });
    expect(leftover(s, "skein")).toEqual({ cpu: 0, mem: 0, count: 0 });
    expect(leftover(s, "machine").cpu).toBe(55);
  });
});

describe("readings a person can take in at a glance", () => {
  test("a share is of the whole machine, not of one core", () => {
    /* 400% of one core on a four-core machine is the whole machine. */
    expect(share(400, 4)).toBe(1);
    expect(share(100, 4)).toBe(0.25);
    expect(share(-5, 4)).toBe(0);
    expect(pct(400, 4)).toBe("100%");
    expect(pct(6, 4)).toBe("1.5%");
  });

  test("bytes are said at the precision anybody would say them", () => {
    expect(bytes(0)).toBe("0 MB");
    expect(bytes(1.4 * 1024 ** 3)).toBe("1.4 GB");
    expect(bytes(512 * 1024 ** 2)).toBe("512 MB");
    expect(bytes(2048)).toBe("2 KB");
    /* Never a trailing zero: "53.0 MB" is a digit of noise on a number that
       changes every sample. */
    expect(bytes(53 * 1024 ** 2)).toBe("53 MB");
    expect(bytes(22.5 * 1024 ** 3)).toBe("22.5 GB");
    expect(bytes(862.8 * 1024 ** 2)).toBe("863 MB");
  });

  /* A row printing 0.2% under a header printing 0% is a meter arguing with
     itself, so both go through the same function. */
  test("a total is said the same way as the rows that make it up", () => {
    expect(pct(0.8, 4)).toBe("0.2%");
    expect(pct(0, 4)).toBe("0%");
  });
});

describe("a knob whose options this file cannot know", () => {
  /* The accounts a wall spends are whatever was registered, so the catalogue
     names a source instead of listing them. See `Source` in widgets.ts. */

  const ACCOUNTS = [
    { value: "work", label: "work" },
    { value: "perso", label: "perso" },
  ];

  function usage() {
    const w = newWidget("usage", 0, 0);
    w.config.measure = "allowance";
    return w;
  }

  /* A knob whose source resolves to nothing is not offered at all: its literal
     options alone are one entry, and a choice offering one thing is the
     knob-that-does-nothing this catalogue refuses everywhere else. It is also
     what makes "one account is not a choice" fall out of the menu for free. */
  test("with nothing resolved the knob is not offered", () => {
    const ids = optionsOf(usage())
      .filter((o) => o.id.startsWith("cfg:account:"))
      .map((o) => o.id);
    expect(ids).toEqual([]);
  });

  /* The one-account gate lives upstream, in what the caller resolves the source
     to — `widgetSources` hands over nothing until there is a genuine choice.
     This layer only knows that an empty source means no knob, which keeps the
     rule about *how many accounts count as a choice* in one place
     (`accounts.ts::several`) rather than split across two. */
  test("a source that resolved to one is still drawn — the gate is upstream", () => {
    const ids = optionsOf(usage(), { accounts: [{ value: "work", label: "work" }] })
      .filter((o) => o.id.startsWith("cfg:account:"))
      .map((o) => o.id);
    expect(ids).toEqual(["cfg:account:all", "cfg:account:signed-in", "cfg:account:work"]);
  });

  /* Both literal options come first and in order: "every account", then the
     signed-in session — which is not one of the accounts in the order and is
     the reading that exists whether any are registered or not. */
  test("the resolved options are appended, not substituted", () => {
    const ids = optionsOf(usage(), { accounts: ACCOUNTS })
      .filter((o) => o.id.startsWith("cfg:account:"))
      .map((o) => o.id);
    expect(ids).toEqual([
      "cfg:account:all",
      "cfg:account:signed-in",
      "cfg:account:work",
      "cfg:account:perso",
    ]);
  });

  test("exactly one is marked, and it is the one in force", () => {
    const w = usage();
    w.config.account = "perso";
    const on = optionsOf(w, { accounts: ACCOUNTS }).filter(
      (o) => o.id.startsWith("cfg:account:") && o.on,
    );
    expect(on).toHaveLength(1);
    expect(on[0]!.id).toBe("cfg:account:perso");
  });

  /* The knob is guarded to the allowance, because a transcript does not record
     which subscription paid for a turn — so on cost or tokens it would be a
     filter that could not filter. */
  test("it is not offered on a reading it could not scope", () => {
    const w = newWidget("usage", 0, 0);
    w.config.measure = "cost";
    const ids = optionsOf(w, { accounts: ACCOUNTS }).map((o) => o.id);
    expect(ids.some((id) => id.startsWith("cfg:account:"))).toBe(false);
  });

  /* The load-bearing one. An account registered after the widget was placed is
     not in the literal list, and clamping to it would read the value back as
     "every account" on the next launch — silently, with the face still claiming
     to show that account. */
  test("a value the catalogue has never heard of survives a round trip", () => {
    const w = usage();
    w.config.account = "some-account-added-later";
    const back = normalizeWidget(JSON.parse(JSON.stringify(w)))!;
    expect(back.config.account).toBe("some-account-added-later");
  });

  test("but a knob with no source is still clamped to its own options", () => {
    const w = usage();
    w.config.measure = "not-a-measure";
    const back = normalizeWidget(JSON.parse(JSON.stringify(w)))!;
    expect(back.config.measure).toBe("allowance");
  });

  test("a non-string is still the default", () => {
    const w = usage();
    (w.config as Record<string, unknown>).account = 7;
    const back = normalizeWidget(JSON.parse(JSON.stringify(w)))!;
    expect(back.config.account).toBe("all");
  });
});

/* What the right-click offers to hang up, and the grouping behind it.
 *
 * The menu was nineteen rows before a browser widget and an Asana board landed
 * on the same afternoon. `offersOf` folds the catalogue's own editorial
 * sequence — "the room, then the meters, then the services, then the agents'
 * own notes, then the logs" — into families, and the invariant that matters is
 * unchanged by all of it: **every widget is still reachable.** A kind that
 * grouping loses is a widget you cannot hang up, and nothing in the app would
 * say so. */
describe("what a right-click offers to hang up", () => {
  const leaves = (offers: ReturnType<typeof offersOf>): string[] =>
    offers.flatMap((o) => ("items" in o ? o.items.map((i) => i.id) : [o.id]));

  test("every widget in the catalogue is reachable, exactly once", () => {
    const got = leaves(offersOf()).sort();
    expect(got).toEqual(WIDGETS.map((w) => w.kind).sort());
  });

  test("the menu is shorter than the catalogue, which is the whole point", () => {
    /* Not an arbitrary number: it asserts that grouping happened at all. A
       regression that dropped `family` from every spec would still pass every
       other test in this block. */
    expect(offersOf().length).toBeLessThan(WIDGETS.length);
  });

  test("a family appears where its first member sits", () => {
    /* So the editorial sequence still decides the order, and a family does not
       sink to the bottom for being a family. `clock` is first in `WIDGETS` and
       is in the room family, so the room's row is first. */
    const first = offersOf()[0];
    expect("items" in first).toBe(true);
    expect(first.id).toBe("family:room");
  });

  test("a family's row is not a widget kind, and a widget's row is", () => {
    /* The ids are what `menu.ts` turns into `widget:<kind>`, so a family row
       leaking into that position would be a menu item that tried to hang up a
       widget called "family:logs". */
    const kinds = new Set<string>(WIDGETS.map((w) => w.kind));
    for (const o of offersOf()) {
      if ("items" in o) {
        expect(o.id.startsWith("family:")).toBe(true);
        expect(kinds.has(o.id)).toBe(false);
      } else {
        expect(kinds.has(o.id)).toBe(true);
      }
    }
  });

  test("every family named on a spec is one the table can label", () => {
    /* A spec naming a family `FAMILIES` does not carry would fall to its own
       row — recoverable rather than absent, which is the choice `normalizeParam`
       makes about an unknown value — but it is still a bug, and this is what
       says so. */
    const known = new Set(FAMILIES.map((f) => f.id));
    for (const w of WIDGETS) {
      if (w.family) expect(known.has(w.family)).toBe(true);
    }
  });

  test("no family has exactly one member", () => {
    /* Which is why the flattening below never fires in practice. A family of one
       is a submenu you open to find a single row, and this is the assertion that
       keeps somebody from creating one by deleting a widget kind. */
    for (const o of offersOf()) {
      if ("items" in o) expect(o.items.length).toBeGreaterThan(1);
    }
  });

  test("a family of one is flattened to a plain row", () => {
    /* The path the assertion above keeps unreachable, proved anyway: deleting a
       widget kind must not leave a pointless hover behind. */
    const one = WIDGETS.filter((w) => w.kind === "serverlog");
    const out = offersOf(one);
    expect(out).toHaveLength(1);
    expect("items" in out[0]).toBe(false);
    expect(out[0].id).toBe("serverlog");
    /* And it goes back to its full label, not its in-family short one: "servers"
       means something under "hang up a log" and nothing on its own. */
    expect(out[0].label).toContain("server log");
  });

  test("every row reads as something to do, in the app's own voice", () => {
    /* It stands among "open a folder…" and "pin up an image…", so a bare noun
       would read as a thing to look at. Lowercase like every other sentence in
       this UI. */
    for (const o of offersOf()) {
      expect(o.label.startsWith("hang up ")).toBe(true);
      expect(o.label).toBe(o.label.toLowerCase());
    }
  });

  test("the article agrees with the label", () => {
    /* "hang up a asana board" is the kind of sentence that makes a careful app
       look careless, and it is what shipped before this. */
    for (const o of offersOf()) {
      const m = /^hang up an? (\S)/.exec(o.label);
      if (!m) continue;
      const vowel = /[aeiou]/i.test(m[1]);
      expect(o.label.startsWith(vowel ? "hang up an " : "hang up a ")).toBe(true);
    }
  });

  test("a submenu's rows are bare, since the verb has already been said", () => {
    for (const o of offersOf()) {
      if (!("items" in o)) continue;
      for (const i of o.items) {
        expect(i.label.startsWith("hang up")).toBe(false);
        expect(i.label.length).toBeGreaterThan(0);
      }
    }
  });
});
