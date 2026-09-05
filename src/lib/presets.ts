/* What a card is set to before it has been asked anything.
 *
 * A conversation costs whatever the model and the effort behind it cost, and
 * both are decided *before* the first word — after that, changing them is a
 * `/model` and an `/effort` into a card that has already spent a full context
 * on its opening prompt. The wall's `+` opened every card on whatever Claude
 * Code happens to be configured for, which for most people is one setting doing
 * duty for a one-line question and a day-long refactor alike. One of those is
 * paying far too much and the other is being answered too cheaply, and you
 * cannot tell which from the card.
 *
 * So the `+` has a right-click, and these are what it offers. Each is a pairing
 * of a model with an effort and a sentence saying what it is for. There are
 * five on purpose: this is a menu to be read at the speed of starting work, and
 * a catalogue of every combination — six models against five levels — is a
 * decision rather than a shortcut.
 *
 * Pure, and the ids are what the store keeps, so a preset can be renamed
 * without orphaning the cards opened from it.
 */

import type { Effort } from "./commands";

export type Preset = {
  /** What a menu item and a stored row call it. Stable; the label is not. */
  id: string;
  /** In the menu, in the wall's voice: what you are about to start. */
  label: string;
  /** The pair itself, shown beside the label rather than described in it. The
   *  point of the menu is seeing what a card will cost before opening it. */
  note: string;
  /** What goes to `--model`.
   *
   *  An alias rather than a full id, deliberately: the CLI resolves it against
   *  whatever the newest model in that family is, so a preset does not go stale
   *  the week a new one ships. Probed 2026-08-20 against claude 2.1.233 —
   *  `opus` → `claude-opus-5`, `opus[1m]` → `claude-opus-5[1m]`, `sonnet[1m]` →
   *  `claude-sonnet-5[1m]`, `haiku` → `claude-haiku-4-5-20251001`, `fable` →
   *  `claude-fable-5`, each read back off `system/init`. The full id with its
   *  tier suffix round-trips too, which is what lets the resolved id be written
   *  to the row at the settling turn and passed straight back at the next wake. */
  model: string;
  /** What goes to `--effort`, where the model has one.
   *
   *  Optional because effort is not universal: the parameter is supported on
   *  the Opus, Sonnet and Fable families and **not on Haiku 4.5**, which is not
   *  in the docs' supported-models list. The CLI does not complain — probed
   *  2026-08-20, `--model haiku --effort low` ran a normal turn and reported
   *  no error — it simply drops it, which is worse than a failure for a menu
   *  whose whole job is to show what you are buying. So the haiku preset
   *  claims no level rather than a level that does nothing. */
  effort?: Effort;
};

/** The five, cheapest first.
 *
 * Ordered by what they cost rather than by how often they are wanted, because
 * the order is the only thing in the menu that says these are a scale. The
 * levels follow Anthropic's own per-model effort guidance (read 2026-08-20):
 * `high` is the API default and the documented starting point for Opus 5,
 * `xhigh` the step up "for demanding coding and agentic work", and `low` and
 * `medium` are named as "your primary control for token cost and response
 * time wherever your evals show quality holds" — which is what the cheap end
 * of this menu is for. The two
 * axes are not the same question — the model is how good the answer can be, the
 * effort is how much thinking is spent getting there — and each of these is a
 * point where both answers agree about the work.
 */
export const PRESETS: Preset[] = [
  {
    id: "ask",
    label: "a quick question",
    note: "haiku",
    model: "haiku",
    /* A name, a flag, what a file does. The cheapest card the wall can open,
       and the one the default setting overpays for most often. No effort: the
       parameter does nothing on this model — see the note on `effort`. */
  },
  {
    id: "work",
    label: "ordinary work",
    note: "sonnet · medium",
    model: "sonnet",
    effort: "medium",
    /* The everyday card: a small feature, a fix with its test, a rename across
       a few files. Where the `+` would land if it had one honest default. */
  },
  {
    id: "read",
    label: "reading a lot of it",
    note: "sonnet[1m] · medium",
    model: "sonnet[1m]",
    effort: "medium",
    /* Checking a claim across a codebase, or a long transcript held whole. The
       million-token window rather than a harder-thinking model: what this kind
       of work runs out of is room, and paying for effort instead buys a careful
       answer about the third of the material that fitted. */
  },
  {
    id: "bug",
    label: "a bug that has resisted",
    note: "opus · high",
    model: "opus",
    effort: "high",
    /* The obvious fix was not it. This is the first preset worth its cost —
       and it is deliberately not the 1M window, since a bug that needs the
       whole tree in front of it is the one below. */
  },
  {
    id: "deep",
    label: "the hard thing",
    note: "opus[1m] · xhigh",
    model: "opus[1m]",
    effort: "xhigh",
    /* Design, a migration, an audit — work where being wrong is expensive and
       the material does not fit in a small window.

       `xhigh` rather than `max`, which is the level this menu is most likely to
       get wrong. The effort docs describe `xhigh` as the tier for
       "long-running agentic and coding tasks (over 30 minutes) with token
       budgets in the millions", and say of `max`: "Reserve for genuinely
       frontier problems. On most workloads `max` adds significant cost for
       relatively small quality gains, and on some structured-output or less
       intelligence-sensitive tasks it can lead to overthinking." A menu exists
       to be picked from without thinking, so the level that is right only when
       you have measured it is the one that does not belong on it — `/effort
       max` is a keystroke away on a card that turns out to need it. */
  },
];

export function presetById(id: string | undefined): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** What the plain `+` opens a card as when nobody has ever said.
 *
 *  `deep` — opus[1m] · xhigh. The menu above orders these by cost and this is
 *  the dear end of it, which wants the argument said out loud rather than left
 *  to look like a slip.
 *
 *  The `+` used to open every card on whatever Claude Code was configured for,
 *  and the failure that has is not symmetric. A card that turns out to be a
 *  one-line question and was opened on opus costs a few cents more than it had
 *  to; a card that turns out to be a day's work and was opened on the cheap
 *  setting is answered worse for hours, and **nothing on the card says so** —
 *  you find out from the quality of what comes back, by which time the context
 *  is spent and `/model` is a new card in all but name. The cheap end of this
 *  menu is one right-click away and is where a quick question should start; the
 *  expensive end is the one you cannot retrofit.
 *
 *  `xhigh` rather than `high` is Anthropic's own recommendation for coding and
 *  agentic work specifically (effort docs, read 2026-09-05: start at `xhigh`
 *  there, `high` for most other intelligence-sensitive work), and it is not the
 *  overshoot `max` would be — see `deep`'s note above, which is why the scale
 *  stops one rung below.
 *
 *  This is a fallback, not a policy. It holds until the wall is told otherwise,
 *  and the wall remembers (`store::default_preset`). */
export const FALLBACK_DEFAULT_PRESET = "deep";

/** Resolve what the store holds into the preset a plain opening actually uses.
 *
 *  Three inputs and they are genuinely three, which is the whole reason the
 *  stored value is nullable:
 *
 *  - `null`/`undefined` — nobody has answered. The built-in default.
 *  - `""` — the user chose *as claude code is set up*, which is a choice and not
 *    an absence: no `--model`, no `--effort`, exactly what every card did before
 *    presets existed. `undefined` back, and the caller sends nothing.
 *  - an id — that preset, and the built-in default if this build has never heard
 *    of it. A retired preset is far likelier than a wall that meant "none", and
 *    falling through to "none" would silently downgrade every card opened after
 *    a rename. */
export function defaultPresetFor(stored: string | null | undefined): Preset | undefined {
  if (stored === null || stored === undefined) return presetById(FALLBACK_DEFAULT_PRESET);
  if (stored === "") return undefined;
  return presetById(stored) ?? presetById(FALLBACK_DEFAULT_PRESET);
}

/** What the `+`'s right-click offers, in the shape `menu.ts` takes.
 *
 *  Built here rather than in `menu.ts` for the reason the widget catalogue is:
 *  that file's business is what a right-click offers, not what a preset *is*. */
export function presetPicks(): { id: string; label: string; note: string }[] {
  return PRESETS.map((p) => ({ id: p.id, label: p.label, note: p.note }));
}
