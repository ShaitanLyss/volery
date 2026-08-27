import { describe, expect, test } from "bun:test";
import {
  BLOCK_MS,
  HOUR,
  WEEK_MS,
  amount,
  blockAt,
  blocks,
  costStep,
  count,
  dayStart,
  leaders,
  left,
  money,
  rateFor,
  readings,
  share,
  shortModel,
  sum,
  turnRowKind,
  type Slice,
} from "../src/lib/usage";

/** A bucket, with only the fields a case cares about spelled out. */
function slice(at: number, over: Partial<Slice> = {}): Slice {
  return {
    at,
    model: "claude-opus-5",
    input: 0,
    output: 0,
    cacheRead: 0,
    write5m: 0,
    write1h: 0,
    ...over,
  };
}

const T0 = Date.UTC(2026, 7, 14, 12, 0, 0);

describe("what a token costs", () => {
  test("every model in the table prices", () => {
    expect(rateFor("claude-opus-5")).toEqual({ input: 5, output: 25 });
    expect(rateFor("claude-sonnet-5")).toEqual({ input: 3, output: 15 });
    expect(rateFor("claude-haiku-4-5")).toEqual({ input: 1, output: 5 });
    expect(rateFor("claude-fable-5")).toEqual({ input: 10, output: 50 });
  });

  /* `system/init` gives the configured id with its window tier attached — see
     the note in classify.ts. A ring is not a price. */
  test("a window tier is not part of the model's name", () => {
    expect(rateFor("claude-opus-5[1m]")).toEqual(rateFor("claude-opus-5"));
  });

  /* The one failure this widget must not have: a model released after the build
     shipped pricing at nothing, so the reading silently reads low for the model
     you are actually using. */
  test("a model this build has never heard of prices by its tier", () => {
    expect(rateFor("claude-opus-9")).toEqual(rateFor("claude-opus-5"));
    expect(rateFor("claude-sonnet-7-2")).toEqual(rateFor("claude-sonnet-5"));
    expect(rateFor("claude-haiku-6")).toEqual(rateFor("claude-haiku-4-5"));
  });

  test("a model matching no tier at all is refused rather than guessed", () => {
    expect(rateFor("gpt-4")).toBeNull();
    expect(rateFor("")).toBeNull();
  });
});

describe("totalling", () => {
  test("the four kinds of token are priced apart", () => {
    /* One million of each, on Opus 5: input $5, output $25, cache read $0.50,
       a 5-minute write $6.25, an hour write $10. */
    const t = sum(
      [
        slice(T0, { input: 1e6 }),
        slice(T0, { output: 1e6 }),
        slice(T0, { cacheRead: 1e6 }),
        slice(T0, { write5m: 1e6 }),
        slice(T0, { write1h: 1e6 }),
      ],
      T0,
      T0 + 1,
    );
    expect(t.usd).toBeCloseTo(5 + 25 + 0.5 + 6.25 + 10, 6);
    expect(t.tokens).toBe(5e6);
  });

  /* The split `migrate_v7` had to make in SQLite, one level further down: an
     hour-TTL write is 1.6x a five-minute one, so adding them together would
     make the column unreadable. */
  test("the two cache-write TTLs are not one number", () => {
    const five = sum([slice(T0, { write5m: 1e6 })], T0, T0 + 1);
    const hour = sum([slice(T0, { write1h: 1e6 })], T0, T0 + 1);
    expect(hour.usd / five.usd).toBeCloseTo(2 / 1.25, 6);
  });

  test("an unpriced model contributes tokens and no cost", () => {
    const t = sum([slice(T0, { model: "some-other-llm", output: 1000 })], T0, T0 + 1);
    expect(t.usd).toBe(0);
    expect(t.tokens).toBe(1000);
    expect(t.unpriced).toBe(1000);
  });

  test("the window is half open, so a bucket is never counted twice", () => {
    const s = [slice(T0, { output: 1 }), slice(T0 + 10, { output: 1 })];
    expect(sum(s, T0, T0 + 10).tokens).toBe(1);
    expect(sum(s, T0 + 10, T0 + 20).tokens).toBe(1);
  });

  test("share never runs past its own end, and has no opinion about nothing", () => {
    expect(share(5, 10)).toBe(0.5);
    expect(share(50, 10)).toBe(1);
    expect(share(5, 0)).toBe(0);
    expect(share(-5, 10)).toBe(0);
  });
});

/* Written to hold in whatever zone the machine running them is in — the claim
   is about the *local* calendar, so nothing here may name an offset. */
describe("the local day", () => {
  test("it lands on the local midnight of the moment's own date", () => {
    const noon = new Date(2026, 7, 14, 12, 34, 56, 789).getTime();
    const d = new Date(dayStart(noon));
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([
      0, 0, 0, 0,
    ]);
    expect(d.getDate()).toBe(14);
    expect(d.getMonth()).toBe(7);
  });

  test("every moment of one local day answers the same start", () => {
    const first = new Date(2026, 7, 14, 0, 0, 0, 0).getTime();
    const last = new Date(2026, 7, 14, 23, 59, 59, 999).getTime();
    expect(dayStart(first)).toBe(first);
    expect(dayStart(last)).toBe(first);
    expect(dayStart(first - 1)).toBeLessThan(first);
  });

  /* The reason this is `Date.setHours` and not `now - (now % DAY)`: a day is
     23 or 25 hours long on the two days a year a timezone moves, and the
     modulo would have the boundary drifting by an hour for the rest of the
     year. Passes in a zone with no DST too — every day is simply 24. */
  test("consecutive days are a day apart, give or take a changeover", () => {
    let at = new Date(2026, 0, 1, 12, 0, 0).getTime();
    let prev = dayStart(at);
    for (let i = 0; i < 400; i++) {
      at += 24 * HOUR;
      const start = dayStart(at);
      const gap = start - prev;
      expect(gap).toBeGreaterThanOrEqual(23 * HOUR);
      expect(gap).toBeLessThanOrEqual(25 * HOUR);
      expect(new Date(start).getHours()).toBe(0);
      prev = start;
    }
  });

  test("asking again about a start returns it unchanged", () => {
    const start = dayStart(new Date(2026, 7, 14, 12, 0, 0).getTime());
    expect(dayStart(start)).toBe(start);
  });
});

describe("the five-hour block", () => {
  test("a block opens on the hour the first turn landed in", () => {
    const at = Date.UTC(2026, 7, 14, 9, 37, 0);
    const [b] = blocks([slice(at)]);
    expect(b.from).toBe(Date.UTC(2026, 7, 14, 9, 0, 0));
    expect(b.to).toBe(b.from + BLOCK_MS);
  });

  test("everything inside an open block joins it", () => {
    const from = Date.UTC(2026, 7, 14, 9, 0, 0);
    const all = blocks([
      slice(from),
      slice(from + HOUR),
      slice(from + 4 * HOUR + 59 * 60_000),
    ]);
    expect(all).toHaveLength(1);
  });

  /* No gap rule is needed and none is written: a turn five hours after the last
     one is necessarily outside whatever block that one was in. */
  test("the first turn past a block's end opens the next one", () => {
    const from = Date.UTC(2026, 7, 14, 9, 0, 0);
    const all = blocks([slice(from), slice(from + BLOCK_MS)]);
    expect(all).toHaveLength(2);
    expect(all[1].from).toBe(from + BLOCK_MS);
  });

  test("blocks come out oldest first however the buckets arrived", () => {
    const from = Date.UTC(2026, 7, 14, 9, 0, 0);
    const all = blocks([slice(from + 2 * BLOCK_MS), slice(from)]);
    expect(all.map((b) => b.from)).toEqual([from, from + 2 * BLOCK_MS]);
  });

  test("nothing said for five hours means no block is open", () => {
    const long = T0 - BLOCK_MS - HOUR;
    expect(blockAt([slice(long)], T0)).toBeNull();
    expect(blockAt([], T0)).toBeNull();
  });

  test("a block that has not run out yet is the one we are in", () => {
    const b = blockAt([slice(T0 - HOUR)], T0);
    expect(b).not.toBeNull();
    expect(b!.from).toBeLessThanOrEqual(T0);
    expect(b!.to).toBeGreaterThan(T0);
  });
});

describe("the two readings", () => {
  /* The whole reason the near window is a block rather than a rolling five
     hours. Work done inside the same block counts however long ago it was;
     work in the block before does not count at all, however recent. */
  test("the five hours is a block, not the last five hours of wall clock", () => {
    /* One block, opened by the earlier turn: 08:00 through 13:00 contains both,
       and contains `now` at 12:00. */
    const s = [
      slice(Date.UTC(2026, 7, 14, 8, 30, 0), { output: 1000 }),
      slice(Date.UTC(2026, 7, 14, 9, 30, 0), { output: 500 }),
    ];
    expect(readings(s, T0, "tokens").block.totals.tokens).toBe(1500);

    /* Two blocks. The older turn is in a closed one and is not this block's. */
    const apart = [
      slice(T0 - 2 * BLOCK_MS, { output: 1000 }),
      slice(Date.UTC(2026, 7, 14, 9, 30, 0), { output: 500 }),
    ];
    expect(readings(apart, T0, "tokens").block.totals.tokens).toBe(500);
  });

  test("the week is rolling, and the block has the only reset", () => {
    const r = readings([slice(T0 - HOUR, { output: 10 })], T0, "tokens");
    expect(r.week.resetsIn).toBeNull();
    expect(r.block.resetsIn).not.toBeNull();
    expect(r.block.resetsIn!).toBeLessThanOrEqual(BLOCK_MS);
  });

  test("a week counts seven days back and no further", () => {
    const s = [
      slice(T0 - WEEK_MS + HOUR, { output: 100 }),
      slice(T0 - WEEK_MS - HOUR, { output: 999 }),
    ];
    expect(readings(s, T0, "tokens").week.totals.tokens).toBe(100);
  });

  /* No fraction here is a fraction of an allowance — nothing on the machine
     knows one. Each is drawn against the wall's own history, and says so. */
  test("the block is drawn against the busiest other block of the week", () => {
    const busy = T0 - 3 * BLOCK_MS;
    const s = [slice(busy, { output: 1000 }), slice(T0 - HOUR, { output: 250 })];
    const r = readings(s, T0, "tokens");
    expect(r.block.against?.amount).toBe(1000);
    expect(r.block.frac).toBeCloseTo(0.25, 6);
  });

  test("the current block is never its own reference", () => {
    const r = readings([slice(T0 - HOUR, { output: 500 })], T0, "tokens");
    expect(r.block.against).toBeNull();
    expect(r.block.frac).toBe(0);
  });

  test("the week is drawn against the week before it", () => {
    const s = [
      slice(T0 - HOUR, { output: 100 }),
      slice(T0 - WEEK_MS - HOUR, { output: 400 }),
    ];
    const r = readings(s, T0, "tokens");
    expect(r.week.against?.amount).toBe(400);
    expect(r.week.frac).toBeCloseTo(0.25, 6);
  });

  test("a first day has nothing honest to compare against", () => {
    const r = readings([slice(T0 - HOUR, { output: 100 })], T0, "tokens");
    expect(r.week.against).toBeNull();
    expect(r.week.frac).toBe(0);
  });

  test("an empty ledger reads as nothing rather than as a hole", () => {
    const r = readings([], T0, "cost");
    expect(r.block.totals.usd).toBe(0);
    expect(r.week.totals.tokens).toBe(0);
    expect(r.block.resetsIn).toBeNull();
    expect(Number.isFinite(r.block.frac)).toBe(true);
    expect(Number.isFinite(r.week.frac)).toBe(true);
  });

  /* The measure changes what "busiest" means, so it has to reach the reference
     too — otherwise a bar in tokens would be drawn against a peak in dollars. */
  test("the reference is measured in the same units as the reading", () => {
    const s = [
      /* Cheap but enormous: cache reads are a tenth of an input token. */
      slice(T0 - 3 * BLOCK_MS, { cacheRead: 10e6 }),
      /* Dear but small. */
      slice(T0 - HOUR, { output: 1e6 }),
    ];
    expect(readings(s, T0, "tokens").block.frac).toBeCloseTo(0.1, 6);
    /* $5 of cache reads against $25 of output — the current block is heavier. */
    expect(readings(s, T0, "cost").block.frac).toBe(1);
  });

  test("amount picks the number the measure asked for", () => {
    const t = sum([slice(T0, { output: 1e6 })], T0, T0 + 1);
    expect(amount(t, "tokens")).toBe(1e6);
    expect(amount(t, "cost")).toBeCloseTo(25, 6);
  });
});

describe("where it went", () => {
  test("models come back heaviest first", () => {
    const s = [
      slice(T0, { model: "claude-haiku-4-5", output: 1e6 }),
      slice(T0, { model: "claude-opus-5", output: 1e6 }),
      slice(T0, { model: "claude-sonnet-5", output: 1e6 }),
    ];
    const l = leaders(s, T0 - HOUR, T0 + HOUR, "cost");
    expect(l.map((r) => r.model)).toEqual([
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
  });

  test("a model that cost nothing is not a leader", () => {
    const s = [slice(T0, { model: "claude-opus-5" })];
    expect(leaders(s, T0 - HOUR, T0 + HOUR, "cost")).toEqual([]);
  });

  test("a model id is shortened to something a widget can print", () => {
    expect(shortModel("claude-opus-5")).toBe("opus 5");
    expect(shortModel("claude-sonnet-4-6")).toBe("sonnet 4.6");
    expect(shortModel("claude-haiku-4-5[1m]")).toBe("haiku 4.5");
  });
});

describe("saying it", () => {
  /* Five characters is the contract — the row is tabular numerals and must not
     reflow as the number grows. The interesting cases are the ones that round
     *up* across a threshold, which is how $999,999 became `$1000k`. */
  test("money never grows past the width the row has", () => {
    for (const n of [
      0, 0.004, 1.5, 9.99, 10, 42.4, 999, 999.6, 1000, 9949, 9999, 12_345,
      999_499, 999_999, 9.94e6, 1e7, 9.9e8,
    ]) {
      expect(money(n).length).toBeLessThanOrEqual(5);
    }
    expect(money(0)).toBe("$0");
    expect(money(1.5)).toBe("$1.50");
    expect(money(42.4)).toBe("$42");
    expect(money(1250)).toBe("$1.3k");
    expect(money(12_345)).toBe("$12k");
    expect(money(999_999)).toBe("$1.0M");
  });

  test("counts read at the size they are", () => {
    expect(count(0)).toBe("0");
    expect(count(912)).toBe("912");
    expect(count(9120)).toBe("9.1k");
    expect(count(91_200)).toBe("91k");
    expect(count(9.12e6)).toBe("9.1M");
    expect(count(231e6)).toBe("231M");
    expect(count(1.4e9)).toBe("1.4B");
  });

  /* Words that change about once a minute rather than a second, for the reason
     the rest screen's `said` gives: a countdown you can watch is one you do. */
  test("what is left is said in words, not ticked", () => {
    expect(left(0)).toBe("any moment");
    expect(left(-5)).toBe("any moment");
    expect(left(20_000)).toBe("under a minute");
    expect(left(41 * 60_000)).toBe("41m");
    expect(left(2 * HOUR)).toBe("2h");
    expect(left(2 * HOUR + 14 * 60_000)).toBe("2h 14m");
  });
});

describe("costStep", () => {
  /* `total_cost_usd` is a running total of the *process*, probed 2026-08-25
     with tools/probe-cost.ts: a fresh session reported 0.2542635 and the same
     session resumed reported 0.225298 for its next small turn. */
  test("is the step the running total took", () => {
    expect(costStep(0.5, 0.2)).toBeCloseTo(0.3, 10);
    expect(costStep(0.2542635, 0)).toBeCloseTo(0.2542635, 10);
  });

  test("takes the whole total when the counter has restarted", () => {
    /* The card outlived its process — an account move, a wake after a crash —
       so the baseline is above what the new process counts from. This used to
       clamp to zero and book the turn at nothing. */
    expect(costStep(0.225298, 0.2542635)).toBeCloseTo(0.225298, 10);
    expect(costStep(0.01, 12.4)).toBeCloseTo(0.01, 10);
  });

  test("never invents money and never returns less than nothing", () => {
    expect(costStep(0, 0)).toBe(0);
    expect(costStep(0, 5)).toBe(0);
    expect(costStep(Number.NaN, 1)).toBe(0);
    expect(costStep(-1, 0)).toBe(0);
    expect(costStep(2, Number.NaN)).toBe(2);
  });
});

describe("turnRowKind", () => {
  const none = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  const real = { in: 1200, out: 340, cacheRead: 98_000, cacheWrite: 4100 };

  /* The case the whole column exists for. `turn 651 18f71b6c 2026-08-25
     10:30:29 rest in=0 out=0 cread=0 cwrite=0 usd=13.52` — the CLI answered
     the prompt itself, so the accumulated cost step landed on a turn that had
     processed nothing. */
  test("money with no turn behind it is a spend row", () => {
    expect(turnRowKind(0, none)).toBe("spend");
  });

  /* `num_turns` counts round trips to a model, so anything above zero is a
     turn whatever else the result says. Probed 2026-08-14 against claude
     2.1.232 with tools/probe-commands.ts: every locally-answered command
     reported 0, the rate-limited turn beside them still reported 1. */
  test("a turn that reached a model is a turn row", () => {
    expect(turnRowKind(1, real)).toBe("turn");
    expect(turnRowKind(14, real)).toBe("turn");
    /* Including one that reached a model and came back with nothing to show
       for it — a refusal, an empty answer. It still asked. */
    expect(turnRowKind(1, none)).toBe("turn");
  });

  /* turns.md: "the failed attempt is still a turn", and a retry that swallowed
     it would make the day's figure understate what the wall spent. A turn that
     errored after reaching a model reports its own tokens and stays a turn. */
  test("a failed turn that reached a model stays a turn row", () => {
    expect(turnRowKind(2, { in: 40, out: 0, cacheRead: 190_000, cacheWrite: 0 })).toBe("turn");
  });

  /* Tokens are consulted only ever to say `turn`. Never seen in the wild; here
     because filing a row with real tokens as "no turn happened" destroys
     information, where the arm it guards merely mislabels. */
  test("tokens outrank a zero round-trip count", () => {
    expect(turnRowKind(0, real)).toBe("turn");
    expect(turnRowKind(0, { ...none, cacheRead: 1 })).toBe("turn");
    expect(turnRowKind(0, { ...none, out: 12 })).toBe("turn");
  });

  /* A CLI that stops sending the field, or an error path that omits it, falls
     back to exactly the behaviour this replaced: attributed, and as readable
     as it was. The other direction would file real turns as spend on the
     strength of a missing field. */
  test("anything but a literal zero is a turn", () => {
    expect(turnRowKind(undefined, none)).toBe("turn");
    expect(turnRowKind(null, none)).toBe("turn");
    expect(turnRowKind("0", none)).toBe("turn");
    expect(turnRowKind(Number.NaN, none)).toBe("turn");
  });

  /* A count that cannot be added up is not evidence that anything was
     processed, so it must not talk the row into being a turn. */
  test("unusable counts are no counts at all", () => {
    expect(turnRowKind(0, { ...none, in: Number.NaN })).toBe("spend");
    expect(turnRowKind(0, { ...none, out: -5 })).toBe("spend");
    expect(turnRowKind(0, { ...none, cacheRead: Number.POSITIVE_INFINITY })).toBe("spend");
    expect(turnRowKind(0, undefined as never)).toBe("spend");
  });
});
