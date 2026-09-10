/* What the wall is made of: the ground, the ink ramp, the status colours, the
 * faces, and how much the thing moves.
 *
 * The second of the two theme rings, and the one where **colour lives**.
 * `theme.ts` is the first, and the split is deliberate — see the head of that
 * file. In one sentence: the reading and the palette are orthogonal, you want
 * `column`'s ruled-off rounds *and* `sugar`'s pink without authoring a theme
 * per combination, and keeping them apart means `theme.ts`'s promise that
 * nothing on its ring can restyle a failed card stays literally true rather
 * than being quietly repealed. The two knob sets are disjoint, so neither
 * `paint` can disturb the other.
 *
 * The shape is the same as the other ring's and for the same reasons: a skin
 * is a *diff* against `tokens.css`, applied as custom properties on the root
 * element and taken off again by removing them, so reverting is exact rather
 * than approximate. `STUDIO` is this ring's empty one and its emptiness is the
 * guarantee. Everything below the catalogue — normalizing, chains, deriving,
 * cycling, import and export — is `catalogue.ts`.
 *
 * ## Colour still means status, and that is now a test rather than a ban
 *
 * The rule this ring exists to bend is real and worth restating before it is
 * bent: colour on this wall means status, so a card that failed must not fail
 * differently because of how somebody likes to read. `theme.ts` enforced that
 * by refusing to let any theme name an `--st-*` at all.
 *
 * That refusal cannot survive a ground that is not dark. Celadon `#7fb8a4`
 * against `#0f0d0c` is 8.6:1 and against a blush `#fffbfd` it is 1.6:1 — the
 * *same token*, meaning the same thing, illegible. So a skin that moves the
 * ground has to move the status colours with it, and the honest question is
 * not whether they may move but what must stay true when they do.
 *
 * Three things, and `test/palette.test.ts` asserts each one for every skin:
 *
 *  - **each status colour is legible on that skin's own well** — a contrast
 *    floor computed against `--well`, not against a remembered dark;
 *  - **each keeps its hue family** — work stays green-through-cyan, ask and
 *    soft stay amber, fail stays red-through-rust, rest stays desaturated. The
 *    families are what somebody has learned; the exact colour is not;
 *  - **work, ask and fail stay apart** — a perceptual distance floor in Oklab,
 *    because hue alone does not separate them. Amber `#e9a13b` and rust
 *    `#c5603f` are 20° apart in the *default* ink and are told apart by
 *    lightness and saturation, so a hue-distance rule would have failed the
 *    thing it was written to protect.
 *
 * `soft` is deliberately exempt from the last one and bounded the other way
 * instead: it is "amber ½ — a question left in prose", so being close to `ask`
 * is its whole meaning and being far from it would be the defect.
 *
 * ## The character group is where motion is a knob
 *
 * `--ch-*` are the ones that are not a colour: the corner radius, the idle
 * float on a working card, the pop a card arrives with, the reach of the glow.
 * They default to exactly what the wall draws today, so `studio` is a no-op
 * here as much as anywhere else.
 *
 * Idle motion is the expensive kind and the numbers are not vague — see
 * `motion.ts`, which has the measurement that named the original bug. A wall
 * that floats is a wall presenting at display rate. That is a real cost and it
 * is *chosen*: `[data-motion]` is the lever, `spare` steps it and `still`
 * stops it, and a skin's float is written so that both arms neutralise it
 * rather than merely damping it.
 *
 * Pure, and tested in `test/palette.test.ts`. The applying half — the DOM
 * write and the storage — is `palette.svelte.ts`.
 */

import { makeCatalogue, type Entry } from "./catalogue";

export {
  MAX_CHAIN,
  EXPORT_VERSION,
  okValue,
  slugify,
  type Derivation,
  type Entry,
} from "./catalogue";

/** Every property a skin is allowed to set.
 *
 *  Closed, like the other ring's, and for the same reason: this is data that
 *  outlives the build that wrote it and that a person types into. Disjoint
 *  from `theme.ts`'s `KNOBS`, which `test/palette.test.ts` asserts — an
 *  overlap would mean two rings writing one property and the last switch
 *  winning, which is a wall that changes when nothing did. */
export const SKIN_KNOBS = [
  /* ground */
  "--ink",
  "--well",
  "--surface",
  "--raised",
  "--edge",
  "--rule",
  /* the ink ramp */
  "--paper",
  "--paper-dim",
  "--paper-mute",
  "--paper-faint",
  /* status — the argument for these being here at all is in the head */
  "--st-work",
  "--st-ask",
  "--st-soft",
  "--st-rest",
  "--st-fail",
  /* faces */
  "--display",
  "--body",
  "--util",
  "--mono",
  /* character */
  "--ch-radius",
  "--ch-lift",
  "--ch-lift-ms",
  "--ch-pop",
  "--ch-pop-ms",
  "--ch-ease",
  "--ch-glow",
  "--ch-shadow",
] as const;

export type SkinKnob = (typeof SKIN_KNOBS)[number];
export type SkinOverrides = Partial<Record<SkinKnob, string>>;

/** What each knob is called where somebody is turning it, and what it takes.
 *  Same bargain as `KNOB_INFO`: `takes` is a hint and a placeholder, never a
 *  validator — `okValue` is the only gate. */
export const SKIN_KNOB_INFO: Record<SkinKnob, { label: string; takes: string; note: string }> = {
  "--ink": { label: "the wall", takes: "#151210", note: "what the studio floor is, behind everything" },
  "--well": { label: "the panel", takes: "#0f0d0c", note: "the transcript's ground, and what contrast is measured against" },
  "--surface": { label: "a card", takes: "#1e1a18", note: "what a conversation is drawn on" },
  "--raised": { label: "raised", takes: "#272220", note: "a fence, a chip, a control that sits above a card" },
  "--edge": { label: "edges", takes: "#332c29", note: "the hairline round a card, a seam, the meta-bar rule" },
  "--rule": { label: "rules", takes: "#3d3532", note: "the stronger line — a prompt's left rule, a hover border" },
  "--paper": { label: "brightest ink", takes: "#ede4d8", note: "prompts, headings, bold. Warm bone, never pure white" },
  "--paper-dim": { label: "prose ink", takes: "#b4a89c", note: "an answer at length — the second rung of the ramp" },
  "--paper-mute": { label: "muted ink", takes: "#8a7e74", note: "tool lines and fold caps; keep it above 4.5:1" },
  "--paper-faint": { label: "marks", takes: "#615850", note: "bullets, markers, underlines — a mark, never a glyph" },
  "--st-work": { label: "working", takes: "#7fb8a4", note: "green through cyan. Streaming, alive" },
  "--st-ask": { label: "asking", takes: "#e9a13b", note: "amber. A structured ask, at full bloom" },
  "--st-soft": { label: "asking softly", takes: "#a8823f", note: "amber held back — a question left in prose" },
  "--st-rest": { label: "at rest", takes: "#6b6058", note: "done. Desaturated, so it reads as no colour at all" },
  "--st-fail": { label: "failed", takes: "#c5603f", note: "red through rust. Crashed" },
  "--display": { label: "display face", takes: '"Sitka Display", Georgia, serif', note: "card titles and headings" },
  "--body": { label: "body face", takes: '"Sitka Text", Georgia, serif', note: "the reading itself" },
  "--util": { label: "utility face", takes: "Corbel, system-ui, sans-serif", note: "labels, meta lines, everything small" },
  "--mono": { label: "mono face", takes: '"Cascadia Mono", ui-monospace, monospace', note: "fences, logs, the shell" },
  "--ch-radius": { label: "corners", takes: "4px", note: "how round a card is. The cheapest character there is" },
  "--ch-lift": { label: "float", takes: "0px", note: "how far a working card drifts. Costs GPU — see motion.ts" },
  "--ch-lift-ms": { label: "the rhythm", takes: "4200ms", note: "one float, and one breath of the glow — deliberately the same clock" },
  "--ch-pop": { label: "arrival pop", takes: "1", note: "the scale a card overshoots to when it lands. 1 is none" },
  "--ch-pop-ms": { label: "pop time", takes: "260ms", note: "how long that takes. Fires once, so it costs nothing at rest" },
  "--ch-ease": { label: "the curve", takes: "cubic-bezier(0.2, 0.8, 0.3, 1)", note: "how a pop moves; a springy one overshoots" },
  "--ch-glow": { label: "glow reach", takes: "34px", note: "how far the working card's light spreads" },
  "--ch-shadow": { label: "card shadow", takes: "none", note: "a card's drop shadow. Rastered once, so it costs nothing at rest" },
};

/** The knobs in the order the editor shows them, under the headings this file
 *  already argues in. */
export const SKIN_GROUPS: { title: string; knobs: SkinKnob[] }[] = [
  { title: "ground", knobs: ["--ink", "--well", "--surface", "--raised", "--edge", "--rule"] },
  { title: "ink", knobs: ["--paper", "--paper-dim", "--paper-mute", "--paper-faint"] },
  {
    title: "status",
    knobs: ["--st-work", "--st-ask", "--st-soft", "--st-rest", "--st-fail"],
  },
  { title: "faces", knobs: ["--display", "--body", "--util", "--mono"] },
  {
    title: "character",
    knobs: [
      "--ch-radius",
      "--ch-shadow",
      "--ch-glow",
      "--ch-lift",
      "--ch-lift-ms",
      "--ch-pop",
      "--ch-pop-ms",
      "--ch-ease",
    ],
  },
];

/** One skin. The shape is `catalogue.ts`'s with this ring's knobs bound in. */
export type Skin = Entry<SkinKnob>;

/** The skin that changes nothing. Its emptiness is the revert guarantee, and
 *  it is the reason "the exact same look and feel" is a thing this feature can
 *  promise rather than approximate. */
export const STUDIO = "studio";

/* The figures in the built-ins below are computed rather than eyeballed, by the
   same arithmetic `test/palette.test.ts` runs — WCAG contrast against that
   skin's own `--well`, and Oklab distance between the three status colours that
   have to stay apart. The default ink is the ladder the others are tuned to
   match:

     --paper       15.4:1     --st-work  8.6:1
     --paper-dim    8.3:1     --st-ask   8.9:1
     --paper-mute   4.9:1     --st-fail  4.7:1
     --paper-faint  2.8:1     --st-rest  3.2:1

   Keeping the ramp's *shape* matters more than matching any one rung: the four
   rungs are a ladder the whole front end reaches for by position, and a skin
   that flattens two of them together loses a distinction ninety-odd rules are
   drawing with. */

export const SKINS: Skin[] = [
  {
    id: STUDIO,
    label: "studio",
    note: "as it always was — the warm ink wall",
    from: null,
    /* Empty on purpose, exactly like `paper` on the other ring. Anything added
       here stops this being a name for the untouched app, at which point there
       is no way back to it. */
    over: {},
    builtin: true,
  },
  {
    id: "sugar",
    label: "sugar",
    note: "pastel light — blush ground, plum ink, and it is very awake",
    from: null,
    over: {
      /* Blush rather than white. A pure #fff ground under a serif at this size
         glares, and the whole point of a light skin here is relief from the
         dark rather than a trade of one discomfort for another. The card is
         the brightest thing, so a card still reads as raised off the wall —
         which is the relationship the dark ink gets by making the card
         *lighter* than the floor, and it has to survive the inversion. */
      "--ink": "#f7eff3",
      "--well": "#fffbfd",
      "--surface": "#ffffff",
      "--raised": "#fdf3f7",
      "--edge": "#ecdae4",
      "--rule": "#d9bfcf",
      /* The ramp, tuned to the default's shape: 14.3 / 7.9 / 4.8 / 2.8 against
         this well, versus 15.4 / 8.3 / 4.9 / 2.8 in the dark. `--paper-mute`
         is the rung that matters most to get right — it carries tool lines and
         fold caps, and the first draft of this skin had it at 3.8:1, which is
         below AA for the body text it is actually set in. */
      "--paper": "#35232c",
      "--paper-dim": "#614954",
      "--paper-mute": "#816a76",
      "--paper-faint": "#a9939e",
      /* Status, re-tuned for a light ground rather than carried over. Note
         these are *deeper* than the ground is pastel: a pastel green on white
         is 1.4:1 and says nothing. The pastel is the wall; the status marks
         still have to be marks. work 3.9:1, ask 3.3:1, fail 4.0:1 — all above
         the 3:1 floor for a non-text mark, and all in their own families. */
      "--st-work": "#2e8f76",
      "--st-ask": "#c8791a",
      "--st-soft": "#a98a5c",
      "--st-rest": "#9a8a93",
      /* Rose rather than rust: on a blush ground rust goes muddy, and rose is
         both legible and the right amount of alarming for a wall that is
         otherwise this cheerful. Still red-family, 0.13 from ask in Oklab. */
      "--st-fail": "#cf5568",
      /* The face, and it does more for the identity than any single colour
         here. Sitka is a *transitional serif* — it has the manners of a
         printed page, which is exactly right for the studio and exactly wrong
         for this. Candara is a humanist sans with flared stems and rounded
         terminals, it ships with Windows so nothing is downloaded, and it was
         drawn for screens at these sizes. Corbel stays available behind it for
         the same family's proportions if a machine somehow lacks it.
         `--mono` is left alone: a fence is somebody's literal output and is
         the one place on the wall that should not have a mood. */
      "--display": '"Candara", "Segoe UI Variable Display", Corbel, system-ui, sans-serif',
      "--body": '"Candara", Corbel, "Segoe UI", system-ui, sans-serif',
      "--util": '"Candara", Corbel, "Segoe UI", system-ui, sans-serif',
      /* Rounder, and it is most of what makes this read as friendly. Free —
         no motion, no present, no raster beyond the one the card already
         does. */
      "--ch-radius": "10px",
      /* A real shadow, which the dark wall never needed and this one does. On
         `#151210` a 1px `--edge` is a visible seam; on blush it is almost
         nothing, and without this the cards stop reading as objects sitting on
         a surface and start reading as regions of a flat diagram. Two layers:
         a tight one for the contact edge and a wide soft one for the lift.
         Static, so it is rastered once and never repainted — this is *not* the
         animated `box-shadow` that `motion.ts` is about, and the distinction is
         the whole of why one is free and the other cost 8% a card. */
      "--ch-shadow": "0 1px 2px rgb(90 40 65 / 0.06), 0 6px 18px -8px rgb(90 40 65 / 0.16)",
      /* The float. This is the knob that costs, and it is switched on here
         because a "cutesie happy" wall that does not move is a screenshot of
         one. 3px over 3.4 seconds is a drift you notice at the edge of vision
         rather than a bounce you watch; anything faster reads as agitation,
         which is the opposite of what this skin is for. `spare` steps it and
         `still` stops it — see `Card.svelte`. */
      "--ch-lift": "3px",
      "--ch-lift-ms": "3400ms",
      /* Arrival. Overshooting past 1 and settling back is the difference
         between a card appearing and a card *arriving*; the curve is what
         carries it, and this one goes past its target and comes back. */
      "--ch-pop": "1.05",
      "--ch-pop-ms": "320ms",
      "--ch-ease": "cubic-bezier(0.34, 1.56, 0.64, 1)",
      "--ch-glow": "44px",
    },
    builtin: true,
  },
  {
    id: "twilight",
    label: "twilight",
    note: "pastel dark — the same comfort at midnight, in violet, with candy status",
    from: null,
    over: {
      /* The argument for this one existing beside `sugar`: the complaint was
         that the wall is dark *every day*, and half of that is monotony rather
         than luminance. A wall you look at at eleven at night should not have
         to become a light one to stop being the same brown. So this keeps the
         dark — the ramp is within a tenth of the default's at every rung — and
         changes the hue underneath it and the sweets on top. */
      "--ink": "#1a1626",
      "--well": "#141120",
      "--surface": "#241f34",
      "--raised": "#2e2843",
      "--edge": "#3b3453",
      "--rule": "#4c4468",
      /* 15.2 / 8.9 / 5.3 / 3.0 — the default ladder, a shade more generous at
         the bottom because violet at low lightness closes up faster than the
         warm brown it replaces. */
      "--paper": "#ece6f7",
      "--paper-dim": "#b8afcd",
      "--paper-mute": "#8e85a5",
      "--paper-faint": "#645c7a",
      /* Brighter and more saturated than the default's, which a violet ground
         can carry and a warm one cannot: 12.0 / 12.1 / 8.6 against this well.
         The families are unchanged — mint is still green, buttercup is still
         amber, and the rose is the red end. */
      "--st-work": "#8fe0c0",
      "--st-ask": "#ffc861",
      "--st-soft": "#b08f4e",
      "--st-rest": "#7b7391",
      "--st-fail": "#ff8fa8",
      /* The display face only, and the restraint is the point. `sugar` goes
         humanist throughout because it is trying to be a different room; this
         is trying to be the *same* room after dark, so the reading stays the
         serif it always was and only the card titles soften. One face changed
         is a mood; three is a different application. */
      "--display": '"Candara", "Segoe UI Variable Display", Corbel, system-ui, sans-serif',
      "--ch-radius": "9px",
      /* Violet-black rather than neutral. A shadow on a dark wall is nearly
         invisible and this one is doing something else: it seats the card in
         the ground so the ground reads as having depth, which is what makes a
         violet wall look lit rather than merely tinted. */
      "--ch-shadow": "0 2px 14px -6px rgb(8 4 20 / 0.55)",
      "--ch-lift": "2px",
      "--ch-lift-ms": "4600ms",
      "--ch-pop": "1.04",
      "--ch-pop-ms": "300ms",
      "--ch-ease": "cubic-bezier(0.34, 1.4, 0.64, 1)",
      /* A wider, softer bloom than the default's 34px. On a violet ground the
         mint reads as light in a room rather than as an outline, which is the
         whole conceit of the status glow and is easier to see here than
         anywhere else. */
      "--ch-glow": "50px",
    },
    builtin: true,
  },
  {
    id: "meadow",
    label: "meadow",
    note: "soft daylight — cream and sage, bright without the sugar",
    from: null,
    over: {
      /* The third feel, and the one that is not cute. `sugar` is a mood you
         choose; this is one you could leave on. Same inversion, none of the
         character knobs turned up — corners a shade rounder than the default
         and nothing moving, because the argument for this skin is calm and a
         floating card is not that. It exists to prove the axis carries a
         *quiet* answer as well as a loud one. */
      "--ink": "#eeece2",
      "--well": "#faf8f1",
      "--surface": "#fffdf7",
      "--raised": "#f4f1e7",
      "--edge": "#ddd9cb",
      "--rule": "#c6c1b0",
      /* 14.1 / 8.0 / 4.6 / 2.6 — the default ladder again, on cream. */
      "--paper": "#262820",
      "--paper-dim": "#4b4e43",
      "--paper-mute": "#6f7266",
      "--paper-faint": "#9a9d90",
      /* work 3.9:1, ask 3.5:1, fail 5.8:1. The fail is deliberately the
         strongest of the three here: on a bright, low-contrast, restful ground
         the one thing that must still interrupt you is a card that broke. It
         was #b8523c in the first draft and sat 0.098 from ask in Oklab — two
         browns on cream, which is precisely the confusion the distance floor
         exists to catch, and it caught it. */
      "--st-work": "#3d8a6b",
      "--st-ask": "#b8761c",
      "--st-soft": "#96793f",
      "--st-rest": "#8b8d82",
      "--st-fail": "#a8402c",
      /* Constantia rather than Sitka, and it is the one change here that is
         not the ground. Both are screen serifs and they disagree about what a
         screen serif is for: Sitka was drawn for legibility at small sizes and
         is fairly neutral about it, Constantia has more colour on the page —
         a larger x-height, more open counters, and a slight calligraphic
         slope to the terminals. On a cream ground at reading length that is
         the difference between a document and a book, which is what this skin
         is for. `--util` stays Corbel: labels want to stay out of the way. */
      "--display": '"Constantia", "Sitka Display", Georgia, serif',
      "--body": '"Constantia", "Sitka Text", Georgia, serif',
      "--ch-radius": "6px",
      /* Sage-tinted and shallower than `sugar`'s. Cards on this wall should
         look set down on paper rather than floating above it — the skin's
         whole argument is calm, and a deep shadow is a card demanding to be
         noticed. */
      "--ch-shadow": "0 1px 2px rgb(45 50 35 / 0.05), 0 4px 12px -6px rgb(45 50 35 / 0.13)",
    },
    builtin: true,
  },
];

/* ── the ring itself ───────────────────────────────────────────────────────
 *
 * `catalogue.ts` with this ring's knobs and built-ins bound in. `skeinSkins`
 * is the wrapper an export writes, and it is what stops a reading theme pasted
 * in here — or a skin pasted into the other ring — arriving as an entry whose
 * every knob was filtered out: selectable, present in the list, and changing
 * nothing, with no way to tell from the panel why. */

const CAT = makeCatalogue<SkinKnob>({
  knobs: SKIN_KNOBS,
  builtins: SKINS,
  rest: STUDIO,
  exportKey: "skeinSkins",
});

export const SKIN_IDS = CAT.builtinIds;

export const isSkinKnob = CAT.isKnob;
export const cleanSkinOverrides = CAT.cleanOverrides;
export const cleanSkin = CAT.cleanEntry;
export const cleanSkins = CAT.cleanEntries;
export const freeSkinId = CAT.freeId;
export const allSkins = CAT.all;
export const findSkin = CAT.find;
export const skinFor = CAT.idFor;
export const skinAt = CAT.at;
export const skinChainOf = CAT.chainOf;
export const resolveSkin = CAT.resolve;
export const deriveSkin = CAT.derive;
export const withSkinKnob = CAT.withKnob;
export const nextSkin = CAT.next;
export const skinDependents = CAT.dependents;
export const exportSkins = CAT.exportText;
export const importSkins = CAT.importText;
export const mergeSkins = CAT.merge;

/* ── the arithmetic the status invariant is checked with ───────────────────
 *
 * Here rather than in the test file because it is a property of the catalogue
 * — the thing a skin has to satisfy — and because a person authoring a skin in
 * the panel should eventually be able to see the same numbers the suite does.
 * Small, exact, and dependency-free.
 *
 * Every one of these takes a six-digit hex, which is what the built-ins are
 * written in and what a colour input produces. A skin knob given `var(…)` or a
 * `color-mix(…)` is perfectly legal and simply cannot be checked from here —
 * `parseHex` returns null and the test skips it rather than failing, since
 * refusing an expression the browser understands would be the wrong trade. */

export function parseHex(v: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** WCAG relative luminance. */
export function luminance(hex: string): number | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map(toLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1–21, or null if either colour is not a literal. */
export function contrast(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Oklab, for the one question hue and contrast together cannot answer: are
 *  these two colours *distinguishable*. Amber and rust are 20° apart in the
 *  default ink and nobody confuses them, so the separation floor has to be
 *  perceptual rather than angular. */
export function oklab(hex: string): [number, number, number] | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [R, G, B] = rgb.map(toLinear);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Perceptual distance between two colours, or null if either is not literal. */
export function apart(a: string, b: string): number | null {
  const x = oklab(a);
  const y = oklab(b);
  if (!x || !y) return null;
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** Hue in degrees and saturation 0–1, HSL-style. Hue is meaningless at low
 *  saturation, which is why `--st-rest` is checked on saturation instead. */
export function hueSat(hex: string): { hue: number; sat: number } | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { hue: 0, sat: 0 };
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { hue: h, sat: d / (1 - Math.abs(2 * l - 1)) };
}

/** Whether a hue sits inside a family, wrapping at 360 — which the red family
 *  does, and getting that wrong is how `#ff8fa8` at 347° reads as "not red". */
export function inFamily(hue: number, from: number, to: number): boolean {
  return from <= to ? hue >= from && hue <= to : hue >= from || hue <= to;
}

/** The hue families a status colour must stay inside, as the test reads them.
 *
 *  Wide on purpose. These are not a style guide — they are the boundary past
 *  which a colour stops meaning what everyone on this wall has learned it
 *  means, and inside them a skin may do as it likes. */
export const FAMILIES: Record<string, { from: number; to: number; what: string }> = {
  "--st-work": { from: 120, to: 200, what: "green through cyan" },
  "--st-ask": { from: 20, to: 65, what: "amber" },
  "--st-soft": { from: 20, to: 65, what: "amber" },
  "--st-fail": { from: 335, to: 30, what: "red through rust" },
};

/** The floors, all of them observed rather than invented: each is set just
 *  below the tightest value the four built-in skins actually reach, so a skin
 *  that is materially worse than the ones that ship fails and one that is
 *  merely different does not.
 *
 *    contrast   tightest shipped 2.6  (meadow's faint-adjacent rest)
 *    apart      tightest shipped 0.13 (sugar's ask/fail)
 *    rest sat   loosest  shipped 0.12 (twilight)
 */
export const FLOORS = {
  /** A status colour is a mark rather than a glyph, so 3:1 is the standard to
   *  reach for and 2.5 is where it stops being a mark at all. */
  contrast: 2.5,
  /** Oklab, between work / ask / fail pairwise. */
  apart: 0.11,
  /** `--st-rest` means "no colour"; above this it starts to mean something. */
  restSat: 0.25,
  /** `--st-soft` is amber held back, so it must stay *near* ask. */
  softNear: 0.28,
} as const;
