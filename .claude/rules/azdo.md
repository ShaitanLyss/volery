---
paths:
  - "src/lib/azdo.ts"
  - "src/lib/devops.svelte.ts"
  - "src/lib/Pipelines.svelte"
  - "src/lib/Reviews.svelte"
  - "src/lib/Run.svelte"
  - "src/lib/Keyring.svelte"
  - "src-tauri/src/azdo.rs"
  - "src-tauri/src/forge.rs"
  - "src-tauri/src/github.rs"
  - "src-tauri/src/vault.rs"
---

# The forge: pipelines and reviews

#### The forge: pipelines and reviews

**There are two forges now, and the file names lag the scope on purpose.** The
rule, the front-end taxonomy and the Rust commands are all still called `azdo`
while answering for GitHub as well — the same bargain `dev.skein.studio` and
`mcp__skein__*` strike in `CLAUDE.md`, and made for the same reason. `azdo_runs`
is quoted in `control.svelte.ts`'s ops and in `wall.test.ts`; `azdo.ts` is named
in `CLAUDE.md`'s architecture section and in this file's own frontmatter.
Renaming them buys a tidier word and costs a rename across files three other
cards are editing. What is *new* is named for what it is — `forge.rs`,
`github.rs`, `Run.svelte` — so the vocabulary is right going forward even where
it is wrong going back. Worth revisiting if a third forge arrives; not worth it
for the second.

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
- **The expiry is on the rung, not on the cache.** The ladder is resolved once per organisation
  and held, because each rung costs a process spawn — and it used to be held *forever*, living
  until `release_azdo`, which only fires when the last pipelines or reviews widget comes off the
  wall. An `az` bearer is good for about an hour. So a wall left up for a day presented a dead
  token; `get` rotates past a refused rung, so on a machine with another working credential that
  cost one wasted request, but the ordinary case on this network is a git credential that is
  code-scoped and 401s on builds anyway — so once the bearer died *every* rung was refused and
  the widget went dark, recoverable only by taking it off the wall and putting it back. Latent
  for ten days while `from_az` could not spawn at all, and reachable the moment that was fixed.

  A TTL on the map would have been the wrong shape: three of the four rungs do not expire — a
  PAT is good for months, an environment variable does not change underneath us, GCM refreshes
  its own — so a clock on the container would re-spawn four processes to rediscover three things
  that had not moved. `Cred::until` is `None` for those and a deadline for the one that dies,
  `get` re-resolves the ladder when any held rung is spent, and there is deliberately no
  non-expiring bearer constructor: every bearer here is an Entra token, and a `bearer()` that
  quietly meant *forever* is the shape the bug had.

  **`expires_on`, never `expiresOn`.** Probed 2026-08-25, one `az account get-access-token`
  returns both: `"expiresOn": "2026-08-25 11:30:28.000000"` is local time with no zone on it, so
  reading it means knowing which zone the CLI meant and being wrong by hours in the others;
  `"expires_on": 1787621428` is seconds since the epoch and needs nothing. Two minutes come off
  it, because a token that dies between being chosen and the request landing is a refusal that
  looks exactly like a credential problem and this poll is slow enough for the gap to be real. A
  floor of a minute goes under it, because a token handed over nearly dead would otherwise be
  re-resolved on every poll — better to present it, take the one refusal and let the ladder
  rotate. `az_token` is pure and holds all of that arithmetic, which is why it is tested.

  Re-resolving also clears that organisation's remembered rung, since the index is into the
  ladder that was just replaced and the new one can be a different length or order. Nothing
  unsafe follows from a stale one — the walk is modulo the length and re-records on success —
  but it would start the pass at a rung nobody chose.
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
- **Five silences, told apart.** A wall with no repo that has pipelines, a first reading still
  in flight, a scope that matched nothing, projects your credential is not on, and a genuinely
  empty list are five different sentences (`emptySaid`). Getting that wrong is most of what
  would make this read as broken.

  **Two of them stopped naming a service when the second forge arrived**, and the reason is
  worth keeping. "asking azure devops…" and "no azure devops repo on this wall" were exactly
  true while there was one forge, and became lies the moment a GitHub repo could satisfy the
  same widget. The failure mode is the worst kind: a sentence that reads as authoritative and
  sends you looking for an Azure DevOps problem you do not have. What the widget actually
  knows is that nothing on this wall has pipelines it can see, so that is what it says.
  "project" still stands in for an Azure DevOps project and a GitHub repository both, which
  is the same stand-in `Run.project` makes and for the same reason — it is the coarsest
  grouping either forge offers under an organisation.

### The second forge

GitHub Actions runs are rows in the **same** runs list and GitHub pull requests
rows in the same reviews list. Not a second widget, not a `source` knob on the
existing one.

- **Because the question is "is anything red anywhere", and splitting the answer
  by which service happens to host the repo is precisely what a wall exists to
  stop.** The argument that made pipelines and reviews two widgets rather than
  one — different facts, different clocks, wanted on screen at the same time —
  says the opposite here: an Azure DevOps build and a GitHub Actions run are the
  *same* fact from two vendors, and nobody wants two widgets side by side to find
  out whether anything is broken. This workspace settles it by being half of
  each: volery is on GitHub, nova/rise/asset_extraction/tx-toolkit on Azure
  DevOps, all on one wall.
- **A `source` knob would have been the same mistake wearing a menu.** A knob you
  have to flip to see the other half of the answer is a knob that is on the wrong
  setting exactly when something breaks.
- Nothing in `widgets.ts` changed. The catalogue entries, the `scope` knob and
  the three variants are all forge-blind and turned out to need no edit at all,
  which is the cheapest possible evidence that the rows really are the same kind
  of row.

#### Facts in Rust, judgement in TypeScript — and the line a projection has to cross

Rust reports **each service's own words**, verbatim, and folds nothing.
`inProgress` from Azure DevOps and `in_progress` from GitHub both arrive as
themselves; `azdo.ts` dispatches on a `forge` field carried on the row.

The tempting alternative — normalising GitHub into Azure DevOps' vocabulary in
`github.rs`, so the front end never learns there are two — was rejected, and the
test that rejects it is worth keeping because every future forge will be argued
against it:

> **A projection is honest where it is total and lossless. It is a lie where the
> second forge has states the first has no word for.**

Two projections pass and are done in Rust:

- **`mergeable`.** GitHub's `MERGEABLE`/`CONFLICTING`/`UNKNOWN` correspond
  exactly to Azure DevOps' `succeeded`/`conflicts`/`queued`. Three to three,
  nothing left over, nothing invented.
- **The vote scale.** A five-point approval scale is not knowledge about a forge;
  `APPROVED` is 10 and `COMMENTED` is 0. `CHANGES_REQUESTED` is **-5 and not
  -10**, and that is the judgement in it: -10 is *rejected*, somebody saying no
  to the change, where -5 is *waiting for the author*, a turn passing. Requesting
  changes on GitHub is how you hand the branch back and it clears when the author
  pushes. Mapping it to -10 would print "rejected" over the ordinary
  back-and-forth of a code review, which is the more alarming of the two ways to
  be wrong.

A run's `conclusion` fails the test outright. GitHub has nine to Azure DevOps'
four, and `timed_out`, `startup_failure` and `action_required` have no Azure
DevOps spelling at all. **`action_required` is the one that decides it**: a
deployment parked waiting for a person to approve it is the wall's amber exactly,
and under a projection it would have had to become `failed` or `succeeded` —
both lies about a thing that is simply waiting. `waiting` (the same idea as a
*status* rather than a conclusion) is the other. Those two states are the whole
return on carrying two vocabularies.

The reverse gap is recorded rather than papered over: **Azure DevOps expresses an
approval gate as a `Checkpoint` record inside the timeline, not as a state on the
build**, so a build waiting at one still reads `inProgress` and `parked` answers
false. Closing that would mean reading the timeline on every poll — a request per
running build — to improve the wording on a few rows, so it is left.

#### What did and did not need a forge arm

The split is the evidence the seam is in the right place, and it is worth stating
as a claim rather than a list: **the questions a wall asks are forge-independent,
and only the vocabulary is not.**

Untouched, and deliberately not retested per forge: `orderRuns`, `orderReviews`,
`scopeRuns`, `scopeReviews`, `tallyRuns`, `tallyReviews`, `needsMe`, `elapsed`,
`reviewTierOf`, `reviewSaid`. A test asserting those still work on a GitHub row
would be testing that adding a field does not break `.sort`.

Given an arm: `tierOf`, `runSaid`, `landable`, and the new stage/step readings.

- **`landable` is the one that would have shipped as a silent bug.** Azure DevOps
  marks each reviewer required or optional and does not roll it up, so the answer
  is arithmetic over the votes. GitHub does the reverse — it will not tell you
  who is required, branch protection knows and the payload does not — and hands
  you `reviewDecision` instead. So a GitHub row's votes are genuinely all
  `required: false`, and running the Azure DevOps arithmetic over them finds an
  **empty required set and answers vacuously true for every open pull request on
  GitHub**, including ones with changes requested. It would have looked like
  working code. Hence `Review.decision`, carried beside the votes because neither
  half is derivable from the other.
- **`shortRef` loses something and says so.** GitHub sends `head_branch` bare, so
  there is nothing to strip — and a tag push arrives as the tag name with no
  marker (`v0.12.0` reads as a branch). Guessing from the shape was refused: a
  branch genuinely called `v2` is ordinary, and a row that silently mislabels one
  is worse than a row that declines to label it.
- **No GitHub state earns `soft`.** Azure DevOps' `partiallySucceeded` has no
  Actions equivalent at the run level, because a job that fails without failing
  the run is `continue-on-error` and Actions reports plain success. The
  amber-at-half-weight simply never appears on a GitHub row, and nothing was lost
  — the service does not draw the distinction.

#### The credential is `gh`'s, and there is no ladder

**This was the real design question, and the answer is the opposite of the Azure
DevOps one.** That side needs a four-rung ladder because none of its credentials
is reliably enough — GCM's is code-scoped and 401s on builds, which is why a PAT
must be minted, entered and stored, and why `vault.rs` and `Keyring.svelte` exist
at all. GitHub needs none of it: `gh` is already installed and already signed in
on any machine somebody works on GitHub from. Probed 2026-08-27 on this one,
`gh auth status` reports scopes `gist, read:org, repo, workflow` — and `repo` and
`workflow` are exactly and only what Actions runs and pull requests want.

So `gh auth token` is the rung, and **what it is not** is the part that makes it
cheap:

- **Not a second wire format.** `gh` is asked for a *credential*, once an hour,
  and then got out of the way — every request after it is the same `ureq` call
  through the same proxy-aware agent Azure DevOps uses. Shelling out to `gh api`
  per request was the expensive alternative: a process spawn per poll, a second
  JSON envelope, and `gh`'s own error vocabulary layered over GitHub's.
- **Not a second secret to manage.** A PAT in the vault would mean a second
  `Keyring`, a second token to rotate, a second way to be mysteriously
  unauthorised — for a credential the machine already has. This is exactly the
  test stated further up for whether a setting deserves a field: *an organisation
  is derivable from the wall and is read off it; a PAT is derivable from nothing
  and is asked for.* **A GitHub token is derivable here, so it is not asked for.**
  That is the same rule reaching its other conclusion, not an exception to it.

`GH_TOKEN`/`GITHUB_TOKEN` are read **ahead** of `gh` — the opposite order to
`VOLERY_AZDO_PAT`, which is last. The reasoning is not inconsistent: the Azure
DevOps ladder falls through on refusal, so any rung above the variable is by
definition one that works, and putting the variable first could only ever mean a
stale shell profile outranking a sign-in you just did. There is no ladder here —
one credential, taken or not — so the order is not choosing between two working
things, it is choosing what "signed in" means. `gh` itself reads `GH_TOKEN` ahead
of its keyring, so agreeing with the tool is the whole of it.

`gh_names` looks for the binary under every name it goes by, which is the lesson
`az` cost ten days paid before it could be paid again: a bare program name does
not consult `PATHEXT`, so a scoop or winget `.cmd` shim is invisible to
`Command::new`.

#### Pull requests are GraphQL, and it is the cheaper shape as well as the better one

The REST list (`GET /repos/{o}/{r}/pulls`) carries neither `mergeable_state` —
GitHub computes the merge in the background and reports it only on the single-PR
endpoint — nor approvals, only `requested_reviewers`, which is who has *not*
answered. Probed 2026-08-27 against `cli/cli`: a REST row can say a PR is open
and a draft, and cannot say whether it conflicts, whether it is approved, or
whether anybody asked for changes. **Three of the six things `reviewSaid`
exists to say.**

One GraphQL query answers all of it at the same cost — one request per repository
— and folds the caller's identity in free (`viewer { login }`), which on the
Azure DevOps side is a second request against `connectionData`. The only price is
a POST with a body in a module otherwise built on GETs, and the one genuinely
awkward thing about it, handled in `graphql()`: **GraphQL answers 200 and puts
the failure in the body**, so treating a 200 as an answer would return an empty
list and call it a quiet morning.

`reviewRequests` and `latestOpinionatedReviews` are disjoint by construction —
GitHub moves a person from the first to the second when they submit — so "asked
and has not answered" arrives already told apart, which is the distinction
`needsMe` is built on and the one REST cannot make. A team request appears as a
null reviewer (the query only spreads `... on User`) and is dropped rather than
guessed at.

#### The costs run the other way round

Azure DevOps: pull requests are org-wide in one call, builds are one request per
project (six here). GitHub: **both** are one per repository — which is cheaper in
practice, since the number of GitHub repositories on a wall is one or two against
six Azure DevOps projects for a single clone.

GitHub's REST core budget is 5000/hour. Runs poll every 20s, so one repository is
180/hour and nothing to think about, ten is 1800 and still fine, thirty would not
be. A 403 carrying `x-ratelimit-remaining: 0` is told apart from a 403 meaning
"not your repository", because the first says *wait* and the second says *you
cannot*, and confusing them sends you hunting a permission problem you do not
have. A 404 is the same silence Azure DevOps' `Denied::Unseen` counts — GitHub
will not admit a private repository exists.

**`Reviews` gained an `unseen` count**, which was structurally always zero while
pull requests came back org-wide and becomes a real number now that GitHub asks
per repository. The front end had been defaulting it for this half all along
(`#land`, `scan.unseen ?? 0`), so the number simply starts being true.

**Azure DevOps' fault wins a tie** when both halves fault, and that is a judgement
rather than which is checked first: the Azure DevOps half is the one needing a
credential you go and mint, it is the fault `Pipelines.svelte` matches on to offer
the keyring button, and a GitHub fault is nearly always `gh auth login` — a
sentence rather than a panel. Same shape as `get` letting a refusal outrank an
invisibility.

**One mutex at a time.** `azdo_runs` takes the Azure DevOps lock, drops it, then
takes the GitHub one. Both are held across a whole network pass, so a command
taking them in one order while anything else took them in the other would
deadlock the wall for two polls — indistinguishable from the freeze `off_main`
exists to prevent. "Never both at once" is a rule that needs no ordering to be
remembered.

### One run, opened

A left click on a row **opens the run in the app**; the browser is an icon button
beside it, drawn on hover and `:focus-visible`. That order is the sink item's own
reading: what you want nine times in ten is *which step went red*, so that is the
cheap gesture, and the tab you used to open to find it out is one click away for
the tenth — a log, a diff, an artifact, anything the panel does not draw.

- **The `dots` and `lanes` readings get no icon.** No room at that size, and none
  needed: a dot opens the panel and the panel carries the link, so the way out
  exists from every reading without every reading drawing it.
- **The row and the link are siblings, not nested.** A button inside a button is
  invalid and the browser resolves it by swallowing one.
- **A `Pipelines` mounted with no `onrun` still opens the browser.** Which is why
  the pass-through is written `onrun={onforgerun ? … : undefined}` — an
  always-truthy wrapper makes the fallback unreachable.

**Two levels on both forges, and that is a decision rather than what either hands
over.** GitHub gives exactly jobs-and-steps. Azure DevOps gives a flat list of
records with parent pointers across four types — probed 2026-08-27 against a RISE
build, 71 records for six stages, in no useful order, `order` meaning *within
your parent*. The unit both services agree on is the one that runs on an agent
and owns a log (Azure DevOps' `Job`, GitHub's job), so that is a `Stage` here and
the leaf below is a `Step`. `Phase` is a 1:1 wrapper and is dropped; `Stage`
survives as a name prefix, and only when the build has more than one, so a
single-stage build does not carry the word "Build" down every row. `Checkpoint`
records are the approval gate's bookkeeping rather than work and are dropped.

A tree of arbitrary depth — faithful to Azure DevOps, padded on GitHub — was the
alternative and was declined: this is read at a glance in a panel, and a reading
whose indentation depends on which forge answered is one you decode before you
can use it.

- **`worthOpening` unfolds one stage for you**: the first that failed, or failing
  that the first still running. A release pipeline is a dozen stages of which
  eleven are skipped, so unfolding all of them buries the row you opened the
  panel for — and unfolding *none* makes you hunt. Null when nothing stands out,
  because opening something on a run that simply passed would be a guess.
- **`skipped` is `rest`, and getting that wrong is most of what would make the
  panel unreadable.** Five of six stages skipped on any given run means a panel
  that drew them amber would be five-sixths alarm.
- **Not-started and running are told apart by the start time, not the state.**
  Azure DevOps says `pending` for both a queued job and one whose agent has not
  reported. Drawing an unstarted stage celadon claims work is happening that is
  not.
- **`succeededWithIssues` is the timeline's spelling of `partiallySucceeded`** —
  the same service, the same idea, two words, one per level. Both are carried
  verbatim rather than one being corrected into the other, which is why
  `stageTierOf` is its own function rather than a reuse of `tierOf`.
- **`detailSaid` has its own silences**, for the reason `emptySaid` does. A queued
  build genuinely has no timeline records — Azure DevOps creates them as the
  agent picks the job up — so "nothing here yet" is the *normal* first few
  seconds of a run rather than an edge case.

#### The polling is bounded twice

`DETAIL_EVERY` is 5s, faster than either list, and justified by the fact that you
opened it deliberately and are looking at one run. The first bound is the usual
one: nothing polls unless a panel is up.

**The second bound is the one that matters — it stops the moment the run stops.**
A finished run cannot change, so `#pollDetail` clears its own timer when Rust says
`live: false`. Without it, a panel left open on a build that finished this morning
would poll a corporate server every five seconds until somebody closed it, which
is exactly what the whole attach/detach arrangement exists to prevent. `live` is
answered in Rust rather than re-derived from the stages, because a run whose last
job has finished is not necessarily finished.

An answer landing for a run the panel has already left is dropped (`opened.id`
re-checked after the await) — five seconds is long enough for that to be ordinary
— and `App.svelte` wraps the panel in `{#key openRun.id}` so opening a second run
tears the first down. Without the key Svelte reuses the component and the
`$effect` cleanup that stops the poller never fires.

#### What is deliberately left out

**Raw log text.** The sink item asks to "consult the run directly in Volery", and
a stage/step tree with per-step status and timings answers it — that is what you
actually go to the browser for when a pipeline goes red. Streaming the logs is a
much larger job (Azure DevOps pages them per timeline record, GitHub serves a zip
of the lot) wanting `logface.ts`'s substrate, a scrollback budget and a per-step
fetch. The external-link button is what covers the gap on purpose: **the one thing
this panel cannot show you is one click from it.**

**And the floor holds.** No re-run, no cancel, no approve, in the panel any more
than in the list — the argument does not weaken by the reading getting deeper, and
it gets stronger the closer you are to the machinery. This wall spawns agents with
`--dangerously-skip-permissions`; a "re-run failed jobs" button beside a job list
read at a glance would be the most consequential thing in the app.

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

