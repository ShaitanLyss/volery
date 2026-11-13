/* The reader behind the cap: what the panel draws and what the door compares.
 *
 * The arithmetic itself is `allowancesamples.ts::ownPoints` and is tested
 * there. What is asserted here is the reading's *scope* — one window per kind,
 * keyed by account label, rebuilt on every read — because that is the part that
 * decides whether a cap is measured against one window or four.
 */

import { describe, expect, test } from "bun:test";
import { OwnShare } from "../src/lib/ownshare.svelte";
import type { AllowanceCost, AllowanceSample } from "../src/lib/allowancesamples";

const NOW = Date.UTC(2026, 10, 13, 3, 0, 0);
const MIN = 60_000;

/** One window read twice, ten points apart, an hour before it rolls. */
function samples(used: number[]): AllowanceSample[] {
  return used.map((u, i) => ({
    at: NOW + i * 10 * MIN,
    host: "studio",
    account: "lyss",
    kind: "session",
    scope: "",
    used: u,
    resetsAt: NOW + 3_600_000,
    severity: "normal",
    plan: "max",
    source: "poll",
  }));
}

function costs(at = NOW): AllowanceCost[] {
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
    },
  ];
}

describe("the share the wall keeps", () => {
  test("is the movement the fact covered, per account", () => {
    const own = new OwnShare();
    own.settle(samples([10, 20]), costs());
    const [got] = own.list("lyss");
    expect(got!.points).toBe(10);
    expect(got!.moved).toBe(10);
    expect(got!.priced).toBeGreaterThan(0);
  });

  /* An account with no reading is *not measured*, which every caller has to be
     able to tell from a share of zero — the cap's whole fallback turns on it. */
  test("an account nobody measured answers with nothing", () => {
    const own = new OwnShare();
    own.settle(samples([10, 20]), costs());
    expect(own.list("tx-team")).toEqual([]);
  });

  /* A window rolled is a new instance, and a sum over instances is four times
     the scale of the reading a cap is compared against. One row per kind. */
  test("only the window that is open now is what it keeps", () => {
    const own = new OwnShare();
    const rolled: AllowanceSample[] = [
      ...samples([0, 10]),
      ...samples([0, 5]).map((s) => ({
        ...s,
        at: s.at + 5 * 3_600_000,
        resetsAt: s.resetsAt + 5 * 3_600_000,
      })),
    ];
    own.settle(rolled, [...costs(NOW), ...costs(NOW + 5 * 3_600_000)]);
    const rows = own.list("lyss");
    expect(rows.length).toBe(1);
    expect(rows[0]!.points).toBe(5);
  });

  test("a second read replaces the first rather than adding to it", () => {
    const own = new OwnShare();
    own.settle(samples([0, 10]), costs());
    own.settle(samples([0, 3]), costs());
    expect(own.list("lyss").map((r) => r.points)).toEqual([3]);
  });

  test("a subscription sentinel has no window to share", () => {
    const own = new OwnShare();
    own.settle(
      samples([0, 10]).map((s) => ({ ...s, account: "@credits" })),
      costs(),
    );
    expect(own.list("@credits")).toBeDefined();
    expect(own.list("@credits").length === 0 || own.list("@credits")[0]!.points === 0).toBe(true);
  });
});
