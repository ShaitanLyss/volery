import { describe, expect, test } from "bun:test";
import {
  emptyBecause,
  FOLLOW,
  linesFor,
  subjectOf,
  tail,
  type Row,
} from "../src/lib/logface";

/* The substrate under all three log widgets, tested on a subject that is
   nothing in particular — which is the point of it. What a dev server group, a
   build and an editor log have in common is exactly this much, and every
   assertion below was learned about one of the three and then found to be true
   of the others. */

type Thing = { id: string; busy: boolean; at: number };
const thing = (id: string, busy = false, at = 0): Thing => ({ id, busy, at });
const isBusy = (t: Thing) => t.busy;
const when = (t: Thing) => t.at;

/* ── which one a widget is about ───────────────────────────────────────── */

describe("a log names its subject or says why it has none", () => {
  test("a wall with nothing on it is an absence, not a blank pane", () => {
    expect(subjectOf(FOLLOW, [])).toEqual({ it: null, because: "none" });
  });

  test("following settles on whatever is working", () => {
    expect(subjectOf(FOLLOW, [thing("a"), thing("b", true)], isBusy)).toEqual({
      it: thing("b", true),
    });
  });

  /* A wall where nothing has ever worked still has one honest answer, and
     whatever button that subject offers under it. Returning nothing here would
     make the widget useless precisely when it is most wanted. */
  test("following falls back to the first when nothing has ever worked", () => {
    expect(subjectOf(FOLLOW, [thing("a"), thing("b")], isBusy).it?.id).toBe("a");
  });

  /* Sink f2cce1c8, which is this function's bug rather than the build log's. A
     build log follows a project through its compile; the instant the compile
     ends nothing is live, and taking `all[0]` handed the widget whichever
     project sorts first — typically one that has never built anything, whose
     face is the words "this project has nothing to build". The reading was
     thrown away at the exact moment it was finally complete. */
  test("following stays on what worked last, rather than on what sorts first", () => {
    const all = [thing("a"), thing("b", false, 1_700)];
    expect(subjectOf(FOLLOW, all, isBusy, when).it?.id).toBe("b");
  });

  test("something working still beats something that merely did", () => {
    const all = [thing("a", true), thing("b", false, 9_999)];
    expect(subjectOf(FOLLOW, all, isBusy, when).it?.id).toBe("a");
  });

  test("the most recent of several that have finished", () => {
    const all = [thing("a", false, 300), thing("b", false, 900), thing("c", false, 40)];
    expect(subjectOf(FOLLOW, all, isBusy, when).it?.id).toBe("b");
  });

  /* Zero is "never", not "long ago", or a wall where nothing has run would rank
     its projects by the accident of a falsy timestamp. */
  test("a subject that has never worked cannot win the fallback", () => {
    const all = [thing("a"), thing("b")];
    expect(subjectOf(FOLLOW, all, isBusy, when).it?.id).toBe("a");
  });

  test("subjects that tie keep the order the caller listed them in", () => {
    const all = [thing("a", false, 500), thing("b", false, 500)];
    expect(subjectOf(FOLLOW, all, isBusy, when).it?.id).toBe("a");
  });

  /* Pinning is pinning. A subject you named is not a race the most recent thing
     on the wall can win. */
  test("a pinned subject is not overruled by a more recent one", () => {
    const all = [thing("a"), thing("b", false, 9_999)];
    expect(subjectOf("a", all, isBusy, when).it?.id).toBe("a");
  });

  /* No predicate at all is a legitimate subject — one where "whichever is
     running" has no meaning — and it takes the first rather than throwing. */
  test("a subject with no notion of working still resolves", () => {
    expect(subjectOf(FOLLOW, [thing("a"), thing("b")]).it?.id).toBe("a");
  });

  test("a pinned subject is shown even while another one is the busy one", () => {
    expect(subjectOf("a", [thing("a"), thing("b", true)], isBusy).it?.id).toBe("a");
  });

  /* The one thing that must not be papered over: a widget pinned to something
     that has been deleted must not quietly start showing somebody else's
     output. The lines would be another subject's and nothing on the face would
     say so. */
  test("a subject that is not on the wall any more is said, not substituted", () => {
    expect(subjectOf("gone", [thing("a")])).toEqual({ it: null, because: "gone" });
  });

  test("a config with nothing written in it follows, the way a fresh one does", () => {
    expect(subjectOf("", [thing("a")]).it?.id).toBe("a");
  });
});

/* ── what it shows ─────────────────────────────────────────────────────── */

describe("the tail, and what a filter keeps back", () => {
  const log = ["one", "TWO", "three"];
  const shouty = (l: string) => l === l.toUpperCase();

  test("everything, in the order it arrived", () => {
    expect(tail(log, null, 10).lines).toEqual(["one", "TWO", "three"]);
  });

  test("only what the predicate keeps, when one is given", () => {
    expect(tail(log, shouty, 10).lines).toEqual(["TWO"]);
  });

  /* An empty pane that cannot say why reads as a widget that has broken. A
     problems-only reading of a build that printed two hundred clean lines is
     legitimately empty, and owes that sentence. */
  test("what the filter dropped is counted, so an empty pane can explain itself", () => {
    expect(tail(log, shouty, 10).hidden).toBe(2);
    expect(tail(log, null, 10).hidden).toBe(0);
  });

  /* Anchored to the newest, which is the whole point of a log on a wall: a
     widget that showed the first four lines a server ever printed would be a
     picture of its launch. */
  test("the tail is the end of the log, not the start of it", () => {
    const long = Array.from({ length: 50 }, (_, i) => `l${i}`);
    const cut = tail(long, null, 4);
    expect(cut.lines).toEqual(["l46", "l47", "l48", "l49"]);
  });

  /* What did not fit needs no apology — it is simply older, and a taller widget
     shows more of it. Only the filter's omissions are a thing the face has to
     say out loud. */
  test("lines that did not fit are not counted as hidden", () => {
    const long = Array.from({ length: 50 }, (_, i) => `l${i}`);
    expect(tail(long, null, 4).hidden).toBe(0);
  });

  /* Generic over the line, because the three subjects hold three different
     ones. Nothing in `tail` may assume a shape. */
  test("it keeps whatever kind of line it was handed", () => {
    const rows: Row[] = [
      { mark: "web", tone: "plain", text: "up" },
      { mark: null, tone: "fail", text: "error C2065:" },
    ];
    const cut = tail(rows, (r) => r.tone === "fail", 10);
    expect(cut.lines).toEqual([rows[1]]);
    expect(cut.hidden).toBe(1);
  });

  /* The box you drag it to is the setting — and here that is load-bearing
     rather than tasteful: the wheel zooms the wall, so a pane on it cannot be
     scrolled, and a widget that overflowed would hide its newest lines behind a
     scrollbar nothing could move. */
  test("a taller log shows more of it, and the shortest still shows one", () => {
    expect(linesFor(300)).toBeGreaterThan(linesFor(150));
    expect(linesFor(90)).toBeGreaterThanOrEqual(1);
    expect(linesFor(0)).toBe(1);
  });
});

describe("a pane a filter emptied says so", () => {
  test("the count, and what it was dropped for, in the subject's own words", () => {
    expect(emptyBecause(3, "on stderr")).toBe(
      "nothing on stderr — 3 lines filtered out",
    );
  });

  /* One line is one line. Nothing here is worth a plural bug on the face of an
     instrument. */
  test("one dropped line is not lines", () => {
    expect(emptyBecause(1, "wrong")).toBe("nothing wrong — 1 line filtered out");
  });

  /* Nothing dropped is a genuinely-empty log, which reads differently: it has
     said nothing yet, and no apology is owed. The caller falls through to its
     own sentence. */
  test("nothing dropped is not this sentence at all", () => {
    expect(emptyBecause(0, "wrong")).toBeNull();
    expect(emptyBecause(-1, "wrong")).toBeNull();
  });
});
