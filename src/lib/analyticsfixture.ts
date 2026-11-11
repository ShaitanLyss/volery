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
