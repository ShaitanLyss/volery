---
paths:
  - "src-tauri/src/provider.rs"
  - "src/lib/providers.ts"
  - "src-tauri/src/spawn.rs"
  - "src-tauri/src/supervisor.rs"
  - "src-tauri/src/aside.rs"
  - "src-tauri/src/admit.rs"
  - "src-tauri/src/limits.rs"
  - "src/lib/presets.ts"
  - "src/lib/starting.ts"
  - "src/lib/classify.ts"
  - "src/lib/usage.ts"
---

# Providers

A card spends one service for its whole life. `claude` is the subscription the wall already
manages; `deepseek` is a balance on DeepSeek's own account, billed per token. The design is
`docs/PROVIDERS.md`; this is what will bite you while editing the code.

## A provider is a funding sentinel, not an account

`conversation.account_label` already answers *whose money does this card spend* and has held a
non-account since `@credits`. `@deepseek` is the same shape: refused by `accounts::is_label`
(it rejects `@`), stored in the same column, read back by `spawn_conversation`'s existing
argument. **There is no `provider` column and no migration.** If you find yourself adding one,
you are rebuilding a road that is already paved.

One predicate, `provider::is_provider` / `onProvider`, guards every site that would otherwise
name a Claude credential store. The list is in `docs/PROVIDERS.md`; the two that make the
process are `supervisor.rs`'s spawn block and `aside.rs`'s copy of it. Missing either is not a
cosmetic bug: the sentinel reaches `accounts::usable_store`, which refuses it as an account that
is not signed in.

## DeepSeek rides the same child

DeepSeek speaks the Anthropic Messages API at `https://api.deepseek.com/anthropic`, so a
DeepSeek card is the same `claude --print` child — same stream, sessions, `--resume`, hooks,
MCP. `provider::apply` sets the base URL, the token, the five model variables and an **empty**
`CLAUDE_SECURESTORAGE_CONFIG_DIR`, and removes `ANTHROPIC_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CODE_ENTRYPOINT` first. Each of those outranks something
being set; the empty store is the second lock against falling through to the machine's sign-in.

**`MAX_THINKING_TOKENS` is gone from a provider card, because it was what clamped the effort.**
The CLI already maps `--effort` onto `output_config.effort` — the dial DeepSeek reads — and then
refuses to raise it while thinking is mechanically disabled, in the installed bundle's own
words: *"output_config.effort '<x>' clamped to '<y>': thinking is mechanically disabled for this
request, and this model rejects higher effort when thinking is disabled"*
(`effort_thinking_disabled_clamp`, 2.1.325). A zero budget is what disabled it. Probed
2026-11-13 (`tools/probe-deepseek-effort.ts`, `docs/DEEPSEEK-EFFORT.md`): with the variable
unset a CLI probe saw high think above low (medians 999 vs 554 characters); the provider's own
API moves flash 314/544/772 output tokens at low/high/max. So deepseek flash has **three menu
rows — low, high and max — and not five**: the provider maps `medium` and `xhigh` onto `high`,
and two rows that buy one run are a menu lying about its resolution.

**The replay concern that variable was added for never rested on it.** Probed 2026-11-04
against a copied session: the CLI keeps the signed blocks in the JSONL and strips them from the
request, with thinking on or off. So DeepSeek reasons, the turn still replays, and nothing here
needs to suppress thinking. `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1` rides with a provider card
because the bundle gates effort on a model it recognises (its own line is
`if(i.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT)return!0`) and a provider's ids are not among them;
`withhold` takes it off every ordinary card, where effort accepted on a family that drops it
silently is the failure the preset table exists to avoid.

**And the provider API's Pro id is `deepseek-v4-pro`.** `deepseek-v4-pro-0813` answers 400
there. BenchLM spells the same model `deepseek-v4-pro-max` in its catalogue, which is why
`benchmarks.ts::ALIASES` maps the wall's name to *that* key: the catalogue's key and the
provider's id are two namespaces and neither is a correction of the other.

**Inline tools are off for a provider card** (`CLAUDE_CODE_INLINE_TOOLS=0`, 2.1.280+, removed
again by `withhold`). From 2.1.286 the CLI can put a deferred MCP tool's whole schema in a
system message as a `tool_definition` block; DeepSeek's endpoint only knows `tool_reference`, and
its 422 does not match the CLI's fallback string, so the card sticks at the first tool search.
`0` keeps tool search on and sends references instead. Probed on 2.1.318: `1` adds the
`inline-tools-2026-09-15` beta header, `0` does not. This is a CLI/DeepSeek interop bug, not
Volery's; see [DeepSeek-V3 #1701](https://github.com/deepseek-ai/DeepSeek-V3/issues/1701).

**The env names are Claude Code's, not ours.** They were read out of the installed binary
(2.1.317) and `test/providers.test.ts` holds this file and `providers.ts` to the same strings.
A typo here is a variable the CLI ignores, which reads exactly like the provider having no
effect.

**And every ordinary child has them taken off** — `provider::withhold`, called from
`credits::withhold` and `credits::apply`, removes all eleven. A card's environment is inherited by
everything it starts, including a lab wall launched from its shell (`bun run lab`, the
documented way to develop a migration); without this, a Claude card on that wall inherits the
DeepSeek base URL and bearer token, which outrank its account store and spend the wrong money.
This is `credits.rs`'s hazard exactly, mirrored.

Any provider that does *not* speak that protocol (Codex, Gemini) needs an adapter in
`classify.ts` and a different spawn. Do not add one to this table and call it done.

## A provider and a model are one choice

There is no provider switch. `PROVIDER_PRESETS` puts the provider's models in the same menu as
the Claude presets, and `#openIn` derives the provider from `preset.provider`. That is why
`Preset` grew a `provider?` field rather than the app growing a second menu: a provider chosen
without a model is a combination with no meaning.

`#openIn` then skips the account ladder entirely — `provider !== null` means `opening` is null
and `account` is the sentinel. `#settleAccount` skips it again on every send, and
`#spend`/`#observe` refuse to mark a phantom account. `admit.rs::queued`/`held_for` return None
for a provider card: the wall-global `held` is about Claude's five-hour windows, and a DeepSeek
card waiting behind a spent subscription is the one failure that arrives exactly when somebody
reaches for the other provider.

**The wire model is a Claude alias, never a DeepSeek id.** Claude Code validates `--model` and
`/model` locally and refuses a name it does not know — the first live card died as
`[claude-code:unrecognized_model]` with `deepseek-v4-pro` before any request. DeepSeek maps
`claude-opus*` to `deepseek-v4-pro` and everything else to `deepseek-flash` server-side, so the
wall stores and draws DeepSeek's names and translates at exactly two boundaries:
`provider::cli_model` at spawn and `providerCliModel` in `switchLines`; `providerModel` is the
reverse for an id coming back. The `ANTHROPIC_DEFAULT_*_MODEL` variables are deliberately not
set — mapping an alias to a provider id locally is what the CLI then rejects.

## Models: a window is a fact about the model, not a suffix

`classify.ts::WINDOWS` names the windows this build knows, and **the default is 1M**. The bug
that produced the table: the wire stores bare ids (`claude-opus-5-5`, `claude-sonnet-5-5`,
`claude-haiku-5-5`), `contextWindowFor` saw no `[1m]`, answered 200k, and every ring clamped at
100%. Claude 4.6+ includes 1M at standard pricing; the suffix is the CLI's way of *asking* for
the beta, not the only place a window lives. The 200k families (opus/sonnet 4.5, haiku 4/3) are
named explicitly, so a genuine fallback to one still narrows.

`#adoptModel` maps a model through `providerModel` before adopting it, so a Claude alias and a
server-served `deepseek-*` id settle on the same name. It refuses to narrow a declared window on
an id from **no family this build knows**: a known id adopts its own window, an unknown one is a
rename, not a window. This is sink `eb733977`'s shape; do not undo it.

`usage.ts` prices DeepSeek at **peak** rates, with `rateAt` halving outside 01:00–04:00 and
06:00–10:00 UTC on weekdays. `rateFor` without a clock answers peak, which overstates rather
than understates. `priceOf` exists because the CLI's `total_cost_usd` is zero for a model it
has no row for — a DeepSeek card must not read `$0.00` while it works, so the turn's figure and
the card's own `costUsd` are both advanced by it.

## The balance and the wall's cap

The keyring reads `GET /user/balance` on open and on demand, never on a clock. The cap is
**Volery's**, not DeepSeek's — there is no server-side spend-limit API — stored in
`provider_budget` (schema v60) and enforced in `deliver_blocks`, the one door every prompt goes
through. Setting a cap starts its clock; raising one keeps it; zero clears it. A cap enforced in
the composer would be a cap a wake walks around.

## Spawning one

`spawn` takes `provider` beside `model`, `effort`, `account` and `computer`. The rules are
enforced in `asked_provider` / `asked_model` before a card is minted:

- `deepseek` takes `flash` or `pro` only; a Claude family name is refused, not mapped.
- `flash`/`pro` without a provider infers `deepseek`; the four family names infer `claude`.
- `account` with `provider: deepseek` is refused — no Claude account can take it.
- `host` with `provider: deepseek` is **allowed**: the provider's *name* crosses and the far
  wall resolves its own key, which never travels (`flyway`). `deepseek` is a word in
  `fleet::NEEDS`, added to the ask automatically by `needs_for`, so both walls check it —
  the asker against the roster, the far wall against its vault now — and a wall without one
  refuses, naming itself. A wall too old to know `CAN_PROVIDER` is refused rather than
  silently opening a Claude card.
- **A provider card's child defaults to its parent's provider** (`spawn` and `host` alike)
  unless the caller names a model, an account, or `provider: claude`. A DeepSeek card fanning
  out is buying DeepSeek's balance; the child runs on `flash`, the provider's default.

`admit::queued` is skipped at spawn for a provider card because the card's row does not exist
yet and the provider cannot be read off the store; the argument is the only honest source.

## What is deliberately absent

Switching provider mid-life is built for `/provider`, the card's right-click and the
`set_provider` tool (`Skein.setProvider`, a stop and a `--resume` on the shared session).
The tool asks from inside a turn and the front end makes the move on the `result` — a child
cannot be ended under its own tool call. `CLAUDE_SECURESTORAGE_CONFIG_DIR` moves only the
credential store, so the transcript is shared. A move back to Claude clears the model and
lands on the CLI's sign-in; the waterfall chooses an account on the next send. A provider
**move** crosses as a `work` act — the owner checks its own key and does the stop/resume, so
a card blocked on a spent subscription can be moved from another wall. A remote **spawn** on
a provider crosses the other way: the name travels and the far wall runs it on its own key,
refusing up front when it holds none. No allowance stack (no
OAuth, no `/api/oauth/usage`). No `account` interface
for the key: it is an integration in `creds.rs`, stored under
`dev.skein.studio/deepseek-key`, read at spawn, never a lendable credential.

## Adding one that speaks the API

`provider.rs` row + `providers.ts` row with the same values; a `creds.rs` service and an
`integrations.ts` row with a byte-identical target (`test/integrations.test.ts` catches drift);
two `PROVIDER_PRESETS`; `SPAWN_PROVIDERS`/`PROVIDER_MODELS` and `PROVIDER_SPAWN`; a `WINDOWS`
row and a `RATES` row. Then `bun run test`, `bun run check`, `bash tools/check-gnu.sh`, and one
live turn.
