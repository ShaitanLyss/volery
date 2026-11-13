import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Account, Allowance } from "../src/lib/accounts";
import { allowanceFacts, nearness, NOTHING_KNOWN, RELEASE_GAP_MS, sameFacts, type Looked } from "../src/lib/admit";
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
  test("the five-hour window speaks, and brings its reset", () => {
    const n = nearness(account("tx-team"), read(win("session", 88, 5_000), win("weekly_all", 40, 9_000)));
    expect(n).toEqual({ spent: 0.88, resetsAt: 5_000 });
  });

  /** Lyss chose 85% against the five hours ("roughly 45 minutes"). A week at
   *  90% — or a model-scoped week, the Opus week full under a Haiku lane — is
   *  not a reason to queue a fan-out for days. */
  test("a full week does not speak", () => {
    const n = nearness(
      account("tx-team"),
      read(win("session", 20, 5_000), win("weekly_all", 90, 9_000), win("weekly_scoped", 99, 9_000)),
    );
    expect(n).toEqual({ spent: 0.2, resetsAt: 5_000 });
    expect(nearness(account("tx-team"), read(win("weekly_all", 95, 9_000)))).toBeNull();
  });

  /** Your cap is the ceiling where you set one — the balancer's own
   *  denominator, so 85% here means what `spentOf` means. */
  test("a cap moves the ceiling", () => {
    const n = nearness(account("tx-team", { session: 50 }), read(win("session", 45, 5_000), win("weekly_all", 45, 9_000)));
    expect(n?.spent).toBeCloseTo(0.9);
    expect(n?.resetsAt).toBe(5_000);
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
  const lookup = (label: string): Looked | null =>
    label === "tx-team"
      ? { account: account("tx-team"), allowance: read(win("session", 91, 7_000)), credits: false }
      : label === "billed"
        ? { account: account("billed"), allowance: read(win("session", 99, 7_000)), credits: true }
        : null;

  test("a held wall is held, until the first door", () => {
    const f = allowanceFacts({ kind: "hold", until: 4_000, standings: [] }, lookup);
    expect(f).toEqual({ ...NOTHING_KNOWN, held: true, until: 4_000, heldBypass: true, untilBypass: 4_000 });
  });

  /** Held by your caps alone: a card bypassing them is not held. */
  test("the bypassed decision is said apart", () => {
    const f = allowanceFacts({ kind: "hold", until: 4_000, standings: [] }, lookup, {
      bypass: { kind: "use", label: "tx-team", home: null, why: "ladder" },
    });
    expect(f.held).toBe(true);
    expect(f.heldBypass).toBe(false);
    expect(f.untilBypass).toBeNull();
  });

  /** A spawn naming an account is weighed where it lands. */
  test("each account a spawn may be asked onto is said", () => {
    const f = allowanceFacts({ kind: "use", label: "other", home: null, why: "ladder" }, lookup, {
      asked: [
        { account: "tx-team", decision: { kind: "use", label: "tx-team", home: null, why: "ladder" } },
        { account: "gone", decision: { kind: "use", label: "other", home: null, why: "ladder" } },
      ],
    });
    expect(f.landing).toBe("other");
    expect(f.spent).toBeNull();
    expect(f.asked[0]!.account).toBe("tx-team");
    expect(f.asked[0]!.spent).toBeCloseTo(0.91);
    expect(f.asked[1]).toEqual({ account: "gone", landing: "other", spent: null, resetsAt: null });
  });

  /** Boost on and the account's own usage credits behind it: the window
   *  filling is a bill, not a wall — Lyss's "credits admit everything" for an
   *  account's credits as for the API key's. */
  test("an account's own usage credits admit, as the key's do", () => {
    const f = allowanceFacts({ kind: "use", label: "billed", home: null, why: "ladder" }, lookup);
    expect(f.landing).toBeNull();
    expect(f.spent).toBeNull();
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
    const asked = { ...a, asked: [{ account: "y", landing: "y", spent: 0.5, resetsAt: 1 }] };
    expect(sameFacts(a, asked)).toBe(false);
    expect(sameFacts(asked, { ...asked, asked: [{ ...asked.asked[0]!, spent: 0.9 }] })).toBe(false);
    expect(sameFacts(asked, { ...asked, heldBypass: true })).toBe(false);
  });

  /** A pace is noted by which accounts and until when. The sentence carries a
   *  percentage that moves every few minutes, and rewriting the note because a
   *  numeral moved is a write that changes nothing the wall will do. */
  test("a pace is a change of account or of time, not of sentence", () => {
    const base = { ...NOTHING_KNOWN, plans: [{ account: "x", why: "paced: at 71%", until: 9 }] };
    expect(sameFacts(NOTHING_KNOWN, base)).toBe(false);
    expect(sameFacts(base, { ...base, plans: [{ account: "x", why: "paced: at 72%", until: 9 }] })).toBe(true);
    expect(sameFacts(base, { ...base, plans: [{ account: "x", why: "paced: at 71%", until: 10 }] })).toBe(false);
    expect(sameFacts(base, { ...base, plans: [{ account: "y", why: "paced: at 71%", until: 9 }] })).toBe(false);
    expect(sameFacts(base, { ...base, plans: [] })).toBe(false);
  });

  test("the plans the wall is holding are carried as told", () => {
    const f = allowanceFacts({ kind: "use", label: "tx-team", home: null, why: "ladder" }, lookup, {
      plans: [{ account: "tx-team", why: "paced: the week is at 71%", until: 9_000 }],
    });
    expect(f.plans).toEqual([{ account: "tx-team", why: "paced: the week is at 71%", until: 9_000 }]);
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

  /** **Tauri drops an argument the command does not name**, so a fact left out
   *  of this payload is not an error anywhere: it is `None` in Rust, and the
   *  gate goes inert while the face still draws it. `plans` shipped that way
   *  for an afternoon and only a review caught it. */
  test("every fact is in the note", () => {
    const ts = readFileSync(new URL("../src/lib/skein.svelte.ts", import.meta.url), "utf8");
    const at = ts.indexOf('invoke("note_allowance"');
    const end = ts.indexOf("}).catch", at);
    /* A slice to a terminator that is not there runs to the end of the file,
       where `held:` and `until:` recur in later code and the guard would pass
       with the payload missing them (found in review). */
    expect(at).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(at);
    const call = ts.slice(at, end);
    for (const key of [
      "held",
      "until",
      "heldBypass",
      "untilBypass",
      "landing",
      "spent",
      "resetsAt",
      "asked",
      "plans",
    ]) {
      expect(call).toContain(`${key}:`);
    }
  });

  /** The threshold is Lyss's (2026-11-02), in one place. */
  test("the ceiling is 85% and lives in Rust alone", () => {
    const rust = readFileSync(new URL("../src-tauri/src/admit.rs", import.meta.url), "utf8");
    expect(rust).toMatch(/pub const CEILING: f64 = 0\.85;/);
    const ts = readFileSync(new URL("../src/lib/admit.ts", import.meta.url), "utf8");
    expect(ts).not.toMatch(/0\.85/);
  });

  /** The front end paces held prompts as Rust paces wakes and notices. */
  test("one release gap on both sides", () => {
    const rust = readFileSync(new URL("../src-tauri/src/admit.rs", import.meta.url), "utf8");
    const m = rust.match(/pub const RELEASE_GAP_MS: u64 = ([\d_]+);/);
    expect(Number(m?.[1]?.replace(/_/g, ""))).toBe(RELEASE_GAP_MS);
  });
});
