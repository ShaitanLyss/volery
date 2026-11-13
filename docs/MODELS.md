# Models: a model at an effort, what it costs, and the balance

On 2026-11-13 an agent opened a build card on `deepseek pro` because the name read as
"the hard end". The newer, cheaper `flash 4.1` beat it on coding (BenchLM coding lane 59.7
vs 46.5; DeepSWE 77.0 vs 62.7) and agentic work, is roughly four times cheaper, and is the
one with vision. The choice was made from a name, not evidence.

The second half is that the choice is never only a model. The same model at a low effort
and at `max` is a different price and a different result, and what anyone is actually
balancing is **quality against cost**. So the reading is a model **at an effort**, and the
first view of it is the frontier where those two meet.

Volery already knows which providers, models and efforts it can spawn; it does not know how
they compare, task by task. This makes that comparison a first-class, cached, dated reading
on the wall, and a tool an agent can ask before it chooses.

## The unit is a model at an effort

One normalized row per **model at an effort**, not one per model:

- **identity** — provider, the wall's spawn name (`flash`, `pro`, `sonnet`) and the effort
  it was run at (`low` through `max`; the provider's own levels, and `none` for a model that
  takes none), the full model version, and the date that mapping was checked. The alias is
  shown beside the version, so "pro" is never a timeless word.
- **what it can do** — vision, tool use, context window. A choice often turns on a
  capability, not a score.
- **quality** — the workflow profile's score at that effort, and every component benchmark
  beneath it.
- **cost** — the price at that effort: the provider's list price per million in and out,
  and, where a source publishes it, the measured cost of the benchmark run. The price basis
  is always named, because reasoning tokens are most of what an effort changes.
- **provenance** — source, harness and date on every reading. Vendor-reported and independent
  are kept apart and never averaged together.

A source that does not state an effort is marked **effort not stated** and is never compared
as if it were a level. An unmapped model or benchmark says "no reading". It never guesses.

## The catalogue, and the profiles

The catalogue is the unit: a **benchmark** tagged by task (repo work, one-shot coding, tool
use, hard reasoning, knowledge, long context, search, vision, speed, price), with its source,
harness and date, and a score per model-at-effort.

A **workflow profile** is a named, weighted set of benchmarks: coding agent, one-shot coding,
hard reasoning, knowledge and research, long context, vision and charts, search, cheap bulk.
Its members and weights are shown, and every ranked row opens to its components. The profile
is a view, not a truth: two entries that disagree across benchmarks are shown disagreeing,
not averaged into a winner.

## The frontier, which is the point

For each workflow, the entries are placed on **quality against cost**, and the efficient
ones are the frontier: no other entry gives more quality for the same or less money. A model
at `max` that costs four times the `medium` run for two points is on the wrong side of it,
and is shown dimmed with the frontier above it.

The models panel opens on the frontier, not on a single winner: the curve is the balance the
choice is actually about. The ranked table is the second view, and a quiet line says which
entries are dominated and by what.

## The three surfaces, one dataset

**At the choice.** Every place a provider, model and effort are chosen — the spawn menu, a
card's provider menu, the accounts panel — carries the effort, the profile score and the
price together, with the source and date on the menu's foot. The efficient choices are
marked and the dominated ones are visible as dominated. A project card opens on the
coding-agent profile; a chat card on knowledge and research. The menu says which profile it
is showing and points at the panel for the others.

**The models panel.** A tab beside the accounts, because that is where a provider is set: a
workflow selector; the **frontier** as the first view, the ranked table as the second, and
the raw catalogue as the third; each row opening to its components, their sources and dates;
a refresh, and a line saying how old the reading is and which sources are on.

**The tool.** `models`, for an agent: `list`, `rank`, `frontier`, `compare`, `explain`. It
answers with the entries, their effort, quality, price and components, the source and the
date. It is deferred, with one clause in `spawn` and `set_provider` pointing at it, because
the moment the agent chooses is the moment it needs this.

## The tool's answer

`models` takes `op: list | rank | frontier | compare | explain`; the `profile` or a custom
`benchmarks` set with weights; the providers to include (the wall's own by default); the
efforts to include; and for `compare` the entries. It also takes `needs` — vision, tool use,
a context floor, a price ceiling — and `budget` or `quality` when the question is one side of
the balance.

- `rank` returns the entries in order with their effort, price, components, sources and dates.
- `frontier` returns the efficient set, so an agent can see the cheaper entry that gives up
  two points, rather than only the winner.
- `compare` returns two entries side by side, per benchmark, with the price difference and
  the effort.
- `explain` returns the profile's members and weights, and what the effort levels mean.

It never says "use X". It says what the reading is, and lets the agent reason. The default
answer names the price basis, because a score without its cost is not the decision.

## The sources, and what they owe

- **BenchLM** — free JSON downloads (`leaderboard.json`, `models.json`, `pricing.json`,
  `speed.json`) and a keyless leaderboard endpoint, aggregating several benchmark families.
  No credential. Its terms allow queries and internal analysis; commercial display or
  redistribution needs a separate licence, so this is read and cached on the machine that
  asked, with attribution on the panel.
- **Artificial Analysis** — a public REST API (`/api/v2/language/models`) with a free tier of
  100 requests a day and attribution required. It publishes effort variants (such as `max`)
  and price, and is the source that makes the effort dimension real. It needs a key, so it is
  an optional source, stored through the integrations panel like any other credential, and
  switched off until someone enters one.
- **Vendor model cards** — the vendor's own claim, marked as such, and only where the page
  publishes numbers as text. DeepSeek's current cards are images, so they are not a source
  until that changes.
- **LMArena** — human preference, if its terms allow. Optional, and kept out of the coding
  and agentic profiles so it cannot be read as a coding score.

A source that cannot be read yields nothing. It never yields a guessed number or an inferred
effort.

## Keeping it current, and honest when it cannot

- The readings live in SQLite: one row per benchmark, model, effort, score, source, harness,
  unit, published date and fetch date; plus the alias table and the profile definitions'
  version. It is a cache, not an authored record.
- It is fetched when the panel opens, and when the tool is asked and the cache is past a
  day's floor. A manual refresh is always there. One fetch per source per floor, so a panel
  left open does not hammer anyone. The fetch is `off_main`.
- With no network the cache serves, and the panel says how old it is: *as of 12 Nov, 14:02*.
- A source that changes shape fails to "no reading" and says so on the panel, rather than
  writing a wrong row.

## Security and honesty

- Allow-listed URLs only. No arbitrary fetch, and no page becomes an instruction.
- The adapters return numbers, labels and dates. HTML never reaches the transcript or the
  panel; text is capped and sanitized.
- A benchmark is evidence about a model, never a standing instruction. The tool's
  description says so.
- Price is the provider's list price at that effort, with the date, or a source's measured
  cost with its basis named. The wall's own caps, boost and spend (`accounts`, `spend`) are a
  different reading and are not mixed in.

## What building it touches

- `benchmarks.rs` — the source adapters, the fetch, the normalizer, the cache; a schema
  rung; the `models` command for the panel.
- `benchmarks.ts` — the pure normalization, the task tags, the alias table (model and
  effort), the profile definitions and weights, the frontier arithmetic, and the "as of"
  arithmetic.
- `ask.rs` — the deferred `models` tool and its one-clause hint in `spawn`/`set_provider`.
- `Accounts.svelte` (the models tab with the frontier, the table and the catalogue), the
  provider/model/effort menu in the spawn flow, and the profile line beside each option.
- The integrations panel for the optional Artificial Analysis key.
- Tests: a fixture per source, the normalizer, the aliases and efforts, the profiles and
  their weights, the frontier, the tool schema in the roster lift, and the no-network state.
- E2E: a lab with the panel, the frontier, a profile switch, a refresh with the network, the
  tool answering with a budget and a quality target, and the offline reading with its date.

## Decided

1. **Workflow profiles are the face.** The panel opens on a workflow; the frontier is its
   first view, the ranked table the second, the catalogue the third.
2. **The reading shows at the choice, in the panel and in the tool.**
3. **BenchLM first, Artificial Analysis optional.** BenchLM needs no credential and
   aggregates several benchmark families; Artificial Analysis is the independent second
   source and the one that carries effort variants, behind a key entered in the integrations
   panel.
4. **The unit is a model at an effort, and the balance is the frontier.** Every reading
   carries its effort and its price; the tool returns the efficient set and can be asked for
   a budget or a quality target, not only a winner.
