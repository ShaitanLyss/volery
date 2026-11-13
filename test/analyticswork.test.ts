import { describe, expect, test } from "bun:test";

import {
  ARTIFACT_KINDS,
  CHURN_GAP_MS,
  CONFLICT_CAP_MS,
  INVALIDATE_ADVICE,
  WORK_CAVEAT,
  asInvalidateRows,
  asOverlaps,
  asWorkRows,
  asWorkSeries,
  bandsOf,
  barsOf,
  ATTRIBUTE_WAIT_MS,
  attributedUsd,
  attributeWaitSaid,
  cacheWriteUsd,
  cardWorkOf,
  conflictEpisodes,
  coordinationOf,
  inputUsd,
  invalidateKey,
  invalidationOf,
  kpisOf,
  panelsOf,
  ratioText,
  scatterOf,
  scatterTicks,
  signed,
  spendOfRow,
  workSpanFor,
  unionSpans,
  workModelOf,
  workStoryState,
  type CardSpendRow,
  type CardWork,
  type InvalidateRow,
  type PairOverlap,
  type WorkRow,
  type WorkSeries,
} from "../src/lib/analyticswork";
import { modeledUsd } from "../src/lib/analytics";
import { fixtureWork } from "../src/lib/analyticsfixture";
import { count, money } from "../src/lib/usage";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 2, 9, 0, 0);

/** The Rust constant the TypeScript wait mirrors, read from source.
 *
 *  `analyticswork.ts::ATTRIBUTE_WAIT_MS` exists only so the copy can name the
 *  bound; the fact is `analytics.rs`'s. A change there that does not reach the
 *  copy would make the page state a wait the store does not use, silently, so
 *  this reads both and follows the alias. The regex slices on `;` and never on
 *  a brace, and line endings do not enter into it: CI checks this out with
 *  CRLF. */
const analyticsRs = await Bun.file(new URL("../src-tauri/src/analytics.rs", import.meta.url)).text();

function rustConst(name: string): string {
  const found = analyticsRs.match(new RegExp(`const\\s+${name}\\s*:\\s*i64\\s*=\\s*([^;]+);`));
  if (!found) throw new Error(`${name} is not in src-tauri/src/analytics.rs`);
  return found[1].trim();
}

/** The product a constant is spelled as (`6 * 60 * 60 * 1000`), without eval. */
function rustProduct(expr: string): number {
  return expr.split("*").reduce((n, part) => {
    const value = Number(part.trim());
    if (!Number.isFinite(value)) throw new Error(`cannot read the constant ${expr}`);
    return n * value;
  }, 1);
}

function work(over: Partial<WorkRow> & Pick<WorkRow, "at" | "kind">): WorkRow {
  return {
    host: "here",
    session: "s1",
    card: "c1",
    agent: "",
    ref: `r${over.at}`,
    branch: "main",
    project: "volery",
    files: 0,
    added: 0,
    removed: 0,
    conflictFiles: 0,
    ms: 0,
    provenance: "receipt",
    ...over,
  };
}

function emptySeries(): WorkSeries {
  return { hourly: [], spend: [], sessions: [] };
}

function spend(over: Partial<CardSpendRow> = {}): CardSpendRow {
  return {
    card: "c1",
    hour: T0,
    account: "lyss",
    model: "claude-opus-5-5",
    provenance: "transcript",
    inTok: 60_000,
    outTok: 24_000,
    cacheRead: 1_200_000,
    write5m: 0,
    write1h: 0,
    requests: 8,
    usdReported: 0,
    ...over,
  };
}

/* ── a conflict is an episode (§3.9) ───────────────────────────────────────*/

describe("a conflict row opens an episode, and the branch closes it", () => {
  test("the next commit on the branch ends it", () => {
    const rows = [
      work({ at: T0, kind: "conflict", ms: 90_000, conflictFiles: 3, branch: "main" }),
      work({ at: T0 + 12 * MINUTE, kind: "commit", branch: "main" }),
    ];
    const [episode] = conflictEpisodes(rows);
    expect(episode.minutes).toBe(12);
    expect(episode.start).toBe(T0);
    expect(episode.end).toBe(T0 + 12 * MINUTE);
    expect(episode.closedBy).toBe("commit");
    expect(episode.closedAt).toBe(T0 + 12 * MINUTE);
    expect(episode.files).toBe(3);
    expect(episode.latencyMs).toBe(90_000);
  });

  test("the next merge ends it too", () => {
    const rows = [
      work({ at: T0, kind: "conflict", branch: "release" }),
      work({ at: T0 + 4 * MINUTE, kind: "merge", branch: "release" }),
    ];
    const [episode] = conflictEpisodes(rows);
    expect(episode.minutes).toBe(4);
    expect(episode.closedBy).toBe("merge");
  });

  test("a commit on another branch does not close it", () => {
    const rows = [
      work({ at: T0, kind: "conflict", branch: "feature" }),
      work({ at: T0 + 2 * MINUTE, kind: "commit", branch: "main" }),
      work({ at: T0 + 8 * MINUTE, kind: "commit", branch: "feature" }),
    ];
    const [episode] = conflictEpisodes(rows);
    expect(episode.closedBy).toBe("commit");
    expect(episode.minutes).toBe(8);
  });

  test("an artifact that lands past the cap does not stretch it", () => {
    const rows = [
      work({ at: T0, kind: "conflict", branch: "main" }),
      work({ at: T0 + 40 * MINUTE, kind: "commit", branch: "main" }),
    ];
    const [episode] = conflictEpisodes(rows);
    expect(episode.minutes).toBe(30);
    expect(episode.closedBy).toBe("cap");
    expect(episode.closedAt).toBe(null);
  });

  test("a conflict nothing resolves runs to the cap, and says so", () => {
    const rows = [work({ at: T0, kind: "conflict", branch: "import" })];
    const [episode] = conflictEpisodes(rows);
    expect(episode.minutes).toBe(30);
    expect(episode.closedBy).toBe("cap");
    expect(episode.closedAt).toBe(null);
    expect(CONFLICT_CAP_MS).toBe(30 * MINUTE);
  });

  test("a command blocked longer than the resolution span keeps its latency", () => {
    const rows = [
      work({ at: T0, kind: "conflict", branch: "main", ms: 6 * MINUTE }),
      work({ at: T0 + 2 * MINUTE, kind: "commit", branch: "main" }),
    ];
    const [episode] = conflictEpisodes(rows);
    expect(episode.minutes).toBe(6);
    expect(episode.end).toBe(T0 + 6 * MINUTE);
  });

  test("a commit in another project on the same branch does not close it", () => {
    /* Two territories both on `main` are ordinary, and one tree's commit is
       not another tree's resolution. */
    const rows = [
      work({ at: T0, kind: "conflict", branch: "main", project: "volery" }),
      work({ at: T0 + 3 * MINUTE, kind: "commit", branch: "main", project: "nova" }),
    ];
    const [episode] = conflictEpisodes(rows);
    expect(episode.closedBy).toBe("cap");
    expect(episode.minutes).toBe(30);
  });

  test("two conflicts in one unresolved stretch are one episode", () => {
    /* An aborted merge and then a rebase: two receipts, one outage. Summing
       them would count the same minutes twice. */
    const rows = [
      work({ at: T0, kind: "conflict", branch: "main" }),
      work({ at: T0 + 5 * MINUTE, kind: "conflict", branch: "main" }),
      work({ at: T0 + 10 * MINUTE, kind: "commit", branch: "main" }),
    ];
    const episodes = conflictEpisodes(rows);
    expect(episodes.length).toBe(1);
    expect(episodes[0].minutes).toBe(10);
    expect(episodes[0].closedBy).toBe("commit");
  });

  test("each conflict is its own episode, in time order", () => {
    const rows = [
      work({ at: T0 + 20 * MINUTE, kind: "conflict", branch: "b" }),
      work({ at: T0, kind: "conflict", branch: "a" }),
      work({ at: T0 + 5 * MINUTE, kind: "commit", branch: "a" }),
    ];
    const episodes = conflictEpisodes(rows);
    expect(episodes.map((e) => e.branch)).toEqual(["a", "b"]);
    expect(episodes[0].minutes).toBe(5);
    expect(episodes[1].minutes).toBe(30);
  });
});

/* ── per-card totals and the null ratios ───────────────────────────────────*/

describe("a card's totals, and the ratios it may not have", () => {
  const rows = [
    work({ at: T0, card: "c1", kind: "commit", added: 100, removed: 20, files: 2 }),
    work({ at: T0 + HOUR, card: "c1", kind: "commit", added: 50, removed: 10, files: 1, provenance: "history" }),
    work({ at: T0 + 2 * HOUR, card: "c1", kind: "pr_merge", provenance: "history" }),
    work({ at: T0 + 3 * HOUR, card: "c1", kind: "push" }),
    work({ at: T0, card: "c2", kind: "commit", added: 40, removed: 0 }),
  ];

  test("lines, churn, commits and their provenance", () => {
    const series = { ...emptySeries(), spend: [spend({ card: "c1" }), spend({ card: "c2" })] };
    const [one, two] = cardWorkOf({ rows, series, from: T0, to: T0 + DAY });
    expect(one.card).toBe("c1");
    expect(one.commits).toBe(2);
    expect(one.attributedCommits).toBe(1);
    expect(one.merged).toBe(1);
    expect(one.attributedMerges).toBe(1);
    expect(one.pushes).toBe(1);
    expect(one.artifacts).toBe(4);
    expect(one.noArtifact).toBe(false);
    expect(one.added).toBe(150);
    expect(one.removed).toBe(30);
    expect(one.net).toBe(120);
    expect(one.churn).toBe(180);
    expect(two.commits).toBe(1);
  });

  test("a card with no merge has no cost per merge, and it is null, not zero", () => {
    const series = {
      ...emptySeries(),
      spend: [spend({ card: "c1" }), spend({ card: "c2" })],
      sessions: [
        { session: "s1", host: "here", card: "c1", project: "volery", source: "card", startedAt: T0, endedAt: T0 + 3 * HOUR },
        { session: "s2", host: "here", card: "c2", project: "volery", source: "card", startedAt: T0, endedAt: T0 + 2 * HOUR },
      ],
    };
    const [one, two] = cardWorkOf({ rows, series, from: T0, to: T0 + DAY });
    expect(one.costPerMerged).toBeGreaterThan(0);
    expect(two.merged).toBe(0);
    expect(two.costPerMerged).toBe(null);
    expect(ratioText(two.costPerMerged, money)).toBe("");
    expect(one.costPerCommit).toBeGreaterThan(0);
    expect(two.costPerCommit).toBeGreaterThan(0);
  });

  test("a card with spend and no artifact is marked, and is not a zero", () => {
    const series = {
      ...emptySeries(),
      spend: [spend({ card: "design" })],
      sessions: [
        { session: "s9", host: "here", card: "design", project: "nova", source: "card", startedAt: T0, endedAt: T0 + 2 * HOUR },
      ],
    };
    const [card] = cardWorkOf({ rows: [], series, from: T0, to: T0 + DAY });
    expect(card.card).toBe("design");
    expect(card.noArtifact).toBe(true);
    expect(card.artifacts).toBe(0);
    expect(card.cost).toBeGreaterThan(0);
    expect(card.costPerCommit).toBe(null);
    expect(card.costPerMerged).toBe(null);
    expect(card.burnUsdPerHour).toBeGreaterThan(0);
  });

  test("no spend attributed is null, and unpriced spend is not free", () => {
    const unpriced = spend({ card: "c1", model: "a-model-with-no-rate", account: "lyss" });
    const series = { ...emptySeries(), spend: [unpriced] };
    const [card] = cardWorkOf({ rows: [], series, from: T0, to: T0 + DAY });
    expect(card.cost).toBe(null);
    expect(card.unpriced).toBe(1);
    expect(spendOfRow(unpriced)).toBe(null);
  });

  test("the reported figure wins for a turn row on a sentinel account", () => {
    const row = spend({ card: "c1", account: "@deepseek", provenance: "turn", usdReported: 1.25 });
    expect(spendOfRow(row)).toBe(1.25);
    /* A zero reported figure is not a measurement, so it falls through to
       pricing, which cannot price a sentinel: null, not free. */
    expect(spendOfRow({ ...row, usdReported: 0 })).toBe(null);
  });

  test("the session intervals are the active time, and a card with none has no burn", () => {
    const series = {
      ...emptySeries(),
      spend: [spend({ card: "c1" })],
      sessions: [
        { session: "s1", host: "here", card: "c1", project: "volery", source: "card", startedAt: T0, endedAt: T0 + HOUR },
        { session: "s1", host: "here", card: "c1", project: "volery", source: "card", startedAt: T0 + 2 * HOUR, endedAt: T0 + 3 * HOUR },
      ],
    };
    const [card] = cardWorkOf({ rows: [], series, from: T0, to: T0 + DAY });
    expect(card.activeMs).toBe(2 * HOUR);
    const [alone] = cardWorkOf({ rows: [], series: { ...emptySeries(), spend: [spend({ card: "c1" })] }, from: T0, to: T0 + DAY });
    expect(alone.activeMs).toBe(0);
    expect(alone.burnUsdPerHour).toBe(null);
  });
});

/* ── the scatter ───────────────────────────────────────────────────────────*/

describe("a net figure keeps its sign, and the axis has no repeated label", () => {
  test("`count` folds a negative to zero, so a signed helper is the only way", () => {
    expect(count(-40)).toBe("0");
    expect(signed(-40)).toBe("-40");
    expect(signed(0)).toBe("+0");
    expect(signed(1200)).toBe(`+${count(1200)}`);
  });

  test("a cleanup card's net is said as a negative, not as zero", () => {
    const rows = [work({ at: T0, kind: "commit", card: "c1", added: 10, removed: 50 })];
    const model = modelOf(rows, { ...emptySeries(), spend: [spend({ card: "c1" })] });
    expect(model.kpis.net).toBe(-40);
    expect(model.story.lede).toContain("-40 net lines");
    expect(model.story.facts.find((f) => f.label === "net lines")?.value).toBe("-40");
    expect(model.cards[0].net).toBe(-40);
  });

  test("every card on zero merges gives two distinct ticks, never 0, 1, 1", () => {
    const ticks = scatterTicks(0, 0, "merged");
    expect(ticks).toEqual([0, 1]);
    expect(new Set(ticks).size).toBe(ticks.length);
    expect(scatterTicks(0, 4, "merged")).toEqual([0, 2, 4]);
    expect(new Set(scatterTicks(0, 0, "net")).size).toBe(2);
  });

  test("a span past the fine tier's keep is made answerable", () => {
    expect(workSpanFor("1y", 365 * DAY)).toBe("90d");
    expect(workSpanFor("30d", 30 * DAY)).toBe("30d");
    expect(workSpanFor("90d", 90 * DAY)).toBe("90d");
    expect(workSpanFor("7d", 7 * DAY)).toBe("7d");
  });
});

describe("the scatter places only what it can", () => {
  const cards = [
    {
      card: "a",
      label: "a",
      project: "volery",
      cost: 100,
      merged: 4,
      net: 900,
      noArtifact: false,
    },
    {
      card: "b",
      label: "b",
      project: "nova",
      cost: 60,
      merged: 0,
      net: -40,
      noArtifact: false,
    },
    {
      card: "design",
      label: "design",
      project: "nova",
      cost: 40,
      merged: 0,
      net: 0,
      noArtifact: true,
    },
    {
      card: "nowhere",
      label: "nowhere",
      project: "rise",
      cost: null,
      merged: 2,
      net: 10,
      noArtifact: false,
    },
  ] as unknown as CardWork[];

  test("x is cost and y is the chosen measure", () => {
    const merged = scatterOf(cards, "merged");
    expect(merged.points.map((p) => [p.card, p.cost, p.y])).toEqual([
      ["a", 100, 4],
      ["b", 60, 0],
      ["design", 40, 0],
    ]);
    const net = scatterOf(cards, "net");
    expect(net.points.find((p) => p.card === "b")?.y).toBe(-40);
  });

  test("a card with no cost is counted, never drawn at zero", () => {
    const scatter = scatterOf(cards, "merged");
    expect(scatter.points.some((p) => p.card === "nowhere")).toBe(false);
    expect(scatter.omitted).toBe(1);
    expect(scatter.points.find((p) => p.card === "design")?.noArtifact).toBe(true);
  });
});

/* ── coordination ──────────────────────────────────────────────────────────*/

describe("conflict minutes times the card's own burn", () => {
  const cards = [
    { card: "a", burnUsdPerHour: 10, cost: 20 },
    { card: "b", burnUsdPerHour: null, cost: null },
  ] as unknown as CardWork[];
  const episodes = conflictEpisodes([
    work({ at: T0, card: "a", kind: "conflict", branch: "main" }),
    work({ at: T0 + 12 * MINUTE, card: "a", kind: "commit", branch: "main" }),
    work({ at: T0 + 2 * HOUR, card: "b", kind: "conflict", branch: "import" }),
  ]);

  test("the dollars are the minutes over the hour times the burn", () => {
    const coordination = coordinationOf(episodes, cards);
    expect(coordination.conflictMinutes).toBe(42);
    expect(coordination.pricedMinutes).toBe(12);
    expect(coordination.unpricedMinutes).toBe(30);
    expect(coordination.coordinationUsd).toBeCloseTo(2, 10);
    expect(coordination.byCard.get("a")).toBeCloseTo(2, 10);
    expect(coordination.byCard.get("b")).toBe(null);
  });

  test("nothing priced is null, not zero", () => {
    const coordination = coordinationOf(
      conflictEpisodes([work({ at: T0, card: "b", kind: "conflict" })]),
      cards,
    );
    expect(coordination.coordinationUsd).toBe(null);
    expect(coordination.conflictMinutes).toBe(30);
    expect(coordination.unpricedMinutes).toBe(30);
  });

  test("no conflict at all is zero minutes and no dollars", () => {
    const coordination = coordinationOf([], cards);
    expect(coordination.conflictMinutes).toBe(0);
    expect(coordination.coordinationUsd).toBe(null);
  });
});

/* ── the panels and the gaps ───────────────────────────────────────────────*/

describe("the two panels keep their own scales and their gaps", () => {
  test("an hour with no reading is absent from the points, not zero", () => {
    const series: WorkSeries = {
      ...emptySeries(),
      spend: [spend({ hour: T0 }), spend({ hour: T0 + 3 * HOUR })],
      hourly: [
        { hour: T0, host: "here", project: "volery", branch: "main", kind: "commit", count: 2, files: 1, added: 3, removed: 0, conflictMs: 0 },
        { hour: T0 + 2 * HOUR, host: "here", project: "volery", branch: "main", kind: "conflict", count: 1, files: 0, added: 0, removed: 0, conflictMs: 60_000 },
      ],
    };
    const panels = panelsOf(series);
    expect(panels.cost.map((p) => p.at)).toEqual([T0, T0 + 3 * HOUR]);
    expect(panels.artifacts.map((p) => p.at)).toEqual([T0]);
    expect(ARTIFACT_KINDS).not.toContain("conflict");
  });

  test("an unpriced card-hour is counted and contributes no bar", () => {
    const panels = panelsOf({ ...emptySeries(), spend: [spend({ model: "unknown-model" })] });
    expect(panels.cost).toEqual([]);
    expect(panels.costUnpriced).toBe(1);
  });
});

/* ── the prose ─────────────────────────────────────────────────────────────*/

function modelOf(rows: WorkRow[], series: WorkSeries, overlaps: PairOverlap[] = [], scratch = { never: false, recorded: 500, first: T0 - 30 * DAY }) {
  return workModelOf({
    rows,
    series,
    overlaps,
    measure: "merged",
    from: T0,
    to: T0 + 7 * DAY,
    span: "7d",
    scratch,
  });
}

describe("what the page says, in each of its states", () => {
  test("nothing recorded at all", () => {
    const model = modelOf([], emptySeries(), [], { never: true, recorded: 0, first: null });
    expect(model.story.state).toBe("nothing");
    expect(model.story.lede).toContain("nothing has been recorded yet");
    expect(model.story.empty).toBe(true);
    expect(model.story.sections).toEqual([]);
  });

  test("a quiet week on a recording wall", () => {
    const model = modelOf([], emptySeries(), [], { never: false, recorded: 12_400, first: T0 - 30 * DAY, outsideKnown: true });
    expect(model.story.state).toBe("nothing");
    expect(model.story.lede).toContain("nothing was recorded in the last 7 days");
    expect(model.story.lede).toContain("12k requests");
  });

  test("an empty window whose outside count was not asked claims none", () => {
    /* The spend read only computes `recorded`/`first` for an empty window. With
       rows in it (or a failed read) those are "not asked", and the prose must
       not turn that into "0 requests on record". */
    const model = modelOf([], emptySeries(), [], { never: false, recorded: 0, first: null, outsideKnown: false });
    expect(model.story.lede).toContain("nothing was recorded in the last 7 days");
    expect(model.story.lede).not.toContain("on record outside this window");
  });

  test("spend with no artifact is its own state, and says what it cannot see", () => {
    const model = modelOf(
      [],
      {
        ...emptySeries(),
        spend: [spend({ card: "design" })],
        sessions: [{ session: "s9", host: "here", card: "design", project: "nova", source: "card", startedAt: T0, endedAt: T0 + 2 * HOUR }],
      },
    );
    expect(model.story.state).toBe("no-artifacts");
    expect(model.story.lede).toContain("produced no artifact");
    expect(model.story.lede).toContain(WORK_CAVEAT);
    expect(model.story.empty).toBe(false);
    expect(model.cards[0].noArtifact).toBe(true);
  });

  test("a normal week names the commits, the lines and the conflicts", () => {
    const rows = [
      work({ at: T0 + HOUR, kind: "commit", added: 120, removed: 20 }),
      work({ at: T0 + 2 * HOUR, kind: "pr_merge" }),
      work({ at: T0 + 3 * HOUR, kind: "conflict", branch: "main" }),
      work({ at: T0 + 15 * MINUTE + 3 * HOUR, kind: "commit", branch: "main" }),
    ];
    const model = modelOf(rows, { ...emptySeries(), spend: [spend()] });
    expect(model.story.state).toBe("normal");
    expect(model.story.lede).toContain("2 commits");
    expect(model.story.lede).toContain("1 merge");
    expect(model.story.lede).toContain("+100 net lines");
    expect(model.story.lede).toContain("15 minutes went to 1 conflict");
    expect(model.story.facts.find((f) => f.label === "merged")?.value).toBe(count(1));
    expect(model.story.sections.map((s) => s.id)).toEqual(["bought", "coordination", "reread", "cannot"]);
  });

  test("a pair listing that was not read is said, not left looking empty", () => {
    const model = workModelOf({
      rows: [work({ at: T0, kind: "commit", added: 3, removed: 1 })],
      series: { ...emptySeries(), spend: [spend()] },
      overlaps: [],
      overlapsUnread: true,
      measure: "merged",
      from: T0,
      to: T0 + 7 * DAY,
      span: "7d",
      scratch: { never: false, recorded: 0, first: null },
    });
    expect(model.overlapsUnread).toBe(true);
    const coordination = model.story.sections.find((s) => s.id === "coordination");
    expect(coordination?.body).toContain("could not be read");
  });

  test("state is decided by what the window holds, not by tone", () => {
    expect(
      workStoryState({ span: "7d", rows: [], kpis: { cost: null, unpriced: 0 } as never, coordination: { conflictMinutes: 0 } as never, bands: [], scratch: { never: true, recorded: 0, first: null } }),
    ).toBe("nothing");
  });
});

/* ── the two skins draw one set of numbers ─────────────────────────────────*/

describe("the room and the page agree, from one fixture", () => {
  const bundle = fixtureWork({ since: T0, until: T0 + 7 * DAY, fine: false }, "normal");
  const model = modelOf(bundle.rows, bundle.series, bundle.overlaps);

  test("the fixture carries every state the face owes a reading for", () => {
    expect(bundle.rows.some((r) => r.provenance === "history")).toBe(true);
    expect(bundle.rows.some((r) => r.provenance === "receipt")).toBe(true);
    expect(model.episodes.length).toBeGreaterThan(1);
    expect(model.episodes.some((e) => e.closedBy === "cap")).toBe(true);
    expect(model.episodes.some((e) => e.closedBy === "commit")).toBe(true);
    expect(model.bands.length).toBeGreaterThan(0);
    expect(model.cards.some((c) => c.noArtifact)).toBe(true);
    expect(model.cards.some((c) => c.cost !== null && c.merged === 0 && c.commits > 0)).toBe(true);
  });

  test("the KPI strip, the story's facts and the table are the same numbers", () => {
    const facts = new Map(model.story.facts.map((f) => [f.label, f.value]));
    expect(facts.get("merged")).toBe(count(model.kpis.merged));
    expect(facts.get("commits")).toBe(count(model.kpis.commits));
    expect(facts.get("net lines")).toBe(signed(model.kpis.net));
    expect(facts.get("conflict minutes")).toBe(count(Math.round(model.kpis.conflictMinutes)));
    expect(facts.get("leading project")).toBe(model.kpis.leading?.project ?? "");

    const tableCost = model.cards.reduce((n, c) => n + (c.cost ?? 0), 0);
    expect(tableCost).toBeCloseTo(model.kpis.cost ?? 0, 8);
    expect(model.cards.reduce((n, c) => n + c.commits, 0)).toBe(model.kpis.commits);
    expect(model.cards.reduce((n, c) => n + c.merged, 0)).toBe(model.kpis.merged);
    expect(model.cards.reduce((n, c) => n + c.net, 0)).toBe(model.kpis.net);
  });

  test("the scatter's dots are the table's cards, at the table's figures", () => {
    for (const point of model.scatter.points) {
      const card = model.cards.find((c) => c.card === point.card)!;
      expect(point.cost).toBe(card.cost ?? 0);
      expect(point.y).toBe(card.merged);
    }
    expect(model.scatter.points.length + model.scatter.omitted).toBe(model.cards.length);
  });

  test("the coordination strip's dollars are the episodes times the cards' burn", () => {
    const coordination = model.coordination;
    let expected = 0;
    for (const episode of coordination.episodes) {
      const card = model.cards.find((c) => c.card === episode.card);
      if (card?.burnUsdPerHour != null) expected += (episode.minutes / 60) * card.burnUsdPerHour;
    }
    if (coordination.pricedMinutes > 0) expect(coordination.coordinationUsd).toBeCloseTo(expected, 8);
    else expect(coordination.coordinationUsd).toBe(null);

    for (const band of model.bands) {
      expect(model.bars.some((b) => b.card === band.left)).toBe(true);
      expect(model.bars.some((b) => b.card === band.right)).toBe(true);
    }
  });

  test("the fixture's own figures are priced by the same table", () => {
    const row = bundle.series.spend[0];
    const fact = {
      hour: row.hour,
      host: "",
      account: row.account,
      provider: "",
      model: row.model,
      effort: "",
      cli: "",
      source: "",
      project: "",
      provenance: "transcript" as const,
      inTok: row.inTok,
      outTok: row.outTok,
      cacheRead: row.cacheRead,
      write5m: row.write5m,
      write1h: row.write1h,
      requests: row.requests,
      usdReported: row.usdReported,
    };
    expect(spendOfRow(row)).toBeCloseTo(modeledUsd(fact) ?? 0, 12);
    expect(spendOfRow(row)).toBeGreaterThan(0);
  });
});

/* ── normalising what the wire says ────────────────────────────────────────*/

describe("a row that will not parse is dropped, never folded as a zero", () => {
  test("the work rows", () => {
    const rows = asWorkRows([
      { at: T0, kind: "commit", card: "c1" },
      { at: 0, kind: "commit" },
      { at: T0, kind: "" },
      null,
    ]);
    expect(rows.length).toBe(1);
    expect(rows[0].card).toBe("c1");
    expect(rows[0].provenance).toBe("receipt");
  });

  test("the series and the pairs", () => {
    const series = asWorkSeries({
      hourly: [{ hour: 0, kind: "commit" }, { hour: T0, kind: "commit", count: 2 }],
      spend: [{ hour: T0, model: "m" }, { hour: 0 }],
      sessions: [{ startedAt: T0, card: "c1", endedAt: T0 - 1 }, { startedAt: 0 }],
    });
    expect(series.hourly.length).toBe(1);
    expect(series.spend.length).toBe(1);
    expect(series.sessions.length).toBe(1);
    expect(series.sessions[0].endedAt).toBe(null);
    const pairs = asOverlaps([
      { left: "a", right: "b", minutes: 3, files: ["x"], spans: [[1, 2], [2, 1]] },
      { left: "a", right: "a", minutes: 2 },
      null,
    ]);
    expect(pairs.length).toBe(1);
    expect(pairs[0].spans).toEqual([[1, 2]]);
  });

  test("spans merge where they touch and drop the empty", () => {
    expect(unionSpans([[10, 20], [20, 30], [40, 40], [5, 7]])).toEqual([
      [5, 7],
      [10, 30],
    ]);
  });
});

/* ── the strips ────────────────────────────────────────────────────────────*/

describe("bars and bands are clipped to the window", () => {
  const series: WorkSeries = {
    ...emptySeries(),
    sessions: [
      { session: "s1", host: "here", card: "c1", project: "volery", source: "card", startedAt: T0 - DAY, endedAt: T0 + 2 * HOUR },
      { session: "s1", host: "here", card: "c1", project: "volery", source: "card", startedAt: T0 + 4 * HOUR, endedAt: T0 + 6 * HOUR },
    ],
  };
  const cards = [{ card: "c1", label: "c1", project: "volery", cost: 10, burnUsdPerHour: 2, artifacts: 1, noArtifact: false }] as unknown as CardWork[];

  test("a session that began before the window is drawn from its edge", () => {
    const bars = barsOf(cards, series, T0, T0 + DAY);
    expect(bars[0].spans).toEqual([
      [T0, T0 + 2 * HOUR],
      [T0 + 4 * HOUR, T0 + 6 * HOUR],
    ]);
  });

  test("a band with no shared minute has no span to draw", () => {
    const bands = bandsOf(
      [{ left: "c1", right: "c2", minutes: 0, files: ["x"], spans: [] }],
      [...cards, { card: "c2", label: "c2", project: "volery", cost: 5, burnUsdPerHour: 1, artifacts: 1, noArtifact: false } as unknown as CardWork],
      T0,
      T0 + DAY,
    );
    expect(bands).toEqual([]);
  });
});

/* ── kpis ──────────────────────────────────────────────────────────────────*/

describe("the leading project is artifacts, and it says its share", () => {
  test("counts artifacts and names the largest project", () => {
    const rows = [
      work({ at: T0, kind: "commit", project: "volery" }),
      work({ at: T0 + 1, kind: "commit", project: "volery" }),
      work({ at: T0 + 2, kind: "pr_merge", project: "nova" }),
      work({ at: T0 + 3, kind: "conflict", project: "nova", branch: "main" }),
    ];
    const cards = cardWorkOf({ rows, series: emptySeries(), from: T0, to: T0 + DAY });
    const coordination = coordinationOf(conflictEpisodes(rows), cards);
    const kpis = kpisOf(rows, cards, coordination);
    expect(kpis.leading?.project).toBe("volery");
    expect(kpis.leading?.share).toBeCloseTo((2 / 3) * 100, 10);
    expect(kpis.conflictMinutes).toBe(30);
  });

  test("no artifacts leaves no leading project, rather than a zero share", () => {
    const kpis = kpisOf([], [], coordinationOf([], []));
    expect(kpis.leading).toBe(null);
    expect(kpis.cost).toBe(null);
  });
});

/* ── invalidation (§3.9) ───────────────────────────────────────────────────*/

const TREE = "C:/workbench/volery";
const CLAUDE = "C:/workbench/volery/CLAUDE.md";

function inv(over: Partial<InvalidateRow> & Pick<InvalidateRow, "at" | "kind">): InvalidateRow {
  return {
    host: "here",
    session: "s1",
    card: "c1",
    ref: CLAUDE,
    tree: TREE,
    affected: 1,
    tokens: 0,
    inTokens: 0,
    model: "",
    usd: 0,
    provenance: "receipt",
    ...over,
  };
}

function paid(over: Partial<InvalidateRow> & Pick<InvalidateRow, "at">): InvalidateRow {
  return inv({
    kind: "instructions",
    provenance: "attributed",
    session: "s2",
    card: "c2",
    affected: 0,
    tokens: 60_000,
    model: "claude-opus-5-5",
    usd: 0,
    ...over,
  });
}

describe("a churn episode is a run of writes, not a write", () => {
  test("three writes inside the gap are one episode, priced at its last write", () => {
    const rows = [
      inv({ at: T0, kind: "instructions" }),
      inv({ at: T0 + 3 * MINUTE, kind: "instructions" }),
      inv({ at: T0 + 8 * MINUTE, kind: "instructions" }),
      paid({ at: T0 + 8 * MINUTE, tokens: 40_000 }),
    ];
    const one = invalidationOf(rows, null);
    expect(one.episodes).toHaveLength(1);
    expect(one.episodes[0].writes).toBe(3);
    expect(one.episodes[0].end).toBe(T0 + 8 * MINUTE);
    expect(one.churnEpisodes).toBe(1);
    expect(one.churnWriteCount).toBe(3);
    expect(one.episodes[0].measured).toBe(true);
    expect(one.episodes[0].tokens).toBe(40_000);
    expect(one.episodes[0].usd).toBeGreaterThan(0);
  });

  test("a write after the gap opens a second episode", () => {
    const rows = [
      inv({ at: T0, kind: "instructions" }),
      inv({ at: T0 + CHURN_GAP_MS + 1, kind: "instructions" }),
    ];
    expect(invalidationOf(rows, null).episodes).toHaveLength(2);
  });

  test("rules are grouped by their directory, not their file", () => {
    const rows = [
      inv({ at: T0, kind: "rule", ref: "C:/x/.claude/rules/style.md" }),
      inv({ at: T0 + MINUTE, kind: "rule", ref: "C:/x/.claude/rules/tests.md" }),
    ];
    const one = invalidationOf(rows, null);
    expect(one.episodes).toHaveLength(1);
    expect(one.episodes[0].writes).toBe(2);
    expect(invalidateKey("rule", "C:/x/.claude/rules/style.md")).toBe("C:/x/.claude/rules");
    expect(invalidateKey("instructions", CLAUDE)).toBe(CLAUDE);
  });

  test("a switch is its own episode, and a repeated one is not churn", () => {
    const rows = [
      inv({ at: T0, kind: "account", ref: "tx-team", session: "s1" }),
      inv({ at: T0 + MINUTE, kind: "account", ref: "tx-team", session: "s1" }),
      inv({ at: T0 + 2 * MINUTE, kind: "model", ref: "claude-opus-5-5", session: "s1" }),
    ];
    const one = invalidationOf(rows, null);
    expect(one.episodes).toHaveLength(3);
    expect(one.churnEpisodes).toBe(0);
    expect(one.switches).toBe(3);
    expect(one.events).toBe(0);
  });
});

describe("events and dollars are never one number", () => {
  test("a receipt row carrying tokens is still only an event", () => {
    const rows = [
      /* A receipt row with a dollar figure on it, which no writer of this build
         produces — and if a later one does, it must not be summed as cost. */
      inv({ at: T0, kind: "instructions", tokens: 90_000, usd: 5 }),
    ];
    const one = invalidationOf(rows, 100);
    expect(one.events).toBe(1);
    expect(one.tokens).toBe(0);
    expect(one.usd).toBe(null);
  });

  test("an attributed row is cost and never an event", () => {
    const rows = [paid({ at: T0 })];
    const one = invalidationOf(rows, null);
    expect(one.events).toBe(0);
    expect(one.episodesCount).toBe(0);
    expect(one.usd).toBe(null);
  });

  test("the share has no divisor and is null rather than zero", () => {
    const rows = [inv({ at: T0, kind: "instructions" }), paid({ at: T0 })];
    expect(invalidationOf(rows, null).share).toBe(null);
    expect(invalidationOf(rows, 0).share).toBe(null);
    expect(invalidationOf(rows, 1000).share).toBeGreaterThan(0);
  });
});

describe("unmeasured is not free", () => {
  test("an episode with no attributed row is null, not zero", () => {
    const one = invalidationOf([inv({ at: T0, kind: "instructions" })], 100);
    expect(one.episodes[0].measured).toBe(false);
    expect(one.episodes[0].usd).toBe(null);
    expect(one.unmeasured).toBe(1);
    expect(one.usd).toBe(null);
  });

  test("an attributed row of zero tokens is measured and costs nothing", () => {
    const one = invalidationOf(
      [inv({ at: T0, kind: "rule", ref: "C:/x/.claude/rules/a.md" }), paid({ at: T0, kind: "rule", ref: "C:/x/.claude/rules/a.md", tokens: 0 })],
      100,
    );
    expect(one.episodes[0].measured).toBe(true);
    expect(one.episodes[0].usd).toBe(0);
    expect(one.usd).toBe(0);
  });

  test("a payer whose model has no rate leaves the episode unpriced", () => {
    const one = invalidationOf(
      [inv({ at: T0, kind: "instructions" }), paid({ at: T0, model: "a-model-nobody-priced" })],
      100,
    );
    expect(one.episodes[0].payers[0].usd).toBe(null);
    expect(one.episodes[0].usd).toBe(null);
    expect(one.episodes[0].measured).toBe(false);
  });
});

describe("the excess is priced through the one rate table", () => {
  test("a cache-write-only row prices the same two ways", () => {
    const tokens = 123_456;
    const viaHelper = cacheWriteUsd(tokens, "claude-opus-5-5", T0);
    const viaRecord = modeledUsd({
      at: T0,
      host: "here",
      session: "s1",
      agent: "",
      parentAgent: "",
      depth: 0,
      model: "claude-opus-5-5",
      effort: "",
      cli: "",
      source: "card",
      account: "lyss",
      accountIdentity: "",
      provider: "claude",
      project: "volery",
      provenance: "transcript",
      inTok: 0,
      outTok: 0,
      cacheRead: 0,
      write5m: tokens,
      write1h: 0,
      requests: 1,
      usdReported: 0,
    });
    expect(viaHelper).not.toBe(null);
    expect(viaHelper).toBeCloseTo(viaRecord ?? 0, 12);
  });

  test("an unknown model has no price rather than a zero", () => {
    expect(cacheWriteUsd(1000, "a-model-nobody-priced", T0)).toBe(null);
  });

  test("fresh input is priced at the input rate, not the cache-write one", () => {
    const tokens = 3_620;
    const input = inputUsd(tokens, "claude-opus-5-5", T0) ?? 0;
    const write = cacheWriteUsd(tokens, "claude-opus-5-5", T0) ?? 0;
    expect(input).toBeGreaterThan(0);
    expect(input).toBeLessThan(write);
    /* Both buckets are what one payer costs. */
    expect(attributedUsd(0, tokens, "claude-opus-5-5", T0)).toBeCloseTo(input, 12);
    expect(attributedUsd(tokens, 0, "claude-opus-5-5", T0)).toBeCloseTo(write, 12);
  });

  test("a payer whose excess landed in fresh input is measured, not free", () => {
    const one = invalidationOf(
      [inv({ at: T0, kind: "instructions" }), paid({ at: T0, tokens: 0, inTokens: 3_620 })],
      100,
    );
    expect(one.episodes[0].measured).toBe(true);
    expect(one.episodes[0].payers[0].tokens).toBe(3_620);
    expect(one.episodes[0].usd).toBeGreaterThan(0);
  });
});

describe("the by-tree reading, and the rows a bad command answer dropped", () => {
  test("groups episodes and keeps a tree whose dollars were never measured at null", () => {
    const rows = [
      inv({ at: T0, kind: "instructions", tree: "C:/a" }),
      paid({ at: T0, tree: "C:/a" }),
      inv({ at: T0 + HOUR, kind: "instructions", tree: "C:/b", ref: "C:/b/AGENTS.md" }),
    ];
    const one = invalidationOf(rows, null);
    const a = one.byTree.find((t) => t.tree === "C:/a");
    const b = one.byTree.find((t) => t.tree === "C:/b");
    expect(a?.measured).toBe(1);
    expect(a?.usd).toBeGreaterThan(0);
    expect(b?.measured).toBe(0);
    expect(b?.usd).toBe(null);
    expect(one.unmeasured).toBe(1);

    const writes = one.byKind.find((k) => k.kind === "instructions");
    expect(writes?.events).toBe(2);
    expect(writes?.episodes).toBe(2);
    expect(writes?.measured).toBe(1);
    expect(writes?.usd).toBeGreaterThan(0);
  });

  test("a row that will not parse is dropped rather than drawn as a zero", () => {
    const rows = asInvalidateRows([
      { at: T0, kind: "instructions", ref: CLAUDE },
      { at: "x", kind: "" },
      null,
      42,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].provenance).toBe("receipt");
  });

  test("the advice is advice, not a ban, and carries no em dash", () => {
    expect(INVALIDATE_ADVICE).not.toContain("—");
    expect(INVALIDATE_ADVICE).toContain(".claude/rules/");
    expect(INVALIDATE_ADVICE).toContain("new cards");
  });

  test("the unmeasured copy names the wait it mirrors, once", () => {
    expect(ATTRIBUTE_WAIT_MS).toBe(6 * HOUR);
    expect(attributeWaitSaid()).toBe("6 hours");
  });

  test("the TypeScript wait is the one the store actually resolves", () => {
    /* **The drift guard.** Following the alias is the point: asserting only
       the literal 6 would pass a Rust file that had moved the wait somewhere
       else while still spelling the lookback as six hours. */
    const alias = rustConst("ATTRIBUTE_WAIT_MS");
    const wait = alias === "ATTRIBUTE_LOOKBACK_MS" ? rustConst("ATTRIBUTE_LOOKBACK_MS") : alias;
    expect(rustProduct(wait)).toBe(ATTRIBUTE_WAIT_MS);
    /* And the wait may not exceed the lookback: an event that aged out of the
       scan can never be revisited, so a longer promise is one the fold cannot
       keep. */
    if (alias === "ATTRIBUTE_LOOKBACK_MS") {
      expect(rustProduct(rustConst("ATTRIBUTE_LOOKBACK_MS"))).toBeGreaterThanOrEqual(ATTRIBUTE_WAIT_MS);
    }
  });
});
