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
import type { Fact, HourFact, UsageRow } from "./analytics";
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
