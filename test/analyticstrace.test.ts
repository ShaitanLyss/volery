import { describe, expect, test } from "bun:test";

import {
  PROMPT_KINDS,
  TAB_STORE,
  addDays,
  asFavouriteRow,
  asPromptBody,
  asPromptRow,
  asVaultState,
  bodyNote,
  bodyReadable,
  bodyTag,
  bodyTagLabel,
  cardLabel,
  costLabel,
  dayKey,
  dayLabel,
  daysOf,
  effectiveKind,
  filterFavourites,
  filterPrompts,
  forgetSaid,
  groupByDay,
  hallTags,
  hallYears,
  isCorrected,
  lengthLabel,
  noteLabel,
  orderFavourites,
  pageOf,
  percentile,
  projectsOf,
  redactionLabel,
  sealSaid,
  startOfDay,
  statsOf,
  tabFor,
  traceWindow,
  vaultReady,
  type FavouriteRow,
  type PromptRow,
} from "../src/lib/analyticstrace";
import { fixturePromptReader, fixtureWindow } from "../src/lib/analyticsfixture";
import { windowRequest } from "../src/lib/analyticsroom";

/** Local time, so the day arithmetic is tested on the same calendar the code
 *  is written for and a CI machine in another zone still agrees. */
const T = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

function row(over: Partial<PromptRow> = {}): PromptRow {
  return {
    host: "here",
    promptId: "p1",
    at: T(2026, 11, 11, 9),
    hour: T(2026, 11, 11, 9),
    seenCount: 1,
    session: "s1",
    card: "analytics",
    project: "volery",
    source: "card",
    account: "lyss",
    provider: "anthropic",
    vaultId: "v1",
    kind: "task",
    kindOverride: null,
    chars: 120,
    words: 20,
    lines: 2,
    fences: 0,
    codeLines: 0,
    images: 0,
    questions: 0,
    redactions: 0,
    withheld: 0,
    bodyState: "sealed",
    bodyTruncated: 0,
    ...over,
  };
}

function favourite(over: Partial<FavouriteRow> = {}): FavouriteRow {
  return {
    host: "here",
    promptId: "p1",
    title: "one",
    tags: ["nova"],
    createdAt: T(2026, 11, 10, 12),
    at: T(2026, 11, 9, 12),
    project: "volery",
    kind: "design",
    kindOverride: null,
    bodyState: "sealed",
    words: 120,
    cost: 12,
    turns: 4,
    note: null,
    noteLocked: false,
    ...over,
  };
}

const NOW = T(2026, 11, 11, 12);

describe("the trace's days", () => {
  test("a window is seven local days ending now", () => {
    const { from, to } = traceWindow(NOW);
    expect(from).toBe(T(2026, 11, 5));
    expect(to).toBe(NOW + 1);
  });

  /* A day is a calendar day. On a zone with a daylight-saving transition,
     adding a fixed 24 hours moves the wall clock by an hour for the rest of
     the year; `setDate` does not. Noon is used because it exists on every
     transition day in every zone. */
  test("a day is moved on the calendar, not by 24 hours", () => {
    const start = T(2026, 1, 1, 12);
    for (let i = 1; i <= 400; i += 1) {
      expect(new Date(addDays(start, i)).getHours()).toBe(12);
    }
  });

  test("today and yesterday are said as words, the rest as dates", () => {
    expect(dayLabel(dayKey(T(2026, 11, 11, 8)), NOW)).toBe("today");
    expect(dayLabel(dayKey(T(2026, 11, 10, 8)), NOW)).toBe("yesterday");
    expect(dayLabel(dayKey(T(2026, 11, 5, 8)), NOW)).toContain("nov");
  });

  test("rows group by local day, newest day and newest prompt first", () => {
    const rows = [
      row({ promptId: "old", at: T(2026, 11, 5, 8) }),
      row({ promptId: "a", at: T(2026, 11, 11, 9) }),
      row({ promptId: "b", at: T(2026, 11, 11, 10) }),
      row({ promptId: "y", at: T(2026, 11, 10, 23) }),
    ];
    const days = groupByDay(rows, NOW);
    expect(days.map((d) => d.day)).toEqual(["2026-11-11", "2026-11-10", "2026-11-05"]);
    expect(days[0].rows.map((r) => r.promptId)).toEqual(["b", "a"]);
    expect(days[0].label).toBe("today");
    expect(days[0].at).toBe(startOfDay(NOW));
  });

  test("the day choices are newest first and carry their own counts", () => {
    const rows = [
      row({ promptId: "a", at: T(2026, 11, 11, 9) }),
      row({ promptId: "b", at: T(2026, 11, 11, 10) }),
      row({ promptId: "c", at: T(2026, 11, 9, 10) }),
    ];
    expect(daysOf(rows, NOW)).toEqual([
      { day: "2026-11-11", label: "today", n: 2 },
      { day: "2026-11-09", label: "mon 9 nov", n: 1 },
    ]);
  });
});

describe("the filters, which are facts", () => {
  const rows = [
    row({ promptId: "a", kind: "design", project: "volery", at: T(2026, 11, 11, 9) }),
    row({ promptId: "b", kind: "task", kindOverride: "design", project: "nova", at: T(2026, 11, 10, 9) }),
    row({ promptId: "c", kind: "nudge", project: "volery", at: T(2026, 11, 5, 9) }),
  ];

  test("a correction is what the filters and the drawing read", () => {
    expect(effectiveKind(rows[1])).toBe("design");
    expect(isCorrected(rows[1])).toBe(true);
    expect(isCorrected(rows[0])).toBe(false);
    expect(filterPrompts(rows, { kind: "design" }).map((r) => r.promptId)).toEqual(["a", "b"]);
  });

  test("project, day and their intersection", () => {
    expect(filterPrompts(rows, { project: "volery" }).map((r) => r.promptId)).toEqual(["a", "c"]);
    expect(filterPrompts(rows, { day: "2026-11-10" }).map((r) => r.promptId)).toEqual(["b"]);
    expect(filterPrompts(rows, { kind: "design", project: "volery", day: "2026-11-11" }).map((r) => r.promptId)).toEqual([
      "a",
    ]);
    expect(filterPrompts(rows, { kind: "issue" })).toEqual([]);
  });

  test("the project list is the rows' own, sorted", () => {
    expect(projectsOf(rows)).toEqual(["nova", "volery"]);
  });

  test("a kind with no honest answer is still a kind", () => {
    expect(PROMPT_KINDS).toEqual(["design", "redirect", "nudge", "task", "question", "issue", "other"]);
    expect(effectiveKind({ kind: "" })).toBe("other");
  });
});

describe("what a row says", () => {
  test("the card, the session and a terminal", () => {
    expect(cardLabel({ card: "analytics", session: "s1", source: "card" })).toBe("analytics");
    expect(cardLabel({ card: "", session: "abcdefghijkl", source: "card" })).toBe("abcdefgh");
    expect(cardLabel({ card: "", session: "", source: "terminal" })).toBe("terminal");
  });

  test("length says words before characters and never zero", () => {
    expect(lengthLabel({ words: 312, chars: 1800 })).toBe("312 words");
    expect(lengthLabel({ words: 1, chars: 6 })).toBe("1 word");
    expect(lengthLabel({ words: 0, chars: 40 })).toBe("40 chars");
    expect(lengthLabel({ words: 0, chars: 0 })).toBe("no text");
  });

  test("redactions distinguish clean, redacted and withheld", () => {
    expect(redactionLabel({ redactions: 0, withheld: 0 })).toBe("clean");
    expect(redactionLabel({ redactions: 3, withheld: 0 })).toBe("3 redacted");
    expect(redactionLabel({ redactions: 3, withheld: 1 })).toBe("withheld");
  });

  test("every body state has a word, and only sealed reads", () => {
    expect(bodyTag({ bodyState: "sealed" })).toBe("sealed");
    expect(bodyTag({ bodyState: "deleted" })).toBe("deleted");
    expect(bodyTag({ bodyState: "anything else" })).toBe("none");
    expect(bodyTagLabel("deleted")).toBe("forgotten");
    expect(bodyTagLabel("none")).toBe("form only");
    expect(bodyReadable({ bodyState: "sealed" }, true)).toBe(true);
    expect(bodyReadable({ bodyState: "sealed" }, false)).toBe(false);
    expect(bodyReadable({ bodyState: "locked" }, true)).toBe(false);
  });

  test("a note says what state it is in and what would change it", () => {
    expect(bodyNote("locked", false)).toContain("transcript");
    expect(bodyNote("locked", true)).toContain("seal pending");
    expect(bodyNote("withheld", true)).toContain("refused");
    expect(bodyNote("deleted", true)).toContain("forgotten");
    expect(bodyNote("none", false)).toContain("before any body was kept");
  });
});

describe("the strip", () => {
  test("median and p90 are exact percentiles over the rows present", () => {
    const rows = [10, 20, 30].map((words, i) => row({ promptId: `p${i}`, words }));
    expect(percentile([10, 20, 30], 0.5)).toBe(20);
    expect(percentile([10, 20, 30], 0.9)).toBe(30);
    expect(percentile([], 0.5)).toBeNull();
    const stats = statsOf(rows);
    expect(stats.n).toBe(3);
    expect(stats.median).toBe(20);
    expect(stats.p90).toBe(30);
  });

  test("the rates follow kinds and redactions, and an empty window says null", () => {
    const rows = [
      row({ promptId: "a", kind: "redirect", redactions: 2 }),
      row({ promptId: "b", kind: "nudge", kindOverride: "redirect", redactions: 0, withheld: 1 }),
      row({ promptId: "c", kind: "task", redactions: 1 }),
    ];
    const stats = statsOf(rows);
    expect(stats.redirectRate).toBeCloseTo(2 / 3);
    expect(stats.nudgeRate).toBe(0);
    expect(stats.redactionRate).toBeCloseTo(1);
    expect(stats.withheld).toBe(1);

    const empty = statsOf([]);
    expect(empty).toEqual({
      n: 0,
      median: null,
      p90: null,
      redirectRate: null,
      nudgeRate: null,
      redactionRate: null,
      withheld: 0,
      questions: 0,
    });
  });
});

describe("paging a busy day", () => {
  test("a page is bounded, counted and clamped", () => {
    const rows = Array.from({ length: 95 }, (_, i) => row({ promptId: `p${i}` }));
    const first = pageOf(rows, 0);
    expect(first.rows).toHaveLength(40);
    expect(first.pages).toBe(3);
    const last = pageOf(rows, 2);
    expect(last.rows).toHaveLength(15);
    expect(pageOf(rows, 99).page).toBe(2);
    expect(pageOf(rows, -3).page).toBe(0);
    expect(pageOf([], 0)).toEqual({ rows: [], page: 0, pages: 1 });
  });
});

describe("the hall", () => {
  const list = [
    favourite({ promptId: "a", title: "old cheap", createdAt: T(2026, 10, 1), at: T(2026, 9, 1), cost: 5, tags: ["nova"] }),
    favourite({ promptId: "b", title: "new dear", createdAt: T(2026, 11, 1), at: T(2026, 3, 1), cost: 90, tags: ["nova", "rise"], project: "nova", kind: "task" }),
    favourite({ promptId: "c", title: "middle", createdAt: T(2026, 10, 15), at: T(2025, 12, 1), cost: 30, tags: [], project: "rise" }),
  ];

  test("date is when you marked it, and cost is the card's", () => {
    expect(orderFavourites(list, "date").map((f) => f.promptId)).toEqual(["b", "c", "a"]);
    expect(orderFavourites(list, "cost").map((f) => f.promptId)).toEqual(["b", "c", "a"]);
    const cheap = [...list].sort((x, y) => x.cost - y.cost);
    expect(orderFavourites(cheap, "cost").map((f) => f.promptId)).toEqual(["b", "c", "a"]);
  });

  test("equal rows have a total order rather than a shuffle", () => {
    const same = [
      favourite({ promptId: "z", createdAt: 5 }),
      favourite({ promptId: "a", createdAt: 5 }),
    ];
    expect(orderFavourites(same, "date").map((f) => f.promptId)).toEqual(["a", "z"]);
  });

  test("tag, project, kind and year are the gallery's filters", () => {
    expect(filterFavourites(list, { tag: "nova" }).map((f) => f.promptId)).toEqual(["a", "b"]);
    expect(filterFavourites(list, { project: "rise" }).map((f) => f.promptId)).toEqual(["c"]);
    expect(filterFavourites(list, { project: "nova" }).map((f) => f.promptId)).toEqual(["b"]);
    expect(filterFavourites(list, { kind: "task" }).map((f) => f.promptId)).toEqual(["b"]);
    expect(filterFavourites(list, { year: 2026 }).map((f) => f.promptId)).toEqual(["a", "b"]);
    expect(filterFavourites(list, { year: 2025 }).map((f) => f.promptId)).toEqual(["c"]);
  });

  test("the filter lists come from the entries", () => {
    expect(hallTags(list)).toEqual(["nova", "rise"]);
    expect(hallYears(list)).toEqual([2026, 2025]);
  });

  test("a sealed note is said, not hidden", () => {
    expect(noteLabel(favourite({ note: "why it mattered" }))).toBe("why it mattered");
    expect(noteLabel(favourite({ note: null, noteLocked: true }))).toBe("note sealed");
    expect(noteLabel(favourite({ note: null, noteLocked: false }))).toBeNull();
  });

  test("cost reads turns and money, and a card with no turns says so", () => {
    expect(costLabel(favourite({ turns: 4, cost: 12 }))).toBe("4 turns · $12");
    expect(costLabel(favourite({ turns: 0, cost: 0 }))).toBe("no turns recorded");
  });
});

describe("the tab memory", () => {
  test("only the two published words mean anything", () => {
    expect(TAB_STORE).toBe("skein.analytics.tab");
    expect(tabFor("prompts")).toBe("prompts");
    expect(tabFor("spend")).toBe("spend");
    expect(tabFor(null)).toBe("spend");
    expect(tabFor("prompt")).toBe("spend");
  });
});

describe("what comes off the wire", () => {
  test("a row with no identity is dropped rather than drawn nameless", () => {
    expect(asPromptRow({})).toBeNull();
    expect(asPromptRow({ host: "h", promptId: "p", words: "lots" })?.words).toBe(0);
    expect(asPromptRow({ host: "h", promptId: "p", kindOverride: "" })?.kindOverride).toBeNull();
  });

  test("the vault says what it holds and never a key", () => {
    const state = asVaultState({
      vaults: [{ vaultId: "v1", createdAt: 7, unlocked: true }, { nope: true }],
      active: "v1",
      idleMs: 1000,
      bodies: { sealed: 3, locked: 2 },
      locators: 2,
      minPassphrase: 12,
    });
    expect(state.vaults).toHaveLength(1);
    expect(vaultReady(state)).toBe(true);
    expect(vaultReady(asVaultState({ vaults: [{ vaultId: "v", unlocked: false }] }))).toBe(false);
    expect(asVaultState({}).minPassphrase).toBe(12);
  });

  test("a body is text or an absence, never the wrong state", () => {
    expect(asPromptBody({ state: "locked", text: null })).toEqual({ state: "locked", text: null, truncated: false });
    expect(asPromptBody({ state: "sealed", text: "abc", truncated: true }).text).toBe("abc");
  });

  test("a favourite joins its form back", () => {
    const f = asFavouriteRow({
      host: "h",
      promptId: "p",
      title: "t",
      tags: ["a", 3],
      cost: "free",
      noteLocked: true,
    });
    expect(f?.tags).toEqual(["a"]);
    expect(f?.cost).toBe(0);
    expect(f?.noteLocked).toBe(true);
    expect(asFavouriteRow({})).toBeNull();
  });

  test("the two destructive reports are sentences with the numbers in them", () => {
    expect(sealSaid({ sealed: 0, withheld: 0, unresolved: 0, remaining: 0, unresolvedIds: [] })).toContain("nothing");
    expect(sealSaid({ sealed: 12, withheld: 1, unresolved: 2, remaining: 3, unresolvedIds: [] })).toBe(
      "12 sealed · 1 withheld · 2 transcripts gone · 3 still waiting",
    );
    expect(forgetSaid({ bodies: 1, marked: 1, tombstones: 1, favourites: 0 })).toContain("one body");
    expect(forgetSaid({ bodies: 4, marked: 4, tombstones: 4, favourites: 2 })).toContain("2 hall entries");
  });
});

describe("the fixture", () => {
  test("its rows are form only and its bodies are invented", async () => {
    const prompts = fixturePromptReader("normal", "locked");
    const at = Date.now();
    const { from, to } = traceWindow(at);
    const rows = await prompts.facts(from, to);
    expect(rows.length).toBeGreaterThan(20);
    const dumped = JSON.stringify(rows);
    expect(dumped).not.toContain("design the analytics surface so a card");
    expect(dumped).not.toContain("text");

    const sealed = rows.find((r) => r.bodyState === "sealed");
    expect(sealed).toBeDefined();
    const locked = await prompts.body(sealed!.host, sealed!.promptId);
    expect(locked.text).toBeNull();
    expect(locked.state).toBe("locked");

    await prompts.unlockVault("twelve characters!");
    const open = await prompts.body(sealed!.host, sealed!.promptId);
    expect(open.state).toBe("sealed");
    /* One of the fixture's seven invented bodies, never a transcript's. */
    expect(
      [
        "design the analytics surface",
        "no, the other one",
        "continue",
        "add a redaction pass",
        "can you check",
        "the build fails on",
        "one thought",
      ].some((s) => open.text?.includes(s)),
    ).toBe(true);
  });

  test("the vault refuses what the command refuses and changes what it changes", async () => {
    const prompts = fixturePromptReader("normal", "none");
    const state = await prompts.vault();
    expect(state.vaults).toEqual([]);
    await expect(prompts.unlockVault("anything at all")).rejects.toThrow("no vault yet");
    await expect(prompts.createVault("too short")).rejects.toThrow("at least 12 characters");

    const created = await prompts.createVault("twelve characters!");
    expect(created.vaults).toHaveLength(1);
    expect(created.vaults[0].unlocked).toBe(true);

    const sealed = await prompts.sealPending();
    expect(sealed.sealed).toBeGreaterThan(0);
    const forgotten = await prompts.forget();
    expect(forgotten.bodies).toBeGreaterThan(0);

    await prompts.resetVault(true);
    const after = await prompts.vault();
    expect(after.vaults).toEqual([]);
  });

  test("an override moves the kind, and a favourite carries it", async () => {
    const prompts = fixturePromptReader("normal", "unlocked");
    const { from, to } = traceWindow(Date.now());
    const [first] = await prompts.facts(from, to);
    await prompts.overrideKind(first.host, first.promptId, "design");
    const kept = await prompts.keepFavourite({
      host: first.host,
      promptId: first.promptId,
      title: "kept",
      tags: ["Nova", "nova"],
      note: "a note",
    });
    expect(kept.kindOverride).toBe("design");
    expect(kept.note).toBe("a note");
    expect(kept.tags).toEqual(["nova"]);
    expect(await prompts.removeFavourite(first.host, first.promptId)).toBe(true);

    /* The fixture refuses what the command refuses, so a preview review cannot
       pass a title or a tag list the wall would reject. */
    await expect(
      prompts.keepFavourite({
        host: first.host,
        promptId: first.promptId,
        title: "x".repeat(121),
        tags: [],
        note: null,
      }),
    ).rejects.toThrow("120");
    await expect(
      prompts.keepFavourite({
        host: first.host,
        promptId: first.promptId,
        title: "lots of tags",
        tags: Array.from({ length: 13 }, (_, i) => `t${i}`),
        note: null,
      }),
    ).rejects.toThrow("12 tags");
  });

  test("a note needs the vault open", async () => {
    const prompts = fixturePromptReader("normal", "locked");
    const { from, to } = traceWindow(Date.now());
    const [first] = await prompts.facts(from, to);
    await expect(
      prompts.keepFavourite({ host: first.host, promptId: first.promptId, title: "t", tags: [], note: "secret" }),
    ).rejects.toThrow("vault has to be open");
  });

  test("nothing in either fixture reaches for a transcript or Tauri", async () => {
    const source = await Bun.file(new URL("../src/lib/analyticsfixture.ts", import.meta.url)).text();
    expect(source).not.toContain("@tauri-apps");
    expect(source).not.toContain("readFile");
    expect(source).not.toContain("Bun.file");
    /* The window fixture still answers what the room asks, so the extension did
       not change the half that was already reviewed. */
    const win = fixtureWindow(windowRequest("week", T(2026, 11, 11, 12)), "normal");
    expect(win.rows.length).toBeGreaterThan(0);
  });
});
