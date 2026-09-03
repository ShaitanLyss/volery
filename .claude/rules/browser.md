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

**What the wall's config now is**, and the shape is deliberate:

- **`playwright`** → `--isolated`. The one that always works, with no dependency on Volery
  running. This is what a terminal session gets, and repointing *this* at the wall's browser
  would have broken Playwright everywhere the wall is not up.
- **`browser`** → `--cdp-endpoint http://127.0.0.1:9222`. The shared browser, and the one that
  satisfies the actual ask. Its browser tools fail while nothing is running there, which is
  honest — the widget's own start button is the fix, and a person who wants to take the mouse
  has the widget open anyway.
- The official plugin is **disabled**, because its arguments are fixed and its default profile
  is the collision.

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

## What is not built

- **Volery does not start the browser by itself.** No auto-start at launch, because that is
  ~450 MB for a wall that may never open a browser widget, and no lazy start on the agent's
  behalf, because nothing announces that a card is about to want one. The widget's start
  button is the gesture. The cost is that `browser`'s MCP tools fail until somebody presses
  it, which is the one rough edge in this feature.
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
```

Playwright's `launch()` **never returns under Bun** on this machine — the import resolves and
`chromium` is there, and the launch hangs indefinitely rather than failing. Every other probe
in `tools/` is `bun tools/probe-*.ts`, so this is the exception and it is why the file says so
at the top. It owns `.scratch/browserprobe/` and deletes only that.
