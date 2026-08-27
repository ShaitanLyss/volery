import { describe, expect, test } from "bun:test";
import {
  NOTHING_HELD,
  TAIL_LINES,
  UNREAD,
  absence,
  drawerCap,
  fold,
  jobCap,
  missing,
  rowsOf,
  size,
  type Chunk,
  type Held,
} from "../src/lib/jobs";

/** A chunk as `joblog::read_from` hands one back. */
const chunk = (at: number, text: string): Chunk => ({ at, text, next: at + text.length });

/** Fold a sequence of chunks, the way a pane does across ticks. */
const run = (...cs: Chunk[]): Held => cs.reduce((h, c) => fold(h, c), NOTHING_HELD);

describe("following a file that is still being written", () => {
  test("a first read that starts at 0 keeps its first line", () => {
    const h = run(chunk(0, "one\ntwo\n"));
    expect(h.lines).toEqual(["one", "two"]);
    expect(h.partial).toBe("");
    expect(h.next).toBe(8);
    expect(h.skipped).toBe(0);
  });

  test("a continuous second read is appended", () => {
    const h = run(chunk(0, "one\n"), chunk(4, "two\n"));
    expect(h.lines).toEqual(["one", "two"]);
  });

  test("a line still being written is held back rather than drawn twice", () => {
    /* The whole reason `partial` is a field. A progress line arriving in three
       writes must be one row that changes, not three rows. */
    const a = run(chunk(0, "wor"));
    expect(a.lines).toEqual([]);
    expect(a.partial).toBe("wor");

    const b = fold(a, chunk(3, "king"));
    expect(b.lines).toEqual([]);
    expect(b.partial).toBe("working");

    const c = fold(b, chunk(7, "\ndone\n"));
    expect(c.lines).toEqual(["working", "done"]);
    expect(c.partial).toBe("");
  });

  test("nothing new leaves everything exactly as it was", () => {
    /* What a second tick finds nearly every time, and it must not disturb the
       pane — an empty chunk that reset the partial would make a half-written
       line flicker once a second. */
    const a = run(chunk(0, "one\nhal"));
    const b = fold(a, chunk(7, ""));
    expect(b.lines).toEqual(["one"]);
    expect(b.partial).toBe("hal");
    expect(b.next).toBe(7);
  });

  test("carriage returns are taken off the ends of lines", () => {
    /* The two ends of a pipe on Windows do not reliably agree, and a log with
       mixed endings must not draw half its rows with a stray glyph. */
    expect(run(chunk(0, "one\r\ntwo\n")).lines).toEqual(["one", "two"]);
  });
});

describe("opening a log that is already large", () => {
  test("a read that starts mid-file drops its first, partial line", () => {
    /* `joblog::read_from` seeks backwards from the end on the first read, so
       what arrives begins in the middle of a line. Keeping it opens the pane on
       a fragment, which reads as corruption rather than as a tail. */
    const h = run(chunk(5_000, "f a line\nwhole\n"));
    expect(h.lines).toEqual(["whole"]);
    expect(h.partial).toBe("");
  });

  test("and says how much it never showed", () => {
    const h = run(chunk(5_000, "f a line\nwhole\n"));
    expect(h.skipped).toBe(5_000);
    expect(missing(h)).toBe("4.9 KB earlier isn't shown — opened at the end");
  });

  test("a mid-file chunk with no newline at all is kept as nothing", () => {
    /* Not even as a partial: gluing the next chunk onto half a line would
       produce a row that is two fragments of different lines. */
    const h = run(chunk(5_000, "no newline here"));
    expect(h.lines).toEqual([]);
    expect(h.partial).toBe("");
  });

  test("a pane that saw the whole file apologises for nothing", () => {
    expect(missing(run(chunk(0, "one\n")))).toBeNull();
  });
});

describe("when continuity breaks", () => {
  test("a file that was truncated is not spliced onto what is held", () => {
    /* The failure this prevents: a pane showing two halves of different minutes
       glued at a line boundary, with nothing saying so. */
    const a = run(chunk(9_000, "x\nold tail\n"));
    const b = fold(a, chunk(0, "fresh\n"));
    expect(b.lines).toEqual(["fresh"]);
    expect(b.next).toBe(6);
  });

  test("a burst bigger than one read drops what it stepped over, and says so", () => {
    const a = run(chunk(0, "one\n"));
    /* `joblog` took the newest window rather than the oldest, so `at` is past
       where we stopped. */
    const b = fold(a, chunk(900_004, "z\nnewest\n"));
    expect(b.lines).toEqual(["newest"]);
    expect(b.skipped).toBe(900_000);
    expect(missing(b)).not.toBeNull();
  });

  test("skipping is cumulative across breaks", () => {
    const a = fold(NOTHING_HELD, chunk(100, "x\na\n"));
    const b = fold(a, chunk(1_100, "y\nb\n"));
    expect(b.skipped).toBe(100 + (1_100 - 104));
  });
});

describe("the bound on what is held", () => {
  test("only the last lines are kept, and the cap is the pane's own", () => {
    const many = Array.from({ length: TAIL_LINES + 50 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const h = run(chunk(0, many));
    expect(h.lines.length).toBe(TAIL_LINES);
    expect(h.lines[0]).toBe("line 50");
    expect(h.lines.at(-1)).toBe(`line ${TAIL_LINES + 49}`);
  });

  test("the cap holds across many small appends, not only one big one", () => {
    /* The leak this bounds is a dev server printing all day, which arrives a
       line at a time rather than in one chunk. */
    let h = NOTHING_HELD;
    for (let i = 0; i < TAIL_LINES + 20; i++) h = fold(h, chunk(h.next < 0 ? 0 : h.next, `l${i}\n`));
    expect(h.lines.length).toBe(TAIL_LINES);
    expect(h.lines.at(-1)).toBe(`l${TAIL_LINES + 19}`);
  });
});

describe("what the pane draws", () => {
  test("a line still being written is drawn as an ordinary row", () => {
    /* From the reader's side it is a line; it is held apart only so it can be
       replaced rather than appended to as it grows. */
    const rows = rowsOf(run(chunk(0, "done\nhalf")));
    expect(rows.map((r) => r.text)).toEqual(["done", "half"]);
  });

  test("problems take a tone, and the tone is buildlog's", () => {
    /* Not a fourth copy of the same judgement: what a backgrounded command is,
       nearly always, is a build, a test run or a server. */
    const rows = rowsOf(run(chunk(0, "ok\nerror: nope\nwarning: hm\n")));
    expect(rows.map((r) => r.tone)).toEqual(["plain", "fail", "warn"]);
  });

  test("no row carries a gutter mark", () => {
    /* Every line here came down one pipe from one command, so a mark naming its
       source would name the same thing four hundred times. */
    expect(rowsOf(run(chunk(0, "a\nb\n"))).every((r) => r.mark === null)).toBe(true);
  });
});

describe("the words", () => {
  test("a size is readable at every scale a log reaches", () => {
    expect(size(512)).toBe("512 B");
    expect(size(1024)).toBe("1.0 KB");
    expect(size(5_000)).toBe("4.9 KB");
    expect(size(20 * 1024 * 1024)).toBe("20 MB");
    /* A log that has run to gigabytes is a real thing to be told about, and
       "3072.0 MB" reads as an instrument that has lost its footing. */
    expect(size(3 * 1024 ** 3)).toBe("3.0 GB");
  });

  test("a job's cap carries the age, which is the point of the row", () => {
    /* Ninety seconds is a command; four hours is a dev server somebody has
       forgotten about. */
    const now = 1_000_000_000;
    const cap = jobCap({ label: "pnpm dev", kind: "command", since: now - 4 * 3600 * 1000 }, now);
    expect(cap).toContain("pnpm dev");
    expect(cap).toContain("command");
    expect(cap).toMatch(/4h/);
  });

  test("the drawer says what the work is rather than counting it", () => {
    /* The count is what the card's hollow ring already draws; a second copy of
       it would be furniture. */
    expect(drawerCap([])).toBe("no background work");
    expect(drawerCap([{ label: "pnpm dev" }])).toBe("pnpm dev — running in the background");
    expect(drawerCap([{ label: "a" }, { label: "b" }])).toBe("2 background jobs — a, b");
  });

  test("the four absences are four different things to say", () => {
    const said = (["waiting", "empty", "nofile", "unreadable"] as const).map(absence);
    expect(new Set(said).size).toBe(4);
    /* The one worth being careful about: a derived path that is not there must
       read as the file being missing, not as a silent process. */
    expect(absence("nofile")).not.toBe(absence("empty"));
    expect(absence("empty")).toContain("printed nothing");
  });
});

describe("the wire format's two halves agree", () => {
  test("UNREAD is not a real offset", () => {
    /* Conflating it with 0 is how a re-opened pane read a 40 MB dev-server log
       from the beginning and showed the morning's banner as though it were now.
       `joblog::UNREAD` is the same value on the Rust side. */
    expect(UNREAD).toBe(-1);
    expect(NOTHING_HELD.next).toBe(UNREAD);
  });

  test("a first chunk at 0 is contiguous with nothing held, and keeps its head", () => {
    /* `fold` compares `got.at` against `held.next`, which is UNREAD here — so
       the first chunk is always a break, and the `at > 0` test is what decides
       whether its first line survives. A short file read whole must keep it. */
    expect(run(chunk(0, "first\n")).lines).toEqual(["first"]);
  });
});
