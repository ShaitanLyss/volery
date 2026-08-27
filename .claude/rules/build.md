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
  a green `check --tests` reads like a green test run and is not one. The way to actually run a
  pure Rust function here is to lift it into a throwaway with `rustc --test` — no cargo, no
  dependencies, no MSVC — which is how `hooks.rs`'s 21 assertions were run on 2026-08-25
  despite `cargo test` being unavailable. It takes a minute and it is the difference between
  believing a parser is right and knowing it.

  **Regenerate the lift from the source file every time; never keep one.** `joblog.rs`'s
  twelve tests were once run against a lift taken before a constant was threaded through the
  function under it, so the green they reported was about a version that no longer existed on
  disk (ac3883e). `tools/lift-servers.ts` is the technique written down as a script rather
  than a habit — it extracts the items by name out of `servers.rs`, builds, runs, and keeps
  nothing — and is the shape to copy for another module rather than a tool with a general
  interface, since which items are pure is a fact about each file.

  Without `RUSTUP_TOOLCHAIN` the failure is the misleading one at the top of this section:
  every build script dies with `link: extra operand`, which is a *missing* MSVC linker rather
  than a broken anything.

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

