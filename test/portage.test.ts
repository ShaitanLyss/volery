import { describe, expect, test } from "bun:test";
import {
  alreadyHere,
  baseName,
  cleanAmbience,
  cleanGroup,
  cleanImage,
  cleanProject,
  cleanServer,
  cleanWidget,
  freeName,
  imageIsHere,
  LAYOUT_KEY,
  LAYOUT_VERSION,
  normPath,
  NOTHING_CARRIED,
  oneActive,
  readLayout,
  rebase,
  rerootGroup,
  sameSpot,
  saySize,
  sayTally,
  tally,
  versionOf,
  widgetIsHere,
  writeLayout,
  type Carried,
} from "../src/lib/portage";

const widget = (kind: string, x = 0, y = 0) => ({
  kind,
  x,
  y,
  w: 200,
  h: 120,
  z: 0,
  config: {},
});

const full: Carried = {
  projects: [
    {
      name: "skein",
      wasRoot: "C:\\atelier\\skein",
      x: 100,
      y: 200,
      groups: [
        {
          label: "dev",
          autostart: true,
          startOrder: 0,
          servers: [
            { label: "vite", command: "bun run dev", cwd: "C:\\atelier\\skein", port: 1420 },
          ],
        },
      ],
    },
  ],
  widgets: [widget("clock", 10, 20)],
  images: [{ name: "shot.png", x: 5, y: 6, w: 300, h: 200, rotation: 0, z: 1, bytes: "AAAA" }],
  ambiences: [{ name: "dusk", layers: [{ kind: "leaves" }], active: true }],
  themes: [],
};

describe("the round trip", () => {
  test("what goes out comes back", () => {
    const back = readLayout(writeLayout(full));
    expect(back).not.toBeNull();
    expect(back).toEqual(full);
  });

  test("the document says which version wrote it", () => {
    const text = writeLayout(full);
    expect(JSON.parse(text)[LAYOUT_KEY]).toBe(LAYOUT_VERSION);
    expect(versionOf(text)).toBe(LAYOUT_VERSION);
    expect(versionOf("not json")).toBeNull();
    expect(versionOf("{}")).toBeNull();
  });

  test("an empty wall is a legitimate thing to have exported", () => {
    /* Saying "nothing in that" about your own empty export would be a lie about
       the file rather than about the wall. */
    const back = readLayout(writeLayout(NOTHING_CARRIED));
    expect(back).toEqual(NOTHING_CARRIED);
  });

  test("text that is not a layout is not a layout", () => {
    expect(readLayout("")).toBeNull();
    expect(readLayout("not json at all")).toBeNull();
    expect(readLayout("[1,2,3]")).toBeNull();
    expect(readLayout("null")).toBeNull();
    /* An object with none of the five keys and no wrapper never claimed to be
       one. */
    expect(readLayout('{"something":"else"}')).toBeNull();
  });

  test("a section this build cannot use comes back empty rather than refusing the file", () => {
    const text = JSON.stringify({
      [LAYOUT_KEY]: 99,
      widgets: [widget("clock")],
      images: "this is not a list",
      projects: [{ nonsense: true }],
    });
    const back = readLayout(text);
    expect(back?.widgets).toHaveLength(1);
    expect(back?.images).toEqual([]);
    expect(back?.projects).toEqual([]);
  });

  test("a newer version is read rather than refused", () => {
    /* A partial import that says so beats no import. */
    const back = readLayout(JSON.stringify({ [LAYOUT_KEY]: 4096, widgets: [widget("clock")] }));
    expect(back?.widgets).toHaveLength(1);
  });
});

describe("cleaners", () => {
  test("a coordinate that is not a number cannot reach a transform", () => {
    const w = cleanWidget({ kind: "clock", x: "left", y: null, w: NaN, h: -5, z: 1.7 });
    expect(w).toEqual({ kind: "clock", x: 0, y: 0, w: 0, h: 0, z: 2, config: {} });
  });

  test("a widget with no kind is dropped, an unknown kind is not", () => {
    /* `widgets.ts` owns what kinds exist; this module must not hold a second
       copy of that list. */
    expect(cleanWidget({ x: 1, y: 2 })).toBeNull();
    expect(cleanWidget({ kind: "something-from-next-year" })?.kind).toBe(
      "something-from-next-year",
    );
  });

  test("a project with no root is dropped, and takes its name from the root when it has none", () => {
    expect(cleanProject({ name: "orphan" })).toBeNull();
    expect(cleanProject({ wasRoot: "C:\\work\\caravan" })?.name).toBe("caravan");
    /* `root_path` accepted as well as `wasRoot`, because a person hand-writing
       one of these will copy the column name. */
    expect(cleanProject({ root_path: "/home/x/thing" })?.wasRoot).toBe("/home/x/thing");
  });

  test("a group with no runnable server is a button that does nothing", () => {
    expect(cleanGroup({ label: "dev", servers: [] })).toBeNull();
    expect(cleanGroup({ label: "dev", servers: [{ label: "a" }] })).toBeNull();
    expect(cleanGroup({ servers: [{ command: "bun dev" }] })?.label).toBe("bun dev");
  });

  test("a port outside the range is a typo, not a port", () => {
    expect(cleanServer({ command: "x", port: 0 })?.port).toBeNull();
    expect(cleanServer({ command: "x", port: 70000 })?.port).toBeNull();
    expect(cleanServer({ command: "x", port: 1420.9 })?.port).toBe(1420);
    expect(cleanServer({ command: "x", port: "1420" })?.port).toBeNull();
  });

  test("start_order is accepted under either spelling", () => {
    expect(cleanGroup({ servers: [{ command: "x" }], start_order: 3 })?.startOrder).toBe(3);
    expect(cleanGroup({ servers: [{ command: "x" }], startOrder: 4 })?.startOrder).toBe(4);
  });

  test("an image keeps its place when its bytes could not be read", () => {
    /* A hole you can see and replace beats a row silently dropped. */
    const i = cleanImage({ name: "a.png", x: 1, y: 2, bytes: null });
    expect(i?.bytes).toBeNull();
    expect(i?.x).toBe(1);
  });

  test("an image takes its name off a path when that is all there is", () => {
    expect(cleanImage({ path: "C:\\Users\\x\\AppData\\references\\shot.png" })?.name).toBe(
      "shot.png",
    );
    expect(cleanImage({ name: "C:/somewhere/deep/pic.jpg" })?.name).toBe("pic.jpg");
  });

  test("only one ambience can be running", () => {
    const out = oneActive([
      { name: "a", layers: null, active: true },
      { name: "b", layers: null, active: true },
      { name: "c", layers: null, active: false },
    ]);
    expect(out.map((a) => a.active)).toEqual([true, false, false]);
  });

  test("an ambience with no name is dropped", () => {
    expect(cleanAmbience({ layers: [] })).toBeNull();
    expect(cleanAmbience({ name: "  " })).toBeNull();
    expect(cleanAmbience({ name: "dusk" })?.active).toBe(false);
  });
});

describe("identity — what counts as already being here", () => {
  test("furniture of the same kind in the same place is the same furniture", () => {
    const here = [{ kind: "clock", x: 100, y: 100 }];
    expect(widgetIsHere({ kind: "clock", x: 100, y: 100 }, here)).toBe(true);
    /* Slop, so a round trip through a float in JSON does not make a second
       clock. */
    expect(widgetIsHere({ kind: "clock", x: 102, y: 98 }, here)).toBe(true);
    expect(widgetIsHere({ kind: "clock", x: 400, y: 100 }, here)).toBe(false);
    expect(widgetIsHere({ kind: "performance", x: 100, y: 100 }, here)).toBe(false);
  });

  test("two clocks in one spot set differently are one clock somebody fiddled with", () => {
    /* Config is deliberately not part of the identity — a re-import should
       leave the fiddling alone rather than adding a second one underneath. */
    const here = [{ kind: "clock", x: 0, y: 0 }];
    expect(widgetIsHere({ kind: "clock", x: 0, y: 0 }, here)).toBe(true);
  });

  test("an image is matched on its file's name, not on a path from another machine", () => {
    const here = [{ path: "C:\\Users\\other\\AppData\\references\\Shot.PNG", x: 10, y: 10 }];
    expect(imageIsHere({ name: "shot.png", x: 10, y: 10 }, here)).toBe(true);
    expect(imageIsHere({ name: "shot.png", x: 900, y: 10 }, here)).toBe(false);
    expect(imageIsHere({ name: "other.png", x: 10, y: 10 }, here)).toBe(false);
  });

  test("nothing is here when nothing is here", () => {
    expect(widgetIsHere({ kind: "clock", x: 0, y: 0 }, [])).toBe(false);
    expect(imageIsHere({ name: "a.png", x: 0, y: 0 }, [])).toBe(false);
  });

  test("sameSpot takes its slop", () => {
    expect(sameSpot(0, 4)).toBe(true);
    expect(sameSpot(0, 5)).toBe(false);
    expect(sameSpot(0, 100, 200)).toBe(true);
  });
});

describe("paths", () => {
  test("the same folder spelled several ways is one folder", () => {
    expect(normPath("C:\\atelier\\skein")).toBe(normPath("c:/atelier/skein/"));
    expect(normPath("C:\\\\atelier\\\\skein\\\\")).toBe("c:/atelier/skein");
  });

  test("a territory is not duplicated by a backslash", () => {
    const roots = ["C:\\atelier\\skein", "D:/work/caravan"];
    expect(alreadyHere({ wasRoot: "c:/atelier/skein/" }, roots)).toBe(true);
    expect(alreadyHere({ wasRoot: "D:\\work\\caravan" }, roots)).toBe(true);
    expect(alreadyHere({ wasRoot: "C:\\atelier\\other" }, roots)).toBe(false);
    expect(alreadyHere({ wasRoot: "C:\\atelier\\skein" }, [])).toBe(false);
  });

  test("baseName keeps the extension, because two screenshots differing in one are two images", () => {
    expect(baseName("C:\\a\\b\\shot.png")).toBe("shot.png");
    expect(baseName("/a/b/shot.png")).toBe("shot.png");
    expect(baseName("shot.png")).toBe("shot.png");
    expect(baseName("C:\\a\\b\\")).toBe("b");
  });

  test("rebase moves a path from under one root to under another", () => {
    expect(rebase("C:\\old\\src\\main.ts", "C:\\old", "D:\\new")).toBe("D:\\new\\src\\main.ts");
    /* Separator style follows the new root — the result is a path for the
       machine reading it. */
    expect(rebase("C:\\old\\src", "C:\\old", "/home/x/new")).toBe("/home/x/new/src");
    expect(rebase("/home/x/old/a", "/home/x/old", "C:\\new")).toBe("C:\\new\\a");
  });

  test("the root itself rebases to the new root", () => {
    expect(rebase("C:\\old", "C:\\old", "D:\\new")).toBe("D:\\new");
    expect(rebase("C:\\old\\", "C:\\old", "D:\\new")).toBe("D:\\new");
  });

  test("a partial segment match is not a match", () => {
    /* `C:\work\skein-old` is not under `C:\work\skein`, and a naive prefix
       check says it is. This is the case the guard exists for. */
    expect(rebase("C:\\work\\skein-old\\a.ts", "C:\\work\\skein", "D:\\new")).toBe(
      "C:\\work\\skein-old\\a.ts",
    );
  });

  test("a path that is not under the old root is left alone", () => {
    /* Rewriting it would be inventing an intention. */
    expect(rebase("E:\\elsewhere\\thing", "C:\\old", "D:\\new")).toBe("E:\\elsewhere\\thing");
    expect(rebase("C:\\old\\a", "", "D:\\new")).toBe("C:\\old\\a");
  });

  test("rerooting a group moves its servers' working directories", () => {
    const g = {
      label: "dev",
      autostart: true,
      startOrder: 0,
      servers: [
        { label: "vite", command: "bun run dev", cwd: "C:\\old\\web", port: 1420 },
        { label: "api", command: "cargo run", cwd: null, port: 8080 },
        { label: "far", command: "x", cwd: "E:\\elsewhere", port: null },
      ],
    };
    const out = rerootGroup(g, "C:\\old", "D:\\new");
    expect(out.servers[0].cwd).toBe("D:\\new\\web");
    /* Null means "the project's root", which is the thing that just changed —
       so it is already correct, and making it absolute would freeze it. */
    expect(out.servers[1].cwd).toBeNull();
    expect(out.servers[2].cwd).toBe("E:\\elsewhere");
    expect(out.label).toBe("dev");
  });
});

describe("what the panel says", () => {
  test("a tally counts each kind and the weight of the images", () => {
    expect(tally(full)).toEqual({
      projects: 1,
      widgets: 1,
      images: 1,
      ambiences: 1,
      themes: 0,
      bytes: 4,
    });
  });

  test("nothing is nothing rather than a sentence of zeroes", () => {
    expect(sayTally(NOTHING_CARRIED)).toBeNull();
  });

  test("one of a thing is singular", () => {
    const one: Carried = { ...NOTHING_CARRIED, widgets: [widget("clock")] };
    expect(sayTally(one)).toBe("1 widget");
    const two: Carried = { ...NOTHING_CARRIED, widgets: [widget("clock"), widget("timer")] };
    expect(sayTally(two)).toBe("2 widgets");
  });

  test("the image weight is only mentioned when there is some", () => {
    const line = sayTally(full);
    expect(line).toContain("of image");
    const noBytes: Carried = {
      ...NOTHING_CARRIED,
      images: [{ name: "a.png", x: 0, y: 0, w: 1, h: 1, rotation: 0, z: 0, bytes: null }],
    };
    expect(sayTally(noBytes)).toBe("1 image");
  });

  test("sizes are rounded, because this is read to decide a press", () => {
    expect(saySize(500)).toBe("1kb");
    expect(saySize(1024 * 40)).toBe("40kb");
    expect(saySize(1024 * 1024 * 2.5)).toBe("2.5mb");
    expect(saySize(1024 * 1024 * 42)).toBe("42mb");
  });
});

describe("freeName", () => {
  test("renames rather than overwrites", () => {
    expect(freeName("dusk", [])).toBe("dusk");
    expect(freeName("dusk", ["dusk"])).toBe("dusk 2");
    expect(freeName("dusk", ["dusk", "dusk 2"])).toBe("dusk 3");
  });

  test("two names differing only in case are a person who does not think they have two", () => {
    expect(freeName("Dusk", ["dusk"])).toBe("Dusk 2");
    expect(freeName("dusk", ["  DUSK  "])).toBe("dusk 2");
  });
});
