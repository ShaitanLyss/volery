import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error a plain CommonJS module the browser host loads; no types
import roots from "../src-tauri/src/browserroots.cjs";

type Plan = { root?: string; refuse?: string } | null;
type Tree = { launch: string; top: string; worktrees: string[]; main?: string | null; unread?: boolean };
type Entry = { path: string; bare: boolean; prunable: boolean };
const R = roots as {
  named(args: unknown): string[];
  parseWorktrees(porcelain: string): Entry[];
  inside(P: typeof path, root: string, file: string): boolean;
  nearestReal(p: string, realpath?: (p: string) => string, P?: typeof path): string;
  cardRoots(t: Tree, P?: typeof path): string[];
  relativeIsGuess(t: Tree, P?: typeof path): boolean;
  plan(o: { args: unknown; launch: string; roots: string[]; output?: string; guess: boolean; unread?: boolean }, P?: typeof path): Plan;
  decide(o: {
    args: unknown;
    launch: string;
    outputDir?: string;
    git: (cwd: string, args: string[]) => Promise<string | null | undefined>;
    exists: (p: string) => boolean;
    realpath?: (p: string) => string;
  }): Promise<Plan>;
};

/* The two reproductions, on Windows paths whatever runs the suite. */
const W = path.win32;
const nova: Tree = {
  launch: "C:\\Users\\flori\\codes\\nova",
  top: "C:/Users/flori/codes/nova",
  worktrees: ["C:/Users/flori/codes/nova", "C:/Users/flori/codes/nova-hop"],
  main: "C:/Users/flori/codes/nova",
};
const novaRoots = R.cardRoots(nova, W);
const novaOut = "C:\\Users\\flori\\codes\\nova\\.playwright-mcp";
const plan = (args: unknown, t: Tree = nova, output = novaOut) =>
  R.plan({ args, launch: t.launch, roots: R.cardRoots(t, W), output, guess: R.relativeIsGuess(t, W), unread: t.unread }, W);

describe("what a call names", () => {
  test("filename on every save, paths on upload and drop", () => {
    expect(R.named({ filename: "a.png" })).toEqual(["a.png"]);
    expect(R.named({ paths: ["a", "b"] })).toEqual(["a", "b"]);
    expect(R.named({ url: "https://x" })).toEqual([]);
    expect(R.named({ filename: "  " })).toEqual([]);
    expect(R.named(undefined)).toEqual([]);
  });
});

describe("git worktree list --porcelain", () => {
  test("main first, with bare and prunable marked", () => {
    const out = [
      "worktree C:/r/main",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree C:/r/hop",
      "HEAD def",
      "detached",
      "",
      "worktree C:/r/gone",
      "HEAD 123",
      "prunable gitdir file points to non-existent location",
      "",
      "worktree C:/r/bare.git",
      "bare",
      "",
    ].join("\n");
    expect(R.parseWorktrees(out)).toEqual([
      { path: "C:/r/main", bare: false, prunable: false },
      { path: "C:/r/hop", bare: false, prunable: false },
      { path: "C:/r/gone", bare: false, prunable: true },
      { path: "C:/r/bare.git", bare: true, prunable: false },
    ]);
    expect(R.parseWorktrees("")).toEqual([]);
  });
});

describe("inside", () => {
  test("a name that only begins with two dots is inside; climbing out is not", () => {
    expect(R.inside(W, "C:\\repo", "C:\\repo\\..cache\\x.png")).toBe(true);
    expect(R.inside(W, "C:\\repo", "C:\\other\\x.png")).toBe(false);
    expect(R.inside(W, "C:\\repo", "C:\\repo")).toBe(true);
    expect(R.inside(W, "C:\\repo", "D:\\repo\\x")).toBe(false);
  });
});

describe("a card's roots", () => {
  test("the launch directory and every worktree of its repository", () => {
    expect(novaRoots).toEqual(["C:\\Users\\flori\\codes\\nova", "C:\\Users\\flori\\codes\\nova-hop"]);
  });

  test("launched below the top, each worktree gives the same subdirectory and nothing above it", () => {
    const sub = R.cardRoots({ launch: "C:\\r\\main\\apps\\web", top: "C:/r/main", worktrees: ["C:/r/main", "C:/r/hop"] }, W);
    expect(sub).toEqual(["C:\\r\\main\\apps\\web", "C:\\r\\hop\\apps\\web"]);
  });

  test("not in a repository, only the launch directory", () => {
    expect(R.cardRoots({ launch: "C:\\scratch", top: "", worktrees: [] }, W)).toEqual(["C:\\scratch"]);
  });
});

describe("one call", () => {
  test("an absolute path in a worktree runs under that worktree (ac92fe93)", () => {
    expect(plan({ filename: "C:/Users/flori/codes/nova-hop/.scratch/walk-hop-sheet.jpg" })).toEqual({
      root: "C:\\Users\\flori\\codes\\nova-hop",
    });
  });

  test("case does not matter on Windows", () => {
    expect(plan({ filename: "c:\\users\\FLORI\\codes\\Nova-Hop\\x.png" })?.root).toBe("C:\\Users\\flori\\codes\\nova-hop");
  });

  test("an absolute path in the launch tree or the output folder stays where it was", () => {
    expect(plan({ filename: "C:/Users/flori/codes/nova/shots/a.png" })).toEqual({ root: "C:\\Users\\flori\\codes\\nova" });
    expect(plan({ filename: `${novaOut}\\a.png` })).toEqual({ root: "C:\\Users\\flori\\codes\\nova" });
  });

  test("a sibling whose name only starts like a root is outside it", () => {
    const p = plan({ filename: "C:/Users/flori/codes/nova-hopper/x.png" });
    expect(p?.refuse).toContain("outside this card's roots");
  });

  test("outside every root is refused, naming the roots and why", () => {
    const p = plan({ filename: "C:/Windows/System32/x.png" });
    expect(p?.refuse).toContain("File access denied: C:\\Windows\\System32\\x.png");
    expect(p?.refuse).toContain("- C:\\Users\\flori\\codes\\nova\n- C:\\Users\\flori\\codes\\nova-hop");
    expect(p?.refuse).toContain("git worktree list");
    expect(p?.refuse).toContain(novaOut);
  });

  test("a `..` that climbs out of a worktree is outside it", () => {
    expect(plan({ filename: "C:/Users/flori/codes/nova-hop/../elsewhere/x.png" })?.refuse).toContain("outside");
  });

  test("a relative name from the main checkout of a repository with worktrees is refused, not guessed (c6683061)", () => {
    const p = plan({ filename: ".r1-logs/x.png" });
    expect(p?.refuse).toContain('Relative file name refused: ".r1-logs/x.png"');
    expect(p?.refuse).toContain("C:\\Users\\flori\\codes\\nova-hop");
    expect(p?.refuse).toContain(novaOut);
  });

  test("a relative name resolves against the launch directory where that is not a guess", () => {
    const alone: Tree = { launch: "C:\\r\\solo", top: "C:/r/solo", worktrees: ["C:/r/solo"], main: "C:/r/solo" };
    expect(plan({ filename: "x.png" }, alone, "C:\\r\\solo\\.playwright-mcp")).toEqual({ root: "C:\\r\\solo" });
    /* Launched in a worktree Volery made for it: that is where it works. */
    const put: Tree = { launch: "C:\\r\\hop", top: "C:/r/hop", worktrees: ["C:/r/main", "C:/r/hop"], main: "C:/r/main" };
    expect(plan({ filename: "x.png" }, put, "C:\\r\\hop\\.playwright-mcp")).toEqual({ root: "C:\\r\\hop" });
  });

  test("launched in a linked worktree of a bare repository, relative names are not a guess", () => {
    const bare: Tree = { launch: "C:\\r\\a", top: "C:/r/a", worktrees: ["C:/r/a", "C:/r/b"], main: null };
    expect(plan({ filename: "x.png" }, bare, "C:\\r\\a\\.playwright-mcp")).toEqual({ root: "C:\\r\\a" });
  });

  test("when git did not answer, a relative name is refused rather than taken for the launch tree", () => {
    const silent: Tree = { launch: "C:\\r\\main", top: "", worktrees: [], main: null, unread: true };
    const p = plan({ filename: "x.png" }, silent, "C:\\r\\main\\.playwright-mcp");
    expect(p?.refuse).toContain("could not read this repository's worktrees");
    expect(p?.refuse).toContain("Git did not answer");
    expect(plan({ filename: "C:/r/hop/x.png" }, silent)?.refuse).toContain("Git did not answer");
  });

  test("files in two trees in one call are refused", () => {
    const p = plan({ paths: ["C:/Users/flori/codes/nova/a.txt", "C:/Users/flori/codes/nova-hop/b.txt"] });
    expect(p?.refuse).toContain("different working trees");
  });

  test("a worktree kept inside the checkout is the root for its own files", () => {
    const nested: Tree = { launch: "C:\\r\\main", top: "C:/r/main", worktrees: ["C:/r/main", "C:/r/main/.worktrees/a"], main: "C:/r/main" };
    expect(plan({ filename: "C:/r/main/.worktrees/a/x.png" }, nested, "C:\\r\\main\\.playwright-mcp")).toEqual({
      root: "C:\\r\\main\\.worktrees\\a",
    });
  });

  test("a call that names no file is left alone", () => {
    expect(plan({ url: "https://example.com" })).toBeNull();
  });
});

/* The whole decision against a real repository: the card "starts", a call is
   decided, a worktree is added, and the next call reaches it. */
describe("against real git", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "browserroots-"));
  const main = path.join(base, "repo");
  const hop = path.join(base, "repo-hop");
  const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
  const git = async (cwd: string, args: string[]) => {
    try {
      return String(execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }));
    } catch (e: any) {
      return /not a git repository/i.test(String(e.stderr)) ? null : undefined;
    }
  };
  const realpath = fs.realpathSync.native;
  fs.mkdirSync(main);
  run(main, "init", "-q");
  run(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  const decide = (filename: string, launch = main) => R.decide({ args: { filename }, launch, git, exists: fs.existsSync, realpath });

  test("a worktree created after the card started is reachable on the next call", async () => {
    const before = await decide(path.join(hop, "x.png"));
    expect(before?.refuse).toContain("outside this card's roots");
    /* Alone, a relative name is the launch directory, as it always was. */
    expect(await decide("x.png")).toBeNull();

    run(main, "worktree", "add", "-q", hop);
    const after = await decide(path.join(hop, ".scratch", "x.png"));
    expect(after?.root && realpath(after.root)).toBe(realpath(hop));
    /* And now the relative name is a guess, so it is refused. */
    expect((await decide("x.png"))?.refuse).toContain("Relative file name refused");
    expect(await decide(path.join(main, "x.png"))).toBeNull();
  });

  test("launched through a junction, the worktrees are still found and agree with the real-path check", async () => {
    const link = path.join(base, "via");
    fs.symlinkSync(main, link, "junction");
    const p = await decide(path.join(hop, "y.png"), link);
    expect(p?.root && realpath(p.root)).toBe(realpath(hop));
    expect((await decide("y.png", link))?.refuse).toContain("Relative file name refused");
    /* The junction's own spelling of a file in the launch tree is the launch tree. */
    expect(await decide(path.join(link, "y.png"), link)).toBeNull();
  });

  test("a git that fails is not a directory with no repository", async () => {
    const broken = async () => undefined;
    const p = await R.decide({ args: { filename: "x.png" }, launch: main, git: broken, exists: fs.existsSync });
    expect(p?.refuse).toContain("Git did not answer");
  });

  test("a worktree whose folder has gone is no longer a root", async () => {
    fs.rmSync(hop, { recursive: true, force: true });
    expect((await decide(path.join(hop, "x.png")))?.refuse).toContain("outside");
  });

  test("not a repository: the launch directory alone", async () => {
    const loose = path.join(base, "loose");
    fs.mkdirSync(loose);
    const p = await R.decide({ args: { filename: path.join(hop, "x.png") }, launch: loose, git, exists: fs.existsSync, realpath });
    expect(p?.refuse).toContain("outside");
    expect(await R.decide({ args: { filename: "x.png" }, launch: loose, git, exists: fs.existsSync, realpath })).toBeNull();
  });
});
