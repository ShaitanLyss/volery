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

## The port is fixed, and that turned out to be worth more than it was chosen for

`DEFAULT_PORT` is 9222 and not an ephemeral port. **An MCP server's arguments are settled when
the card spawns and cannot be renegotiated**, and a static config is the only kind the thing
supplying `@playwright/mcp` has — so an endpoint whose port moved between runs could not be
written down anywhere. Everything about the agent half of this feature follows from that one
fact.

**And then the same fact paid for the lazy start.** A fixed port means the address can be
written down *before there is anything at the other end of it*, which is what lets every card
hold `mcp__browser__*` whether or not a Chrome exists. `browser::address` takes no app handle
and asks nothing about a running browser; it is a constant. See the lazy-start section below
— it is the one place where a constraint this file spent a page apologising for turned out to
be the mechanism.

`VOLERY_CDP_ENDPOINT` is the other half, in **every** card's environment — for test code the
agent *writes*, since `connectOverCDP` takes a string and a string in the environment is one a
shell expansion reaches without a round trip.

It used to be set only while a browser was actually running, on the argument that an empty
variable would read as an endpoint to anything checking whether it exists. That is still true
about an empty one and is no longer the right conclusion, because the variable stopped being
evidence: the address is correct at all times and what varies is whether anything answers.
**So its meaning is narrower now — where the wall's browser is, not that there is one.** A
card that wants one up calls a `mcp__browser__*` tool, which starts it.

**That leaves one rough edge and it is not fixable in this direction.** An environment is
written at spawn and cannot be added to afterwards, so a card that wakes the browser through
a tool call still has the same variable it always had — correct, and pointing at something
that is now running, which is the good case. A card that reaches for `connectOverCDP` *first*,
with no browser up, gets a connection refused and has to call a browser tool to wake one. The
hook cannot help there: it fires on tool names, and starting a 450 MB browser because a shell
command happened to mention a variable is not a trade worth making.

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

**The absence used to be said, and now there is no absence to say.** For a while this
paragraph had a second arm — eighty words telling a card the shared browser was not running,
that it therefore had no `mcp__browser__*`, and that it could not be given any until it was
woken again. That was the honest answer to the sink item's second question at the time, and
the honest substitute for a capability nobody could hand over: a card that can complain
precisely beats one reporting "no volery browser tools on this wall" with no idea why.

It is gone because the condition is gone; see the lazy-start section. What replaced it is one
clause about **latency**, and that clause is doing real work rather than padding the
paragraph. The first browser call on a sleeping wall takes a second or two longer than the
rest, and an unexplained pause is the exact shape an agent misreads as a hang — after which it
retries, or reaches for the other browser family, or reports the tool broken. Eleven words
before the wait forecloses all three; the same words after it would arrive too late to be
worth anything. It promises no figure, because a cold Chrome on a cold profile is not a number
that paragraph can honour.

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

## Where it stands on your desktop

Asked on 2026-09-11, and the whole of it: *"when I start volery browser, it literally opens a
chrome window. Is there any way to see it visually in volery but not see it as a chrome window
outside volery?"*

There are two honest answers rather than one, so `browser::Mode` is a setting with three
values — `window`, `parked`, `headless` — and the default is `parked`, because that is what
was asked for. All of it was measured before any of it was built, and **the measurement
overturned the design twice**, which is why the numbers are here rather than a summary of
them.

`probe-browser.ts hidden`, Chrome 152.0.7977.83, screencast held 30s against a page
repainting every 50ms. Two shorter runs agreed with the long one on every row:

```text                                       frames/30s   a new tab does what
a window, as it was before any of this            599      nothing
SW_HIDE, no extra flags                           597      PUTS IT BACK ON THE DESKTOP
SW_HIDE, + the three occlusion flags                1      PUTS IT BACK ON THE DESKTOP
parked off-screen, + the three flags              602      nothing
parked off-screen, no extra flags                 601      nothing
headless                                          597      there is no window
```

**Hiding loses to Chrome, and that is the finding the design rests on.**
`ShowWindow(SW_HIDE)` is the obvious implementation. Opening a *tab* re-shows the window — the
same `HWND` flips visible again, on every run — so every page the agent opened would flash
Chrome onto your desktop and need chasing back down. Parking it at (-32000, -32000) with
`WS_EX_TOOLWINDOW` survives a new tab untouched, because Chrome calls `ShowWindow` and never
repositions. Only a genuinely new *window* — an OAuth popup — lands somewhere visible, and
that is what `browser_park` re-parks.

**The three occlusion flags were shipped for a day on a justification the control run
disproved.** `--disable-features=CalculateNativeWinOcclusion`,
`--disable-backgrounding-occluded-windows` and `--disable-renderer-backgrounding` went in on
the reasoning that a window nobody can see is one Chrome stops painting. Read the last two
rows: parked with them is 602 frames and without them 601. They buy *nothing* for a parked
window, because such a window is not occluded in Windows' sense — `IsWindowVisible` is true
and nothing overlaps it; it is simply outside every monitor. They came out rather than being
left in as insurance, and the row above them is why: in the one configuration where those
flags change anything, they make it **worse** — `SW_HIDE` with them delivers 1 frame in 30s,
reproducibly, against 597 without. Flags with an interaction that surprising do not belong on
a path that measures fine without them.

Two general things, and they are the reason this reads as a confession:

- **The first probe measured the wrong thing and agreed with me.** It applied the hide at
  launch, then created a page — and creating a page creates a *tab*, which puts the window
  back. So the frame count was of a perfectly visible window, and it read as confirmation.
  What caught it was the row being *inconsistent between runs* (0, then 58, then 1), which is
  the tell: a number that will not reproduce is not a measurement, however much it agrees
  with you.
- **The control was missing.** Hiding was measured with and without the flags, and then the
  flags were claimed on behalf of *parking* — a different thing being done to the window.
  Nobody had run the pair that shipped. `parked, no extra flags` is that row, and it is in
  the probe now so the next person cannot skip it either.

**So `window` and `parked` put identical arguments on the command line**, and the only
difference is where `park_windows` puts the window once it exists. That makes both live: a
browser started in a window can be parked, and one started parked can be shown, which is
`browser_show` / `browser_park` and the two buttons on the widget. Headless is the only mode
that cannot be moved, having no window at all.

**Headless is visible on the wire, and only there.** `--headless=new` sends
`HeadlessChrome/152.0.0.0` in the `User-Agent` header — real, not folklore — while the
`Sec-CH-UA` client-hint brands are byte-identical to a headed browser's. That second half is
what makes an override worth doing: one that fixed the string while leaving the hints
contradicting it would be a *more* distinctive fingerprint than the honest one, and there is
nothing here to contradict. So `spawn_browser` launches headless once, asks `/json/version`
what it just sent, deletes the word `Headless`, and relaunches with `--user-agent`. Derived
rather than composed from a template, deliberately: the alternative is this app holding an
opinion about Chrome's user-agent format, which Google has changed twice in living memory, and
about Edge's, which differs. The cost is one extra launch, paid only in headless mode and in
practice by the launch restore, which runs behind the painted wall.

**Whether Microsoft's sign-in actually objects to `HeadlessChrome` is untested** and was
asserted in conversation before it was checked. It is moot for the shipped default — parked is
a headed Chrome — and neutralised for headless by the override, but nothing here has driven a
real corporate sign-in and this file should not imply otherwise.

## Coming back up the way you left it

**Volery now restores the browser that was running when the wall closed**, and this section
used to say the opposite, at length.

The old refusal was right about what it was refusing: no *unconditional* auto-start, because
that is ~450 MB for a wall that may never open a browser widget, and no lazy start on the
agent's behalf, because nothing announces that a card is about to want one. What it did not
consider is the third thing — a browser that was demonstrably in use when the wall closed.
That is not a guess about what you might want, it is a record of what you had, and it costs
nothing on the walls the arithmetic was protecting.

`browser_state` (schema v33) is one row beside `window_frame`, for the same reason: a fact
about the app rather than about anything on the wall, and there is only ever one of it.
**`was_running` is written at both ends of the browser's life rather than at exit**, which is
`set_mid_turn`'s lesson restated — code that runs at exit is exactly the code a crash skips,
so a wall that was *killed* holding a browser comes back holding one. Stopping it on purpose
is what stops the next launch bringing it back, and that is the only thing distinguishing the
two.

**It used to close a rough edge as well, and that half of its justification has expired.** The
`browser` entry was supplied only when a browser was running *at spawn*, so a card opened
before you pressed start never had `mcp__browser__*` at all — and restoring the browser at
launch was what gave the cards roused at launch their tools. That needed the two halves
ordered, and they were: a `starting` flag published before the background thread began, and
`Skein.rouse` awaiting `browser_await_start` before its first spawn.

**Both of those are deleted.** Cards hold the tools regardless now, so there is no gap to
order against, and what the wait had become was a second or two of nothing at the head of
every launch that restored a browser. `browser_await_start` is gone rather than unused — a
command still registered is one the next reader has to work out the purpose of.

What the restore still does is put back **the page you were looking at**. A widget showing a
live browser is furniture, and a wall that comes back with its furniture missing reads as
having forgotten something. That is a smaller claim than the one it used to make and it is
still worth the ~450 MB, because it is only ever paid on a wall that demonstrably had a
browser open when it closed.

Nothing about it delays the window. `setup` loads the mode synchronously and returns; the wall
paints while Chrome is still starting.

## The browser starts itself, in front of the call that needs it

The ask, from a card on `nova` that had been asked to drive a UI and had to say it could not:
make the tools **always** available and start Chrome **lazily**. What stood in the way was one
sentence this file had repeated in four places — an MCP server's arguments are settled at
spawn, and `--cdp-endpoint` needs a value that does not exist until Chrome is running.

**That sentence is true about arguments and says nothing about connections**, which is the
whole of it. `tools/probe-lazy-browser.ts`, 2026-09-19, `@playwright/mcp` pointed at a port
with nothing bound to it:

```text
initialize              ok in 1030ms
tools/list              25 tools
first tools/call        isError: connect ECONNREFUSED 127.0.0.1:19222       [22ms]
…Chrome started…        385ms
second tools/call       ok — same server process, no restart              [1800ms]
```

Three findings, each of which had to hold:

- **The endpoint is an address, not a dependency.** The server comes up and advertises all 25
  tools with nothing listening. So the entry can be written into every card's `--mcp-config`
  at spawn, and `browser::address` is a constant rather than a reading.
- **The failure does not latch.** One process, one refused call, Chrome appears, next call
  succeeds. A server that cached its first CDP failure would have made this unbuildable.
- **It does not dial at startup at all.** A third arm pointed it at a listener counting its
  accepts: **zero** across `initialize` and `tools/list`. So registering the server costs no
  connection, and therefore nothing that could be made to start a browser by itself.

### The hook is what stands in the gap

Between the model asking for a browser tool and the server reaching for a socket there is a
window, and Volery already has something standing in it: the `PreToolUse` hook it hands every
card (`hooks.md`). `tools/probe-mcp-hook.ts` measured the two things that had to be true of it
— it fires for **MCP** tools, with `tool_name` as the prefixed name, and **the CLI waits for
it**: a hook that held for 1.5s in front of an MCP call had that call run 69ms after it
returned.

So `hooks::wakes_browser` routes on `mcp__browser__`, `hooks::wake_browser` POSTs to
`ask::WAKE_PATH`, and `browser::ensure_running` puts a Chrome up. On success the hook says
nothing and the call proceeds; on failure it returns `permissionDecision: "deny"`, which stops
the call and reaches the model.

Four things about that shape are load-bearing:

- **The hook asks Volery rather than spawning Chrome itself.** A hook is a short-lived child
  of the *card*, so a Chrome it spawned would be outside Volery's job object, unreaped at
  quit, invisible to the widget and unknown to `browser_stop` — the orphan `processes.md` is
  entirely about, built on purpose. The wake route is on the listener the card's argv already
  carries, so it invents no second channel.
- **It does not fail open**, which is a departure from that module's rule. The compensator
  fails open because an uncompensated command still runs; here there is nothing to fail open
  *to*. A browser tool with no browser cannot succeed however quietly we step aside, so the
  choice is between a refusal that explains and playwright's `ECONNREFUSED 127.0.0.1:9222` —
  a port the agent has never heard of, with an invitation to go and find another browser.
- **The claim and the check are under one lock.** Two cards asked to drive a UI in the same
  second is a Tuesday, and the loser of that race does not fail cleanly: its `await_ready` is
  answered by the *winner's* browser, so it reports success holding a child that bound
  nothing. `ensure_running` claims `starting` in the same critical section that finds nothing
  running; everyone else waits on it.
- **The `PreToolUse` timeout had to go up.** It was 10s and a wake can take longer; a hook the
  CLI kills prints nothing, and printing nothing is how that module says *allow*. So it is 50s
  against a 40s `WAKE_TIMEOUT`, and `lift-browser.ts` asserts the relationship rather than the
  numbers — the failure is a ceiling wrong in the permissive direction, which is the shape
  this codebase refuses everywhere.

### And the widget had to be told, because nothing had ever needed to tell it

`Pane.refresh` was reached from three places: the start button, `saveSession`,
and CDP target events — which arrive over `#watcher`, **a socket that only exists
once a browser has already been found**. So a browser that came up any other way
left the widget reading "not running" for ever.

That was already true of the launch restore, and it was survivable, because the
only other way to get a browser was the button in that very widget: press it,
`ensure_running` finds one already up, `refresh` runs, and the face corrects
itself. Nobody would have called it a bug.

**A card starting one is what made it a bug**, and a bad one — the widget's
entire job is to say whether there is a browser, and it would have said no with
an agent driving a page through it. So `browser::announce` emits
`browser:changed` at both boundaries: when a start is claimed (the face says
"starting the browser…" and offers no second start), when it settles either way
— from the `Starting` guard's `Drop`, so a *failed* start redraws too rather
than leaving "starting…" up for ever with no button — and when a browser is
stopped.

It is a fold over an event that is made to exist at the moment of the change, by
the code making the change, which is what `CLAUDE.md` asks for in place of a
fourth poller. There is no clock and nothing to stop. The payload is empty on
purpose: the front end is about to read the status, the target list and the
browser socket together, and a status in the envelope would be a second, racier
copy of a reading it is going to take properly.

`Pane` therefore holds a subscription and owes a release — `release()` detaches,
and `snapshot.listeners.pane` is how a superseded generation is seen from
outside, which is the rule `CLAUDE.md` states for every other class here.

### Volery will not adopt a browser it did not start

`await_ready` polls `/json/version` and takes the first answer, and for the whole
of this feature's life nothing asked **who owned the port**. That was survivable
while a browser could only start two ways — a person pressing the button, or a
launch restore — because both have somebody watching.

Every `mcp__browser__*` call now reaches `ensure_running`, so it stopped being
survivable. Two shapes, both ordinary:

- **The person's own Chrome, started with a debugging port** — a common dev
  habit, and one `resume_at_launch`'s own comment already named as the commonest
  cause of a failed restore. Volery's Chrome launches on its own profile, fails
  to bind 9222, and stays up as a plain window; `await_ready` is answered by the
  *person's* browser and `Running` is stored pointing at it. Every card on the
  wall would then be driving their live sessions, with `browser_close` and
  `browser_run_code_unsafe` among the tools, while `browser_stop` killed the
  window Volery spawned and left the driven one running outside the job object.
- **A Chrome already holding Volery's own profile.** Chrome's profile singleton
  hands the new process's command line to the existing instance and **exits
  immediately**, so `await_ready` succeeds off that instance and `Running.child`
  is dead the moment it is stored. The reap in `ensure_running` then fires on
  the next call and does it all again — a process spawn, a `save_browser_state`
  write and two `browser:changed` emits **per browser tool call**, with the
  widget flapping between running and not for the length of the turn.

Two guards, because the two shapes are caught at different moments:

- **`port_is_free`** bind-tests the port before spawning and refuses by name.
  There is no ownership to check — CDP has no notion of a credential and
  `/json/version` says nothing about who started the browser — so binding is the
  only question with an honest answer, and it is the same question Chrome is
  about to ask. It races, which is fine: the listener is dropped before Chrome
  is spawned, so this is a diagnostic that turns a silent adoption into a
  refusal naming the cause, not a lock.
- **`await_ready` bails when the child has exited.** A process that is gone did
  not open this port, so whoever answered is a stranger. This is what catches
  the profile-singleton handoff, which no bind test can see — the port is
  legitimately occupied by a Chrome, just not ours.

`await_port_closed` is the same fact from the other side, and is why the headless
relaunch waits: `kill` reaches one process and Chrome is a dozen, so the port
outlives the handle. `tools/probe-lazy-browser.ts` measured that as a 30-second
timeout that looked exactly like the whole design being unworkable.

The general shape, which is the reason this is written at length rather than
fixed quietly: **a check nobody performs is affordable only for as long as a
person is standing where it would have run.** Automating the gesture is what
turns a latent adoption into a routine one, and the automation is the change
that owes the check.

### The proxy was the other answer, it works, and it is not what shipped

Arm D of the same probe built the alternative: a port Volery always has bound, which starts
Chrome on its first connection and then splices bytes to it. It works — tools listed with no
Chrome, first tool call starts one in 448ms and succeeds. So this is a choice rather than an
elimination, and the reasons are:

- **A TCP accept is not evidence that anybody wants a browser.** Anything touching the port
  starts 450 MB of Chrome — a stale playwright from a dead card, a port scan, a `curl` by
  hand. A card calling a browser tool is unambiguous.
- **The proxy cannot say anything.** When Chrome will not start, all it can do is close the
  socket, and playwright reports a timeout naming a port. The founding bug of this whole
  subsystem (`b6bfecba`) is *a card unable to say why*, so a mechanism with no voice loses on
  the criterion this file already cares most about.
- **It would give the wall two addresses for one browser.** The widget, `browser_targets`,
  `browser_open` and the screencast socket all speak to 9222 directly.

What the proxy would have bought, and the hook does not, is agent-written
`connectOverCDP($VOLERY_CDP_ENDPOINT)` — which dials the port without going through any tool.
That is the rough edge recorded above. If it ever matters more than the three objections, arm
D is already proved and is the thing to build.

**Two of that arm's three failures were the prototype's own**, and they are worth knowing
because both read as the design being impossible: bytes arriving while the proxy is still
starting Chrome have to be *kept* (bun drops them across an `await` even after `pause()`), and
a killed Chrome holds its port for a moment after the handle is gone. A Rust implementation
gets the first for free — not reading a socket leaves the bytes in the kernel buffer.

### What it costs, and this is the part to argue with

This section used to carry the paragraph *"conditional rather than always, and the arithmetic
is why"*, and that arithmetic did not go away — **the feature spends it deliberately.**
Re-measured 2026-09-19, one idle `@playwright/mcp` pointed at a dead endpoint, private commit
of the whole tree:

```text
npx @playwright/mcp@latest --cdp-endpoint …    3 procs   216.7 MB
   node.exe  (the npx wrapper)                            99.9 MB
   cmd.exe                                                11.4 MB
   node.exe  (the server itself)                         105.4 MB
node <cache>/@playwright/mcp/cli.js …          1 proc    105.3 MB   <- same 25 tools
```

**That is per card, at card start, whether or not the card ever looks at a page**, and it is
the cost of the thing that was asked for: tools that are always listed need a server that is
always running. No mechanism avoids it — the hook and the proxy pay it identically — so it is
not a consequence of choosing one.

What changed is who pays. Before, a card spawned while a browser happened to be running paid
it; on a wall that keeps a browser up, that was most cards already. Now every project card
does. Ten cards is ~2.2 GB on a machine `processes.md` measures at 15.8 GB, and that file's
whole argument is against paying that way.

**And 111 MB of it is `npx`, for nothing.** The wrapper is two processes that resolve a
package and then sit there; running the same `cli.js` under `node` directly serves the same
25 tools in 1 process at 105 MB. Halving the cost of this feature is available and is *not*
taken here, deliberately: resolving that path means reading npm's hash-named `_npx` cache,
which freezes the version `@latest` exists to move, and fails on a machine that has never
cached it — a silent failure in the direction of a card with no browser tools, which is
exactly the bug this subsystem was created by. It wants to be its own change with its own
fallback, and it would benefit every card that already carried the server. Filed in the sink
with these numbers.

The other end of the ladder, for whoever picks that up: a shim registered in place of
`@playwright/mcp` — Volery's own binary answering `initialize` and `tools/list` from a cached
schema and spawning the real server only on the first `tools/call` — takes the resting cost to
roughly a small Rust process, and subsumes the hook. It costs an MCP server implementation, a
schema cache and a version-drift story, which is why it is named here rather than built.

## What is not built

- **No navigation bar.** The agent navigates, and `Page.navigate` is wired in `pane.svelte.ts`
  for whatever wants it, but there is no address field on the widget. Deliberate for now: the
  page you are testing is one the agent opened, and a URL field invites the widget to become a
  browser rather than a view of the agent's browser. Worth revisiting the first time somebody
  wants to check a second route by hand.
- **One browser, not one per territory.** Nothing stops a second, but the port is a single
  constant and the config that points the agent at it is wall-wide.

## The probes

Three of them now, and only the first has the `node` restriction.

```powershell
bun tools/probe-lazy-browser.ts   # when @playwright/mcp dials its endpoint, and
                                  # whether the browser may arrive after the card.
                                  # No API turn; one Chrome on port 19222, its own profile
bun tools/probe-mcp-hook.ts       # whether a PreToolUse hook sees an MCP call and whether
                                  # the CLI WAITS for it. Two real turns, pinned to Haiku
```

Both are what the lazy start rests on, and both are written to be re-run when the CLI or
`@playwright/mcp` updates — the failures they guard against are silent in the direction that
matters. `probe-lazy-browser` never touches the wall's own browser on 9222.

`bun tools/probe-browser.ts` — except **it must be run with `node`, not `bun`**:

```powershell
node --experimental-strip-types tools/probe-browser.ts cost      # per-browser vs per-page
node --experimental-strip-types tools/probe-browser.ts collide   # two clients, one profile
node --experimental-strip-types tools/probe-browser.ts share     # agent + widget on one page
node --experimental-strip-types tools/probe-browser.ts vault     # sign in once, seed an isolated browser
node --experimental-strip-types tools/probe-browser.ts hidden    # a browser you cannot see
HOLD=30000 node --experimental-strip-types tools/probe-browser.ts hidden   # ...for half a minute
```

`hidden` is **not** in `all`, deliberately: it launches five browsers in a row and moves real
windows around your desktop, which is not a thing to do to somebody who asked for the memory
figures. It is also the one branch that needs no Playwright — the questions are about windows
and headers, and a driver in between would bring opinions about exactly the flags under test.

`HOLD` is the screencast's duration and defaults to 3000. Three seconds answers *does it paint
at all*; thirty answers *does it keep painting*, which is a different question because Chrome's
occlusion calculation is throttled — a window it will eventually give up on still paints for
the first few seconds. If a parked browser's picture ever goes stale after minutes rather than
seconds, `HOLD=300000` is the run that would show it, and the three occlusion flags removed
from `raw_spawn` are the first thing to try putting back.

Playwright's `launch()` **never returns under Bun** on this machine — the import resolves and
`chromium` is there, and the launch hangs indefinitely rather than failing. Every other probe
in `tools/` is `bun tools/probe-*.ts`, so this is the exception and it is why the file says so
at the top. It owns `.scratch/browserprobe/` and deletes only that.
