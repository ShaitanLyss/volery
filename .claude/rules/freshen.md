---
paths:
  - "src-tauri/src/freshen.rs"
  - "src/lib/freshen.ts"
  - "src/lib/freshening.svelte.ts"
  - "src/lib/Freshen.svelte"
---

# Keeping Claude Code and its plugins current

The team ships skills through a plugin marketplace (tx-toolkit, a git repo on Azure DevOps).
After a push, every machine's marketplace clone and installed plugin copy stayed where they were
until somebody ran three commands by hand, and inside a card `/plugin` answers "isn't available
in this environment". Sink `9e477f33` is the cost: a card briefed to load a skill pushed that
morning got the September copy and had to read `SKILL.md` straight off the source tree. Asked for
2026-10-27: an automatic run, a button for "what I'd click after pushing a new skill", and then
the same for agents.

## What runs, and the three decisions it rests on

`freshen.rs` runs, one at a time, each in a job with a timeout:

```text
claude update                                               5 min
claude plugin marketplace update <name> --json              3 min, per known marketplace
claude plugin update <plugin@market> --scope <s> --json     3 min, per install, per scope
```

- **The plan is the CLI's own two files, read and never written.** `known_marketplaces.json`
  names the marketplaces and `installed_plugins.json` (v2: a list of installs per key, one per
  scope) names the plugins. A new marketplace or a new project scope therefore costs no code.
  Writing either file ourselves would be a second writer in a race only the CLI can see.
- **Marketplace first, because a plugin update reads it.** Refreshing the clone moves no
  installed copy; updating a plugin against a stale clone finds nothing newer. Verified by hand.
- **A project scope runs in its project** (`cwd = projectPath`, `--scope project`), since the
  CLI resolves a project install from where it is run. One whose folder is gone is in the plan
  already `skipped`, and says so, rather than run somewhere it means a different install.
  `managed` is skipped too.

`--json` on both plugin commands is the CLI's machine-readable line, probed against 2.1.311:
`updateOutcome` is `updated` / `up_to_date`, else read as skipped; `outcome` other than `ok` or a
non-zero exit is a failure, reported by its first line. `claude update` has no `--json`, so its
three sentences are read as text. Every parser has a fallback to the human sentence, and every
shape is a test in `freshen.rs`.

**Never `-y`.** A marketplace that changed a plugin's install command makes the CLI ask a person
to confirm it, and refuse without `-y` when nobody can. That refusal is right for anything
unattended: the row carries its first line and the person runs it in a terminal.

**Never a question from the background.** The marketplace is a git fetch against Azure DevOps.
The automatic run and a card's run set `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` and
`credential.interactive=false` (through `GIT_CONFIG_COUNT`, since the git is the CLI's child);
the button does not, because a person pressed it and a sign-in window is then a question they
can answer.

## When

Once, a minute after launch (`LAUNCH_GRACE_MS`), then every `everyHours` — six by default, one
to 168, `0` meaning never — measured from when the last run *started*. The scheduler is a
condvar wait aimed at the next due moment, so changing the setting re-aims it at once and an
idle wall pays one sleeping thread. This is a clock, and the argument for one is short: a
marketplace push emits nothing this machine can hear, and the nearest event — somebody pressing
the button — is the other half of the feature.

**Not in a development build** unless `VOLERY_FRESHEN_AUTO` is set. A lab and the installed wall
would both update the same `~/.claude` on their own schedules, and two CLIs writing
`installed_plugins.json` at once is the race the paragraph above declines. The panel says
"a development build never checks by itself" instead of drawing a switch that does nothing. The
button and the tool work everywhere.

## Which cards are on the old copy

An update reaches the next process, never a running one. `freshen.ts::staleOf` asks each card's
own `system/init`, which names both halves: `claude_code_version` (a required field of the init
schema) and `plugins[]` with `path`, the per-commit cache directory the skills are read from. An
update that moved tx-toolkit installed it under a new directory, so a card still reading the old
one is stale, exactly, with no clock involved. `Conversation.cliVersion` and `runningPlugins` hold
the two, and are cleared by the `dormant` setter, since the next process says nothing until its
first message.

A live card with no init yet — most of them, since rousing and `stir` hand out processes ahead of
any prompt — is judged by age: started before `changedAt`, the last run that moved the CLI or a
plugin (a marketplace refreshed moves nothing any card runs on). That can only err towards
calling a card stale, and the price of that is one lossless stand-down.

## Restarting them, never mid-turn

`Skein.restartStale` is the reaper's stand-down (`letRest`) with the wait taken out:
`reaping.ts::keptFrom(card, around, 0)` is the one list of what a process would take with it — a
turn, a prompt on the wire, a question, background work, a timer, live children — and
`rest_conversation` refuses under the supervisor's lock if a turn opened in between. The card goes
dormant, which loses nothing, and its next process — on your next keystroke, through `stir` —
starts on what is installed now. It is not respawned at once: a process nobody is about to speak
to is memory spent for nothing. Busy cards are counted and left; pressing again after they rest
takes them.

## Where it is drawn and who can run it

- **The accounts panel** (`<space> a`), under the `claude code 2.1.311` line, because that is
  where this machine's Claude Code is already described: the last run's one line, each item
  (open while running and after a run that moved or failed something), the stale cards with a
  restart button, and the interval. `Freshen.svelte`; the reader is `freshening.svelte.ts`, not
  `freshen.svelte.ts`, which on this filesystem is the same import as the component.
- **`<space> m u`** runs it from anywhere.
- **A chronicle row** per finished run that moved or failed something (`freshen.ts::runRow`),
  naming the stale cards. A run that found everything current writes nothing.
- **`mcp__skein__update_claude`**, deferred, found by its hint. It starts the run (or joins the
  one going) and waits up to `TOOL_WAIT`, four minutes, under the 300s clock Bun's `fetch` holds
  every MCP call to (`ask.md`), then answers item by item; `status: true` only reads. A chat card
  is refused. The answer says that the caller's own process keeps the old copy, and to tell the
  person rather than try to restart itself.

`freshen.json` in the app data directory keeps the settings, the last run item by item and
`changedAt`. Every failed step is also a `warn!` under `freshen:` in `logs/volery.log`, so a card
can read why something did not update.

## Across the flyway

Per machine, deliberately: a run updates the `~/.claude` of the wall it runs on, and a card on
another wall sees its own wall's state through its own tool. To update the far laptop, open a
card there and ask it to call `update_claude`, which is the arrangement `update_volery` already
has.
