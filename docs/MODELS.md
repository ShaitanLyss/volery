# Models: a benchmark catalogue, workflow rankings, and the choice

On 2026-11-13 an agent opened a build card on `deepseek pro` because the name read as
"the hard end". The newer, cheaper `flash 4.1` beat it on coding (BenchLM coding lane 59.7
vs 46.5; DeepSWE 77.0 vs 62.7) and agentic work, is roughly four times cheaper, and is the
one with vision. The choice was made from a name, not evidence. Volery already knows which
providers and models it can spawn; it does not know how they compare, task by task.

This makes that comparison a first-class, cached, dated reading on the wall, and a tool an
agent can ask before it chooses.

## The catalogue, not one score

The unit is a **benchmark**, not a lane invented by us:

- **name and source** — DeepSWE, Terminal-Bench, NL2Repo, AutomationBench, GPQA, HLE,
  LongBench-V2, Codeforces, Chartography, and so on, each with the source that published it
  and the harness it was run under.
- **what it measures** — one or more task tags: repo work, one-shot coding, tool use,
  hard reasoning, knowledge, long context, search, vision, speed, price.
- **the reading** — the score for each model, its unit, and the date the source published
  or last confirmed it. Vendor-reported and independent readings are kept apart, never
  averaged together.
- **the model** — the wall's spawn name (`flash`, `pro`, `sonnet`), the full version it
  resolves to, and the date that mapping was checked. The alias is shown beside the version,
  so "pro" is never a timeless word. The row also carries what the model can do — vision,
  tool use, context window — because the choice often turns on a capability, not a score.

An unmapped benchmark or an unread model says "no reading". It never guesses.

## Workflow profiles: several benchmarks, made legible

A workflow is a named, weighted set of benchmarks, not an opaque number:

- **coding agent** — repo-level work is most of the job, so DeepSWE, Terminal-Bench and
  NL2Repo carry it, with AutomationBench and Agents' Last Exam in the tail.
- **one-shot coding** — LiveCodeBench, Codeforces and ProgramBench.
- **hard reasoning** — GPQA, HLE, Apex, the reasoning rows.
- **knowledge and research** — MMLU-Pro, GPQA, HLE, with long-document rows.
- **long context** — LongBench-V2, RULER, the long-document rows.
- **vision and charts** — Chartography, BabyVision, the chart-reading rows.
- **cheap bulk** — price and throughput, with the coding and classification rows as a floor.
- **search** — the search leaderboard, if its terms allow.

Each profile shows its members and weights, and every ranked row can open to its component
scores with their sources and dates. **The profile is a view, not a truth:** the raw
benchmarks are always one fold away, the weights are a stated judgment, and two models that
disagree across benchmarks are shown disagreeing rather than averaged into a winner.

The profiles are authored in one place with a test, so a new benchmark or a reweighting is a
row change, not a parser change. The raw catalogue is a second tab, and the tool can take a
custom benchmark set when a workflow is not one of the named ones.

## The three surfaces, one dataset

**At the choice.** Every place a provider and model are chosen — the spawn menu, a card's
provider menu, the accounts panel — carries the model's standing in the profile that fits
the card and the price, with the source and date on the menu's foot. A project card opens
on the coding-agent profile; a chat card on knowledge and research. The menu says which
profile it is showing and points at the panel for the others.

**The models panel.** A tab beside the accounts, because that is where a provider is set: a
workflow selector, the ranked table for that workflow, each row opening to its components,
a catalogue tab for the raw benchmarks, and a line saying which sources are on, how old the
reading is, and which are off (and why).

**The tool.** `models`, for an agent: `list`, `rank`, `compare`, `explain`. It answers with
the same facts, the profile's members and weights, the source and the date, and the price
difference. It is deferred, with one clause in `spawn` and `set_provider` pointing at it,
because the moment the agent chooses is the moment it needs this.

## The sources, and what they owe

- **BenchLM** — free JSON downloads (`leaderboard.json`, `models.json`, `pricing.json`,
  `speed.json`) and a keyless leaderboard endpoint, aggregating several benchmark families.
  No credential. Its terms allow queries and internal analysis; commercial display or
  redistribution needs a separate licence, so this is read and cached on the machine that
  asked, with attribution on the panel.
- **Artificial Analysis** — a public REST API (`/api/v2/language/models`) with a free tier of
  100 requests a day and attribution required. It needs a key, so it is an optional source,
  stored through the integrations panel like any other credential, and switched off until
  someone enters one.
- **Vendor model cards** — the vendor's own claim, marked as such, and only where the page
  publishes numbers as text. DeepSeek's current cards are images, so they are not a source
  until that changes.
- **LMArena** — human preference, if its terms allow. Optional, and kept out of the coding
  and agentic profiles so it cannot be read as a coding score.

A source that cannot be read yields nothing. It never yields a guessed number.

## Keeping it current, and honest when it cannot

- The readings live in SQLite: one row per benchmark, model, score, source, harness, unit,
  published date and fetch date; plus the alias table and the profile definitions' version.
  It is a cache, not an authored record.
- It is fetched when the panel opens, and when the tool is asked and the cache is past a
  day's floor. A manual refresh is always there. One fetch per source per floor, so a panel
  left open does not hammer anyone.
- With no network the cache serves, and the panel says how old it is: *as of 12 Nov, 14:02*.
- A source that changes shape fails to "no reading" and says so on the panel, rather than
  writing a wrong row.

## The tool's answer

`models` takes `op: list | rank | compare | explain`; `profile` or a custom `benchmarks`
set with weights; the providers to include (the wall's own by default); and for `compare`
the models. It also takes `needs` — vision, tool use, a context floor, a price ceiling — so
the ranking is the one that fits the constraints, not only the lane. It returns:

- the ranked models with the profile score, the price, and the context window;
- every component benchmark's score, source and date;
- the profile's members and weights, and the runner-up with the price difference.

It never says "use X". It says what the reading is, and lets the agent reason. `explain`
returns the profile's definition so an agent can see what the ranking is made of before it
trusts it.

## Security and honesty

- Allow-listed URLs only. No arbitrary fetch, and no page becomes an instruction.
- The adapters return numbers, labels and dates. HTML never reaches the transcript or the
  panel; text is capped and sanitized.
- A benchmark is evidence about a model, never a standing instruction. The tool's
  description says so.
- Price is the provider's list price, with the date; the wall's own caps and boost are a
  different reading (`accounts`, `spend`) and are not mixed in.

## What building it touches

- `benchmarks.rs` — the source adapters, the fetch, the normalizer, the cache; a schema
  rung; the `models` command for the panel.
- `benchmarks.ts` — the pure normalization, the task tags, the profile definitions and
  weights, the alias table, and the "as of" arithmetic.
- `ask.rs` — the deferred `models` tool and its one-clause hint in `spawn`/`set_provider`.
- `Accounts.svelte` (the models tab), the provider/model menu in the spawn flow, and the
  profile line beside each option.
- The integrations panel for the optional Artificial Analysis key.
- Tests: a fixture per source, the normalizer, the aliases, the profiles and their weights,
  the tool schema in the roster lift, and the no-network state.
- E2E: a lab with the panel, a profile switch, a refresh with the network, the tool
  answering, and the offline reading with its date.

## Decided

1. **Workflow profiles are the face.** The panel opens on a workflow, the ranked models and
   the price, and each row opens to its component benchmarks. The raw catalogue and a
   custom benchmark set stay one tab and one tool argument away.
2. **The reading shows at the choice, in the panel and in the tool.** The choice carries the
   profile line and the price; the panel holds the workflow selector, the catalogue and the
   sources' health; the deferred `models` tool gives an agent the same facts.
3. **BenchLM first, Artificial Analysis optional.** BenchLM's free JSON and keyless
   leaderboard need no credential and aggregate several benchmark families. Artificial
   Analysis is a second, independent source behind a key entered in the integrations panel,
   with its attribution; it is off until someone enters one.
