/* Providers: a card that runs on an agent service other than the subscription
 * Claude Code is signed in as. DeepSeek first.
 *
 * **A provider is not an account.** It is a sentinel in `conversation
 * .accountLabel` — the same column and the same shape as `@credits` — because
 * that field already answers "whose money does this card spend", and a
 * provider is a third kind of answer. `accounts::is_label` refuses `@`, so no
 * registered Claude account can collide with one. The Rust half is
 * `provider.rs`.
 *
 * **Why DeepSeek needs no adapter.** Its endpoint speaks the Anthropic
 * Messages API, so a provider card is the same `claude --print` child with
 * three variables pointed somewhere else. Nothing here parses a new event
 * vocabulary. Anything that does *not* speak that API (Codex, Gemini) would
 * need an adapter in `classify.ts` and a different spawn, and is deliberately
 * not pretended to be free.
 *
 * What this file is for: the one place the wall's vocabulary and the model
 * mapping live, so a menu, a card's chip, a context ring and a price cannot
 * disagree about what a deepseek card is.
 */

import type { Effort } from "./commands";
import type { Preset } from "./presets";

/** The sentinel `conversation.account_label` holds. Kept in step with
 *  `provider.rs::DEEPSEEK` by `test/providers.test.ts`, which reads that file. */
export const DEEPSEEK = "@deepseek";

export type ProviderId = "deepseek";

export type Provider = {
  id: ProviderId;
  /** What a menu and a card call it. Lowercase, house style. */
  label: string;
  /** What the store holds. Always one of the `@` sentinels. */
  account: string;
  /** One line on what choosing it means, for the row that offers it. */
  note: string;
  /** The models this provider offers, as ids the CLI accepts. A card picks one
   *  of these explicitly — `flash` and `pro` are two different balances being
   *  spent, not an effort knob on one model. */
  models: {
    /** When the card was opened with no model at all. */
    fallback: string;
    opus: string;
    sonnet: string;
    haiku: string;
  };
};

/** The table. One entry today; a second provider is a row here and a `Provider`
 *  in `provider.rs`, and the four places that ask `PROVIDERS` follow. */
export const PROVIDERS: Provider[] = [
  {
    id: "deepseek",
    label: "deepseek",
    account: DEEPSEEK,
    note: "billed per token",
    /* Read 2026-11-04 off DeepSeek's pricing page: both models carry a 1M
       window and a 384K output ceiling. `flash` is the everyday one and what
       the guide for Claude Code sets as the default; `v4-pro` is the dear end
       and what `opus` resolves to. No `[1m]` suffix — both are 1M already, and
       the window table in `classify.ts` knows the bare ids. */
    models: {
      fallback: "deepseek-flash",
      opus: "deepseek-v4-pro",
      sonnet: "deepseek-flash",
      haiku: "deepseek-flash",
    },
  },
];

/** The models a provider card can be opened on, as presets.
 *
 *  **This is how a provider and a model are chosen together.** There is no
 *  separate provider switch: the model menu lists these beside the five Claude
 *  rows, and picking one opens a card on that provider with that model — one
 *  gesture, and the row already says what it costs. A provider with one model
 *  would still have a row, because "on deepseek" is a choice about money and
 *  not a synonym for a model name.
 *
 *  `id` is what the store keeps (`conversation.model` is the model itself; the
 *  preset id is only remembered as the wall's default), so these can be renamed
 *  without orphaning a card. */
export const PROVIDER_PRESETS: Preset[] = [
  {
    id: "ds-flash",
    label: "a quick deepseek answer",
    note: "flash",
    model: "deepseek-flash",
    provider: "deepseek",
  },
  {
    id: "ds-pro",
    label: "the hard thing, on deepseek",
    note: "v4 pro · high",
    model: "deepseek-v4-pro",
    effort: "high" as Effort,
    provider: "deepseek",
  },
];

/** Which provider a card's label names, or null for an ordinary card. */
export function providerOf(label: string | null | undefined): Provider | null {
  const at = label?.trim();
  if (!at) return null;
  return PROVIDERS.find((p) => p.account === at) ?? null;
}

/** The predicate every guard uses, in the shape `onCredits` has. */
export function onProvider(label: string | null | undefined): boolean {
  return providerOf(label) !== null;
}

/** What a card's account line should say, or null when it is an ordinary card. */
export function providerName(label: string | null | undefined): string | null {
  return providerOf(label)?.label ?? null;
}

/** What a requested model becomes on this provider. */
export function providerModel(provider: Provider, model: string | null | undefined): string | null {
  const bare = model?.replace(/\[.*\]$/, "").trim().toLowerCase();
  if (!bare) return null;
  if (bare.startsWith("deepseek-")) return bare;
  if (bare.includes("opus")) return provider.models.opus;
  if (bare.includes("sonnet")) return provider.models.sonnet;
  if (bare.includes("haiku") || bare.includes("fable")) return provider.models.haiku;
  return provider.models.fallback;
}

/** The model the CLI is actually given, as a family alias.
 *
 *  **The provider's names are the wall's; Claude Code's are the wire's.** The
 *  CLI validates `--model` and `/model` locally and refuses an id it has never
 *  heard of (`[claude-code:unrecognized_model]`, observed on the first live
 *  card), so `deepseek-v4-pro` must never reach it. DeepSeek's Anthropic
 *  endpoint maps the families itself: `claude-opus*` → `deepseek-v4-pro`,
 *  everything else → `deepseek-flash`.
 *
 *  This is the mirror of `providerModel`, and the two are the only places the
 *  translation lives: display ids in, alias out at the spawn and at `/model`;
 *  alias in, display id out at `#adoptModel`. */
export function providerCliModel(provider: Provider, model: string | null | undefined): string {
  const bare = model?.replace(/\[.*\]$/, "").trim().toLowerCase() ?? "";
  if (bare.includes("v4-pro") || bare.includes("opus")) return "opus";
  if (
    bare.includes("flash") ||
    bare.includes("sonnet") ||
    bare.includes("haiku") ||
    bare.includes("fable")
  ) {
    return "sonnet";
  }
  return "sonnet";
}
