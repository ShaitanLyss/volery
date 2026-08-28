import { expect, test, describe } from "bun:test";
import {
  absence,
  atLeast,
  keeping,
  LEVELS,
  markOf,
  normalizeConfig,
  pulseOf,
  rowsOf,
  SHOWINGS,
  standing,
  toneOf,
  type Level,
  type LogLine,
} from "../src/lib/applog";
/* Deliberately reaching into the catalogue: the narrowings the menu offers and
   the ones `keeping` understands are a contract between two files, and a test
   that restates either by hand cannot notice them disagreeing. */
import { specFor } from "../src/lib/widgets";

const line = (over: Partial<LogLine> = {}): LogLine => ({
  at: 1_700_000_000_000,
  level: "info",
  target: "librespot_core::session",
  text: "Connecting to AP \"ap-gae2.spotify.com:4070\"",
  ...over,
});

describe("what a line is worth", () => {
  test("three tones over five levels, and the quiet ones are plain", () => {
    expect(toneOf("error")).toBe("fail");
    expect(toneOf("warn")).toBe("warn");
    /* Not calm — *ordinary*. A wall that tinted debug would be permanently the
       colour of its own plumbing. */
    expect(toneOf("info")).toBe("plain");
    expect(toneOf("debug")).toBe("plain");
    expect(toneOf("trace")).toBe("plain");
  });

  test("the gutter shows the last segment of the module path", () => {
    expect(markOf("librespot_core::session")).toBe("session");
    expect(markOf("librespot_connect::spirc")).toBe("spirc");
    /* A bare target has no segments to take the last of. */
    expect(markOf("wry")).toBe("wry");
    expect(markOf("")).toBe("");
  });

  test("loudness is compared by position, so the order is declared once", () => {
    expect(atLeast("error", "warn")).toBe(true);
    expect(atLeast("warn", "warn")).toBe(true);
    expect(atLeast("info", "warn")).toBe(false);
    expect(atLeast("trace", "debug")).toBe(false);
    expect(atLeast("error", "trace")).toBe(true);
  });

  /* A newer build's vocabulary arriving at an older face must be visible rather
     than silently filtered — the bargain `applyEvent`'s default arm strikes. */
  test("a level this build has never heard of is kept, not dropped", () => {
    expect(atLeast("shouty" as Level, "warn")).toBe(true);
    expect(atLeast("error", "shouty" as Level)).toBe(true);
  });
});

describe("the narrowing", () => {
  const log: LogLine[] = [
    line({ level: "error", text: "Tried too many access points" }),
    line({ level: "warn", text: "will be ignored while Not Active" }),
    line({ level: "info", text: "Authenticated as 'chronoflo' !" }),
    line({ level: "debug", text: "Input volume 32767 mapped to: 3.16%" }),
  ];

  const kept = (showing: string) => {
    const k = keeping(showing);
    return k ? log.filter(k) : log;
  };

  test("`all` filters nothing, and says so by returning null", () => {
    /* Null rather than a true-predicate: `logface.tail` uses the null to skip
       the filter, which on two thousand lines is a copy that does not happen. */
    expect(keeping("all")).toBeNull();
    expect(kept("all")).toHaveLength(4);
  });

  test("`problems` is errors and warnings, which no floor expresses", () => {
    /* Not a floor, because `info` sits between `warn` and nothing — that is the
       whole reason this narrowing exists beside the levels. */
    expect(kept("problems").map((l) => l.level)).toEqual(["error", "warn"]);
  });

  test("a level is a floor, not an equality", () => {
    expect(kept("warn").map((l) => l.level)).toEqual(["error", "warn"]);
    expect(kept("info").map((l) => l.level)).toEqual(["error", "warn", "info"]);
    expect(kept("error").map((l) => l.level)).toEqual(["error"]);
  });

  test("an unrecognised narrowing shows everything rather than nothing", () => {
    /* A config from a newer build must not present as an empty log, which reads
       as breakage rather than as a filter. */
    expect(keeping("whatever")).toBeNull();
  });

  test("an emptied pane explains itself, and a full one stays quiet", () => {
    expect(absence(0, "problems")).toBeNull();
    expect(absence(12, "problems")).toBe(
      "nothing to complain about — 12 lines filtered out",
    );
    expect(absence(1, "warn")).toBe("nothing at warn or worse — 1 line filtered out");
  });
});

describe("the readings over the whole log", () => {
  test("a log with nothing in it is quiet rather than zero", () => {
    /* "0 lines" is a measurement; a log that has said nothing is a state. */
    expect(standing([])).toBe("quiet");
    expect(pulseOf([])).toBe("idle");
  });

  test("errors lead, then warnings, then the count alone", () => {
    expect(standing([line(), line()])).toBe("2 lines");
    expect(standing([line()])).toBe("1 line");
    expect(standing([line(), line({ level: "warn" })])).toBe("1 warning · 2 lines");
    expect(standing([line({ level: "error" }), line({ level: "warn" })])).toBe(
      "1 error · 2 lines",
    );
  });

  /* The bug this guards. A dot reading only the last line would go green again
     the moment something routine was said after a failure — hiding the one
     thing the widget knows that matters. */
  test("the dot reads the whole log, so an old error still shows", () => {
    const after = [line({ level: "error" }), ...Array(50).fill(line())];
    expect(pulseOf(after)).toBe("dead");
    expect(pulseOf([...Array(50).fill(line()), line({ level: "warn" })])).toBe("pending");
    expect(pulseOf([line(), line()])).toBe("live");
  });
});

describe("drawing", () => {
  test("a row carries the mark, the tone and the text as printed", () => {
    const rows = rowsOf([line({ level: "error", target: "librespot_connect::spirc" })]);
    expect(rows).toEqual([
      {
        mark: "spirc",
        tone: "fail",
        text: "Connecting to AP \"ap-gae2.spotify.com:4070\"",
      },
    ]);
  });
});

describe("the widget's config, read the way every opaque column is", () => {
  test("nothing, rubbish and a newer build's knob all degrade to something drawable", () => {
    expect(normalizeConfig(undefined)).toEqual({ showing: "all", marks: true });
    expect(normalizeConfig({})).toEqual({ showing: "all", marks: true });
    expect(normalizeConfig({ variant: "sideways" })).toEqual({
      showing: "all",
      marks: true,
    });
    expect(normalizeConfig({ marks: "yes" })).toEqual({ showing: "all", marks: true });
  });

  test("it reads `variant`, which is the key the catalogue actually stores", () => {
    /* Reading `showing` here is the exact failure the catalogue refuses
       everywhere else: the knob appears in the menu, persists, and silently
       does nothing. `spotify.ts` documents the same asymmetry. */
    expect(normalizeConfig({ variant: "problems" }).showing).toBe("problems");
    expect(normalizeConfig({ showing: "problems" }).showing).toBe("all");
    expect(normalizeConfig({ marks: false }).marks).toBe(false);
  });
});

describe("the seam between the catalogue and the face", () => {
  const spec = specFor("applog");

  test("the widget is in the catalogue at all", () => {
    expect(spec).toBeDefined();
  });

  /* In both directions, which is the point. A narrowing the menu offers that
     `keeping` ignores is a control that does nothing; one `keeping` understands
     that the menu never offers is unreachable. */
  test("every narrowing the menu offers is one the filter understands", () => {
    const offered = (spec?.params?.[0] as { options?: { value: string }[] })?.options ?? [];
    expect(offered.length).toBeGreaterThan(0);
    for (const o of offered) {
      expect(SHOWINGS).toContain(o.value);
    }
    expect(offered.map((o) => o.value).sort()).toEqual([...SHOWINGS].sort());
  });

  test("every level is orderable, so the menu cannot offer an unrankable one", () => {
    for (const l of LEVELS) {
      expect(atLeast(l, "trace")).toBe(true);
    }
    expect(LEVELS).toHaveLength(5);
  });
});
