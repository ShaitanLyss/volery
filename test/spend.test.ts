import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import {
  MEASURES,
  PERIODS,
  SCOPES,
  asWatch,
  periodSaid,
  thresholdSaid,
  tokens,
  watchSaid,
  when,
  type SpendWatch,
} from "../src/lib/spend";

const RUST = readFileSync(new URL("../src-tauri/src/spend.rs", import.meta.url), "utf8");
const ANALYTICS = readFileSync(new URL("../src-tauri/src/analytics.rs", import.meta.url), "utf8");
const STORE = readFileSync(new URL("../src-tauri/src/store.rs", import.meta.url), "utf8");
const ASK = readFileSync(new URL("../src-tauri/src/ask.rs", import.meta.url), "utf8");
const LIMITS = readFileSync(new URL("../src-tauri/src/limits.rs", import.meta.url), "utf8");

const T0 = Date.UTC(2026, 10, 12, 14, 3, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function watch(over: Partial<SpendWatch> = {}): SpendWatch {
  return {
    id: 3,
    conversationId: "c-1",
    measure: "usd",
    period: "session",
    atValue: 10,
    scope: "self",
    createdAt: T0 - HOUR,
    firedFor: null,
    firedAt: null,
    ...over,
  };
}

describe("a threshold, said the way the card wrote it", () => {
  test("a whole dollar is not written to the cent", () => {
    expect(thresholdSaid("usd", 10)).toBe("$10");
    expect(thresholdSaid("usd", 10.5)).toBe("$10.50");
  });

  test("small money keeps its precision rather than rounding to nothing", () => {
    expect(thresholdSaid("usd", 0.25)).toBe("$0.2500");
  });

  test("tokens and points say their unit", () => {
    expect(thresholdSaid("tokens", 1_000_000)).toBe("1M tokens");
    expect(thresholdSaid("tokens", 2_000_000)).toBe("2M tokens");
    expect(thresholdSaid("allowance_points", 5)).toBe("5 points");
    expect(thresholdSaid("allowance_points", 5.5)).toBe("5.5 points");
  });

  test("a count is abbreviated at the same scale as the tool's answer", () => {
    expect(tokens(312)).toBe("312");
    expect(tokens(84_900)).toBe("84k");
    expect(tokens(1_240_000)).toBe("1.2M");
    expect(tokens(-1)).toBe("0");
  });
});

describe("one watch, in a line", () => {
  test("the threshold, the period, and whose spend it counts", () => {
    expect(watchSaid(watch(), T0)).toBe("warn at $10, this session");
    expect(watchSaid(watch({ period: "day", measure: "tokens", atValue: 2_000_000 }), T0)).toBe(
      "warn at 2M tokens, today",
    );
    expect(watchSaid(watch({ scope: "self+children" }), T0)).toBe(
      "warn at $10, this session, with the cards it opened",
    );
  });

  test("a period is said as a person says it", () => {
    expect(periodSaid("session")).toBe("this session");
    expect(periodSaid("day")).toBe("today");
    expect(periodSaid("turn")).toBe("this turn");
    expect(periodSaid("window")).toBe("this window");
  });

  test("fired is a fact about an instance, not about the setting", () => {
    /* The same watch reads unfired again when the day rolls; that is the
       restart, and drawing it as a permanent property would hide it. The clock
       is the machine's, so the expected time is asked of the same formatter. */
    const fired = T0 - 60_000;
    const time = new Date(fired).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(watchSaid(watch({ firedAt: fired }), T0)).toBe(
      `warn at $10, this session · fired today ${time}`,
    );
  });

  test("a firing is dated on the page's own clock, without one of its own", () => {
    expect(when(T0 - 60_000, T0).startsWith("today ")).toBe(true);
    expect(when(T0 - DAY, T0).startsWith("yesterday ")).toBe(true);
    expect(when(Date.UTC(2026, 10, 3, 9, 0), T0)).toBe("3 Nov");
  });
});

describe("a row from the store, normalised", () => {
  test("a real row comes through whole", () => {
    expect(asWatch({ ...watch(), extra: 1 })).toEqual(watch());
  });

  test("a measure or period this build cannot name is dropped, not labelled", () => {
    /* A page may not offer a delete for something it cannot read: the person
       would be deleting a row whose meaning they cannot see. */
    expect(asWatch({ ...watch(), measure: "euros" })).toBe(null);
    expect(asWatch({ ...watch(), period: "fortnight" })).toBe(null);
    expect(asWatch({ ...watch(), scope: "the whole wall" })).toBe(null);
  });

  test("a row missing its identity or its number is dropped", () => {
    expect(asWatch({ ...watch(), id: undefined })).toBe(null);
    expect(asWatch({ ...watch(), atValue: "ten" })).toBe(null);
    expect(asWatch(null)).toBe(null);
    expect(asWatch("a watch")).toBe(null);
  });
});

describe("the vocabulary is the Rust tool's, not a second one", () => {
  test("the three measures are the ones `spend.rs` parses", () => {
    for (const m of MEASURES) {
      expect(RUST).toContain(`"${m}" => Ok(Measure`);
    }
  });

  test("the four periods are the ones `spend.rs` parses", () => {
    for (const p of PERIODS) {
      expect(RUST).toContain(`"${p}" => Ok(Period`);
    }
  });

  test("both scopes are the ones `spend.rs` parses", () => {
    for (const s of SCOPES) {
      expect(RUST).toContain(`"${s}"`);
    }
  });

  test("the four verbs are advertised across the two tools", () => {
    expect(RUST).toMatch(/"enum": \["read", "list"\]/);
    expect(RUST).toMatch(/"enum": \["watch", "unwatch"\]/);
  });
});

describe("plan mode can read the spend and not write a watch", () => {
  /* The reason the verbs are two tools. `ask.rs` asserts both directions of its
     read-only list; this is the same contract seen from the one that was split. */
  test("`spend` is advertised read-only, `spend_watch` is not", () => {
    expect(ASK).toMatch(/reads_only\(crate::spend::schema\(\)\)/);
    expect(ASK).toMatch(/found_by\(\s*crate::spend::watch_schema\(\)/);
    expect(ASK).not.toMatch(/reads_only\(crate::spend::watch_schema\(\)\)/);
  });
});

describe("a watch only ever touches its own card's rows", () => {
  /* The brief's own guard, and it is asserted on the statements rather than
     trusted: every write to `spend_watch` must name the conversation, and the
     delete must have it in the WHERE rather than in a check before it. */
  test("the delete is scoped in the statement", () => {
    const at = STORE.indexOf("pub fn drop_watch");
    expect(at).toBeGreaterThan(-1);
    const body = STORE.slice(at, STORE.indexOf("pub fn mark_watch_fired", at));
    expect(body).toContain("conversation_id");
    expect(body).toMatch(/DELETE FROM spend_watch WHERE id = \?1 AND conversation_id = \?2/);
  });

  test("the fire mark is scoped too", () => {
    const at = STORE.indexOf("pub fn mark_watch_fired");
    const body = STORE.slice(at, at + 900);
    expect(body).toContain("conversation_id = ?2");
  });

  test("the read is scoped to one card", () => {
    const at = STORE.indexOf("pub fn watches_of");
    const body = STORE.slice(at, STORE.indexOf("pub fn watches_all", at));
    expect(body).toContain("WHERE conversation_id = ?1");
  });

  test("the tool never inserts a row for any card but its caller", () => {
    const at = RUST.indexOf("fn do_watch");
    const body = RUST.slice(at, RUST.indexOf("fn do_unwatch", at));
    expect(body).toContain("conversation_id: card.into()");
    expect(body).not.toMatch(/conversation_id:\s*"[^"]+"\.into\(\)/);
  });
});

describe("where it is mounted, and the pointer that reaches it", () => {
  test("the ask chain routes the tool", () => {
    expect(ASK).toContain("crate::spend::handle(&app, &conversation_id, &tool, &args)");
  });

  test("it is deferred with a search hint, not loaded", () => {
    /* The loaded tier is at its ceiling; §11.13's discovery channel is
       `allowance`'s answer, which costs nothing per turn. */
    const at = ASK.indexOf("crate::spend::schema()");
    expect(at).toBeGreaterThan(-1);
    const around = ASK.slice(Math.max(0, at - 600), at);
    expect(around).toContain("found_by");
    expect(around).not.toContain("always(");
  });

  test("allowance's answer names `spend read` in full", () => {
    expect(LIMITS).toContain("mcp__skein__spend");
    expect(LIMITS).toContain("verb `read`");
  });
});

describe("the catch-up is bounded, and bounded forward", () => {
  test("it reads the tail of one card's file no further than its cap", () => {
    const at = ANALYTICS.indexOf("pub(crate) fn catch_up");
    expect(at).toBeGreaterThan(-1);
    const body = ANALYTICS.slice(at, ANALYTICS.indexOf("/// One pass:", at));
    expect(body).toContain("CATCH_UP_BYTES");
    expect(body).toContain("Read::take(&mut f, cap)");
    /* A tail-biased read leaves a hole: the mark advances to the end over
       bytes nobody read. The forward read is the contract. */
    expect(body).not.toContain("len.saturating_sub");
    expect(body).toContain("if line.last() != Some(&b'\\n')");
  });

  test("it does not prune the collector's other offsets", () => {
    const at = ANALYTICS.indexOf("pub(crate) fn catch_up");
    const body = ANALYTICS.slice(at, ANALYTICS.indexOf("/// One pass:", at));
    expect(body).not.toContain("reading.alive(");
  });
});

describe("children are opt-in, and the sum is labelled", () => {
  test("the schema asks, and the tool defaults to self", () => {
    expect(RUST).toContain('args.get("children")');
    expect(RUST).toContain('Scope::WithChildren');
  });

  test("the answer says when it includes the cards it opened", () => {
    expect(RUST).toContain("and the cards it opened");
  });
});

describe("an allowance share that cannot be computed is null", () => {
  test("share_of_window answers a reason rather than a number", () => {
    const at = RUST.indexOf("fn share_of_window");
    const body = RUST.slice(at, RUST.indexOf("fn cache_said", at));
    expect(body).toContain("points: None");
    expect(body).toContain("no allowance samples");
  });
});

describe("the schema rung", () => {
  test("v68 is the next rung and it is in the ladder", () => {
    expect(STORE).toContain("const SCHEMA_VERSION: i64 = 68;");
    expect(STORE).toContain("(68, migrate_v68)");
  });

  test("the table is §17's, with the index the tool reads it by", () => {
    const at = STORE.indexOf("fn migrate_v68");
    const body = STORE.slice(at, STORE.indexOf("/* ── saved views", at));
    for (const col of [
      "conversation_id",
      "measure",
      "period",
      "at_value",
      "scope",
      "created_at",
      "fired_for",
      "fired_at",
    ]) {
      expect(body).toContain(col);
    }
    expect(body).toContain("ON DELETE CASCADE");
    expect(body).toContain("spend_watch_by_conversation");
    expect(body).toContain("CREATE TABLE IF NOT EXISTS");
  });
});
