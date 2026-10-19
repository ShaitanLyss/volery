import { describe, expect, test } from "bun:test";
import {
  absence,
  foldLog,
  groupOptions,
  isLive,
  keeping,
  latest,
  nameOf,
  pulseOf,
  rowsOf,
  standing,
  type LogLine,
  type Reading,
} from "../src/lib/serverlog";

/* What is true of a dev server group and of nothing else. The three things
   every log widget shares — how many lines fit, which subject it is about, what
   a filter that emptied the pane owes you — moved to `test/logface.test.ts`
   when the build log and the editor log turned out to want them too. */

/* A group, as much of one as the log widget reads. Defaults are a healthy
   single-server group, so each test says only what it is about. */
function group(over: Partial<Reading> = {}): Reading {
  const servers = over.servers ?? [{ label: "web", port: 5173 }];
  return {
    id: "g1",
    label: "dev",
    project: "skein",
    running: true,
    overall: "up",
    servers,
    health: Object.fromEntries(servers.map((s) => [s.label, "up" as const])),
    log: [],
    ...over,
  };
}

const line = (label: string, text: string, stderr = false): LogLine => ({
  label,
  line: text,
  stderr,
});

/* ── the narrowing, and the tone it puts in the gutter ─────────────────── */

describe("which pipe a line came down", () => {
  const log = [line("web", "one"), line("web", "two", true)];

  /* The first thing in the app to read `LogLine.stderr`, which only became true
     when the pseudo-terminal came off and each pipe got its own reader — under
     one merged reader the field was hardcoded `false` for every line ever
     emitted. */
  test("stderr narrows to stderr; everything else does not narrow at all", () => {
    expect(keeping("all")).toBeNull();
    expect(log.filter(keeping("stderr")!).map((l) => l.line)).toEqual(["two"]);
  });

  /* The gutter and never the text. A line on stderr is not necessarily bad
     news — half of everything logs perfectly calm prose there — so the mark
     carries the tone and `LogTail` is told not to tint. */
  test("a stderr line is marked, with its label in the gutter", () => {
    expect(rowsOf(log)).toEqual([
      { mark: "web", tone: "plain", text: "one" },
      { mark: "web", tone: "fail", text: "two" },
    ]);
  });
});

describe("a group's dot", () => {
  /* Starting is pending rather than live: it has not bound its port yet, and a
     celadon dot on a server about to fail to start is a reading that was too
     keen. */
  test("up is live, starting is only pending, exited is dead", () => {
    expect(pulseOf("up")).toBe("live");
    expect(pulseOf("starting")).toBe("pending");
    expect(pulseOf("exited")).toBe("dead");
    expect(pulseOf("idle")).toBe("idle");
  });
});

describe("which group the wall follows", () => {
  /* Asked of `running` rather than of `overall`, so a group whose server
     crashed a second ago is still the one you are watching rather than being
     skipped over for a quiet one — the log of the thing that just died is the
     log you want. */
  test("a group that crashed is still the one being followed", () => {
    expect(isLive(group({ running: true, overall: "exited" }))).toBe(true);
    expect(isLive(group({ running: false, overall: "idle" }))).toBe(false);
  });
});

describe("the two absences are two different things to say", () => {
  test("a deleted group is named as such, not papered over", () => {
    expect(absence("gone")).toContain("not on the wall any more");
  });

  test("a wall with no groups points at where one comes from", () => {
    expect(absence("none")).toContain("servers panel");
  });
});

describe("the last thing each server said", () => {
  const servers = [
    { label: "web", port: 5173 },
    { label: "api", port: 3000 },
  ];
  const log = [
    line("web", "starting"),
    line("api", "listening on 3000"),
    line("web", "ready in 342ms"),
  ];

  test("one line each, most recent, in the group's own order", () => {
    expect(latest(servers, log, "all")).toEqual([
      { label: "web", line: "ready in 342ms", stderr: false },
      { label: "api", line: "listening on 3000", stderr: false },
    ]);
  });

  /* The silent one is the interesting one, so it gets a row rather than being
     left out of the reading. */
  test("a server that has said nothing still gets a row", () => {
    expect(latest(servers, [line("web", "up")], "all")).toEqual([
      { label: "web", line: "up", stderr: false },
      { label: "api", line: null, stderr: false },
    ]);
  });

  test("the filter reaches this reading too", () => {
    const withErr = [...log, line("api", "ECONNREFUSED", true)];
    expect(latest(servers, withErr, "stderr")).toEqual([
      { label: "web", line: null, stderr: false },
      { label: "api", line: "ECONNREFUSED", stderr: true },
    ]);
  });

  test("a line from a server that is not in this group is not shown", () => {
    expect(latest([{ label: "web", port: null }], [line("ghost", "hi")], "all")).toEqual(
      [{ label: "web", line: null, stderr: false }],
    );
  });
});

/* ── is it down, and what does the button say ──────────────────────────── */

describe("a group that is not saying anything says why", () => {
  test("one nobody has started offers a start", () => {
    const s = standing(group({ running: false, overall: "idle" }));
    expect(s).toEqual({ down: true, word: "not started", verb: "start" });
  });

  /* The half this would have got wrong. `running` is a flag the wall sets when
     it asks for a start, so a server that exited on its own comes back
     `running: true` — and a start button that appeared only for a group nobody
     had started would be missing from exactly the case you opened the log to
     understand. */
  test("one that exited on its own is down, whatever the running flag says", () => {
    const s = standing(
      group({ running: true, overall: "exited", health: { web: "exited" } }),
    );
    expect(s.down).toBe(true);
    expect(s.word).toBe("exited");
    expect(s.verb).toBe("start again");
  });

  test("a group half of which exited says so", () => {
    const s = standing(
      group({
        running: true,
        overall: "exited",
        servers: [
          { label: "web", port: 5173 },
          { label: "api", port: 3000 },
        ],
        health: { web: "up", api: "exited" },
      }),
    );
    expect(s.down).toBe(true);
    expect(s.word).toBe("one of them exited");
  });

  /* Up, and the reading is the lines. A widget narrating "it is running" over
     the top of its own output is a label on a window. */
  test("a running group is left to speak for itself", () => {
    expect(standing(group()).down).toBe(false);
    expect(standing(group()).word).toBeNull();
  });

  test("one still starting is not something to press a button about", () => {
    const s = standing(group({ overall: "starting", health: { web: "starting" } }));
    expect(s.down).toBe(false);
    expect(s.word).toBeNull();
  });
});

/* ── naming one ────────────────────────────────────────────────────────── */

describe("a group names itself the same way everywhere", () => {
  /* A widget belongs to no project, so a log has to say whose server it is
     showing — and a menu of five entries all reading `dev` is a menu that
     cannot be used. */
  test("the project, then the group", () => {
    expect(nameOf({ project: "skein", label: "dev" })).toBe("skein · dev");
  });

  test("a group with no project to name reads as itself", () => {
    expect(nameOf({ project: "", label: "dev" })).toBe("dev");
  });

  test("the menu offers every group, in the order the wall holds them", () => {
    expect(
      groupOptions([
        group({ id: "a", label: "dev", project: "skein" }),
        group({ id: "b", label: "api", project: "nova" }),
      ]),
    ).toEqual([
      { value: "a", label: "skein · dev" },
      { value: "b", label: "nova · api" },
    ]);
  });
});

/* The wall is handed batches now, never lines — `servers.rs`'s outlet. */
describe("foldLog", () => {
  const l = (n: number): LogLine => line("web", String(n));

  test("a batch is appended, and the log keeps its newest `cap`", () => {
    const out = foldLog([l(1), l(2)], [l(3), l(4)], 0, 3);
    expect(out.map((x) => x.line)).toEqual(["2", "3", "4"]);
  });

  test("the skipped line survives a full batch, which is the only batch that has one", () => {
    const full = Array.from({ length: 400 }, (_, i) => l(i));
    const out = foldLog([l(-2), l(-1)], full, 9_000, 400);
    expect(out).toHaveLength(400);
    expect(out[0].label).toBe("volery");
    expect(out[0].line).toContain("9,000");
    expect(out[399].line).toBe("399");
  });

  test("lines skipped by the outlet are said, not silently missing", () => {
    const out = foldLog([l(1)], [l(9)], 12_431, 10);
    expect(out.map((x) => x.line)).toEqual(["1", "… 12,431 lines went by too fast to draw", "9"]);
    expect(out[1].label).toBe("volery");
  });

  test("a fresh array every time, because the log is `$state.raw`", () => {
    const log = [l(1)];
    expect(foldLog(log, [], 0, 10)).not.toBe(log);
  });
});

describe("a flooding group", () => {
  test("says so instead of drawing the flood, and how long it has left", () => {
    const s = standing(group({ flood: { rate: 3614, stopsIn: 42, stopped: false } }));
    expect(s.down).toBe(true);
    expect(s.word).toBe("flooding its log — ~3,614 lines a second; the wall stops it in 42s");
    expect(s.verb).toBe("restart");
  });

  test("stopped for it, it says who stopped it and why", () => {
    const s = standing(
      group({ running: false, overall: "idle", flood: { rate: 3614, stopsIn: null, stopped: true } }),
    );
    expect(s.word).toBe("stopped by the wall — it was flooding its log");
    expect(s.verb).toBe("start again");
  });

  test("a group with no flood reads exactly as before", () => {
    expect(standing(group({ flood: null })).down).toBe(false);
  });
});
