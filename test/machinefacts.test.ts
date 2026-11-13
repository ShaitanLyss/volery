import { describe, expect, test } from "bun:test";
import {
  capacitySaid,
  fold,
  gib,
  machineSaid,
  measured,
  MACHINE_ROWS,
  pct,
  rate,
  type MachineNow,
} from "../src/lib/machinefacts";

function m(over: Partial<MachineNow> = {}): MachineNow {
  return {
    cpu: null,
    memUsed: null,
    memTotal: null,
    gpu: null,
    netRx: null,
    netTx: null,
    worktrees: null,
    ...over,
  };
}

describe("how a machine figure is said", () => {
  test("a percentage is floored and clamped to its unit", () => {
    expect(pct(12.9)).toBe("12%");
    expect(pct(0)).toBe("0%");
    expect(pct(140)).toBe("100%");
    expect(pct(-4)).toBe("0%");
  });

  test("memory is binary units, and a host figure is not a decimal", () => {
    expect(gib(8.2 * 1024 ** 3)).toBe("8.2GB");
    expect(gib(32 * 1024 ** 3)).toBe("32GB");
  });

  test("a rate picks the unit that makes it readable", () => {
    expect(rate(0)).toBe("0");
    expect(rate(512)).toBe("512B/s");
    expect(rate(1.5 * 1024 ** 2)).toBe("1.5MB/s");
    expect(rate(42 * 1024 ** 2)).toBe("42MB/s");
  });

  /** **A measure that could not be read is absent from the sentence**, never a
   *  zero: a GPU this build cannot ask about must not read as an idle one. */
  test("says only what it could read", () => {
    expect(capacitySaid(m({ cpu: 37.5, memUsed: 8 * 1024 ** 3, memTotal: 32 * 1024 ** 3 }))).toBe(
      "cpu 37% · mem 8.0GB of 32GB",
    );
    expect(capacitySaid(m({ gpu: null }))).toBe("");
    expect(machineSaid(m({ cpu: 4, netRx: 2048, netTx: 1024, worktrees: 1 }))).toBe(
      "cpu 4% · net 2.0KB/s in, 1.0KB/s out · 1 worktree",
    );
  });
});

describe("folding a span", () => {
  const rows = [m({ cpu: 10 }), m({ cpu: 80 }), m({ cpu: null }), m({ cpu: 30 })];

  test("keeps the last, the peak and the low, and skips what was not read", () => {
    const got = fold(rows, (x) => x.cpu);
    expect(got.last).toBe(30);
    expect(got.peak).toBe(80);
    expect(got.low).toBe(10);
    expect(got.points).toEqual([10, 80, 30]);
  });

  test("an unread measure is distinguishable from a quiet one", () => {
    expect(measured([m({ cpu: null }), m({ cpu: null })], (x) => x.cpu)).toBe(false);
    expect(measured([m({ cpu: 0 })], (x) => x.cpu)).toBe(true);
  });

  test("every row on the block names a measure it can pick", () => {
    const one = m({ cpu: 5, memUsed: 2 ** 33, memTotal: 2 ** 35, gpu: 7, diskFree: 2 ** 40, netRx: 900 });
    for (const row of MACHINE_ROWS) expect(row.pick(one)).not.toBeNull();
    expect(MACHINE_ROWS.map((r) => r.key)).toEqual(["cpu", "mem", "gpu", "disk", "net"]);
  });
});
