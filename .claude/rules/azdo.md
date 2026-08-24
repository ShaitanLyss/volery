---
paths:
  - "src/lib/azdo.ts"
  - "src/lib/devops.svelte.ts"
  - "src/lib/Pipelines.svelte"
  - "src/lib/Reviews.svelte"
  - "src/lib/Keyring.svelte"
  - "src-tauri/src/azdo.rs"
  - "src-tauri/src/vault.rs"
---

# Azure DevOps: pipelines and reviews

#### Azure DevOps: pipelines and reviews

Two instruments for the forge the work actually lives in: `pipelines` — what is building,
across every project at once — and `reviews` — open pull requests, and which of them want
you. `azdo.rs` answers in facts, `azdo.ts` is pure and owns the whole taxonomy, and
`devops.svelte.ts` is the one connection behind however many of either are up.

**They are two widgets rather than one with a variant, and that was the design question.** A
variant on this wall means a different *reading of the same fact* — a clock's five faces are
all the time, a timer's three are all the run. Runs and pull requests are different facts, off
different endpoints, on different clocks, answering different questions; and decisively, you
want both on the wall **at the same time**, which a variant makes impossible. What they
genuinely share is the connection, so that is what is shared. Each keeps a `variant` of its
own for how it is drawn (`list`, `lanes`, `dots`).

- **The organisation is read off the wall, never configured.** The organisations worth watching
  are exactly the ones whose repos are standing on your wall. `git remote get-url origin` in
  each project root is the whole of the configuration, both spellings
  (`dev.azure.com/<org>` and `<org>.visualstudio.com`), and a wall with no Azure DevOps repo on
  it asks nothing of the network at all.

  This used to be argued from "there is no text field anywhere in Skein", which stopped being
  true some time ago (the dock, the shell, the finder) and is now false on purpose
  (`Keyring.svelte`). **The argument is better without it, and the distinction it replaces is
  worth keeping:** an organisation is a *fact about the wall* and asking for one would be asking
  you to retype what the app can see; a PAT is not derivable from anything at all, since it
  exists only because somebody went and minted it. That is the test for whether a new setting
  deserves a field — not whether fields exist.
- **Authentication is a ladder that falls through on refusal, not on absence**, and that
  distinction is the whole of why it works. Git Credential Manager already holds a credential
  for `dev.azure.com` on any machine that has cloned from the org — free, nothing to set up —
  and it is enough for pull requests and **not** for builds, because GCM issues a code-scoped
  token. Probed 2026-08-14 against `LagardereAWPL` with `.scratch/tlsprobe`, one credential,
  four endpoints: `projects 200`, `pull reqs 200`, `identity 200`, **`builds 401`**. So a
  ladder that stopped at the first credential it could *find* would have worked for reviews and
  been permanently broken for pipelines, with nothing to say about why. Each rung is tried until
  one is *accepted* — git credential, `az account get-access-token`, the token in the Windows
  vault, then `VOLERY_AZDO_PAT` — and which rung answered is remembered per organisation and per
  endpoint family, so that 401 is paid once rather than on every poll.
- **The `az` rung did not exist on Windows for the first ten days, and the way it failed is the
  part to remember.** `Command::new("az")` resolves a bare program name by appending `.exe` and
  does not consult `PATHEXT`; the Azure CLI installs `az.cmd` and no `az.exe`. So the spawn
  failed, `output`'s `.ok()?` turned that into the same `None` that means "az is not installed",
  and `ladder` returned the git credential *alone* — which is refused on builds. The pipelines
  widget therefore said `a token was refused (401)` on every poll, with no fallback, and the
  message was entirely consistent with a ladder that had tried everything. Verified 2026-08-24
  with `UseShellExecute = false` so it is the same CreateProcess resolution: bare `az` fails
  with "the system cannot find the file specified", `az.cmd` starts and exits 0.

  Two fixes came out of it and the second matters more than the first. `az_names` looks for the
  rung under every name it goes by — bare first, the `find.rs::candidates` order, since an
  `az.exe` somebody installed on purpose is the one they mean. And **a `Cred` now carries what
  to call it** instead of deriving that from `Basic` vs `Bearer`: three of the four rungs are
  Basic, so "a token" named a rung you could not identify, and the one distinction it most
  needed to draw was *a code-scoped credential git happens to hold* from *a PAT you minted on
  purpose*. **A diagnostic that cannot tell two rungs apart is how a dead rung hides.** Anything
  added to this ladder owes a name.
- **The environment variable is last, and being last costs it nothing.** It has a claim to
  winning outright, being the most deliberate. But since the ladder falls through on refusal,
  the only case where the order decides anything is one where a rung above it was *accepted* —
  and an accepted rung is by definition a credential that works. First, it would instead mean a
  stale variable in somebody's shell profile silently outranking the sign-in they just did. The
  stored token sits directly above it for the same reason in miniature: the two are the same
  kind of credential and the vault holds the more current statement of it, exactly as
  `VOLERY_AZDO_PAT` is read ahead of `SKEIN_AZDO_PAT`.
- **A 400 can mean "you are not on this project", and it used to end the pass.** `get` falls
  through on 401, 403 and 404 — the last because AzDO returns it for a project the caller cannot
  see rather than admitting the project exists. It does the same thing with a **400** carrying
  `typeKey: ProjectDoesNotExistException`, which fell to the hard-error arm instead, so the
  first rung that could not see a project stopped the ladder before the rung that could was
  tried. Probed 2026-08-24: an `az` identity on this org reads builds in 2 of 6 projects and
  gets that 400 on the other 4. Matched on `typeKey` and never on the status alone — forgiving
  every 400 would swallow a malformed request, which is a bug in this file and has to stay loud.

  And a project no rung can see is **counted, not faulted** (`Denied::Unseen`, `Runs.unseen`).
  Per-project permissions are the shape of somebody's tenant, not an error, and a widget
  permanently red about four projects you were never on is a widget you stop reading. But it is
  not silent either: `emptySaid` gains a fifth silence, because "no recent runs" over four
  projects that refused to answer is the face claiming to know something it does not. A
  credential refusal outranks an invisibility when both happened — that is the mixed case, and
  the 401 is the actionable half.
- **The token is entered in the app, and it is the only secret Skein stores.** `vault.rs` has
  the argument for *where*: not the wall's SQLite (plaintext, and layouts are exported out of
  it), not a DPAPI blob of our own (encrypted but invisible and revocable only through us), but
  the Windows Credential Manager — DPAPI underneath, the vault GCM already keeps this org's
  other token in, and listed in Control Panel where you can delete it without Skein's help. The
  target name keeps the `dev.skein.studio` identity for the reason CLAUDE.md gives about the
  `%APPDATA%` folder: it is a name the disk depends on, and the visible rename was made
  provisional.

  **No command hands a token back.** `azdo_token` answers a boolean, so the front end can say
  whether one is held and never what it is — which is what makes it safe for `snapshot.azdo` to
  report `token` at all. `set`/`clear` drop the credential cache in the same command, since
  `Cache::creds` is resolved once per org and held; without that the ladder you just changed
  would not be consulted until the last widget came off the wall.
- **`Cache::creds` has no TTL, and one rung is a token that expires.** The other three cached
  things carry an `Instant`; the ladder does not, so it lives until `release_azdo`. An `az`
  bearer is good for about an hour, so a wall left up for days holds an expired one — and once
  the git credential is refused too, the widget goes dark until the last pipelines widget comes
  off the wall and goes back on. Now reachable rather than theoretical, since the `az` rung
  works. Not fixed here; it wants an expiry on the rung rather than on the map, because the
  other three do not expire.
- **GCM refuses to answer for `dev.azure.com` without the organisation, and then tries to
  prompt.** Probed 2026-08-14: asked for the bare host it returns `fatal: Cannot determine the
  organization name for this 'dev.azure.com' remote URL`, and falls through to a sign-in — which
  blocks forever with no terminal and pops a window over the wall from a poll nobody asked for.
  So the org goes in as `path`, `credential.useHttpPath=true` is forced **on the command line**
  rather than trusted from the user's config (it happens to be set on this machine, and a
  feature that quietly dies on a colleague's because of a config they have never heard of is not
  a feature), and `GIT_TERMINAL_PROMPT=0` with `credential.interactive=false` are set for the
  reason `project.rs::fetch_projects` sets them: **a background poll must never ask a
  question.** This is also why the credential is resolved per organisation rather than once.
- **This network intercepts TLS, and the HTTP client had to be chosen for it.** `dev.azure.com`
  here presents a certificate issued by `ca.macquarietelecom-103950.au.goskope.com` — Netskope —
  whose root is in Windows' `LocalMachine\Root` and in no bundled root set. rustls' default
  roots are webpki-roots, a copy of Mozilla's, which *cannot* contain a corporate CA: built the
  obvious way this fails with a certificate error on every request here and works perfectly on
  the developer's home wifi, which is the worst shape a bug can have. Hence `ureq` with
  `native-certs`, and the note in Cargo.toml as well as this one. Those four 200s above are real
  handshakes through the proxy and are the proof.
- **Pull requests are org-wide in one call; builds are not.** `_apis/git/pullrequests` with no
  project in the path returns every open PR in every repo the caller can see. There is no
  equivalent for builds, so runs cost one request per project — six on this workspace — which is
  why the two halves poll on different cadences (20s for runs, 60s for reviews) and why the
  project list is cached for ten minutes.
- **The two halves fail apart, so they are kept apart all the way down.** A `fault` per half,
  not one on the class: the 401 above is *the normal broken state*, and a single field would have
  had the reviews widget reporting the pipelines widget's problem. A pass that got rows keeps
  them even if something else faulted — with two orgs on the wall, one refusing must not blank
  the other — but a pass that got *nothing* and faulted leaves the last good rows up, or a
  network blip would empty a list somebody is reading.
- **`needsMe` is narrower than "am I a reviewer", and that is the judgement the reviews face is
  really making.** A PR you opened is not waiting on you even though Azure DevOps lists you on
  it — which it does: four of this org's eight open PRs had their own author down as a
  *required* reviewer, because that is what the branch policy adds. Nor is one you have already
  voted on, whichever way you voted; rejecting it puts the ball with the author.
- **`partiallySucceeded` is not a fault.** It means the build worked and something non-blocking
  did not, so rust would be a lie about a pipeline that produced an artifact — but it is not
  nothing either, so it takes the warming amber that means exactly that on a card. A cancelled
  run is `rest` for the reason a stopped card is: nothing went wrong and somebody did it on
  purpose. A completed run with a result nothing recognises is muted, never red — a widget that
  invents faults is a widget you stop trusting.
- **`live` is not a strict in-progress filter.** A pipeline that failed ninety seconds ago is
  the single most useful row this widget can draw, and a strict filter makes it vanish at the
  moment it matters, so finished runs stay for `SETTLING_MS`.
- **Colour is status here exactly as everywhere else.** Azure DevOps' own UI has a colour per
  state; this has the wall's four, and introduces no hue. Runs order by how much they want you
  and then longest-running first; reviews order the same way and then **oldest** first — the
  opposite, deliberately, because a stale pull request is a problem where a stale build is
  merely history.
- **A row is a link and nothing else.** No re-run, no cancel, no approve — a deliberate floor
  rather than an unfinished edge. This wall spawns agents with
  `--dangerously-skip-permissions`, so a button here that started a deployment would be the most
  consequential thing in the app sitting one stray click away from a list read at a glance; and
  an approval lands under your name on somebody else's work and belongs where the diff is. Going
  *to* the thing costs nothing and can be taken back. It routes out through
  `Skein.openLink` → `open.rs`, like every link in the transcript.
- **Five silences, told apart.** A wall with no Azure DevOps repo, a first reading still in
  flight, a scope that matched nothing, projects your credential is not on, and a genuinely
  empty list are five different sentences (`emptySaid`). Getting that wrong is most of what
  would make this read as broken.

### The token panel

`Keyring.svelte`, drawn over the wall in the same shell `Carry` and `Themes` use, reachable
two ways on purpose. From the header menu, because that is where settings live; and **from the
pipelines widget's own fault line**, because that is where you find out you need one — a panel
only in a menu is a panel nobody finds at the moment it would help.

- **The fault line becomes a button only when the fault is a refusal**, matched on the text.
  A network timeout or an unreadable body is not something a token fixes, and offering one
  there would be the widget guessing.
- **Pressed, never automatic.** A panel that opened itself because a poll came back 401 would
  be a window appearing over the wall every twenty seconds.
- **The widget routes the gesture out as `onkeyring`** rather than reaching for the panel —
  App → Canvas → WidgetNode → Pipelines, the chain `onopen` and `onreveal` already use. Which
  panel is on screen is the studio's business, and this widget can be dropped to the size of a
  card, where a field would not fit at all.
- **The panel quotes the fault verbatim** instead of rewording it. The fault names the rung
  that was refused, which is the useful half, and a second vocabulary for the same fact is a
  second thing to keep true.
- It does not report which rung is *in use*, deliberately: the ladder resolves per organisation
  and per endpoint family, so any single answer would be wrong somewhere.

The control surface has an `azdo` op — `read` takes both readings now rather than waiting out
the beats, `rows` hands back the lists with each row's *tier* on it, which is the only way to
see from outside that the taxonomy reached the face. `snapshot.azdo` reports each half's
`watchers`, `ready`, `orgs`, `asked`, `unseen` and `fault` separately, and `polling` apart from
the widget count for the reason `meter.sampling` is. It deliberately reports no credential and
no fragment of one: a snapshot is written to a file. `token` is a boolean — whether one is
stored — which is also the most the front end is ever told, so there is no version of that field
which could leak one by accident.

