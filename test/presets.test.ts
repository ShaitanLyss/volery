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

  test("the wide window is asked for wherever it is not the cheap end", () => {
    /* `contextWindowFor` reads the tier out of the alias, which is what sizes
       the ring before `system/init` has said anything — and the tier is free:
       `opus` and `opus[1m]` are one row in the price table at $5/$25 per MTok,
       as are `sonnet` and `sonnet[1m]` at $2/$10. So a `[1m]` nobody asked for
       costs nothing, which is why this test no longer names two ids: the note
       beside the label still has to say the tier, and `presetPicks` is what
       shows it. What is asserted is the direction — the two presets that exist
       to be cheap keep the small window, since the point of the cheap end is a
       card that cannot quietly grow into a large one. */
    const wide = PRESETS.filter((p) => contextWindowFor(p.model) === 1_000_000);
    expect(wide.map((p) => p.id)).toEqual(["read", "bug", "deep"]);
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

  test("a family name never resolves to a narrower window than the menu would pick", () => {
    /* The point of resolving to a preset rather than to a bare `--model` is
       that the pairing comes with it. `sonnet` is sonnet at a level somebody
       chose; `opus` is the wide window, because the presets that are not are
       the cheap end of a menu this door does not offer. */
    expect(presetForSpawn("sonnet")).toMatchObject({ model: "sonnet", effort: "medium" });
    expect(presetForSpawn("opus")?.model).toBe("opus[1m]");
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
