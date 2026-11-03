import { describe, expect, test } from "bun:test";

import { readSheets, sheetKnobs, sheetWidget } from "../src/lib/sheets";
import { READINGS } from "../src/lib/leader";
import { FRAME, VARIANT, defaultConfig, rowsFor } from "../src/lib/widgets";

describe("a reading in a sheet", () => {
  test("is the widget, at the size of the box it is drawn in", () => {
    const w = sheetWidget("pipelines", {}, { w: 820.4, h: 540.6 })!;
    expect(w).toMatchObject({ kind: "pipelines", w: 820, h: 541, x: 0, y: 0 });
    /* The face fits rows to the height, as on the wall: a tall sheet shows
       more of the list than a widget hung at its default size. */
    expect(rowsFor(w.h)).toBeGreaterThan(rowsFor(210));
  });

  test("with its config normalized as one off disk is", () => {
    const kept = sheetWidget("pipelines", { scope: "mine", variant: "retired-reading", junk: 4 }, { w: 400, h: 300 })!;
    expect(kept.config.scope).toBe("mine");
    expect(kept.config[VARIANT]).toBe(defaultConfig("pipelines")[VARIANT]);
    expect(kept.config.junk).toBeUndefined();
  });

  test("every reading can be held, and nothing else can", () => {
    for (const k of READINGS) expect(sheetWidget(k, null, { w: 300, h: 200 })).not.toBeNull();
    expect(sheetWidget("clock", null, { w: 300, h: 200 })).toBeNull();
    expect(sheetWidget("said", null, { w: 300, h: 200 })).toBeNull();
    expect(sheetWidget("nonsense", null, { w: 300, h: 200 })).toBeNull();
  });

  test("offers the widget's own knobs, less the frame", () => {
    const keys = sheetKnobs("pipelines", defaultConfig("pipelines")).map((p) => p.key);
    expect(keys).toContain(VARIANT);
    expect(keys).toContain("scope");
    expect(keys).not.toContain(FRAME);
    for (const k of READINGS) expect(sheetKnobs(k, defaultConfig(k)).map((p) => p.key)).not.toContain(FRAME);
  });

  test("and never a knob whose options come from elsewhere", () => {
    for (const k of READINGS) {
      for (const p of sheetKnobs(k, defaultConfig(k))) if (p.kind === "choice") expect(p.from).toBeUndefined();
    }
  });
});

describe("what is kept between openings", () => {
  test("reads an object of readings, and nothing else", () => {
    expect(readSheets(null)).toEqual({});
    expect(readSheets("not json")).toEqual({});
    expect(readSheets("[1,2]")).toEqual({});
    expect(readSheets(JSON.stringify({ pipelines: { scope: "all" }, clock: { variant: "analog" }, reviews: 3 }))).toEqual({
      pipelines: { scope: "all" },
    });
  });
});
