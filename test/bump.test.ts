import { expect, test, describe } from "bun:test";
import {
  actionsFor,
  bumpPlan,
  bumpable,
  bumpedTo,
  compareVersions,
  folderName,
  formatVersion,
  parseVersion,
  BUMP_LEVELS,
  NO_STATUS,
  type BumpLevel,
  type ProjectFacts,
  type VersionFile,
} from "../src/lib/actions";
import { apart, arcSpots, ARC_ITEM, ARC_R, ARC_SPREAD } from "../src/lib/arc";

/* What a chip in the acts row measures — the thing the arc has to come out of
   without landing on. Same height as an arc item, since they are the same
   reading at the same type size. */
const CHIP = { w: 46, h: ARC_ITEM.h };
/* The button's own centre, which every offset is measured from. */
const ORIGIN = { dx: 0, dy: 0 };

/* A project whose only interesting property is what its files say about its
   version. `git` is on throughout: without a repository there is nothing to
   commit into and no tag to hang, which is asserted on its own below. */
const at = (...versions: VersionFile[]): ProjectFacts => ({
  root: "C:\\atelier\\skein",
  manager: "pnpm",
  scripts: [],
  node: false,
  tauri: false,
  cargo: false,
  git: true,
  unreal: null,
  versions,
});

const pkg = (version: string): VersionFile => ({
  path: "package.json",
  kind: "json",
  version,
});
const conf = (version: string): VersionFile => ({
  path: "src-tauri/tauri.conf.json",
  kind: "json",
  version,
});
const crate = (version: string): VersionFile => ({
  path: "src-tauri/Cargo.toml",
  kind: "toml",
  version,
});
const lock = (version: string): VersionFile => ({
  path: "src-tauri/Cargo.lock",
  kind: "lock",
  version,
});
const ini = (version: string): VersionFile => ({
  path: "Config/DefaultGame.ini",
  kind: "ini",
  version,
});

const ids = (f: ProjectFacts) => actionsFor(f, NO_STATUS).map((a) => a.id);

const planFor = (f: ProjectFacts, level: BumpLevel) => {
  const b = bumpable(f);
  if (!b) throw new Error("not bumpable");
  return bumpPlan(b, level, f.root);
};

describe("reading a version", () => {
  test("three numbers, or four for an unreal build number", () => {
    expect(parseVersion("0.7.0")).toEqual({ major: 0, minor: 7, patch: 0, arity: 3 });
    expect(parseVersion("1.0.0.4")).toEqual({ major: 1, minor: 0, patch: 0, arity: 4 });
    /* Whitespace inside the quotes is a real thing to find in a hand-edited
       file, and is not a reason to withhold the verb. */
    expect(parseVersion("  1.2.3  ")?.minor).toBe(2);
  });

  test("anything that is not a plain number is not a version", () => {
    /* Tauri lets `version` be a path to a package.json — read verbatim by
       `project.rs`, rejected here, which is where the judgement belongs. */
    expect(parseVersion("../package.json")).toBeNull();
    expect(parseVersion("v1.2.3")).toBeNull();
    expect(parseVersion("1.2")).toBeNull();
    expect(parseVersion("1.2.3.4.5")).toBeNull();
    expect(parseVersion("")).toBeNull();
  });

  /* Bumping *from* a prerelease is a release decision rather than arithmetic —
     patch could mean 1.2.0, 1.2.1-rc.1 or 1.2.0-rc.2 — so the verb is withheld
     rather than guessed at. */
  test("a prerelease is not bumpable", () => {
    expect(parseVersion("1.2.0-rc.1")).toBeNull();
    expect(parseVersion("1.2.0+build.7")).toBeNull();
    expect(bumpable(at(pkg("1.2.0-rc.1")))).toBeNull();
  });
});

describe("the arithmetic", () => {
  const v = parseVersion("1.4.7")!;

  test("one step up, everything to the right of it back to zero", () => {
    expect(formatVersion(bumpedTo(v, "major"))).toBe("2.0.0");
    expect(formatVersion(bumpedTo(v, "minor"))).toBe("1.5.0");
    expect(formatVersion(bumpedTo(v, "patch"))).toBe("1.4.8");
  });

  /* A fourth number is a build number, and resetting it is what a version bump
     means. It keeps its *position* — the file's own convention — and is always
     written as zero. */
  test("an unreal build number keeps its place and loses its value", () => {
    const u = parseVersion("1.0.0.4")!;
    expect(formatVersion(bumpedTo(u, "patch"), 4)).toBe("1.0.1.0");
    expect(formatVersion(bumpedTo(u, "major"), 4)).toBe("2.0.0.0");
    /* The tag and the message always take three, whatever the file carries. */
    expect(formatVersion(bumpedTo(u, "patch"))).toBe("1.0.1");
  });

  test("arity does not affect ordering", () => {
    expect(compareVersions(parseVersion("1.0.0")!, parseVersion("1.0.0.0")!)).toBe(0);
    expect(compareVersions(parseVersion("1.0.1")!, parseVersion("1.0.0.9")!)).toBeGreaterThan(0);
    expect(compareVersions(parseVersion("0.9.9")!, parseVersion("1.0.0")!)).toBeLessThan(0);
  });
});

describe("whether a project has a version to bump at all", () => {
  test("no repository, no verb — there is nothing to commit into", () => {
    const f = at(pkg("1.2.3"));
    expect(bumpable(f)).not.toBeNull();
    expect(bumpable({ ...f, git: false })).toBeNull();
    expect(ids({ ...f, git: false })).not.toContain("bump");
  });

  test("nothing declaring a version, no verb", () => {
    expect(bumpable(at())).toBeNull();
    expect(bumpable(at(conf("../package.json")))).toBeNull();
  });

  /* `0.0.0` is what `npm init` writes and what every private app that has never
     released still carries. It is the one number that says the field was never
     used rather than saying anything about a release. */
  test("0.0.0 is not a project versioning itself", () => {
    expect(bumpable(at(pkg("0.0.0")))).toBeNull();
    expect(ids(at(pkg("0.0.0")))).not.toContain("bump");
    /* 0.1.0 is `cargo new`'s default *and* a perfectly real first release, and
       there is no telling them apart — so it is offered. */
    expect(bumpable(at(pkg("0.1.0")))).not.toBeNull();
    /* And one file at 0.0.0 beside a real one does not veto it. */
    expect(formatVersion(bumpable(at(pkg("0.0.0"), conf("1.2.0")))!.from)).toBe("1.2.0");
  });
});

describe("files that disagree", () => {
  /* The highest is bumped from. Not a favoured shape and not a refusal: a
     refusal is a dead end that sends you to a terminal, and the lowest can go
     backwards over a tag that already exists. */
  test("the highest wins, and every file is still written", () => {
    const f = at(pkg("0.6.1"), conf("0.7.0"), crate("0.6.1"));
    const b = bumpable(f)!;
    expect(formatVersion(b.from)).toBe("0.7.0");
    expect(b.agreed).toBe(false);

    const plan = bumpPlan(b, "minor", f.root);
    expect(plan.to).toBe("0.8.0");
    /* All three, so the disagreement heals on the first press. */
    expect(plan.files.map((e) => e.to)).toEqual(["0.8.0", "0.8.0", "0.8.0"]);
    /* And each carries what its own file says now, so a stale reading refuses
       in `bump_version` rather than overwriting. */
    expect(plan.files.map((e) => e.from)).toEqual(["0.6.1", "0.7.0", "0.6.1"]);
  });

  test("the chip says so, because a silent reconciliation is worth knowing about", () => {
    const opener = actionsFor(at(pkg("0.6.1"), conf("0.7.0")), NO_STATUS).find(
      (a) => a.id === "bump",
    )!;
    expect(opener.title).toContain("do not agree");
    expect(opener.title).toContain("0.7.0 is the highest");

    const agreed = actionsFor(at(pkg("0.7.0"), conf("0.7.0")), NO_STATUS).find(
      (a) => a.id === "bump",
    )!;
    expect(agreed.title).not.toContain("do not agree");
  });

  /* Differing arity is not disagreement: an ini's `1.0.0.0` and a package.json's
     `1.0.0` are the same version, and each keeps its own shape. */
  test("three parts and four parts are the same version", () => {
    const f = at(pkg("1.0.0"), ini("1.0.0.0"));
    const b = bumpable(f)!;
    expect(b.agreed).toBe(true);
    const plan = bumpPlan(b, "minor", f.root);
    expect(plan.files.map((e) => e.to)).toEqual(["1.1.0", "1.1.0.0"]);
    expect(plan.tag).toBe("v1.1.0");
  });
});

describe("the plan", () => {
  const f = at(pkg("0.7.0"), crate("0.7.0"), lock("0.7.0"), conf("0.7.0"));

  test("the tag is the version with a v, which is what this repo already has", () => {
    expect(planFor(f, "minor").tag).toBe("v0.8.0");
    expect(planFor(f, "major").tag).toBe("v1.0.0");
    expect(planFor(f, "patch").tag).toBe("v0.7.1");
  });

  /* `<project>: <version>` — the shape this repository's own log already uses
     for a release (`skein: 0.7.0`). A message of just the number is unreadable
     in a log of anything else. */
  test("the message names the project as well as the number", () => {
    expect(planFor(f, "minor").message).toBe("skein: 0.8.0");
    expect(folderName("C:\\atelier\\skein")).toBe("skein");
    expect(folderName("/home/x/my-app/")).toBe("my-app");
  });

  /* The live test case: this repository at 0.7.0 carries the number in four
     files, and its own `skein: 0.7.0` commit moved all four together. */
  test("every declaring file is in it, lockfile included", () => {
    const plan = planFor(f, "patch");
    expect(plan.files.map((e) => e.path)).toEqual([
      "package.json",
      "src-tauri/Cargo.toml",
      "src-tauri/Cargo.lock",
      "src-tauri/tauri.conf.json",
    ]);
    expect(plan.files.every((e) => e.to === "0.7.1")).toBe(true);
    expect(plan.from).toBe("0.7.0");
  });
});

describe("the row", () => {
  const node = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({
    ...at(pkg("0.7.0")),
    node: true,
    scripts: ["build", "test"],
    ...over,
  });

  /* After the toolchain and before the two that leave the machine. What a bump
     produces is the push chip beside it — the branch ends one commit ahead — so
     a release leaves the machine by a separate, deliberate click. */
  test("bump sits between the toolchain and the git chips", () => {
    const row = ids({ ...node(), git: true });
    expect(row).toEqual(["build", "test", "bump", "bump:major", "bump:minor", "bump:patch"]);

    const ahead = actionsFor(node(), { ...NO_STATUS, upstream: true, ahead: 1, branch: "main" }).map(
      (a) => a.id,
    );
    expect(ahead.indexOf("bump")).toBeLessThan(ahead.indexOf("push"));
    expect(ahead.indexOf("test")).toBeLessThan(ahead.indexOf("bump"));
  });

  test("the opener carries the number and no steps; the choices carry the steps", () => {
    const row = actionsFor(node(), NO_STATUS);
    const opener = row.find((a) => a.id === "bump")!;
    expect(opener.label).toBe("bump 0.7.0");
    expect(opener.steps).toEqual([]);
    expect(opener.arc).toBeUndefined();

    for (const level of BUMP_LEVELS) {
      const choice = row.find((a) => a.id === `bump:${level}`)!;
      expect(choice.label).toBe(level);
      /* Hangs off the opener, so `chipsFor` gathers it rather than drawing it. */
      expect(choice.arc).toBe("bump");
      expect(choice.steps).toHaveLength(1);
      expect(choice.steps[0].kind).toBe("bump");
    }
  });

  test("biggest step first, the way a version number reads", () => {
    expect(BUMP_LEVELS).toEqual(["major", "minor", "patch"]);
  });

  /* The one thing this feature must never grow. A release leaves the machine
     because you pressed the push chip, never because you pressed bump. */
  test("nothing in a bump pushes", () => {
    for (const a of actionsFor(node(), NO_STATUS)) {
      if (!a.id.startsWith("bump")) continue;
      const argv = a.steps.flatMap((s) => (s.kind === "run" ? s.argv : []));
      expect(argv.join(" ")).not.toContain("push");
      expect(a.title).toContain("nothing is pushed");
    }
  });

  test("each choice says what it will do before it is pressed", () => {
    const minor = actionsFor(node(), NO_STATUS).find((a) => a.id === "bump:minor")!;
    expect(minor.title).toContain("0.7.0 → 0.8.0");
    expect(minor.title).toContain('commit "skein: 0.8.0"');
    expect(minor.title).toContain("tag v0.8.0");
  });

  /* An Unreal project versions in `Config/DefaultGame.ini` and offers the same
     verb, four-part number and all. */
  test("an unreal project bumps its ProjectVersion", () => {
    const f: ProjectFacts = {
      ...at(ini("1.0.0.4")),
      unreal: {
        uproject: "C:\\atelier\\skein\\Skein.uproject",
        name: "Skein",
        engine: "C:\\Program Files\\Epic Games\\UE_5.8",
        mcpPort: null,
        log: "C:\\atelier\\skein\\Saved\\Logs\\Skein.log",
      },
    };
    expect(ids(f)).toContain("bump");
    const plan = planFor(f, "minor");
    expect(plan.files).toEqual([
      { path: "Config/DefaultGame.ini", kind: "ini", from: "1.0.0.4", to: "1.1.0.0" },
    ]);
    expect(plan.tag).toBe("v1.1.0");
  });
});

/* The same class of invariant `CARD_BOX` has in `layout.test.ts`: a handful of
   numbers that have to hold or the thing collides with itself, where nothing
   would say so. Retuning `ARC_R` or `ARC_SPREAD` without re-checking these is
   the failure this exists to catch. */
describe("the arc's geometry", () => {
  const three = arcSpots(3);

  test("a top arc, not a circle — every choice ends up above the button", () => {
    expect(three).toHaveLength(3);
    for (const s of three) expect(s.dy).toBeLessThan(0);
    /* Left, middle, right, in reading order, and the middle one straight up. */
    expect(three[0].dx).toBeLessThan(0);
    expect(Math.abs(three[1].dx)).toBeLessThan(0.001);
    expect(three[2].dx).toBeGreaterThan(0);
    /* Symmetric, so the gesture is the same shape on both sides. */
    expect(three[0].dx).toBeCloseTo(-three[2].dx, 6);
    expect(three[0].dy).toBeCloseTo(three[2].dy, 6);
    /* And a shallow fan rather than a bloom: the outer two are further out
       than up, which is what keeps the peak near the acts row. */
    expect(Math.abs(three[0].dx)).toBeGreaterThan(Math.abs(three[0].dy));
  });

  test("nothing lands on the button it came out of", () => {
    for (const s of three) expect(apart(s, ORIGIN, CHIP)).toBe(true);
  });

  test("nothing lands on its neighbours", () => {
    expect(apart(three[0], three[1])).toBe(true);
    expect(apart(three[1], three[2])).toBe(true);
    expect(apart(three[0], three[2])).toBe(true);
  });

  /* The peak is what reaches over the card above the acts row. At `wall`
     density a card fills 78 of its 116-unit slot, so ~44 units of empty slot
     plus 18 of region padding sit beneath the last card — and the chip's own
     centre is ~12 above the region's bottom edge. Anything past that is
     transient overlap, accepted and bounded; see `arc.ts`. Asserted so that
     widening the arc has to be a decision rather than a side effect. */
  test("the peak stays within the slack beneath a card at wall density", () => {
    const peak = Math.max(...three.map((s) => -s.dy)) + ARC_ITEM.h / 2;
    expect(peak).toBeLessThanOrEqual(53);
    /* 44 of empty slot + 18 of padding, less the ~12 the chip's centre sits
       above the region's edge. */
    expect(peak).toBeLessThanOrEqual(44 + 18 - 12 + 3);
  });

  /* Sideways it must land inside the 52-unit gutter between territories even
     when the arc's chip is the first in the row — the row starts 11 units in
     and a chip's centre is another ~23, so 34 of the reach is inside the
     region and the rest overhangs. */
  test("the sideways reach overhangs less than the gutter between territories", () => {
    const reach = Math.max(...three.map((s) => Math.abs(s.dx))) + ARC_ITEM.w / 2;
    expect(reach - (11 + CHIP.w / 2)).toBeLessThan(52);
  });

  test("one choice has no fan to open, and none is no arc", () => {
    expect(arcSpots(1)).toEqual([{ dx: expect.closeTo(0, 6), dy: -ARC_R }]);
    expect(arcSpots(0)).toEqual([]);
  });

  /* `apart` is what "clears" means everywhere above: separated on *either*
     axis, since the outer items deliberately overlap the button horizontally
     and are held off it vertically. */
  test("apart is one axis, not both", () => {
    expect(apart({ dx: 0, dy: -30 }, ORIGIN)).toBe(true);
    expect(apart({ dx: 60, dy: 0 }, ORIGIN)).toBe(true);
    expect(apart({ dx: 10, dy: -5 }, ORIGIN)).toBe(false);
  });

  test("the fan opens through a spread it can afford", () => {
    /* Wider than this and the outer items sit on the chip, which the clearance
       test above would catch — this says the constant is the tuned one. */
    expect(ARC_SPREAD).toBe(120);
    expect(arcSpots(3, ARC_R, 170).some((s) => !apart(s, ORIGIN, CHIP))).toBe(true);
  });
});
