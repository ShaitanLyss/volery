# Providers

A **provider** is which service a card spends. `claude` is the subscription the wall already
manages; `deepseek` is a balance on DeepSeek's own account, billed per token. A card is on one
provider for its whole life, chosen when it opens, and the choice is visible on the card.

This document is the reasoning. The code is `src-tauri/src/provider.rs` and
`src/lib/providers.ts`; the rule that fires when you open either is
`.claude/rules/providers.md`.

## A provider is not an account

`conversation.account_label` already answers *whose money does this card spend*, and it has
held a non-account before: `@credits`. A provider is the same shape, one rung out — a sentinel
refused by `accounts::is_label` (it refuses `@`), stored in the same column, and guarded by one
predicate at every site that would otherwise name a Claude credential store.

That is not a shortcut dressed as a design. It is the reason the provider itself needed **no
schema migration**. (The spending cap later grew one table, `provider_budget`, v60 — but the
card's provider still lives in `account_label`, and the cap is a separate fact.)

The sentinel today is `@deepseek`. `accounts.rs` cannot register a label that starts with `@`,
so no Claude account can collide with it — the same guarantee `@credits` relies on.

## Why DeepSeek needs no second event pipeline

DeepSeek publishes an **Anthropic-compatible Messages endpoint** at
`https://api.deepseek.com/anthropic`. A DeepSeek card is therefore the *same*
`claude --print --output-format stream-json` child Volery has always spawned: same stream, same
transcripts, same `--resume`, same hooks, same MCP servers, same presets. Only the endpoint,
the credential and the model names change.

`provider::apply` sets:

```text
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
ANTHROPIC_AUTH_TOKEN=<the key from the vault>
ANTHROPIC_MODEL=sonnet
CLAUDE_CODE_SUBAGENT_MODEL=sonnet
CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
CLAUDE_SECURESTORAGE_CONFIG_DIR=<an empty folder>
```

and removes `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CODE_ENTRYPOINT`
first, because each of those outranks something it is about to set. The empty store is the
second lock: with the token present it changes nothing, and for a build that one day stopped
honouring the variable it turns a silent fall-through to the machine's Claude sign-in into
`authMethod: "none"`. `credits::apply` strikes the identical bargain.

**The model on the wire is a Claude alias, and that is not cosmetic.** Claude Code resolves and
validates `--model`/`ANTHROPIC_MODEL` before it makes a request, and a name it does not know
dies as `[claude-code:unrecognized_model]` — found on the first live card, which had been
handed `deepseek-v4-pro`. DeepSeek's Anthropic endpoint maps the families itself
(`claude-opus*` → `deepseek-v4-pro`, everything else → `deepseek-flash`), so the wall stores and
draws DeepSeek's names and translates at the two boundaries: `provider::cli_model` (spawn) and
`providers.ts::providerCliModel` (`/model`). `providerModel` is the reverse, used when an id
comes back. The `ANTHROPIC_DEFAULT_*_MODEL` variables are deliberately **not** set: mapping an
alias to a provider id locally is exactly what the CLI then refuses.

**`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is deliberate.** A provider card must not talk to
Anthropic at all. The CLI's own update checks, telemetry and model-list fetches are not this
card's business, and with a DeepSeek token they would fail somewhere two hops from the cause.

**The env names are Claude Code's, and a typo is silent.** They were read out of the installed
binary (2.1.317), not guessed, and `test/providers.test.ts` holds the Rust and TypeScript sides
to the same strings. A mistyped name would read as the provider having no effect at all.

Anything that does **not** speak the Anthropic API — Codex, Gemini — would need a model
adapter in `classify.ts` and a different spawn. That seam is not pretended to exist here:
`classify.ts` is still "the file that grows an interface if a second backend matters", and a
provider that speaks a different protocol is a different feature.

## Choosing one, and choosing a model

There is no separate provider switch. **A provider and a model are one decision**, so the model
menu lists the provider's models as presets:

```text
a quick question          haiku
reading a lot of it       sonnet[1m] · low
ordinary work             sonnet[1m] · medium
a bug that has resisted   opus[1m] · high
the hard thing            opus[1m] · xhigh
──────────────────────────
a quick deepseek answer   flash · 1m
the hard thing, on deepseek  v4 pro · 1m
──────────────────────────
as claude code is set up
```

The same rows are the `+`'s right-click and chat view's model chip, because both read
`presets.ts::presetPicks` / `starting.ts::presetRows`. Picking `deepseek pro` opens a card on
DeepSeek with `deepseek-v4-pro`; picking `deepseek flash` opens one on `deepseek-flash`. The
choice is also the wall's default if ctrl-clicked on the `+`, which means a wall can open every
new card on DeepSeek without a second setting.

The provider's own names are `deepseek-flash` and `deepseek-v4-pro`. Both carry a 1M window and
a 384K output ceiling (read 2026-11-04). `flash` is the everyday model; `pro` is the dear end
and is what a Claude `opus` alias resolves to. `classify.ts`'s window table knows both, and an
id it has never heard of is **1M by default** — the ring would otherwise read 100% on a card
with four fifths of its window left. The same change fixed the Claude side of that bug: the
ids the wire actually stores (`claude-opus-5-5`, `claude-sonnet-5-5`) are 1M whatever suffix
they carry, and the 200k families are named in the table rather than assumed from a missing
`[1m]`.

### Spawned cards

`mcp__skein__spawn` takes `provider` beside `model`, `effort`, `account` and `computer`, so an
agent can open a DeepSeek lane deliberately rather than only a person clicking a menu:

```json
{ "provider": "deepseek", "model": "flash", "effort": "low", "prompt": "..." }
```

Rules, all refused before a card is minted:

- `deepseek` takes `flash` or `pro`; a Claude family name is refused rather than mapped.
- Omitting `provider` and naming `flash` or `pro` infers `deepseek`; naming `haiku`, `sonnet`
  or `opus` infers `claude`.
- A DeepSeek card cannot name an `account` — its money is not a Claude subscription.
- A DeepSeek card cannot be asked for on another wall (`host`): the key lives on the wall that
  runs the card, and credentials never cross (`flyway`). The refusal names that.
- `effort` works on both DeepSeek models; `haiku` still takes none.

## The guards, and why each one exists

`@credits` needed the same list; a provider is a third sentinel and the cost of missing one is
not symmetrical.

| site | without the guard |
|---|---|
| `supervisor.rs` spawn | `@deepseek` reaches `accounts::usable_store` and is refused as an account that is not signed in — true, and not the question. The key is never applied. |
| `aside.rs` (`/btw`) | a side question on a DeepSeek card silently runs on the Claude sign-in. |
| `Skein.#settleAccount` | the account ladder treats it as an unusable account: it either moves the card onto a subscription it did not ask for or parks the prompt because every Claude window is spent. |
| `Skein.#spend` / `#observe` | a DeepSeek refusal or rate-limit event marks a phantom account called `@deepseek` in the waterfall. |
| `Skein.putOnAccount` | `/account` tries to resume a DeepSeek transcript on a Claude account whose model cannot reach it. Refused, with words. |
| `admit.rs` `queued` / `held_for` | the spawn and the wake wait for a Claude window the card does not spend. This was the one that would have bitten exactly when it mattered: every Claude account spent, and DeepSeek is the thing you reach for. |
| `limits.rs::do_allowance` | the `allowance` tool reports "no subscription could be read", hedging about a sign-in that was never meant to exist. It now says the balance is on DeepSeek's account and this wall cannot read it. |
| `Card.svelte` / `ChatView.svelte` | the card draws no funding word, or draws `@deepseek` as if it were an account name. |

`admit.ts::facetOf` is not in the table because a provider card never reaches it: the skip is
at `#settleAccount`, one door earlier, which is the same place a wall with no accounts is let
through.

## Money

`usage.ts` prices DeepSeek's two models from the published table, at **peak** rates:

| model | input | output | cache read | off-peak |
|---|---|---|---|---|
| `deepseek-flash` | $0.30 | $1.20 | 0.02× input | half |
| `deepseek-v4-pro` | $1.32 | $3.96 | 0.0333× input | half |

Peak is 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday. `rateAt(model, at)` halves the rate
outside it; `rateFor(model)`, which has no clock, answers the peak one — the direction that
overstates rather than understates. Chinese public holidays are not known here, so a holiday
turn is priced at peak (again, the safe direction).

**Two spend figures, and they must not disagree.** The title bar is `SUM(turn.usd)`, which is
the CLI's own `total_cost_usd`. The CLI prices Claude models from a table of its own; it has no
row for `deepseek-*`, so it reports zero. `Conversation` therefore fills that zero from
`usage.ts::priceOf` for a provider card — and only the zero case, so a provider that one day
reports its own bill wins — and advances the card's own `costUsd` by the same step, so the
transcript's cost line and a shadow's published figure are not zero either. The usage widget
prices each five-minute slice at its own clock; the fallback prices the turn at its end, so the
two can differ only for a turn that straddles a peak boundary (04:00 or 10:00 UTC).

## The balance, and the wall's own limit

DeepSeek publishes `GET /user/balance`, so the amount left is knowable — it is not an allowance
of windows, it is money. The keyring reads it **on open and on demand, never on a clock**:
DeepSeek announces no change, and a balance that nobody is looking at is not worth capacity.

The **limit is Volery's own**, because DeepSeek has no server-side spend-limit API. It is a
dollar cap stored in `provider_budget` (schema v60), enforced in `deliver_blocks` — the one door
every prompt goes through, so a typed turn, a spawned brief, a subscription wake and a relay
message are all covered. The cap's clock starts when a cap is first set and survives being
raised; zero clears it. The keyring row shows the balance, what this wall has spent since the
clock started, and the field to set the cap.

Not supported: the allowance stack. There is no OAuth token and no `/api/oauth/usage` for
DeepSeek, so the card has no five-hour or weekly windows. That is the documented graceful path
for Bedrock, Vertex and a bare API key, and it is not a fault.

## Moving a card between providers — slash and right-click built (2026-11-04)

The ask: take one conversation from Claude to DeepSeek and back, by slash command,
the card's right-click or an agent tool, keeping what matters. All three exist;
the agent tool asks from inside a turn and the wall makes the move after the result.

### The seam is already there

`provider::apply` sets `CLAUDE_SECURESTORAGE_CONFIG_DIR`, **not** `CLAUDE_CONFIG_DIR`
(`supervisor.rs` has the probe). The credential store moves; the transcript does not.
Both providers write `~/.claude/projects/<slug>/<session>.jsonl`, and the `--resume` an
account swap already uses finds the same session on the other side. A move is therefore:
end the child, write the new label, home and model, spawn again with `--resume`. The
session id, transcript, tools, files and children stay exactly where they were.

### What does not transfer: thinking blocks

DeepSeek's Anthropic endpoint refuses a tool-use history containing thinking blocks:
`content[].thinking … must be passed back to the API` ([cc-switch
#3263](https://github.com/farion1231/cc-switch/issues/3263)). Claude Code's blocks are
Anthropic-signed, DeepSeek's are its own; neither is valid for the other. The CLI bundle
names `MAX_THINKING_TOKENS=0` as the switch that turns thinking off (its own refusal text
says "unset MAX_THINKING_TOKENS=0" to turn it back on), and `provider::apply` now sets it.
A DeepSeek turn therefore produces no thinking blocks, and the round-trip 400 is closed at
the source.

**Claude's existing thinking blocks are never replayed to the API.** Probed 2026-11-04
against claude 2.1.318: a copied session carrying five signed `thinking` blocks was resumed
against a local stand-in endpoint with the provider's own environment. The request carried
**zero** `thinking` blocks — with thinking on, with `MAX_THINKING_TOKENS=0`, and with the
session's own model (`sonnet`). The CLI keeps the blocks in the JSONL and strips them from
the request. That settles the design:

- DeepSeek never receives Claude's blocks, so there is nothing to strip, no sidecar, and no
  session rewrite. The move is just `--resume` with the other environment.
- Coming back to Claude, the blocks are still in the file, but the CLI will not send them
  there either. They are preserved as the record of what was thought; they are not a context
  the model can resume. That is the CLI's limit, not this wall's, and it is the honest half
  of the user's blob idea.
- DeepSeek's **own** thinking is off (`MAX_THINKING_TOKENS=0`), because its endpoint refuses
  a tool-use turn whose thinking blocks it did not receive in the form it expects.

The same copied session resumed against the stand-in and completed a turn after the
endpoint changed, which is the move's mechanism in one line: same session, different base
URL, transcript and tools intact.

### Home, model, money

- To DeepSeek: the provider's fallback model (`deepseek-flash`), written with the label in
  one `set_conversation_mode` — the row must not resume a Claude card on a `deepseek-*`
  id, or a DeepSeek card on a Claude one.
- Back to Claude: the model is cleared (`None`, which `COALESCE` cannot express, hence the
  command) and the label is `null` — the CLI's own sign-in. A wall that manages accounts
  has the waterfall put it on one at the next send, which is the one choice this gesture
  deliberately does not guess.
- The exact account and model a card left are **not** remembered yet. If a move back needs
  to land on the same subscription, that is two columns (`provider_home`,
  `provider_home_model`) and a rung; the session does not depend on it.
- The provider cap and balance apply while there; the Claude account's caps are untouched.

### The three gestures

- **Slash**: `/provider claude|deepseek`, derived from the `provider` verb
  (`handle.ts::VERB_SLASH`); the card's process ends and resumes, so it is `by: "skein"`.
- **Right-click**: *run it on…* with `claude code` and every provider, the current row
  marked, offered on provider cards too. A provider with no key still has a row; the move
  refuses with the keyring sentence rather than hiding the choice.
- **Agent**: `set_provider` (`provider::set_provider_schema`). It never ends a child from
  inside its own tool call: it emits `provider:move` to the front end, which holds the
  request until the turn's `result`, then runs the same stop-and-resume as the gestures.
  It moves the caller's own conversation (a child would be a second kind of request); the
  call needs a provider whose key is already in the keyring.

### What remains to be probed

One real Claude → DeepSeek → Claude turn with the user's key, to see DeepSeek's own
responses and prices. The session mechanism, the thinking behaviour and the request the CLI
builds have all been probed without it; what a key adds is DeepSeek's answer, not a new
question about the conversation.

## What this deliberately does not do

- **No remote spawn on a provider.** A remote `spawn` on DeepSeek is refused with words
  rather than opened against a key the far machine may not have. A **move** is different: it
  crosses as a work act, the owner checks its own key and does the stop/resume, and the key
  never travels. That is the remote-unblock case (`flyway/act.rs`, `Elsewhere.#perform`).
- **No account interface for the key.** The key is an integration (`creds.rs`), not an
  account: it is stored in the Windows vault under `dev.skein.studio/deepseek-key`, read at
  spawn, and never handed to a card as a lendable credential.
- **No Codex or Gemini.** They do not speak the Anthropic Messages API, so they need a real
  adapter rather than an env overlay. The provider table is the place that would grow, and
  `classify.ts` is the file that would grow the interface.

## Adding a provider that *does* speak the API

1. A `Provider` row in `provider.rs` (label, key service, base URL, model mapping) and one in
   `providers.ts` with the same values.
2. A `creds.rs` `Service` entry and an `integrations.ts` row whose `target` is byte-identical;
   `test/integrations.test.ts` is what catches drift between them.
3. Two presets in `providers.ts::PROVIDER_PRESETS`, one per model.
4. `SPAWN_PROVIDERS` and `PROVIDER_MODELS` in `spawn.rs`, and the same two model names in
   `presets.ts::PROVIDER_SPAWN`.
5. Rows in `classify.ts::WINDOWS` and `usage.ts::RATES`.
6. Run `bun run test`, `bun run check`, `bash tools/check-gnu.sh`, and one live turn.

## What was verified, and what was not

Verified on 2026-11-04 against claude 2.1.317, without spending a token:

- A local listener posing as `api.deepseek.com/anthropic` received
  `POST /v1/messages` with `model=deepseek-flash`, `Authorization: Bearer …` and
  `anthropic-version: 2023-06-01` from the installed CLI — the env path and the model env are
  real.
- `ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_` / `_HAIKU_` exist in the installed binary.
- The project-settings route (a `.claude/settings.local.json` carrying the env) was attempted
  and did **not** produce a request before the probe was stopped, so it is not reported as
  working. It is rejected on security grounds regardless: it puts the key in a plaintext file
  in a repository. The vault and the child's environment are the chosen path.

Not verified here: a live DeepSeek turn, which needs a key the user adds in the keyring after
the build. The things to watch on that first turn are in the next section.

### The first live turn

1. Does `system/init` report the Claude alias or a `deepseek-*` id? Either is mapped by
   `providerModel`, so the ring should be right; the transcript's own model line is the thing
   to read.
2. Does `result.total_cost_usd` come back non-zero? If it does, the title bar is the CLI's
   figure and the fallback does nothing. If it is zero, `priceOf` fills it.
3. Does `cache_read_input_tokens` arrive? DeepSeek prices cache hits separately, and the table
   carries the 0.02× / 0.0333× ratios; `cache_creation_input_tokens` is documented as 0, so
   the 1.25×/2× cache-write multipliers never apply.
4. Does a tool call survive? DeepSeek's compatibility table supports client tool use and
   requires the assistant's `thinking` blocks back; the CLI does that for its own endpoint, and
   this is the one place a proxy can differ in a way that only shows mid-turn. The hooks and
   MCP servers are local and unaffected.
