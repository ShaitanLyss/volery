/* Instruments you hang on the wall.
 *
 * A widget is furniture in the room rather than part of the work: it belongs to
 * no project, never enters the auto-layout, and is always placed by hand — the
 * same bargain a reference image has, and for the same reason. What makes it a
 * different thing is that Skein *draws* it: a clock is not a picture of a clock,
 * and the performance meter is reading this machine as you watch.
 *
 * Pure — no runes, no DOM — so the catalogue, the defaults and the validation
 * can be tested directly. `widgets.svelte.ts` owns the wall's copies and
 * `WidgetNode.svelte` draws them.
 *
 * The catalogue is the whole vocabulary. A new knob is one line here, a new
 * variant is one entry in a `choice`, and a new kind of widget is one spec plus
 * one arm in `WidgetNode`'s switch — nothing in Rust ever hears about it, which
 * is what the opaque `config_json` column buys (see `store.rs::migrate_v5`). */

import {
  DEFAULT_LENGTH,
  LENGTHS,
  lengthOf,
  type Duo,
  type Run,
} from "./timing";
import { spotOf } from "./glass";
/* Same bargain as `timing`: the arithmetic stays import-free and this file is
   the bridge between a flat config and the shapes it reads. */
import { paceOf, type Pace } from "./clock";
/* The one literal every log widget's subject knob has, taken from the file that
   resolves it rather than written out three times — a default spelled
   differently in two places is a widget that comes back off disk following
   nothing. */
import { FOLLOW } from "./logface";

export type WidgetKind =
  | "clock"
  | "performance"
  | "timer"
  | "pomodoro"
  | "spotify"
  | "usage"
  | "burn"
  | "status"
  | "pipelines"
  | "reviews"
  | "asana"
  | "asanatasks"
  | "asanahealth"
  | "billboard"
  | "sink"
  | "gates"
  | "serverlog"
  | "buildlog"
  | "applog"
  | "unreallog"
  | "browser";

export type Choice = { value: string; label: string };

/** A knob that only means something when another one is set a certain way.
 *
 * A stopwatch has no length to count down from, and a menu offering one would be
 * a knob that does nothing — which is worse than a missing knob, because it
 * reads as broken rather than as absent. Declarative rather than a predicate so
 * the catalogue stays data: `only` is checked against the config, never called.
 * The value is still *stored* while hidden, so flipping a timer to counting down
 * and back does not lose the length you had chosen. */
export type Guard = { key: string; is: string[] };

/** Where a choice's options come from when this file cannot know them.
 *
 * The accounts a wall spends are whatever you registered, so they cannot be a
 * literal list here — and a function would make the catalogue code. Naming a
 * *source* keeps it data, which is the same bargain `only` strikes by being a
 * declaration rather than a predicate. The caller resolves the name; nothing
 * here ever calls anything.
 *
 * A knob with a source is not clamped to its literal `options` on the way back
 * in (`normalizeParam`), because the valid set is not knowable at this layer —
 * an account registered after the widget was placed would otherwise be read
 * back as the default, silently, on the next launch. */
export type Source =
  | "accounts"
  | "groups"
  | "projects"
  | "editors"
  | "boards"
  | "pages";

/** A group of widgets the right-click menu offers behind one row.
 *
 * **These are not new groups.** The catalogue has described itself in exactly
 * these terms since the note above `spotify` was written: "the things you hang
 * up because of how the afternoon feels, then the meters, then the services,
 * then the agents' own notes, then the logs… a record player belongs with the
 * first group and nowhere near the second." That was an *order*, and an order is
 * a grouping you can only see by reading the whole list.
 *
 * Nineteen widgets made the list long; a browser widget and an Asana board
 * landing on the same afternoon made it a scroll, and three more Asana readings
 * would have taken it past twenty. So the families are a field now instead of a
 * sequence, and the menu is eight rows.
 *
 * A family still has to be a **subject** rather than a bin: four logs are four
 * views of one substrate, the billboard and the sink are both what the agents
 * wrote down, and what Claude costs and whether Claude is up are two questions
 * about the same service. The two things left standing alone are standing alone
 * on purpose — the performance meter is the only reading of *this machine*, and
 * the browser is the only thing on the wall you work *in*. */
export type WidgetFamily = "room" | "claude" | "forge" | "asana" | "notes" | "logs";

/** What each family's row says.
 *
 *  The order here is irrelevant: a family appears where its first member sits in
 *  `WIDGETS`, so the editorial sequence still decides what comes first.
 *
 *  The label is a whole action rather than a noun ("hang up a log", not "logs")
 *  because it stands among `open a folder…` and `pin up an image…`, where a
 *  bare noun reads as a thing to look at rather than a thing to do. The
 *  submenu's rows are then as bare as they can be — the verb has been said
 *  once, so saying it four more times is four rows of noise. */
export const FAMILIES: { id: WidgetFamily; label: string }[] = [
  /* The catalogue's own first group, in the catalogue's own words. */
  { id: "room", label: "hang up something for the room" },
  /* What the service costs and whether it is answering. Two questions, one
     subject — and the subject is the thing this whole app is a face for. */
  { id: "claude", label: "hang up a claude reading" },
  { id: "forge", label: "hang up a forge widget" },
  { id: "asana", label: "hang up an asana widget" },
  /* "the agents' own notes" is the phrase the catalogue already used for these,
     so it is the phrase the row uses. */
  { id: "notes", label: "hang up the agents' own notes" },
  { id: "logs", label: "hang up a log" },
];

/** What one knob is. Deliberately three shapes rather than a number and a
 *  convention: a variant is a name, not a slider position, and reading `2` back
 *  as "artistic" would be a wall that changed meaning when the list was
 *  reordered. */
export type WidgetParam =
  | {
      key: string;
      kind: "choice";
      label: string;
      options: Choice[];
      def: string;
      only?: Guard;
      /** Options this list cannot hold — see `Source`. Appended to `options`
       *  rather than replacing them, so a knob keeps its literal entries (like
       *  "every account") alongside whatever is resolved. */
      from?: Source;
    }
  | { key: string; kind: "toggle"; label: string; def: boolean; only?: Guard }
  | {
      key: string;
      kind: "number";
      label: string;
      min: number;
      max: number;
      step: number;
      def: number;
      only?: Guard;
    };

/** A key a widget writes as it runs, rather than one anybody turns.
 *
 * A timer's state is two numbers — the epoch its run began and the seconds it
 * has banked — and they belong in the config for the reason everything else
 * does: `config_json` is one opaque column, so persisting a running timer costs
 * no migration and no new command. What they must *not* do is turn up in the
 * right-click menu, or be clamped to a spec's range on the way back in. Hence a
 * second list: `params` is the vocabulary of the menu, `state` is the vocabulary
 * of the instrument. */
export type WidgetState = { key: string; def: number };

export type WidgetSpec = {
  kind: WidgetKind;
  label: string;
  /** One sentence, lowercase, for the menu that offers it. */
  note: string;
  /** How big it arrives, in canvas units. */
  box: { w: number; h: number };
  /** How small it may be dragged before it stops saying anything. */
  min: { w: number; h: number };
  params: WidgetParam[];
  state?: WidgetState[];
  /** Which family's row this hides behind in the menu, if any. */
  family?: WidgetFamily;
  /** What it is called *inside* that family, where the family's row has already
   *  named the subject. "server log" under "hang up a log" says the word twice;
   *  "servers" says the part that distinguishes it. Absent means `label`. */
  short?: string;
  /** The whole menu row, for a label the "hang up a …" template cannot carry.
   *
   *  Most labels are countable nouns and the template reads correctly over
   *  them. A few are not — "performance" is a quantity, "gates" is a plural,
   *  "spotify" is a company — and "hang up a gates" is the kind of sentence
   *  that makes a careful app look careless. Overriding the row is cheaper than
   *  renaming the widget, since `label` is what the thing is called everywhere
   *  else. */
  offer?: string;
};

export type WidgetConfig = Record<string, string | number | boolean>;

export type Widget = {
  id: string;
  kind: WidgetKind;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  /** Where it is drawn if it has been stuck to the glass, in screen pixels, or
   *  null for one standing on the wall. Never a substitute for `x`/`y` — see
   *  the note at the top of `glass.ts`. */
  glassX: number | null;
  glassY: number | null;
  config: WidgetConfig;
};

const choice = (
  key: string,
  label: string,
  options: Choice[],
  def: string,
  only?: Guard,
  from?: Source,
): WidgetParam => ({
  key,
  kind: "choice",
  label,
  options,
  def,
  ...(only ? { only } : {}),
  ...(from ? { from } : {}),
});

const toggle = (key: string, label: string, def: boolean): WidgetParam => ({
  key,
  kind: "toggle",
  label,
  def,
});

/** The two numbers every running instrument keeps. Shared, so a timer and a
 *  duo's first lane are the same pair of keys and `runIn` reads either. */
const RUN: WidgetState[] = [
  { key: "since", def: 0 },
  { key: "banked", def: 0 },
];

/* A `number` param is part of the vocabulary — `normalizeParam` clamps one to
   its own range — but nothing in the catalogue uses one yet: the two knobs that
   wanted to be numbers were both better answered by the size of the box. */

/** The variant is the first parameter of every widget by convention: it is the
 *  one knob that changes what you are looking at rather than how much of it. */
export const VARIANT = "variant";

/** How much of a frame a widget wears. */
export const FRAME = "frame";

/** Whether a clock is telling the time or is off somewhere of its own. */
export const PACE = "pace";

/** The knobs every widget has, whatever it draws.
 *
 * Kept out of the specs and appended by `paramsOf`, so a new kind of instrument
 * gets them by existing rather than by remembering — the same argument
 * `widgetOffers` makes for the menu that hangs one up. Five copies of the same
 * three lines is five places for the wording to drift.
 *
 * The frame is a `choice` rather than two toggles because the fourth state the
 * pair would allow is the one nobody wants: an outline with nothing behind it is
 * a hole cut in the wall, not an instrument. So the three values are an ordered
 * retreat — outline and fill, fill alone, then neither — and each step takes one
 * layer off.
 *
 * `bare` is the deliberate exception to "nothing on the wall may be
 * transparent" (see the ambience note in CLAUDE.md). That rule exists because a
 * leaf drifting through a dormant card reads as broken; a clock you have
 * *asked* to sit in the weather is the opposite — it is the reading you chose,
 * and the wall behind it is what makes it furniture rather than a panel. The
 * default is unchanged, so nothing already on a wall moves. */
export const COMMON: WidgetParam[] = [
  choice(
    FRAME,
    "frame",
    [
      { value: "framed", label: "an outline and a fill" },
      { value: "plate", label: "a fill, no outline" },
      { value: "bare", label: "neither — the wall shows through" },
    ],
    "framed",
  ),
];

export const WIDGETS: WidgetSpec[] = [
  {
    kind: "clock",
    label: "clock",
    family: "room",
    short: "a clock",
    note: "the time, in whichever hand suits the wall",
    box: { w: 190, h: 190 },
    min: { w: 76, h: 56 },
    params: [
      choice(
        VARIANT,
        "face",
        [
          { value: "analog", label: "analog" },
          { value: "digital", label: "digital" },
          { value: "words", label: "words" },
          { value: "artistic", label: "artistic" },
          { value: "abstract", label: "abstract" },
        ],
        "analog",
      ),
      /* Whether it is telling the time at all.
       *
       * A knob rather than a sixth face, because hurtling through the afternoon
       * is something all five of these can do and a variant would have made it
       * a face you gave up another face to have. The faces know nothing about
       * it — `madAt` lies about the instant and every one of them draws that
       * instant as it always did. See `clock.ts`.
       *
       * The rate is not a knob and will not become one: no numbers among these
       * (a menu is a poor slider), and the three that are here are three
       * readings rather than three speeds. */
      choice(
        PACE,
        "pace",
        [
          { value: "real", label: "the actual time" },
          { value: "racing", label: "hurtling forward" },
          { value: "unwinding", label: "running backwards" },
          { value: "deranged", label: "off its hinges" },
        ],
        "real",
      ),
      toggle("seconds", "seconds", true),
      /* 24-hour by default: this is a studio wall next to a terminal, and every
         timestamp anywhere near it is already 24-hour. */
      toggle("h24", "24-hour", true),
      toggle("date", "the date", false),
    ],
  },
  {
    kind: "performance",
    label: "performance",
    offer: "hang up the performance meter",
    note: "what this studio's own processes are costing",
    box: { w: 300, h: 210 },
    min: { w: 176, h: 96 },
    params: [
      choice(
        VARIANT,
        "reading",
        [
          { value: "list", label: "list" },
          { value: "bars", label: "bars" },
          { value: "gauges", label: "gauges" },
        ],
        "list",
      ),
      /* Skein's own tree first, because that is the question this wall raises —
         "what is all of this costing me" — and the machine's full process list
         is a click away for when it isn't. */
      choice(
        "scope",
        "scope",
        [
          { value: "skein", label: "this studio" },
          { value: "machine", label: "the whole machine" },
        ],
        "skein",
      ),
    ],
  },
  {
    /* Counting up, counting down, or two lanes of which one runs. Those are the
       variant rather than the face, because they are what you are looking at:
       a stopwatch and a countdown answer different questions with the same
       digits, and the reference implementation kept them as separate pages for
       exactly that reason. How it is *drawn* is the knob below. */
    kind: "timer",
    label: "timer",
    family: "room",
    short: "a timer",
    note: "how long this has taken, or how long is left",
    box: { w: 220, h: 132 },
    min: { w: 118, h: 66 },
    params: [
      choice(
        VARIANT,
        "counting",
        [
          { value: "up", label: "up, from zero" },
          { value: "down", label: "down, to zero" },
          { value: "duo", label: "two lanes, one at a time" },
        ],
        "up",
      ),
      choice(
        "face",
        "drawn as",
        [
          { value: "digits", label: "digits" },
          { value: "ring", label: "a ring" },
          { value: "bar", label: "a bar" },
        ],
        "digits",
      ),
      /* Only a countdown has a length. Stored while hidden, so flipping to
         counting up and back does not lose what you had chosen. */
      choice("length", "how long", LENGTHS.map(({ value, label }) => ({ value, label })), DEFAULT_LENGTH, {
        key: VARIANT,
        is: ["down"],
      }),
    ],
    /* A duo's second lane. The first is `since`/`banked`, so an `up` timer
       switched to `duo` carries its time into the `on` lane rather than
       starting again — which is what anybody switching would expect. */
    state: [...RUN, { key: "sinceOff", def: 0 }, { key: "bankedOff", def: 0 }],
  },
  {
    /* A view, not the thing itself. The cycle is one per studio and lives in
       `pomodoro.svelte.ts` — two of these on the wall are two readings of one
       afternoon, and a second widget holding its own phase would be two clocks
       telling different times. So the config here is the face and nothing
       else, and the cadence is reached through the same menu but written
       through to the shared cycle. */
    kind: "pomodoro",
    label: "pomodoro",
    family: "room",
    short: "a pomodoro",
    note: "focus and breaks, with the breaks actually taken",
    box: { w: 216, h: 206 },
    min: { w: 128, h: 92 },
    params: [
      choice(
        VARIANT,
        "reading",
        [
          { value: "ring", label: "a ring" },
          { value: "beads", label: "the cycle" },
          { value: "digits", label: "digits" },
        ],
        "ring",
      ),
    ],
  },
  {
    /* What is playing, and the transport for it.
     *
     * Placed here, at the end of the run of instruments that are about *the
     * room* — a clock, a timer, a pomodoro — rather than alphabetically or at
     * the end. This list is the order the right-click offers them in, so it is
     * an editorial sequence rather than a set: the things you hang up because
     * of how the afternoon feels, then the meters, then the services, then the
     * agents' own notes, then the logs. A record player belongs with the first
     * group and nowhere near the second.
     *
     * The one widget here whose face reaches its holder directly rather than
     * being handed one. `deck.svelte.ts` is a module-level singleton with
     * refcounted attach/detach, so the arm in `WidgetNode` is one line and no
     * prop threads down through `Canvas` and `App` — which is right for the
     * only instrument on the wall that nothing else needs to see. Owns no
     * timer either: every reading is a pure function of `clock.t`. See
     * `spotify.ts`. */
    kind: "spotify",
    label: "spotify",
    family: "room",
    short: "the record player",
    offer: "hang up the record player",
    note: "what is playing, and the transport for it",
    box: { w: 248, h: 150 },
    min: { w: 150, h: 46 },
    params: [
      /* Three readings, and the smallest is the reason there are three: a
         `bar` is a strip you sit on a shelf under something else, so it drops
         the art and the transport and keeps the title and the playhead. A knob
         rather than a width breakpoint, because a widget's size is something
         you chose by dragging it and guessing from the width would override
         that. */
      choice(
        VARIANT,
        "reading",
        [
          { value: "full", label: "art, transport and times" },
          { value: "compact", label: "smaller art, no times" },
          { value: "bar", label: "a strip — title and playhead" },
        ],
        "full",
      ),
      toggle("art", "album art", true),
      toggle("progress", "the playhead", true),
    ],
  },
  {
    /* The other meter, and the one that reads a clock rather than a machine:
       what Claude Code has spent against the two windows its limits run on.
       Deliberately not scoped to this studio — the limits are per account and
       count every turn taken on this machine, terminal ones included, so a
       reading of Skein's own cards would answer a different question with the
       same numerals. See `usage.ts`. */
    kind: "usage",
    label: "usage",
    family: "claude",
    short: "what is left",
    note: "how much of the allowance is gone, and when it comes back",
    box: { w: 264, h: 152 },
    min: { w: 142, h: 76 },
    params: [
      choice(
        VARIANT,
        "reading",
        [
          { value: "bars", label: "bars" },
          { value: "rings", label: "rings" },
          { value: "digits", label: "digits" },
        ],
        "bars",
      ),
      /* The allowance is the default, and it is a different *fact* from the
         two below it rather than a third way of counting the same one: a
         percentage of the account's own limit, off `/api/oauth/usage`, with a
         reset the server names. It leads because it is the question anybody
         actually has — how much of the five hours is gone, and when does it
         come back — and because it is the only one of the three with a real
         denominator.

         Cost stays, and stays ahead of tokens, because it is the only reading
         that weights the five kinds of token against each other: a cache read
         is a tenth of an input token and an output token is five times one, so
         a raw total is very nearly a count of cache reads and says almost
         nothing about how hard the wall has been worked. It is also the only
         reading available at all on an account with no OAuth sign-in — see
         `limits.ts`. */
      choice(
        "measure",
        "counted in",
        [
          { value: "allowance", label: "what is left of the allowance" },
          { value: "cost", label: "what it would cost" },
          { value: "tokens", label: "tokens" },
        ],
        "allowance",
      ),
      /* Which subscription this face is a reading of.
       *
       * Only on the allowance, and that is a limitation rather than a
       * preference. The allowance is the *account's* own figure and arrives per
       * account off `/api/oauth/usage`, so scoping it is exact. Cost and tokens
       * are inferred from the transcripts on this machine, and **a transcript
       * does not record which subscription paid for the turn** — so an account
       * knob on those two would be a filter that could not filter, which is the
       * knob-that-does-nothing this file already refuses elsewhere. The turn
       * table could answer it for Skein's own cards, and that is deliberately
       * not offered: it would be a different question wearing the same
       * numerals, which is the call `usage.md` already makes about scoping this
       * widget to the studio.
       *
       * "every account" leads and is the default, because with a waterfall the
       * question is usually about the wall rather than about one subscription —
       * and because it is the only setting that stays right when the account
       * you were watching is not the one being spent any more. */
      choice(
        "account",
        "for",
        [
          { value: "all", label: "every account" },
          /* The globally signed-in session, which is not one of the accounts in
           * the order and is the one reading that exists whether or not any are
           * registered. Offered explicitly because it answers a question the
           * per-account faces cannot: what the subscription *this machine* is
           * signed in as has left — which is what a terminal outside Skein
           * spends, and what the wall read before accounts existed. */
          { value: "signed-in", label: "the signed-in session" },
        ],
        "all",
        { key: "measure", is: ["allowance"] },
        "accounts",
      ),
    ],
  },
  {
    /* The derivative of the widget above it, and a separate kind rather than a
       fourth `measure` on it — which is the call `azdo.md` makes for pipelines
       and reviews, arrived at the same way. A variant on this wall is a
       different *reading of the same fact*, and the fact here is a different
       one: how much has gone, against how fast it is going. Decisively, they
       are wanted on the wall at the same time — the whole use of a rate is to
       watch it against a total — and a variant is exclusive.

       Everything it reads is already in hand. The one shared `Ledger` behind
       however many usage widgets are up is behind this one too, so a wall that
       has either pays once and a wall that has neither pays nothing. No fourth
       poller; see the "exactly three deliberate exceptions" note in CLAUDE.md
       for the standard one would have had to meet. */
    kind: "burn",
    label: "burn rate",
    family: "claude",
    short: "the burn rate",
    note: "how fast this wall is burning tokens",
    box: { w: 216, h: 196 },
    min: { w: 92, h: 68 },
    params: [
      /* Four readings of one number, and they are genuinely different
         instruments rather than skins — the same test the clock's five faces
         pass. A dial is read by angle against the wall's own habits, a bar by
         position, a trace by shape over the past hour, and the numerals by
         reading the number. The dial leads because it is the one that answers
         "fast or slow *for me*" without being read, which is what an instrument
         hung on a wall is for. */
      choice(
        VARIANT,
        "face",
        [
          { value: "dial", label: "a dial, with a needle" },
          { value: "bar", label: "a bar" },
          { value: "trace", label: "the past hour, as a line" },
          { value: "numerals", label: "the number, and nothing else" },
        ],
        "dial",
      ),
      /* Which unit, and the default is the one this machine's own transcripts
         argue for rather than the one that sounds tidiest. A request carries a
         median 163k tokens and lands about every six seconds, so a per-second
         reading is finer than its own quantum; only 22% of the wall clock has
         any activity in it, so a per-hour reading projects an hour that never
         happens. A minute is where the work is — a turn is about a minute and a
         few hundred thousand tokens. The whole measurement is at the top of
         `rate.ts`.

         The other two are offered because the ask asked for them and because a
         wall worked differently from this one may well disagree. Turning this
         re-marks the dial to round numbers in the unit you chose, which is
         deliberate and is explained where the scale is computed. */
      choice(
        "per",
        "counted per",
        [
          { value: "second", label: "second" },
          { value: "minute", label: "minute" },
          { value: "hour", label: "hour" },
        ],
        "minute",
      ),
      /* The odometer under the speedometer: what these five hours have burned.
         Deliberately the same figure the `usage` widget's block reading carries
         — a speed and a distance on one face is the entire idiom being borrowed
         here, and two instruments disagreeing about the trip would be worse
         than one repeating it. */
      toggle("odometer", "what these five hours have burned", true),
    ],
  },
  {
    /* Whether Claude itself is up, off `status.claude.com`.
     *
     * The third instrument in a row about the thing this wall is made of, and
     * the only one whose subject is somebody else's machine: the two above it
     * read what the allowance has left and how fast it is going, and this one
     * answers the question those two cannot — the wall has gone quiet and the
     * turns are failing, so is it me or is it them? A question with an obvious
     * answer that costs a browser tab, an ambiguous search and a minute is a
     * question people answer by guessing.
     *
     * It is the fourth thing on this wall that goes and *looks*, which is a
     * thing CLAUDE.md makes you argue for. The argument is in `status.ts` and
     * written out in `.claude/rules/widgets.md`; the short of it is that two
     * events near the fact are folded — you coming back to the window, and a
     * card's turn ending in an error — and the leftover backstop tightens with
     * the news rather than stopping, because an outage resolves.
     *
     * And it is the one face in the catalogue where the house colour rule is
     * not a constraint but the whole design: chrome is achromatic and colour is
     * reserved for status, and this *is* status, so Statuspage's ladder maps
     * onto the five `--st-*` tokens with nothing invented. `toneOf` is that
     * mapping and the sixth rung, `unknown`, is deliberately achromatic — not
     * having reached the page is the absence of a reading, and drawing it in
     * any status colour would be the widget inventing news. */
    kind: "status",
    label: "claude status",
    family: "claude",
    short: "is it up",
    offer: "hang up claude's status",
    note: "whether claude itself is up, and which part of it is not",
    box: { w: 262, h: 168 },
    min: { w: 132, h: 62 },
    params: [
      /* Two readings of one page, and they answer the two halves of the
         question separately. `overall` is the headline and the dot — the wall's
         "is it them", legible at the size of a card and green almost always.
         `parts` is every service on one line each, which is the half that
         matters once the answer is yes: the API being degraded and the Console
         being degraded are very different afternoons.

         No `incidents` reading, deliberately, and it is the `reviews` scope
         argument one file over: a face that is empty on every ordinary day is a
         face nobody looks at, and by the time it had something to say the habit
         of glancing at it would be gone. An incident is drawn *inside* both
         readings when there is one, which is where it is actually wanted. */
      choice(
        VARIANT,
        "reading",
        [
          { value: "overall", label: "the headline" },
          { value: "parts", label: "every service, one line each" },
        ],
        "overall",
      ),
      /* And this one narrows rather than re-reads, the way `sink`'s and the
         three logs' do. Only on the list, because "only what is wrong" has no
         meaning applied to a single headline — a knob that did nothing there
         would read as broken rather than as absent, which is the whole reason
         `Guard` exists.

         It is the setting that makes this furniture rather than an instrument:
         a widget that is blank all week and grows a rust line the morning
         something breaks is the reading you want hanging in the corner. The
         face says how many it is keeping back, so a blank pane is never a
         widget that looks broken. */
      choice(
        "showing",
        "showing",
        [
          { value: "all", label: "every service" },
          { value: "ill", label: "only what is not operational" },
        ],
        "all",
        { key: VARIANT, is: ["parts"] },
      ),
      /* Off by default, and the argument is the same one the editor log's
         timestamps make. A maintenance window three weeks out is not a reading
         of *now* and this is an instrument about now — but it is exactly what
         somebody planning a Friday deploy wants, and the page publishes it, so
         hiding it outright would be this widget deciding something it is not
         entitled to decide. */
      toggle("upcoming", "scheduled maintenance", false),
    ],
  },
  {
    /* The two Azure DevOps instruments, and they are two rather than one with a
       variant switching between them — which is the question this feature was
       asked as. A variant on this wall means a different *reading of the same
       fact*: a clock's five faces are all the time, a timer's three are all the
       run. Pipelines and pull requests are different facts, off different
       endpoints, on different clocks, and answering different questions ("is it
       green" and "who is waiting on whom"). Decisively, they are wanted on the
       wall *at the same time*, and a variant is exclusive — picking one would
       mean losing the other. What they genuinely share is the connection, and
       that is shared, in `devops.svelte.ts`.

       Wider than they are tall, both, and the widest things in the catalogue: a
       row here is a project, a pipeline and a branch, and none of the three can
       be dropped without the row ceasing to say where it is from. */
    kind: "pipelines",
    label: "pipelines",
    family: "forge",
    short: "pipelines",
    note: "what is building, across every project at once",
    box: { w: 340, h: 210 },
    min: { w: 190, h: 84 },
    params: [
      choice(
        VARIANT,
        "reading",
        [
          { value: "list", label: "list" },
          { value: "lanes", label: "lanes, by project" },
          { value: "dots", label: "dots" },
        ],
        "list",
      ),
      /* `live` first, because it is the view Azure DevOps itself will not give
         you without picking a project — the whole reason this is worth drawing
         on a wall rather than opening in a tab. It keeps runs that have just
         finished, or the row you most want would vanish as it landed; see
         `SETTLING_MS`. */
      choice(
        "scope",
        "showing",
        [
          { value: "live", label: "what is running, and what just finished" },
          { value: "mine", label: "the ones I started" },
          { value: "all", label: "everything recent" },
        ],
        "live",
      ),
    ],
  },
  {
    kind: "reviews",
    label: "reviews",
    family: "forge",
    short: "reviews",
    note: "open pull requests, and which of them want you",
    box: { w: 340, h: 210 },
    min: { w: 190, h: 84 },
    params: [
      choice(
        VARIANT,
        "reading",
        [
          { value: "list", label: "list" },
          { value: "lanes", label: "lanes, by repository" },
          { value: "dots", label: "dots" },
        ],
        "list",
      ),
      /* `mine` rather than `waiting`, deliberately. A widget that only ever
         showed what is blocked on you would be empty most of the day and
         therefore ignored — and the pull requests you opened and are waiting on
         somebody else for are the other half of the same question. */
      choice(
        "scope",
        "showing",
        [
          { value: "mine", label: "mine, and the ones I was asked about" },
          { value: "waiting", label: "only what is waiting on me" },
          { value: "all", label: "every open pull request" },
        ],
        "mine",
      ),
    ],
  },
  {
    kind: "asana",
    label: "asana board",
    family: "asana",
    short: "the board",
    note: "one project's board, and its cards where you put them",
    /* Wider than anything else in this catalogue, and the widest thing on the
       wall. A board is columns side by side — that is what makes it a board
       rather than a list — and four of them at a legible card width is what
       this comes to. The `counts` reading is what it becomes when you want it
       small. */
    box: { w: 560, h: 320 },
    min: { w: 200, h: 110 },
    params: [
      /* Two readings of one fact, the test every variant on this wall has to
         pass. `counts` is not a lesser board: it is the shape that still says
         something at the size of a card, where columns say nothing at all —
         and it is deliberately not draggable, being a gauge rather than the
         board. */
      choice(
        VARIANT,
        "reading",
        [
          { value: "board", label: "the board" },
          { value: "counts", label: "how much is in each column" },
        ],
        "board",
      ),
      /* Every real option is resolved at menu time, so this knob does not
         appear until the connection has fetched a project list — see `Source`
         and `optionGroupsOf`. The widget draws its own picker in the meantime,
         because a board with no project is not a board and a first-run state
         reachable only through a right-click menu reads as broken.

         `""` as the default rather than a project: there is no project this
         file could name, and guessing the first one the token can see would
         put somebody else's board on your wall. It is a *literal* option as
         well as the default, which is both what the catalogue's own invariant
         requires — a default has to be a value the knob accepts, since it is
         what a widget comes back as when nothing resolves — and a way to put
         the picker back without taking the widget down. */
      choice(
        "project",
        "project",
        [{ value: "", label: "none — show the picker" }],
        "",
        undefined,
        "boards",
      ),
      /* Asana's own idiom is `completed_since=now`, which filters the
         *checkmark* and not the column — so a Done column still draws either
         way, and what this hides is the cards somebody has actually finished
         with. `open` first because a board that accumulates every task ever
         ticked is one nobody reads twice. */
      choice(
        "showing",
        "showing",
        [
          { value: "open", label: "what is still open" },
          { value: "all", label: "everything, ticked or not" },
        ],
        "open",
      ),
    ],
  },
  {
    /* What is on you, across every project. The cheapest useful reading here —
       one request, no board to pick — and the one a developer glances at most.
       Asana calls it "My tasks" and puts it behind a tab; the whole argument
       for a wall is that a thing you check twenty times a day belongs on it. */
    kind: "asanatasks",
    label: "asana tasks",
    family: "asana",
    short: "what is on me",
    note: "what is assigned to you, across every project",
    box: { w: 300, h: 200 },
    min: { w: 170, h: 78 },
    params: [
      choice(
        VARIANT,
        "reading",
        [
          { value: "list", label: "the list" },
          { value: "counts", label: "late, today, this week" },
        ],
        "list",
      ),
      /* Same knob and same wording as the board's, because it is the same
         question about the same filter — `completed_since=now` hides what has
         been ticked rather than what is in a done column. */
      choice(
        "showing",
        "showing",
        [
          { value: "open", label: "what is still open" },
          { value: "all", label: "everything, ticked or not" },
        ],
        "open",
      ),
    ],
  },
  {
    /* How every project is going. The reading Asana will not give you without a
       portfolio: its status updates live one project at a time, so "is anything
       off track anywhere" is a tab each. Same argument the pipelines widget
       makes, one service over. */
    kind: "asanahealth",
    label: "asana health",
    family: "asana",
    short: "project health",
    note: "how every project is going, worst first",
    box: { w: 300, h: 180 },
    min: { w: 150, h: 70 },
    params: [
      /* `dots` first, and it is the default for the reason the pipelines
         widget's `live` is: the question is "is anything wrong anywhere", and a
         grid of dots answers it without your having to read a word. The list is
         for when the answer is yes and you want to know which. */
      choice(
        VARIANT,
        "reading",
        [
          { value: "dots", label: "dots" },
          { value: "list", label: "a list, worst first" },
        ],
        "dots",
      ),
      /* `mine` first, because sixty-four dots is a pattern rather than a
         reading. The three you are a member of are the three you are
         accountable for; the rest are somebody else's grid. */
      choice(
        "scope",
        "showing",
        [
          { value: "mine", label: "the projects I am on" },
          { value: "all", label: "every project in the workspace" },
        ],
        "mine",
      ),
    ],
  },
  {
    kind: "billboard",
    label: "billboard",
    family: "notes",
    short: "the billboard",
    offer: "hang up the billboard",
    note: "what the agents have said they are working on",
    box: { w: 320, h: 220 },
    min: { w: 200, h: 96 },
    params: [
      /* Two readings of the same board, and the difference is whether you have
         to ask. A list is for a board you glance at — it fits eight notices in
         the height four notes take — and the notes are for one hung where you
         are actually working, where the point is to have read them without
         clicking anything. */
      choice(
        VARIANT,
        "reading",
        [
          { value: "list", label: "list" },
          { value: "notes", label: "notes, opened out" },
        ],
        "list",
      ),
      /* And this one is about *hiding* rather than reading. There is no `scope`
         here on purpose: a widget belongs to no project (see the note at the
         top of this file), so "this project" has no referent to resolve
         against — and the split that matters is the agents', who must not be
         shown another project's work. You want the wall. */
      choice(
        "showing",
        "showing",
        [
          { value: "all", label: "everything up" },
          { value: "current", label: "only what is still fresh" },
        ],
        "all",
      ),
    ],
  },
  {
    kind: "sink",
    label: "sink",
    family: "notes",
    short: "the sink",
    offer: "hang up the sink",
    note: "things the agents noticed and could not stop for",
    box: { w: 340, h: 260 },
    min: { w: 220, h: 110 },
    params: [
      /* Two readings, and they answer different questions. `pile` is the whole
         of it, oldest first, for when you want to know what this wall owes —
         and it is a *list*, not the billboard's opened-out notes, because an
         item carries a paragraph written for whoever picks it up months later
         and eight of those at once is prose rather than an instrument.
         `next` draws the single oldest thing nobody is on, opened out, which is
         the sink hung where you work rather than where you plan: not "what is
         waiting" but "what should I do about it now". Same table, and the second
         reading is the one that makes an item get done. */
      choice(
        VARIANT,
        "reading",
        [
          { value: "pile", label: "the whole pile" },
          { value: "next", label: "the next thing, opened out" },
        ],
        "pile",
      ),
      /* And this one narrows rather than re-reads. No scope knob, for
         `billboard`'s reason: a widget belongs to no project, so "this project"
         has no referent to resolve against. */
      choice(
        "showing",
        "showing",
        [
          { value: "all", label: "everything in it" },
          { value: "bug", label: "only what is broken" },
          { value: "idea", label: "only what should exist" },
          { value: "chore", label: "only the chores" },
          { value: "note", label: "only the notes" },
        ],
        "all",
      ),
    ],
  },
  {
    /* **`pipelines` draws a remote build's state; this draws the local tree's**,
       and they are deliberately two widgets rather than one with a variant. The
       rule the catalogue already applies: a variant is for two readings of one
       *fact*, and "did CI pass on the branch I pushed" and "does the checkout in
       front of me compile" are two facts, on two clocks, answering two
       questions. They are also wanted up at the same time, which is what settles
       it, since a variant is exclusive.

       Sink 3ebe1d59. What this exists for is the afternoon nobody could tell
       whether the tree was broken, since when, or whose fault it was: one
       breakage diagnosed three times over, broadcast to the whole wall and
       retracted an hour later, and a `git stash` that wiped four cards' work
       while somebody tried to find out whether an error was their own.

       **Nothing behind it goes and looks**, so it is not the fourth thing on
       this wall that does. `gates.svelte.ts` is fed by `gates:changed`, which
       every write to the table emits, and the rows are written because cards run
       these gates constantly of their own accord — so the face is a fold over
       events that already arrive. See `.claude/rules/gates.md`.

       Sized like the sink rather than like the logs: a row here is a gate, a
       verdict, an age and who saw it, which is prose-shaped and does not want a
       compiler's eighty columns. */
    kind: "gates",
    label: "gates",
    family: "notes",
    short: "the gatehouse",
    offer: "hang up the gatehouse",
    note: "whether the tree builds, and who last saw it do so",
    box: { w: 320, h: 200 },
    min: { w: 200, h: 90 },
    params: [
      /* Two readings answering different questions. `state` is one line per
         gate, red first — the wall glanced at, for "is anything broken".
         `detail` opens the newest failure out with the tail of what it said,
         which is the reading for a wall hung where you are actually working:
         not "is anything broken" but "what is broken, and do I already know
         why".

         No `scope` knob, and here that is more than `billboard`'s reason. A
         widget belongs to no project, *and* this record is keyed by tree rather
         than by project — two cards on different worktrees of one project share
         a project and share no files — so "this project" would be the wrong
         question even if a widget had a referent for it. */
      choice(
        VARIANT,
        "reading",
        [
          { value: "state", label: "one line per gate" },
          { value: "detail", label: "the newest failure, opened out" },
        ],
        "state",
      ),
      /* And this one narrows rather than re-reads, `sink`'s shape. A gate nobody
         has run is not a gate that passed, so what is drawn by default is
         whatever has actually been observed; `red` cuts it to what is broken,
         for a wall where this is a warning light rather than a status board. */
      choice(
        "showing",
        "showing",
        [
          { value: "all", label: "every gate seen run" },
          { value: "red", label: "only what is red" },
        ],
        "all",
      ),
    ],
  },
  {
    /* A dev server's own output, and the one instrument here that reads
       something the app was already holding: `servers.rs` pipes every group's
       stdout and stderr up as `server:log` and `GroupRuntime` keeps them, for
       the panel. So there is no sampler behind this and nothing to attach to —
       which is why no `Servers` holder was invented for it, the way `Meter` and
       `Ledger` and `DevOps` were for the three faces that do have to go and
       ask. See `serverlog.ts`.

       Wider than it is tall, and the second-widest thing in the catalogue after
       the two Azure DevOps faces: a line here is a compiler's, and a log cut to
       forty columns is a log you read by guessing. */
    kind: "serverlog",
    label: "server log",
    family: "logs",
    short: "servers",
    note: "what a dev server is saying, and a way to start it when it is not",
    box: { w: 380, h: 200 },
    min: { w: 200, h: 90 },
    params: [
      /* Two readings of one fact — what the servers in this group are saying.
         `lines` is the scroll, as printed, with the colour the pipes kept by
         asking for it (`force_colour`). `latest` is the last thing each server
         said, one line apiece and larger: the reading for a log dropped to the
         size of a card, where a tail of four monospace lines says nothing and
         "ready in 342ms" says all of it. A group of two servers is two lines
         there, including the one that has gone quiet — which is the one you are
         looking for. */
      choice(
        VARIANT,
        "reading",
        [
          { value: "lines", label: "the tail, as printed" },
          { value: "latest", label: "the last thing each said" },
        ],
        "lines",
      ),
      /* Which group. A widget belongs to no project — see the head of this
         file — so unlike the territory chips this cannot be answered by where
         it is standing, and it has to be answered by name.

         `running` leads and is the default, because it is the setting that
         stays right: groups are added and deleted long after a widget was hung
         up, and a wall where the thing you want to watch is simply "whatever is
         working" is most walls. Nothing is hidden by it — the face names its
         subject in the header either way, so following and pinning read the
         same and differ only in what happens when a second group starts.

         The rest of the options are the groups themselves, resolved at menu
         time off the wall (`Source`), because this file cannot know them. A
         wall with one group does not offer the knob at all: following it and
         naming it are the same answer, which is the question-with-one-answer
         this catalogue refuses everywhere else. */
      choice(
        "group",
        "watching",
        [{ value: FOLLOW, label: "whichever is running" }],
        FOLLOW,
        undefined,
        "groups",
      ),
      /* And this one narrows rather than re-reads, the way `sink`'s does. It is
         also the first thing in the app to read `ServerLog.stderr`, which only
         became true when the pseudo-terminal came off and each pipe got its own
         reader — under one merged reader the field was hardcoded `false` for
         every line ever emitted. See `.claude/rules/servers.md`. */
      choice(
        "showing",
        "showing",
        [
          { value: "all", label: "everything it printed" },
          { value: "stderr", label: "only what went to stderr" },
        ],
        "all",
      ),
    ],
  },
  {
    /* The fourth log, and the only one with no subject to pick — there is one
       process and it says one stream of things. So no chooser, no `FOLLOW`, and
       the whole knob surface is how much of it to show.

       It exists because until 2026-08-28 this app installed no `log` sink at
       all, and a day went into recovering lines librespot had been emitting the
       whole time. `applog.rs` has that account; the short version is that the
       app's own diagnosis was the one thing the wall could not show you. */
    kind: "applog",
    label: "app log",
    family: "logs",
    short: "the app",
    note: "what volery and its dependencies are saying about themselves",
    box: { w: 380, h: 200 },
    min: { w: 200, h: 90 },
    params: [
      /* A floor rather than a set of checkboxes: levels are ordered, and
         "warn or worse" is the question people actually have. `problems` is
         the exception and earns its place — errors *and* warnings with the
         chatter gone is the reading you want when something has just broken,
         and it is not expressible as a floor because `info` sits between them
         and nothing. */
      choice(
        VARIANT,
        "showing",
        [
          { value: "all", label: "everything the sink let through" },
          { value: "problems", label: "only errors and warnings" },
          { value: "error", label: "errors" },
          { value: "warn", label: "warn and worse" },
          { value: "info", label: "info and worse" },
          { value: "debug", label: "debug and worse" },
        ],
        "all",
      ),
      /* The gutter costs real width on a narrow widget, and on a wall where
         this is pinned small the lines matter more than which module said
         them — the full target is still on the row's title. */
      toggle("marks", "show which module said it", true),
    ],
  },
  {
    /* The second of the three logs, and the one whose subject is a *run* rather
       than a thing that sits there: see `buildlog.ts` for why the knob names a
       project all the same — a run's id lasts as long as one compile, and there
       would be nothing stable to pin a widget to.

       Not an Unreal widget, deliberately. UBT, cargo, tsc and pnpm all produce
       a run, and nothing in the face asks whose it is. */
    kind: "buildlog",
    label: "build log",
    family: "logs",
    short: "builds",
    note: "what a build is saying, and how far along it got",
    box: { w: 380, h: 200 },
    min: { w: 200, h: 90 },
    params: [
      /* Two readings, and the second is the one that earns the widget. `lines`
         is the tail as printed. `progress` is the bar, the last note and the
         elapsed — which is what this face can still say at the size of a card,
         where four monospace lines of `cl.exe` invocations say nothing. The
         same bargain the server log's `latest` strikes. */
      choice(
        VARIANT,
        "reading",
        [
          { value: "lines", label: "the tail, as printed" },
          { value: "progress", label: "how far along, and the last note" },
        ],
        "lines",
      ),
      /* Which project's last run. `running` leads for the reason it does
         everywhere in this catalogue — it is the setting that stays right — and
         here it means something slightly stronger than elsewhere: a wall of six
         projects where one is compiling has exactly one answer, and the moment
         it stops the widget holds still rather than wandering off the log you
         were about to read. */
      choice(
        "project",
        "watching",
        [{ value: FOLLOW, label: "whichever is building" }],
        FOLLOW,
        undefined,
        "projects",
      ),
      /* And the narrowing that makes a UBT log readable at all: three thousand
         lines, four of which matter. `diagnosticOf` is deliberately fussy about
         punctuation — see the long note in `buildlog.ts` — because a matcher
         that called `Compiling error-handling v0.3.1` an error would turn this
         into a second copy of the log with no way to tell from looking. */
      choice(
        "showing",
        "showing",
        [
          { value: "all", label: "everything it printed" },
          { value: "problems", label: "only errors and warnings" },
        ],
        "all",
      ),
    ],
  },
  {
    /* The third, and the only one that has to go and *ask*: a dev server's
       output is already on the wall because the panel wanted it and a build's
       because a chip did, where the editor's log is a file nothing was reading.
       `actions.svelte.ts` tails it while a widget wants it and the editor is
       up — see `unreallog.ts` for why those are both conditions. */
    kind: "unreallog",
    label: "editor log",
    family: "logs",
    short: "the editor",
    note: "what a running unreal editor is saying about itself",
    box: { w: 400, h: 210 },
    min: { w: 210, h: 90 },
    params: [
      choice(
        VARIANT,
        "reading",
        [
          { value: "lines", label: "the tail, taken apart" },
          { value: "tally", label: "the count, and the last thing wrong" },
        ],
        "lines",
      ),
      choice(
        "project",
        "watching",
        [{ value: FOLLOW, label: "whichever editor is open" }],
        FOLLOW,
        undefined,
        "editors",
      ),
      choice(
        "showing",
        "showing",
        [
          { value: "all", label: "every category" },
          { value: "problems", label: "only warnings and errors" },
        ],
        "all",
      ),
      /* Off by default, and that is the whole argument for having the knob: a
         stamp is twenty-three characters of a line that has sixty to spend, and
         `timeOf` cuts it to eight — but eight is still an eighth of the face, and
         it is only ever worth it when you are lining this up against a build
         that failed at about the same moment. */
      toggle("stamps", "the time each line was written", false),
    ],
  },
  {
    /* The one widget you work *in* rather than read, and the only one that
       takes the pointer away from the wall. That is why it is a widget at all
       rather than a panel: a page you are testing wants to sit next to the card
       whose agent is driving it, at whatever size that page deserves, and the
       wall is the only surface here where two things can be side by side.

       It draws a page in the browser `browser.rs` owns, which the agent is
       driving at the same time over the same CDP port — so a click here lands
       in the session the agent has, with its cookies and its login. It is not a
       second browser and deliberately not a webview: see the measurement in
       `browser.rs`, where hosting the page in-app saves ~0 against sharing one
       real Chrome and gives up the pinned build, cross-browser and real
       contexts.

       Bigger than anything else in the catalogue, and it has to be: this is the
       only widget whose content has its own correct size. A 1280-wide app in a
       400-wide widget is legible as a shape and illegible as an interface, and
       `fitFrame` will not scale up past 1 to pretend otherwise. */
    kind: "browser",
    label: "browser",
    note: "a page you and the agent are both driving",
    box: { w: 640, h: 460 },
    min: { w: 260, h: 200 },
    params: [
      /* Two readings, and unlike most `variant`s here these differ in what they
         are *for* rather than in how much they say. `page` is the picture and
         the pointer — the thing that was asked for. `log` is the same page's
         console and network over `logface.ts`'s substrate, which is the reading
         you want when the picture looks right and the app is still wrong.

         One widget with a variant rather than two kinds, because unlike
         pipelines and reviews these are two readings of *one fact* — this page,
         right now — and they are not wanted at the same time in the same
         square. Hang two browser widgets if you want both; they share the one
         connection, the way the two DevOps instruments share theirs. */
      choice(
        VARIANT,
        "reading",
        [
          { value: "page", label: "the page, and you can click it" },
          { value: "log", label: "its console and network" },
        ],
        "page",
      ),
      /* Which of the browser's pages this widget is showing. The options come
         from the browser itself rather than from this list, the way a server
         log's group does — a page is not something the catalogue can know
         about, since the agent opens them.
 
         `FOLLOW` leads, the same literal the three logs use and for the same
         reason: it is the setting that stays right. Pages here are opened and
         closed by the *agent* as it works, so a widget pinned to one page id
         would be pointing at nothing within the hour — and unlike a server
         group there is no gesture by which you would re-pin it. It is also the
         default that makes the spec honest: a sourced knob still has to hold
         its own default in its literal options, or a widget read back with
         nothing resolved comes off disk undrawable. */
      choice(
        "target",
        "page",
        [{ value: FOLLOW, label: "whichever page there is" }],
        FOLLOW,
        undefined,
        "pages",
      ),
      /* Narrowing, the same shape the three logs and the sink use. Only on the
         log reading, since "only what is wrong" has no meaning applied to a
         picture — a knob that does nothing reads as broken rather than absent,
         which is what `Guard` is for. */
      choice(
        "showing",
        "showing",
        [
          { value: "all", label: "console and network" },
          { value: "console", label: "only the console" },
          { value: "problems", label: "only failures and warnings" },
        ],
        "all",
        { key: VARIANT, is: ["log"] },
      ),
      /* On by default, and it is the setting that decides whether this is an
         instrument or a tool. Off, the widget is a live picture you cannot
         touch — which is the right thing for one hanging in a corner watching
         what an agent does, and stops a stray click on the wall going into
         somebody's staging environment. */
      toggle("interactive", "clicks and keys reach the page", true),
    ],
  },
];

/* How many lines a meter of this height has room for.
 *
 * Not a parameter, on purpose: the box you drag it to is the answer, and a
 * number in a menu that disagreed with the height would be a widget arguing
 * with itself. Measured against the same constants the face is styled with —
 * change `.rows`'s font size and this comes with it.
 *
 * Shared by the process meter, the pipelines face and the reviews face, which
 * is why it is not named for any of them: all three are a header over a list of
 * one-line rows at the same size, and three copies of this arithmetic would be
 * three places for a row height to drift from the CSS it describes. */
const PERF_HEAD = 26;
const PERF_ROW = 18;

export function rowsFor(h: number): number {
  return Math.max(1, Math.floor((h - PERF_HEAD - 8) / PERF_ROW));
}

export function specFor(kind: string): WidgetSpec | null {
  return WIDGETS.find((w) => w.kind === kind) ?? null;
}

/** Every knob this widget has — its own, then the ones everything has.
 *
 * The one place `COMMON` is joined on, and therefore the definition of "a
 * widget's vocabulary": the menu, the defaults and the read back off disk all
 * ask this rather than reading `spec.params`, or a shared knob would be offered
 * without being persisted (or persisted without being reachable). Common last,
 * which is also what keeps the variant first — a convention `variantOf` and the
 * menu both lean on. */
export function paramsOf(spec: WidgetSpec): WidgetParam[] {
  return [...spec.params, ...COMMON];
}

/** One row in the menu that hangs things up: an instrument, or a family of
 *  them behind one row.
 *
 *  Shaped so `menu.ts` can turn it into items without importing this file —
 *  the two have never known about each other, and a menu that had to be
 *  recompiled to learn about a new widget would be the coupling the opaque
 *  `config_json` column exists to avoid. */
export type Offer =
  | { id: string; label: string }
  | { id: string; label: string; items: { id: string; label: string }[] };

/** What a right-click offers to hang up, in the catalogue's own order.
 *
 *  Moved out of `App.svelte`, where it was one line, because it stopped being
 *  one line: which widgets group together is knowledge about the catalogue, and
 *  the catalogue is what this file is. Pure, so the grouping is tested rather
 *  than looked at.
 *
 *  **A family appears where its first member sits**, so the editorial sequence
 *  in `WIDGETS` still decides the order and a family does not jump to the
 *  bottom for being a family. Later members are folded into that row rather
 *  than drawn again.
 *
 *  **A family of one is flattened**, which is this file's version of `menu.ts`'s
 *  standing rule that offering nothing is a real answer: a submenu you open to
 *  find a single row is strictly worse than the row, since it costs a gesture
 *  and tells you nothing. Not reachable from today's catalogue — every family
 *  has at least two — and it is the behaviour that makes deleting a widget kind
 *  safe rather than something that leaves a menu with a pointless hover in it.
 *
 *  The parameter is for the test that proves the flattening, since no real
 *  family has one member — the catalogue is the default and every caller uses
 *  it. */
/** "a" or "an", by the sound the label starts with.
 *
 *  Spelling rather than phonetics — the exceptions English has ("an hour", "a
 *  university") do not occur among these labels, and a table of them would be
 *  a table to keep true for a menu nobody reads twice. `an app log` and `an
 *  asana board` are the two this exists for. */
function article(label: string): string {
  return /^[aeiou]/i.test(label) ? "an" : "a";
}

/** One instrument's row, template or override. */
function offerLabel(spec: WidgetSpec): string {
  return spec.offer ?? `hang up ${article(spec.label)} ${spec.label}`;
}

export function offersOf(specs: WidgetSpec[] = WIDGETS): Offer[] {
  const out: Offer[] = [];
  /* Where each family's row ended up, so a later member can be folded into a
     row that has already been emitted. */
  const at = new Map<WidgetFamily, number>();
  for (const w of specs) {
    const member = { id: w.kind, label: w.short ?? w.label };
    if (!w.family) {
      out.push({ id: w.kind, label: offerLabel(w) });
      continue;
    }
    const seen = at.get(w.family);
    if (seen === undefined) {
      const family = FAMILIES.find((f) => f.id === w.family);
      /* A family named on a spec and missing from `FAMILIES` would otherwise be
         a widget you cannot hang up at all. Drawn as its own row instead —
         wrong-looking rather than absent, which is the recoverable of the two
         and the same choice `normalizeParam` makes about an unknown value. */
      if (!family) {
        out.push({ id: w.kind, label: offerLabel(w) });
        continue;
      }
      at.set(w.family, out.length);
      out.push({ id: `family:${family.id}`, label: family.label, items: [member] });
      continue;
    }
    const row = out[seen];
    if ("items" in row) row.items.push(member);
  }
  /* The flatten pass. Done afterwards rather than while building, because
     whether a family has one member is not known until the whole catalogue has
     been walked. */
  return out.map((o) => {
    if (!("items" in o) || o.items.length !== 1) return o;
    const only = specs.find((w) => w.kind === o.items[0].id);
    return {
      id: o.items[0].id,
      label: only ? offerLabel(only) : `hang up ${article(o.items[0].label)} ${o.items[0].label}`,
    };
  });
}

/** The variants a kind offers, for the menu that switches between them. */
export function variantsOf(kind: string): Choice[] {
  const p = specFor(kind)?.params.find((p) => p.key === VARIANT);
  return p?.kind === "choice" ? p.options : [];
}

/** Everything a widget can be told that is not its variant, as marked options.
 *
 * Built off the catalogue so a knob added there is reachable by hand the same
 * day — a parameter with no way to reach it is a parameter that does not exist.
 * A toggle is one item that flips; a choice is one item per value, of which one
 * is marked. Numbers are deliberately absent: a menu is a poor slider, and the
 * one number a widget has (how many rows a meter shows) is answered better by
 * the box you drag it to. */
/** Everything a widget can be told, **one group per knob**.
 *
 * Grouped rather than flat, and the reason is written into `menu.ts` already:
 * a clock's face and whether it shows seconds are different kinds of question,
 * and a menu that runs them together reads as a list of unrelated items. That
 * argument was made about `picks` against `options` and stopped one level too
 * early — inside `options` every knob was still poured into one list. It went
 * unnoticed while every option label was a self-describing sentence ("what it
 * would cost", "a ring"); it stopped being invisible the moment a knob's
 * options became bare account names sitting under "tokens".
 *
 * Empty groups are dropped, so a guarded knob leaves no gap behind it. */
export function optionGroupsOf(
  w: Widget,
  sources: Partial<Record<Source, Choice[]>> = {},
): { id: string; label: string; on: boolean }[][] {
  const spec = specFor(w.kind);
  if (!spec) return [];
  const out: { id: string; label: string; on: boolean }[][] = [];
  for (const p of paramsOf(spec)) {
    if (p.key === VARIANT) continue;
    if (!allows(w, p)) continue;
    if (p.kind === "toggle") {
      out.push([{ id: `cfg:${p.key}`, label: p.label, on: onOf(w, p.key, p.def) }]);
    } else if (p.kind === "choice") {
      const now = textOf(w, p.key, p.def);
      /* A sourced knob whose source resolves to nothing is not offered at all.
         Its literal options alone are one entry — "every account" with no
         account to compare it against — and a choice offering one thing is the
         knob-that-does-nothing this file refuses everywhere else. It is also
         why the invariant test exempts sourced knobs from needing two literal
         options: the second one arrives here or the knob does not appear. */
      if (p.from && (sources[p.from]?.length ?? 0) === 0) continue;
      const options = p.from ? [...p.options, ...(sources[p.from] ?? [])] : p.options;
      out.push(
        options.map((o) => ({
          id: `cfg:${p.key}:${o.value}`,
          label: o.label,
          on: o.value === now,
        })),
      );
    }
  }
  return out.filter((g) => g.length > 0);
}

/** The same thing flat, for callers that want one list. */
export function optionsOf(
  w: Widget,
  /** What each `Source` actually resolves to right now. The caller knows and
   *  this file does not — the wall's accounts live in a rune. Absent or empty
   *  is fine: the knob then offers only its literal options, which for the
   *  account knob is "every account", and that is the honest menu for a wall
   *  with no accounts registered. */
  sources: Partial<Record<Source, Choice[]>> = {},
): { id: string; label: string; on: boolean }[] {
  return optionGroupsOf(w, sources).flat();
}

/** Does this widget's current config let that knob mean anything? A guard that
 *  names a key nothing sets is treated as satisfied — a knob is better shown
 *  than silently lost when a spec is edited. */
export function allows(w: Widget, p: WidgetParam): boolean {
  if (!p.only) return true;
  const now = w.config[p.only.key];
  if (typeof now !== "string") return true;
  return p.only.is.includes(now);
}

/** What a menu id asks for. `cfg:<key>` flips a toggle; `cfg:<key>:<value>`
 *  sets a choice. Parsed here so the component turning ids into calls stays a
 *  component. */
export function optionFor(
  w: Widget,
  id: string,
): { key: string; value: string | boolean } | null {
  if (!id.startsWith("cfg:")) return null;
  const [key, ...rest] = id.slice(4).split(":");
  if (!key) return null;
  if (rest.length) return { key, value: rest.join(":") };
  return { key, value: !onOf(w, key) };
}

export function uid(): string {
  return crypto.randomUUID();
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function defaultConfig(kind: string): WidgetConfig {
  const spec = specFor(kind);
  if (!spec) return {};
  const out: WidgetConfig = {};
  for (const p of paramsOf(spec)) out[p.key] = p.def;
  for (const s of spec.state ?? []) out[s.key] = s.def;
  return out;
}

/** One knob, coerced onto its spec. Anything unreadable becomes the default —
 *  a widget with a NaN in it is a hole in the wall, and there is nothing here
 *  worth failing over. */
function normalizeParam(p: WidgetParam, raw: unknown): string | number | boolean {
  if (p.kind === "choice") {
    if (typeof raw !== "string") return p.def;
    /* A knob whose options come from somewhere else cannot be checked against
       the literal list — see `Source`. Clamping here is what would read an
       account registered after this widget was placed back as "every account"
       on the next launch, quietly, with the widget still claiming to be showing
       it. An unknown value is left standing and the face says it cannot find
       that account, which is the recoverable failure of the two. */
    if (p.from) return raw;
    return p.options.some((o) => o.value === raw) ? raw : p.def;
  }
  if (p.kind === "toggle") return typeof raw === "boolean" ? raw : p.def;
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : p.def;
  return clamp(Math.round(n / p.step) * p.step, p.min, p.max);
}

/** A widget as it came off disk, made drawable.
 *
 * Every read goes through here, which is the other half of the opaque column:
 * a knob that was renamed, a variant that was deleted, or a whole config that
 * would not parse degrades to something that draws rather than to a NaN inside
 * a frame loop. Returns null only for a kind nothing knows how to draw — that
 * is a widget from a newer build, and pretending it is a clock would be worse
 * than leaving it off the wall. */
export function normalizeWidget(raw: unknown): Widget | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const spec = typeof r.kind === "string" ? specFor(r.kind) : null;
  if (!spec) return null;

  const num = (v: unknown, def: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : def;
  const cfg = (r.config ?? {}) as Record<string, unknown>;
  const spot = spotOf(r as { glassX?: number | null; glassY?: number | null });

  const config: WidgetConfig = {};
  for (const p of paramsOf(spec)) config[p.key] = normalizeParam(p, cfg[p.key]);
  /* State is checked for being a finite number and otherwise left exactly as it
     was written. Emphatically not clamped the way a `number` knob is: an epoch
     has no range a catalogue could know, and rounding one to a step would move
     a timer's start by up to half a step every time it was read back. */
  for (const s of spec.state ?? []) {
    const raw = cfg[s.key];
    config[s.key] =
      typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, raw) : s.def;
  }

  return {
    id: typeof r.id === "string" && r.id ? r.id : uid(),
    kind: spec.kind,
    x: num(r.x, 0),
    y: num(r.y, 0),
    w: Math.max(spec.min.w, num(r.w, spec.box.w)),
    h: Math.max(spec.min.h, num(r.h, spec.box.h)),
    z: Math.round(num(r.z, 0)),
    /* Both or neither — half a pair is a row an older build wrote, and reads as
       being on the wall. Deliberately not clamped to the window the way a
       `number` knob is clamped to its range: a widget stuck to the glass on a
       wide screen has to come back where it was left when the window is wide
       again, so the squeeze belongs where it is drawn (`glassAt`). */
    glassX: spot?.x ?? null,
    glassY: spot?.y ?? null,
    config,
  };
}

/** A fresh widget of a kind, centred on a point — you aimed at a spot on the
 *  wall, not at a corner. */
export function newWidget(kind: WidgetKind, atX: number, atY: number, z = 0): Widget {
  const spec = specFor(kind);
  const box = spec?.box ?? { w: 190, h: 190 };
  return {
    id: uid(),
    kind,
    x: atX - box.w / 2,
    y: atY - box.h / 2,
    w: box.w,
    h: box.h,
    z,
    /* On the wall, like everything else that arrives — the glass is somewhere
       you put a thing on purpose, never somewhere a thing lands. */
    glassX: null,
    glassY: null,
    config: defaultConfig(kind),
  };
}

/* ── reading a config ──────────────────────────────────────────────────────
 *
 * A config is `Record<string, string | number | boolean>` because that is what
 * survives a JSON column honestly. These three keep the assertion in one place
 * instead of at every use. */

export function variantOf(w: Widget): string {
  const v = w.config[VARIANT];
  return typeof v === "string" ? v : (specFor(w.kind)?.params[0] as { def: string })?.def ?? "";
}

export function textOf(w: Widget, key: string, fallback = ""): string {
  const v = w.config[key];
  return typeof v === "string" ? v : fallback;
}

export function onOf(w: Widget, key: string, fallback = false): boolean {
  const v = w.config[key];
  return typeof v === "boolean" ? v : fallback;
}

export function numOf(w: Widget, key: string, fallback = 0): number {
  const v = w.config[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** How much of a frame this widget wears, as one word.
 *
 * It goes onto the node as `data-frame` and the whole of the styling hangs off
 * that attribute — one enum in the DOM rather than a pair of booleans, so the
 * state the pair would allow and nobody wants (an outline with the wall showing
 * through it) cannot be written. It is also then readable from a wall test,
 * which is the only way to see from outside that the knob reached a rule. */
export function frameOf(w: Widget): string {
  return textOf(w, FRAME, "framed");
}

/** Whether this clock is telling the time, and if not, what it is doing
 *  instead. Total both ways round — a knob spelled by an older build, and a
 *  pace `clock.ts` no longer knows, both read as the truth. */
export function paceIn(w: Widget): Pace {
  return paceOf(textOf(w, PACE, "real"));
}

/* ── instruments that run ──────────────────────────────────────────────────
 *
 * The bridge between a widget's flat config and `timing.ts`'s shapes. It is
 * here rather than in `timing.ts` so that file can stay import-free and the
 * catalogue can be built off its tables; and it is a handful of named functions
 * rather than inline indexing so a key spelled wrong is one place to fix rather
 * than four. */

/** The primary run — an `up` timer, a `down` timer, or a duo's `on` lane. */
export function runIn(w: Widget): Run {
  return { since: numOf(w, "since"), banked: numOf(w, "banked") };
}

export function duoIn(w: Widget): Duo {
  return {
    on: runIn(w),
    off: { since: numOf(w, "sinceOff"), banked: numOf(w, "bankedOff") },
  };
}

export function runPatch(run: Run): WidgetConfig {
  return { since: run.since, banked: run.banked };
}

export function duoPatch(duo: Duo): WidgetConfig {
  return {
    since: duo.on.since,
    banked: duo.on.banked,
    sinceOff: duo.off.since,
    bankedOff: duo.off.banked,
  };
}

/** What this timer counts down from, or null when it counts up.
 *
 * Null rather than zero, and it matters: `standing` reads null as "cannot ring"
 * and zero as "rang the instant it was hung up". A duo has no limit either — two
 * lanes racing a deadline is a different instrument, and not one anybody asked
 * for. */
export function limitIn(w: Widget): number | null {
  if (w.kind !== "timer" || variantOf(w) !== "down") return null;
  return lengthOf(textOf(w, "length", DEFAULT_LENGTH));
}

/** Does this kind of widget carry a clock that has to be held at launch and
 *  banked on the beat? Asked of the spec rather than of a list of kinds, so a
 *  future instrument that runs gets both by declaring `since`. */
export function runs(kind: string): boolean {
  return (specFor(kind)?.state ?? []).some((s) => s.key === "since");
}
