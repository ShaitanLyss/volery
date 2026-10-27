import { describe, expect, test } from "bun:test";
import { rasterTarget, saveName } from "../src/lib/picturecopy";

describe("rasterTarget", () => {
  test("a raster is never resized", () => {
    expect(rasterTarget(3200, 2053, false)).toEqual({ w: 3200, h: 2053 });
  });
  test("a small svg is drawn wide enough to paste", () => {
    expect(rasterTarget(400, 200, true)).toEqual({ w: 1600, h: 800 });
  });
  test("a huge svg is bounded", () => {
    const t = rasterTarget(10000, 5000, true);
    expect(Math.max(t.w, t.h)).toBe(4096);
  });
  test("no size, no target", () => {
    expect(rasterTarget(0, 0, true)).toEqual({ w: 0, h: 0 });
  });
});

describe("saveName", () => {
  test("keeps the name, takes the extension from the bytes", () => {
    expect(saveName("eos-13-1.png", "data:image/png;base64,AAA")).toBe("eos-13-1.png");
    expect(saveName("chart.svg", "data:image/svg+xml;base64,AAA")).toBe("chart.svg");
    expect(saveName("photo.jpeg", "data:image/jpeg;base64,AAA")).toBe("photo.jpg");
  });
  test("a name with no file in it", () => {
    expect(saveName("", "data:image/png;base64,AAA")).toBe("picture.png");
    expect(saveName("a/b:c", "data:image/png;base64,AAA")).toBe("a-b-c.png");
  });
});
