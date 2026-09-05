import { expect, test, describe } from "bun:test";
import {
  clip,
  delayFor,
  FLOOR,
  gradeOf,
  gradeOfImpact,
  gradeOfPart,
  gradeOfReading,
  gradeClaimed,
  headlineOf,
  hiddenBy,
  incidentsOf,
  isStale,
  latestNote,
  PACE,
  paceFor,
  rankOf,
  rowsOf,
  sayAge,
  sayGrade,
  STALE,
  toneOf,
  understates,
  worse,
  type Grade,
  type Health,
  type Incident,
  type Part,
  type Reading,
} from "../src/lib/status";

/* The shapes below are cut from what `status.claude.com/api/v2/summary.json`
   actually answered on 2026-08-27 — see the probe transcript at the head of
   `src-tauri/src/status.rs`. Six components, no groups, and an incident whose
   notes shed affected components as it resolves. */

const part = (name: string, status: string, position: number, extra: Partial<Part> = {}): Part => ({
  name,
  status,
  position,
  group: false,
  hiddenWhenWell: false,
  ...extra,
});

const health = (over: Partial<Health> = {}): Health => ({
  indicator: "none",
  description: "All Systems Operational",
  updatedAt: "2026-08-27T02:34:03.699Z",
  components: [
    part("claude.ai", "operational", 1),
    part("Claude Console (platform.claude.com)", "operational", 2),
    part("Claude API (api.anthropic.com)", "operational", 3),
    part("Claude Code", "operational", 4),
  ],
  incidents: [],
  maintenances: [],
  ...over,
});

const got = (over: Partial<Health> = {}, at = 1_000): Reading => ({
  got: true,
  health: health(over),
  at,
});

const lost = (at = 1_000): Reading => ({ got: false, fault: "dns failed", at });

const incident = (over: Partial<Incident> = {}): Incident => ({
  id: "n0rlp126qf8g",
  name: "Issues logging into Claude.ai",
  status: "monitoring",
  impact: "minor",
  url: "https://stspg.io/6211zbpptv0y",
  startedAt: "2026-08-24T20:11:23.924Z",
  notes: [
    { status: "monitoring", body: "Monitoring closely.", at: "2026-08-24T20:26:21.577Z" },
    { status: "investigating", body: "Looking into it.", at: "2026-08-24T20:11:24.058Z" },
  ],
  affects: ["claude.ai"],
  ...over,
});

describe("the two ladders Statuspage publishes become one this wall speaks", () => {
  test("the page's site indicator maps onto every rung", () => {
    expect(gradeOf("none")).toBe("well");
    expect(gradeOf("minor")).toBe("watch");
    expect(gradeOf("major")).toBe("wrong");
    expect(gradeOf("critical")).toBe("broken");
    expect(gradeOf("maintenance")).toBe("planned");
  });

  test("a component's own vocabulary lands on the same rungs", () => {
    expect(gradeOfPart("operational")).toBe("well");
    expect(gradeOfPart("degraded_performance")).toBe("watch");
    expect(gradeOfPart("partial_outage")).toBe("wrong");
    expect(gradeOfPart("major_outage")).toBe("broken");
    expect(gradeOfPart("under_maintenance")).toBe("planned");
  });

  /* The failure direction that matters. A rung Statuspage adds tomorrow, read
     as "all fine", would be this widget saying the opposite of the truth in the
     one case it exists for. Read as "cannot tell" it is merely honest. */
  test("a word neither ladder knows is unknown, never well", () => {
    for (const odd of ["", "degraded", "partial", "SEV1", "operational_ish"]) {
      expect(gradeOf(odd)).toBe("unknown");
      expect(gradeOfPart(odd)).toBe("unknown");
    }
  });

  test("an incident's impact is the site ladder, with none meaning fine", () => {
    expect(gradeOfImpact("none")).toBe("well");
    expect(gradeOfImpact("critical")).toBe("broken");
  });

  test("worse is worse, and planned is not a fault", () => {
    expect(worse("well", "broken")).toBe("broken");
    expect(worse("watch", "planned")).toBe("watch");
    expect(rankOf("planned")).toBeLessThan(rankOf("watch"));
    /* Not knowing must not outrank being told. */
    expect(rankOf("unknown")).toBeLessThan(rankOf("well"));
  });

  test("every rung has a word and none of them shouts", () => {
    const grades: Grade[] = ["well", "watch", "wrong", "broken", "planned", "unknown"];
    for (const g of grades) {
      const said = sayGrade(g);
      expect(said.length).toBeGreaterThan(0);
      expect(said).toBe(said.toLowerCase());
    }
  });
});

describe("colour is reserved for status, and absence of a reading is not one", () => {
  test("the five rungs wear the five status tokens and nothing new", () => {
    expect(toneOf("well")).toBe("var(--st-work)");
    expect(toneOf("watch")).toBe("var(--st-soft)");
    expect(toneOf("wrong")).toBe("var(--st-ask)");
    expect(toneOf("broken")).toBe("var(--st-fail)");
    expect(toneOf("planned")).toBe("var(--st-rest)");
  });

  /* The one that would be a bug rather than a preference: a page we could not
     reach drawn in a status colour is the widget inventing news. */
  test("unknown is achromatic", () => {
    expect(toneOf("unknown")).toBe("var(--paper-faint)");
    expect(toneOf("unknown")).not.toMatch(/--st-/);
  });

  test("no rung reaches for a colour the wall has not already declared", () => {
    const grades: Grade[] = ["well", "watch", "wrong", "broken", "planned", "unknown"];
    for (const g of grades) {
      expect(toneOf(g)).toMatch(/^var\(--(st-(work|soft|ask|fail|rest)|paper-faint)\)$/);
    }
  });
});

describe("what a reading amounts to", () => {
  test("a quiet page is well, in the page's own sentence", () => {
    const r = got();
    expect(gradeOfReading(r)).toBe("well");
    expect(headlineOf(r).line).toBe("All Systems Operational");
    expect(headlineOf(r).sub).toBeNull();
  });

  test("a reading that never landed is unknown and says so", () => {
    expect(gradeOfReading(lost())).toBe("unknown");
    expect(headlineOf(lost()).line).toBe("could not reach the status page");
  });

  test("the page's indicator leads, because the page knows more than we do", () => {
    const r = got({ indicator: "major", description: "Major Service Outage" });
    expect(gradeOfReading(r)).toBe("wrong");
  });

  /* Observed on real Statuspage instances in the gap between a component being
     flipped and an incident being opened. "All Systems Operational" printed over
     a rust row would be a widget arguing with itself. */
  test("a component worse than the headline drags the headline down", () => {
    const r = got({
      indicator: "none",
      components: [part("claude.ai", "operational", 1), part("Claude Code", "major_outage", 4)],
    });
    expect(gradeOfReading(r)).toBe("broken");
  });

  test("a group row is a heading and cannot drag anything anywhere", () => {
    const r = got({
      components: [part("Everything", "major_outage", 1, { group: true })],
    });
    expect(gradeOfReading(r)).toBe("well");
  });

  test("a page with no sentence of its own falls back to our word", () => {
    expect(headlineOf(got({ description: "   " })).line).toBe("operational");
  });
});

/* The bug the user reported on 2026-09-04, from the wire that caused it.
   `incidents.json` for 2026-09-03 carries "Elevated errors for multiple models":
   claude.ai, the API, Claude Code and Cowork all set to `partial_outage` from
   13:26 to 16:23 UTC, while the site indicator — which Statuspage computes from
   incident impact rather than from components — sat a rung below, and its canned
   sentence with it. The dot was already honest; the words were not, and the one
   line carrying our own word for the grade was suppressed by the presence of an
   incident, i.e. exactly whenever there was one. */
describe("the page's own sentence may not understate the page's own components", () => {
  const outage = () =>
    got({
      indicator: "minor",
      description: "Minor Service Outage",
      components: [
        part("claude.ai", "partial_outage", 1),
        part("Claude Console (platform.claude.com)", "operational", 2),
        part("Claude API (api.anthropic.com)", "partial_outage", 3),
        part("Claude Code", "partial_outage", 4),
      ],
      incidents: [
        incident({
          name: "Elevated errors for multiple models",
          status: "identified",
          impact: "major",
          affects: ["claude.ai", "Claude API (api.anthropic.com)", "Claude Code"],
        }),
      ],
    });

  test("the reading grades on the components, not on the indicator", () => {
    expect(gradeClaimed(outage())).toBe("watch");
    expect(gradeOfReading(outage())).toBe("wrong");
    expect(understates(outage())).toBe(true);
  });

  test("our word leads, and it is the word for what is actually down", () => {
    expect(headlineOf(outage()).line).toBe("partial outage");
    expect(headlineOf(outage()).line).not.toMatch(/minor/i);
  });

  test("the page's sentence is kept verbatim rather than dropped", () => {
    expect(headlineOf(outage()).sub).toBe('page says "Minor Service Outage"');
  });

  /* An open incident is not the trigger and never was — the sub line is about
     two sources disagreeing, and the previous shape hid it whenever an incident
     existed, which is the only time the disagreement matters. */
  test("a page agreeing with itself says one thing and no more", () => {
    const r = got({
      indicator: "major",
      description: "Partial System Outage",
      components: [part("Claude Code", "partial_outage", 4)],
      incidents: [incident({ impact: "major" })],
    });
    expect(understates(r)).toBe(false);
    expect(headlineOf(r)).toEqual({ line: "Partial System Outage", sub: null });
  });

  /* The direction that must never invert: the page saying something *worse* than
     its components is the page knowing more than we do, and it keeps the floor. */
  test("a page worse than its own components keeps its own sentence", () => {
    const r = got({ indicator: "critical", description: "Major Service Outage" });
    expect(gradeOfReading(r)).toBe("broken");
    expect(understates(r)).toBe(false);
    expect(headlineOf(r).line).toBe("Major Service Outage");
  });

  test("a reading that never landed claims nothing either way", () => {
    expect(gradeClaimed(lost())).toBe("unknown");
    expect(understates(lost())).toBe(false);
  });
});

describe("the rows a list reading draws", () => {
  test("worst first, then the page's own order", () => {
    const r = got({
      indicator: "minor",
      components: [
        part("claude.ai", "operational", 1),
        part("Claude Console", "operational", 2),
        part("Claude API", "major_outage", 3),
        part("Claude Code", "degraded_performance", 4),
      ],
    });
    expect(rowsOf(r).map((x) => x.name)).toEqual([
      "Claude API",
      "Claude Code",
      "claude.ai",
      "Claude Console",
    ]);
  });

  /* On a green day nothing may shuffle: every grade is equal, so `position`
     alone decides and the list is the page's list. */
  test("a green page draws in the page's order and holds still", () => {
    expect(rowsOf(got()).map((x) => x.position)).toEqual([1, 2, 3, 4]);
  });

  test("a group row is not a service and is never drawn", () => {
    const r = got({ components: [part("Everything", "operational", 1, { group: true })] });
    expect(rowsOf(r)).toEqual([]);
  });

  /* The flag is the page saying "do not put this in front of people unless it
     matters", which is why it is carried up from Rust at all. */
  test("a component the page hides while it is well is hidden while it is well", () => {
    const hiddenOk = got({
      components: [part("Claude for Government", "operational", 6, { hiddenWhenWell: true })],
    });
    expect(rowsOf(hiddenOk)).toEqual([]);

    const hiddenIll = got({
      components: [part("Claude for Government", "partial_outage", 6, { hiddenWhenWell: true })],
    });
    expect(rowsOf(hiddenIll).map((x) => x.name)).toEqual(["Claude for Government"]);
  });

  test("the narrowing keeps only what is not operational", () => {
    const r = got({
      components: [
        part("claude.ai", "operational", 1),
        part("Claude Code", "degraded_performance", 4),
      ],
    });
    expect(rowsOf(r, true).map((x) => x.name)).toEqual(["Claude Code"]);
  });

  /* An empty pane that cannot account for itself reads as a widget that has
     broken — the debt `logface.ts` settles for the three logs. */
  test("a filter that emptied the pane can say how much it dropped", () => {
    const r = got();
    expect(rowsOf(r, true)).toEqual([]);
    expect(hiddenBy(r, true)).toBe(4);
    expect(hiddenBy(r, false)).toBe(0);
  });

  test("a failed reading has no rows and does not pretend to", () => {
    expect(rowsOf(lost())).toEqual([]);
    expect(rowsOf(lost(), true)).toEqual([]);
  });
});

describe("incidents", () => {
  test("worst first, then newest", () => {
    const r = got({
      incidents: [
        incident({ id: "a", impact: "minor", startedAt: "2026-08-26T10:00:00Z" }),
        incident({ id: "b", impact: "critical", startedAt: "2026-08-20T10:00:00Z" }),
        incident({ id: "c", impact: "minor", startedAt: "2026-08-27T10:00:00Z" }),
      ],
    });
    expect(incidentsOf(r).map((i) => i.id)).toEqual(["b", "c", "a"]);
  });

  /* A window three weeks out is not a reading of now, which is why the knob
     defaults off — and it is exactly what somebody planning a Friday deploy
     wants, which is why there is a knob at all. */
  test("scheduled maintenance is folded in only when asked for", () => {
    const r = got({ maintenances: [incident({ id: "m", impact: "none" })] });
    expect(incidentsOf(r)).toEqual([]);
    expect(incidentsOf(r, true).map((i) => i.id)).toEqual(["m"]);
  });

  test("the latest note is taken by its stamp, not by where the wire put it", () => {
    const shuffled = incident({
      notes: [
        { status: "investigating", body: "first", at: "2026-08-24T20:11:24.058Z" },
        { status: "monitoring", body: "second", at: "2026-08-24T20:26:21.577Z" },
      ],
    });
    expect(latestNote(shuffled)?.body).toBe("second");
  });

  test("an incident with nothing said about it yet is not a crash", () => {
    expect(latestNote(incident({ notes: [] }))).toBeNull();
  });

  test("a failed reading holds no incidents", () => {
    expect(incidentsOf(lost(), true)).toEqual([]);
  });
});

describe("prose cut to a widget's line", () => {
  test("a body that fits is left exactly alone", () => {
    expect(clip("Monitoring closely.", 90)).toBe("Monitoring closely.");
  });

  test("hard newlines Statuspage sends become one line", () => {
    expect(clip("We have identified\nand resolved\tan issue.")).toBe(
      "We have identified and resolved an issue.",
    );
  });

  test("a paragraph is cut to length, ellipsis included", () => {
    const cut = clip("x".repeat(400), 40);
    expect(cut).toHaveLength(40);
    expect(cut.endsWith("…")).toBe(true);
  });

  test("nothing is not a crash", () => {
    expect(clip("")).toBe("");
    expect(clip("   \n  ")).toBe("");
  });
});

describe("how old a reading is allowed to look", () => {
  const now = 10_000_000;

  test("fresh is fresh", () => {
    expect(isStale({ got: true, health: health(), at: now - 60_000 }, now)).toBe(false);
  });

  /* The only way to reach this is to have been away, which is exactly the case
     where a green dot would be a claim nobody checked. */
  test("half an hour is where a reading stops being a reading of now", () => {
    expect(isStale(got({}, now - STALE + 1), now)).toBe(false);
    expect(isStale(got({}, now - STALE), now)).toBe(true);
  });

  test("stale is twice the calm backstop, so a watched wall never sees it", () => {
    expect(STALE).toBe(2 * PACE.calm);
  });

  test("the age is said in the register the billboard already set", () => {
    expect(sayAge(now, now)).toBe("just now");
    expect(sayAge(now - 59_000, now)).toBe("just now");
    expect(sayAge(now - 3 * 60_000, now)).toBe("3m ago");
    expect(sayAge(now - 2 * 3_600_000, now)).toBe("2h ago");
    expect(sayAge(now - 3 * 86_400_000, now)).toBe("3d ago");
  });

  test("a clock that has gone backwards reads as now rather than as negative", () => {
    expect(sayAge(now + 5_000, now)).toBe("just now");
  });
});

describe("the cadence, which is the whole argument for this widget existing", () => {
  /* `update.ts`'s third bound is "stop for good once there is something to say",
     on the observation that no further ask can change the answer. An outage
     resolves, so the same observation runs the other way here: the moment there
     is something to say is the moment the answer starts changing. */
  test("green is asked about rarely and anything else often", () => {
    expect(paceFor("well")).toBe(PACE.calm);
    for (const g of ["watch", "wrong", "broken", "planned"] as Grade[]) {
      expect(paceFor(g)).toBe(PACE.alert);
    }
    expect(PACE.alert).toBeLessThan(PACE.calm);
  });

  /* The rung this classification exists to get right. Backing off to the calm
     pace when we could not reach the page would make the one case where the
     instrument is useful the one case where it is slowest. */
  test("not knowing is asked about at the unwell pace, because it resolves too", () => {
    expect(paceFor("unknown")).toBe(PACE.alert);
  });

  test("the floor never lets a trigger ask twice inside a minute", () => {
    expect(delayFor(0)).toBe(FLOOR);
    expect(delayFor(FLOOR / 2)).toBe(FLOOR / 2);
    expect(delayFor(FLOOR)).toBe(0);
    expect(delayFor(FLOOR * 10)).toBe(0);
  });

  test("a wall that has never asked asks on this tick", () => {
    expect(delayFor(Number.POSITIVE_INFINITY)).toBe(0);
  });

  /* A card's turn ending in an error routes through the same floor as a focus,
     so a territory of six cards failing in the same second is one ask and not
     six. That is the whole of the guard against an outage causing a small
     storm of requests about the outage. */
  test("a burst of triggers inside the floor is still one ask", () => {
    let since = 0;
    const waits = [0, 1_000, 1_050, 1_100].map((t) => delayFor(since + t));
    expect(waits.every((w) => w > 0)).toBe(true);
    since = FLOOR + 1;
    expect(delayFor(since)).toBe(0);
  });

  test("the calm backstop is the update check's, deliberately", () => {
    expect(PACE.calm).toBe(15 * 60_000);
  });
});
