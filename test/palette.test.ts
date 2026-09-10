import { describe, expect, test } from "bun:test";

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { KNOBS } from "../src/lib/theme";
import {
  FAMILIES,
  FLOORS,
  SKINS,
  SKIN_GROUPS,
  SKIN_IDS,
  SKIN_KNOBS,
  SKIN_KNOB_INFO,
  STUDIO,
  allSkins,
  apart,
  cleanSkin,
  cleanSkinOverrides,
  contrast,
  deriveSkin,
  exportSkins,
  hueSat,
  importSkins,
  inFamily,
  isSkinKnob,
  nextSkin,
  parseHex,
  resolveSkin,
  skinChainOf,
  type Skin,
  type SkinKnob,
} from "../src/lib/palette";
import { exportThemes, importThemes } from "../src/lib/theme";

/* `fileURLToPath`, not `new URL(…).pathname`: on Windows the latter is
   `/C:/Users/…`, whose leading slash makes every `readdirSync` an ENOENT. */
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const TOKENS = readFileSync(join(SRC, "lib/tokens.css"), "utf8");

/** Every .svelte and .css file under src/, as text. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const at = join(dir, e.name);
      if (e.isDirectory()) walk(at);
      else if (/\.(svelte|css)$/.test(e.name)) out.push(readFileSync(at, "utf8"));
    }
  };
  walk(SRC);
  return out;
}

/** What `tokens.css` declares, so `studio` can be checked as the values it
 *  actually resolves to rather than as the empty map it is. */
function tokenDefaults(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of TOKENS.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gim)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

const DEFAULTS = tokenDefaults();

/** One `var(--x)` indirection followed, repeatedly, against the same map.
 *
 *  Needed because a token may be declared as *a reference to another token*
 *  rather than as a literal — `--hollow: var(--ink)` is the case that matters
 *  here, and it is written that way on purpose so that whatever the ground
 *  becomes, a dormant card follows it.
 *
 *  Without this the checks below do not fail on such a token, they **skip**
 *  it: `parseHex("var(--ink)")` is null, every measurement returns null, and
 *  every assertion guarded by `if (c === null) return` quietly passes. That is
 *  the worse failure of the two, and it had already happened — the dormant
 *  check was not running for `studio` at all, which is the one skin whose
 *  hollow is a reference. A skipped invariant looks exactly like a satisfied
 *  one from the outside.
 *
 *  Bounded, so a `--a: var(--b); --b: var(--a)` in the stylesheet costs a few
 *  iterations rather than the suite. A reference that resolves to nothing is
 *  left as it was and skips as before, which is right: that is a value only
 *  the browser can settle. */
function deref(value: string, map: Record<string, string>): string {
  let v = value;
  for (let i = 0; i < 8; i++) {
    const m = /^var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)$/i.exec(v.trim());
    if (!m) return v;
    const next = map[m[1]];
    if (next === undefined || next === v) return v;
    v = next;
  }
  return v;
}

/** The values a skin actually draws with: the stylesheet's defaults, with the
 *  skin's resolved chain written over them, and every plain `var()` reference
 *  followed to the literal underneath. This is what the browser computes, and
 *  checking anything less would let `studio` — whose map is empty on purpose —
 *  escape every invariant below. */
function drawn(id: string): Record<string, string> {
  const merged: Record<string, string> = { ...DEFAULTS, ...resolveSkin(id) };
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(merged)) out[k] = deref(v, merged);
  return out;
}

describe("the revert guarantee", () => {
  /* Same assertion the other ring opens with, and for the same reason: if this
     fails there is no way back to the untouched wall. Lyss's one hard
     requirement for this feature was that the default look and feel does not
     move, and this is the whole of it. */
  test("studio sets nothing", () => {
    expect(resolveSkin(STUDIO)).toEqual({});
  });

  test("and is first in the ring, so the way back is one known place", () => {
    expect(SKINS[0].id).toBe(STUDIO);
  });

  test("every built-in only touches skin knobs", () => {
    for (const s of SKINS) {
      for (const k of Object.keys(s.over)) expect(isSkinKnob(k)).toBe(true);
    }
  });

  /* The load-bearing one for two rings existing at all. An overlap means two
     holders writing one property, and the wall then depends on which of them
     painted last — a wall that changes when nothing did. */
  test("the two rings share no knob", () => {
    const reading = new Set<string>(KNOBS);
    for (const k of SKIN_KNOBS) {
      expect(reading.has(k), `${k} is on both rings`).toBe(false);
    }
  });
});

describe("a knob reaches a rule", () => {
  /* `theme.md`'s ugliest test, applied to the second ring — and it is here for
     exactly the bug it caught the first time: a catalogue can be complete, a
     paint can be correct, `getComputedStyle` can report every value back
     faithfully, and the wall can draw the same thing whatever you pick,
     because nothing in the theme half can see whether a rule consumes what it
     sets. */
  const all = sources().join("\n");

  test("tokens.css declares every knob, so studio is exactly the untouched app", () => {
    for (const k of SKIN_KNOBS) expect(TOKENS).toContain(`${k}:`);
  });

  test("and some rule actually reads every one of them", () => {
    for (const k of SKIN_KNOBS) {
      expect(all.includes(`var(${k}`), `${k} is declared but no rule draws with it`).toBe(true);
    }
  });

  /* The fallback rule is narrower on this ring than on the other, and the
     difference is deliberate rather than an oversight.

     `theme.ts` requires every one of its knobs to be read as `var(--k, base)`,
     because `Markdown.svelte` renders outside the panel and outside
     `tokens.css` and a bare `var()` resolving to nothing is a declaration
     invalid at computed-value time. The ground tokens have been read bare in
     nineteen hundred places since before any of this existed, they are always
     declared, and requiring a fallback on each would be a mechanical edit of
     the entire front end for no defect.

     `--ch-*` are new, so being strict costs nothing, and they are the ones
     where a missing value is worst: a bare `var(--ch-radius)` inside a `calc`
     invalidates the whole declaration, and a card with no radius is a card
     with no *border-radius property* at all. */
  test("every character knob carries its base value as the var() fallback", () => {
    for (const k of SKIN_KNOBS) {
      if (!k.startsWith("--ch-")) continue;
      expect(all.includes(`var(${k})`), `${k} is read with no fallback`).toBe(false);
    }
  });
});

describe("a token declared as a reference is still measured", () => {
  /* The hole this closes: `--hollow` is `var(--ink)` in `tokens.css`, so
     before `deref` every measurement of it was null and every check on it
     *skipped*. The dormant-card invariant was not running for `studio` — the
     one skin the floor was derived from — and it passed for exactly that
     reason. A skipped assertion is indistinguishable from a satisfied one
     unless something asserts it ran. */
  test("studio's hollow resolves to the wall rather than to the word var", () => {
    const v = drawn(STUDIO);
    expect(v["--hollow"]).toBe(v["--ink"]);
    expect(parseHex(v["--hollow"])).not.toBeNull();
  });

  test("and every skin's dormant pair is measurable, not skipped", () => {
    for (const s of SKINS) {
      const v = drawn(s.id);
      expect(contrast(v["--edge"], v["--ink"]), `${s.id} outline`).not.toBeNull();
      expect(contrast(v["--hollow"], v["--ink"]), `${s.id} fill`).not.toBeNull();
    }
  });
});

describe("the editor's copy", () => {
  test("every knob is described", () => {
    for (const k of SKIN_KNOBS) {
      expect(SKIN_KNOB_INFO[k]?.label, `${k} has no label`).toBeTruthy();
      expect(SKIN_KNOB_INFO[k]?.note, `${k} has no note`).toBeTruthy();
    }
  });

  test("and appears in exactly one group", () => {
    const seen = SKIN_GROUPS.flatMap((g) => g.knobs);
    expect([...seen].sort()).toEqual([...SKIN_KNOBS].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });
});

/* ── the invariant that replaced the ban ─────────────────────────────────
 *
 * `theme.ts` kept "colour means status" by refusing to let a theme name an
 * `--st-*` at all. That refusal cannot survive a ground that is not dark —
 * celadon is 8.6:1 on the studio's well and 1.6:1 on a blush one, the same
 * token meaning the same thing, illegible. So the ban became these, and they
 * are the reason a skin may move a status colour without the colour ceasing
 * to mean anything. See the head of `palette.ts`. */

const STATUS = ["--st-work", "--st-ask", "--st-soft", "--st-rest", "--st-fail"] as const;

describe.each(SKINS.map((s) => [s.label, s.id] as const))("%s keeps status meaning", (_l, id) => {
  const v = drawn(id);
  const well = v["--well"];

  test("every status colour is legible on this skin's own well", () => {
    for (const k of STATUS) {
      const c = contrast(v[k], well);
      /* A skin may legally set a knob to `var(…)` or a `color-mix(…)`, which
         cannot be measured from here. Skipping is the right trade: refusing an
         expression the browser understands would be worse than not checking
         it, and every colour that ships is a literal. */
      if (c === null) continue;
      expect(c, `${k} is ${c?.toFixed(2)}:1 on ${well}`).toBeGreaterThanOrEqual(FLOORS.contrast);
    }
  });

  test("and stays in its hue family", () => {
    for (const [k, fam] of Object.entries(FAMILIES)) {
      const hs = hueSat(v[k]);
      if (!hs) continue;
      /* A colour with no saturation has no meaningful hue, so it cannot be
         out of family — and `--st-soft` on a very muted skin is the realistic
         case. */
      if (hs.sat < 0.12) continue;
      expect(
        inFamily(hs.hue, fam.from, fam.to),
        `${k} is at ${hs.hue.toFixed(0)}°, outside ${fam.what} (${fam.from}–${fam.to})`,
      ).toBe(true);
    }
  });

  test("rest reads as no colour at all", () => {
    const hs = hueSat(v["--st-rest"]);
    if (!hs) return;
    expect(hs.sat, `--st-rest is ${hs.sat.toFixed(2)} saturated`).toBeLessThanOrEqual(
      FLOORS.restSat,
    );
  });

  /* Perceptual, not angular, and that is the whole point of it. Amber
     `#e9a13b` and rust `#c5603f` are twenty degrees apart in the *default*
     ink and nobody has ever confused them, so a hue-distance rule would have
     failed the thing it was written to protect. This floor caught a real one:
     meadow's first fail was `#b8523c`, 0.098 from its ask — two browns on
     cream. */
  test("working, asking and failed stay apart", () => {
    const pairs: [SkinKnob, SkinKnob][] = [
      ["--st-work", "--st-ask"],
      ["--st-ask", "--st-fail"],
      ["--st-work", "--st-fail"],
    ];
    for (const [a, b] of pairs) {
      const d = apart(v[a], v[b]);
      if (d === null) continue;
      expect(d, `${a} and ${b} are ${d?.toFixed(3)} apart`).toBeGreaterThanOrEqual(FLOORS.apart);
    }
  });

  /* The other direction, and it is not symmetry for its own sake: `--st-soft`
     is "amber ½ — a question left in prose". Being close to ask is its
     meaning, so drifting away from it is the defect here, and a skin that made
     it a distinct sixth colour would have invented a status. */
  test("softly-asking stays near asking", () => {
    const d = apart(v["--st-soft"], v["--st-ask"]);
    if (d === null) return;
    expect(d, `--st-soft is ${d?.toFixed(3)} from --st-ask`).toBeLessThanOrEqual(FLOORS.softNear);
  });

  /* The ramp is a ladder the whole front end reaches for by position — the
     four rungs are "brightest", "prose", "muted", "a mark". A skin that
     flattens two of them together loses a distinction ninety-odd rules are
     drawing with, and it fails silently: everything still renders. */
  test("the ink ramp is still a ladder", () => {
    const rungs = ["--paper", "--paper-dim", "--paper-mute", "--paper-faint"] as const;
    const ratios = rungs.map((k) => contrast(v[k], well));
    if (ratios.some((r) => r === null)) return;
    for (let i = 1; i < ratios.length; i++) {
      expect(
        ratios[i]!,
        `${rungs[i]} (${ratios[i]!.toFixed(1)}:1) is not below ${rungs[i - 1]} (${ratios[i - 1]!.toFixed(1)}:1)`,
      ).toBeLessThan(ratios[i - 1]!);
    }
    /* The rung that carries tool lines and fold caps is body text, so it owes
       AA. The first draft of `sugar` had it at 3.8:1 — which looked fine and
       is not. */
    expect(ratios[2]!, "--paper-mute is below AA for the text it is set in").toBeGreaterThanOrEqual(
      4.5,
    );
    /* And the brightest rung has to actually be bright, or the whole ladder
       has been shifted down rather than kept. */
    expect(ratios[0]!).toBeGreaterThanOrEqual(10);
  });

  test("a card is distinguishable from the wall behind it", () => {
    const c = contrast(v["--surface"], v["--ink"]);
    if (c === null) return;
    /* Small on purpose — this is a *seam*, not a contrast pair, and the dark
       wall itself only ships at 1.08. */
    expect(c).toBeGreaterThanOrEqual(1.06);
  });

  /* The one that was missing, and it let a real bug through: on the light
     skins as first shipped, **dormant cards were invisible**.

     A dormant card is filled with `--hollow` (which defaults to the wall
     itself), carries no shadow, and is outlined in a 1px *dashed* `--edge`.
     So on the dark wall the fill contributes exactly nothing — 1.0, by
     construction — and the entire card is its outline. That works there
     because the outline reads at 1.36. On `sugar` it was 1.18 and on `meadow`
     1.19, and a dashed hairline at 1.18 against the ground it is drawn on is
     not there.

     The check that shipped asked whether a *live* card was distinguishable
     from the wall, which was the wrong pair: it passed at 1.13 while the thing
     actually being complained about was three tokens away. A floor set below
     everything that ships tests nothing — the number has to come from the
     case that works, which is the dark wall, not from the cases in front of
     you. */
  test("and a dormant one is too, which is the outline and maybe the fill", () => {
    const outline = contrast(v["--edge"], v["--ink"]);
    const fill = contrast(v["--hollow"], v["--ink"]);
    if (outline === null || fill === null) return;
    /* Either may carry it, and on a dark ground only the outline does — so
       this is honestly a disjunction rather than two floors. The light skins
       clear it twice over, which is why they read better than the dark one
       here rather than merely as well. */
    const best = Math.max(outline, fill);
    expect(
      best,
      `a dormant card is outline ${outline.toFixed(2)} / fill ${fill.toFixed(2)} against its wall`,
    ).toBeGreaterThanOrEqual(FLOORS.dormant);
  });

  /* `--edge` is not only the dormant outline — it is every card border, every
     seam, the meta-bar rule and `column`'s round rule. If it is too weak the
     dormant card is just where you notice first. */
  test("the hairline reads against the wall and against a card", () => {
    const onWall = contrast(v["--edge"], v["--ink"]);
    const onCard = contrast(v["--edge"], v["--surface"]);
    if (onWall === null || onCard === null) return;
    expect(onWall, `--edge is ${onWall.toFixed(2)} on the wall`).toBeGreaterThanOrEqual(
      FLOORS.dormant,
    );
    expect(onCard, `--edge is ${onCard.toFixed(2)} on a card`).toBeGreaterThanOrEqual(1.2);
  });

  /* `--rule` is the *stronger* line — a prompt's left rule, a hover border. If
     a skin ever inverted the two, every "this one matters more" on the wall
     would be saying the opposite. */
  test("the strong line is stronger than the hairline", () => {
    const edge = contrast(v["--edge"], v["--ink"]);
    const rule = contrast(v["--rule"], v["--ink"]);
    if (edge === null || rule === null) return;
    expect(rule).toBeGreaterThan(edge);
  });
});

describe("the shipped skins are what they say they are", () => {
  test("every colour in a built-in is a literal, so the suite can read it", () => {
    /* Not a rule for authored skins — `var(…)` and `color-mix(…)` are legal
       and simply skip the checks above. It is a rule for the ones that *ship*,
       because a built-in that quietly opted out of the invariant would make
       every assertion above vacuous without failing one of them. */
    for (const s of SKINS) {
      for (const k of STATUS) {
        const v = s.over[k];
        if (v === undefined) continue;
        expect(parseHex(v), `${s.id}'s ${k} is "${v}", which cannot be checked`).not.toBeNull();
      }
    }
  });

  test("studio is the only one that changes nothing", () => {
    for (const s of SKINS) {
      if (s.id === STUDIO) continue;
      expect(Object.keys(s.over).length, `${s.id} is empty`).toBeGreaterThan(0);
    }
  });

  test("the two light skins really are light, and twilight really is dark", () => {
    /* A cheap sanity check that the three feels are three feels — if a skin
       were pasted in from the wrong place this is what would notice. */
    const lum = (id: string) => contrast(drawn(id)["--well"], "#000000")!;
    expect(lum("sugar")).toBeGreaterThan(lum(STUDIO));
    expect(lum("meadow")).toBeGreaterThan(lum(STUDIO));
    expect(lum("twilight")).toBeLessThan(lum("sugar"));
  });

  test("each names itself in the ring and cycles round", () => {
    const ids = SKINS.map((s) => s.id);
    for (let i = 0; i < ids.length; i++) {
      expect(nextSkin(ids[i])).toBe(ids[(i + 1) % ids.length]);
    }
  });
});

describe("reading a store back", () => {
  test("a knob from another ring is dropped", () => {
    expect(cleanSkinOverrides({ "--tx-size": "2rem", "--ink": "#fff" })).toEqual({
      "--ink": "#fff",
    });
  });

  test("an entry claiming a built-in's name is refused", () => {
    expect(cleanSkin({ id: STUDIO, over: {} })).toBeNull();
    expect(cleanSkin({ id: "sugar", over: {} })).toBeNull();
  });

  test("a chain resolves root-first with the child winning", () => {
    const mine: Skin[] = [
      { id: "mine", label: "mine", note: "", from: "sugar", over: { "--ink": "#000000" } },
    ];
    const over = resolveSkin("mine", mine);
    expect(over["--ink"]).toBe("#000000");
    /* Inherited from sugar, untouched. */
    expect(over["--ch-radius"]).toBe("10px");
    expect(skinChainOf("mine", mine).map((s) => s.id)).toEqual(["sugar", "mine"]);
  });

  test("a from naming nothing still resolves on its own layer", () => {
    const mine: Skin[] = [
      { id: "orphan", label: "orphan", note: "", from: "gone", over: { "--ink": "#123456" } },
    ];
    expect(resolveSkin("orphan", mine)).toEqual({ "--ink": "#123456" });
  });

  test("deriving by copy flattens the base in and cuts the link", () => {
    const s = deriveSkin("sugar", { label: "mine", how: "copy" });
    expect(s.from).toBeNull();
    expect(s.over["--ch-radius"]).toBe("10px");
  });

  test("built-ins are all in the ring and none is a custom", () => {
    expect(allSkins().map((s) => s.id)).toEqual(SKINS.map((s) => s.id));
    for (const s of SKINS) expect(SKIN_IDS.has(s.id)).toBe(true);
  });
});

describe("the two rings do not take each other's exports", () => {
  /* Both formats are `{ <key>: 1, themes: [...] }` and look alike enough to
     paste into the wrong panel. Without the wrapper key, a skin taken in here
     would arrive as an entry whose every knob was filtered out — present in
     the list, selectable, and changing nothing, with nothing in the panel to
     say why. Refusing it lets the import say "nothing in that" instead. */
  const aSkin: Skin[] = [
    { id: "mine", label: "mine", note: "", from: null, over: { "--ink": "#101010" } },
  ];

  test("a skin export does not import as a reading theme", () => {
    expect(importThemes(exportSkins(aSkin))).toEqual([]);
  });

  test("a reading-theme export does not import as a skin", () => {
    const aTheme = [
      { id: "mine", label: "mine", note: "", from: null, over: { "--tx-size": "1rem" } },
    ];
    expect(importSkins(exportThemes(aTheme as never))).toEqual([]);
  });

  test("but a skin's own export comes back whole", () => {
    expect(importSkins(exportSkins(aSkin))).toEqual(aSkin);
  });

  test("and a bare array is still taken, since that is a thing people paste", () => {
    expect(importSkins(JSON.stringify(aSkin))).toEqual(aSkin);
  });
});

/* ── the panel draws either ring off one handle ───────────────────────────
 *
 * `Themes.svelte` holds a `Ring` and calls the same members whichever tab is
 * showing, so the two holders have to agree on every name. Nothing in either
 * holder can see the other and nothing in the component can see either — the
 * exact shape of contract that needs a test standing outside all three, which
 * is the general lesson `theme.md` already draws from the knob bug.
 *
 * Read as text because the holders are `.svelte.ts` and carry runes, which
 * cannot be imported into a bun test. Crude, and it fails in the direction
 * that matters: rename `Ink.theme` and this goes red rather than the panel
 * going blank on one tab. */
describe("both holders answer the same questions", () => {
  const panel = readFileSync(join(SRC, "lib/Themes.svelte"), "utf8");
  const ink = readFileSync(join(SRC, "lib/theme.svelte.ts"), "utf8");
  const skins = readFileSync(join(SRC, "lib/palette.svelte.ts"), "utf8");

  /** Every member the panel reaches for off its `Ring` handle. */
  const asked = [...panel.matchAll(/\bring\.([a-z][A-Za-z]*)/g)].map((m) => m[1]);

  test("the panel asks for something", () => {
    /* Guards the regex above: if the panel is refactored to a different name
       this suite would otherwise pass by asking nothing. */
    expect(new Set(asked).size).toBeGreaterThan(6);
  });

  test.each([...new Set(asked)].sort())("both declare %s", (member) => {
    const declared = (src: string) =>
      new RegExp(`(get\\s+${member}\\s*\\(|^\\s{2}${member}\\s*[=(<])`, "m").test(src);
    expect(declared(ink), `Ink has no ${member}`).toBe(true);
    expect(declared(skins), `Skins has no ${member}`).toBe(true);
  });
});
