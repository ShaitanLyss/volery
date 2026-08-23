---
paths:
  - "src-tauri/src/update.rs"
  - "src/lib/update.ts"
  - "src/lib/release.svelte.ts"
  - ".github/workflows/release.yml"
---

# Getting onto the newer one

The old way out of a release was: notice it exists, open the repo, download the installer,
close the wall, run the installer, open the wall. Six steps, five of them clerical, and the
first is the one nobody does reliably — so the version you are running is the version you
happened to install, whenever that was.

Volery asks GitHub once at launch whether there is a newer tag, and if there is, one button
downloads the installer and runs it on the way out.

### It is the installer that does the work

`tauri-plugin-updater` was the obvious answer and is not the one taken. The decision was made
against measurement rather than taste, so the measurements are here — and so is the one that
would reverse it.

**What it would buy** is a minisign signature over a download that comes from the same HTTPS
GitHub either way. That is real and it is the only thing.

**What it would cost**, three things, all specific:

- **Its default TLS would fail on the one network this app is used from.** The default feature
  is `rustls-tls` → `reqwest/rustls-no-provider`, which trusts webpki-roots. This network runs
  Netskope interception, so a bundled Mozilla root set cannot contain the CA that actually
  signs what arrives. That is not a guess — it is the failure the note over `ureq` in
  `Cargo.toml` was written for, one service across. Fixable with the `native-tls` feature, and
  the point is that it is a thing you would have to *know* to fix.
- **It brings the async runtime this crate has twice declined.** reqwest 0.13 and tokio, plus
  zip/tar/flate2. Both `ureq` and `tiny_http` carry a comment saying they were chosen to avoid
  exactly that.
- **It ends with `std::process::exit(0)`**, which walks past `RunEvent::ExitRequested` — the
  handler CLAUDE.md says everything depends on, where the supervisor, the servers, the shells,
  the bangs and the control token are all taken down. There is an `on_before_exit` hook to
  compensate with, and compensating is worse than not needing to.

**And what it buys in smoothness is nothing**, which is the finding that settled it. From
`tauri-bundler` 2.9.4's own `installer.nsi`: the installer parses `/P`, `/S`, `/UPDATE`, `/R`,
`/NS` and `/ARGS` out of `$CMDLINE` itself, in `.onInit` and `.onInstSuccess`. The plugin's
`passive` mode passes `/P /R /UPDATE /ARGS <current args>` — *flags*, to the same installer,
that any caller can pass. `INSTALL_ARGS` passes three of them and gets the same experience: a
progress bar, no questions, and the app back up afterwards. `/ARGS` is the only one left out,
and Volery is launched with no arguments that matter.

One catch in that template is worth writing down, because getting it wrong looks like a broken
restart rather than a missing flag: **`/R` is only read when `/P` or `/S` is also set.** Line
745, with the comment *"GUI installer has a toggle for the user to (re)start the app"*. Passive
and restart go together or neither does anything, and `update.rs` has a test that says so.

**What would reverse this:** the SignPath certificate landing (`release.yml`'s `sign` step is
still a deliberate no-op). Once the installers are signed, Windows verifies them and the
plugin's signature is verifying the same bytes a second time. The argument for the plugin gets
*weaker* with time, not stronger.

### Rust asks; the wall decides

The same split `limits.rs` draws against `limits.ts`, and for its reason: the part that will be
argued about is the policy, and an argument is worth having against tests.

`update.rs` returns what GitHub said together with `CARGO_PKG_VERSION`, and compares nothing.
`update.ts` decides whether that tag is newer, which asset can be driven, and what any of it is
called. The rule underneath every one of those decisions is **when in doubt, offer nothing** —
an update not offered costs one manual download some other day, and an update offered wrongly
downloads four megabytes and closes a wall with twenty cards on it. So an unparseable version,
a missing installer and an unreadable answer all come out the same way, which is silence.

- **A prerelease is not parsed at all.** `0.7.0-rc.1` fails `parseVersion`, so nothing
  downstream can offer it. That is the whole prerelease policy and it is deliberately
  implemented as a refusal to *order* rather than as a filter: a wall that closed itself to
  install a release candidate would be doing something nobody asked for, and if prereleases
  ever want offering they want it with the word on the button.
- **Only the NSIS `-setup.exe`.** It is the one artifact this app knows how to drive. The MSI
  beside it on every release would need `msiexec` and a different argument vocabulary, and an
  updater that downloaded one and then could not run it quietly is worse than one that never
  offered. `release.yml` publishes both, and the comment above the build step says why the
  NSIS one is load-bearing now.
- **Matched on the shape of the name, never the product name.** `Skein_0.6.1_x64-setup.exe` and
  `Volery_0.7.0_x64-setup.exe` both match, so the rename did not leave a release nothing could
  update from — and the next rename will not either. There is a test for the old name.
- **Strictly later, so an older tag is never taken.** A tag going backwards means somebody
  pulled a release, and rolling a wall backwards unasked is worse than doing nothing.

### Asked when you are looking at it, and not otherwise

GitHub does not tell anyone a tag appeared, so this goes and looks. It used to look
**once**, when the wall was painted, on the argument that a release landing at four is one
you are told about tomorrow morning.

That was true of the answer and wrong about the wall. This app is left running for days —
the process behind the 0.7.0 button had been up thirty-nine hours — so "once at launch"
meant a release cut on Tuesday stayed invisible until something unrelated made you restart.
And a wall opened with no network never checked again at all, which is the failure that
actually settled it: the old shape had no way to recover from its own worst case.

So it asks again, and **the shape is deliberately not a clock.** Focus is an event,
`attention.focused` already folds it, and `App.svelte` hands it to `Releases.watch` in one
line. The common trigger is you coming back to the window, which is also the moment the
answer is worth having. Three bounds, each doing a job:

- **Only while the window is in front.** A wall left open on a second monitor for a week
  asks nothing. This is the whole of the cost argument.
- **A floor between asks** (`FLOOR`, five minutes), so alt-tabbing forty times costs one
  question. The pending ask is *rescheduled*, never queued.
- **It stops for good once there is something to say.** `unanswered` in `update.ts` is that
  rule, and it is the tightest of the three — not a saving but the observation that no
  further ask can change the answer.

`BACKSTOP` (fifteen minutes) covers the window you never look away from, where focus alone
would never fire again. It runs only while focused, so the first bound contains it rather
than sitting beside it: four questions an hour at the very most, against sixty.

`unanswered` does a second job that is easy to miss and is why it is pure and tested: a
reply can be **in flight when you press the button**, so it is asked again *after* the answer
comes back. Without that, an ask that started before the press would put `offered` back over
a download already three megabytes in.

Unauthenticated, which is 60 requests an hour from one address. No token: a public repo's
releases need none, and an updater that wanted a credential is an updater nobody can audit.
`latest_release` is `async` and that is now load-bearing — asked repeatedly, a synchronous
version would freeze every card on the wall for the length of each request.

**Every failure is silence in the header.** No network, GitHub down, a rate limit, a tag
nothing can order: the chrome looks exactly as it did. `fault` is kept for the control
surface's snapshot and drawn nowhere — an app that reported its own inability to check for
updates, in its own chrome, every launch, would be nagging about its plumbing. The one failure
that *is* drawn is one you asked for: a download that broke after you pressed the button.

### The installer is launched by the exit handler, not by the button

Because **quitting can be refused**. A wall with background work on it asks before it goes
(`quit.rs`), and an installer launched before that question is answered would be rewriting a
running exe while the person who chose to stay watches it happen.

So the button downloads, arms `Arming`, and closes the window through the ordinary path — where
the wall gets to ask about its own work exactly as it does for any other quit. `lib.rs` calls
`update::run_armed` last of all in the exit handler, after the supervisor, the servers, the
shells and the bangs are down, which is the only moment the exe being replaced has actually
been let go of. If you say "stay", nothing has happened except a file in the data directory.

`Arming::take` **spends** the arming rather than reading it, because that handler runs twice on
a clean quit (`ExitRequested` and then `Exit`) and two installers racing for one directory is
worse than none.

### What is not taken on trust

Two commands here could otherwise be a remote-execution primitive with a friendly name, and
`control.rs` publishes a port — so the front end is not the only thing that can reach a Tauri
command.

- **`fetch_update` re-asks GitHub** rather than parsing the URL it was handed. The URL has to
  be a `browser_download_url` on the newest release; a cache the caller could have edited in
  between is not a check.
- **`arm_update` will only arm a file this app downloaded**: inside the `updates` directory
  under the app's own data dir, and ending in `.exe`.
- **The asset's file name is sanitised** before it is used as a path. It comes off somebody
  else's release and decides where a file is written and then *executed*, so separators, colons
  and doubled dots do not survive. It sanitises rather than refuses, because a refusal there
  would be an update blocked by a release title.
- **The download directory is the app's own**, not `%TEMP%`. Tidiness is not the argument: a
  stray `enum.py` in `%TEMP%` on this machine broke every python script run from there, because
  Python puts the script's own directory on `sys.path`. A directory everything writes to is a
  directory anything can be shadowed in, and an installer is a thing that will be executed.
- **A short read deletes the file.** `Content-Length` is the server's own claim about what it
  was sending; less than that means the connection went, and a truncated installer is worse
  than no installer because it is still an executable somebody could run.
