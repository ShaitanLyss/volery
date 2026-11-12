/* A window of facts, made up, for looking at the room without a wall.
 *
 * `invoke` has nothing behind it in a plain browser, so `analytics.html` mounts
 * the room with this as its reader. It generates rows the way the store would:
 * the same two shapes, the same grain as the requested tier, and deliberate
 * holes, because a fixture with no hole in it never shows whether the chart
 * draws a gap rather than a dip.
 *
 * **It is not in any bundle.** `vite build` takes `index.html` only, and
 * `test/analyticsroom.test.ts` holds both halves of that: nothing but the
 * preview entry imports this file, and the vite config names no second input.
 *
 * Deterministic for a given request, so two screenshots a day apart differ only
 * by the clock the reader was handed.
 */

import type { AnalyticsWindow, WindowRequest } from "./analyticsroom";
import type { SpendWatch } from "./spend";
import type { Fact, HourFact, ToolTotal, UsageRow } from "./analytics";
import type { BehaviourBundle, BehaviourReader } from "./analyticsbehaviourread.svelte";
import type { SessionFact } from "./analyticsbehaviour";
import type { ActionMark, ActionSeriesRow, ActionSlice, ActionWindow } from "./acts";
import type { CardLife, LifeSpend } from "./analyticslife";
import type { LifeReader } from "./analyticsliferead.svelte";
import type { AllowanceCost, AllowanceSample } from "./allowancesamples";
import type { FundingRow } from "./fundings";
import type {
  CardSpendRow,
  InvalidateRow,
  PairOverlap,
  WorkBundle,
  WorkHourRow,
  WorkReader,
  WorkRow,
  WorkSessionRow,
} from "./analyticswork";
import {
  asVaultState,
  startOfDay,
  type FavouriteRow,
  type ForgetReport,
  type PromptBody,
  type PromptReader,
  type PromptRow,
  type ResetReport,
  type SealReport,
  type VaultState,
} from "./analyticstrace";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** What the preview asks for: `?empty=1` is a store that has never recorded,
 *  `?quiet=1` is a working wall with nothing in this window. */
export type FixtureMode = "normal" | "empty" | "quiet";

/** A linear congruential generator, so the same request draws the same rows.
 *  Not a good random number, which is exactly right here. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const PROJECTS = ["volery", "nova", "rise", "tx-toolkit", "atlas"];
const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5", "deepseek-flash"];

/** One request's tokens, with the shapes a transcript really has: a large
 *  cache read, a small fresh input, an output a fraction of it. */
function tokens(rand: () => number, model: string) {
  const inTok = Math.round(400 + rand() * 6000);
  const outTok = Math.round(200 + rand() * 2400);
  const cacheRead = inTok > 0 ? Math.round(inTok * (2 + rand() * 26)) : 0;
  const write5m = Math.round(inTok * rand() * 0.5);
  const write1h = Math.round(inTok * rand() * 0.08);
  return { inTok, outTok, cacheRead, write5m, write1h, model };
}

export function fixtureWindow(req: WindowRequest, mode: FixtureMode = "normal"): AnalyticsWindow {
  const tier = req.fine ? "fine" : "hourly";
  const base = { tier, since: req.since, until: req.until } as const;

  if (mode === "empty") {
    return { ...base, rows: [], cards: 0, first: null, recorded: 0 };
  }
  if (mode === "quiet") {
    return {
      ...base,
      rows: [],
      cards: 0,
      first: req.since - 26 * 24 * HOUR,
      recorded: 184_920,
    };
  }

  const step = req.fine ? 5 * MINUTE : HOUR;
  const rand = rng(0x5eed1e);
  const rows: UsageRow[] = [];

  /* One blackout about a third in, at least two hours and at most six: the
     hole the chart has to draw as a hole. */
  const span = Math.max(1, req.until - req.since);
  const from = req.since + span * 0.34;
  const to = from + Math.min(6 * HOUR, Math.max(2 * HOUR, span * 0.1));

  const start = Math.ceil(req.since / step) * step;
  for (let t = start; t < req.until; t += step) {
    if (t >= from && t < to) continue;
    const hour = new Date(t).getHours();
    /* Quiet at night, and quiet in patches: a wall that spent something every
       five minutes of its life is a fixture that cannot show a lull. */
    if (hour < 6 || hour > 22) {
      if (rand() > 0.08) continue;
    } else if (rand() > 0.78) {
      continue;
    }

    const count = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < count; i += 1) {
      const project = PROJECTS[Math.floor(rand() * PROJECTS.length)];
      const model = MODELS[Math.floor(rand() * MODELS.length)];
      const sentinel = model === "deepseek-flash";
      const account = sentinel ? "@deepseek" : rand() > 0.3 ? "lyss" : "tx-team";
      const provider = sentinel ? "deepseek" : "anthropic";
      const t2 = tokens(rand, model);

      if (req.fine) {
        const row: Fact = {
          at: t,
          host: "fixture",
          session: `s${Math.floor(rand() * 12)}`,
          agent: rand() > 0.85 ? `a${Math.floor(rand() * 4)}` : "",
          parentAgent: "",
          depth: 0,
          model: t2.model,
          effort: rand() > 0.5 ? "high" : "medium",
          cli: "2.1",
          source: "card",
          account,
          accountIdentity: "",
          provider,
          project,
          provenance: "transcript",
          inTok: t2.inTok,
          outTok: t2.outTok,
          cacheRead: t2.cacheRead,
          write5m: t2.write5m,
          write1h: t2.write1h,
          requests: 1,
          usdReported: 0,
        };
        rows.push(row);
      } else {
        const row: HourFact = {
          hour: t,
          host: "fixture",
          account,
          provider,
          model: t2.model,
          effort: rand() > 0.5 ? "high" : "medium",
          cli: "2.1",
          source: "card",
          project,
          provenance: "transcript",
          inTok: t2.inTok,
          outTok: t2.outTok,
          cacheRead: t2.cacheRead,
          write5m: t2.write5m,
          write1h: t2.write1h,
          requests: 1,
          usdReported: 0,
        };
        rows.push(row);
      }
    }
  }

  const first = req.since - 41 * 24 * HOUR;
  return {
    ...base,
    rows,
    cards: Math.max(1, Math.round(span / (6 * HOUR))),
    first,
    recorded: rows.length + 12_400,
  };
}

/* ── the prompt trace, made up ──────────────────────────────────────────── */

/** Which vault the preview starts with. `none` is a wall that has never made
 *  one, `locked` one whose passphrase was set and the key has gone, and
 *  `unlocked` the reading the vault exists for. */
export type VaultMode = "none" | "locked" | "unlocked";

const PROMPT_KINDS = ["design", "redirect", "nudge", "task", "question", "issue", "other"] as const;
const PROMPT_PROJECTS = ["volery", "nova", "rise", "tx-toolkit", "atlas"];
const PROMPT_CARDS = [
  "analytics, the prompt trace",
  "the hall of fame",
  "redaction corpus",
  "auth waterfall",
  "gondola preview",
  "the flyway archive",
];

/** Made-up redacted bodies: the words of none of them came from a transcript,
 *  which is the fixture's one promise (`test/analyticsroom.test.ts` holds the
 *  import; this is the constant side of it). */
const BODIES = [
  "design the analytics surface so a card can swap account without losing its place. the redacted keys go, the paths stay · <redacted: 2 tokens>",
  "no, the other one: keep the store's shape and move the fold into rust",
  "continue",
  "add a redaction pass for <redacted: path> and hold the false-positive corpus to it",
  "can you check whether the rollup moved when the kind was overridden?",
  "the build fails on <redacted: path>: the resolver cannot find the workspace member",
  "one thought: the hall should survive every prune, and a forgotten body should take its marker with it",
];

function promptRowsFor(now: number): PromptRow[] {
  const rand = rng(0x9a1ab1e);
  const rows: PromptRow[] = [];
  /* Seven local days, today included, newest day still growing: the trace's
     own window. */
  for (let back = 6; back >= 0; back -= 1) {
    const dayStart = startOfDay(now - back * 24 * HOUR);
    const n = back === 0 ? 11 : 9 + Math.floor(rand() * 10);
    for (let i = 0; i < n; i += 1) {
      const at = dayStart + Math.floor((0.08 + rand() * 0.84) * 24 * HOUR);
      if (at > now) continue;
      const kind = PROMPT_KINDS[Math.floor(rand() * PROMPT_KINDS.length)];
      const project = PROMPT_PROJECTS[Math.floor(rand() * PROMPT_PROJECTS.length)];
      const card = PROMPT_CARDS[Math.floor(rand() * PROMPT_CARDS.length)];
      const words = 3 + Math.floor(rand() * 420);
      const redactions = rand() > 0.72 ? 1 + Math.floor(rand() * 4) : 0;
      /* The four body states the trace distinguishes, so a review sees the
         marker's vocabulary rather than only `sealed`. */
      const roll = rand();
      const bodyState =
        roll > 0.93 ? "withheld" : roll > 0.86 ? "deleted" : roll > 0.74 ? "locked" : roll > 0.71 ? "none" : "sealed";
      const id = `p${back}-${i}`;
      rows.push({
        host: "fixture",
        promptId: id,
        at,
        hour: at - (at % HOUR),
        seenCount: rand() > 0.94 ? 2 : 1,
        session: `s${Math.floor(rand() * 9)}`,
        card,
        project,
        source: rand() > 0.85 ? "terminal" : "card",
        account: rand() > 0.3 ? "lyss" : "tx-team",
        provider: "anthropic",
        vaultId: bodyState === "sealed" ? "fixture-vault" : "",
        kind,
        kindOverride: null,
        chars: words * 6,
        words,
        lines: 1 + Math.floor(rand() * 12),
        fences: rand() > 0.86 ? 1 : 0,
        codeLines: 0,
        images: rand() > 0.96 ? 1 : 0,
        questions: kind === "question" ? 1 : 0,
        redactions,
        withheld: bodyState === "withheld" ? 1 : 0,
        bodyState,
        bodyTruncated: 0,
      });
    }
  }
  return rows.sort((a, b) => a.at - b.at);
}

function seedFavourites(rows: PromptRow[], now: number): FavouriteRow[] {
  const pick = (i: number) => rows[Math.min(rows.length - 1, Math.floor((rows.length * i) / 5))];
  /* A short fixture clamps two picks onto one row, and two favourites keyed on
     the same prompt is a keyed `{#each}` with a duplicate. One entry is the
     honest answer there: there is only one prompt. */
  const chosen = [pick(1), pick(3)].filter(
    (row, i, all) => row && all.findIndex((r) => r.host === row.host && r.promptId === row.promptId) === i,
  );
  if (chosen.length === 0) return [];
  return chosen.map((row, i) => ({
    host: row.host,
    promptId: row.promptId,
    title: i === 0 ? "the analytics design that stuck" : "the redaction lesson",
    tags: i === 0 ? ["nova", "orchestration"] : ["analytics", "design"],
    createdAt: now - (i + 1) * HOUR,
    at: row.at,
    project: row.project,
    kind: row.kind,
    kindOverride: null,
    bodyState: row.bodyState,
    words: row.words,
    cost: 18.4 + i * 7.25,
    turns: 22 + i * 4,
    note: i === 0 ? "the four currents idea came from this one." : "the false-positive corpus was the whole brief.",
    noteLocked: false,
  }));
}

/** The prompt trace's reader, with made-up facts and a vault that behaves.
 *
 * Everything a review needs to exercise is here and none of it is a transcript:
 * the rows are generated, the bodies are the seven sentences above, the hall's
 * notes are invented, and the mutating gestures are the commands' contracts
 * with fixture state behind them. `unlock` accepts any passphrase of twelve or
 * more characters — the same floor the real command enforces — and refuses a
 * short one with the command's own sentence, so the refusal path is visible too.
 */
/* ── the work facts, made up ───────────────────────────────────────────────*/

/** What the work tab draws, from a window of invented facts.
 *
 *  Deliberate holes, because a fixture with none never shows whether a face
 *  draws a gap, a dash or a zero:
 *
 *  - **receipts and history together**, so a commit attributed from git is
 *    visibly marked as such;
 *  - **a conflict that a later commit closes** and **one nothing resolves**,
 *    which is the thirty-minute cap;
 *  - **an overlap pair**, placed inside both cards' sessions;
 *  - **a card with spend and no artifact** (`design`), drawn as *no artifact*;
 *  - **a card with commits and no merge** (`atlas`), whose `$ / merged` is a
 *    dash rather than a zero.
 *
 *  Fractions of the requested window rather than fixed day offsets, so the
 *  same fixture answers 24h and 90d. Deterministic for one request.
 */
export function fixtureWork(req: WindowRequest, mode: FixtureMode = "normal"): WorkBundle {
  const since = req.since;
  const until = req.until;
  const span = Math.max(60_000, until - since);
  const at = (f: number, minutes = 0) => Math.round(since + span * f) + minutes * MINUTE;

  if (mode !== "normal") {
    return {
      rows: [],
      series: { hourly: [], spend: [], sessions: [] },
      overlaps: [],
      invalidations: [],
    };
  }

  const rows: WorkRow[] = [];
  let ref = 0;
  const work = (over: Partial<WorkRow> & Pick<WorkRow, "at" | "card" | "kind">): WorkRow => ({
    host: "here",
    session: `s-${over.card || "terminal"}`,
    agent: "",
    ref: `r${++ref}`,
    branch: "main",
    project: over.card || "terminal",
    files: 0,
    added: 0,
    removed: 0,
    conflictFiles: 0,
    ms: 0,
    provenance: "receipt",
    ...over,
  });

  /** A run of commits across the window, with a recorded sha each. `gap` keeps
   *  a stretch clear so a conflict's intended resolution really is the next
   *  artifact on the branch, rather than whichever generated commit happens to
   *  fall in the twelve minutes. */
  function commits(
    card: string,
    count: number,
    from: number,
    to: number,
    per: { files: number; added: number; removed: number },
    history: number,
    gap?: [number, number],
  ) {
    for (let i = 0; i < count; i += 1) {
      const f = from + ((to - from) * (i + 0.5)) / count;
      if (gap && f >= gap[0] && f <= gap[1]) continue;
      rows.push(
        work({
          at: at(f),
          card,
          kind: "commit",
          ref: `c${card}${i.toString(16)}`,
          files: per.files,
          added: per.added + ((i * 17) % 41),
          removed: per.removed + ((i * 7) % 19),
          provenance: i < history ? "history" : "receipt",
        }),
      );
    }
  }

  /* volery: the busiest card, one conflict a commit closes. The generated
     commits keep a thirteen-minute hole clear around it, in *time* rather than
     in fractions, so the intended resolution is the next artifact at 24h and
     at 7d alike. */
  const conflictAt = 0.3;
  commits("volery", 44, 0.02, 0.88, { files: 3, added: 61, removed: 12 }, 4, [
    conflictAt,
    conflictAt + (13 * MINUTE) / span,
  ]);
  for (let i = 0; i < 4; i += 1) {
    rows.push(work({ at: at(0.2 + i * 0.16), card: "volery", kind: "pr_merge", ref: `#41${i}`, branch: "main", provenance: i === 0 ? "history" : "receipt", files: 0 }));
  }
  rows.push(work({ at: at(conflictAt), card: "volery", kind: "conflict", ref: "rebase", branch: "main", conflictFiles: 3, ms: 95_000 }));
  /* The resolution, twelve minutes later: an episode of twelve minutes rather
     than the ninety-five seconds the command was blocked. */
  rows.push(work({ at: at(conflictAt, 12), card: "volery", kind: "commit", ref: "resolve1", branch: "main", files: 3, added: 22, removed: 8 }));

  /* nova: more merges than volery per commit, and the leading project. */
  commits("nova", 31, 0.04, 0.92, { files: 2, added: 84, removed: 6 }, 6);
  for (let i = 0; i < 4; i += 1) {
    rows.push(work({ at: at(0.12 + i * 0.2), card: "nova", kind: "pr_merge", ref: `#72${i}`, branch: "main", provenance: i === 0 ? "history" : "receipt" }));
  }

  /* rise: a conflict on a branch nothing resolves, so the cap is what ends it. */
  commits("rise", 12, 0.44, 0.72, { files: 2, added: 58, removed: 5 }, 0);
  for (let i = 0; i < 2; i += 1) {
    rows.push(work({ at: at(0.5 + i * 0.16), card: "rise", kind: "pr_merge", ref: `#300${i}`, branch: "main" }));
  }
  rows.push(work({ at: at(0.62), card: "rise", kind: "conflict", ref: "cherry-pick", branch: "import", conflictFiles: 2, ms: 240_000 }));

  /* atlas: a cleanup card. Commits and no merge (the null ratio), and more
     lines removed than added, which is the negative net the table must say
     with its sign rather than folding to zero. */
  commits("atlas", 6, 0.58, 0.84, { files: 1, added: 12, removed: 70 }, 0);

  /* The terminal: counted toward the project, never toward a card. */
  commits("", 18, 0.08, 0.8, { files: 2, added: 53, removed: 3 }, 18);
  rows.push(work({ at: at(0.36), card: "", kind: "merge", ref: "merge0", branch: "main", provenance: "history" }));
  rows.push(work({ at: at(0.56), card: "", kind: "merge", ref: "merge1", branch: "main", provenance: "history" }));

  const hourlyMap = new Map<string, WorkHourRow>();
  for (const row of rows) {
    if (row.kind === "conflict") continue;
    const hour = Math.floor(row.at / HOUR) * HOUR;
    const key = `${hour}|${row.project}|${row.branch}|${row.kind}`;
    const one = hourlyMap.get(key) ?? {
      hour,
      host: "here",
      project: row.project,
      branch: row.branch,
      kind: row.kind,
      count: 0,
      files: 0,
      added: 0,
      removed: 0,
      conflictMs: 0,
    };
    one.count += 1;
    one.files += row.files;
    one.added += row.added;
    one.removed += row.removed;
    hourlyMap.set(key, one);
  }

  /* Sessions: two stretches for volery, and one for each other, placed so the
     overlap pair below falls inside both. */
  const sessions: WorkSessionRow[] = [
    { session: "s-volery", host: "here", card: "volery", project: "volery", source: "card", startedAt: at(0.02), endedAt: at(0.08) },
    { session: "s-volery", host: "here", card: "volery", project: "volery", source: "card", startedAt: at(0.26), endedAt: at(0.4) },
    { session: "s-nova", host: "here", card: "nova", project: "nova", source: "card", startedAt: at(0.04), endedAt: at(0.12) },
    { session: "s-rise", host: "here", card: "rise", project: "rise", source: "card", startedAt: at(0.28), endedAt: at(0.46) },
    { session: "s-atlas", host: "here", card: "atlas", project: "atlas", source: "card", startedAt: at(0.58), endedAt: at(0.66) },
    { session: "s-design", host: "here", card: "design", project: "nova", source: "card", startedAt: at(0.7), endedAt: at(0.78) },
    { session: "s-terminal", host: "here", card: "", project: "volery", source: "terminal", startedAt: at(0.3), endedAt: at(0.38) },
  ];

  /* The tokens behind the dollars. Ten hours of volery at a plausible opus
     context, fewer for the rest; the model is one the rate table knows, so the
     cost is priced by the same arithmetic the spend tab uses. */
  const spend: CardSpendRow[] = [];
  const spendHours: [string, number][] = [
    ["volery", 10],
    ["nova", 7],
    ["rise", 4],
    ["atlas", 2],
    ["design", 3],
    ["", 3],
  ];
  for (const [card, hours] of spendHours) {
    const session = sessions.find((s) => s.card === card);
    for (let i = 0; i < hours; i += 1) {
      spend.push({
        card,
        hour: Math.floor((session?.startedAt ?? since) / HOUR + i) * HOUR,
        account: "lyss",
        model: i % 3 === 2 ? "claude-sonnet-5-5" : "claude-opus-5-5",
        provenance: "transcript",
        inTok: 60_000,
        outTok: 24_000,
        cacheRead: 1_200_000,
        write5m: 0,
        write1h: 0,
        requests: 8,
        usdReported: 0,
      });
    }
  }

  /* Where the pair overlapped, inside both of their sessions. */
  const overlaps: PairOverlap[] = [
    {
      left: "nova",
      right: "volery",
      minutes: 5,
      files: ["c:/x/src/auth.ts"],
      spans: [[at(0.045), at(0.045) + 5 * MINUTE]],
    },
    {
      left: "rise",
      right: "volery",
      minutes: 14,
      files: ["c:/x/src/import.ts", "c:/x/src/parse.ts"],
      spans: [[at(0.3), at(0.3) + 9 * MINUTE], [at(0.31), at(0.31) + 5 * MINUTE]],
    },
  ];

  /* The invalidation half (§3.9), with the holes a review needs to see:
   *
   *  - a **churn run** of three writes to one `CLAUDE.md` in eight minutes,
   *    priced once, after the last write, with two paying cards;
   *  - a **rule** write whose excess measured at nothing, drawn as $0 rather
   *    than as unmeasured;
   *  - an instruction write nobody could measure, which must read *unmeasured*
   *    and never zero;
   *  - an account, a provider and a model move, each its own episode.
   */
  const inv: InvalidateRow[] = [];
  const tree = (name: string) => `C:/workbench/${name}`;
  const write = (at: number, card: string, session: string, kind: "instructions" | "rule", ref: string, affected: number) =>
    inv.push({
      at,
      host: "here",
      session,
      card,
      kind,
      ref,
      tree: tree(card || "volery"),
      affected,
      tokens: 0,
      inTokens: 0,
      model: "",
      usd: 0,
      provenance: "receipt",
    });
  const paid = (at: number, card: string, session: string, kind: string, ref: string, tokens: number, inTokens = 0) =>
    inv.push({
      at,
      host: "here",
      session,
      card,
      kind,
      ref,
      tree: tree(kind === "instructions" || kind === "rule" ? "volery" : card),
      affected: 0,
      tokens,
      inTokens,
      model: "claude-opus-5-5",
      usd: 0,
      provenance: "attributed",
    });

  /* The churn run: three writes, eight minutes apart at most, one episode. */
  const churn = at(0.3);
  write(churn, "volery", "s-volery", "instructions", "C:/x/CLAUDE.md", 2);
  write(churn + 3 * MINUTE, "volery", "s-volery", "instructions", "C:/x/CLAUDE.md", 2);
  write(churn + 8 * MINUTE, "volery", "s-volery", "instructions", "C:/x/CLAUDE.md", 2);
  paid(churn + 8 * MINUTE, "nova", "s-nova", "instructions", "C:/x/CLAUDE.md", 64_000);
  /* The other bucket: a resumed card reads the file as fresh input, which is
     what `tools/probe-invalidate.ts` measured on this machine. */
  paid(churn + 8 * MINUTE, "rise", "s-rise", "instructions", "C:/x/CLAUDE.md", 0, 38_000);

  /* A rule write, measured and free. */
  const rule = at(0.48);
  write(rule, "volery", "s-volery", "rule", "C:/x/.claude/rules/analytics.md", 1);
  paid(rule, "nova", "s-nova", "rule", "C:/x/.claude/rules/analytics.md", 0);

  /* An instruction write on a tree where nobody's next request was seen. */
  write(at(0.66), "rise", "s-rise", "instructions", "C:/x/rise/AGENTS.md", 1);

  /* The moves, which the strip marks and the summary counts. */
  inv.push({
    at: at(0.18),
    host: "here",
    session: "s-volery",
    card: "volery",
    kind: "account",
    ref: "tx-team",
    tree: tree("volery"),
    affected: 3,
    tokens: 0,
    inTokens: 0,
    model: "",
    usd: 0,
    provenance: "receipt",
  });
  paid(at(0.18), "volery", "s-volery", "account", "tx-team", 22_000);
  inv.push({
    at: at(0.4),
    host: "here",
    session: "s-nova",
    card: "nova",
    kind: "provider",
    ref: "deepseek",
    tree: tree("nova"),
    affected: 2,
    tokens: 0,
    inTokens: 0,
    model: "",
    usd: 0,
    provenance: "receipt",
  });
  inv.push({
    at: at(0.6),
    host: "here",
    session: "s-atlas",
    card: "atlas",
    kind: "model",
    ref: "claude-haiku-4-5",
    tree: tree("atlas"),
    affected: 1,
    tokens: 0,
    inTokens: 0,
    model: "",
    usd: 0,
    provenance: "receipt",
  });

  return {
    rows,
    series: { hourly: [...hourlyMap.values()], spend, sessions },
    overlaps,
    invalidations: inv.sort((a, b) => a.at - b.at || a.provenance.localeCompare(b.provenance)),
  };
}

/** The preview's work reader: `?tab=work` drives the same component the app
 *  does, with no Tauri behind it. */
export function fixtureWorkReader(mode: FixtureMode = "normal"): WorkReader {
  return async (from, to) => fixtureWork({ since: from, until: to, fine: true }, mode);
}

/* ── the behaviour tab's window, made up ─────────────────────────────────── */

/** A window of tool hours, sessions and moves, for `?tab=behaviour`.
 *
 * It answers the states the drawing has to tell apart rather than producing
 * plausible-looking noise:
 *
 *  - **a built-in beside an MCP tool of a different name**, so the empty server
 *    column is visible next to a filled one;
 *  - **three servers plus two more that also complete**, which is the palette's
 *    cap and the fold, so the muted tone is drawn rather than described;
 *  - **a server with no completed call**, which is in the table and not on the
 *    scatter;
 *  - **a skill and two subagents**, so the invoked half has rows and the face
 *    can say what is not recorded;
 *  - **a session opened by an agent, one by nobody, and one still open**, which
 *    are the three states of `opened_by`;
 *  - **a move between fundings beside a file invalidation**, so the habits
 *    count a move and not every invalidation.
 *
 * Fractions of the requested window, so the same fixture answers 24h and 1y.
 * Deterministic for one request.
 */
export function fixtureBehaviour(req: { since: number; until: number }, mode: FixtureMode = "normal"): BehaviourBundle {
  const since = req.since;
  const until = req.until;
  const span = Math.max(60_000, until - since);
  if (mode !== "normal")
    return {
      tools: [],
      sessions: [],
      changes: [],
      actions: {
        from: since,
        to: until,
        bucket: 60_000,
        coarse: false,
        marksCapped: false,
        series: [],
        marks: [],
        cards: [],
        hosts: [],
      },
      changesUnread: false,
      actionsUnread: false,
    };

  const random = rng(Math.floor(span / 60_000) + 7);

  /** One rollup row, its calls split across the five bands so a percentile has
   *  a distribution rather than a spike.
   *
   *  The bands are computed over the calls that *completed* and the last one
   *  takes the rounding remainder, so they sum to it exactly as
   *  `ToolSum::add` makes them. `noResult` is the one exception, and it is the
   *  real shape of it: a call that never returned counts as a call and lands in
   *  no band at all. */
  const row = (
    over: Pick<ToolTotal, "kind" | "server" | "tool" | "target"> & {
      calls: number;
      bands: [number, number, number, number, number];
      bytes: number;
      errorShare: number;
      noResult?: boolean;
    },
  ): ToolTotal => {
    const total = Math.max(1, Math.round(over.calls * (0.7 + random() * 0.6)));
    const done = over.noResult ? 0 : total;
    const [a, b, c, d, e] = over.bands;
    const counts = [Math.round(done * a), Math.round(done * b), Math.round(done * c), Math.round(done * d), 0];
    /* The rounding remainder goes to the band the row means to have most of,
       so a distribution with a 5% error still reads as one with a 5% error
       rather than as a spike in the open band. */
    const biggest = [a, b, c, d, e].indexOf(Math.max(a, b, c, d, e));
    let remainder = done - (counts[0] + counts[1] + counts[2] + counts[3]);
    while (remainder > 0) {
      counts[biggest] += 1;
      remainder -= 1;
    }
    return {
      kind: over.kind,
      server: over.server,
      tool: over.tool,
      target: over.target,
      calls: total,
      errors: Math.round(total * over.errorShare),
      receipts: 0,
      msTotal: Math.round(done * (30 * a + 120 * b + 600 * c + 3000 * d + 8000 * e)),
      msUnder50: counts[0],
      msUnder200: counts[1],
      msUnder1s: counts[2],
      msUnder5s: counts[3],
      msOver5s: counts[4],
      outBytes: over.noResult ? 0 : Math.round(done * over.bytes * (0.8 + random() * 0.5)),
      turnUsd: total * 0.0025,
    };
  };

  /* Twelve draws of one group each, so the fixture exercises the same summing
     the SQL does rather than handing the page totals it never has to merge. */
  const tools: ToolTotal[] = [];
  for (let i = 0; i < 12; i += 1) {
    tools.push(
      row({ kind: "builtin", server: "", tool: "Read", target: "", calls: 90, bands: [0.8, 0.16, 0.03, 0.01, 0], bytes: 900, errorShare: 0.004 }),
      row({ kind: "builtin", server: "", tool: "Edit", target: "", calls: 26, bands: [0.5, 0.35, 0.12, 0.03, 0], bytes: 120, errorShare: 0.03 }),
      row({ kind: "builtin", server: "", tool: "Bash", target: "", calls: 34, bands: [0.1, 0.3, 0.4, 0.17, 0.03], bytes: 1400, errorShare: 0.06 }),
      row({ kind: "builtin", server: "", tool: "Grep", target: "", calls: 18, bands: [0.6, 0.3, 0.09, 0.01, 0], bytes: 2600, errorShare: 0.008 }),
      row({ kind: "mcp", server: "browser", tool: "browser_take_screenshot", target: "", calls: 12, bands: [0, 0.05, 0.35, 0.5, 0.1], bytes: 210_000, errorShare: 0.04 }),
      row({ kind: "mcp", server: "skein", tool: "ask_user", target: "", calls: 4, bands: [0.2, 0.5, 0.3, 0, 0], bytes: 400, errorShare: 0 }),
      row({ kind: "mcp", server: "asana", tool: "asana_board", target: "", calls: 3, bands: [0, 0.2, 0.5, 0.3, 0], bytes: 9000, errorShare: 0.12 }),
      /* Two quieter servers that do complete, so the scatter really draws the
         fold rather than three named dots and an empty fourth hue. */
      row({ kind: "mcp", server: "linear", tool: "linear_list", target: "", calls: 2, bands: [0.3, 0.5, 0.2, 0, 0], bytes: 2000, errorShare: 0 }),
      row({ kind: "mcp", server: "github", tool: "github_pr", target: "", calls: 1, bands: [0.1, 0.4, 0.4, 0.1, 0], bytes: 5000, errorShare: 0.05 }),
      row({ kind: "skill", server: "", tool: "Skill", target: "tx-toolkit:ship-gauntlet", calls: 2, bands: [0.4, 0.4, 0.2, 0, 0], bytes: 2200, errorShare: 0 }),
      row({ kind: "skill", server: "", tool: "Skill", target: "volery:coordinate", calls: 1, bands: [0.5, 0.5, 0, 0, 0], bytes: 1800, errorShare: 0 }),
      row({ kind: "agent", server: "", tool: "Agent", target: "scout", calls: 3, bands: [0.7, 0.2, 0.1, 0, 0], bytes: 600, errorShare: 0.02 }),
      row({ kind: "agent", server: "", tool: "Agent", target: "red-team", calls: 2, bands: [0.6, 0.3, 0.1, 0, 0], bytes: 1500, errorShare: 0 }),
    );
  }
  /* A server whose calls all failed before they completed: in the table, not
   * on the scatter, and the figure says why. Every call returned nothing, so
   * it lands in no latency band while still counting as a call. */
  tools.push(
    row({ kind: "mcp", server: "flaky", tool: "flaky_call", target: "", calls: 5, bands: [0, 0, 0, 0, 0], bytes: 0, errorShare: 1, noResult: true }),
  );

  const sessions = fixtureSessions(since, until);
  const changes: InvalidateRow[] = [
    {
      at: since + span * 0.3,
      host: "here",
      session: "b1",
      card: "c1",
      kind: "account",
      ref: "tx-team",
      tree: "C:/workbench/volery",
      affected: 3,
      tokens: 0,
      inTokens: 0,
      model: "",
      usd: 0,
      provenance: "attributed",
    },
    {
      at: since + span * 0.55,
      host: "here",
      session: "b2",
      card: "c2",
      kind: "provider",
      ref: "deepseek",
      tree: "C:/workbench/nova",
      affected: 2,
      tokens: 0,
      inTokens: 0,
      model: "",
      usd: 0,
      provenance: "attributed",
    },
    {
      at: since + span * 0.7,
      host: "here",
      session: "b3",
      card: "c3",
      kind: "model",
      ref: "deepseek-v4-pro",
      tree: "C:/workbench/rise",
      affected: 1,
      tokens: 0,
      inTokens: 0,
      model: "",
      usd: 0,
      provenance: "receipt",
    },
    /* A file invalidation is not a move, and the habits must not count it. */
    {
      at: since + span * 0.8,
      host: "here",
      session: "b4",
      card: "c4",
      kind: "edit",
      ref: "src/lib/analyticsbehaviour.ts",
      tree: "C:/workbench/volery",
      affected: 1,
      tokens: 0,
      inTokens: 0,
      model: "",
      usd: 0,
      provenance: "receipt",
    },
  ];
  return { tools, sessions, changes, actions: fixtureActions(since, until), changesUnread: false, actionsUnread: false };
}

/** The gesture window the behaviour page's band draws from (§3.10).
 *
 *  Deterministic for one span, and shaped to make the folds *visible* rather
 *  than merely non-empty: a card returned to inside the twenty-second floor
 *  (which is one visit, not two switches), a burst of clicks in one minute, two
 *  walls so the per-machine split has something to split, and a run of quiet
 *  buckets so the strip's gaps are gaps. */
function fixtureActions(since: number, until: number): ActionWindow {
  const span = Math.max(60_000, until - since);
  /* **The same tier the store would answer with.** A span past the fine tier
     has counts and no marks, and the preview has to show that rather than a
     comfortable version of it: the band's whole honest half is what it says
     when the order is gone. */
  const coarse = span > 90 * 24 * 3_600_000;
  const at = (f: number) => Math.round((since + span * f) / 60_000) * 60_000;
  const cards = ["a1", "b2", "c3", "d4"] as const;
  const marks: ActionMark[] = [];
  const cardsFocused = new Map<string, { first: number; last: number; count: number }>();
  let focus = 0;
  for (let i = 0; i < 26; i++) {
    const f = 0.02 + (i / 26) * 0.94;
    /* Every fourth stay is a glance: out and back inside the floor. */
    const card = i % 4 === 0 && i > 0 ? cards[(focus - 2 + 8) % cards.length]! : cards[focus % cards.length]!;
    const at0 = at(f);
    marks.push({ at: at0, host: i % 3 === 0 ? "laptop" : "desk", kind: "focus", target: card });
    const held = cardsFocused.get(card) ?? { first: at0, last: at0, count: 0 };
    held.count++;
    held.last = at0;
    cardsFocused.set(card, held);
    if (i % 4 === 0 && i > 0) continue;
    focus++;
    if (i % 3 === 0) marks.push({ at: at0 + 60_000, host: "desk", kind: "send", target: card });
    if (i % 9 === 4) marks.push({ at: at0 + 120_000, host: "desk", kind: "interrupt", target: card });
  }
  /* The same ladder the reader climbs, so a year is 365 bars rather than half a
     million. */
  const bucket = span > 60 * 24 * 3_600_000 ? 24 * 3_600_000 : span > 2 * 24 * 3_600_000 ? 3_600_000 : 60_000;
  const series: ActionSeriesRow[] = [];
  for (let t = since - (since % bucket); t < until; t += bucket) {
    const f = (t - since) / span;
    /* A working day: busy through the middle, quiet at both ends. */
    const busy = Math.max(0, Math.sin(f * Math.PI));
    if (busy < 0.05) continue;
    series.push({ at: t, kind: "click", count: Math.round(busy * 14) });
    if (busy > 0.5) series.push({ at: t, kind: "send", count: Math.round(busy * 2) });
  }
  /* Names rather than ids, because that is what the store resolves and what the
     table draws: the fixture would otherwise show a row the real page cannot
     produce. */
  const names = new Map([
    ["a1", "the shader representing flow"],
    ["b2", "nova reader for attributes"],
    ["c3", "context menu pass"],
    ["d4", "the harbour chart"],
  ]);
  const cardsOut: ActionSlice[] = [...cardsFocused].flatMap(([key, held]) => [
    {
      key,
      kind: "focus",
      count: held.count,
      first: held.first,
      last: held.last,
      name: names.get(key) ?? "",
    },
    {
      key,
      kind: "send",
      count: marks.filter((m) => m.kind === "send" && m.target === key).length,
      first: held.first,
      last: held.last,
      name: names.get(key) ?? "",
    },
  ]);
  const hosts: ActionSlice[] = ["laptop", "desk"].map((key) => ({
    key,
    kind: "focus",
    count: marks.filter((m) => m.kind === "focus" && m.host === key).length,
    first: since,
    last: until,
    name: "",
  }));
  return {
    from: since,
    to: until,
    bucket,
    coarse,
    marksCapped: false,
    series,
    marks: coarse ? [] : marks,
    cards: cardsOut,
    hosts,
  };
}

/** The preview's behaviour reader: `?tab=behaviour` drives the same component
 *  the app does, with no Tauri behind it. */
export function fixtureBehaviourReader(mode: FixtureMode = "normal"): BehaviourReader {
  return async (from, to) => fixtureBehaviour({ since: from, until: to }, mode);
}

/** The sessions the habits count, with the three opener states and one still
 *  open. Placed across the window so the day bars have a shape. */
function fixtureSessions(since: number, until: number): SessionFact[] {
  const span = Math.max(60_000, until - since);
  const starts = [0.02, 0.1, 0.16, 0.25, 0.38, 0.44, 0.57, 0.63, 0.72, 0.8, 0.88, 0.94];
  const openers: SessionFact["openedBy"][] = [
    "person",
    "person",
    "agent",
    "person",
    "person",
    "agent",
    "person",
    "unknown",
    "person",
    "person",
    "agent",
    "person",
  ];
  const providers = ["anthropic", "anthropic", "deepseek", "anthropic", "anthropic", "anthropic", "deepseek", "anthropic", "anthropic", "anthropic", "deepseek", "anthropic"];
  const projects = ["volery", "nova", "volery", "rise", "volery", "nova", "tx-toolkit", "volery", "atlas", "volery", "nova", "volery"];
  return starts.map((f, i) => {
    const startedAt = Math.round(since + span * f);
    const live = i === starts.length - 1;
    const terminal = i === 10;
    return {
      session: `b${i + 1}`,
      host: "here",
      project: projects[i],
      source: terminal ? "terminal" : "card",
      card: terminal ? "" : `c${i + 1}`,
      /* A terminal session was typed by a person and has no parent card; the
         two fields travel together or the fixture models a thing that cannot
         happen. */
      parentCard: !terminal && openers[i] === "agent" ? "c1" : "",
      openedBy: terminal ? "person" : openers[i],
      branch: "main",
      startedAt,
      endedAt: live ? null : startedAt + Math.round(span * 0.04),
      cliMin: "2.1.300",
      cliMax: "2.1.318",
      accountFirst: providers[i] === "deepseek" ? "@deepseek" : "lyss",
      accountLast: providers[i] === "deepseek" ? "@deepseek" : "lyss",
      providerFirst: providers[i],
      providerLast: providers[i],
      turns: 3 + i,
    };
  });
}

/** The watches the preview's selected card carries, so the block beside its
 *  spend can be looked at without a wall. Two rows and a working delete; the
 *  ids are the ones a real `spend_watch` row would have. */
export function fixtureWatches(): {
  watches: (card: string) => Promise<SpendWatch[]>;
  unwatch: (card: string, id: number) => Promise<boolean>;
} {
  const now = Date.now();
  let rows: SpendWatch[] = [
    {
      id: 1,
      conversationId: "",
      measure: "usd",
      period: "session",
      atValue: 10,
      scope: "self",
      createdAt: now - 3_600_000,
      firedFor: "session:s-1",
      firedAt: now - 1_800_000,
    },
    {
      id: 2,
      conversationId: "",
      measure: "tokens",
      period: "day",
      atValue: 2_000_000,
      scope: "self+children",
      createdAt: now - 600_000,
      firedFor: null,
      firedAt: null,
    },
  ];
  return {
    watches: async (card) => rows.map((w) => ({ ...w, conversationId: card })),
    unwatch: async (_card, id) => {
      const before = rows.length;
      rows = rows.filter((w) => w.id !== id);
      return rows.length < before;
    },
  };
}

export function fixturePromptReader(mode: FixtureMode = "normal", vaultMode: VaultMode = "locked"): PromptReader {
  const now = Date.now();
  let rows = mode === "normal" ? promptRowsFor(now) : [];
  /* A wall with no vault cannot have sealed a body, so `?vault=none` draws the
     state that wall would really be in: every body it saw is waiting on a key
     that has never existed. */
  if (vaultMode === "none") {
    rows = rows.map((r) => (r.bodyState === "sealed" ? { ...r, bodyState: "locked", vaultId: "" } : r));
  }
  let favourites = seedFavourites(rows, now);
  let unlocked = vaultMode === "unlocked";
  let made = vaultMode !== "none";
  /* Nor can a note have been sealed under a key that never existed. */
  if (!made) favourites = favourites.map((f) => ({ ...f, note: null }));

  const state = (): VaultState =>
    asVaultState({
      vaults: made ? [{ vaultId: "fixture-vault", createdAt: now - 30 * 24 * HOUR, unlocked }] : [],
      active: unlocked ? "fixture-vault" : null,
      idleMs: unlocked ? 12 * MINUTE : null,
      bodies: {
        sealed: rows.filter((r) => r.bodyState === "sealed").length,
        locked: rows.filter((r) => r.bodyState === "locked").length,
        withheld: rows.filter((r) => r.bodyState === "withheld").length,
        deleted: rows.filter((r) => r.bodyState === "deleted").length,
        none: rows.filter((r) => r.bodyState === "none").length,
      },
      locators: rows.filter((r) => r.bodyState === "locked").length,
      minPassphrase: 12,
    });

  const noteFor = (f: FavouriteRow): FavouriteRow => ({
    ...f,
    note: unlocked ? f.note : null,
    noteLocked: !unlocked && Boolean(f.note),
  });

  const rowOf = (host: string, id: string) => rows.find((r) => r.host === host && r.promptId === id);

  return {
    async facts(from, to) {
      return rows.filter((r) => r.at >= from && r.at < to);
    },

    async body(host, promptId): Promise<PromptBody> {
      const row = rowOf(host, promptId);
      if (!row) throw new Error("that prompt is not on this wall");
      if (row.bodyState !== "sealed") return { state: row.bodyState, text: null, truncated: false };
      if (!unlocked) return { state: "locked", text: null, truncated: false };
      const at = Math.abs(row.promptId.charCodeAt(1)) % BODIES.length;
      return { state: "sealed", text: BODIES[at], truncated: row.bodyTruncated !== 0 };
    },

    async vault() {
      return state();
    },

    async createVault(passphrase) {
      if (passphrase.length < 12) {
        throw new Error(`a passphrase must be at least 12 characters, and this one is ${passphrase.length}`);
      }
      made = true;
      unlocked = true;
      return state();
    },

    async unlockVault(passphrase) {
      if (passphrase.length < 12) {
        throw new Error(`a passphrase must be at least 12 characters, and this one is ${passphrase.length}`);
      }
      if (!made) throw new Error("this wall has no vault yet, so there is nothing to unlock: create one first");
      unlocked = true;
      return state();
    },

    async lockVault() {
      unlocked = false;
      return state();
    },

    async sealPending(): Promise<SealReport> {
      if (!unlocked) throw new Error("that vault is locked");
      const waiting = rows.filter((r) => r.bodyState === "locked");
      rows = rows.map((r) => (r.bodyState === "locked" ? { ...r, bodyState: "sealed" } : r));
      return { sealed: waiting.length, withheld: 0, unresolved: 0, remaining: 0, unresolvedIds: [] };
    },

    async forget(): Promise<ForgetReport> {
      const bodies = rows.filter(
        (r) => r.bodyState === "sealed" || r.bodyState === "locked" || r.bodyState === "withheld",
      );
      const gone = new Set(bodies.map((r) => `${r.host}/${r.promptId}`));
      const hallGone = favourites.filter((f) => gone.has(`${f.host}/${f.promptId}`)).length;
      favourites = favourites.filter((f) => !gone.has(`${f.host}/${f.promptId}`));
      rows = rows.map((r) => (gone.has(`${r.host}/${r.promptId}`) ? { ...r, bodyState: "deleted" } : r));
      return {
        bodies: bodies.filter((r) => r.bodyState === "sealed").length,
        marked: bodies.length,
        tombstones: bodies.length,
        favourites: hallGone,
      };
    },

    async resetVault(confirm): Promise<ResetReport> {
      if (!confirm) {
        throw new Error(
          "resetting deletes the key and every sealed prompt, and nothing can bring them back, and the call must say confirm",
        );
      }
      const bodies = rows.filter((r) => r.bodyState === "sealed").length;
      const notes = favourites.filter((f) => f.note).length;
      const vaults = made ? 1 : 0;
      made = false;
      unlocked = false;
      rows = rows.map((r) =>
        r.bodyState === "sealed" || r.bodyState === "locked" || r.bodyState === "withheld"
          ? { ...r, bodyState: "deleted" }
          : r,
      );
      favourites = favourites.map((f) => ({ ...f, note: null, noteLocked: false }));
      return { vaults, bodies, tombstones: bodies, notes };
    },

    async overrideKind(host, promptId, kind) {
      rows = rows.map((r) => (r.host === host && r.promptId === promptId ? { ...r, kindOverride: kind } : r));
      favourites = favourites.map((f) =>
        f.host === host && f.promptId === promptId ? { ...f, kindOverride: kind } : f,
      );
    },

    async favourites() {
      return favourites
        .map(noteFor)
        .map((f) => {
          const row = rowOf(f.host, f.promptId);
          return row
            ? {
                ...f,
                at: row.at,
                project: row.project,
                kind: row.kind,
                kindOverride: row.kindOverride,
                bodyState: row.bodyState,
                words: row.words,
              }
            : f;
        })
        .sort((a, b) => b.createdAt - a.createdAt);
    },

    async keepFavourite(input) {
      const row = rowOf(input.host, input.promptId);
      if (!row) throw new Error("that prompt is not on this wall, so there is nothing to keep");
      const title = input.title.trim();
      if (!title) throw new Error("a hall entry needs a title, so it can be found by name later");
      if ([...title].length > 120) throw new Error("a hall title is at most 120 characters");
      /* The same normalisation and the same caps the command applies, or a
         preview review would pass a field the real wall refuses. */
      const tags: string[] = [];
      for (const raw of input.tags) {
        if ([...raw].length > 32) throw new Error("a tag is at most 32 characters, and one of these is longer");
        const tag = raw.trim().toLowerCase();
        if (tag && !tags.includes(tag)) tags.push(tag);
      }
      if (tags.length > 12) throw new Error("a hall entry carries at most 12 tags");
      const existing = favourites.find((f) => f.host === input.host && f.promptId === input.promptId);
      let note = existing?.note ?? null;
      if (input.note !== null) {
        if (!input.note.trim()) note = null;
        else if (!unlocked) throw new Error("a note is sealed, so the vault has to be open before you can keep one");
        else if ([...input.note].length > 2_000) throw new Error("a note is at most 2,000 characters");
        else note = input.note;
      }
      const next: FavouriteRow = {
        host: input.host,
        promptId: input.promptId,
        title,
        tags,
        createdAt: existing?.createdAt ?? Date.now(),
        at: row.at,
        project: row.project,
        kind: row.kind,
        kindOverride: row.kindOverride,
        bodyState: row.bodyState,
        words: row.words,
        /* A made-up card cost, so the gallery's "by the card's cost" sort has
           something to order the entries it did not ship with. */
        cost: existing?.cost ?? Math.round((row.words / 9) * 100) / 100,
        turns: existing?.turns ?? Math.max(1, Math.round(row.words / 30)),
        note,
        noteLocked: false,
      };
      favourites = [
        next,
        ...favourites.filter((f) => `${f.host}/${f.promptId}` !== `${input.host}/${input.promptId}`),
      ];
      return noteFor(next);
    },

    async removeFavourite(host, promptId) {
      const before = favourites.length;
      favourites = favourites.filter((f) => `${f.host}/${f.promptId}` !== `${host}/${promptId}`);
      return favourites.length < before;
    },
  };
}

/* ── a card's life, made up (§11.10) ─────────────────────────────────────── */

/** A card's history for `?card=1`: a card opened on one account, swapped to a
 *  team, moved to DeepSeek and given a wider model, with the spend under each
 *  funding to draw the bar.
 *
 * **The three modes answer the states the block has to tell apart**, which is
 * why it is a fixture rather than a recording:
 *
 *  - `normal` — a life the facts cover from its start, so the bar is a lifetime
 *    share and nothing has to be qualified;
 *  - `quiet` — a card older than the fine tier, so `factsFrom` is inside the
 *    life and the page must say where the token half begins rather than draw a
 *    lifetime share over a recent window;
 *  - `empty` — a card opened and not yet spoken to: no session, no spend, and
 *    a total that must be a dash rather than `$0.00`.
 */
export function fixtureLife(mode: FixtureMode = "normal"): LifeReader {
  return async (card: string): Promise<CardLife | null> => {
    const now = Date.now();
    const day = 86_400_000;
    if (mode === "empty") {
      return {
        card,
        label: "just opened",
        nowSession: "",
        nowAccount: "",
        nowModel: "",
        sessions: [],
        spend: [],
        moves: [],
        usdReported: 0,
        turns: 0,
        factsFrom: 0,
      };
    }
    const old = mode === "quiet";
    const born = now - (old ? 200 : 9) * day;
    /* **The store's two clocks, which the fixture has to have too.** A fact is
       stamped with its five-minute bucket floor while a session's start and a
       move's instant are exact, so a session beginning at 12:03:20 has its
       first fact at 12:00:00 and a move at 12:06:23 is followed by a group at
       12:05:00. A fixture that put the fact after the session start, or the
       move before the group, would hide exactly the arithmetic the page is
       careful about. */
    const bucket = (t: number) => Math.floor(t / (5 * MINUTE)) * (5 * MINUTE);
    const sessionA = "11111111-aaaa-4000-8000-000000000001";
    const sessionB = "11111111-bbbb-4000-8000-000000000002";
    const sessions: SessionFact[] = [
      {
        session: sessionA,
        host: "studio",
        project: "volery",
        source: "card",
        card,
        parentCard: "",
        openedBy: "person",
        branch: "main",
        startedAt: born + 7_000,
        endedAt: born + 5 * day,
        cliMin: "2.1.300",
        cliMax: "2.1.319",
        accountFirst: "lyss",
        accountLast: "tx-team",
        providerFirst: "anthropic",
        providerLast: "anthropic",
        turns: 31,
      },
      {
        session: sessionB,
        host: "studio",
        project: "volery",
        source: "card",
        card,
        parentCard: "",
        openedBy: "person",
        branch: "main",
        startedAt: born + 6 * day + 12 * MINUTE + 5_000,
        endedAt: null,
        cliMin: "2.1.319",
        cliMax: "2.1.319",
        accountFirst: "@deepseek",
        accountLast: "@deepseek",
        providerFirst: "deepseek",
        providerLast: "deepseek",
        turns: 11,
      },
    ];
    const spend: LifeSpend[] = [
      {
        session: sessionA,
        account: "lyss",
        provider: "anthropic",
        model: "claude-opus-5-5",
        firstAt: bucket(born),
        lastAt: bucket(born + 3 * day),
        inTok: 780_000,
        outTok: 61_000,
        cacheRead: 16_400_000,
        write5m: 2_100_000,
        write1h: 900_000,
        requests: 26,
        usd: 23.62,
        unpriced: 0,
      },
      {
        session: sessionA,
        account: "tx-team",
        provider: "anthropic",
        model: "claude-opus-5-5",
        firstAt: bucket(born + 3 * day + 40 * MINUTE),
        lastAt: bucket(born + 5 * day),
        inTok: 210_000,
        outTok: 18_000,
        cacheRead: 5_200_000,
        write5m: 640_000,
        write1h: 200_000,
        requests: 5,
        usd: 9.80,
        unpriced: 0,
      },
      {
        session: sessionB,
        account: "@deepseek",
        provider: "deepseek",
        model: "deepseek-flash",
        firstAt: bucket(born + 6 * day + 12 * MINUTE),
        lastAt: bucket(born + 7 * day),
        inTok: 94_000,
        outTok: 12_000,
        cacheRead: 1_800_000,
        write5m: 0,
        write1h: 0,
        requests: 8,
        usd: 2.94,
        unpriced: 0,
      },
      {
        session: sessionB,
        account: "@deepseek",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        firstAt: bucket(born + 7 * day + 90 * MINUTE),
        lastAt: bucket(now - 40 * MINUTE),
        inTok: 48_000,
        outTok: 9_000,
        cacheRead: 900_000,
        write5m: 0,
        write1h: 0,
        requests: 3,
        usd: 1.74,
        unpriced: 0,
      },
    ];
    return {
      card,
      label: "agent audit",
      nowSession: sessionB,
      nowAccount: "@deepseek",
      nowModel: "deepseek-v4-pro",
      sessions,
      spend,
      moves: [
        { at: born + 3 * day + 40 * MINUTE, kind: "account", reference: "tx-team" },
        { at: born + 6 * day + 12 * MINUTE + 7_000, kind: "provider", reference: "deepseek" },
        { at: born + 7 * day + 90 * MINUTE, kind: "model", reference: "deepseek-v4-pro" },
      ],
      usdReported: 38.1,
      turns: 42,
      /* An old card's facts begin inside its life; a young one's do not. */
      factsFrom: old ? born + 110 * day : born - 30 * day,
    };
  };
}

/* ── the live strip's allowance samples (§11.1), made up ─────────────────── */

/** Two accounts' windows, over the last eight days and up to now.
 *
 * The states the strip has to tell apart: **one session instance that ended at
 * its own reset** (90 points, which the day keeps), **the current one behind it**
 * (68 points, so the last day is 158% of the five-hour allowance and the block
 * can be seen saying so), and **a weekly window on each account**, so the binding
 * tile is a choice between accounts rather than the only number there is. The
 * stamps are stable inside an instance and move only at the reset: a fixture
 * that drifts one is a fixture that loses the delta it meant to sum.
 * Sources alternate so the sample list carries all three doors.
 */
export function fixtureAllowanceSamples(from: number, to: number): AllowanceSample[] {
  const now = Math.min(to, Date.now());
  const out: AllowanceSample[] = [];
  const push = (
    at: number,
    account: string,
    kind: string,
    used: number,
    resetsAt: number | null,
    source: AllowanceSample["source"] = "poll",
  ) => {
    if (at < from || at > now) return;
    out.push({
      at,
      host: "studio",
      account,
      kind,
      scope: "",
      used,
      resetsAt,
      severity: "normal",
      plan: "team",
      source,
    });
  };
  /* The five-hour window, twice today. The first instance fills and is given
     back at its reset; the second is the one the wall is in now. */
  const firstReset = now - 4 * HOUR;
  const first = [0, 18, 40, 63, 90];
  for (let i = 0; i < first.length; i++) {
    push(now - 9 * HOUR + i * (5 * HOUR) / (first.length - 1), "lyss", "session", first[i], firstReset);
  }
  const sessionReset = now + 1.2 * HOUR;
  const second = [0, 9, 22, 35, 47, 58, 68];
  for (let i = 0; i < second.length; i++) {
    push(
      now - 3.5 * HOUR + (i * 3.5 * HOUR) / (second.length - 1),
      "lyss",
      "session",
      second[i],
      sessionReset,
      i % 3 === 0 ? "stream" : "poll",
    );
  }
  /* The week, on each account: slower, and it resets days out. */
  const lyssWeek = now + 1 * 24 * HOUR;
  const lyssWeekAt = [34, 35.2, 36.5, 38.4, 40, 41, 41.6];
  for (let i = 0; i < lyssWeekAt.length; i++) {
    push(now - 6 * 24 * HOUR + i * 24 * HOUR, "lyss", "weekly_all", lyssWeekAt[i], lyssWeek);
  }
  const weekReset = now + 4 * 24 * HOUR;
  for (let i = 0; i < 16; i++) {
    push(
      now - (15 - i) * 12 * HOUR,
      "tx-team",
      "weekly_all",
      40 + i * 0.4,
      weekReset,
      i === 0 ? "peer" : "poll",
    );
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The day's turns, grouped by funding, for the preview's block (§21). */
export function fixtureFundings(): FundingRow[] {
  return [
    { label: "@deepseek", kind: "provider", usd: 50, tokens: 2_100_000, turns: 11 },
    { label: "@credits", kind: "credits", usd: 40, tokens: 860_000, turns: 6 },
    { label: "lyss", kind: "plan", usd: 30, tokens: 1_240_000, turns: 18 },
  ];
}

/** The flyway's two readings, for the preview's strip. */
export const FIXTURE_FLEET = {
  rate: 24_130,
  parts: [
    { host: null, rate: 20_130 },
    { host: "lab.queerisfreedom", rate: 4_000 },
  ],
  silent: [],
  cards: 7,
  local: 5,
  measured: true,
};

/** The fine-tier cost buckets the residual is split against, made up: a request
 *  every twenty minutes for a week, on three models and two accounts, priced by
 *  the real table so the preview's dollars are the table's. */
export function fixtureAllowanceCosts(from: number, to: number): AllowanceCost[] {
  const now = Math.min(to, Date.now());
  const step = 5 * MINUTE;
  const models = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"];
  const out: AllowanceCost[] = [];
  let i = 0;
  /* `tx-team`'s own requests stop six tenths of the way through, so the week's
     later sample intervals have nothing to attribute to them and the residual
     tile has something true to draw. A fixture where every interval has facts
     can only ever say 0 points, which is the one reading that shows nothing. */
  const txStops = from + Math.round((now - from) * 0.6);
  for (let at = Math.ceil(from / step) * step; at < now; at += 20 * MINUTE) {
    if (i % 4 === 0 && at >= txStops) {
      i++;
      continue;
    }
    out.push({
      at,
      host: "studio",
      session: `fixture-session-${i % 3}`,
      account: i % 4 === 0 ? "tx-team" : "lyss",
      provider: "anthropic",
      model: models[i % models.length],
      provenance: "transcript",
      inTok: 700,
      outTok: 90,
      cacheRead: 24_000,
      write5m: 1_800,
      write1h: 0,
      requests: 1,
    });
    i++;
  }
  return out;
}
