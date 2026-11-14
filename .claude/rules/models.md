---
paths:
  - "src-tauri/src/benchmarks.rs"
  - "src/lib/benchmarks.ts"
  - "src/lib/standings.svelte.ts"
  - "src/lib/Models.svelte"
  - "src/lib/model-profiles.json"
---

# Models: a model at an effort, what it costs, and the balance

The design is `docs/MODELS.md`. This is what building it taught and what a later edit will
break. Three surfaces read one dataset: the frontier/table/catalogue in the accounts panel,
the line beside a model in a menu, and the deferred `models` tool an agent asks before it
chooses.

## The arithmetic is in Rust, and that is not an accident

The panel and the tool answer the same question and only one of them can reach the front end:
a tool is served by `ask.rs` with no webview involved and possibly no window open. So the
profile score, the frontier, the coverage and the runner-up are computed **once**, in
`benchmarks.rs`; `benchmarks.ts` owns only definitions — the task tags, the aliases, the
as-of wording, the menu's line. Two implementations of "which entry gives more quality for
less money" would eventually show two rankings on one wall.

The profile table is `src/lib/model-profiles.json` and **both languages read that file**
(`include_str!` on one side, a JSON import on the other), so a reweighting is one edit, not
two tables held in step by a drift test.

## The unit is a model at an effort, and no source states an effort

Neither BenchLM nor Artificial Analysis publishes an effort level — read 2026-11-13.
`benchmark_reading.effort` therefore holds `not-stated` for every row, and the panel and the
tool say *effort not stated* rather than inventing a level. The column exists so a source
that does state one lands without a second schema rung. The wall's own aliases carry the
effort it *would* spawn at (`benchmarks.ts::ALIASES`) — a fact about the wall, not a reading.

## The sources and their terms

- **BenchLM** (`/data/models.json`, `benchmarks.json`, `pricing.json`, `speed.json`) — the
  catalogue. CC BY-NC 4.0: queries and internal analysis only; nothing here publishes its
  data, it is read by this machine, cached in this machine's database, and credited on the
  panel. `leaderboard.json` is deliberately not fetched: its category score is BenchLM's own
  composite, and the point of this feature is showing components rather than somebody else's
  aggregate.
- **Artificial Analysis** — optional, behind a key in the integrations panel. **The
  documented `/api/v2/language/models` is Pro-only; a free key gets 403 there.** The free
  shape is `/api/v2/language/models/free`, and that is what `benchmarks.rs` and `creds.rs`'s
  probe fetch. The design expected it to carry effort variants; it does not.
- A source that cannot be read yields nothing: a parse failure marks the source `failed`,
  **leaves the previous cache in place**, and says so on the panel.

## A scale is inferred from the data, never from a hope

BenchLM's per-model `benchmarks` object mixes percentages with Elo ratings, dollars, turn
counts and token rates. `unit_for` decides a benchmark's unit once, across every value it has:
anything that leaves 0..=100 is its own scale and can never be a profile member. Profiles name
only benchmarks known to be scores, and the test holds that.

A **zero price is a self-hosted model, not a free one** — `pricing.json` lists open-weight
models at 0/0 and a reading of $0 would dominate every frontier while meaning "somebody
else's electricity". Those get no price reading at all.

**Vision and tool use are evidence, never absence of evidence**: `vision: true` when the model
has a multimodal benchmark reading and `tool_use: true` when it has an agentic one; otherwise
`null` (`not stated`). A `needs` question the sources never answered fails rather than passes.

## A comparison happens inside a coverage tier, and nowhere else

The table groups entries by **how many members their score was computed over** and never
orders across a group; the rank number restarts under each heading. A model measured on three
of four benchmarks has answered a different question from one measured on two of four, and a
single descending column of the two is an order that does not exist — it is coverage ranking
first and quality second, wearing one number. The `present`/`members` pair is the tier, the
frontier is computed **inside the best-covered tier only**, every thinner entry is reported
`not placeable` with the reason, and the curve's own foot says which tier it is and how many
were left off. Unscored entries come last under their own heading, naming the members they
lack — "missing HLE, GPQA Diamond" answers *why is that model not here* in a way a count
cannot.

`benchmarks.rs` computes the order and the tier; `benchmarks.ts::tiers`/`tierLabel` only group
for drawing, and `test` holds both: the Rust suite asserts the order never interleaves tiers
and that a better thinner entry is never made efficient, and the Bun suite holds the grouping.

## Whose number it is, which is part of the number

BenchLM's own definitions say it: `agentsLastExam` is "Provider-reported task score",
Terminal-Bench 2.1 is "mostly provider-reported". A reading of one of those is the model's
developer talking, and `provider_reported` marks it at normalization from the definition's
own words. Where `benchmarkSources` names a publisher it is carried (`publisher`), and a
publisher that *is* the model's creator counts as the developer; where nobody is credited the
panel says **"publisher not stated"** rather than letting silence read as independence. The
model-level `evidenceStatus` (`supported` / `estimated`) and `scoreConfidence` are carried and
shown on the row.

`rank` already prefers a non-vendor reading for the same benchmark, and every row says how
many of its numbers are the developer's own ("3 of 5 members · 1 provider-reported"). Three
states, deliberately: a named publisher, the developer, and nobody saying — the third is not
a synonym for the first.

## Quality is partial and says so

`rank` requires **half the members by count** before it will score an entry, renormalises the
weights over what is present, and reports `coverage` plus `missing` on every row. A model that
was not run on a benchmark has not failed it. The frontier is the Pareto set over (price,
quality); a dominated row is **dimmed and named with what beat it**, never hidden.

## Refreshing, without a clock

Two events, no poller: the panel opening (`models_view`) and a tool call (`models::answer`)
both fetch when the cache is past `FLOOR_MS` (a day); the refresh button forces one. Both
commands are `off_main` — the first fetch is ~6.5 MB and tens of thousands of inserts. The
cache tables are `benchmark_source`, `benchmark_model`, `benchmark_def`, `benchmark_reading`
(schema v76) and are a cache, not an authored record: an empty table means nothing has been
read yet, and the panel says so.

## The tool

`models` is **deferred** with a search hint written as the words a card is holding ("is flash
better than pro", "what does a model cost"), `readOnlyHint`, and the plan-mode `READS` list.
Adding a tool is still three registrations (`ask.rs::roster`, `supervisor.rs::SPEAKING_SOURCES`,
`tools/lift-roster.ts::SOURCES`) plus `MODULES` in the lift when the schema lives in a module
of its own — the lift flattens sources and rewrites `crate::x::y` only for names in that list.
`classify.ts::SKEIN_MODELS_TOOL` must know the name or the transcript draws the raw
`mcp__skein__models`.

**Two guards caught real mistakes here, and both are worth keeping**: the lift's
`no_tool_result_names_a_tool_a_card_cannot_call` refused a result string saying bare
`` `models` `` instead of `mcp__skein__models`, and `classify.test.ts`'s vocabulary test
refused the tool before `describeTool` could name it.

## The standing line, at both choices

The chat view's model menu (`ModelMenu.svelte`) and the wall's `+` right-click
(`menu.ts::presetRows`, fed by `standings.picks()` from `App.svelte`) both carry it. The
wall's version appends to the row's existing `note` — model and effort first, then
"coding agent 65.7 · $8.00/1M" — and puts the profile, the price basis and the as-of on the
menu's **foot** rather than on every row. `standings.ensure()` runs once at launch so the
first right-click is not a menu with no lines on it; that is a *read* of the cache, and the
fetch is still the panel's or the tool's.

**An alias names a key the source publishes, and that is checkable.** `ALIASES.model` was
written from BenchLM's model list, and the pro model is spelled `deepseek-v4-pro-max` there
— an early read of the same page suggested `-0813`, which the live catalogue does not carry.
An alias pointing at a key nothing publishes reads "no reading" in a menu for ever with
nothing red anywhere, so `test/benchmarks.test.ts` holds every alias against
`test/fixtures/benchlm-models.json`: refresh that snapshot and a key that moved goes red in
the suite rather than in a menu.

## What is not built

- No effort variants and no vendor cards: no source publishes either as text today.
- `src/lib/standings.svelte.ts` is named for the subsystem because `models.svelte.ts` beside
  `Models.svelte` is two paths differing in case — the trap `accounts.md` records.
