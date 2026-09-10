---
paths:
  - "src-tauri/src/browser.rs"
  - "src/lib/browser.ts"
  - "src/lib/pane.svelte.ts"
  - "src/lib/Browser.svelte"
  - "tools/probe-browser.ts"
---

# A browser the wall owns, and a page two things drive at once

The ask was "I test with Playwright and then I test it myself in the browser — it would be
great to test the app directly in Volery, some kind of interactive browser widget, not only a
view, very probably the same thing agents could leverage with Playwright so that I can
interact with a page managed by agent."

So the requirement is not *a browser in Volery*. It is **one page, two drivers** — the agent
over CDP and the person with a mouse, in the same session, with the same login, at the same
time. That distinction decides every design question below.

## The first answer was wrong, and the measurement is why

The idea arrived as a way to *save memory*: host pages in a webview or an iframe instead of
letting Playwright launch Chrome, and avoid "RAM issues or Playwright instance leaks". Both
halves of that turned out to be false here, and the numbers are worth keeping because the
argument will be made again.

**There was no leak.** `.claude/rules/processes.md` had already settled it: sink 7f011a39
reported 24 `@playwright/mcp` processes and ~1.0 GB as a day's accumulation, and walking
`ParentProcessId` found nothing orphaned — all of them live servers of live cards, inside the
job object. Re-measured for this work: `close()` on a browser returns to **0 processes and
0 MB**. There is nothing to reclaim.

**And Playwright was not what was using the memory.** Full census on a wall with 9 live cards,
2026-09-03, split by `--user-data-dir` rather than by executable path — which matters, because
`@playwright/mcp` defaults to the **Chrome channel** and therefore drives the same
`Program Files\Google\Chrome` binary as the person's own browser and cannot be told apart by
path. The first split of this measurement was wrong for exactly that reason:

```text
chrome.exe, default profile      27 procs   5562 MB   <- the person's own browsing
node.exe, next dev + expo         2 procs   3720 MB
chrome.exe, ms-playwright-mcp     8 procs    651 MB   <- ONE agent browser, all of it
node.exe, playwright-mcp          2 procs    219 MB
```

Playwright's entire footprint was **~870 MB** against 5.6 GB of the person's own Chrome and
3.7 GB of two dev servers.

**What a browser costs, and therefore what sharing is worth.** Real Chrome, real page — a dev
bundle, not `about:blank`, and that distinction is worth about 100×. The first run of this
probe reported 19 MB per browser because it measured `chrome-headless-shell` on a blank page,
which is a true number about nothing anybody does:

```text
browser A + 1 page                  550.7 MB   ( 9 procs)
browser A + 4 pages                1190.9 MB   (12 procs)  -> 128 MB per page
+ a whole second browser + 1 page  1802.5 MB   (21 procs)  -> 611.6 MB
after close()                          0.0 MB   ( 0 procs)
```

A browser is ~450 MB fixed; a page is ~128 MB. **So sharing one browser saves ~484 MB per
additional card — and a WebView2-hosted page would still cost its own ~128 MB renderer.**
Hosting the page in-app saves approximately nothing that sharing a real Chrome does not
already save, and costs the pinned browser build, cross-browser, real `newContext()`, and an
unauthenticated CDP port on the environment that draws the wall itself. That is the whole
argument against the obvious design, and it is arithmetic rather than taste.

**Iframes are worse and are not a judgement call.** `X-Frame-Options` and CSP
`frame-ancestors` block most real targets, same-origin blocks reading into the frame, and
Playwright cannot attach to a frame in a page without attaching to *that page* — which is
Volery's own UI. It works only for your own dev servers with headers relaxed, which is the
case that needs the least help.

## The bug that was actually there

Nobody was looking for this one. The installed config was the official plugin's bare
`npx @playwright/mcp@latest` with **no `--user-data-dir`**, so every card resolves to the same
default profile. Two clients cannot share a Chrome profile directory:

```text
card A                        : opened
card B (while A holds it)     : FAILED -> "Target page, context or browser has been closed"
```

The error names nothing about profiles. It had not bitten only because one card had ever used
Playwright; it would have, the first time two cards verified a UI at once, and it would have
read as "playwright is broken". `--isolated` fixes it (probed, both clients open), and so does
pointing both at one shared browser.

**The shape wanted**, and the two halves are supplied by different people:

- **`playwright`** → `--isolated`. The one that always works, with no dependency on Volery
  running. This is what a terminal session gets, and repointing *this* at the wall's browser
  would have broken Playwright everywhere the wall is not up. **This half is the user's**, and
  the current arrangement here is the official plugin's own `.mcp.json` hand-edited to carry
  `--isolated --storage-state`, which is why a card sees it as
  `mcp__plugin_playwright_playwright__*`. Note where that edit lives:
  `~/.claude/plugins/cache/claude-plugins-official/playwright/unknown/.mcp.json`, a **cache**
  directory with three sibling versions beside it still holding the pristine
  `npx @playwright/mcp@latest` — so a plugin update reinstates the profile collision above,
  silently.
- **`browser`** → `--cdp-endpoint http://127.0.0.1:9222`. The shared browser, and the one that
  satisfies the actual ask. **This half is Volery's**, since 2026-09-10 — `browser::mcp_server`
  is the entry and `ask::mcp_config` puts it in the card's own `--mcp-config`.

**It was not, for a fortnight, and that is the bug worth keeping.** This section said "what
the wall's config now is" and listed both servers plus "the official plugin is disabled" —
three present-tense claims, none of them true on this machine. `claude mcp list` answered with
eight claude.ai connectors and one *enabled* plugin, and there was no `browser` server in any
scope: not in `~/.claude.json`'s `mcpServers` (empty), not project-scoped, not in a `.mcp.json`
in this repo. So the feature's agent half had never once worked, while
`supervisor::append_prompt` told every card on every turn that `mcp__browser__*` was there.
Reported from a nova card as sink `b6bfecba`; the cost recorded there is not the missing
capability but the confident sentence — a card told it holds a tool it does not hold cannot
say what is wrong, so a wheel-scroll bug was diagnosed by reasoning about the DOM instead of by
looking, and the first fix was wrong.

Two general things fall out, and they are why this is written at length:

- **Documentation that asserts a machine's configuration is documentation nothing keeps
  honest.** It is the `append_prompt` failure one layer up — a confident sentence about a name
  that resolves to nothing, in the place a reader trusts most. The repair is the same one:
  make the thing true by construction, then describe what you built.
- **A feature can be complete everywhere except the one seam nobody owns.** The Chrome, the
  port, the widget, the vault, the screencast, `VOLERY_CDP_ENDPOINT` and the prompt were all
  built and all correct. What was missing was six lines of JSON that neither this repo nor the
  user had been made responsible for, and the gap was invisible from both ends.

## The port is fixed, and that is a constraint rather than a preference

`DEFAULT_PORT` is 9222 and not an ephemeral port. **An MCP server's arguments are settled when
the card spawns and cannot be renegotiated**, and a static config is the only kind the thing
supplying `@playwright/mcp` has — so an endpoint whose port moved between runs could not be
written down anywhere. Everything about the agent half of this feature follows from that one
fact.

`VOLERY_CDP_ENDPOINT` is the other half, in every card's environment while a browser is
running — for test code the agent *writes*, since `connectOverCDP` takes a string and a string
in the environment is one a shell expansion reaches without a round trip. Set only while there
is a browser: an empty variable would read as an endpoint to anything checking whether it
exists.

## The two flags that are load-bearing, both found the hard way

- **`--remote-allow-origins`.** Chrome 111 began closing CDP WebSocket upgrades whose
  handshake carries an `Origin` header, and every connection from a webview carries one. The
  `/json/*` HTTP endpoints answer fine either way, so this fails **after everything appears to
  be working** — the port is up, the target list is right, and the socket dies in the
  handshake naming nothing. `*` is not a widening of reach: any process on this machine can
  already open the port.
- **`--user-data-dir`.** The collision above, and it also buys the thing that makes the widget
  pleasant — a login that survives between turns, because the profile is Volery's own under
  the app data folder rather than a temporary one.

## Why a screencast, and why it costs nothing idle

`Page.startScreencast` **pushes** `Page.screencastFrame` on change and pushes nothing for
stillness: measured **0 frames in 1.2s** on an idle page, first frame 11ms after
`startScreencast` returned. So this is a fold over an event stream rather than a poller —
`CLAUDE.md`'s test — and a browser widget left open on the wall costs nothing while nothing is
happening, which is `motion.md`'s. Frames are ~6 kB on a simple page and ~95 kB for a full
1280×800 view of a real app at quality 80.

**Chrome stops sending until the last frame is acknowledged.** `Page.screencastFrameAck` is
therefore not optional bookkeeping: a missing ack is not a slow widget, it is a picture frozen
forever. It is also what stops a slow reader building a queue it can never drain.

**Rust folds nothing and holds no frame.** The socket is the front end's, because 95 kB of
base64 in a JSON envelope thirty times a second would be serialised and parsed on the main
thread — the only thread that paints the wall, and precisely what `off_main` exists to keep
work off. `browser.rs` starts the process, waits for the port, lists targets, and stops.

## Why the input half works at all

`Input.dispatchMouseEvent` and `dispatchKeyEvent` are synthesized **inside the renderer and
need no real window focus**. That single fact is what makes this feature possible: the widget
can put a click into a page without the wall losing focus, without Chrome coming to the front,
and without competing with the canvas for the pointer. Proved end to end before any of it was
built — a click dispatched from a second, independent CDP client landed in a page Playwright
was driving and the page's own counter went from 0 to 1.

Two things about it are easy to get wrong and are tested:

- **A printable key needs `keyDown` *and* `char`.** Text insertion is driven by the `char`
  event, so `keyDown` alone fires every listener and inserts nothing — a person typing into
  the page would watch their keystrokes do nothing. A non-printable key must get no `char`, or
  Backspace types a character as well as deleting one.
- **Three coordinate spaces, not two.** The pointer arrives in *widget* pixels, the picture
  occupies a letterboxed rectangle of those, and the page thinks in *CSS pixels of its own
  viewport* — which is `metadata.deviceWidth`, not the JPEG's pixel size, and those are
  routinely different. Dividing by the wrong one is the bug where clicks land near the right
  place at one window size and nowhere near it at another. `toPage` divides by the drawn
  rectangle and multiplies by the device size; a click in the letterbox margin returns null
  rather than being clamped to an edge the person did not aim at.

## Three concessions on the wall, each an existing rule rather than a new one

- **`data-live` joins `data-grip` and `data-text` in `Canvas.handleOf`.** Without it
  `groundDown` captures the pointer and the click never leaves the wall. Unlike `data-text`
  this is not about *selecting*, so it deliberately does not pair with `user-select: text` —
  `test/styles.test.ts` keys only on the text marker. The pan buttons still reach past it,
  which is what keeps a full-width page from being a hole in the wall.
- **The wheel is stopped before the surface's own listener.** `Canvas` puts a non-passive
  `wheel` on the surface and `preventDefault`s every one to zoom, which is why `widgets.md`
  says nothing standing on the wall scrolls. A page is the one thing that genuinely must. The
  listener there is on the bubble phase, so `stopPropagation` from the widget is enough.
- **Escape stays the wall's.** A page that swallowed it would make the widget a trap — you
  could not get out without the mouse. Everything else goes to the page.

## The knobs, and the one that is not clamped

`target` leads with `FOLLOW`, the same literal the three logs use, and here the argument is
stronger than it is for a server group: **pages are opened and closed by the agent as it
works**, so a widget pinned to a page id would be pointing at nothing within the hour and
there is no gesture by which you would re-pin it. It is also what makes the spec honest — a
sourced knob still has to hold its own default among its literal options, or a widget read
back with nothing resolved comes off disk undrawable.

`normalizeConfig` deliberately does **not** clamp `target` to the known list. A page id is
whatever Chrome minted and the valid set is not knowable at that layer, which is the same
exemption `normalizeParam` already grants every sourced knob.

The catalogue's own invariant tests caught two mistakes in the first draft of this spec — the
default missing from the literal options, and the knob being unreachable because the test
fixture had never heard of `pages`. Both were the tests being right.

## Two ways to have a browser, and the agent chooses

The concurrency question was asked as "several agents testing several projects at once — is
that supported?", and the answer needed splitting. `--isolated` gives every card its own
browser and full parallelism, and does it by **throwing the session away** — which is the
opposite of what was wanted, because signing into rise, nova, mikano and sdp once per card is
the cost being complained about.

A browser *per project* was proposed and rejected by the person who asked, correctly: the
conflict is per **agent**, not per project. Two agents in one project may want to be two
different users, and a project-shaped boundary cannot express that.

So there are two servers and the agent picks:

| | `browser` | `playwright` |
|---|---|---|
| what it is | the shared Chrome Volery owns | its own isolated browser |
| sign-in | **live and shared** — one refresh serves everybody | **seeded** from the vault at start |
| cost | ~450 MB for the whole wall | ~580 MB per card |
| isolation | none; one cookie jar | complete |
| blast radius | an agent clearing cookies logs everybody out | itself |

An agent that needs to *be somebody else*, or that clears state in its teardown, takes
`playwright`. One that wants the live session and the cheapest footprint takes `browser` —
and that is also the one the widget shows, so it is what you use when you want to take the
mouse yourself.

## How a card learns any of this

Configuration alone does not teach it. An agent sees `mcp__browser__*` and
`mcp__playwright__*` with **`@playwright/mcp`'s own upstream descriptions**, which cannot
mention a shared Chrome, a widget somebody is watching, or a vault — none of those exist in
the world that server knows about. So it is a coin flip, and one side is expensive: an agent
that takes the shared browser and clears cookies in its teardown, which is the correct
instinct everywhere else, signs every other card out of everything at once.

Four mechanisms were available and only one fits:

- **An `mcp__skein__*` tool** is the wrong shape. An agent does not ask about a capability it
  does not know exists, and making it visible means the roster's always-loaded tier, which
  `ask.rs` is explicit about paying for.
- **Guidance** (`guidance.rs`) is right for a *policy* — "in this project always use the
  shared one" — and wrong for the capability. You would have to type it, and a card roused
  from last month would not have it. Guidance is instructions, not documentation.
- **A per-project `CLAUDE.md`** is per project, and this is wall-wide.
- **`--append-system-prompt`** (`supervisor::append_prompt`), by that function's own stated
  criterion: kept to what the tool descriptions cannot say, and left off a chat card — which
  spawns with no browser at all, so telling it would be an instruction to try what it will be
  refused.

**And then it was cut to half its first draft**, which is the part worth carrying. Anthropic's
own guidance is that knowledge only *sometimes* relevant belongs in a skill loaded on demand
rather than in the prompt every conversation pays for, and that a bloated instruction file
makes an agent ignore the instructions that matter. Browser testing is sometimes. So what
stayed is only what an agent cannot usefully be told *later*, because by then the damage is
done: that the shared browser is shared, that its cookies are not its own, and that a login
page is a question for the person rather than a puzzle to solve with credentials it should not
have. Everything else — the vault, the widget, `VOLERY_CDP_ENDPOINT`, the reasoning — is in
this file, which loads when somebody opens a file it governs and costs nothing otherwise.

The test for anything proposed for that paragraph in future: *would an agent that learned this
too late already have broken something for somebody else?* If not, it belongs here.

**The coupling was real and unguarded, and it broke.** The two server *names* in that
paragraph came from the user's own MCP configuration, which this app did not write, so the
prompt made a claim the code could not verify — and `named_tools` cannot catch a drift, being
scoped to `MCP_PREFIX` by construction. Both names were wrong: `mcp__browser__*` had no server
at all, and the user's own is `mcp__plugin_playwright_playwright__*` rather than
`mcp__playwright__*`.

**So the shared half is now Volery's and the other half is no longer named.**
`spawn_now` reads `browser::endpoint` once and uses it three times — the `VOLERY_CDP_ENDPOINT`
variable, the `browser` entry in the `--mcp-config`, and whether `append_prompt` may claim the
family exists — so a card cannot be handed any two of the three and not the third. The other
family is *described* ("any other browser server here is your own") rather than named, because
a name this app does not control cannot be printed in the one paragraph every card pays for on
every turn; `the_prompt_names_no_browser_volery_does_not_supply` is asserted inside
`the_prompt_tells_a_card_which_browser_is_shared`, and
`the_browser_server_and_the_paragraph_agree` holds the config and the prose to the same flag
in both directions. The false arm is the one that matters — a paragraph naming the tools
unconditionally passes every other assertion on a wall with no browser running, which is
exactly how this shipped.

**And the absence is now said rather than left silent.** A card spawned with no browser
running is told so, in one sentence, and told that starting it is a button on the widget. That
is the direct answer to the sink item's second question: Volery cannot inject tools into an
open card, and the honest substitute is a card that can complain precisely instead of
reporting "no volery browser tools on this wall" with no idea why.

**What is proven and what is not.** `browser::mcp_server`'s doc comment carries the probe:
spawned with exactly that entry, `system/init` reports the server connected and 24 tools under
`mcp__browser__`. That is the claim — *the tools reach a card* — and it was made against a
hand-built `--mcp-config` rather than against a Volery build, because this machine has no MSVC
toolchain and cannot compile the app. Whether a card can then *drive* the browser is untested
by anything here.

## The vault

`%APPDATA%\dev.skein.studio\sessions\wall.json`, in Playwright's own `storageState` shape,
and `playwright` is pointed at it with `--storage-state`.

**One file for the whole wall, not one per app.** `storageState` already carries cookies for
every domain and local storage for every origin in a single document, so splitting it would
be inventing a structure the format does not have — and a card would then have to know which
file its app was in, which is knowledge it has no way to get.

**Proved end to end** with `probe-browser.ts vault` before any of it was relied on: set a
cookie and a localStorage token in the shared browser, capture, write, then seed a *fresh
isolated* browser and read both back. Both carried. That is the whole feature in one run, and
it is the branch to re-run if seeding ever stops working.

Four decisions in the capture, each of which is a bug avoided rather than a preference:

- **Local storage is read with `Runtime.evaluate`, not the `DOMStorage` domain.**
  `DOMStorage.getDOMStorageItems` is keyed by `securityOrigin` in older Chromes and by
  `storageKey` in newer ones, so using it means knowing which Chrome is on the other end.
  `Object.entries(localStorage)` has meant one thing for fifteen years. This matters more
  than it looks: an MSAL app keeps its token in local storage, so the cookie half alone would
  carry next-auth sign-ins and silently miss Microsoft ones.
- **Every open page is read, not only the attached ones.** You sign in on a tab; whether a
  widget happened to be pointed at that tab is irrelevant to whether the session should be
  saved. So the capture borrows a socket per target for the length of one question and closes
  it, leaving `#live` undisturbed.
- **A missing `sameSite` becomes `Lax` rather than `undefined`.** Playwright *requires* the
  field and rejects the whole document without it, so one under-specified cookie would cost
  every other sign-in in the vault. `Lax` is what Chrome itself treats absence as, so this is
  a translation and not a guess.
- **An expired cookie is dropped.** Seeding a dead one is worse than seeding nothing: the
  browser takes it, the app reads it, and the failure looks like the app rather than like the
  vault.

Two more, on either side of the write:

- **The vault is created empty at `setup`, before any card can spawn.**
  `--storage-state <path>` with a path that does not exist is a browser that will not start,
  and the card that discovers that is one whose turn is already spent. It cannot fail the
  launch — unlike `Store::open` nothing here is load-bearing for drawing the wall, so it logs
  and carries on, which is the one place in `setup` where that is the right answer.
- **The write is atomic, and parsed before it happens.** Several agents may be starting at the
  moment you press save, and a card reading a half-written vault gets a parse error and no
  session. Write to a sibling and rename. Parsing first is the same argument one step earlier:
  this file is handed to every seeded browser on the wall, so one that will not parse costs
  every card at once, and it is cheaper to refuse it than to write it.

**Saving is a widget action rather than a panel entry**, because it is the gesture you make
immediately after signing in and the browser you signed into is the thing on screen. It is
also the one button on a log-family face that cannot destroy anything — the rule that keeps
stop buttons out of these widgets is about a mis-drag killing a server, and writing a file
twice is writing it once. It says what it wrote, with numbers: a bare "saved" is
indistinguishable from having written an empty file, which is exactly the case worth noticing
— you pressed it before signing in, or on a page whose auth lives somewhere this cannot
reach.

**What the vault cannot carry**: IndexedDB, sessionStorage, and service-worker caches.
`storageState` covers cookies and local storage and nothing else. An app keeping its token in
`sessionStorage` is one where only the shared `browser` will do.

## What is not built

- **Volery does not start the browser by itself.** No auto-start at launch, because that is
  ~450 MB for a wall that may never open a browser widget, and no lazy start on the agent's
  behalf, because nothing announces that a card is about to want one. The widget's start
  button is the gesture.

  **The cost is now sharper than "the tools fail", and it is the one rough edge left.** The
  `browser` entry is supplied only when a browser is running *at spawn*, so a card opened
  before you press start does not have the tools at all and cannot be given them — an MCP
  server's arguments are settled when the card spawns and there is no renegotiating them.
  Waking the card is a spawn, so a rouse picks them up; nothing short of that does.

  **Conditional rather than always, and the arithmetic is why.** An idle
  `npx @playwright/mcp --cdp-endpoint` with no browser attached is 2 node processes and
  ~212 MB, measured 2026-09-10 and consistent with the census above — spawned per card, at
  card start, whether or not that card ever looks at a page. Passing it unconditionally would
  make every card on the wall pay that for a browser most of them will never touch, which is
  the same trade auto-start was refused on one paragraph up. Ten cards is 2 GB. The
  alternative buys one thing — a card opened before the browser gains the tools when you
  press start — and `processes.md` is the whole argument against paying that way for it.
- **No navigation bar.** The agent navigates, and `Page.navigate` is wired in `pane.svelte.ts`
  for whatever wants it, but there is no address field on the widget. Deliberate for now: the
  page you are testing is one the agent opened, and a URL field invites the widget to become a
  browser rather than a view of the agent's browser. Worth revisiting the first time somebody
  wants to check a second route by hand.
- **One browser, not one per territory.** Nothing stops a second, but the port is a single
  constant and the config that points the agent at it is wall-wide.

## The probe

`bun tools/probe-browser.ts` — except **it must be run with `node`, not `bun`**:

```powershell
node --experimental-strip-types tools/probe-browser.ts cost      # per-browser vs per-page
node --experimental-strip-types tools/probe-browser.ts collide   # two clients, one profile
node --experimental-strip-types tools/probe-browser.ts share     # agent + widget on one page
node --experimental-strip-types tools/probe-browser.ts vault     # sign in once, seed an isolated browser
```

Playwright's `launch()` **never returns under Bun** on this machine — the import resolves and
`chromium` is there, and the launch hangs indefinitely rather than failing. Every other probe
in `tools/` is `bun tools/probe-*.ts`, so this is the exception and it is why the file says so
at the top. It owns `.scratch/browserprobe/` and deletes only that.
