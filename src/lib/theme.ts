/* The wall's ink, as a set of overrides rather than as a second stylesheet.
 *
 * `tokens.css` stays the ground truth and is not touched by any of this: a
 * theme is a *diff* against it, applied to `document.documentElement` as CSS
 * custom properties and taken off again by removing them. That shape is chosen
 * for one property above all the others — **reverting has to be exact**. A
 * theme that swapped one stylesheet for another could only promise to look
 * like the original; one that removes the properties it set leaves the cascade
 * resolving against `tokens.css` and nothing else, which is the same thing the
 * app draws with no theme code in it at all. Hence `REST`, whose override map
 * is deliberately empty and whose whole job is to be a name for "as it always
 * was" — a default you can choose, rather than the absence of a choice.
 *
 * It is not a palette switcher and must not become one. Skein is a single warm
 * ink studio wall on purpose, and colour on it means status; a theme here
 * changes how the *reading* is set — its ink, its size, its air, its rag — and
 * every knob below exists because it was a hard-coded number somewhere that
 * turned out to be worth arguing about. `KNOBS` is closed and no `--st-*` is
 * in it, so a theme cannot say that a failed card is a different kind of
 * failed depending on how somebody likes to read.
 *
 * There is a second ring beside this one — `palette.ts`, the *skin*, which
 * owns the ground, the paper ramp, the status colours, the faces and how much
 * the wall moves. That is where colour went, and it is a separate axis rather
 * than more knobs here for two reasons. The rings are composable: `column`'s
 * ruled-off rounds and `sugar`'s pink are one choice each rather than a theme
 * per combination. And the paragraph above stays *true of this file* — the
 * reading is set here, and nothing on this ring can make a failed card a
 * different kind of failed. The two knob sets are disjoint, so neither `paint`
 * can disturb the other.
 *
 * Everything below the catalogue itself — normalizing a store, walking a
 * `from` chain, deriving, cycling, import and export — is `catalogue.ts`,
 * parameterised by the knob list, and re-exported here under the names it has
 * always had. What stays in this file is what is genuinely about *this* ring.
 *
 * Pure, and tested in `test/theme.test.ts`. The applying half — the DOM write
 * and the storage — is `theme.svelte.ts`.
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

/** Every property a theme is allowed to set.
 *
 *  A closed list, and `resolve` filters against it, for the reason the rest of
 *  the front end normalizes anything opaque it reads back: this is data that
 *  outlives the build that wrote it, and once custom themes exist it is data a
 *  person typed. A name from an older version, a knob since renamed, a
 *  typo — all of them arrive as a string that is nobody's property, and the
 *  answer is to drop it rather than to write it onto the root element where it
 *  will sit forever doing nothing and confusing the next person to read the
 *  computed style.
 *
 *  Each has a default in `tokens.css` that is exactly what the panel drew
 *  before any of this existed, so `REST` is a no-op by construction. */
export const KNOBS = [
  /* ink */
  "--tx-prose",
  "--tx-you",
  "--paper-note",
  /* type */
  "--tx-size",
  "--tx-leading",
  "--tx-code",
  /* air and rag */
  "--tx-round",
  "--tx-round-rule",
  "--tx-wrap",
  "--tx-head-wrap",
  "--tx-hyphens",
] as const;

export type Knob = (typeof KNOBS)[number];
export type Overrides = Partial<Record<Knob, string>>;

/** What each knob is called where somebody is turning it, and what it takes.
 *
 *  Here rather than in the editor component for the reason the rest of this
 *  file is here: it is a property of the catalogue, it is the thing that goes
 *  stale when a knob is added, and a test can hold it to that. `KNOB_GROUPS`
 *  below asserts every knob is spoken for, so adding one to `KNOBS` and
 *  forgetting to describe it is a red suite rather than a blank row.
 *
 *  `takes` is a placeholder and a hint, not a validator — `okValue` is the only
 *  gate, and it is deliberately about size and control characters rather than
 *  about CSS grammar. A knob given nonsense costs that one declaration, which
 *  is a cheaper failure than an editor that refuses a value the browser would
 *  have understood. */
export const KNOB_INFO: Record<Knob, { label: string; takes: string; note: string }> = {
  "--tx-prose": {
    label: "the agent's prose",
    takes: "var(--paper-dim)",
    note: "what an answer is set in — the long-form reading",
  },
  "--tx-you": {
    label: "your prompts",
    takes: "var(--paper)",
    note: "your half of the column, against its left rule",
  },
  "--paper-note": {
    label: "notes",
    takes: "var(--paper-faint)",
    note: "the seam, the meta line, the meta-bar, a fence's tag and copy",
  },
  "--tx-size": {
    label: "size",
    takes: "0.86rem",
    note: "what the wall is set in; ctrl+wheel is the other one",
  },
  "--tx-leading": {
    label: "leading",
    takes: "1.55",
    note: "light on dark blooms, so it wants a little more than paper does",
  },
  "--tx-code": {
    label: "fence size",
    takes: "0.78em",
    note: "relative to the line; 0.86em is level with inline code",
  },
  "--tx-round": {
    label: "air above a prompt",
    takes: "0rem",
    note: "what marks where one round ends and the next begins",
  },
  "--tx-round-rule": {
    label: "rule above a prompt",
    takes: "transparent",
    note: "the stronger version of the same; var(--edge) to turn it on",
  },
  "--tx-wrap": {
    label: "rag",
    takes: "wrap",
    note: "pretty to kill the one-word last lines",
  },
  "--tx-head-wrap": {
    label: "heading rag",
    takes: "wrap",
    note: "balance, so a two-line heading stops breaking 90/10",
  },
  "--tx-hyphens": {
    label: "hyphenation",
    takes: "manual",
    note: "auto calms the rag and reads as print; people feel it either way",
  },
};

/** The knobs in the order an editor should show them, under the headings the
 *  rest of this file already argues in. */
export const KNOB_GROUPS: { title: string; knobs: Knob[] }[] = [
  { title: "ink", knobs: ["--tx-prose", "--tx-you", "--paper-note"] },
  { title: "type", knobs: ["--tx-size", "--tx-leading", "--tx-code"] },
  {
    title: "air and rag",
    knobs: ["--tx-round", "--tx-round-rule", "--tx-wrap", "--tx-head-wrap", "--tx-hyphens"],
  },
];

/** One theme on this ring. The shape is `catalogue.ts`'s, with this ring's
 *  knobs bound into it — see there for what each field is for. */
export type Theme = Entry<Knob>;

/** The theme that changes nothing. Its emptiness is load-bearing: see the head
 *  of this file. */
export const REST = "paper";

/* The contrast figures quoted below are computed from `tokens.css` against
   `--well` (#0f0d0c), which is what the panel is drawn on:

     --paper       #ede4d8   15.4:1
     --paper-dim   #b4a89c    8.3:1
     --paper-mute  #8a7e74    4.9:1
     --paper-faint #615850    2.8:1

   The first three are a clean ramp. The fourth is not a text colour — it is
   below AA at any size — and `tokens.css` was using it for the seam label at
   10.2px, the meta-bar at 10.9px and the meta line at 12.2px. `--paper-note`
   is the knob that lets that be argued about without disturbing the ninety-odd
   places where `--paper-faint` is correctly drawing a mark or a rule. */

export const BUILTINS: Theme[] = [
  {
    id: REST,
    label: "paper",
    note: "as it always was",
    from: null,
    /* Empty on purpose, and it is the whole revert guarantee — see the head of
       this file. Anything added here stops this being a name for the untouched
       app, at which point there is no way back to it. */
    over: {},
    builtin: true,
  },
  {
    id: "readable",
    label: "readable",
    note: "notes lifted to a text contrast, a larger fence, air above a prompt",
    from: null,
    over: {
      /* 2.8:1 → 4.9:1 for the four small things that were text rather than
         marks. `--paper-faint` itself is untouched, so every dash, marker and
         hairline on the wall stays exactly where it was. */
      "--paper-note": "var(--paper-mute)",
      /* The fence was 0.78em of a 13.8px line — 10.7px, smaller than the tool
         lines above it and the smallest thing in the panel bar the seam. A
         fence is the densest and most literal thing in an answer and was set
         the smallest. 0.86em puts it level with inline code, which was already
         at 0.86em and disagreeing with it by a pixel. */
      "--tx-code": "0.86em",
      /* Light on dark blooms — the glyphs optically thicken and the counters
         close up — so a serif that wants 1.55 on paper wants a little more
         here. */
      "--tx-leading": "1.62",
      /* The structural one. Two paragraphs inside one answer sat 7.6px apart
         (0.55em margins, collapsed); a prompt and the answer to it sat 9.6px
         apart (`.lines`' gap). A 2px difference between "next paragraph" and
         "a whole new thing was said" is proximity saying nothing at all, and
         it is why finding where a round starts wanted the rail. The left rule
         on a prompt was already the landmark; this is the room it needs to act
         as one. */
      "--tx-round": "0.6rem",
      /* Orphans are constant at this measure — around 53 characters at the
         default panel width. Chromium only reflows the last few lines for
         `pretty`, so it is cheap, and it is the one wrap change with no
         aesthetic cost. `balance` on headings for the same reason: a two-line
         heading in this column breaks 90/10 without it. */
      "--tx-wrap": "pretty",
      "--tx-head-wrap": "balance",
    },
    builtin: true,
  },
  {
    id: "prose",
    label: "prose",
    note: "readable, and the answer is the loudest thing on the page",
    /* The first demonstration of the feature, and the reason it is worth
       having: this used to repeat every one of `readable`'s six knobs, with a
       test asserting the two stayed in step by hand. Now it says what it
       actually is — `readable`, plus two decisions — and the duplication and
       the test that policed it are both gone. */
    from: "readable",
    over: {
      /* The inversion. Your prompt was `--paper` at 15.4:1 and the agent's
         prose — the thing you are here to read, at length — was `--paper-dim`
         at 8.3:1, so the brightest thing on the page was the half you wrote
         and already know. The prompt is over-marked as it is: a 2px rule, its
         own margin, and a rail devoted to listing it. This lets the rule do
         the landmarking alone and gives the reading the top of the ramp.
         Neither is a defect — 8.3:1 is fine by any standard — which is
         precisely why it is a theme and not a fix. */
      "--tx-prose": "var(--paper)",
      "--tx-you": "var(--paper-dim)",
      /* At 40–53 characters the rag is real and hyphenation calms it
         measurably. It lives only here because it is the one knob that reads
         as a printed page rather than as a screen, and people feel that
         immediately and in both directions. `index.html` carries `lang="en"`,
         without which this would silently do nothing. */
      "--tx-hyphens": "auto",
    },
    builtin: true,
  },
  {
    id: "temper",
    label: "temper",
    note: "prose, held a step back so bold is still bold",
    /* `prose` answers "the answer is muted" by giving the reading the top of
       the ramp. That works, and it costs something the complaint did not ask
       to spend: `strong`, `.h` and `.link` are all `--paper` too, so prose at
       `--paper` is prose at exactly the brightness of every emphasis inside
       it. Bold is then carried by weight and face alone — 600, and the display
       serif for a heading — with no brightness step at all. In an answer
       written as run-in bold labels, which is how an agent writes most of
       them, that flattens the thing the labels are for.

       Measured against `--well`, and the second column is the one this theme
       exists for — how much brighter bold still is than the prose around it:

         --paper-dim   8.3:1   1.85   (paper, readable — muted, but bold reads)
         40% toward   10.8:1   1.42
         60% toward   12.2:1   1.26   (here)
         --paper      15.4:1   1.00   (prose, column — no step at all)

       So this is the ramp lifted clear of muted while leaving emphasis a
       step to stand on. It is one knob different from `prose` on purpose —
       nothing else moves, so switching between the two answers exactly one
       question — and it sits beside `prose` in the ring for the same reason,
       since the ring order is the order you compare in.

       `color-mix` rather than a literal, because the number is not a colour
       somebody picked: it is a position on the ramp `tokens.css` already
       declares. A literal would sit slightly off that ramp and would stay
       where it was if the two ends were ever retuned. */
    from: "prose",
    over: {
      "--tx-prose": "color-mix(in srgb, var(--paper) 60%, var(--paper-dim))",
    },
    builtin: true,
  },
  {
    id: "column",
    label: "column",
    note: "prose, and every round is ruled off rather than only spaced",
    /* The one issue the other two only half-answer, taken at its stronger
       setting. `readable` gives a prompt real air above it and argues — rightly
       — that the left rule was always the landmark and only wanted room to act
       as one. That is true while you are reading forwards. It stops being true
       when you are *hunting*: scrolling back through a long card for the round
       where something was decided, whitespace is a difference you have to
       measure against the paragraph spacing beside it, and a rule is one you
       see without reading. The rails answer the same question and want a hand
       on the mouse, which is exactly what you do not have while scrolling.

       Deferred at the time — "a lot of rules down a long card, and I'd try the
       whitespace first" — and that is the right order to have tried them in
       and the reason both exist rather than one replacing the other. This is
       the version for a card with forty rounds on it. */
    from: "prose",
    over: {
      /* `--edge`, so it is the same hairline the seam and the meta-bar already
         draw. A round boundary is the same kind of event as the boundary
         between restored scrollback and the live stream — one thing ending and
         another starting — and it should not invent a second weight of rule to
         say so. Against the left rule already there it closes into a bracket
         opening the round, which is why this reads as structure rather than as
         one more horizontal line every screenful. */
      "--tx-round-rule": "var(--edge)",
      /* Nearly double `readable`'s air, and it buys two different things here.
         Half of it sits above the rule and half below (see `.line.you`), so the
         rule gets clear space on both sides instead of being crowded by the
         answer above it — an under-led rule reads as an underline belonging to
         the paragraph over it rather than as a divider between two things. */
      "--tx-round": "1.1rem",
    },
    builtin: true,
  },
];

/* ── the ring itself ───────────────────────────────────────────────────────
 *
 * Everything from here down is `catalogue.ts` with this ring's knobs and
 * built-ins bound in. The names are the ones this module has always exported,
 * so `theme.svelte.ts`, `Themes.svelte` and `test/theme.test.ts` did not move
 * when the machinery was lifted out to be shared with `palette.ts`.
 *
 * `skeinThemes` is the wrapper an export writes, and it is what stops a skin
 * pasted in here arriving as a theme whose every knob was filtered out —
 * selectable, present in the list, and changing nothing, with no way to tell
 * from the panel why. */

const CAT = makeCatalogue<Knob>({
  knobs: KNOBS,
  builtins: BUILTINS,
  rest: REST,
  exportKey: "skeinThemes",
});

export const BUILTIN_IDS = CAT.builtinIds;

export const isKnob = CAT.isKnob;
export const cleanOverrides = CAT.cleanOverrides;
export const cleanTheme = CAT.cleanEntry;
export const cleanThemes = CAT.cleanEntries;
export const freeId = CAT.freeId;
export const allThemes = CAT.all;
export const findTheme = CAT.find;
export const themeFor = CAT.idFor;
export const themeAt = CAT.at;
export const chainOf = CAT.chainOf;
export const resolve = CAT.resolve;
export const derive = CAT.derive;
export const withKnob = CAT.withKnob;
export const nextTheme = CAT.next;
export const dependents = CAT.dependents;
export const exportThemes = CAT.exportText;
export const importThemes = CAT.importText;
export const mergeThemes = CAT.merge;
