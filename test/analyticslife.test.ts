import { describe, expect, test } from "bun:test";
import {
  asCardLife,
  daySaid,
  fundingSaid,
  lifeModel,
  livedSaid,
  nowSaid,
  rowSaid,
  sharesOf,
  splitSaid,
  timeline,
  type CardLife,
  type LifeMove,
  type LifeSpend,
} from "../src/lib/analyticslife";
import type { SessionFact } from "../src/lib/analyticsbehaviour";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const BORN = new Date(2026, 10, 3, 9, 0).getTime();

function session(over: Partial<SessionFact> = {}): SessionFact {
  return {
    session: "s1",
    host: "studio",
    project: "volery",
    source: "card",
    card: "c1",
    parentCard: "",
    openedBy: "person",
    branch: "main",
    startedAt: BORN,
    endedAt: BORN + 2 * DAY,
    cliMin: "2.1.300",
    cliMax: "2.1.319",
    accountFirst: "lyss",
    accountLast: "lyss",
    providerFirst: "anthropic",
    providerLast: "anthropic",
    turns: 10,
    ...over,
  };
}

function spend(over: Partial<LifeSpend> = {}): LifeSpend {
  return {
    session: "s1",
    account: "lyss",
    provider: "anthropic",
    model: "claude-opus-5-5",
    firstAt: BORN + 5 * 60_000,
    lastAt: BORN + 2 * DAY,
    inTok: 1000,
    outTok: 100,
    cacheRead: 4000,
    write5m: 500,
    write1h: 100,
    requests: 4,
    usd: 1.5,
    unpriced: 0,
    ...over,
  };
}

function life(over: Partial<CardLife> = {}): CardLife {
  return {
    card: "c1",
    label: "agent audit",
    nowSession: "s1",
    nowAccount: "lyss",
    nowModel: "claude-opus-5-5",
    sessions: [session()],
    spend: [spend()],
    moves: [],
    usdReported: 3.75,
    turns: 10,
    factsFrom: BORN - 30 * DAY,
    ...over,
  };
}

describe("a card's life, made drawable", () => {
  test("a row the command cannot name is dropped rather than drawn as zero", () => {
    const raw = {
      card: "c1",
      label: "agent audit",
      nowAccount: "lyss",
      nowModel: "claude-opus-5-5",
      usdReported: 2.5,
      turns: 3,
      factsFrom: 1000,
      sessions: [
        {
          session: "s1",
          startedAt: 5000,
          endedAt: null,
          openedBy: "person",
          accountFirst: "lyss",
          accountLast: "lyss",
          providerFirst: "anthropic",
          providerLast: "anthropic",
          turns: 3,
        },
        { session: "", startedAt: 6000 },
      ],
      spend: [
        { session: "s1", account: "lyss", provider: "anthropic", model: "m1", firstAt: 2000, lastAt: 4000 },
        { session: "s1", account: "lyss", provider: "anthropic", model: "", firstAt: 2000 },
      ],
      moves: [
        { at: 3000, kind: "account", reference: "tx-team" },
        { at: 3100, kind: "write", reference: "a.rs" },
      ],
    };
    const one = asCardLife(raw)!;
    expect(one.card).toBe("c1");
    expect(one.sessions.length).toBe(1);
    expect(one.spend.length).toBe(1);
    expect(one.spend[0].usd).toBeNull();
    expect(one.moves.length).toBe(1);
    expect(one.moves[0].reference).toBe("tx-team");
    expect(asCardLife({ label: "no card id" })).toBeNull();
    expect(asCardLife(null)).toBeNull();
  });
});

describe("who paid, and by what model", () => {
  test("the bar folds by account and the shares sum to the whole", () => {
    const rows = [
      spend({ account: "lyss", inTok: 300, outTok: 0, cacheRead: 0, write5m: 0, write1h: 0 }),
      spend({ account: "lyss", inTok: 300, outTok: 0, cacheRead: 0, write5m: 0, write1h: 0 }),
      spend({ account: "tx-team", inTok: 400, outTok: 0, cacheRead: 0, write5m: 0, write1h: 0 }),
    ];
    const out = sharesOf(rows, "account");
    expect(out.tokens).toBe(1000);
    expect(out.rows.map((r) => r.label)).toEqual(["lyss", "tx-team"]);
    expect(out.rows[0].share).toBeCloseTo(0.6, 10);
    expect(out.rows[0].tokens).toBe(600);
    expect(out.rows[1].share).toBeCloseTo(0.4, 10);
    expect(out.rows.reduce((sum, r) => sum + (r.share ?? 0), 0)).toBeCloseTo(1, 10);
  });

  test("an unrecorded account is named, so the shares still add to the whole", () => {
    const out = sharesOf([spend({ account: "" }), spend({ account: "lyss" })], "account");
    expect(out.rows.map((r) => r.label).sort()).toEqual(["lyss", "unknown"]);
  });

  test("past four fundings the rest fold into one row rather than leaving the bar short", () => {
    const rows = ["a", "b", "c", "d", "e", "f"].map((account) =>
      spend({ account, inTok: 100, outTok: 0, cacheRead: 0, write5m: 0, write1h: 0 }),
    );
    const out = sharesOf(rows, "account");
    expect(out.tokens).toBe(600);
    expect(out.rows.length).toBe(5);
    expect(out.rows[4].label).toBe("others");
    expect(out.rows[4].tokens).toBe(200);
    expect(out.rows.reduce((sum, r) => sum + (r.share ?? 0), 0)).toBeCloseTo(1, 10);
  });

  test("a group the table could not price makes the folded dollars a floor, said out loud", () => {
    const out = sharesOf([spend({ usd: 1.5 }), spend({ account: "ds", usd: null })], "account");
    expect(out.usdPartial).toBe(true);
    expect(out.usd).toBe(1.5);
  });

  test("tokens on an unknown model are counted and reported, never priced at zero", () => {
    /* Every token unpriced: the row has no dollar figure at all, not `$0`, and
       the block says "part unpriced" rather than presenting a floor. */
    const all = sharesOf([spend({ usd: 0, unpriced: 5700 })], "account");
    expect(all.tokens).toBe(5700);
    expect(all.unpriced).toBe(5700);
    expect(all.usdPartial).toBe(true);
    expect(all.rows[0].usd).toBeNull();
    /* Some priced, some not: the priced half's dollars stand as a floor. */
    const part = sharesOf([spend({ usd: 1.5, unpriced: 900 })], "account");
    expect(part.rows[0].usd).toBe(1.5);
    expect(part.usdPartial).toBe(true);
  });
});

describe("the change timeline", () => {
  test("it opens on the funding and model the first request used", () => {
    /* **The fact is stamped before the session started**, because it carries
       its five-minute bucket floor rather than its instant. This is the
       ordering the store really has, and a `>= startedAt` test would drop the
       model from every opening row in the app. */
    const rows = timeline(
      life({ sessions: [session({ startedAt: BORN + 7_000 })], spend: [spend({ firstAt: BORN })] }),
    );
    expect(rows[0].verb).toBe("opened");
    expect(rows[0].at).toBe(BORN + 7_000);
    expect(rows[0].target).toBe("lyss · claude-opus-5-5");
  });

  test("a move is drawn with its new value and says the reason is unknown", () => {
    const at = BORN + 6 * HOUR;
    const rows = timeline(life({ moves: [{ at, kind: "account", reference: "tx-team" }] }));
    const move = rows.find((r) => r.verb === "account")!;
    expect(move.target).toBe("tx-team");
    expect(move.reason).toBe("reason unknown");
    expect(rowSaid(move)).toBe("moved to tx-team");
  });

  test("a funding with no move beside it is drawn as the first spend under it", () => {
    const later = spend({
      session: "s2",
      account: "tx-team",
      firstAt: BORN + 8 * HOUR,
      lastAt: BORN + 9 * HOUR,
    });
    const rows = timeline(life({ spend: [spend(), later] }));
    const derived = rows.find((r) => r.verb === "spend")!;
    expect(derived.at).toBe(BORN + 8 * HOUR);
    expect(derived.target).toBe("tx-team · claude-opus-5-5");
    expect(rowSaid(derived)).toBe("first spent on tx-team · claude-opus-5-5");
  });

  test("a move that explains the change means the same transition is not drawn twice", () => {
    /* The move is at 17:01:23 and the first group under it is stamped 17:00:00,
       so the group's stamp is *before* the move. A group that is not the
       session's first is the only case that needs the move at all, which is
       why this session already has an earlier group. */
    const floor = BORN + 8 * HOUR;
    const at = floor + 83_000;
    const earlier = spend({ session: "s2", firstAt: floor - HOUR, lastAt: floor - 60_000 });
    const later = spend({ session: "s2", account: "tx-team", firstAt: floor, lastAt: floor + HOUR });
    const rows = timeline(
      life({
        sessions: [session(), session({ session: "s2", startedAt: floor - HOUR + 5_000 })],
        spend: [spend(), earlier, later],
        moves: [{ at, kind: "account", reference: "tx-team" }],
      }),
    );
    expect(rows.filter((r) => r.verb === "spend").length).toBe(0);
    expect(rows.filter((r) => r.verb === "account").length).toBe(1);
    expect(rows.filter((r) => r.verb === "session").length).toBe(1);
  });

  test("a new session names its own funding, and a renewal is not called a move", () => {
    const rows = timeline(
      life({
        sessions: [
          session(),
          session({
            session: "s2",
            startedAt: BORN + 3 * DAY,
            endedAt: null,
            accountFirst: "@deepseek",
            providerFirst: "deepseek",
          }),
        ],
        spend: [
          spend(),
          spend({
            session: "s2",
            account: "@deepseek",
            provider: "deepseek",
            model: "deepseek-flash",
            firstAt: BORN + 3 * DAY + 4 * 60_000,
            lastAt: BORN + 4 * DAY,
          }),
        ],
      }),
    );
    const renewed = rows.find((r) => r.verb === "session")!;
    expect(renewed.target).toBe("@deepseek · deepseek-flash");
    expect(rowSaid(renewed)).toBe("new session on @deepseek · deepseek-flash");
    expect(rows.filter((r) => r.verb === "spend").length).toBe(0);
  });

  test("a card in its first minute, with spend and no session row yet, still says when it began", () => {
    const rows = timeline(life({ sessions: [] }));
    expect(rows.length).toBe(1);
    expect(rows[0].verb).toBe("spend");
    expect(rows[0].at).toBe(BORN + 5 * 60_000);
    expect(rows[0].target).toBe("lyss · claude-opus-5-5");
  });

  test("rows are ordered by the clock, and a session at the same instant comes before a move", () => {
    const rows = timeline(
      life({
        moves: [
          { at: BORN + 2 * HOUR, kind: "model", reference: "claude-sonnet-5-5" },
          { at: BORN, kind: "account", reference: "lyss" },
        ] as LifeMove[],
      }),
    );
    expect(rows.map((r) => r.at)).toEqual([BORN, BORN, BORN + 2 * HOUR]);
    expect(rows[0].verb).toBe("opened");
    expect(rows[1].verb).toBe("account");
  });
});

describe("the whole reading", () => {
  test("dollars are all time and the token half knows its own scope", () => {
    const model = lifeModel(life(), BORN + 2 * DAY);
    expect(model.usd).toBe(3.75);
    expect(model.perTurn).toBeCloseTo(0.375, 10);
    expect(model.partial).toBe(false);
    expect(splitSaid(model)).toBe("");
    expect(model.sessions).toBe(1);
    expect(model.tokens).toBe(5700);
    expect(model.requests).toBe(4);
  });

  test("a card older than the facts says where the token half begins", () => {
    const model = lifeModel(life({ factsFrom: BORN + 5 * DAY }), BORN + 20 * DAY);
    expect(model.partial).toBe(true);
    expect(splitSaid(model, BORN + 20 * DAY)).toContain("ninety days");
    expect(splitSaid(model, BORN + 20 * DAY)).toContain(daySaid(BORN + 5 * DAY, BORN + 20 * DAY));
  });

  test("no settled turn is blank, never a division by zero", () => {
    const model = lifeModel(life({ turns: 0, usdReported: 0 }), BORN);
    expect(model.perTurn).toBeNull();
  });

  test("an open session is lived to now, and a closed one to its last end", () => {
    const open = lifeModel(life({ sessions: [session({ endedAt: null })] }), BORN + 4 * DAY);
    expect(open.open).toBe(true);
    expect(open.lived).toBe(4 * DAY);
    const closed = lifeModel(life(), BORN + 9 * DAY);
    expect(closed.open).toBe(false);
    expect(closed.lived).toBe(2 * DAY);
  });

  test("the chip is what it is on now and never the caption of the total", () => {
    const model = lifeModel(life(), BORN);
    expect(nowSaid(model)).toBe("now on lyss · claude-opus-5-5");
    const bare = lifeModel(life({ nowAccount: "", nowModel: "" }), BORN);
    expect(nowSaid(bare)).toBe("nothing recorded");
  });
});

describe("saying it", () => {
  test("a duration reads in the unit its size deserves", () => {
    expect(livedSaid(0)).toBe("less than a minute");
    expect(livedSaid(42 * 60_000)).toBe("42 min");
    expect(livedSaid(3 * HOUR + 20 * 60_000)).toBe("3h 20m");
    /* Forty seconds short of four hours rounds to the hour, never `3h 60m`. */
    expect(livedSaid(3 * HOUR + 59 * 60_000 + 40_000)).toBe("4 hours");
    expect(livedSaid(3 * DAY + 4 * HOUR)).toBe("3 days 4h");
    expect(livedSaid(DAY)).toBe("1 day");
  });

  test("a funding skips the two absences rather than printing them", () => {
    expect(fundingSaid("lyss", "m")).toBe("lyss · m");
    expect(fundingSaid("unknown", "m")).toBe("m");
    expect(fundingSaid("", "")).toBe("");
  });

  test("an empty life says so rather than drawing a bar over nothing", () => {
    const model = lifeModel(life({ sessions: [], spend: [], turns: 0, usdReported: 0, factsFrom: 0 }), Date.now());
    expect(model.tokens).toBe(0);
    expect(model.partial).toBe(false);
    expect(splitSaid(model)).toBe("no requests recorded for this card");
    expect(model.timeline).toEqual([]);
    expect(model.born).toBe(0);
  });

  test("a day is named without a locale, so two machines agree", () => {
    expect(daySaid(BORN, BORN + DAY)).toBe("3 Nov");
    expect(daySaid(BORN, BORN + 400 * DAY)).toBe("3 Nov 2026");
  });
});
