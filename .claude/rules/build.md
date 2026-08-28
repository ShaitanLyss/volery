---
paths:
  - "src-tauri/Cargo.toml"
  - "src-tauri/Cargo.lock"
  - "tools/*.ps1"
  - "tools/windres-shim.c"
---

# Building without MSVC

### Building without MSVC

`bun run tauri build` wants the MSVC toolchain, and Visual Studio Build Tools wants a local
administrator. Where there isn't one, `tools/build-gnu.ps1` builds the same two installers
against `x86_64-pc-windows-gnu` with Cygwin's mingw-w64 cross gcc — both of which install
per-user.

```powershell
pwsh tools/build-gnu.ps1              # release + msi + nsis
pwsh tools/build-gnu.ps1 -NoBundle    # just the exe
```

Probed 2026-08-13 (GCC 13.4.0, rustc 1.95.0, binutils 2.46): the whole tree compiles and
links on gnu — bundled sqlite, wry, webview2-com, portable-pty — the exe opens its windows,
and WiX and NSIS produce what they produce under MSVC. Four things bite:

- **The failure without MSVC does not mention MSVC.** rustc runs bare `link.exe`, which
  resolves to GNU coreutils' `link` from Git Bash or Cygwin, and every build script dies
  with `link: extra operand`. That is a *missing* MSVC linker, not a broken one.
- **Cygwin's `windres` cannot read a Windows path.** It drives `gcc -E` through a shell
  command string, so cargo's backslashed `OUT_DIR` arrives at the preprocessor with the
  separators eaten (`C:\a\b` → `C:ab`) and `tauri-build` panics compiling `resource.rc`.
  Forward slashes compile the identical file. `tools/windres-shim.c` is a `windres` that
  rewrites its arguments and delegates; the script builds it into `.build-tools/` and puts
  that in front of PATH **for the build only** — installed under the real PATH it would
  shadow the genuine `windres` for everything else on the machine. It has to be intercepted
  by name, since `embed-resource` 3.0.11 spawns the bare `windres` on non-msvc targets and
  reads no `$RC` override on that path.
- **The gnu exe needs `WebView2Loader.dll` beside it, and the bundler doesn't know.**
  `webview2-com-sys` hardcodes `target_env = "msvc"` → `WebView2LoaderStatic`, anything else
  → `#[link(name = "WebView2Loader.dll")]`; there is no feature to choose. The build drops a
  copy into `target/release`, so the app runs *from the build directory* and looks fine,
  and the installer then produces something that dies on launch with "WebView2Loader.dll was
  not found". `build-gnu.ps1` ships it as a bundle resource through a `--config` overlay —
  not in `tauri.conf.json`, where it would be a missing resource under MSVC. `objdump -p`
  on the exe is the check: it must name no non-system DLL but that one.
- **The `cc` crate builds the C dependencies for Cygwin, not for mingw**, because this
  toolchain's *host* is `x86_64-pc-windows-gnu` — so `cc` sees host == target, decides the
  build is native, and spawns the bare name `gcc`, which on this PATH is Cygwin's own.
  rustc links with `x86_64-w64-mingw32-gcc` already, so only the C dependencies are
  affected and the failure lands at link time in the linker's voice, naming nothing that
  points at the cause — `liblibsqlite3_sys-*.rlib(sqlite3.o)` carrying undefined references
  to `cygwin_conv_path` and `__errno`. Probed 2026-08-13 against libsqlite3-sys 0.30.1 with
  Cygwin's GCC 13.4.0. `build-gnu.ps1` pins `CC_x86_64_pc_windows_gnu` (and `CXX_`/`AR_`)
  to the cross compiler. Note the target triple is spelled with **underscores** in those
  variable names, and a misspelled one is simply not read — the same silent-fallback shape
  as the Tauri arg-name bug further down.

- **`cargo test` does not run on the gnu toolchain here**, so the Rust suites need MSVC and
  the pure Bun suites are what a no-MSVC machine can actually check. Probed 2026-08-13: the
  crate *compiles* clean for `x86_64-pc-windows-gnu` and `cargo test --lib` links, but the
  harness exe dies at load with `0xC0000139` (STATUS_ENTRYPOINT_NOT_FOUND) — before any test
  runs, so a failure here says nothing about the code. Plain `cargo test` does not even get
  that far: the debug **cdylib** overruns mingw ld's export table (`export ordinal too large`),
  which the release build never hits. `--lib` skips it.

  **`0xC0000139` is not specific to the test harness — it is any exe built from this crate on
  this target.** Probed 2026-08-14 with `examples/azdo-probe.rs`: it *links* in release
  (`cargo build --release --example`, and the debug build dies at `export ordinal too large:
  125332` as above), and the resulting exe then exits `0xC0000139` before `main` runs, with
  `WebView2Loader.dll` beside it or not. So on a no-MSVC machine an `examples/` probe **cannot
  be run at all**, which is worth knowing before writing one: the only exe that works on gnu is
  the app itself. The way to probe a library question here is a throwaway crate with just that
  dependency in it — `.scratch/tlsprobe` is the pattern, and it built and ran in about two
  minutes. Note it needs the same `CC_x86_64_pc_windows_gnu`/`AR_` pins the main build does, or
  `ring` fails at link with unresolved Cygwin symbols — the `cc`-crate trap two bullets up,
  which bites any scratch crate with a C dependency exactly as it bites this one.

- **`cargo check --lib` *does* work on the gnu toolchain, and is the loop to use.** Probed
  2026-08-14: with the dependency tree warm it answers in seconds (4s for no change, ~19s after
  editing one module), so type errors in Rust are catchable on a machine with no MSVC even
  though the tests are not runnable. It needs the same environment `build-gnu.ps1` sets — the
  windres shim on PATH, `RUSTUP_TOOLCHAIN`, `SKEIN_REAL_WINDRES`, and the three compiler pins:

  ```bash
  export PATH="$PWD/.build-tools:$PATH"          # after: gcc -O2 -o .build-tools/windres.exe tools/windres-shim.c
  export RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu
  export SKEIN_REAL_WINDRES=C:/cygwin/bin/windres.exe
  export CC_x86_64_pc_windows_gnu=C:/cygwin/bin/x86_64-w64-mingw32-gcc.exe
  export CXX_x86_64_pc_windows_gnu=C:/cygwin/bin/x86_64-w64-mingw32-g++.exe
  export AR_x86_64_pc_windows_gnu=C:/cygwin/bin/x86_64-w64-mingw32-ar.exe
  cd src-tauri && cargo check --lib
  ```

  That block is `tools/check-gnu.sh`, so the loop is one command:

  ```bash
  bash tools/check-gnu.sh            # cargo check --lib
  bash tools/check-gnu.sh --tests    # and the test modules, which still cannot be *run*
  ```

  **`--tests` typechecks assertions it cannot execute**, which is worth saying out loud because
  a green `check --tests` reads like a green test run and is not one. **Assertions here are run
  by lifting them out of the crate**, and the three ways of doing that are below. Read the
  paragraph after them before trusting a green one — a lift is a copy, and what it proves is
  narrower than a `cargo test` would be.

  **The one line all three need, and the one most often missed.** Bare `rustc` takes the
  *default* toolchain, which is msvc on this machine, and dies with the misleading error at
  the top of this section — `link: extra operand`, a *missing* MSVC linker rather than a
  broken anything. So every recipe below is pinned:

  ```bash
  export RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu
  ```

  Two cards discovered that omission independently on 2026-08-27, hours apart, because the
  paragraph that used to be here read as though plain `rustc` was enough. Every
  `tools/lift-*.ts` sets it in the child's environment for the same reason; if you write a
  fourth, copy that.

  **1. `rustc --test` on a lifted file.** No cargo, no dependencies, no linker beyond rustc's
  own — so it is unaffected by whatever state the dependency graph is in, which is the point.
  This is how `hooks.rs`'s 21 assertions were run on 2026-08-25 and `control.rs`'s seven `vk`
  assertions on 2026-08-27.

  ```bash
  rustc --test --edition 2021 -A dead_code -o t.exe lifted.rs && ./t.exe
  ```

  **2. The same, plus the rlibs cargo already built.** The limit above is dependency-free
  code, and it is not a real limit: the deps are sitting in the target directory and a lifted
  file can link them.

  ```bash
  D=src-tauri/target/x86_64-pc-windows-gnu/debug/deps
  rustc --test --edition 2021 -A dead_code \
    --extern serde_json=$D/libserde_json-<hash>.rlib \
    -L dependency=$D -o t.exe lifted.rs && ./t.exe
  ```

  Re-probed 2026-08-28 against `libserde_json-09f778d09ea19cd6.rlib`: it links and the
  assertion runs. This borrows *our* build, so it is only as healthy as our graph — which is
  exactly the circumstance variant 3 exists for.

  **It reaches only the crates whose `.rlib` cargo actually built, and that is fewer than
  the directory suggests.** `cargo check` emits `.rmeta` — metadata, enough to typecheck
  against and not enough to link — and produces an `.rlib` only where something in the build
  genuinely needed one. Probed 2026-08-28: `serde_json` and `serde` have rlibs, `rusqlite`
  has `librusqlite-*.rmeta` and no rlib at all, so `store.rs`'s assertions cannot be lifted
  this way however pure they are. The symptom is a linker error naming a crate you can see
  sitting in `deps`.

  Two further wrinkles worth knowing before reaching for this:

  - **A proc macro is built for the *host*, not for `--target`.** `serde_derive` is a `.dll`
    in `src-tauri/target/debug/deps`, not an `.rlib` beside the others, and needs its own
    `--extern` plus a second `-L dependency=`. `tools/lift-project.ts` does this and says so.
  - **`block()`'s brace counting is naive in seven of the nine lift scripts.** They count
    every `{` on the line, including ones inside string literals and comments — so lifting an
    item whose body writes out a `package.json` fixture, or whose doc block says "the `{` of
    the root object", swallows the rest of the file and rustc reports `unclosed delimiter`
    hundreds of lines from the cause. `lift-project.ts`'s `scan()` is the fixed version;
    sink 4b20ad50 is whether to copy it or extract `tools/lift.ts`.

  **3. A throwaway cargo crate, when our own graph is the broken thing.** `cargo new` outside
  the repo, a `[workspace]` stanza in its `Cargo.toml` so ours does not adopt it, the one
  dependency you need, the lifted items pasted in. About four seconds, and it has *its own*
  dependency graph. Card 851e14c8 used it to verify Azure DevOps timeline flattening on
  2026-08-27 and it caught a real bug — thirteen stages in, five rows out, because a skipped
  stage carries no `Job` record. `.scratch/tlsprobe` is the same pattern for a library
  question; note it needs the `CC_x86_64_pc_windows_gnu`/`AR_` pins if anything in it has a C
  dependency.

  **That day is why this is not a curiosity.** For a stretch of 2026-08-27 `cargo check --lib`
  could not run at all, for any card, and not because of anybody's code: `librespot-core
  0.8`'s build script pulled two versions of `vergen_lib` into one graph (vergen 9.1.0 moved
  from `vergen-lib ^0.1.6` to `^9.1.0` — a breaking change inside a minor bump — while
  `vergen-gitcl 1.0.8` stayed on 0.1.6). During that window the lift was the *only* way to
  verify any Rust in this repo, and it was documented wrong.

  **A green lift is evidence about the text you lifted, not about the file on disk**, and the
  gap is real: the lifted text compiles in a different context — no `crate::`, no siblings, no
  `#[cfg(windows)]` arms. Two things close it, and they are meant to be used together:

  - **Regenerate the lift from the source file every time; never keep one.** `joblog.rs`'s
    twelve tests were once run against a lift taken before a constant was threaded through the
    function under it, so the green they reported was about a version that no longer existed on
    disk (ac3883e). `tools/lift-servers.ts` is the technique written down as a script rather
    than a habit — it extracts the items by name out of `servers.rs`, builds, runs, and keeps
    nothing — and is the shape to copy for another module rather than a tool with a general
    interface, since which items are pure is a fact about each file. There are seven of them
    now (`board`, `gates`, `selector`, `servers`, `smith`, `spawn`, `tunnel`).
  - **Pair it with `bash tools/check-gnu.sh --tests`**, which typechecks the real module, in
    place, in the crate. The lift says the logic is right; `--tests` says the assertions still
    compile against the code that is actually there. Neither alone is a `cargo test`; together
    they are most of one.

### Writing an assertion nobody can run

There are ~570 assertions across 42 modules in this crate and **not one of them runs here by
default.** So the question is not "is this test correct" but "what happens to it while nobody
is looking", and the answer depends entirely on how it is written. Sink `0b97adde` is the
finding; this is the rule that came out of it.

**An exhaustive assertion in a suite that cannot be executed is documentation, not a guard.**
`the_roster_tools_are_advertised_beside_the_question` in `ask.rs` used to spell the MCP roster
out as a flat `vec!`. It rotted twice. First the forge's three tools were registered without a
line there; then the tiering reordered six of them. Both times it went on **compiling** — a
`vec!` missing three elements is perfectly good Rust — so nothing said a word until somebody
walked into that function for an unrelated reason, and the second time the first thing that
could say so was the release workflow, which it failed several commits after the change that
caused it. It failed *for tidiness*, and it named the wrong commit.

Three rules, in the order to reach for them:

1. **Derive the expectation; never restate a registry.** A restated list is a second copy that
   no compiler keeps honest. `every_deferred_tool_can_be_found` and
   `the_loaded_tier_is_what_every_turn_pays_for` sit in the same module, are just as
   exhaustive, and could not rot either time — because they ask `roster()` what is in it
   rather than saying. What is left after deriving is the part a handler can genuinely get
   wrong: filtering, paging, sorting, or appending a loaded tool below a deferred one.
2. **If it must be exhaustive and cannot be derived, it needs a lift.** Some genuinely cannot:
   nothing holds a second list of search hints to check the first against. Those are the
   assertions worth the twenty minutes of a `tools/lift-*.ts`, and `lift-roster.ts` is that
   one — the whole roster contract, ten assertions across `ask.rs` and `supervisor.rs`,
   executing in under a second. It is also the worked example of variant 2 above, since the
   schemas are `serde_json`.
3. **A loop over a list is green when the list is empty.** Three assertions in
   `supervisor.rs` iterate the tools the appended prompt names, so all three passed on a
   prompt that named none — which is exactly what a bad edit to the format string, or to
   `named_tools`' backtick-pairing, would produce. Any `for x in <derived list>` that asserts
   inside the loop owes a non-empty check outside it, or the guard goes green precisely when
   its subject disappears.

The same three apply to the Bun suites, where they matter less only because those *do* run.

  **What a no-MSVC machine *can* do is typecheck the crate**, which is worth knowing before
  writing Rust blind here: `cargo check --lib` under the gnu toolchain compiles every module
  and reports real errors. It needs the same environment `build-gnu.ps1` sets — the toolchain,
  `.build-tools` in front of PATH for the windres shim, and the three `*_x86_64_pc_windows_gnu`
  compiler pins — and takes about a minute warm. Re-confirmed 2026-08-14. So a change to
  `src-tauri` is checkable without a local administrator; only *running* the assertions is not.

- **`bun run tauri dev` cannot work on gnu either**, for that same reason — `tauri dev` builds
  the cdylib, and the debug cdylib dies at `export ordinal too large: 104203` after compiling
  all 405 crates. Probed 2026-08-13; `build-gnu.ps1 -Dev` exists and documents the failure
  rather than working. So on a machine with no MSVC there is **no hot-reload loop**, and
  looking at the running app means:

  ```powershell
  pwsh tools/build-gnu.ps1 -NoBundle
  $env:SKEIN_CONTROL="1"; $env:SKEIN_NO_SERVERS="1"; ./src-tauri/target/release/skein.exe
  ```

  With the dependency tree warm that relinks only the final crate, so a front-end change costs
  a relink rather than a build — but a release build embeds `dist/`, so every front-end edit
  needs one. `SKEIN_NO_SERVERS` matters because this exe reads the *real* store: without it a
  second instance beside an installed one races the first for every port in the workspace and
  both walls end up showing `exited`. And `bun run test:wall` is the thing to reach for rather
  than driving the real wall by hand.

  It cannot be linked statically on this target, which is worth writing down so nobody
  spends the afternoon again. `WebView2LoaderStatic.lib` is MSVC C++: after discounting the
  52 symbols the archive defines itself, what stays undefined includes MSVC-mangled
  `operator new`/`delete` (`??2@YAPEAX_KAEBUnothrow_t@std@@@Z` and friends), `std::nothrow`,
  `_Init_thread_header`/`_footer`/`_epoch`, `__security_cookie`/`__security_check_cookie`
  and `__guard_dispatch_icall_fptr`. mingw's libstdc++ mangles Itanium-style (`_Znwm`), so
  none of it resolves, and CFG's dispatch pointer is synthesized by MSVC's linker. `zig cc`
  does not help: `-target x86_64-windows-gnu` is the same ABI, and `-target
  x86_64-windows-msvc` fails `WindowsSdkNotFound`, since zig locates an MSVC install rather
  than shipping one. Note also that static would not make Skein self-contained — the loader
  is a 160 KB shim whose whole job is to `LoadLibrary` the WebView2 *runtime* installed on
  the machine.

