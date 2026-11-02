import { describe, expect, test } from "bun:test";
import { RENEW_ASK, RENEW_MARK_FROM, renewMarkTitle, renewWorth, rereads, tokensShort } from "../src/lib/renewing";

describe("a card's context, said as its price", () => {
  test("in tokens a person reads at a glance", () => {
    expect(tokensShort(480_123)).toBe("480k");
    expect(tokensShort(1_840)).toBe("1.8k");
    expect(tokensShort(640)).toBe("640");
    expect(rereads(480_123)).toBe("every request re-reads 480k tokens");
  });
});

describe("the quiet mark on a coordinator worth renewing", () => {
  test("only for a large card with children open under it", () => {
    expect(renewWorth(RENEW_MARK_FROM, 1)).toBe(true);
    expect(renewWorth(RENEW_MARK_FROM - 1, 4)).toBe(false);
    expect(renewWorth(900_000, 0)).toBe(false);
  });
  test("says the price, the children and the way to do it", () => {
    const t = renewMarkTitle(480_000, 2);
    expect(t).toContain("480k");
    expect(t).toContain("2 cards open");
    expect(t).toContain("space then c n");
    expect(renewMarkTitle(480_000, 1)).toContain("1 card open");
  });
});

describe("the prompt Lyss's gesture sends", () => {
  test("names the tool in full and asks for the note's four parts", () => {
    expect(RENEW_ASK).toContain("mcp__skein__renew");
    for (const part of ["decided", "in flight", "next", "durable notes"]) expect(RENEW_ASK).toContain(part);
    expect(RENEW_ASK.startsWith("/")).toBe(false);
  });
});
