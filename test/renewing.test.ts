import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  RENEW_ASK,
  RENEW_BUSY,
  RENEW_DROPPED,
  RENEW_MARK_FROM,
  RENEW_NOT_SCHEDULED,
  renewBlocker,
  renewDeclined,
  renewMarkTitle,
  scheduleAhead,
  renewWorth,
  rereads,
  tokensShort,
} from "../src/lib/renewing";

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

describe("a renewal Rust declined to perform", () => {
  test("the three prefixes are the ones renew.rs writes", () => {
    const rust = readFileSync(new URL("../src-tauri/src/renew.rs", import.meta.url), "utf8");
    const said = (name: string) => rust.match(new RegExp(`pub const ${name}: &str = "([^"]+)";`))?.[1];
    expect(said("NOT_SCHEDULED")).toBe(RENEW_NOT_SCHEDULED);
    expect(said("BUSY")).toBe(RENEW_BUSY);
    expect(said("DROPPED")).toBe(RENEW_DROPPED);
  });

  test("nothing scheduled any more stops the waiting — the id is never kept to retry after every turn", () => {
    expect(renewDeclined("not-scheduled: no renewal is scheduled for ab12cd34")).toBe("gone");
    expect(renewDeclined("Error: not-scheduled: no renewal")).toBe("gone");
  });

  test("mid-turn is asked again; a renewal given up is not; anything else is raised", () => {
    expect(renewDeclined("busy: the card is mid-turn")).toBe("later");
    expect(renewDeclined("dropped: this card has 2 background jobs")).toBe("dropped");
    expect(renewDeclined("no conversation x")).toBe("failed");
  });
});

describe("what a renewal would destroy, which only the wall can see", () => {
  const now = 1_000_000;
  const none = { jobs: 0, timers: [], now };

  test("nothing running, nothing armed: no blocker", () => {
    expect(renewBlocker(none)).toBeNull();
  });

  test("a background job gives the renewal up, and says to renew once it has reported", () => {
    expect(renewBlocker({ ...none, jobs: 1 })).toContain("1 background job still running");
    expect(renewBlocker({ ...none, jobs: 3 })).toContain("3 background jobs");
  });

  test("a schedule still ahead gives it up; one that has fired does not, whatever the reaper's slack says", () => {
    const sched = renewBlocker({ ...none, timers: [{ at: now + 60_000, until: now + 960_000 }] })!;
    expect(sched).toContain("CronCreate");
    expect(sched).toMatch(/then renew\.$/);
    /* Woken by its own ScheduleWakeup a minute ago: armed for the reaper,
       spent for a renewal. */
    expect(renewBlocker({ ...none, timers: [{ at: now - 60_000, until: now + 840_000 }] })).toBeNull();
  });

  test("a recurring job blocks while it lives; a one-shot with no readable time never blocks for ever", () => {
    expect(scheduleAhead([{ at: null, until: now + 3_600_000 }], now)).toBe(true);
    expect(scheduleAhead([{ at: null, until: now - 1 }], now)).toBe(false);
    expect(scheduleAhead([{ at: null, until: null }], now)).toBe(false);
  });
});
