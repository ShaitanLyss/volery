/* The fold behind the cap: what the panel draws and what the door compares.
 *
 * The arithmetic is `allowancesamples.ts::ownPoints` and is tested there. What
 * is asserted here is the reading's *scope* and its three states, because those
 * are what decide whether a cap is measured against one window or four, and
 * whether "this wall spent nothing" is told apart from "this wall's spend could
 * not be priced".
 */

import { describe, expect, test } from "bun:test";
import { ownUses, type AllowanceCost, type AllowanceSample } from "../src/lib/allowancesamples";

const NOW = Date.UTC(2026, 10, 13, 3, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

/** One window read twice, ten points apart, an hour before it rolls. */
function samples(used: number[], over: Partial<AllowanceSample> = {}): AllowanceSample[] {
  return used.map((u, i) => ({
    at: NOW + i * 10 * MIN,
    host: "studio",
    account: "lyss",
    kind: "session",
    scope: "",
    used: u,
    resetsAt: NOW + HOUR,
    severity: "normal",
    plan: "max",
    source: "poll",
    ...over,
  }));
}

function costs(at = NOW, over: Partial<AllowanceCost> = {}): AllowanceCost[] {
  return [
    {
      at,
      host: "studio",
      session: "s-1",
      account: "lyss",
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      provenance: "transcript",
      card: "card-1",
      inTok: 1_000,
      outTok: 0,
      cacheRead: 0,
      write5m: 0,
      write1h: 0,
      requests: 1,
      ...over,
    },
  ];
}

describe("the share the wall keeps", () => {
  test("is the movement the fact covered, with the reading it is a share of", () => {
    const [got] = ownUses(samples([10, 20]), costs());
    expect(got!.points).toBe(10);
    expect(got!.moved).toBe(10);
    expect(got!.priced).toBeGreaterThan(0);
    expect(got!.worked).toBe(true);
    expect(got!.used).toBe(20);
    expect(got!.resetsAt).toBe(NOW + HOUR);
  });

  /* The difference the cap's fallback turns on: this wall spent nothing in the
     window (a share of zero, whatever the account reads) against this wall
     spent something that could not be priced (unknown). */
  test("says whether this wall worked at all, priced or not", () => {
    const [quiet] = ownUses(samples([10, 20]), []);
    expect(quiet!.worked).toBe(false);
    expect(quiet!.priced).toBe(0);

    /* A request whose model the price table cannot place is still work. */
    const [unpriced] = ownUses(samples([10, 20]), costs(NOW, { model: "a-model-from-2027" }));
    expect(unpriced!.worked).toBe(true);
  });

  test("an account nobody measured answers with nothing", () => {
    expect(ownUses(samples([10, 20]), costs()).find((r) => r.account === "tx-team")).toBeUndefined();
  });

  /* A window rolled is a new instance, and a sum over instances is four times
     the scale of the reading a cap is compared against. One row per kind. */
  test("only the window that is open now is what it keeps", () => {
    const rolled = [
      ...samples([0, 10]),
      ...samples([0, 5]).map((s) => ({
        ...s,
        at: s.at + 5 * HOUR,
        resetsAt: s.resetsAt + 5 * HOUR,
      })),
    ];
    const rows = ownUses(rolled, [...costs(NOW), ...costs(NOW + 5 * HOUR)]);
    expect(rows.length).toBe(1);
    expect(rows[0]!.points).toBe(5);
  });

  test("a subscription sentinel has no window to share", () => {
    expect(ownUses(samples([0, 10], { account: "@credits" }), costs())).toEqual([]);
  });

  /* Two scoped windows of one kind would each credit the same cost buckets, and
     a cap keys on the kind, so it would be compared against a doubled figure.
     Left out rather than summed, and the cap falls back to the account's own
     percentage for that kind — the behaviour it had before any of this. */
  test("a scoped window is left out rather than summed", () => {
    expect(ownUses(samples([0, 10], { scope: "Opus" }), costs())).toEqual([]);
  });
});

/* A bucket that begins before the window still overlaps it, and `spansOf`
   credits exactly those — so the flag has to be taken over the same buckets or
   it says this wall did nothing about a window it demonstrably moved. */
describe("a bucket that straddles the opening of a window", () => {
  test("counts as work in that window", () => {
    const [got] = ownUses(samples([10, 20]), costs(NOW - 2 * MIN));
    expect(got!.worked).toBe(true);
  });

  test("and one from well before it does not", () => {
    const [got] = ownUses(samples([10, 20]), costs(NOW - 30 * MIN));
    expect(got!.worked).toBe(false);
  });
});
