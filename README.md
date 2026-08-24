# Volery

**A studio wall for every Claude Code conversation at once.**

Volery is a Windows desktop app that puts all of your concurrent
[Claude Code](https://claude.com/claude-code) conversations on a single zoomable canvas.
Each conversation is a card. Cards sit in territories, cards can be read, answered, stopped
and set aside, and you can see the state of every one of them at a glance without cycling
through terminal tabs.

There is no terminal emulator anywhere in it. Each card is a long-lived
`claude --print --output-format stream-json` child process, and Volery folds that structured
event stream into its own design — so a card knows the difference between thinking, writing,
running a tool, asking you a question and having crashed, and can say so in a colour and a
line of prose rather than in scrollback.

Released under the [MIT license](LICENSE).

## What it does

**The wall.** Cards are laid out on a fixed pitch across a canvas you pan and zoom. Zooming
does not scale the cards — it changes what they *draw*: at the closest density a card shows
its recent transcript, at the furthest it is a lit tile telling you only whether it needs
you. Cards group into territories, which are named regions of the wall you drop work into.

**Status is colour, and colour is only status.** The whole app is a single warm-ink theme;
the only hues in it are celadon for working, amber for asking, and rust for failed. A card
warms as it is neglected, so a conversation you have abandoned mid-answer becomes visually
loud on its own.

**The transcript panel.** A real reader for one conversation: markdown parsed rather than
printed, runs of tool calls folded into a single openable cap, two navigation rails (every
prompt you have sent, and the structure of the answer you are reading), keyboard scrolling,
adjustable column width and reading size. Copying gives you back the markdown source, not
the rendering of it.

**Answering questions.** Volery ships an `ask_user` MCP server, so an agent can ask you a real
question with real options and park until you answer it — the card goes amber, and you click
a button instead of typing a reply into a stream.

**Instruments.** A widget catalogue you place on the wall beside the work: clocks, timers and
a pomodoro cycle, a performance meter, a running total of what Claude Code has cost you
today, and — if your repositories are on Azure DevOps — live pipeline runs and open pull
requests, including which of them are actually waiting on your review.

**Sessions outlive the app.** Everything is in SQLite. Close Volery and reopen it and the wall
comes back as you left it, with dormant cards that wake on the next thing you send them.
Volery can also adopt sessions it did not start.

**Attention.** When something wants you and the window is not focused, it escalates: taskbar
flash, then a small purpose-built notification window, then optionally a chime. Not an OS
toast.

## Requirements

- **Windows.** Job objects, real input synthesis and the screen-space arithmetic are
  Windows-only; other platforms return errors rather than silently doing nothing.
- **[Claude Code](https://claude.com/claude-code)** on `PATH`, signed in.
- **[Bun](https://bun.sh)** and a **[Rust](https://rustup.rs) toolchain with MSVC** to build.

Prebuilt installers are on the [releases page](https://github.com/ShaitanLyss/volery/releases).

## Building

```powershell
bun install
bun run tauri dev        # run it
bun run tauri build      # bundle installers
```

Checks:

```powershell
bun run check            # svelte-check + tsc
bun run test             # the pure test suites
cd src-tauri && cargo test
```

Two suites are excluded from `bun run test` on purpose: `test:live` spawns the real `claude`
binary and spends real API credit, and `test:wall` drives an already-running app over the
control surface. Both are real tests — run them when you touch the event classifier or the
wall.

## A note on capability

Conversations opened against a project spawn with `--dangerously-skip-permissions`, because
the entire point is agents working unattended across many repositories at once. Broadcasting
a prompt to a selection of cards is therefore the most destructive gesture in the app; it
costs a modifier key and warns you when the targets share a working tree.

Conversations opened outside any project are a different kind: they spawn with web search and
web fetch only, and no bypass at all, so they can reach nothing on the machine.

Know which one you are typing into. Volery draws the distinction on the card.

## Privacy

Volery has no telemetry, no analytics, no crash reporting and no update check. Nothing is
sent anywhere about you or your use of it. Your conversations, wall layout, timers and usage
figures live in a local SQLite database and never leave the machine.

Three things do go out, all of them at your direction:

- **Your prompts go to Anthropic**, because Volery spawns the `claude` CLI and that is what
  Claude Code does. Volery does not talk to the API itself; it reads the CLI's output stream.
- **Azure DevOps**, and only if you place a pipelines or reviews widget and have repositories
  on a Azure DevOps remote. `azdo.rs` is the only file in the codebase that makes an HTTP
  request. Credentials are tried in order until one is accepted: your existing Git Credential
  Manager, an `az` login, a personal access token you enter in the app, then a
  `VOLERY_AZDO_PAT` variable (the older `SKEIN_AZDO_PAT` is still read). Volery holds none of
  the first two and never writes a credential or any fragment of one into a snapshot.

  The token you enter is the one thing it stores, and it goes in the **Windows Credential
  Manager** — under `dev.skein.studio/azdo-pat`, beside the one Git Credential Manager keeps
  for the same organisation — rather than into Volery's own database. So it is encrypted at
  rest by Windows, it is visible in Control Panel → Credential Manager, and you can delete it
  there without Volery's cooperation. Nothing hands it back once stored: no command returns
  it, so no panel, no snapshot and no exported layout can carry it.
- **`git fetch` against your own remotes**, to know whether a branch is behind. Always with
  `GIT_TERMINAL_PROMPT=0`, so a background poll can never pop a credential prompt at you.

Clicking a link in a transcript opens your ordinary browser, and that is the browser's
business from then on.

## Code signing

**Releases are currently unsigned.** Windows SmartScreen will warn you when you run the
installer. An application to the SignPath Foundation for free OSS code signing is pending;
until it is approved, verify downloads by checking they came from
[the releases page](https://github.com/ShaitanLyss/volery/releases) of this repository, which
builds them in public on GitHub Actions from the source in this tree.

Team, and who may approve a signing request: **Lyss Delprat**, sole maintainer.

## Architecture

Tauri 2, with a **Svelte 5 + Vite** front end — plain Svelte with runes, not SvelteKit.

```
claude -p (child process, NDJSON over stdio)
  → Rust reader threads emit conv:event / conv:stderr / conv:exit
  → the front end routes by conversation id
  → each event is folded into per-card reactive state
  → derived values paint the card
```

Nothing polls, and nothing the agent said is drawn before it says it — every state a card can
be in is a fold over events that actually arrived.

Contributors: `CLAUDE.md` is the working guide to the codebase, and `.claude/rules/` holds one
file per subsystem explaining why that code is shaped the way it is. Most of it records a bug
that shipped.
