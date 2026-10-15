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
  "--hollow",
  "--raised",
  "--edge",
  "--rule",
  "--shade",
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
  "--ch-bloom",
  "--ch-wash",
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
  "--hollow": { label: "a dormant card", takes: "var(--ink)", note: "what a spent card is filled with. On a dark wall, the wall" },
  "--raised": { label: "raised", takes: "#272220", note: "a fence, a chip, a control that sits above a card" },
  "--edge": { label: "edges", takes: "#332c29", note: "the hairline round a card, a seam, the meta-bar rule" },
  "--rule": { label: "rules", takes: "#3d3532", note: "the stronger line — a prompt's left rule, a hover border" },
  "--shade": { label: "shadow", takes: "#000", note: "what every drop shadow is made of. A light ground wants its own hue at an alpha, e.g. rgb(60 40 30 / 0.2)" },
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
  "--ch-bloom": { label: "glow strength", takes: "1", note: "how much of a live card's light reaches the ground. A light skin wants about a third, since a halo on paper is a stain" },
  "--ch-wash": { label: "status tint", takes: "0%", note: "how much of its status colour a live card takes into its fill. The light ground's answer to a glow" },
  "--ch-shadow": { label: "card shadow", takes: "none", note: "a card's drop shadow. Rastered once, so it costs nothing at rest" },
};

/** The knobs in the order the editor shows them, under the headings this file
 *  already argues in. */
export const SKIN_GROUPS: { title: string; knobs: SkinKnob[] }[] = [
  {
    title: "ground",
    knobs: ["--ink", "--well", "--surface", "--hollow", "--raised", "--edge", "--rule", "--shade"],
  },
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
      "--ch-bloom",
      "--ch-wash",
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
   same arithmetic `test/palette.test.ts` runs: WCAG contrast against that
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
   drawing with.

   ## The light skins share one ladder, and it is not white

   The first light skins were a dark wall with its values flipped, and the
   person they were for said they burned and had no depth. Both were measurable.
   Their cards were `#ffffff` and their panels within a hair of it. So the
   bright thing on screen was the whole window, rather than the text and the
   status marks as on the dark wall. That is 150-250 times the light studio
   sends, all day. And their four surfaces sat inside 0.04 of each other in
   Oklab lightness, out of order: chips darker than the card under them, the
   panel lighter than the wall. Wall, panel, card and plate were one white,
   and only the hairlines drew structure.

   So the three light skins below stand on one lightness ladder, and only hue,
   chroma, faces and character tell them apart:

     wall 0.885   chip 0.912   panel 0.928   card 0.958   (Oklab L)
     edge 0.79    rule 0.735
     ink  0.30 / 0.405 / 0.475 / 0.64 ≈ 11.0 / 7.3 / 5.4 / 2.7 on the panel

   - **Nothing is white.** The wall is a dim paper, about 0.69 in luminance
     where white is 1, and the brightest thing is a card at 0.88. Paper under
     room light is far dimmer than a monitor's white, and a light skin is
     meant to read like paper.
   - **Ordered, and as spread as studio's.** About 0.07 from wall to card,
     against studio's 0.10 across the same four, and in the order a page
     needs: a card is the brightest object, the panel a reading surface a step
     down, chips and fences a step toward the wall.
   - **Depth from shadow, not from light.** On a light ground nothing glows. A
     card is raised by a shadow tinted to the ground (`--ch-shadow`), every
     other shadow is made of a ground-hued `--shade` at an alpha, and a live
     card takes a little of its status colour into its fill (`--ch-wash`) with
     its halo turned down (`--ch-bloom`). A dormant card is the wall's own
     colour with a dashed edge and no shadow. On paper, being flat on the
     surface is what "unlit" means, so `--hollow` keeps its default.
   - **Near-colourless neutrals.** Surface chroma 0.011-0.016, which is a tint
     and not a colour. At this lightness chroma shows in a way it never does
     at studio's: the first `sugar` was simply pink, and on a pink wall colour
     stops meaning status.
   - **Status deeper and more saturated, not muddier.** A pastel on paper says
     nothing, and darkening a pastel gives you brown. Each is picked in Oklch
     at a mid lightness, with as much chroma as its hue holds there. */

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
    id: "vellum",
    label: "vellum",
    note: "studio by day — warm paper, the same faces, nothing glows",
    from: null,
    over: {
      /* The studio's daylight twin, and the reference the other light skins
         are variations on. Same faces, same corners, nothing that moves: the
         only answer this skin gives is to "the same room, with the lights
         on". Hue 75 at chroma 0.011, the warm of unbleached paper, which is
         studio's bone ink turned into a ground. */
      "--ink": "#ddd8d1",
      "--well": "#ece6df",
      "--surface": "#f6f0e9",
      "--raised": "#e6e1da",
      "--edge": "#c1b9ae",
      "--rule": "#b1a89c",
      /* Ground-hued, at an alpha. Every shadow on the wall is this mixed with
         transparent at the strength its site was tuned to, so 0.24 lands the
         heaviest (90%) at about 0.22, in brown rather than black. */
      "--shade": "rgb(62 48 36 / 0.24)",
      /* 11.0 / 7.3 / 5.4 / 2.7 on the panel. The top rung is held under
         studio's 15.4: dark text on a light field at full contrast is the
         other half of what made the first light skins tiring. */
      "--paper": "#352c25",
      "--paper-dim": "#514740",
      "--paper-mute": "#655a53",
      "--paper-faint": "#958a82",
      /* work 3.6, ask 2.6, fail 4.6 on the panel, rest desaturated. Ask is the
         tightest. Amber is a light hue, and an amber dark enough to read
         higher than this on paper is brown. */
      "--st-work": "#22876b",
      "--st-ask": "#ca7f10",
      "--st-soft": "#a17740",
      "--st-rest": "#8b857f",
      "--st-fail": "#b63d29",
      "--ch-shadow": "0 1px 2px rgb(62 48 36 / 0.1), 0 6px 18px -8px rgb(62 48 36 / 0.26)",
      "--ch-bloom": "0.3",
      "--ch-wash": "7%",
    },
    builtin: true,
  },
  {
    id: "sugar",
    label: "sugar",
    note: "pastel light — blush ground, plum ink, and it is very awake",
    from: null,
    over: {
      /* Blush, on the light ladder. The first `sugar` was a near-white pink at
         chroma 0.03 on its lines and 0.031 in its ink. That made the whole
         wall the colour, and it burned. This keeps the blush in the hue and
         halves the chroma (0.016 on the surfaces), so it is a pink wall in the
         way a paper is warm. The pastel is still there, but not as the light
         source. */
      "--ink": "#e2d5da",
      "--well": "#f0e3e9",
      "--surface": "#faedf3",
      "--raised": "#ebdee3",
      "--edge": "#c8b4bd",
      "--rule": "#b8a2ac",
      "--shade": "rgb(72 40 58 / 0.24)",
      /* Plum, 11.1 / 7.3 / 5.5 / 2.8 on the panel. The ink keeps more chroma
         than the ground (0.03), since text is small enough to carry a colour
         without the page becoming it. */
      "--paper": "#382833",
      "--paper-dim": "#55434e",
      "--paper-mute": "#685662",
      "--paper-faint": "#998592",
      /* Mint, tangerine and rose, deep enough to be marks: work 3.4, ask 2.65,
         fail 4.1. Rose rather than rust, because rust goes muddy on blush and
         rose is the right amount of alarm for a wall this cheerful. It is
         still in the red family, and 0.17 from ask in Oklab. */
      "--st-work": "#238a71",
      "--st-ask": "#d07803",
      "--st-soft": "#ab7b49",
      "--st-rest": "#90868c",
      "--st-fail": "#c23d61",
      /* The face, which does more for the identity than any colour here. Sitka
         is a transitional serif with the manners of a printed page, which is
         right for the studio and wrong for this. Candara is a humanist sans
         with flared stems and rounded terminals, drawn for screens, and it
         ships with Windows. `--mono` is left alone: a fence is somebody's
         literal output and should not have a mood. */
      "--display": '"Candara", "Segoe UI Variable Display", Corbel, system-ui, sans-serif',
      "--body": '"Candara", Corbel, "Segoe UI", system-ui, sans-serif',
      "--util": '"Candara", Corbel, "Segoe UI", system-ui, sans-serif',
      "--ch-radius": "10px",
      /* Deeper than vellum's, since a cheerful wall wants its cards to sit
         up. Plum rather than black. Static, so it is rastered once: this is
         not the animated shadow `motion.ts` is about. */
      "--ch-shadow": "0 1px 2px rgb(72 40 58 / 0.1), 0 8px 20px -9px rgb(72 40 58 / 0.28)",
      "--ch-bloom": "0.3",
      "--ch-wash": "8%",
      /* The float, which costs. It is on because a "cutesie happy" wall that
         does not move is a screenshot of one. 3px over 3.4s is a drift at the
         edge of vision, not a bounce. `spare` steps it and `still` stops it
         (see `Card.svelte`). */
      "--ch-lift": "3px",
      "--ch-lift-ms": "3400ms",
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
         that the wall is dark *every day*, and half of that is monotony
         rather than luminance. A wall you look at at eleven at night should
         not have to become light to stop being the same brown. So this keeps
         studio's ladder (within a few hundredths of Oklab L at every rung)
         and changes the hue under it.

         At chroma 0.024 on the surfaces. The first draft ran 0.03-0.06, five
         to eight times studio's, and read as a purple application rather than
         the studio after dark. Chrome here is meant to be close to colourless,
         and violet at 0.024 is a tint you feel more than see. */
      "--ink": "#171521",
      "--well": "#11101c",
      "--surface": "#201f2b",
      "--raised": "#2a2835",
      "--edge": "#353248",
      "--rule": "#44415b",
      /* 15.2 / 9.1 / 5.4 / 3.0, the default ladder a shade more generous at
         the bottom, because violet at low lightness closes up faster than
         warm brown. */
      "--paper": "#e8e5f5",
      "--paper-dim": "#b5b2c1",
      "--paper-mute": "#8b8897",
      "--paper-faint": "#615e6c",
      /* Candy: brighter and more saturated than the default's, which a dark
         violet ground carries and a warm one cannot. 12.0 / 12.2 / 8.6. Mint
         is still green, buttercup still amber, and the rose is the red end. */
      "--st-work": "#85e0be",
      "--st-ask": "#fac871",
      "--st-soft": "#b4925e",
      "--st-rest": "#7a7986",
      "--st-fail": "#f493aa",
      /* The display face only. `sugar` goes humanist throughout because it is
         trying to be a different room. This is trying to be the *same* room
         after dark, so the reading stays the serif it always was. One face
         changed is a mood; three is a different application. */
      "--display": '"Candara", "Segoe UI Variable Display", Corbel, system-ui, sans-serif',
      "--ch-radius": "9px",
      /* Violet-black rather than neutral, seating the card in the ground so
         the ground reads as having depth. */
      "--ch-shadow": "0 2px 14px -6px rgb(8 4 20 / 0.55)",
      "--ch-lift": "2px",
      "--ch-lift-ms": "4600ms",
      "--ch-pop": "1.04",
      "--ch-pop-ms": "300ms",
      "--ch-ease": "cubic-bezier(0.34, 1.4, 0.64, 1)",
      /* A wider, softer bloom than the default's 34px. On a dark violet ground
         the mint reads as light in a room rather than as an outline, which is
         the whole conceit of the status glow. That is why this skin keeps
         `--ch-bloom` at 1 where the light ones turn it down. */
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
      /* The quiet one: `sugar` is a mood you choose, this is one you could
         leave on. The light ladder at hue 100 and chroma 0.013, a cream with
         sage in it, and nothing moves. */
      "--ink": "#dbd9d0",
      "--well": "#e9e8de",
      "--surface": "#f3f1e8",
      "--raised": "#e4e2d9",
      "--edge": "#bdbbac",
      "--rule": "#acaa99",
      "--shade": "rgb(46 52 36 / 0.24)",
      /* 11.0 / 7.3 / 5.4 / 2.7 on the panel, in a green-grey ink. */
      "--paper": "#2d2f27",
      "--paper-dim": "#484a42",
      "--paper-mute": "#5b5d55",
      "--paper-faint": "#8b8e84",
      /* work 3.8, ask 2.7, fail 5.3. The fail is deliberately the strongest
         of the three here: on a restful, low-contrast ground the one thing
         that must still interrupt you is a card that broke. The first draft's
         fail sat 0.098 from its ask in Oklab, two browns on cream. This one is
         0.18 away. */
      "--st-work": "#31835d",
      "--st-ask": "#c47d04",
      "--st-soft": "#9c7a42",
      "--st-rest": "#86877f",
      "--st-fail": "#a8372a",
      /* Constantia rather than Sitka. Both are screen serifs, and Constantia
         has more colour on the page: open counters and a slight calligraphic
         slope. On cream at reading length that is the difference between a
         document and a book. `--util` stays Corbel: labels stay out of the
         way. */
      "--display": '"Constantia", "Sitka Display", Georgia, serif',
      "--body": '"Constantia", "Sitka Text", Georgia, serif',
      "--ch-radius": "6px",
      /* Shallower than sugar's. Cards here should look set down on paper,
         not floating above it. */
      "--ch-shadow": "0 1px 2px rgb(46 52 36 / 0.09), 0 5px 14px -7px rgb(46 52 36 / 0.22)",
      "--ch-bloom": "0.3",
      "--ch-wash": "7%",
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
 *  below the tightest value the built-in skins actually reach, so a skin
 *  that is materially worse than the ones that ship fails and one that is
 *  merely different does not.
 *
 *    contrast   tightest shipped 2.59 (vellum's ask: amber dark enough for
 *                                      more on paper is brown)
 *    apart      tightest shipped 0.16 (vellum's ask/fail)
 *    rest sat   loosest  shipped 0.10 (studio)
 *
 *  These are about status. What the ground itself owes (order, spread, no
 *  glare, neutral neutrals) is asserted in `test/palette.test.ts` under "is
 *  a place", with its numbers taken from studio. */
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
  /** How visible a dormant card has to be against the wall it sits on —
   *  whichever of its outline or its fill carries it.
   *
   *  1.30, and the number comes from the dark wall rather than from the light
   *  ones: `studio`'s dashed `--edge` reads at 1.36 and that is the case known
   *  to work. The light skins first shipped at 1.18 and 1.19 and their dormant
   *  cards were **invisible** — the fill is the wall by default, there is no
   *  shadow, and the outline was all there was. Setting a floor from the cases
   *  in front of you rather than from the one that works is how that got
   *  through the first time. */
  dormant: 1.3,
} as const;
