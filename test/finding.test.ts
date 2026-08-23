import { describe, expect, test } from "bun:test";

import {
  CHORDS,
  LAPSE_MS,
  LEADER,
  chord,
  fileRows,
  grepRows,
  insideRoot,
  isMarkdown,
  moveIn,
  offers,
  pieces,
  placesIn,
  rank,
  runsOf,
  score,
  shift,
  splitPath,
  viewLines,
  windowAround,
  type Hit,
} from "../src/lib/finding";

/* ── the leader ───────────────────────────────────────────────────────────── */

describe("the space leader", () => {
  test("a bare key with nothing open is not ours", () => {
    const step = chord(null, "q");
    expect(step.kind).toBe("idle");
    expect(step.swallow).toBe(false);
  });

  test("the leader opens a sequence and is swallowed", () => {
    const step = chord(null, LEADER);
    expect(step.kind).toBe("leader");
    expect(step.open).toBe("");
    expect(step.swallow).toBe(true);
  });

  test("space then f then f finds a file", () => {
    /* The whole gesture, pressed one key at a time the way a hand does it. */
    let open = chord(null, " ").open;
    let step = chord(open, "f");
    expect(step.kind).toBe("pending");
    expect(step.open).toBe("f");
    open = step.open;
    step = chord(open, "f");
    expect(step.kind).toBe("fire");
    expect(step).toMatchObject({ mode: "files" });
    expect(step.open).toBeNull();
  });

  test("space then f then w greps", () => {
    const step = chord(chord(chord(null, " ").open, "f").open, "w");
    expect(step).toMatchObject({ kind: "fire", mode: "grep" });
  });

  test("a key that completes no chord falls through rather than being eaten", () => {
    /* The one that matters. `<space>q` in nvim leaves you with a `q`; a finder
       that swallowed it would be a wall where a letter occasionally vanished
       into a gesture nobody made. */
    const step = chord("", "q");
    expect(step.kind).toBe("lapse");
    expect(step.swallow).toBe(false);
    expect(step.open).toBeNull();
  });

  test("a second letter that completes no chord also falls through", () => {
    const step = chord("f", "z");
    expect(step.kind).toBe("lapse");
    expect(step.swallow).toBe(false);
  });

  test("escape abandons the sequence and is the one key that is still ours", () => {
    /* Swallowed, so a press meant as "forget it" does not also deselect the
       card — that would be one key doing two things. */
    const step = chord("f", "Escape");
    expect(step.kind).toBe("lapse");
    expect(step.swallow).toBe(true);
  });

  test("a sequence lapses, and the key is reconsidered from scratch", () => {
    /* Not merely dropped: the leader pressed again after a long wait has to
       open a *fresh* sequence rather than be read as the second key of the
       stale one. */
    const step = chord("f", " ", LAPSE_MS + 1);
    expect(step.kind).toBe("leader");
    expect(step.open).toBe("");
  });

  test("a letter after the lapse belongs to the wall again", () => {
    const step = chord("f", "f", LAPSE_MS + 1);
    expect(step.kind).toBe("idle");
    expect(step.swallow).toBe(false);
  });

  test("inside the timeout the same letter still completes the chord", () => {
    const step = chord("f", "f", LAPSE_MS - 1);
    expect(step).toMatchObject({ kind: "fire", mode: "files" });
  });

  test("the leader pressed inside a sequence restarts it", () => {
    const step = chord("f", " ");
    expect(step.kind).toBe("leader");
    expect(step.open).toBe("");
  });

  test("a modifier on its own leaves the sequence exactly as it was", () => {
    /* Every modifier fires its own keydown, so without this a hand brushing
       Shift between the leader and the letter would abandon the chord. */
    for (const key of ["Shift", "Control", "Alt", "Meta", "CapsLock"]) {
      const step = chord("f", key);
      expect(step.kind).toBe("held");
      expect(step.open).toBe("f");
      expect(step.swallow).toBe(false);
    }
  });

  test("a modifier with nothing open changes nothing either", () => {
    const step = chord(null, "Shift");
    expect(step).toMatchObject({ kind: "held", open: null, swallow: false });
  });

  test("a named key is not a letter in a chord", () => {
    for (const key of ["Tab", "Enter", "ArrowDown", "F11", "Home"]) {
      expect(chord("f", key).kind).toBe("lapse");
    }
  });

  test("shift+F still types the chord", () => {
    /* Which is how a caps-locked keyboard types it, and how a hand that holds
       shift a beat too long does. */
    expect(chord(chord(null, " ").open, "F")).toMatchObject({ kind: "pending", open: "f" });
    expect(chord("f", "F")).toMatchObject({ kind: "fire", mode: "files" });
  });
});

describe("the which-key hint", () => {
  test("the leader alone offers both chords, by their whole letters", () => {
    expect(offers("")).toEqual([
      { keys: "ff", mode: "files" },
      { keys: "fw", mode: "grep" },
    ]);
  });

  test("one letter in, it offers only what is left to press", () => {
    expect(offers("f")).toEqual([
      { keys: "f", mode: "files" },
      { keys: "w", mode: "grep" },
    ]);
  });

  test("a completed chord offers nothing — there is nothing left to press", () => {
    expect(offers("ff")).toEqual([]);
  });

  test("every chord in the catalogue is reachable from the leader", () => {
    /* Guards against a chord being added whose first letter nothing offers,
       which would be a binding with no affordance at all. */
    const heads = new Set(offers("").map((o) => o.keys));
    for (const seq of Object.keys(CHORDS)) expect(heads.has(seq)).toBe(true);
  });
});

/* ── scoring ──────────────────────────────────────────────────────────────── */

describe("scoring a path", () => {
  test("a query that is not a subsequence does not match at all", () => {
    expect(score("src/lib/finding.ts", "zzz")).toBeNull();
    /* Order matters — the letters are there but not in that order. */
    expect(score("abc", "cba")).toBeNull();
  });

  test("an empty query matches everything, flatly", () => {
    expect(score("anything", "")).toEqual({ score: 0, spans: [] });
  });

  test("case is never a filter", () => {
    expect(score("src/lib/Transcript.svelte", "transcript")).not.toBeNull();
    expect(score("src/lib/transcript.ts", "TRANSCRIPT")).not.toBeNull();
  });

  test("a consecutive run beats the same letters strewn about", () => {
    const together = score("src/lib/finding.ts", "find")!.score;
    const apart = score("f-i-n-d-x.ts", "find")!.score;
    expect(together).toBeGreaterThan(apart);
  });

  test("the initials of the segments find the file", () => {
    /* The word-boundary bonus, which is the thing that makes a two-letter
       query useful at all. */
    const wanted = score("src/lib/theme.ts", "slt")!.score;
    const other = score("src/lib/ambience.ts", "slt")!.score;
    expect(wanted).toBeGreaterThan(other);
  });

  test("the spans say where it matched, merged into runs", () => {
    const s = score("src/lib/finding.ts", "find")!;
    expect(s.spans).toEqual([{ from: 8, to: 12 }]);
  });

  test("a space in the query is a separator and not a character to find", () => {
    /* Nobody looks for a path with a space in it by typing the space. */
    expect(score("src/lib/theme.ts", "lib theme")).not.toBeNull();
  });

  test("runs are the fewest spans that cover the hits", () => {
    expect(runsOf([1, 2, 3, 7, 8, 20])).toEqual([
      { from: 1, to: 4 },
      { from: 7, to: 9 },
      { from: 20, to: 21 },
    ]);
    expect(runsOf([])).toEqual([]);
  });
});

describe("ranking", () => {
  const FILES = [
    "src/lib/store.ts",
    "src-tauri/src/store.rs",
    "src/lib/storage/index.ts",
    "src/lib/conversation.svelte.ts",
    "docs/NAMES.md",
    ".claude/rules/finding.md",
    "src/lib/finding.ts",
    "test/finding.test.ts",
  ];

  test("a name typed in full comes first", () => {
    expect(rank(FILES, "finding.ts")[0].item).toBe("src/lib/finding.ts");
  });

  test("the file wins over the folder of the same name", () => {
    /* `store` must mean `store.ts`, not everything living under a `storage/`. */
    const top = rank(FILES, "store").map((r) => r.item);
    expect(top[0]).toMatch(/store\.(ts|rs)$/);
    expect(top.indexOf("src/lib/storage/index.ts")).toBeGreaterThan(1);
  });

  test("initials find a long name", () => {
    expect(rank(FILES, "csvl")[0].item).toBe("src/lib/conversation.svelte.ts");
  });

  test("an empty query is the head of the list rather than nothing", () => {
    /* Opening onto the shape of the project beats opening onto a blank panel. */
    const out = rank(FILES, "", 3);
    expect(out.map((r) => r.item)).toEqual(FILES.slice(0, 3));
  });

  test("nothing matching is an empty answer and not an error", () => {
    expect(rank(FILES, "qqqqq")).toEqual([]);
  });

  test("the cap bounds what comes back", () => {
    const many = Array.from({ length: 500 }, (_, i) => `src/f${i}.ts`);
    expect(rank(many, "f", 20).length).toBe(20);
  });
});

/* ── the two lists ────────────────────────────────────────────────────────── */

describe("grep mode's list", () => {
  const HITS: Hit[] = [
    { path: "src/lib/finding.ts", line: 12, col: 5, text: "export const LEADER = ' ';" },
    { path: "src/App.svelte", line: 900, col: 9, text: "finder.press(e.key)" },
  ];
  const FILES = ["src/lib/finding.ts", "src/lib/finder.svelte.ts"];

  test("names come before contents", () => {
    /* Asked for as "search file name and contents", and the order is the
       judgement: a name match is a far stronger statement of intent, and there
       are always fewer of them. */
    const rows = grepRows(HITS, FILES, "finding");
    expect(rows[0]).toMatchObject({ path: "src/lib/finding.ts", line: null, marked: "path" });
    expect(rows.some((r) => r.marked === "text" && r.line === 900)).toBe(true);
  });

  test("a content row carries the place and the line", () => {
    /* With no file list there are no name rows, so the content hits are the
       whole list — in ripgrep's own order, which is the walk order and is why
       a file's lines stay together. */
    const rows = grepRows(HITS, [], "press");
    expect(rows.length).toBe(2);
    expect(rows[1]).toMatchObject({ path: "src/App.svelte", line: 900, col: 9, marked: "text" });
    expect(rows[1].text).toBe("finder.press(e.key)");
  });

  test("the mark on a content row starts at the column ripgrep gave", () => {
    const row = grepRows(HITS, [], "press")[1];
    /* Column 9, 1-based, so index 8 — and as wide as what was typed, which is
       exact for a literal and approximate for a regex. */
    expect(row.spans).toEqual([{ from: 8, to: 13 }]);
  });

  test("with no query there are no name rows to put first", () => {
    const rows = grepRows(HITS, FILES, "");
    expect(rows.every((r) => r.marked === "text")).toBe(true);
    expect(rows.length).toBe(2);
  });

  test("files mode makes a row per path and nothing else", () => {
    const rows = fileRows(FILES, "finding");
    expect(rows[0]).toMatchObject({ line: null, col: null, text: null, marked: "path" });
  });
});

/* ── drawing ──────────────────────────────────────────────────────────────── */

describe("marking the match", () => {
  test("a string is split into plain and matched pieces", () => {
    expect(pieces("finding.ts", [{ from: 0, to: 4 }])).toEqual([
      { text: "find", hit: true },
      { text: "ing.ts", hit: false },
    ]);
  });

  test("nothing matched is one plain piece", () => {
    expect(pieces("abc", [])).toEqual([{ text: "abc", hit: false }]);
  });

  test("the pieces always concatenate back to the original", () => {
    /* An off-by-one here drops a character out of the middle of a path and the
       panel still looks entirely plausible, which is why this is asserted
       rather than eyeballed. */
    const text = "src/lib/finding.ts";
    for (const spans of [
      [{ from: 0, to: 3 }],
      [{ from: 4, to: 7 }, { from: 8, to: 12 }],
      [{ from: 15, to: 18 }],
    ]) {
      expect(pieces(text, spans).map((p) => p.text).join("")).toBe(text);
    }
  });

  test("spans are moved onto the filename, and the ones in the directory go", () => {
    /* A clamped half-span would mark the first character of the filename —
       a character that did not match, which is worse than marking nothing. */
    const spans = [{ from: 2, to: 5 }, { from: 9, to: 13 }];
    expect(shift(spans, 8)).toEqual([{ from: 1, to: 5 }]);
  });
});

describe("moving through the list", () => {
  test("both ends clamp rather than wrapping", () => {
    expect(moveIn(5, 0, -1)).toBe(0);
    expect(moveIn(5, 4, 1)).toBe(4);
    expect(moveIn(5, 2, 1)).toBe(3);
  });

  test("a page step lands inside the list rather than past it", () => {
    expect(moveIn(5, 0, 10)).toBe(4);
    expect(moveIn(50, 40, 10)).toBe(49);
  });

  test("an empty list has nowhere to be", () => {
    expect(moveIn(0, 0, 1)).toBe(0);
    expect(moveIn(0, 3, -1)).toBe(0);
  });
});

/* ── the viewer ───────────────────────────────────────────────────────────── */

describe("reading a file", () => {
  test("lines are numbered from one", () => {
    expect(viewLines("a\nb\nc")).toEqual([
      { no: 1, text: "a" },
      { no: 2, text: "b" },
      { no: 3, text: "c" },
    ]);
  });

  test("the newline every text file ends with is not a line", () => {
    expect(viewLines("a\nb\n").length).toBe(2);
  });

  test("a blank line in the middle is a line", () => {
    expect(viewLines("a\n\nb\n").map((l) => l.text)).toEqual(["a", "", "b"]);
  });

  test("CRLF leaves nothing behind", () => {
    expect(viewLines("a\r\nb\r\n").map((l) => l.text)).toEqual(["a", "b"]);
  });

  test("the cap bounds the rows", () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    expect(viewLines(text, 10).length).toBe(10);
  });

  test("an empty file is no lines at all", () => {
    expect(viewLines("")).toEqual([]);
  });
});

describe("the preview window", () => {
  test("a short file is shown whole", () => {
    expect(windowAround(20, 5, 60)).toEqual({ from: 0, to: 20 });
  });

  test("a whole-file row shows the head", () => {
    expect(windowAround(500, null, 60)).toEqual({ from: 0, to: 60 });
  });

  test("the hit sits a third of the way down", () => {
    /* What you want to see about a line of source is mostly what comes after
       it, so it is not centred. */
    const w = windowAround(500, 100, 60);
    expect(w).toEqual({ from: 79, to: 139 });
    expect(100).toBeGreaterThan(w.from);
    expect(100).toBeLessThan(w.to);
  });

  test("a hit near the top does not open onto half a window", () => {
    expect(windowAround(500, 2, 60)).toEqual({ from: 0, to: 60 });
  });

  test("a hit near the bottom shows the last rows rather than running past", () => {
    expect(windowAround(500, 499, 60)).toEqual({ from: 440, to: 500 });
  });
});

describe("which files are documents", () => {
  test("markdown is, whatever it is spelt like", () => {
    expect(isMarkdown("README.md")).toBe(true);
    expect(isMarkdown(".claude/rules/finding.md")).toBe(true);
    expect(isMarkdown("docs/NAMES.MARKDOWN")).toBe(true);
    expect(isMarkdown("a/b.mdx")).toBe(true);
  });

  test("source is not", () => {
    expect(isMarkdown("src/lib/finding.ts")).toBe(false);
    expect(isMarkdown("Cargo.toml")).toBe(false);
    /* No extension at all — a normal thing for a file to have, and it must not
       throw or be read as a document. */
    expect(isMarkdown("LICENSE")).toBe(false);
    expect(isMarkdown("src/lib")).toBe(false);
  });

  test("a directory that looks like an extension does not count", () => {
    expect(isMarkdown("docs.md/notes.ts")).toBe(false);
  });
});

describe("splitting a path", () => {
  test("the directory keeps its separator, so the halves rejoin", () => {
    const p = splitPath("src/lib/finding.ts");
    expect(p).toEqual({ dir: "src/lib/", name: "finding.ts" });
    expect(p.dir + p.name).toBe("src/lib/finding.ts");
  });

  test("a bare name has no directory", () => {
    expect(splitPath("package.json")).toEqual({ dir: "", name: "package.json" });
  });

  test("a windows path splits at the last separator too", () => {
    expect(splitPath("C:\\atelier\\skein")).toEqual({ dir: "C:\\atelier\\", name: "skein" });
  });
});

/* ── reaching the viewer from a transcript ────────────────────────────────── */

describe("reducing a path against a project root", () => {
  const ROOT = "C:\\atelier\\skein";

  test("an absolute path inside the root becomes a relative one", () => {
    expect(insideRoot("C:\\atelier\\skein\\src\\lib\\finding.ts", ROOT)).toBe(
      "src/lib/finding.ts",
    );
  });

  test("either separator, on either side", () => {
    expect(insideRoot("C:/atelier/skein/src/lib/a.ts", ROOT)).toBe("src/lib/a.ts");
    expect(insideRoot("C:\\atelier\\skein\\src\\a.ts", "C:/atelier/skein")).toBe("src/a.ts");
  });

  test("case does not decide it, because Windows does not", () => {
    expect(insideRoot("c:\\ATELIER\\Skein\\src\\a.ts", ROOT)).toBe("src/a.ts");
  });

  test("a trailing separator on the root changes nothing", () => {
    expect(insideRoot("C:\\atelier\\skein\\a.ts", "C:\\atelier\\skein\\")).toBe("a.ts");
  });

  test("a path outside the root is null rather than clamped", () => {
    /* The useful answer. A tool call can name a file in another repo, in %TEMP%
       or in the engine directory, and none of those can be opened here — they
       have to stay inert text rather than become a link that fails. */
    expect(insideRoot("C:\\Windows\\win.ini", ROOT)).toBeNull();
    expect(insideRoot("C:\\atelier\\caravan\\src\\a.cpp", ROOT)).toBeNull();
    expect(insideRoot("/etc/passwd", ROOT)).toBeNull();
  });

  test("a sibling whose name merely starts the same is outside", () => {
    /* Whole segments only: `skein2` is not inside `skein`. */
    expect(insideRoot("C:\\atelier\\skein2\\a.ts", ROOT)).toBeNull();
  });

  test("the root itself is a directory and not a file to open", () => {
    expect(insideRoot(ROOT, ROOT)).toBeNull();
    expect(insideRoot(ROOT + "\\", ROOT)).toBeNull();
  });

  test("an already-relative path is taken as it is", () => {
    expect(insideRoot("src/lib/finding.ts", ROOT)).toBe("src/lib/finding.ts");
    expect(insideRoot("./src/lib/a.ts", ROOT)).toBe("src/lib/a.ts");
    expect(insideRoot(".claude/rules/finding.md", ROOT)).toBe(".claude/rules/finding.md");
  });

  test("a relative path that climbs out is refused here too", () => {
    /* Rust refuses it as well, and both must: the front end so no dead link is
       drawn, Rust because a command is reachable from anything holding the IPC. */
    expect(insideRoot("..\\..\\Windows\\win.ini", ROOT)).toBeNull();
    expect(insideRoot("src/../../secrets", ROOT)).toBeNull();
  });

  test("nothing on either side is null and not a crash", () => {
    expect(insideRoot("", ROOT)).toBeNull();
    expect(insideRoot("src/a.ts", "")).toBeNull();
  });
});

describe("finding places in a tool result", () => {
  test("ripgrep's own output is a list of places", () => {
    const text =
      "src/lib/finding.ts:42:7:  const at = 0;\nsrc/App.svelte:900:9:  finder.press(e.key)";
    const found = placesIn(text);
    expect(found.length).toBe(2);
    expect(found[0]).toMatchObject({ path: "src/lib/finding.ts", line: 42, col: 7 });
    expect(found[1]).toMatchObject({ path: "src/App.svelte", line: 900, col: 9 });
  });

  test("the span covers exactly the place and not the line after it", () => {
    const text = "src/lib/finding.ts:42:7:  const at = 0;";
    const [p] = placesIn(text);
    expect(text.slice(p.from, p.to)).toBe("src/lib/finding.ts:42:7");
  });

  test("a place with no column is still a place", () => {
    const [p] = placesIn("see src/lib/finding.ts:42 for the reason");
    expect(p).toMatchObject({ path: "src/lib/finding.ts", line: 42, col: null });
  });

  test("an absolute windows path with a drive letter", () => {
    const [p] = placesIn("C:\\atelier\\skein\\src\\lib\\finding.ts:12:1:x");
    expect(p.path).toBe("C:\\atelier\\skein\\src\\lib\\finding.ts");
    expect(p.line).toBe(12);
  });

  test("a bare time is not a place", () => {
    /* The extension guard is the whole of what rules these out, and a false
       positive here is a dead link in the middle of an agent's output. */
    expect(placesIn("finished at 10:30 after 5:12 of work")).toEqual([]);
    expect(placesIn("ratio 3:1, took 90:00")).toEqual([]);
  });

  test("a url is not a place, even though it has a dot and a colon-number", () => {
    /* The path character class includes `/`, so the match can start at the
       scheme — `http://example.com:8080` parses as a path of `http://example.com`
       and a line of 8080 unless the matched text itself is checked. */
    expect(placesIn("serving on http://localhost:1420/ now")).toEqual([]);
    expect(placesIn("see https://example.com:8080/x")).toEqual([]);
  });

  test("a version number is not a place", () => {
    expect(placesIn("ripgrep 15.2.0:1 is installed")).toEqual([]);
  });

  test("a bare filename mentioned in prose is not a place", () => {
    /* The guard that measurement added rather than reasoning: `probe-places.ts`
       over 1,150 real tool results found `RailReplayTests.cpp:282` and dozens
       like it, all of which `insideRoot` then reduced to a root-relative path
       that does not exist — a dead link, which is the one outcome worse than no
       link. A relative candidate has to carry a separator. */
    expect(placesIn("see RailReplayTests.cpp:282 for the assertion")).toEqual([]);
    expect(placesIn("package.json:3 sets it")).toEqual([]);
  });

  test("but a relative path with a directory in it is", () => {
    /* The asymmetry with `insideRoot` is the point: a bare name passed as a
       tool's `file_path` is a path, because something opened it. A bare name in
       a sentence is somebody talking about a file. */
    const [p] = placesIn("see src/lib/finding.ts:42");
    expect(p).toMatchObject({ path: "src/lib/finding.ts", line: 42 });
  });

  test("and an absolute one needs no separator argument at all", () => {
    const [p] = placesIn("C:\\atelier\\skein\\a.ts:9");
    expect(p.line).toBe(9);
  });

  test("prose with no places in it yields none", () => {
    expect(placesIn("")).toEqual([]);
    expect(placesIn("the build succeeded")).toEqual([]);
  });

  test("places come back in the order they occur, so spans can be walked", () => {
    const text = "a/one.ts:1:1:x\nb/two.rs:2:2:y\nc/three.md:3:3:z";
    const found = placesIn(text);
    expect(found.map((p) => p.line)).toEqual([1, 2, 3]);
    for (let i = 1; i < found.length; i++) {
      expect(found[i].from).toBeGreaterThanOrEqual(found[i - 1].to);
    }
  });
});
