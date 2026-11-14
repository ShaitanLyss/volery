import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALIASES,
  EFFORT_LEVELS,
  PROFILES,
  PROFILE_TABLE,
  TASKS,
  aliasOf,
  asOf,
  effortLabel,
  frontierSaid,
  meets,
  missingNames,
  reportedNote,
  sayProvenance,
  tierLabel,
  tiers,
  menuLine,
  membersOf,
  modelOf,
  pastFloor,
  profileFor,
  profileOf,
  sayAsOf,
  sayPrice,
  scored,
  standingLine,
  sourceLabel,
  tagsFor,
  weightsOf,
  type Entry,
  type SourceState,
} from "../src/lib/benchmarks";

const REPO = join(import.meta.dir, "..");

const entry = (over: Partial<Entry> = {}): Entry => ({
  key: "m",
  name: "a model",
  creator: "a maker",
  effort: "not-stated",
  source: "benchlm",
  quality: 60,
  price: 1,
  priceBasis: "per 1M blended 3:1",
  input: 1,
  output: 2,
  contextWindow: 1_000_000,
  vision: true,
  toolUse: true,
  efficient: true,
  rank: 1,
  coverage: 1,
  present: 3,
  members: 3,
  reported: 0,
  evidence: null,
  components: [],
  missing: [],
  ...over,
});

const source = (over: Partial<SourceState> = {}): SourceState => ({
  id: "benchlm",
  label: "BenchLM",
  attribution: "Data from BenchLM.ai",
  url: "https://benchlm.ai/data",
  on: true,
  status: "ok",
  at: "2026-11-13T02:11:01Z",
  said: null,
  rows: 100,
  ...over,
});

describe("the profile table", () => {
  test("every default kind points at exactly one profile, and they differ", () => {
    const project = PROFILES.filter((p) => p.defaultFor === "project");
    const chat = PROFILES.filter((p) => p.defaultFor === "chat");
    expect(project).toHaveLength(1);
    expect(chat).toHaveLength(1);
    expect(project[0].id).not.toBe(chat[0].id);
  });

  test("ids are unique and every member is a benchmark this build can name", () => {
    const ids = PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PROFILES) {
      expect(p.members.length).toBeGreaterThan(0);
      for (const m of p.members) {
        expect(`${p.id} → ${m.benchmark}`).toBeTruthy();
        expect(PROFILE_TABLE.benchmarks[m.benchmark]).toBeDefined();
      }
    }
  });

  test("no profile names the same benchmark twice, and every weight is positive", () => {
    for (const p of PROFILES) {
      const keys = p.members.map((m) => m.benchmark);
      expect(new Set(keys).size).toBe(keys.length);
      for (const m of p.members) expect(m.weight).toBeGreaterThan(0);
    }
  });

  test("weights are fractions of the whole", () => {
    for (const p of PROFILES) {
      const total = weightsOf(p).reduce((sum, m) => sum + m.weight, 0);
      expect(Math.abs(total - 1)).toBeLessThan(1e-9);
    }
  });

  test("a reweighting is a row change, not a code change — the Rust half reads this same file", () => {
    const rs = readFileSync(join(REPO, "src-tauri", "src", "benchmarks.rs"), "utf8");
    expect(rs).toContain('include_str!("../../src/lib/model-profiles.json")');
  });

  test("every authoring date is a real date", () => {
    expect(Number.isNaN(Date.parse(PROFILE_TABLE.authoredOn))).toBe(false);
  });

  test("cheap bulk is the one profile that ranks by cost", () => {
    const byCost = PROFILES.filter((p) => p.order === "cost").map((p) => p.id);
    expect(byCost).toEqual(["cheap-bulk"]);
  });

  test("membersOf drops nothing in this table and carries each label", () => {
    for (const p of PROFILES) {
      expect(membersOf(p)).toHaveLength(p.members.length);
      for (const m of membersOf(p)) expect(m.label.length).toBeGreaterThan(0);
    }
  });

  test("every task tag is one of the vocabulary", () => {
    const known = new Set(TASKS.map((t) => t.id));
    for (const def of Object.values(PROFILE_TABLE.benchmarks)) expect(known.has(def.task)).toBe(true);
  });
});

describe("the aliases", () => {
  test("no wall name is claimed twice", () => {
    const names = ALIASES.map((a) => a.alias);
    expect(new Set(names).size).toBe(names.length);
  });

  test("a version id resolves back to the alias that names it", () => {
    expect(aliasOf("claude-opus-5-5")?.alias).toBe("opus");
    expect(aliasOf("deepseek-v4-1-flash")?.alias).toBe("deepseek-flash");
  });

  test("the window suffix is not part of the model", () => {
    expect(aliasOf("sonnet[1m]")?.model).toBe("claude-sonnet-5-5");
    expect(aliasOf("opus[1m]")?.alias).toBe("opus[1m]");
  });

  test("every alias states a valid effort, and haiku takes none", () => {
    for (const a of ALIASES) expect(EFFORT_LEVELS).toContain(a.effort);
    expect(aliasOf("haiku")?.effort).toBe("none");
  });

  test("each mapping carries the date it was checked", () => {
    for (const a of ALIASES) {
      expect(Number.isNaN(Date.parse(a.checked))).toBe(false);
      expect(a.note.length).toBeGreaterThan(0);
    }
  });

  test("an unmapped name says so rather than guessing", () => {
    expect(aliasOf("gpt-9000")).toBeNull();
    expect(modelOf("gpt-9000")).toBeNull();
  });

  /* The snapshot the table was checked against, held beside it. A source that
     renames a key leaves an alias pointing at a version nothing publishes, and
     the menu then says "no reading" for ever with nothing red anywhere. This is
     the guard: refresh the fixture and an alias that no longer resolves goes
     red, in the suite rather than in a menu. */
  test("every alias names a model the snapshot actually carries", () => {
    const snap = JSON.parse(readFileSync(join(REPO, "test", "fixtures", "benchlm-models.json"), "utf8"));
    const keys = new Set(snap.items.map((m: { canonicalModelKey: string }) => m.canonicalModelKey));
    for (const a of ALIASES) {
      expect(`${a.alias} → ${a.model}`).toBeTruthy();
      expect(keys.has(a.model!)).toBe(true);
    }
  });
});

describe("task tags", () => {
  test("a repository benchmark is repo work and not only coding", () => {
    const tags = tagsFor({ key: "sweVerified", name: "SWE-bench Verified", category: "coding" });
    expect(tags).toContain("repo");
    expect(tags).toContain("coding");
  });

  test("an agentic benchmark is tool use", () => {
    expect(tagsFor({ key: "terminalBench41", name: "Terminal-Bench 4.1", category: "agentic" })).toContain(
      "tool-use",
    );
  });

  test("long context is read off the name, because the category does not say", () => {
    expect(tagsFor({ key: "mrcrv2", name: "MRCRv2", category: "reasoning" })).toContain("long-context");
  });

  test("price and speed come from the unit, never from a word", () => {
    expect(tagsFor({ key: "price:blended", name: "blended price", category: "", unit: "USD / 1M tokens" })).toContain(
      "price",
    );
    expect(tagsFor({ key: "speed:tps", name: "throughput", category: "", unit: "tokens/s" })).toContain("speed");
  });

  test("an unknown category still yields a tag rather than nothing", () => {
    expect(tagsFor({ key: "x", name: "x", category: "" })).toEqual(["knowledge"]);
  });
});

describe("how old the reading is", () => {
  test("the newest successful source is the as-of", () => {
    expect(
      asOf([
        source({ at: "2026-11-12T10:00:00Z" }),
        source({ id: "artificial-analysis", at: "2026-11-13T09:00:00Z" }),
      ]),
    ).toBe("2026-11-13T09:00:00Z");
  });

  test("a source that is off, or has never read, does not date the panel", () => {
    expect(asOf([source({ at: null, status: "never" })])).toBeNull();
    expect(asOf([source({ on: false, at: "2026-11-13T09:00:00Z" })])).toBeNull();
  });

  test("the line names the day, and the age once it is more than a day", () => {
    const now = Date.parse("2026-11-14T12:00:00Z");
    expect(sayAsOf([source({ at: "2026-11-12T10:00:00Z" })], now)).toContain("(2 days old)");
  });

  test("nothing read says so, with the source's reason", () => {
    expect(sayAsOf([source({ at: null, status: "never" })])).toBe("nothing read yet");
    expect(sayAsOf([source({ at: null, status: "failed", said: "connection timed out" })])).toContain(
      "connection timed out",
    );
    expect(sayAsOf([source({ on: false, at: null, status: "off" })])).toBe("no source is on");
  });

  test("the floor is a day", () => {
    const now = Date.parse("2026-11-13T12:00:00Z");
    expect(pastFloor([source({ at: "2026-11-13T02:00:00Z" })], now)).toBe(false);
    expect(pastFloor([source({ at: "2026-11-12T02:00:00Z" })], now)).toBe(true);
    expect(pastFloor([source({ at: null, status: "never" })], now)).toBe(true);
  });
});

describe("what a surface says", () => {
  test("a price never travels without its basis", () => {
    expect(sayPrice(0.28, "per 1M blended 3:1")).toBe("$0.280 per 1M blended 3:1");
    expect(sayPrice(12, "per 1M blended 3:1")).toBe("$12.00 per 1M blended 3:1");
    expect(sayPrice(0, "per 1M blended 3:1")).toBe("free");
    expect(sayPrice(null, "per 1M blended 3:1")).toBe("no price published");
  });

  test("an effort that was not stated is a word, not a blank", () => {
    expect(effortLabel("not-stated")).toBe("effort not stated");
    expect(effortLabel("none")).toBe("no effort parameter");
    expect(effortLabel("high")).toBe("at high");
  });

  test("the menu names the profile it is showing and the date", () => {
    const line = menuLine(entry(), profileFor("project"), "as of 13 nov, 02:11");
    expect(line).toContain("coding agent");
    expect(line).toContain("60.0");
    expect(line).toContain("as of 13 nov");
    expect(line).toContain("on the frontier");
  });

  test("no reading is drawn as no reading", () => {
    expect(menuLine(null, profileFor("chat"), "nothing read yet")).toContain("no reading");
  });

  test("a menu row says the profile, the score and a compact price", () => {
    const line = standingLine(entry({ quality: 65.7, price: 8 }), profileFor("project"));
    expect(line).toBe("coding agent 65.7 · $8.00/1M");
    expect(standingLine(entry({ quality: null, price: 0.2 }), profileFor("project"))).toContain("no score");
    expect(standingLine(null, profileFor("project"))).toContain("no reading");
  });

  test("source names are the products' own", () => {
    expect(sourceLabel("benchlm")).toBe("BenchLM");
    expect(sourceLabel("artificial-analysis")).toBe("Artificial Analysis");
    expect(sourceLabel("vendor")).toBe("the vendor's own card");
  });
});

describe("needs", () => {
  test("a capability nobody stated is not a capability", () => {
    expect(meets(entry({ vision: null }), { vision: true })).toBe(false);
    expect(meets(entry({ vision: true }), { vision: true })).toBe(true);
    expect(meets(entry({ toolUse: null }), { toolUse: true })).toBe(false);
  });

  test("a context floor and a price ceiling are both inclusive", () => {
    expect(meets(entry({ contextWindow: 1_000_000 }), { context: 1_000_000 })).toBe(true);
    expect(meets(entry({ contextWindow: 200_000 }), { context: 1_000_000 })).toBe(false);
    expect(meets(entry({ price: 2 }), { maxPrice: 2 })).toBe(true);
    expect(meets(entry({ price: 3 }), { maxPrice: 2 })).toBe(false);
  });

  test("an unmeasured capability or price fails the need rather than passing it", () => {
    expect(meets(entry({ contextWindow: null }), { context: 1 })).toBe(false);
    expect(meets(entry({ price: null }), { maxPrice: 100 })).toBe(false);
  });

  test("no needs means everything passes", () => {
    expect(meets(entry({ vision: null, contextWindow: null, price: null }), {})).toBe(true);
  });
});

describe("the frontier's sentence", () => {
  test("says what the cheap end gives up", () => {
    const rows = [
      entry({ key: "cheap", name: "cheap", quality: 50, price: 0.1 }),
      entry({ key: "dear", name: "dear", quality: 70, price: 5 }),
    ];
    const said = frontierSaid(rows);
    expect(said).toContain("cheap gives up 20.0 points to dear");
    expect(said).toContain("less");
  });

  test("one entry that is both ends says that instead", () => {
    expect(frontierSaid([entry({ quality: 80, price: 1 })])).toContain("both the cheapest and the strongest");
  });

  test("no placeable entry is said as such rather than drawn as an empty curve", () => {
    expect(frontierSaid([entry({ price: null })])).toContain("no entry has both a score and a price");
  });

  test("a dominated row is not part of the sentence", () => {
    const rows = [entry({ key: "good", quality: 80, price: 1 }), entry({ key: "dominated", quality: 40, price: 9, efficient: false })];
    expect(frontierSaid(rows)).not.toContain("dominated");
    expect(scored(rows)).toBe(2);
  });
});

describe("coverage tiers", () => {
  test("the table is grouped by how many members an entry was scored over", () => {
    const rows = [
      entry({ key: "a", present: 2, quality: 90 }),
      entry({ key: "b", present: 3, quality: 50 }),
      entry({ key: "c", present: 3, quality: 80 }),
      entry({ key: "d", present: 1, quality: null }),
    ];
    const { scored, unscored } = tiers(rows);
    expect(scored.map((t) => t.present)).toEqual([3, 2]);
    expect(scored[0].rows.map((r) => r.key)).toEqual(["b", "c"]);
    expect(unscored.map((r) => r.key)).toEqual(["d"]);
  });

  test("a tier says the fact rather than an adjective", () => {
    expect(tierLabel({ present: 3, members: 3, rows: [] })).toBe("every member");
    expect(tierLabel({ present: 2, members: 3, rows: [] })).toBe("2 of 3 members");
  });

  test("a missing member is named, not just counted", () => {
    const row = entry({
      components: [
        { benchmark: "gpqa", name: "GPQA Diamond", weight: 0.5, score: 93.6, unit: "score (0-100)", source: "benchlm", published: null, vendor: false, publisher: null },
        { benchmark: "hle", name: "HLE", weight: 0.5, score: null, unit: "", source: "", published: null, vendor: false, publisher: null },
      ],
      missing: ["hle"],
    });
    expect(missingNames(row)).toEqual(["HLE"]);
  });
});

describe("provenance", () => {
  const part = (over: Record<string, unknown> = {}) => ({
    benchmark: "agentsLastExam",
    name: "Agents' Last Exam",
    weight: 0.1,
    score: 35.4,
    unit: "score (0-100)",
    source: "benchlm" as const,
    published: null,
    vendor: false,
    publisher: null,
    ...over,
  });

  test("three states, and the third is not independence", () => {
    expect(sayProvenance(part({ publisher: "Vals AI" }))).toBe("Vals AI");
    expect(sayProvenance(part({ vendor: true }))).toBe("the model's own developer");
    expect(sayProvenance(part({ vendor: true, publisher: "DeepSeek" }))).toBe(
      "DeepSeek (the model's own developer)",
    );
    expect(sayProvenance(part())).toBe("publisher not stated");
  });

  test("a row says how many of its numbers are the developer's own", () => {
    expect(reportedNote(entry({ reported: 0 }))).toBe("");
    expect(reportedNote(entry({ reported: 2 }))).toBe("2 provider-reported");
  });
});

describe("a profile is looked up, never assumed", () => {
  test("an unknown id is null", () => {
    expect(profileOf("nonexistent")).toBeNull();
    expect(profileOf("")).toBeNull();
    expect(profileOf("coding-agent")?.label).toBe("coding agent");
  });

  test("a project card opens on the coding agent and a chat card on knowledge", () => {
    expect(profileFor("project").id).toBe("coding-agent");
    expect(profileFor("chat").id).toBe("knowledge-research");
    expect(profileFor(null).id).toBe("coding-agent");
  });
});
