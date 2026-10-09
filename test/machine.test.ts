import { describe, expect, test } from "bun:test";
import {
  UNSUPPORTED,
  awakeLine,
  awakeSaid,
  comeback,
  normalize,
  reopenLine,
  reopenSaid,
  type MachineStatus,
} from "../src/lib/machine";

const laptop: MachineStatus = {
  supported: true,
  awake: true,
  power: "mains",
  holding: true,
  lid: "nothing",
  reopen: true,
  ownsEntry: true,
  armed: true,
  startupBlocked: false,
  arso: { policyOff: false, user: true, managed: false },
};

describe("how far a wall comes back by itself", () => {
  test("an unmanaged machine with automatic sign-in comes back after any restart", () => {
    expect(comeback({ policyOff: false, user: true, managed: false })).toBe("any");
    /* Never touched is Windows' default, which is on. */
    expect(comeback({ policyOff: false, user: null, managed: false })).toBe("any");
  });

  test("a managed machine comes back after update restarts only", () => {
    expect(comeback({ policyOff: false, user: true, managed: true })).toBe("updates");
  });

  test("a policy or her own switch leaves it waiting for a sign-in", () => {
    expect(comeback({ policyOff: true, user: true, managed: false })).toBe("signin");
    expect(comeback({ policyOff: false, user: false, managed: true })).toBe("signin");
  });
});

describe("the awake sentence says what defeats it", () => {
  test("held on mains with a lid that does nothing", () => {
    expect(awakeSaid(laptop)).toBe("keeping this machine awake — it is on mains power");
  });

  test("a lid that sleeps is said in the toggle's own words, not left to a rule file", () => {
    expect(awakeSaid({ ...laptop, lid: "sleep" })).toContain("closing the lid still puts it to sleep");
    expect(awakeSaid({ ...laptop, lid: "unknown" })).toContain("closed lid may still");
    expect(awakeSaid({ ...laptop, lid: "absent" })).toBe(
      "keeping this machine awake — it is on mains power",
    );
  });

  test("on battery it says it is letting go", () => {
    expect(awakeSaid({ ...laptop, power: "battery", holding: false })).toContain("on battery now");
  });

  test("off is just the knob", () => {
    expect(awakeSaid({ ...laptop, awake: false, holding: false })).toBe(
      "letting this machine sleep as usual",
    );
  });

  test("a request windows refused does not claim to be holding", () => {
    expect(awakeSaid({ ...laptop, holding: false })).toContain("refused");
  });
});

describe("the reopen sentence says how far it reaches", () => {
  test("any restart, behind the lock screen", () => {
    expect(reopenSaid(laptop)).toBe("reopen after a restart — after any restart, behind the lock screen");
  });

  test("a switch never touched says what the claim rests on", () => {
    const line = reopenSaid({ ...laptop, arso: { ...laptop.arso, user: null } });
    expect(line).toContain('if "use my sign-in info" is on');
  });

  test("a managed machine says why it is narrower", () => {
    const line = reopenSaid({ ...laptop, arso: { ...laptop.arso, managed: true } });
    expect(line).toContain("after update restarts only");
    expect(line).toContain("work machine");
  });

  test("a policy and an opt-out each name what to do or who did it", () => {
    expect(reopenSaid({ ...laptop, arso: { ...laptop.arso, policyOff: true } })).toContain(
      "your administrator",
    );
    expect(reopenSaid({ ...laptop, arso: { ...laptop.arso, user: false } })).toContain(
      "sign-in options",
    );
  });

  test("task manager and a debug build both outrank windows' sign-in", () => {
    expect(reopenSaid({ ...laptop, startupBlocked: true })).toContain("task manager");
    expect(reopenSaid({ ...laptop, ownsEntry: false })).toContain("installed app");
  });

  test("off is just the knob", () => {
    expect(reopenSaid({ ...laptop, reopen: false })).toBe("not reopening after a restart");
  });
});

describe("the menu rows stay short", () => {
  /* The ground menu is `nowrap`, so one long row widens the whole menu — the
     first cut of these did, to ~590px. Every state is walked, so a new branch
     cannot slip a sentence in. */
  const states: MachineStatus[] = [];
  for (const power of ["mains", "battery", "unknown"] as const)
    for (const lid of ["absent", "nothing", "sleep", "hibernate", "shutdown", "unknown"] as const)
      for (const holding of [true, false])
        for (const awake of [true, false])
          states.push({ ...laptop, power, lid, holding, awake });
  for (const policyOff of [true, false])
    for (const user of [true, false, null])
      for (const managed of [true, false])
        for (const startupBlocked of [true, false])
          for (const ownsEntry of [true, false])
            states.push({ ...laptop, startupBlocked, ownsEntry, arso: { policyOff, user, managed } });
  states.push(UNSUPPORTED);

  test("no row is longer than a short phrase", () => {
    for (const s of states) {
      expect(awakeLine(s).length).toBeLessThanOrEqual(48);
      expect(reopenLine(s).length).toBeLessThanOrEqual(48);
    }
  });

  test("the short row still carries the lid and the narrower reach", () => {
    expect(awakeLine({ ...laptop, lid: "sleep" })).toContain("lid");
    expect(reopenLine({ ...laptop, arso: { ...laptop.arso, managed: true } })).toContain("update restarts only");
    expect(reopenLine({ ...laptop, arso: { ...laptop.arso, policyOff: true } })).toContain("policy");
  });
});

describe("whatever comes over the wire is drawable", () => {
  test("garbage is unsupported", () => {
    expect(normalize(null)).toEqual(UNSUPPORTED);
    expect(normalize("nope")).toEqual(UNSUPPORTED);
  });

  test("unknown enum values degrade to unknown", () => {
    const s = normalize({ ...laptop, power: "nuclear", lid: "flaps" });
    expect(s.power).toBe("unknown");
    expect(s.lid).toBe("unknown");
  });

  test("a well-formed status comes through untouched", () => {
    expect(normalize(JSON.parse(JSON.stringify(laptop)))).toEqual(laptop);
  });
});
