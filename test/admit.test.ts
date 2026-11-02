import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Account, Allowance } from "../src/lib/accounts";
import { allowanceFacts, nearness, NOTHING_KNOWN, sameFacts } from "../src/lib/admit";
import { CREDITS } from "../src/lib/credits";
import { isQueuedSpawn, QUEUED_SPAWN } from "../src/lib/holding";
import type { Window } from "../src/lib/limits";

function account(label: string, caps: Record<string, number> = {}): Account {
  return { label, priority: 1, rank: 0, enabled: true, caps, signedIn: true, lapsed: false };
}

function win(kind: string, used: number, resetsAt: number | null): Window {
  return { kind, group: kind === "session" ? "session" : "weekly", used, severity: "normal", resetsAt, scope: null, active: false };
}

function read(...windows: Window[]): Allowance {
  return { ok: true, windows, at: 0 };
}

describe("how close the landing account is to its ceiling", () => {
  test("the fullest window speaks, and brings its reset", () => {
    const n = nearness(account("tx-team"), read(win("session", 88, 5_000), win("weekly_all", 40, 9_000)));
    expect(n).toEqual({ spent: 0.88, resetsAt: 5_000 });
  });

  /** Your cap is the ceiling where you set one — the balancer's own
   *  denominator, so 85% here means what `spentOf` means. */
  test("a cap moves the ceiling", () => {
    const n = nearness(account("tx-team", { weekly_all: 50 }), read(win("session", 30, 5_000), win("weekly_all", 45, 9_000)));
    expect(n?.spent).toBeCloseTo(0.9);
    expect(n?.resetsAt).toBe(9_000);
  });

  /** A queue decided on a reading nobody took would be a guess wearing a
   *  number, so an unmeasured account says nothing rather than 0. */
  test("an unmeasured account is not near anything", () => {
    expect(nearness(account("a"), undefined)).toBeNull();
    expect(nearness(account("a"), { ok: false, fault: "timed out" })).toBeNull();
    expect(nearness(account("a"), read())).toBeNull();
  });
});

describe("what one decision for a new card amounts to", () => {
  const lookup = (label: string) =>
    label === "tx-team" ? { account: account("tx-team"), allowance: read(win("session", 91, 7_000)) } : null;

  test("a held wall is held, until the first door", () => {
    const f = allowanceFacts({ kind: "hold", until: 4_000, standings: [] }, lookup);
    expect(f).toEqual({ ...NOTHING_KNOWN, held: true, until: 4_000 });
  });

  test("an account says where it lands and how full it is", () => {
    const f = allowanceFacts({ kind: "use", label: "tx-team", home: null, why: "ladder" }, lookup);
    expect(f.held).toBe(false);
    expect(f.landing).toBe("tx-team");
    expect(f.spent).toBeCloseTo(0.91);
    expect(f.resetsAt).toBe(7_000);
  });

  /** Boost is a decision already made to keep work moving with money; a queue
   *  would overrule it. */
  test("credits admit everything", () => {
    expect(allowanceFacts({ kind: "use", label: CREDITS, home: null, why: "credits" }, lookup)).toEqual(NOTHING_KNOWN);
  });

  /** Nothing signed in never ends by itself, so nothing may wait behind it. */
  test("no account at all is a fault, not a wait", () => {
    expect(allowanceFacts({ kind: "none", why: "nothing is signed in" }, lookup)).toEqual(NOTHING_KNOWN);
  });

  test("a percent is the precision a change is noted at", () => {
    const a = { ...NOTHING_KNOWN, landing: "x", spent: 0.861 };
    expect(sameFacts(a, { ...a, spent: 0.869 })).toBe(true);
    expect(sameFacts(a, { ...a, spent: 0.871 })).toBe(false);
    expect(sameFacts(null, a)).toBe(false);
  });
});

describe("a queued spawn is known again after a restart", () => {
  /** `held_why` is stored and `waiting` is not, so the words are the marker —
   *  and they are Rust's (`admit::verdict`), held equal here. */
  test("by the words Rust writes", () => {
    const rust = readFileSync(new URL("../src-tauri/src/admit.rs", import.meta.url), "utf8");
    const quoted = [...rust.matchAll(/"(queued — [^"{]*)/g)].map((m) => m[1]!);
    expect(quoted.length).toBeGreaterThanOrEqual(2);
    for (const q of quoted) expect(isQueuedSpawn(q)).toBe(true);
    expect(rust).toContain(`"${QUEUED_SPAWN}`);
    expect(isQueuedSpawn("held — every account is spent")).toBe(false);
    expect(isQueuedSpawn(null)).toBe(false);
  });

  /** The threshold is Lyss's (2026-11-02), in one place. */
  test("the ceiling is 85% and lives in Rust alone", () => {
    const rust = readFileSync(new URL("../src-tauri/src/admit.rs", import.meta.url), "utf8");
    expect(rust).toMatch(/pub const CEILING: f64 = 0\.85;/);
    const ts = readFileSync(new URL("../src/lib/admit.ts", import.meta.url), "utf8");
    expect(ts).not.toMatch(/0\.85/);
  });
});
