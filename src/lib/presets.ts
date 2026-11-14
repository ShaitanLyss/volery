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
 * of a model with an effort and a sentence saying what it is for. There are six
 * on purpose: five rungs of the Claude families, cheapest first, and one fable
 * row at the end for the work where you want the frontier rather than the
 * everyday model. A catalogue of every combination — every family against five
 * levels — is a decision rather than a shortcut.
 *
 * Pure, and the ids are what the store keeps, so a preset can be renamed
 * without orphaning the cards opened from it.
 */

import { isEffort, type Effort } from "./commands";
import { PROVIDER_PRESETS, SPAWN_ONLY_PRESETS, type ProviderId } from "./providers";

export type Preset = {
  /** What a menu item and a stored row call it. Stable; the label is not. */
  id: string;
  /** In the menu, in the wall's voice: what you are about to start. */
  label: string;
  /** The pair itself, shown beside the label rather than described in it. The
   *  point of the menu is seeing what a card will cost before opening it. A
   *  model alias's `[1m]` suffix is not shown: every family here is on the wide
   *  window and the tier was never a price. */
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
  /** Whether this model has no effort level at all, as against one whose level
   *  nobody has said. Haiku is the only one: the parameter is dropped silently
   *  there, which is worse than a refusal for a menu whose job is showing what
   *  you are buying. A provider's models all take one. */
  effortless?: boolean;
  /** Which provider this row opens a card on. Absent is Claude Code's own
   *  subscription, which is every row above it; a provider row names the
   *  service whose balance it spends. The provider is a fact about the preset
   *  rather than a second menu, so choosing `deepseek pro` chooses both at
   *  once. */
  provider?: ProviderId;
};

/** The six, cheapest first.
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
    effortless: true,
    /* A name, a flag, what a file does. The cheapest card the wall can open,
       and the one the default setting overpays for most often. No effort: the
       parameter does nothing on this model — see the note on `effort`. */
  },
  {
    id: "read",
    label: "reading a lot of it",
    note: "sonnet · low",
    model: "sonnet[1m]",
    effort: "low",
    /* Checking a claim across a codebase, or a long transcript held whole. What
       this kind of work runs out of is *room*, not thinking — so the window is
       the whole of what this row buys and the level is the cheap end, which is
       the honest pairing for it: a card asked to hold a million tokens and
       reason hard about all of them is a card spending the dear axis on a job
       whose difficulty is bookkeeping.

       It was `medium`, which made it `work` with a wider window — and once the
       window stopped being something you pay for (below), that was two rows
       doing one thing. Now the two sonnet rows differ by effort, exactly as the
       two opus rows do, and the menu reads as one scale rather than two axes
       half-crossed. */
  },
  {
    id: "work",
    label: "ordinary work",
    note: "sonnet · medium",
    model: "sonnet[1m]",
    effort: "medium",
    /* The everyday card: a small feature, a fix with its test, a rename across
       a few files. Where the `+` would land if it had one honest default.

       On the wide window, and for the reason `bug` is: **the tier is not a
       price**. Read 2026-09-30 off the pricing docs' long-context section —
       "Claude 4.6 and later models … include the full 1M token context window
       at standard pricing. (A 900k-token request is billed at the same
       per-token rate as a 9k-token request.)" — so holding it back bought
       nothing and cost the card room. What it cost was not hypothetical: the
       everyday card is the one that gets handed a long file halfway through and
       compacts, and a compaction in the middle of ordinary work throws away the
       context the work was standing on. */
  },
  {
    id: "bug",
    label: "a bug that has resisted",
    note: "opus · high",
    model: "opus[1m]",
    effort: "high",
    /* The obvious fix was not it. This is the first preset worth its cost, and
       the wide window is now part of it: `opus` and `opus[1m]` are the same
       $5/$25 per MTok — one row in the price table, no long-context premium —
       so holding back the 1M window bought nothing and cost the card room.
       Which is the shape of the bug this preset is for: the obvious fix was not
       it, so the answer is somewhere you have not looked yet, and a card that
       compacts halfway through looking has lost the half it already read. The
       row below is still a different preset, because what separates them is the
       effort rather than the window. */
  },
  {
    id: "deep",
    label: "the hard thing",
    note: "opus · xhigh",
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
  {
    id: "frontier",
    label: "frontier performance",
    note: "fable · xhigh",
    model: "fable",
    effort: "xhigh",
    /* The fable family at the top of its effort scale: the second frontier
       option, beside `deep`, for the work where the model's own frontier is
       the point. Fable 5.2 carries the 1M window in the family itself, which
       is why the note has no tier suffix — nor do the four above it, since
       every family here is on the wide window and the suffix was never a
       price. */
  },
];

export function presetById(id: string | undefined): Preset | undefined {
  return (
    PRESETS.find((p) => p.id === id) ??
    PROVIDER_PRESETS.find((p) => p.id === id) ??
    /* A preset no menu offers, which a spawn can still name — see the note on
       `SPAWN_ONLY_PRESETS`. Resolved so a card opened on `pro` displays as one;
       never listed, so nobody is offered an effort it does not take. */
    SPAWN_ONLY_PRESETS.find((p) => p.id === id)
  );
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
  return [...PRESETS, ...PROVIDER_PRESETS].map((p) => ({ id: p.id, label: p.label, note: p.note }));
}

/* ── the four names an agent may spawn a card on ────────────────────────────
 *
 * `mcp__skein__spawn` lets one card open another, and until now every card
 * opened that way ran on whatever Claude Code is configured for on this
 * machine — one setting standing in for a rename across four files and a
 * migration alike. That is the same complaint the `+`'s right-click answers,
 * arriving through the one door that has no right-click: a parent deciding to
 * fan a job out knows better than any global default which pieces are cheap,
 * because it is the thing that divided them up.
 *
 * **Four names rather than the six presets**, and the cut is deliberate.
 * A preset id is Skein vocabulary — `ask`, `work`, `read`, `bug`, `deep`,
 * `frontier` — and an agent choosing between them has to have read
 * `presets.ts` to know that `read` is a window rather than a mode. A model
 * family is vocabulary the caller already has: it knows what haiku costs and
 * what opus is for, from the same knowledge that made it decide the piece was
 * small. So the tool takes the word everybody already shares and this table
 * turns it into the pairing the menu would have picked, effort and window
 * included — which is the half an agent naming a bare `--model` would have got
 * wrong for free.
 *
 * Mapping to a preset rather than straight to `--model` is what buys that
 * second half. `sonnet` alone is sonnet at whatever effort the CLI defaults to;
 * `work` is sonnet at `medium`, which is a judgement somebody made about the
 * pair. And it keeps one table: change what `ordinary work` means and the cards
 * an agent opens change with it, rather than drifting a week later.
 *
 * **The effort is a default and not a fixture**, which is the one thing this
 * arrangement got wrong for its first life. A bundled pairing is the right
 * *starting* answer and the wrong *only* answer: the parent is the thing that
 * decomposed the job, so it is the one party that knows which lanes are
 * mechanical, and a lane that is mechanical does not get better at a harder
 * level — it only costs more, once per card, inside whatever budget the user
 * set. So `spawn` takes an optional `effort` beside `model`, the levels are the
 * ones `/effort` already takes (`EFFORT_LEVELS`), and leaving it off lands on
 * the row below. Found the expensive way, with five cards on the wall running
 * `xhigh` against a capped window budget — sink `564bd55d`.
 */

/** The four, as `spawn`'s schema offers them and in the order it does. */
export const SPAWN_MODELS = ["haiku", "sonnet", "opus", "fable"] as const;

export type SpawnModel = (typeof SPAWN_MODELS)[number];

/** Which preset each of the four names, and why that one.
 *
 *  These are the **defaults** — what a name means when the caller said nothing
 *  about effort. Naming one overrides the level and keeps everything else the
 *  row decided; see `presetForSpawn`.
 *
 *  - `haiku` → **ask**, the only preset on that model, and the only one that
 *    claims no effort — the parameter does nothing there (see `Preset.effort`).
 *  - `sonnet` → **work**, sonnet[1m] · medium. Not `read`, which is now the
 *    cheap-thinking row rather than the wide-window one: the window comes with
 *    the family either way, since the tier is not a price (see the `work` row).
 *    That matters more here than at the `+`, because there is no argument on
 *    this tool that says *window* — a parent who wanted room could not ask for
 *    it, so the name has to carry it. A spawned card is always doing work
 *    somebody else scoped and cannot ask for more room the way a card with a
 *    person in front of it can.
 *  - `opus` → **bug**, opus[1m] · high. The wide window, because that is not a
 *    price tier (`menu.md`), and `high` rather than `xhigh` because **the
 *    argument that puts the user's own `+` at the dear end runs backwards
 *    here.** `FALLBACK_DEFAULT_PRESET` is `deep` on the asymmetry that a card
 *    opened too cheap is answered worse for hours and nothing says so — which
 *    holds when a *person* clicks `+` not knowing yet what the card is for. A
 *    spawned card is the opposite case: the parent divided the job up, wrote
 *    the brief, and knows what this lane is. An implementation lane briefed in
 *    full does not get better at `xhigh`, and a card opened by an agent is one
 *    of several — so the overspend is multiplied by the fan-out and lands
 *    inside a budget somebody set. `high` is Anthropic's documented starting
 *    point for Opus 5; `xhigh` is one word away for the piece that earns it.
 *    Sink `564bd55d`, where five spawned cards ran `xhigh` because nothing
 *    could say otherwise.
 *  - `fable` → **frontier**, fable · xhigh. The other frontier family, at the
 *    top of its scale: a spawned card is the parent's lane, and a caller who
 *    knows the piece is cheaper names a lower level.
 */
const SPAWN_PRESET: Record<SpawnModel, string> = {
  haiku: "ask",
  sonnet: "work",
  opus: "bug",
  fable: "frontier",
};

/** The preset a card an agent opened is set up as, or `undefined` for none.
 *
 *  `undefined` is the whole of what a spawn was before this existed — no
 *  `--model`, no `--effort`, the machine's own setting — and it is what an
 *  omitted `model` still means. It is deliberately *not* the wall's default
 *  preset: that setting is the answer to "what does my `+` open", and a card an
 *  agent asked for is not a card the user clicked for. Silently spending the
 *  dear end of this menu on every spawned card would be the one change here
 *  nobody chose.
 *
 *  `effort` is the second half of the pair, and it overrides the row's level
 *  while keeping the row's *window* — which is the whole reason this still
 *  resolves through a preset rather than building a pair from two strings. The
 *  caller names a family and a level; which window that family gets is a
 *  judgement this table made and the caller has not read. Asking for the level
 *  the row already holds gives the row back unchanged, so `opus` and
 *  `opus`+`high` are the same preset and not two ids meaning one thing.
 *
 *  A synthesized row's `id` is not a menu row and nothing stores it — `#openIn`
 *  writes `model` and `effort` onto the conversation and never the id. It is
 *  spelled `<base>·<effort>` so that anything that does print one says which
 *  pairing it was rather than claiming to be a preset you could pick.
 *
 *  An unrecognised name degrades to `undefined` rather than throwing. `do_spawn`
 *  has already refused anything but the four by the time this is reached, so
 *  this is the normalizer's usual bargain (`CLAUDE.md`, opaque JSON columns):
 *  a build that gains a fifth name before this table does opens a card on the
 *  machine's setting instead of failing to open one. An unrecognised *effort*
 *  degrades the same way, to the row's own level — a card on the right model at
 *  the wrong level is recoverable, and a refusal here would be a refusal after
 *  Rust already accepted the word, which is a seam saying two things. */
export function presetForSpawn(
  asked: string | null | undefined,
  effort?: string | null,
  /** Which provider the caller named, if any. A provider's model names are its
   *  own (`flash`, `pro`), so they are mapped here rather than through
   *  `SPAWN_PRESET`, which is Claude's four families. Naming `flash` or `pro`
   *  without a provider infers DeepSeek: the words mean nothing on Claude and
   *  the alternative is refusing a request whose meaning is plain. */
  provider?: string | null,
): Preset | undefined {
  const name = asked?.trim().toLowerCase();
  const named = provider?.trim().toLowerCase() || null;
  const providerish = named ?? (name === "flash" || name === "pro" || name?.startsWith("deepseek-") ? "deepseek" : null);
  if (providerish === "deepseek") {
    const base = presetById(name ? PROVIDER_SPAWN[name] : "ds-flash");
    if (!base) return undefined;
    return withEffort(base, effort);
  }
  if (!name) return undefined;
  const id = SPAWN_PRESET[name as SpawnModel];
  const base = id ? presetById(id) : undefined;
  if (!base) return undefined;
  return withEffort(base, effort);
}

/** The pair, with the caller's level over the row's where the model takes one.
 *
 *  `undefined` effort, the row's own level, or a model with no effort at all
 *  gives the row back unchanged. Haiku's is the case that matters: the CLI drops
 *  `--effort` silently there, so a synthesized row would *claim* a level that
 *  did nothing. `do_spawn` refuses that pairing before it gets here; this is the
 *  second half of one answer. */
function withEffort(base: Preset, effort?: string | null): Preset {
  const level = effort?.trim().toLowerCase();
  if (!level || !isEffort(level) || level === base.effort || base.effortless) return base;
  return { ...base, id: `${base.id}·${level}`, note: `${base.model} · ${level}`, effort: level };
}

/** A provider's model name as the preset that opens it. Its own table because
 *  the names are the provider's (`flash`, `pro`), not Claude's families, and
 *  mixing the two would let `opus` open a DeepSeek card by accident. */
const PROVIDER_SPAWN: Record<string, string> = {
  flash: "ds-flash",
  pro: "ds-pro",
  "deepseek-flash": "ds-flash",
  "deepseek-v4-pro": "ds-pro",
};

/** What a preset row becomes on the wire to another wall: one of `spawn`'s
 *  four family names and a level, or nulls for *as claude code is set up*.
 *
 *  A section's menu offers **this wall's** presets for a card opened on another
 *  (Lyss: *"spawn remote cards based on my local presets and default preset"*),
 *  and the wire carries `spawn`'s vocabulary rather than a `--model` string —
 *  the far wall resolves the pair through its own `presetForSpawn`, which keeps
 *  the family's window. Every row here round-trips to its own model and effort
 *  that way (`test/presets.test.ts` holds it), so `deep` arrives as opus[1m] ·
 *  xhigh and not as `bug`. A model outside the four, or a level on a family
 *  that takes none, degrades to the family alone and then to nulls — the far
 *  wall would refuse the pair otherwise, and a card on the right model at its
 *  own level beats no card. */
export function spawnPairOf(
  preset: Pick<Preset, "model" | "effort" | "provider"> | null | undefined,
): { model: string | null; effort: string | null; provider: ProviderId | null } {
  /* A provider's **name** travels and its key does not: the far wall runs the
     card on its own keyring, and refuses before anything opens if it holds
     none (`fleet::missing` over `needs`). So a provider preset crosses as the
     provider alone, with no model — the far wall's `presetForSpawn` resolves
     its default (`flash`) from it — rather than degrading to a `null` pair,
     which would open an ordinary Claude card there and spend the wrong money. */
  if (preset?.provider) return { model: null, effort: null, provider: preset.provider };
  const family = preset?.model.replace(/\[.*\]$/, "").trim().toLowerCase();
  if (!family || !(SPAWN_MODELS as readonly string[]).includes(family)) {
    return { model: null, effort: null, provider: null };
  }
  const base = presetById(SPAWN_PRESET[family as SpawnModel]);
  return {
    model: family,
    effort: base?.effort && preset?.effort ? preset.effort : null,
    provider: null,
  };
}
