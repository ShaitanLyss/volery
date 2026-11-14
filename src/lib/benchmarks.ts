/* Models: a model at an effort, what it costs, and the balance between them.
 *
 * The design is `docs/MODELS.md`. This file is the wall's half of it: what a
 * task tag means, which names the wall spawns and which versions those resolve
 * to, the workflow profiles and their weights, how old a reading is, and the
 * one line a menu draws at the moment somebody chooses. `benchmarks.rs` is the
 * other half — the source adapters, the fetch, the cache, and the ranking.
 *
 * ## Why the ranking is not here
 *
 * The panel and the `models` tool answer the same question, and only one of
 * them can reach this file: a deferred tool is served by `ask.rs` in Rust, with
 * no webview involved and possibly no window open. So the arithmetic that
 * decides a profile score, a frontier and a runner-up is written once, in
 * `benchmarks.rs`, and the panel draws what it is handed. Two implementations
 * of "which entry gives more quality for less money" would be two answers to
 * one question, and the wall would eventually show both.
 *
 * What is here is everything that is a *definition* rather than a computation:
 * the profiles (authored once, in `model-profiles.json`, read by both sides),
 * the aliases, the tags, the as-of wording and the menu's line. Those are the
 * parts a person argues about, and they are pure so the argument happens
 * against tests.
 *
 * ## A ranking is a view, never a truth
 *
 * Nothing here — and nothing in the Rust half — collapses a model to a single
 * hidden score. A profile names its members and weights, every ranked row
 * carries its components, and two entries that disagree across benchmarks are
 * shown disagreeing. Vendor-reported readings are marked and never averaged
 * with independent ones.
 */

import PROFILES_JSON from "./model-profiles.json";

/** What a benchmark measures. One benchmark may carry more than one. */
export type TaskTag =
  | "repo"
  | "coding"
  | "tool-use"
  | "reasoning"
  | "knowledge"
  | "long-context"
  | "search"
  | "vision"
  | "speed"
  | "price";

export const TASKS: { id: TaskTag; label: string }[] = [
  { id: "repo", label: "repository work" },
  { id: "coding", label: "one-shot coding" },
  { id: "tool-use", label: "tool use" },
  { id: "reasoning", label: "hard reasoning" },
  { id: "knowledge", label: "knowledge" },
  { id: "long-context", label: "long context" },
  { id: "search", label: "search" },
  { id: "vision", label: "vision" },
  { id: "speed", label: "speed" },
  { id: "price", label: "price" },
];

/** The effort a reading was taken at.
 *
 *  `not-stated` is not a level and never sorts with them: a source that does
 *  not say what effort it ran at has not told us what it measured. Showing it
 *  beside `high` as though the two were comparable is the one thing this
 *  dimension exists to prevent. `none` is the different fact that the model
 *  takes no effort parameter at all (the wall's haiku preset). */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "none" | "not-stated";

export const EFFORT_LEVELS: Effort[] = ["low", "medium", "high", "xhigh", "max", "none", "not-stated"];

/** What a source is. `vendor` is kept as an id because a vendor's own card is
 *  a source of a different kind and must never be averaged with the others. */
export type SourceId = "benchlm" | "artificial-analysis" | "vendor";

export type SourceState = {
  id: SourceId;
  label: string;
  /** The line the panel owes a source whose terms ask for credit. */
  attribution: string;
  url: string;
  /** Whether this source is asked at all. Artificial Analysis is off until a
   *  key is entered in the integrations panel. */
  on: boolean;
  status: "ok" | "failed" | "off" | "never";
  /** When it was last read successfully, ISO 8601, or null. */
  at: string | null;
  /** Why it is failed or off, in the source's own words where it has any. */
  said: string | null;
  rows: number;
};

/** A model as one source names it. Merged across sources by `key` for display,
 *  never for arithmetic: two sources' context windows are two statements, and
 *  the tool says which source each reading came from. */
export type ModelRow = {
  source: SourceId;
  key: string;
  name: string;
  creator: string;
  contextWindow: number | null;
  release: string | null;
  vision: boolean | null;
  toolUse: boolean | null;
};

export type BenchmarkDef = {
  key: string;
  name: string;
  category: string;
  unit: string;
  /** The source that defines it, so the catalogue can say. */
  source: SourceId;
};

export type Reading = {
  source: SourceId;
  model: string;
  benchmark: string;
  score: number | null;
  unit: string;
  effort: Effort;
  harness: string | null;
  published: string | null;
  /** The vendor's own claim about its own model. Never averaged with the rest. */
  vendor: boolean;
};

/** One component of a profile score, as the panel and the tool both show it. */
export type Component = {
  benchmark: string;
  name: string;
  weight: number;
  score: number | null;
  unit: string;
  source: SourceId;
  published: string | null;
  /** The number came from the model's own developer — a provider-reported
   *  benchmark or a model card. Never drawn as independent. */
  vendor: boolean;
  /** Who the source credits for the number, where it credits anybody. Absent is
   *  "not stated", and that is what the panel says. */
  publisher: string | null;
};

/** One ranked entry: a model at an effort, in one profile. */
export type Entry = {
  key: string;
  name: string;
  creator: string;
  effort: Effort;
  source: SourceId;
  quality: number | null;
  price: number | null;
  /** Named on every surface, because reasoning tokens are most of what an
   *  effort changes and a price without its basis is not the decision. */
  priceBasis: string;
  input: number | null;
  output: number | null;
  contextWindow: number | null;
  vision: boolean | null;
  toolUse: boolean | null;
  /** On the quality/cost frontier of this profile. */
  efficient: boolean;
  rank: number | null;
  /** How much of the profile's weight this entry has a reading for, as a
   *  fraction. A score computed from two members of five is shown sparse. */
  coverage: number;
  /** The pair that *is* the tier. Two entries scored over different member
   *  sets are two different questions; the rule of this whole surface is that
   *  they are never ordered against each other, and this is what says so. */
  present: number;
  members: number;
  /** How many of the present members' numbers came from the model's own
   *  developer. Beside the coverage, because "3 of 5 members" and "3 of 5, two
   *  of them provider-reported" are different amounts of knowing. */
  reported: number;
  /** The source's own evidence status for this model: `supported` or
   *  `estimated`, where it states one. */
  evidence: string | null;
  components: Component[];
  /** Members this entry has no reading for. Shown, never guessed. */
  missing: string[];
};

/** What `models_view` answers with: everything a ranked surface needs, computed
 *  in Rust so the tool and the panel cannot disagree. */
export type Ranked = {
  profile: Profile;
  asOf: string | null;
  sources: SourceState[];
  rows: Entry[];
  /** Entries that are efficient but could not be placed on the curve because a
   *  price or a quality is missing, with which one. */
  unplaceable: { key: string; why: string }[];
  /** Every dimmed row's explanation: which efficient entry beat it. */
  dominated: { key: string; by: string }[];
  /** Which tier the frontier was computed inside, and how many members a full
   *  profile has. `benchmarks.rs` decides both. */
  frontierTier: number;
  memberCount: number;
};

// ── the profiles, read from the one file both languages share ──────────────

export type ProfileMember = { benchmark: string; weight: number };

export type Profile = {
  id: string;
  label: string;
  note: string;
  /** Which card kind opens on it: a project card on the coding agent, a chat
   *  card on knowledge and research. Null for the rest. */
  defaultFor: "project" | "chat" | null;
  /** `quality` ranks by the profile score; `cost` ranks by price among the
   *  entries that clear the floor, which is what "cheap bulk" is asking. */
  order: "quality" | "cost";
  members: ProfileMember[];
};

export type ProfileTable = {
  version: number;
  authoredOn: string;
  benchmarks: Record<string, { label: string; task: TaskTag }>;
  profiles: Profile[];
};

/** The shared table. `benchmarks.rs` reads this very file, so a reweighting is
 *  one edit and a recompile rather than two tables kept in step by a test. */
export const PROFILE_TABLE = PROFILES_JSON as ProfileTable;

export const PROFILES: Profile[] = PROFILE_TABLE.profiles;

export function profileOf(id: string | null | undefined): Profile | null {
  if (!id) return null;
  return PROFILES.find((p) => p.id === id) ?? null;
}

/** The profile a menu shows when nobody has said otherwise: a project card is
 *  repo work, a chat card is reading and research. */
export function profileFor(kind: "project" | "chat" | null | undefined): Profile {
  const wanted = kind === "chat" ? "chat" : "project";
  return PROFILES.find((p) => p.defaultFor === wanted) ?? PROFILES[0];
}

/** Weights as fractions of the whole, and a member with no weight is a mistake
 *  worth surfacing rather than hiding — so a non-positive weight is dropped
 *  here and the profile test asserts none is authored. */
export function weightsOf(profile: Profile): ProfileMember[] {
  const kept = profile.members.filter((m) => m.weight > 0);
  const total = kept.reduce((sum, m) => sum + m.weight, 0);
  if (total <= 0) return [];
  return kept.map((m) => ({ benchmark: m.benchmark, weight: m.weight / total }));
}

/** The members this build can name, with their label and task. A profile that
 *  names a benchmark the shared table does not describe is a mistake the test
 *  catches; at runtime it is dropped rather than drawn as a blank row. */
export function membersOf(
  profile: Profile,
): (ProfileMember & { label: string; task: TaskTag | null })[] {
  const out: (ProfileMember & { label: string; task: TaskTag | null })[] = [];
  for (const m of weightsOf(profile)) {
    const def = PROFILE_TABLE.benchmarks[m.benchmark];
    if (def) out.push({ ...m, label: def.label, task: def.task });
  }
  return out;
}

// ── the aliases: what the wall spawns, and what that resolves to ───────────

/** One wall name and the version it is currently known to be.
 *
 *  The alias is shown beside the version on every surface, so "pro" is never a
 *  timeless word: what it resolves to is a fact with a date on it, and the
 *  date is the day this table was checked against the sources. Nothing here
 *  infers a version from a name. */
export type Alias = {
  /** What an agent or a preset types: the CLI alias or the provider's model id. */
  alias: string;
  provider: "claude" | "deepseek";
  /** The full model version key the benchmarks catalogue uses, where one is
   *  known. Null is a real answer: an alias nobody has mapped says so. */
  model: string | null;
  /** What the wall spawns it at when nothing else is said. `none` for a model
   *  that takes no effort parameter; `not-stated` where the wall has no default. */
  effort: Effort;
  checked: string;
  note: string;
};

/** The table, read off the sources on 2026-11-13 (BenchLM's model list) and
 *  the wall's own presets for what the alias spawns at.
 *
 *  `haiku` is `none` rather than a level for `presets.ts`'s reason: the
 *  parameter is dropped silently on that model. */
export const ALIASES: Alias[] = [
  {
    alias: "haiku",
    provider: "claude",
    model: "claude-haiku-5-5",
    effort: "none",
    checked: "2026-11-13",
    note: "the cheapest card the wall can open; no effort parameter",
  },
  {
    alias: "sonnet",
    provider: "claude",
    model: "claude-sonnet-5-5",
    effort: "medium",
    checked: "2026-11-13",
    note: "the everyday model; the preset opens it at medium",
  },
  {
    alias: "sonnet[1m]",
    provider: "claude",
    model: "claude-sonnet-5-5",
    effort: "medium",
    checked: "2026-11-13",
    note: "the same model asking for the wide window",
  },
  {
    alias: "opus",
    provider: "claude",
    model: "claude-opus-5-5",
    effort: "high",
    checked: "2026-11-13",
    note: "the dear end of the ordinary menu",
  },
  {
    alias: "opus[1m]",
    provider: "claude",
    model: "claude-opus-5-5",
    effort: "high",
    checked: "2026-11-13",
    note: "the same model asking for the wide window",
  },
  {
    alias: "fable",
    provider: "claude",
    model: "claude-fable-5-2",
    effort: "medium",
    checked: "2026-11-13",
    note: "the newest fable",
  },
  {
    alias: "deepseek-flash",
    provider: "deepseek",
    model: "deepseek-v4-1-flash",
    effort: "not-stated",
    checked: "2026-11-13",
    note: "deepseek's everyday model; the provider takes no wall effort level",
  },
  {
    alias: "deepseek-v4-pro",
    provider: "deepseek",
    model: "deepseek-v4-pro-max",
    effort: "not-stated",
    checked: "2026-11-13",
    note: "deepseek's dear model; the provider takes no wall effort level",
  },
];

/** The alias a name resolves to, or null. A full version id resolves to the
 *  alias that names it, so a menu can say both halves from one string. */
export function aliasOf(name: string | null | undefined): Alias | null {
  const full = name?.trim();
  if (!full) return null;
  /* The exact spelling first: `opus[1m]` and `opus` are two rows, and a
   *  suffix-stripping match would answer the first for either. */
  const exact = ALIASES.find((a) => a.alias === full);
  if (exact) return exact;
  const bare = full.replace(/\[.*\]$/, "");
  return (
    ALIASES.find((a) => a.alias.replace(/\[.*\]$/, "") === bare) ??
    ALIASES.find((a) => a.model === bare) ??
    null
  );
}

/** The model key a wall name resolves to, for looking a reading up. */
export function modelOf(alias: string | null | undefined): string | null {
  return aliasOf(alias)?.model ?? null;
}

// ── task tags ──────────────────────────────────────────────────────────────

/** The tag a benchmark carries, from its category and its name.
 *
 *  The category is the source's own taxonomy and is the first answer. The name
 *  is read only for the cases the category cannot distinguish — a coding
 *  benchmark that is actually repository work, a vision benchmark that is
 *  actually chart reading — and the patterns are deliberately narrow: a wrong
 *  tag puts a benchmark in a profile it does not belong to, which is worse
 *  than leaving it tagged by category alone. */
export function tagsFor(benchmark: { key: string; name: string; category: string; unit?: string }): TaskTag[] {
  const name = benchmark.name.toLowerCase();
  const key = benchmark.key.toLowerCase();
  const cat = benchmark.category.toLowerCase();
  const tags = new Set<TaskTag>();

  if (cat.includes("agentic")) {
    tags.add("tool-use");
    if (/terminal|shell|computer|os-?world|swe/.test(name)) tags.add("repo");
  }
  if (cat.includes("coding")) {
    tags.add("coding");
    if (/swe|repo|deep-?swe|patch|bug/.test(name) || /swe/.test(key)) tags.add("repo");
  }
  if (cat.includes("reasoning")) tags.add("reasoning");
  if (cat.includes("knowledge")) tags.add("knowledge");
  if (cat.includes("math")) tags.add("reasoning");
  if (cat.includes("multimodal")) tags.add("vision");
  if (cat.includes("multilingual")) tags.add("knowledge");

  if (/longbench|ruler|mrcr|longmem|long-?context|needle/.test(name) || /longbench|ruler|mrcr/.test(key)) {
    tags.add("long-context");
  }
  if (/browsecomp|deepsearch|searchqa|web-?search/.test(name) || /browse|deepsearch/.test(key)) {
    tags.add("search");
  }
  if (benchmark.unit === "USD / 1M tokens") tags.add("price");
  if (benchmark.unit === "tokens/s" || benchmark.unit === "s") tags.add("speed");

  if (tags.size === 0) tags.add("knowledge");
  return [...tags];
}

// ── how old the reading is ─────────────────────────────────────────────────

/** The newest successful read across the sources that are on, ISO 8601, or
 *  null when nothing has ever been read. This is the "as of" the design asks
 *  for: an age of a *dataset*, not of the panel. */
export function asOf(sources: SourceState[]): string | null {
  let newest: number | null = null;
  let at: string | null = null;
  for (const s of sources) {
    if (!s.on || !s.at) continue;
    const t = Date.parse(s.at);
    if (Number.isNaN(t)) continue;
    if (newest === null || t > newest) {
      newest = t;
      at = s.at;
    }
  }
  return at;
}

/** The panel's line: "as of 12 nov, 14:02", or why there is nothing to date.
 *
 *  Lowercase, quiet and sentence-shaped like the rest of the prose here. The
 *  day is named with its month because a wall left up for a week would
 *  otherwise read "as of 14:02" about a reading from last Tuesday. */
export function sayAsOf(sources: SourceState[], now = Date.now()): string {
  const at = asOf(sources);
  if (!at) {
    const failed = sources.filter((s) => s.on && s.status === "failed");
    if (failed.length) return `nothing read yet — ${failed[0].label} says ${failed[0].said ?? "it could not be read"}`;
    return sources.some((s) => s.on) ? "nothing read yet" : "no source is on";
  }
  const t = Date.parse(at);
  if (Number.isNaN(t)) return "nothing read yet";
  const d = new Date(t);
  const day = d.getDate();
  const month = d.toLocaleString("en-GB", { month: "short" }).toLowerCase();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const age = Math.floor((now - t) / 86_400_000);
  const when = age > 0 ? `${day} ${month} (${age} day${age === 1 ? "" : "s"} old)` : `${day} ${month}, ${hh}:${mm}`;
  return `as of ${when}`;
}

/** Whether the cache is past the day floor the design sets, which is what
 *  makes a tool call fetch rather than answer from what it has. */
export function pastFloor(sources: SourceState[], now = Date.now()): boolean {
  const at = asOf(sources);
  if (!at) return true;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return true;
  return now - t > 86_400_000;
}

// ── what a surface says ────────────────────────────────────────────────────

export function sourceLabel(id: SourceId): string {
  switch (id) {
    case "benchlm":
      return "BenchLM";
    case "artificial-analysis":
      return "Artificial Analysis";
    case "vendor":
      return "the vendor's own card";
  }
}

/** What an effort is called where a reading is drawn. The two non-levels are
 *  words rather than blanks, because a blank beside "high" reads as a level
 *  somebody forgot to fill in. */
export function effortLabel(effort: Effort): string {
  switch (effort) {
    case "not-stated":
      return "effort not stated";
    case "none":
      return "no effort parameter";
    default:
      return `at ${effort}`;
  }
}

/** A price as the panel and the tool say it, with its basis never separated
 *  from the number. `null` is "no price", which is a different answer from
 *  "free" and is drawn as one. */
export function sayPrice(price: number | null, basis: string): string {
  if (price === null) return "no price published";
  if (price === 0) return "free";
  const digits = price < 1 ? 3 : 2;
  return `$${price.toFixed(digits)} ${basis}`;
}

/** The line a provider/model menu draws under an entry: the profile it is
 *  showing, the score, and the price. Quiet and lowercase, and it names the
 *  profile so a menu cannot be read as a universal ranking. */
export function menuLine(entry: Entry | null, profile: Profile, asOfLine: string): string {
  if (!entry) return `${profile.label}: no reading`;
  const parts: string[] = [profile.label];
  parts.push(entry.quality === null ? "no score" : entry.quality.toFixed(1));
  parts.push(sayPrice(entry.price, entry.priceBasis));
  if (entry.effort !== "not-stated") parts.push(effortLabel(entry.effort));
  if (entry.efficient) parts.push("on the frontier");
  return parts.join(" · ") + ` — ${asOfLine}`;
}

/** A menu row's second line: the profile it is showing, the score and the
 *  price. Shorter than `menuLine` on purpose — a menu is read at the speed of
 *  starting work, and the date belongs on the menu's foot rather than on every
 *  row. It names the profile because a score without one is a universal ranking,
 *  which is the claim this whole file refuses. */
export function standingLine(entry: Entry | null, profile: Profile): string {
  if (!entry) return `${profile.label} · no reading`;
  const q = entry.quality === null ? "no score" : entry.quality.toFixed(1);
  /* Compact because this shares a row with the model and the effort: the basis
     and the date are on the menu's own foot, once, rather than trailing every
     row of it. */
  const price =
    entry.price === null
      ? "no price"
      : entry.price === 0
        ? "free"
        : `$${entry.price < 1 ? entry.price.toFixed(3) : entry.price.toFixed(2)}/1M`;
  return `${profile.label} ${q} · ${price}`;
}

/** Whether an entry meets what an agent asked for. A need that cannot be
 *  checked is *not* met: "vision: true" against an entry whose sources never
 *  said is an unanswered question, and answering it yes would be the guess
 *  this whole file refuses. */
export type Needs = {
  vision?: boolean;
  toolUse?: boolean;
  context?: number;
  maxPrice?: number;
};

export function meets(entry: Entry, needs: Needs): boolean {
  if (needs.vision && entry.vision !== true) return false;
  if (needs.toolUse && entry.toolUse !== true) return false;
  if (needs.context !== undefined && (entry.contextWindow === null || entry.contextWindow < needs.context)) {
    return false;
  }
  if (needs.maxPrice !== undefined && (entry.price === null || entry.price > needs.maxPrice)) return false;
  return true;
}

/** The two entries a frontier is read for: the cheapest that keeps most of the
 *  quality, and the best quality at any price.
 *
 *  This is presentation rather than arithmetic — the Rust half decides which
 *  rows are efficient — but it is the sentence the panel puts above the curve,
 *  so it is here where a test can read it. Null when there is nothing on the
 *  frontier to say it about. */
export function frontierSaid(rows: Entry[]): string {
  const efficient = rows.filter((r) => r.efficient && r.quality !== null && r.price !== null);
  if (efficient.length === 0) return "no entry has both a score and a price, so there is no frontier to draw";
  const best = [...efficient].sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0))[0];
  const cheapest = [...efficient].sort((a, b) => (a.price ?? 0) - (b.price ?? 0))[0];
  if (best.key === cheapest.key) {
    return `${best.name} is both the cheapest and the strongest entry here`;
  }
  const given = (best.quality ?? 0) - (cheapest.quality ?? 0);
  const costs = (best.price ?? 0) - (cheapest.price ?? 0);
  return (
    `${cheapest.name} gives up ${given.toFixed(1)} points to ${best.name} ` +
    `and costs ${sayPrice(costs, cheapest.priceBasis)} less`
  );
}

/** How many entries a profile could score at all — the number that tells a
 *  panel its sources are thin rather than that every model is bad. */
export function scored(rows: Entry[]): number {
  return rows.filter((r) => r.quality !== null).length;
}

/** One coverage tier: every entry scored over the same number of members. */
export type Tier = { present: number; members: number; rows: Entry[] };

/** The ranked table split into the only groups it may be ordered in.
 *
 *  **The order across tiers is not a ranking, and this is what stops it being
 *  read as one.** A model measured on three of four benchmarks has answered a
 *  different question from one measured on two of four; its mean is not higher
 *  or lower on the same scale, it is a mean of something else. So the table is
 *  headings with entries under them, the ranks restart at each heading, and
 *  entries with too few members to score at all come last under their own
 *  heading, naming what they lack. */
export function tiers(rows: Entry[]): { scored: Tier[]; unscored: Entry[] } {
  const groups = new Map<number, Entry[]>();
  for (const r of rows) {
    if (r.quality === null) continue;
    const list = groups.get(r.present) ?? [];
    list.push(r);
    groups.set(r.present, list);
  }
  const scored = [...groups.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([present, list]) => ({ present, members: list[0]?.members ?? 0, rows: list }));
  return { scored, unscored: rows.filter((r) => r.quality === null) };
}

/** What a tier's heading says. "3 of 4 members" is the fact; "every member" is
 *  the same fact for the one tier that needs no arithmetic from the reader. */
export function tierLabel(tier: Tier): string {
  if (tier.present === tier.members) return "every member";
  return `${tier.present} of ${tier.members} members`;
}

/** Who is speaking, for one component. The three states are deliberately three:
 *  a named publisher, the model's developer, and nobody saying. The third is
 *  not independence and must never be drawn as it. */
export function sayProvenance(c: Component): string {
  if (c.vendor) return c.publisher ? `${c.publisher} (the model's own developer)` : "the model's own developer";
  if (c.publisher) return c.publisher;
  /* Short enough to sit on a component's own line, and still a statement rather
     than a blank: an unnamed publisher is not an independent one. */
  return "no publisher";
}

/** How many of a row's scored members are the developer's own numbers, as a
 *  clause for the coverage line. Empty when none of them are. */
export function reportedNote(row: Entry): string {
  if (row.reported === 0) return "";
  return `${row.reported} provider-reported`;
}

/** The members a row has no reading for, by their catalogue names.
 *
 *  Beside "not enough readings" this is the answer to *why is that model not
 *  here*, which a count of members cannot give: a row missing GPQA Diamond and
 *  HLE is a different absence from one missing two agentic benchmarks. */
export function missingNames(row: Entry): string[] {
  return row.components.filter((c) => c.score === null).map((c) => c.name || c.benchmark);
}
