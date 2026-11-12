/* The day's spend in every currency, and the funding split (§21).
 *
 * The arithmetic that matters here is the join between two clocks: turns carry
 * money in the currency they were billed in, samples carry allowance points on
 * the clock each window resets on. A day can hold more than one five-hour
 * window, which is why the percentage a day produces can exceed 100 without
 * anything being wrong.
 */

import { describe, expect, test } from "bun:test";
import {
  exchangesOf,
  fundingLine,
  fundingOf,
  fundingReadings,
  fundingSaid,
  usdPerPoint,
  windowSpend,
  asFundingRow,
  type FundingRow,
} from "../src/lib/fundings";
import { instancesOf, type AllowanceSample, type WindowInstance } from "../src/lib/allowancesamples";
import { fixtureAllowanceSamples, fixtureFundings } from "../src/lib/analyticsfixture";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function row(label: string, usd: number, tok = 1_000, turns = 1): FundingRow {
  return { label, kind: fundingOf(label), usd, tokens: tok, turns };
}

function sample(
  at: number,
  used: number,
  account = "lyss",
  kind = "session",
  resetsAt: number | null = at + 5 * HOUR,
): AllowanceSample {
  return { at, host: "desk", account, kind, scope: "", used, resetsAt, source: "poll" };
}

/** One five-hour instance that filled `steps` in order, then a reset. */
function instance(
  from: number,
  steps: number[],
  { account = "lyss", kind = "session", resetsAt = from + 5 * HOUR } = {},
): WindowInstance {
  let last = steps[0] ?? 0;
  const points = steps.map((used, i) => ({ at: from + i * HOUR, used }));
  let delta = 0;
  for (let i = 1; i < points.length; i++) delta += Math.max(0, points[i].used - points[i - 1].used);
  last = points.length ? points[points.length - 1].used : last;
  return {
    account,
    kind,
    scope: "",
    resetsAt,
    from,
    to: points.length ? points[points.length - 1].at : from,
    first: points[0]?.used ?? 0,
    last,
    delta,
    points,
    hosts: ["desk"],
  };
}

describe("fundingOf", () => {
  test("a plain label is a subscription", () => {
    expect(fundingOf("lyss")).toBe("plan");
    expect(fundingOf("work-max")).toBe("plan");
  });

  test("@credits is anthropic's own credits", () => {
    expect(fundingOf("@credits")).toBe("credits");
  });

  test("another @ sentinel is a provider", () => {
    expect(fundingOf("@deepseek")).toBe("provider");
    expect(fundingOf("@anything-else")).toBe("provider");
  });

  test("no label is still a plan, because it is the cli's sign-in", () => {
    expect(fundingOf("")).toBe("plan");
  });
});

describe("windowSpend", () => {
  test("sums a day across every instance of one kind, which is how a day passes 100%", () => {
    const instances = [
      instance(0, [0, 90], { resetsAt: 5 * HOUR }),
      instance(6 * HOUR, [0, 68], { resetsAt: 11 * HOUR }),
    ];
    const got = windowSpend(instances, 0, DAY);
    expect(got).toEqual([{ account: "lyss", kind: "session", scope: "", points: 158 }]);
  });

  test("two scoped windows of one kind are two rows, because they are two currencies", () => {
    const instances = [
      instance(0, [0, 30], { kind: "weekly_scoped" }),
      instance(0, [0, 12], { kind: "weekly_scoped" }),
    ];
    instances[0].scope = "opus";
    instances[1].scope = "sonnet";
    const got = windowSpend(instances, 0, DAY);
    expect(got.map((r) => [r.scope, r.points])).toEqual([
      ["opus", 30],
      ["sonnet", 12],
    ]);
  });

  test("a covered hour that did not move is a measured zero, not a missing one", () => {
    const got = windowSpend([instance(0, [20, 20])], 0, DAY);
    expect(got).toEqual([{ account: "lyss", kind: "session", scope: "", points: 0 }]);
  });

  test("one instance inside the window and one outside: only the first counts", () => {
    const instances = [
      instance(0, [0, 60]),
      instance(2 * DAY, [0, 30]),
    ];
    expect(windowSpend(instances, 0, DAY)[0].points).toBe(60);
  });

  test("a step straddling the boundary contributes its overlap's share", () => {
    /* A single step from 10:00 (10%) to 11:00 (50%): 40 points over the hour.
       Half an hour of it is inside a window that starts at 10:30. */
    const one = instance(0, [0]); // a placeholder we then reshape
    one.points = [
      { at: 10 * HOUR, used: 10 },
      { at: 11 * HOUR, used: 50 },
    ];
    one.from = 10 * HOUR;
    one.to = 11 * HOUR;
    one.first = 10;
    one.last = 50;
    one.delta = 40;
    expect(windowSpend([one], 10.5 * HOUR, DAY)[0].points).toBeCloseTo(20);
  });

  test("each window kind is its own row and they are never summed", () => {
    const instances = [
      instance(0, [0, 40], { kind: "session" }),
      instance(0, [0, 10], { kind: "weekly_all", resetsAt: 7 * DAY }),
    ];
    const got = windowSpend(instances, 0, DAY);
    expect(got.map((r) => [r.kind, r.points])).toEqual([
      ["session", 40],
      ["weekly_all", 10],
    ]);
  });

  test("a provider sentinel has no allowance and is skipped", () => {
    const instances = [instance(0, [0, 50], { account: "@deepseek" })];
    expect(windowSpend(instances, 0, DAY)).toEqual([]);
  });

  test("a window with no samples inside contributes nothing and covers nothing", () => {
    const instances = [instance(2 * DAY, [0, 30])];
    expect(windowSpend(instances, 0, DAY)).toEqual([]);
    expect(windowSpend(instances, 0, 0)).toEqual([]);
  });

  test("a real sample series folds through instancesOf and lands on the same reading", () => {
    /* The stamp is stable across the instance and moves only at the reset;
       `instancesOf` closes an instance on a moved stamp, so a fixture that
       drifts it loses the delta it was trying to sum. */
    const samples: AllowanceSample[] = [
      sample(0, 0, "lyss", "session", 5 * HOUR),
      sample(HOUR, 90, "lyss", "session", 5 * HOUR),
      sample(6 * HOUR, 0, "lyss", "session", 11 * HOUR),
      sample(7 * HOUR, 68, "lyss", "session", 11 * HOUR),
    ];
    const instances = instancesOf(samples);
    expect(windowSpend(instances, 0, DAY)[0].points).toBe(158);
  });
});

describe("fundingReadings", () => {
  test("joins a plan row to its account's windows and leaves credits without any", () => {
    const instances = [
      instance(0, [0, 90]),
      instance(6 * HOUR, [0, 68], { resetsAt: 11 * HOUR }),
      instance(0, [0, 12], { kind: "weekly_all", resetsAt: 7 * DAY }),
    ];
    const readings = fundingReadings(
      [row("@deepseek", 50), row("@credits", 40), row("lyss", 30)],
      instances,
      0,
      DAY,
    );
    const plan = readings.find((r) => r.label === "lyss")!;
    const credits = readings.find((r) => r.label === "@credits")!;
    const provider = readings.find((r) => r.label === "@deepseek")!;
    expect(plan.windows).toEqual([
      { kind: "session", scope: "", points: 158 },
      { kind: "weekly_all", scope: "", points: 12 },
    ]);
    expect(credits.windows).toEqual([]);
    expect(provider.windows).toEqual([]);
    expect(readings.map((r) => r.usd)).toEqual([50, 40, 30]);
  });

  test("a plan with no sample covering the day reports no windows, not zero percent", () => {
    const readings = fundingReadings([row("newplan", 10)], [], 0, DAY);
    expect(readings[0].windows).toEqual([]);
  });
});

describe("usdPerPoint", () => {
  test("is the attributed cost over the points the window moved", () => {
    expect(usdPerPoint(63, 150)).toBeCloseTo(0.42);
  });

  test("no points moved, or nothing priced, means no rate rather than a free one", () => {
    expect(usdPerPoint(10, 0)).toBeNull();
    expect(usdPerPoint(0, 0)).toBeNull();
    expect(usdPerPoint(0, 20)).toBeNull();
  });

  test("an exchange exists only where both reads did", () => {
    const instances = [instance(0, [0, 20])];
    const priced = exchangesOf(instances, [{ at: 0, host: "desk", account: "lyss", cost: 3 }], [
      { label: "lyss", kind: "plan", usd: 3, tokens: 0, turns: 1, windows: [{ kind: "session", scope: "", points: 20 }] },
      { label: "@credits", kind: "credits", usd: 2, tokens: 0, turns: 1, windows: [] },
    ]);
    expect(priced).toEqual([{ account: "lyss", kind: "session", scope: "", usdPerPoint: 0.15 }]);
    /* The same window with no fact read: a percentage, and no rate. */
    expect(
      exchangesOf(instances, [], [
        { label: "lyss", kind: "plan", usd: 3, tokens: 0, turns: 1, windows: [{ kind: "session", scope: "", points: 20 }] },
      ]),
    ).toEqual([]);
  });
});

describe("saying it", () => {
  test("names each kind of funding the way the wall speaks", () => {
    expect(fundingSaid("lyss", "plan")).toBe("lyss");
    expect(fundingSaid("@credits", "credits")).toBe("anthropic api credits");
    expect(fundingSaid("@deepseek", "provider")).toBe("deepseek credits");
    expect(fundingSaid("", "plan")).toBe("the signed-in account");
  });

  test("the money-only line keeps the currencies apart", () => {
    expect(
      fundingLine([row("@deepseek", 50), row("@credits", 40), row("lyss", 30)]),
    ).toBe("deepseek credits $50.00 · anthropic api credits $40.00 · lyss $30.00");
  });
});

describe("the preview fixture", () => {
  test("is the user's own example: 158% of the five-hour window, and three fundings", () => {
    const now = new Date(2026, 10, 12, 15, 0).getTime();
    const samples = fixtureAllowanceSamples(now - 8 * DAY, now);
    const instances = instancesOf(samples);
    const readings = fundingReadings(fixtureFundings(), instances, now - DAY, now);
    const plan = readings.find((r) => r.label === "lyss")!;
    expect(plan.windows.find((w) => w.kind === "session")!.points).toBe(158);
    expect(readings.map((r) => r.label)).toEqual(["@deepseek", "@credits", "lyss"]);
  });
});

describe("asFundingRow", () => {
  test("reads the grouped row the command answers, deriving the kind from the label", () => {
    expect(asFundingRow({ label: "@credits", usd: 2, tokens: 30, turns: 1 })).toEqual({
      label: "@credits",
      kind: "credits",
      usd: 2,
      tokens: 30,
      turns: 1,
    });
    expect(asFundingRow({ label: "lyss", usd: 0, tokens: 0, turns: 1 })?.kind).toBe("plan");
  });

  test("refuses a row with impossible money rather than drawing a negative", () => {
    expect(asFundingRow({ label: "lyss", usd: -1, tokens: 0, turns: 1 })).toBeNull();
    expect(asFundingRow({ label: "lyss", usd: 1, tokens: NaN, turns: 1 })).toBeNull();
    expect(asFundingRow(null)).toBeNull();
  });
});

