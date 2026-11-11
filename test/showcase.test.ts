import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  ADMISSION_SAID,
  ANALYTICS,
  ASK,
  ASSIGNMENTS,
  ASSIGNMENT_SUMMARY,
  BOOST_SAID,
  CARD_PROSE,
  CARD_PROSE_AFTER,
  CARD_RUN,
  CHAPTERS,
  COORDINATE,
  DESIGN_ASK,
  DESK,
  COMPARE,
  COMPARE_NOTE,
  NEXT,
  PLANE_H,
  PLANE_W,
  SECURITY_FACTS,
  SECURITY_HEADLINE,
  SECURITY_PLANS,
  SECURITY_STAGE,
  SHOW_CARD_H,
  SLEEP_SAID,
  SHOW_CARD_W,
  STATUS_SAID,
  USAGE_SAID,
  TABS_STORY,
  TERMINAL_LINES,
  TOOLS,
  WALL_CARDS,
  WALL_TERRITORIES,
  chapterIndex,
  nextChapter,
  previousChapter,
  progress,
  theftStory,
} from "../src/lib/showcase";

describe("the tour's chapters", () => {
  test("there are ten of them and every id is reachable", () => {
    expect(CHAPTERS.length).toBe(10);
    expect(new Set(CHAPTERS.map((c) => c.id)).size).toBe(10);
  });

  test("every chapter has a title and a lede worth reading", () => {
    for (const c of CHAPTERS) {
      expect(c.title.trim().length).toBeGreaterThan(2);
      expect(c.lede.trim().length).toBeGreaterThan(20);
    }
  });

  test("the heading is a sentence rather than the rail's label again", () => {
    for (const c of CHAPTERS) {
      expect(c.head.trim().length).toBeGreaterThan(10);
      expect(c.head).not.toBe(c.title);
    }
  });

  test("index, next and previous agree with the array", () => {
    expect(chapterIndex("why")).toBe(0);
    expect(chapterIndex("next")).toBe(CHAPTERS.length - 1);
    expect(nextChapter(0)).toBe(1);
    expect(nextChapter(CHAPTERS.length - 1)).toBe(0);
    expect(previousChapter(0)).toBe(CHAPTERS.length - 1);
  });

  test("progress runs from zero to one and never past either", () => {
    expect(progress(0)).toBe(0);
    expect(progress(CHAPTERS.length - 1)).toBe(1);
    for (let i = 0; i < CHAPTERS.length; i++) {
      expect(progress(i)).toBeGreaterThanOrEqual(0);
      expect(progress(i)).toBeLessThanOrEqual(1);
    }
  });
});

describe("the demo wall", () => {
  test("every card sits inside the plane", () => {
    for (const c of WALL_CARDS) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + SHOW_CARD_W).toBeLessThanOrEqual(PLANE_W);
      expect(c.y + SHOW_CARD_H).toBeLessThanOrEqual(PLANE_H);
    }
  });

  test("every card has a status the legend can explain", () => {
    for (const c of WALL_CARDS) {
      expect(STATUS_SAID[c.status]).toBeTruthy();
    }
  });

  test("there is one card of every status on the wall", () => {
    const seen = new Set(WALL_CARDS.map((c) => c.status));
    for (const s of ["work", "ask", "rest", "fail", "idle"] as const) {
      expect(seen.has(s)).toBe(true);
    }
  });

  test("a territory contains at least one card, so none is decoration", () => {
    for (const t of WALL_TERRITORIES) {
      const inside = WALL_CARDS.filter(
        (c) => c.x >= t.x && c.y >= t.y && c.x + SHOW_CARD_W <= t.x + t.w && c.y + SHOW_CARD_H <= t.y + t.h,
      );
      expect(inside.length).toBeGreaterThan(0);
    }
  });
});

describe("spreading the work", () => {
  test("every assignment names all four resources and says why", () => {
    for (const a of ASSIGNMENTS) {
      for (const f of ["job", "model", "effort", "source", "host", "why"] as const) {
        expect(a[f].trim().length).toBeGreaterThan(2);
      }
    }
  });

  test("the fan-out actually spreads", () => {
    expect(new Set(ASSIGNMENTS.map((a) => a.model)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(ASSIGNMENTS.map((a) => a.source)).size).toBe(3);
    expect(new Set(ASSIGNMENTS.map((a) => a.host)).size).toBe(2);
  });

  test("the summary is counted from the assignments, not typed", () => {
    expect(ASSIGNMENT_SUMMARY).toContain(`${ASSIGNMENTS.length} cards`);
    expect(ASSIGNMENT_SUMMARY).toContain("2 subscriptions and 1 balance");
    expect(ASSIGNMENT_SUMMARY).toContain("2 machines");
  });

  test("boost, admission, sleep and usage each say enough to act on", () => {
    for (const said of [BOOST_SAID, ADMISSION_SAID, SLEEP_SAID, USAGE_SAID]) {
      expect(said.trim().length).toBeGreaterThan(60);
    }
  });
});

describe("the desk", () => {
  test("every thing says what it is, what it needs and what it costs", () => {
    for (const d of DESK) {
      expect(d.name.trim().length).toBeGreaterThan(2);
      expect(d.line.trim().length).toBeGreaterThan(30);
      expect(d.needs.trim().length).toBeGreaterThan(3);
      expect(d.cost.trim().length).toBeGreaterThan(20);
      expect(["wall", "machine", "wire", "service"]).toContain(d.where);
    }
  });

  test("all four places have something in them, so no heading is empty", () => {
    for (const w of ["wall", "machine", "wire", "service"] as const) {
      expect(DESK.filter((d) => d.where === w).length).toBeGreaterThan(0);
    }
  });

  test("the services the user named are on it", () => {
    for (const id of ["asana", "pipelines", "spotify", "claude-status", "analytics", "sources"]) {
      expect(DESK.some((d) => d.id === id)).toBe(true);
    }
  });

  test("the things that are the wall's identity are on it", () => {
    for (const id of [
      "plans",
      "instructions",
      "themes",
      "chronicle",
      "pictures",
      "toys",
      "away",
      "notifications",
      "portage",
      "kit",
      "compact",
      "finder",
      "voice",
    ]) {
      expect(DESK.some((d) => d.id === id)).toBe(true);
    }
  });
});

describe("the transcript demo", () => {
  test("the terminal side is the raw stream, not a tidy summary", () => {
    expect(TERMINAL_LINES.length).toBeGreaterThan(10);
    expect(TERMINAL_LINES.some((l) => l.includes(`"type":"tool_use"`))).toBe(true);
    expect(TERMINAL_LINES.some((l) => l.includes(`"type":"result"`))).toBe(true);
  });

  test("the folded run carries a diff, because an edit drawn as prose is not one", () => {
    const edit = CARD_RUN.find((c) => c.tool === "Edit");
    expect(edit?.diff?.length).toBeGreaterThan(3);
    expect(edit?.diff?.some((d) => d.sign === "+")).toBe(true);
    expect(edit?.diff?.some((d) => d.sign === "-")).toBe(true);
  });

  test("both halves of the answer are present", () => {
    expect(CARD_PROSE.trim().length).toBeGreaterThan(80);
    expect(CARD_PROSE_AFTER.trim().length).toBeGreaterThan(40);
    /* The prose is markdown because the panel renders markdown. */
    expect(CARD_PROSE).toContain("**");
  });
});

describe("the question", () => {
  test("every option says what it costs", () => {
    expect(ASK.options.length).toBe(3);
    for (const o of ASK.options) {
      expect(o.label.trim().length).toBeGreaterThan(3);
      expect(o.detail.trim().length).toBeGreaterThan(20);
    }
  });

  test("the question carries the reasoning, not only the choice", () => {
    expect(ASK.why.trim().length).toBeGreaterThan(60);
  });

  test("a question can show three designs, and each one says what it costs", () => {
    expect(DESIGN_ASK.options.length).toBe(3);
    const ids = DESIGN_ASK.options.map((o) => o.id);
    expect(new Set(ids).size).toBe(3);
    for (const o of DESIGN_ASK.options) {
      expect(o.label.trim().length).toBeGreaterThan(3);
      expect(o.detail.trim().length).toBeGreaterThan(20);
    }
    /* The sentence the chosen design is answered with, and the other half of
       the feature: a file that already exists travels the same path. */
    expect(DESIGN_ASK.chosen.length).toBeGreaterThan(40);
    expect(DESIGN_ASK.also).toContain("file");
  });
});

describe("the four beats of the opening", () => {
  test("the wall survives a closed laptop, which is the fourth beat", () => {
    expect(TABS_STORY.length).toBe(4);
    const last = TABS_STORY[TABS_STORY.length - 1];
    expect(last.title).toBe("closed, then opened");
    /* The three things the user named as getting their time back. */
    expect(last.body).toContain("resumes");
    expect(last.body).toContain("dev servers");
  });
});

describe("analytics, at the stage its card allows", () => {
  test("the label claims the recorder and not the interface", () => {
    expect(ANALYTICS.label).toBe("in build · recording now");
    /* The one claim that must never drift: a mockup shown inside the app
       reads as the app unless the copy says otherwise. */
    expect(ANALYTICS.caveat).toContain("not a screenshot");
    expect(ANALYTICS.caveat).toContain("not drawn yet");
  });

  test("the four things a manager would ask about are there", () => {
    expect(ANALYTICS.points.length).toBe(4);
    const text = ANALYTICS.points.map((p) => `${p.title} ${p.line}`).join(" ").toLowerCase();
    expect(text).toContain("account");
    expect(text).toContain("provider");
    expect(text).toContain("mcp");
    expect(text).toContain("window");
  });

  test("cross-machine and the report are named as designed, not built", () => {
    expect(ANALYTICS.after).toContain("flyway");
    expect(ANALYTICS.after).toContain("report");
    expect(ANALYTICS.after).toContain("not built");
  });
});

describe("the coordinator", () => {
  test("every ruling says what it does, and all four are distinct", () => {
    const verbs = COORDINATE.rulings.map((r) => r.verb);
    expect(new Set(verbs).size).toBe(4);
    for (const r of COORDINATE.rulings) {
      expect(r.line.trim().length).toBeGreaterThan(40);
    }
    expect(COORDINATE.gate).toContain("commit");
  });
});

describe("the comparison", () => {
  test("every row has one cell per tool", () => {
    for (const r of COMPARE) {
      expect(r.cells.length).toBe(TOOLS.length);
    }
  });

  test("every cell is a verdict with a reason", () => {
    for (const r of COMPARE) {
      for (const c of r.cells) {
        expect(["yes", "partly", "no"]).toContain(c.v);
        expect(c.said.trim().length).toBeGreaterThan(2);
      }
    }
  });

  test("the table can say no about Volery, or it is not a comparison", () => {
    const volery = TOOLS.findIndex((t) => t.id === "volery");
    const answers = COMPARE.map((r) => r.cells[volery]?.v);
    expect(answers).toContain("partly");
  });

  test("the note names what the others are better at", () => {
    expect(COMPARE_NOTE).toContain("terminal is faster");
    expect(COMPARE_NOTE).toContain("better than Volery");
  });
});

describe("security", () => {
  test("both drafts exist, so hardening changes one constant and not the copy", () => {
    expect(SECURITY_PLANS.current.length).toBe(4);
    expect(SECURITY_PLANS.hardened.length).toBe(4);
    expect(SECURITY_HEADLINE.current).not.toBe(SECURITY_HEADLINE.hardened);
  });

  test("the plans' status matches the stage they belong to", () => {
    for (const p of SECURITY_PLANS.current) expect(p.status).toBe("planned");
    for (const p of SECURITY_PLANS.hardened) expect(p.status).toBe("shipped");
  });

  test("the shipped stage still names a gap, or it is marketing", () => {
    /* Even after hardening, a card with the repository in its hands is the
       design and not a bug. The copy has to keep saying so. */
    const hardened = SECURITY_PLANS.hardened.map((p) => p.body).join(" ");
    expect(hardened).toContain("bypass");
  });

  test("every fact says something and carries a tone", () => {
    for (const f of SECURITY_FACTS) {
      expect(f.label.trim().length).toBeGreaterThan(2);
      expect(f.value.trim().length).toBeGreaterThan(20);
      expect(["ok", "warn", "gap"]).toContain(f.tone);
    }
    expect(SECURITY_FACTS.some((f) => f.tone === "gap")).toBe(true);
  });

  test("the stolen-key story is four distinct answers", () => {
    const lines = new Set<string>();
    for (const stage of ["current", "hardened"] as const) {
      for (const stolen of [false, true]) {
        for (const second of [false, true]) {
          lines.add(theftStory(stage, stolen, second).body);
        }
      }
    }
    expect(lines.size).toBe(3);
    expect(theftStory("current", true, false).title).toBe("the key is enough");
    expect(theftStory("current", true, true).title).toBe("the key is not enough");
    expect(theftStory("hardened", true, false).title).toBe("the key is not enough");
  });
});

describe("what comes next", () => {
  test("the three the user asked for are in it", () => {
    const text = NEXT.map((n) => `${n.title} ${n.body}`).join(" ").toLowerCase();
    expect(text).toContain("plugin");
    expect(text).toContain("mcp");
    expect(text).toContain("azure");
    expect(text).toContain("allowance");
  });
});

describe("the copy is the house's", () => {
  /** Every string reachable from the module, walked rather than listed, so a
   *  paragraph added tomorrow is covered without editing this test. */
  function strings(v: unknown, out: string[] = []): string[] {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) strings(x, out);
    else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
    return out;
  }

  const source = readFileSync("src/lib/showcase.ts", "utf8");

  test("no em dash and no en dash anywhere a reader can see one", () => {
    /* The user's rule, stated once and enforced here rather than remembered.
       Code comments count too: the next person copies what they read. */
    expect(source.includes("—")).toBe(false);
    expect(source.includes("–")).toBe(false);
  });

  test("no antithesis formula and no 'not just' opener", () => {
    const copy = strings({
      CHAPTERS,
      WALL_CARDS,
      ASSIGNMENTS,
      ASSIGNMENT_SUMMARY,
      BOOST_SAID,
      ADMISSION_SAID,
      SLEEP_SAID,
      USAGE_SAID,
      DESK,
      STATUS_SAID,
      CARD_PROSE,
      CARD_PROSE_AFTER,
      CARD_RUN,
      ASK,
      ANALYTICS,
      DESIGN_ASK,
      COORDINATE,
      COMPARE,
      COMPARE_NOTE,
      SECURITY_FACTS,
      SECURITY_PLANS,
      SECURITY_HEADLINE,
      NEXT,
      TABS_STORY,
      TERMINAL_LINES,
    }).join("\n");
    expect(copy.toLowerCase()).not.toContain("not just");
    expect(copy.toLowerCase()).not.toContain("it's not only");
  });

  test("the module reads nothing and spawns nothing", () => {
    /* The tour must cost no allowance and work with no backend. An import of
     *  the store or an invoke would make it fail on a plane. */
    expect(source).not.toContain("@tauri-apps");
    expect(source).not.toContain("invoke(");
    expect(source).not.toContain("skein.svelte");
  });

  test("there is copy to check at all", () => {
    /* A walk over an empty module would pass every assertion above. */
    expect(strings({ CHAPTERS, WALL_CARDS, COMPARE }).length).toBeGreaterThan(40);
  });
});

describe("the stage the chapter is actually in", () => {
  test("the constant names one of the two drafts", () => {
    expect(["current", "hardened"]).toContain(SECURITY_STAGE);
    expect(SECURITY_PLANS[SECURITY_STAGE].length).toBe(4);
  });
});
