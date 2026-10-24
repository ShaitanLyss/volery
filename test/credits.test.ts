import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Choice } from "../src/lib/accounts";
import { carryNote, creditRefusalOf, healNote } from "../src/lib/classify";
import {
  boostLabel,
  CREDITS,
  creditsStanding,
  fundingName,
  money,
  monthStart,
  nextMonth,
  offCreditsNote,
  onCredits,
  ontoCreditsNote,
  parseBudget,
  refuseCredits,
  route,
  sayBoost,
  type AccountState,
  type CreditsStanding,
  type Purse,
} from "../src/lib/credits";

const READY: CreditsStanding = { ready: true };
const OFF: CreditsStanding = { ready: false, why: "boost is off", until: null };

/** A wall of three, as Lyss's was on 2026-10-24: `lyss` and `tx-team` sharing
 *  priority 1, `alizee` on 2. `states` says which can take work; the ladder is a
 *  small stand-in for `choose` — stick to a ready account, else the first ready
 *  one in order, else hold (or `none` when nothing is even usable). */
function wall(states: Record<string, AccountState>) {
  const order = ["lyss", "tx-team", "alizee"];
  const state = (label: string): AccountState => states[label] ?? "unusable";
  const ladder = (stickTo: string | null): Choice => {
    if (stickTo !== null && state(stickTo) === "ready") return { kind: "use", label: stickTo, swapFrom: null };
    const pick = order.find((l) => state(l) === "ready");
    if (pick) return { kind: "use", label: pick, swapFrom: stickTo !== null && stickTo !== pick ? stickTo : null };
    if (order.some((l) => state(l) === "blocked")) return { kind: "hold", until: null, standings: [] };
    return { kind: "none", why: "no account is usable" };
  };
  return { state, ladder };
}

describe("credits are not an account", () => {
  test("the label is the one Rust spawns on", () => {
    const rs = readFileSync("src-tauri/src/credits.rs", "utf8");
    expect(rs).toContain(`pub const LABEL: &str = "${CREDITS}";`);
  });

  test("no account can be called it — the label rule refuses the @", () => {
    const rs = readFileSync("src-tauri/src/accounts.rs", "utf8");
    expect(rs).toContain("c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_'");
    expect(CREDITS.startsWith("@")).toBe(true);
  });

  test("a face calls it credits and leaves accounts alone", () => {
    expect(onCredits(CREDITS)).toBe(true);
    expect(onCredits("credits")).toBe(false);
    expect(onCredits(null)).toBe(false);
    expect(fundingName(CREDITS)).toBe("credits");
    expect(fundingName("tx-team")).toBe("tx-team");
    expect(fundingName(null)).toBeNull();
  });
});

describe("where a card goes, with boost on — one afternoon on Lyss's wall", () => {
  test("16:00, tx-team runs out under a card: it goes onto credits, not alizee", () => {
    const w = wall({ lyss: "blocked", "tx-team": "blocked", alizee: "ready" });
    expect(route({ current: "tx-team", home: null, credits: READY, ...w })).toEqual({
      kind: "use",
      label: CREDITS,
      home: "tx-team",
      why: "credits",
    });
  });

  test("16:05, a new card still takes the ladder first", () => {
    const w = wall({ lyss: "blocked", "tx-team": "blocked", alizee: "ready" });
    expect(route({ current: null, home: null, credits: READY, ...w })).toMatchObject({
      kind: "use",
      label: "alizee",
      why: "ladder",
    });
  });

  test("a card whose account has room stays exactly where it is", () => {
    const w = wall({ lyss: "blocked", "tx-team": "ready", alizee: "ready" });
    expect(route({ current: "tx-team", home: null, credits: READY, ...w })).toEqual({
      kind: "use",
      label: "tx-team",
      home: null,
      why: "stay",
    });
  });

  test("on credits while its home is still out: it stays on credits, even with alizee free", () => {
    const w = wall({ lyss: "blocked", "tx-team": "blocked", alizee: "ready" });
    expect(route({ current: CREDITS, home: "tx-team", credits: READY, ...w })).toEqual({
      kind: "use",
      label: CREDITS,
      home: "tx-team",
      why: "stay",
    });
  });

  test("21:00, tx-team's session resets: the card goes home at its next message", () => {
    const w = wall({ lyss: "blocked", "tx-team": "ready", alizee: "blocked" });
    expect(route({ current: CREDITS, home: "tx-team", credits: READY, ...w })).toEqual({
      kind: "use",
      label: "tx-team",
      home: null,
      why: "home",
    });
  });

  test("a card that started on credits goes to any account with room", () => {
    const w = wall({ lyss: "blocked", "tx-team": "blocked", alizee: "ready" });
    expect(route({ current: CREDITS, home: null, credits: READY, ...w })).toMatchObject({
      label: "alizee",
      why: "home",
    });
  });

  test("a home switched off is no home", () => {
    const w = wall({ lyss: "blocked", "tx-team": "unusable", alizee: "ready" });
    expect(route({ current: CREDITS, home: "tx-team", credits: READY, ...w })).toMatchObject({
      label: "alizee",
    });
  });
});

describe("anything the ladder cannot place goes onto credits at once", () => {
  /* Lyss, mid-build: "all accounts are already used or off and I spawn a card
     in boost mode, it should use credits right away". */
  test("a new card, every account spent", () => {
    const w = wall({ lyss: "blocked", "tx-team": "blocked", alizee: "blocked" });
    expect(route({ current: null, home: null, credits: READY, ...w })).toEqual({
      kind: "use",
      label: CREDITS,
      home: null,
      why: "credits",
    });
  });

  test("a new card, every account switched off", () => {
    const w = wall({ lyss: "unusable", "tx-team": "unusable", alizee: "unusable" });
    expect(route({ current: null, home: null, credits: READY, ...w })).toMatchObject({
      label: CREDITS,
      home: null,
    });
  });

  test("a card whose account was switched off, with nothing else free", () => {
    const w = wall({ lyss: "unusable", "tx-team": "blocked", alizee: "blocked" });
    expect(route({ current: "lyss", home: null, credits: READY, ...w })).toMatchObject({
      label: CREDITS,
      home: null,
    });
  });

  test("but a switched-off account with another free goes down the ladder, as before", () => {
    const w = wall({ lyss: "unusable", "tx-team": "ready", alizee: "ready" });
    expect(route({ current: "lyss", home: null, credits: READY, ...w })).toMatchObject({
      label: "tx-team",
      why: "ladder",
    });
  });
});

describe("when credits cannot take work, everything is the ladder exactly", () => {
  test("boost off: a card that runs out goes down the ladder", () => {
    const w = wall({ lyss: "blocked", "tx-team": "blocked", alizee: "ready" });
    expect(route({ current: "tx-team", home: null, credits: OFF, ...w })).toMatchObject({
      label: "alizee",
      why: "ladder",
    });
  });

  test("boost off and everything spent: held, as today", () => {
    const w = wall({ lyss: "blocked", "tx-team": "blocked", alizee: "blocked" });
    expect(route({ current: "tx-team", home: null, credits: OFF, ...w }).kind).toBe("hold");
  });

  test("boost off and nothing usable: the fault, as today", () => {
    const w = wall({ lyss: "unusable", "tx-team": "unusable", alizee: "unusable" });
    expect(route({ current: null, home: null, credits: OFF, ...w }).kind).toBe("none");
  });

  test("a card on credits when they stop: back down the ladder from its home", () => {
    const w = wall({ lyss: "blocked", "tx-team": "blocked", alizee: "ready" });
    expect(route({ current: CREDITS, home: "tx-team", credits: OFF, ...w })).toEqual({
      kind: "use",
      label: "alizee",
      home: null,
      why: "ladder",
    });
    const spent = wall({ lyss: "blocked", "tx-team": "blocked", alizee: "blocked" });
    expect(route({ current: CREDITS, home: "tx-team", credits: OFF, ...spent }).kind).toBe("hold");
  });
});

describe("whether credits can take work", () => {
  const purse = (over: Partial<Purse> = {}): Purse => ({
    boost: true,
    keyHeld: true,
    budget: 500,
    spent: 0,
    refused: null,
    ...over,
  });
  const now = new Date(2026, 9, 24, 15).getTime();

  test("ready with boost on, a key, room in the budget and nothing refused", () => {
    expect(creditsStanding(purse(), now)).toEqual({ ready: true });
  });

  test("a key not yet asked about is read as present — a spawn without one fails loudly", () => {
    expect(creditsStanding(purse({ keyHeld: null }), now).ready).toBe(true);
  });

  test("each reason it cannot, said", () => {
    expect(creditsStanding(purse({ boost: false }), now)).toMatchObject({ ready: false, why: "boost is off" });
    expect(creditsStanding(purse({ keyHeld: false }), now)).toMatchObject({ ready: false });
    const spent = creditsStanding(purse({ spent: 500 }), now);
    expect(spent).toMatchObject({ ready: false, until: nextMonth(now) });
    if (!spent.ready) expect(spent.why).toContain("$500 of the $500");
    expect(creditsStanding(purse({ budget: null, spent: 9000 }), now).ready).toBe(true);
    const mark = refuseCredits(null, "balance", now);
    expect(creditsStanding(purse({ refused: mark }), now)).toMatchObject({ ready: false, until: mark.until });
    expect(creditsStanding(purse({ refused: mark }), mark.until + 1).ready).toBe(true);
  });
});

describe("refusals", () => {
  const now = 1_000_000;

  test("a rate limit waits a minute, an empty balance an hour, and each backs off", () => {
    const rate = refuseCredits(null, "rate", now);
    expect(rate.until - now).toBe(60_000);
    const again = refuseCredits(rate, "rate", rate.until + 1);
    expect(again.until - (rate.until + 1)).toBe(120_000);
    const balance = refuseCredits(null, "balance", now);
    expect(balance.until - now).toBe(3_600_000);
  });

  test("one arriving while one stands is the same news, not a second strike", () => {
    const first = refuseCredits(null, "rate", now);
    const same = refuseCredits(first, "rate", now + 10);
    expect(same.strikes).toBe(1);
    expect(same.until).toBe(first.until);
  });

  test("ceilings: ten minutes for weather, six hours for money", () => {
    let r = refuseCredits(null, "rate", now);
    for (let i = 0; i < 12; i++) r = refuseCredits(r, "rate", r.until + 1);
    expect(r.until - r.at).toBe(10 * 60_000);
    let b = refuseCredits(null, "key", now);
    for (let i = 0; i < 12; i++) b = refuseCredits(b, "key", b.until + 1);
    expect(b.until - b.at).toBe(6 * 3_600_000);
  });
});

describe("what the CLI says when credits refuse a turn", () => {
  test("an empty balance, in the API's words and the CLI's own", () => {
    const api = {
      type: "result",
      is_error: true,
      api_error_status: 400,
      result:
        "API Error: 400 Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    };
    expect(creditRefusalOf(api)).toBe("balance");
    expect(creditRefusalOf({ is_error: true, result: "Credit balance too low · Add funds: https://platform.claude.com/settings/billing" })).toBe("balance");
  });

  test("a refused key — the exact result probed with a dummy key on 2.1.304", () => {
    const probed = {
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 401,
      result: "Invalid API key · Fix external API key",
    };
    expect(creditRefusalOf(probed)).toBe("key");
  });

  test("the organisation's rate limit", () => {
    expect(
      creditRefusalOf({
        is_error: true,
        api_error_status: 429,
        result: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"…"}}',
      }),
    ).toBe("rate");
  });

  test("a successful turn that merely talks about credit balances is not a refusal", () => {
    expect(
      creditRefusalOf({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "When the credit balance is too low the CLI says so.",
      }),
    ).toBeNull();
  });
});

describe("saying it", () => {
  test("onto credits names what it left, that it is money, and the re-read", () => {
    const said = ontoCreditsNote("tx-team", "the 5 hours is spent");
    expect(said).toContain("moved from tx-team onto credits — the 5 hours is spent");
    expect(said).toContain("billed per token");
    expect(said).toContain("goes back to tx-team when that has room");
    expect(said).toContain("re-reads this conversation uncached");
    expect(ontoCreditsNote(null, "no account on the ladder can take work")).toStartWith("put on credits");
  });

  test("a refusal on credits is not called an allowance running out", () => {
    /* Found driving the lab: the card read "out of allowance" over a refused
       balance, which is a subscription's sentence about something else. */
    expect(healNote("limited", 1, 5000, true)).toStartWith("credits were refused — trying again");
    expect(healNote("limited", 1, 5000)).toStartWith("this account is out of allowance");
    expect(carryNote(1, 5000, true)).toStartWith("credits were refused part-way through");
    expect(carryNote(1, 5000)).toStartWith("the allowance ran out part-way through");
  });

  test("and off them", () => {
    expect(offCreditsNote("tx-team", "home", null)).toBe(
      "moved from credits back to tx-team — tx-team has room again. the next turn re-reads this conversation uncached",
    );
    expect(offCreditsNote("alizee", "ladder", "boost is off")).toContain("— boost is off.");
  });

  test("the button: the switch, and the month while it is on", () => {
    const p: Purse = { boost: false, keyHeld: true, budget: 500, spent: 88.4, refused: null };
    expect(boostLabel(p)).toBe("boost");
    expect(boostLabel({ ...p, boost: true })).toBe("boost · $88 of $500");
    expect(boostLabel({ ...p, boost: true, budget: null })).toBe("boost · $88");
    expect(sayBoost(p, OFF)).toContain("space then m b");
    expect(sayBoost({ ...p, boost: true }, { ready: false, why: "the api key was refused", until: null })).toContain(
      "credits are not taking work: the api key was refused",
    );
  });

  test("money, budgets and months", () => {
    expect(money(0)).toBe("$0");
    expect(money(3.456)).toBe("$3.46");
    expect(money(41.2)).toBe("$41");
    expect(parseBudget("$250")).toEqual({ ok: true, budget: 250 });
    expect(parseBudget("")).toEqual({ ok: true, budget: null });
    expect(parseBudget("lots")).toEqual({ ok: false });
    const at = new Date(2026, 9, 24, 15).getTime();
    expect(new Date(monthStart(at)).getDate()).toBe(1);
    expect(new Date(nextMonth(at)).getMonth()).toBe(10);
  });
});
