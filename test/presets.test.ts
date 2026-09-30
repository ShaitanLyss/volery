import { expect, test, describe } from "bun:test";
import {
  FALLBACK_DEFAULT_PRESET,
  PRESETS,
  SPAWN_MODELS,
  defaultPresetFor,
  presetById,
  presetForSpawn,
  presetPicks,
} from "../src/lib/presets";
import { readFileSync } from "node:fs";
import { EFFORT_LEVELS, isEffort } from "../src/lib/commands";
import { contextWindowFor } from "../src/lib/classify";
import { menuFor, type MenuItem } from "../src/lib/menu";

const items = (m: MenuItem[]) =>
  m.filter((i): i is Extract<MenuItem, { kind: "item" }> => i.kind === "item");

describe("what the + offers before a card is opened", () => {
  test("a preset either names a level this build knows, or none at all", () => {
    /* The level goes to `--effort`, which takes these five and nothing else.
       Absent is a real answer: effort is unsupported on Haiku 4.5, and a
       preset on that model must not claim one. */
    for (const p of PRESETS) {
      if (p.effort !== undefined) expect(isEffort(p.effort)).toBe(true);
    }
    expect(EFFORT_LEVELS.length).toBe(5);
  });

  test("only the model without an effort parameter goes without one", () => {
    /* Haiku 4.5 is absent from the effort docs' supported-models list, and the
       CLI drops the flag silently rather than refusing it — so nothing but this
       test would notice a preset claiming a level that never applies. */
    const silent = PRESETS.filter((p) => p.effort === undefined);
    expect(silent.map((p) => p.model)).toEqual(["haiku"]);
  });

  test("the menu does not offer max", () => {
    /* Deliberate, and the one place this catalogue departs from "just offer the
       range". `max` is documented as adding significant cost for relatively
       small gains on most workloads, and as prone to overthinking on the less
       intelligence-sensitive ones — a level worth reaching for only once you
       have measured it, which is the opposite of what a menu is for. */
    expect(PRESETS.map((p) => p.effort)).not.toContain("max");
  });

  test("the ids are unique and stable, since rows are opened under them", () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    expect(presetById("bug")?.model).toBe("opus[1m]");
    expect(presetById("nothing-like-this")).toBeUndefined();
    expect(presetById(undefined)).toBeUndefined();
  });

  test("the note says what is actually being asked for, and nothing more", () => {
    for (const p of PRESETS) {
      expect(p.note).toContain(p.model);
      if (p.effort) expect(p.note).toContain(p.effort);
      /* The other direction is the one that bit: a note reading "haiku · low"
         beside a spawn that sends no `--effort` is the menu lying about the
         thing it exists to show. */
      else expect(p.note).toBe(p.model);
    }
  });

  test("the wide window is asked for wherever the model has one", () => {
    /* `contextWindowFor` reads the tier out of the alias, which is what sizes
       the ring before `system/init` has said anything — and the tier is free.
       Read 2026-09-30 off the pricing docs' long-context section: "Claude 4.6
       and later models … include the full 1M token context window at standard
       pricing. (A 900k-token request is billed at the same per-token rate as a
       9k-token request.)" So a `[1m]` nobody asked for costs nothing, and the
       only row without one is the only row whose *model* has none — haiku 4.5.
       This used to hold the opposite direction, that the cheap end kept the
       small window so a cheap card could not quietly grow into a large one.
       That argument was about a card growing past what you meant to buy, and
       with the rate flat there is nothing left to buy: what the small window
       bought was a compaction in the middle of the work. */
    const wide = PRESETS.filter((p) => contextWindowFor(p.model) === 1_000_000);
    expect(wide.map((p) => p.id)).toEqual(["read", "work", "bug", "deep"]);
    /* The one that is not wide is haiku's, and it is not an exception to the
       rule — it is the rule, since that model has no 1M tier to ask for. */
    const narrow = PRESETS.filter((p) => contextWindowFor(p.model) !== 1_000_000);
    expect(narrow.map((p) => p.model)).toEqual(["haiku"]);
    for (const p of PRESETS) {
      if (contextWindowFor(p.model) === 1_000_000) {
        expect(p.note).toContain("[1m]");
      }
    }
  });

  test("they run cheapest to dearest, which is the only order the menu implies", () => {
    /* Two terms, because the window is not one of them any more. The family is
       what the rate is charged at, and within a family the effort is what a
       turn spends — so `opus[1m] · high` sits below `opus[1m] · xhigh` and the
       tier decides nothing. Ranked lexicographically, and ties are allowed:
       two rows at the same price are a real arrangement, and the label is what
       tells them apart. */
    const rank = (p: (typeof PRESETS)[number]): [number, number] => [
      ["haiku", "sonnet", "opus", "fable"].indexOf(
        p.model.replace(/\[.*\]$/, ""),
      ),
      p.effort ? EFFORT_LEVELS.indexOf(p.effort) : -1,
    ];
    const ranks = PRESETS.map(rank);
    expect(ranks.map(([family]) => family)).not.toContain(-1);
    const cmp = (a: [number, number], b: [number, number]) =>
      a[0] - b[0] || a[1] - b[1];
    expect([...ranks].sort(cmp)).toEqual(ranks);
  });
});

describe("the menu the + puts up", () => {
  test("every preset is offered, and the plain opening last", () => {
    const m = items(menuFor({ kind: "spawn", presets: presetPicks() }));
    expect(m.map((i) => i.id)).toEqual([
      ...PRESETS.map((p) => `preset:${p.id}`),
      "new",
    ]);
    /* The one that needs no reading is the one you get by not right-clicking,
       so it sits under the five that are worth looking at. */
    expect(m[m.length - 1].label).toBe("as claude code is set up");
  });

  test("the notes ride the items, and nothing else in the app has one", () => {
    const m = items(menuFor({ kind: "spawn", presets: presetPicks() }));
    expect(m.filter((i) => i.note).length).toBe(PRESETS.length);
    expect(items(menuFor({ kind: "card" })).some((i) => i.note)).toBe(false);
  });

  test("with no presets it is still the plain opening, not an empty box", () => {
    /* `tidy` drops the separator that would otherwise open the menu. */
    expect(menuFor({ kind: "spawn" })).toEqual([
      { kind: "item", id: "new", label: "as claude code is set up" },
    ]);
  });
});

describe("what a plain + opens, and changing it", () => {
  test("the built-in default is opus on the wide window at xhigh", () => {
    /* Pinned rather than left to whatever `deep` happens to say, because this
       is the one preset the wall applies to cards nobody chose a preset for —
       so an edit to the catalogue that moved it would change what every plain
       `+` costs, silently, on a wall where nothing on the card says which
       setting opened it. Anthropic's effort guidance puts coding and agentic
       work at `xhigh` specifically; `high` is for most other intelligence-
       sensitive work, and `max` is the overshoot this menu already refuses. */
    const d = defaultPresetFor(null);
    expect(d?.id).toBe(FALLBACK_DEFAULT_PRESET);
    expect(d?.model).toBe("opus[1m]");
    expect(d?.effort).toBe("xhigh");
  });

  test("never answered and answered 'none' are different answers", () => {
    /* The distinction the nullable column exists for. Collapsing them would
       make the wall's default impossible to turn off: the only way to say "no
       preset" would be indistinguishable from never having been asked, and the
       default would come straight back. */
    expect(defaultPresetFor(null)?.id).toBe(FALLBACK_DEFAULT_PRESET);
    expect(defaultPresetFor(undefined)?.id).toBe(FALLBACK_DEFAULT_PRESET);
    expect(defaultPresetFor("")).toBeUndefined();
  });

  test("a stored id this build has retired falls back, rather than to nothing", () => {
    /* A preset that was renamed away is much likelier than a wall that meant
       no preset at all — and falling through to "none" would quietly downgrade
       every card opened after the rename. */
    expect(defaultPresetFor("ask")?.id).toBe("ask");
    expect(defaultPresetFor("a-preset-from-some-later-build")?.id).toBe(
      FALLBACK_DEFAULT_PRESET,
    );
  });

  test("the menu marks the row a plain + would open, and only that one", () => {
    const m = items(menuFor({ kind: "spawn", presets: presetPicks(), presetDefault: "work" }));
    const on = m.filter((i) => i.on);
    expect(on.map((i) => i.id)).toEqual(["preset:work"]);
    /* Marked *and* unmarked, so the rest are radio rows showing they are not
       chosen rather than plain items saying nothing either way. */
    expect(m.every((i) => i.on !== undefined)).toBe(true);
  });

  test("'as claude code is set up' is one of the choices, and marked like one", () => {
    /* It is stored as `""`, so it has to be markable the same way — otherwise
       a wall deliberately opening cards on no preset shows a menu with no dot
       anywhere and reads as one nobody has answered. */
    const m = items(menuFor({ kind: "spawn", presets: presetPicks(), presetDefault: "" }));
    expect(m.filter((i) => i.on).map((i) => i.id)).toEqual(["new"]);
  });

  test("with nobody to tell it what the default is, it marks nothing", () => {
    const m = items(menuFor({ kind: "spawn", presets: presetPicks() }));
    expect(m.every((i) => i.on === undefined)).toBe(true);
  });

  test("the ctrl-click is said out loud, and only where it would do something", () => {
    /* `ContextMenu` has no room for a second action on a row, so the second
       job of this menu is a modifier — and a modifier nobody is told about is
       a feature only its author has. */
    const hints = (t: Parameters<typeof menuFor>[0]) =>
      menuFor(t).filter((i) => i.kind === "hint");
    const told = hints({ kind: "spawn", presets: presetPicks(), presetDefault: "work" });
    expect(told.length).toBe(1);
    expect(told[0]).toMatchObject({ text: expect.stringContaining("ctrl-click") });
    /* Nothing to act on, nothing said. */
    expect(hints({ kind: "spawn", presets: presetPicks() }).length).toBe(0);
    /* And it stays the one menu in the app with a caption on it. */
    expect(hints({ kind: "card" }).length).toBe(0);
  });
});

describe("what a card an agent opened is set up as", () => {
  test("each of the three names resolves to a preset this build has", () => {
    /* The failure this catches is the one that costs money quietly: a name the
       tool accepts and the table does not know opens a card on the machine's
       own setting, while the agent, the receipt and the wall all say otherwise.
       `presetForSpawn` degrades rather than throws on purpose, so nothing but
       this notices. */
    for (const name of SPAWN_MODELS) {
      expect(presetForSpawn(name)).toBeDefined();
    }
  });

  test("the three are the three `spawn` will hand over", () => {
    /* The seam is a name crossing an `emit`, and the two ends are in different
       languages — so this reads the Rust array rather than a transcription of
       it. `spawn.rs`'s `the_three_names_are_the_ones_the_wall_resolves` holds
       the other half, that the schema's enum is what the validator accepts. */
    const rs = readFileSync("src-tauri/src/spawn.rs", "utf8");
    const arr = rs.match(/pub const SPAWN_MODELS: \[&str; \d+\] = \[([^\]]*)\]/);
    expect(arr).not.toBeNull();
    const rust = [...arr![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(rust).toEqual([...SPAWN_MODELS]);
  });

  test("the cheap name is the one preset that claims no effort", () => {
    /* Haiku 4.5 has no `--effort`, and the CLI drops the flag silently rather
       than refusing it — so a mapping that landed `haiku` on any other row
       would look right everywhere and buy nothing. */
    expect(presetForSpawn("haiku")?.model).toBe("haiku");
    expect(presetForSpawn("haiku")?.effort).toBeUndefined();
  });

  test("the families Rust refuses an effort on are exactly the ones with no level", () => {
    /* `spawn.rs`'s `EFFORTLESS` is the one fact about what a model *costs* that
       lives on the Rust side, and it is there because a refusal has to happen
       before an id is minted — which is before this table is ever reached. That
       makes it a second copy, and this is what stops it drifting from the
       first: read out of the source rather than transcribed, and compared
       against the real rows.
       Held here rather than in a cargo test for a second reason — this machine
       has no MSVC and runs none of those (`.claude/rules/build.md`), so a cargo
       assertion about a `.ts` file would be one nobody ever sees go red. */
    const rs = readFileSync("src-tauri/src/spawn.rs", "utf8");
    const arr = rs.match(/const EFFORTLESS: \[&str; \d+\] = \[([^\]]*)\]/);
    expect(arr).not.toBeNull();
    const deaf = [...arr![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const noLevel = SPAWN_MODELS.filter((n) => presetForSpawn(n)?.effort === undefined);
    expect(deaf.sort()).toEqual([...noLevel].sort());
  });

  test("a family name never resolves to a narrower window than the menu would pick", () => {
    /* The point of resolving to a preset rather than to a bare `--model` is
       that the pairing comes with it. `sonnet` is sonnet at a level somebody
       chose; `opus` is the wide window, because the presets that are not are
       the cheap end of a menu this door does not offer. */
    expect(presetForSpawn("sonnet")).toMatchObject({
      model: "sonnet[1m]",
      effort: "medium",
    });
    expect(presetForSpawn("opus")?.model).toBe("opus[1m]");
    /* Both wide, and that is the point of the door rather than a coincidence:
       `spawn` has no argument that says *window*, so a parent who needed room
       could not ask for it — the name has to carry it. */
    expect(contextWindowFor(presetForSpawn("sonnet")!.model)).toBe(1_000_000);
  });

  test("the default a name carries is the working level, not the dear one", () => {
    /* Sink `564bd55d`, and the reason it is not the same answer as
       `FALLBACK_DEFAULT_PRESET`. That default is for a *person* clicking `+`
       before they know what the card is for, where being answered too cheaply
       is the unrecoverable mistake. A spawned card is the other case: the
       parent wrote the brief and knows the lane, and the overspend is
       multiplied by however many cards it opened. */
    expect(presetForSpawn("sonnet")?.effort).toBe("medium");
    expect(presetForSpawn("opus")?.effort).toBe("high");
    /* And that is a different row from what the plain `+` opens, which is the
       whole of the asymmetry — if these ever agree by accident, one of the two
       arguments has been lost. */
    expect(presetForSpawn("opus")?.effort).not.toBe(
      presetById(FALLBACK_DEFAULT_PRESET)?.effort,
    );
  });

  test("a named effort moves the level and keeps the window the name chose", () => {
    /* Which window a family gets is a judgement this table made and the caller
       has not read — so naming a level may not be a way to lose it. This is the
       whole reason `presetForSpawn` still resolves through a row rather than
       building a pair out of two strings. */
    const low = presetForSpawn("opus", "low");
    expect(low).toMatchObject({ model: "opus[1m]", effort: "low" });
    expect(presetForSpawn("sonnet", "xhigh")).toMatchObject({
      model: "sonnet[1m]",
      effort: "xhigh",
    });
    /* `max` is on no preset — the menu stops at `xhigh` because a menu is
       picked from without measuring — but an agent naming it has measured
       something about one lane of a job it divided up itself. */
    expect(presetForSpawn("opus", "max")?.effort).toBe("max");
  });

  test("asking for the level a name already carries is the same row, not a second one", () => {
    /* Or `opus` and `opus`+`high` would be two ids meaning one thing, and the
       id is the only part of a preset that is supposed to be stable. */
    expect(presetForSpawn("opus", "high")).toBe(presetForSpawn("opus"));
    expect(presetForSpawn("sonnet", "medium")).toBe(presetForSpawn("sonnet"));
  });

  test("a level that cannot land leaves the row's own, rather than claiming it", () => {
    /* `asked_effort` refuses both of these before a card is minted, so neither
       arm is reachable from the tool. They are held anyway because the failure
       is a *card that claims a level it is not running at* — haiku drops
       `--effort` silently, so a build where the Rust gate went missing would
       draw the word in the meta bar, store it on the row and hand it back at
       every wake, with nothing anywhere disagreeing. */
    expect(presetForSpawn("haiku", "high")?.effort).toBeUndefined();
    expect(presetForSpawn("opus", "ultra")?.effort).toBe("high");
    expect(presetForSpawn("opus", "")?.effort).toBe("high");
    /* And an effort with no model is still no preset at all: there is nothing
       to hang a level on, and inventing a model here would be this table
       choosing one the caller never named. */
    expect(presetForSpawn(null, "low")).toBeUndefined();
  });

  test("the five levels are the five `spawn` will hand over", () => {
    /* The other seam, and it breaks the same way as the model one: a level Rust
       accepts and this file cannot read is a card at the family's default with
       the receipt saying otherwise. Read out of `spawn.rs` rather than
       transcribed, and against `EFFORT_LEVELS` rather than a literal — the
       words are `/effort`'s, so a caller needs one vocabulary and not two. */
    const rs = readFileSync("src-tauri/src/spawn.rs", "utf8");
    const arr = rs.match(/pub const SPAWN_EFFORTS: \[&str; \d+\] = \[([^\]]*)\]/);
    expect(arr).not.toBeNull();
    const rust = [...arr![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(rust).toEqual([...EFFORT_LEVELS]);
    for (const level of rust) {
      expect(presetForSpawn("opus", level)?.effort).toBe(level);
    }
  });

  test("nobody naming one is not the wall's default, it is no preset at all", () => {
    /* Three inputs and they are genuinely three, exactly as `defaultPresetFor`
       has to be. Silently spending the dear end of the menu on every spawned
       card would be the one change here nobody chose — and the wall's default
       answers a different question, which is what the user's own `+` opens. */
    expect(presetForSpawn(null)).toBeUndefined();
    expect(presetForSpawn(undefined)).toBeUndefined();
    expect(presetForSpawn("")).toBeUndefined();
    expect(presetForSpawn("  ")).toBeUndefined();
  });

  test("a name this build has never heard of opens a card rather than failing to", () => {
    /* `do_spawn` has refused anything but the three by the time this is
       reached, so this arm is only ever a build that gained a fourth name at
       one end. The normalizer's usual bargain: degrade to something that
       works. */
    expect(presetForSpawn("fable")).toBeUndefined();
    expect(presetForSpawn("gpt-4")).toBeUndefined();
  });

  test("it reads what a model would actually write", () => {
    expect(presetForSpawn(" Sonnet ")?.id).toBe(presetForSpawn("sonnet")?.id);
  });
});
