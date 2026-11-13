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

## What is not built

- The wall's `+` right-click menu (`menu.ts::presetRows`) does not carry the standing line —
  its rows are built from `MenuTarget` in `App.svelte`, which this card did not touch. The
  chat view's model menu does (`ModelMenu.svelte`).
- No effort variants and no vendor cards: no source publishes either as text today.
- `src/lib/standings.svelte.ts` is named for the subsystem because `models.svelte.ts` beside
  `Models.svelte` is two paths differing in case — the trap `accounts.md` records.
