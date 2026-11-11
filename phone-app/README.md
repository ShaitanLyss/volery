# The phone companion (Android)

`docs/PHONE.md` M2b — the Android app that wraps the `phone-node` Rust crate and
dials the flyway from the device. A foreground service holds the node alive
while you walk; a home screen shows the roster and the cards digest the dial
came back with.

Two halves:

| | what | language | where |
|---|---|---|---|
| the bridge | the JNI cdylib over `phone-node` | Rust | `src-tauri/phone-ffi/` — a member of `src-tauri`'s workspace, so it shares one Cargo.lock |
| the app | foreground service + home + stub settings | Kotlin + Gradle | `phone-app/android/` |

## The FFI is JNI, not uniffi

The brief's preference was uniffi, and it genuinely fights here rather than
merely being unfamiliar. Half of what `sight` returns is a `serde_json::Value`
(the cards snapshot, deliberately opaque so a card's taxonomy stays in
`classify.ts`) and `start` takes a `WallKey`, which derives nothing on purpose
so a secret is never one `{:?}` away from a log line. Neither is an
uniffi-mappable type, so uniffi would need a hand-written flattening layer
*anyway*. Given that, a JSON envelope over JNI is less machinery than uniffi's
proc-macros, bindgen step and async-executor wiring — and `jni` (pure Rust) is
the only crate added. The whole surface is two calls, so hand-written JNI stays
small. `ffi/src/lib.rs` argues it in full.

## Building

Two steps — the native `.so`, then the APK. Both need the Android toolchain
(NDK r26d, JDK 17, SDK with build-tools 35; the paths on this machine are in
`.claude`'s android toolchain memory).

### 1. Cross-compile the bridge

```bash
cd src-tauri/phone-ffi
export NDK="$HOME/Android/Sdk/ndk/27.1.12297006"   # $ANDROID_HOME/ndk/<version>
export BIN="$NDK/toolchains/llvm/prebuilt/windows-x86_64/bin"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$BIN/aarch64-linux-android24-clang.cmd"
export CC_aarch64_linux_android="$BIN/aarch64-linux-android24-clang.cmd"
export CXX_aarch64_linux_android="$BIN/aarch64-linux-android24-clang++.cmd"
export AR_aarch64_linux_android="$BIN/llvm-ar.exe"
# On a machine with no MSVC, mingw or Cygwin, the host build scripts and proc
# macros are gnu artifacts and still need a linker. The gnu toolchain ships
# rust-lld and mingw's import libraries, but rustc still spawns `dlltool` by
# name — the NDK's llvm-dlltool is a drop-in once it is on PATH as dlltool.exe.
mkdir -p ../../.build-tools
cp "$BIN/llvm-dlltool.exe" ../../.build-tools/dlltool.exe
export PATH="$PWD/../../.build-tools:$PATH"
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER=rust-lld
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_RUSTFLAGS="-C linker-flavor=gnu-lld -C link-self-contained=yes"
# Through this network's TLS-inspecting proxy, cargo's schannel revocation
# check fails on every crates.io download. Persisted as a user environment
# variable on this machine; `git config --global http.schannelCheckRevoke
# false` is the same switch for git.
export CARGO_HTTP_CHECK_REVOKE=false
# A member of src-tauri's workspace, so target/ is the shared one — no
# CARGO_TARGET_DIR override needed, and the .so lands in ../target.
cargo build --target aarch64-linux-android

mkdir -p ../../phone-app/android/app/src/main/jniLibs/arm64-v8a
"$BIN/llvm-strip.exe" --strip-debug \
  -o ../../phone-app/android/app/src/main/jniLibs/arm64-v8a/libphone_ffi.so \
  ../target/aarch64-linux-android/debug/libphone_ffi.so
```

The `.cargo/config.toml` beside the crate sets `max-page-size=16384`; a `.so`
whose LOAD segments are at `0x1000` was linked before that flag reached the
linker, and Android 15 will warn about it. `llvm-readelf -l` on the stripped
file should show `0x4000`.

### 2. Build the APK

```bash
cd phone-app/android
./gradlew assembleDebug     # app/build/outputs/apk/debug/app-debug.apk
```

The wall key phrase is a secret: it lives in `android/local.properties`
(gitignored) as `phone.key`, read into `BuildConfig` at build time. `phone.host`
and `phone.name` default to the `m2` lab wall and `phone`.

**The `.so` is a build artifact and is gitignored, so it does not rebuild
itself.** Any change under `src-tauri/phone-ffi/**` or `src-tauri/phone-node/**`
must be followed by step 1 and a reinstall, or the phone runs new Kotlin against
an old bridge. That is exactly what a stale one looked like on 2026-11-10: the
first typed sentence after M5b reached `NativeBridge.steward`, the library had
never heard of it, and the process died on an executor thread with no message
anywhere on screen. `Steer.call` now catches the failure and the rail says *the
phone's bridge is out of date* — but the cure is still to rebuild step 1.

## The look

The phone is chat view's identity at arm's length, and the design is the
mockups in `.scratch-e6abc47c/` (`01-roster` … `07-play`) with the system
described in `00-overview.html`. `Theme.kt` is that system as Compose: a
[Palette] holds the wall's own primitives (ground, sheet, surface, raised, edge,
the four paper steps, the five status colours) and derives the mixed ones —
`lift` = surface 82% + paper 3%, `hair` = edge@80%, `lamp` = paper@6%, `prose` =
paper-dim 45% / paper — with `lerp`, which interpolates in Oklab exactly as
`color-mix(in oklab, …)` does. Two grounds are built from them: `studio` (the
default, the signature) and `vellum` (studio by day, nothing white, no glare).
Colour is status only; the mark's work→ask gradient is the brand and the one
exception.

Type follows the wall's split: chrome is the system sans (Segoe UI Variable on
Windows, Roboto here), the agent's and the card's prose is the serif at
`tx × 1.2` with 1.62 leading (Sitka on the desktop, Noto Serif here), names are
the display serif and machinery is mono. `Motion` is five durations and two
easings, transform and opacity only, folded into `LocalMotion` with the
`full`/`spare`/`still` preference — `still` runs nothing, `spare` drops the
endless breathing.

Material 3 stays as **substrate**, not as a look: it is what supplies insets,
touch, text selection and accessibility, and `VoleryTheme` paints the system
bars so no screen can forget them. Everything it would draw is ours — no
TopAppBar, no tonal elevation, no ripple (a 90 ms press instead), no Material
palette, no Material icons (`Glyph.kt` draws the mockups' own 16-unit strokes).
The screens are `MainActivity` (roster, a card's page and the confirm gate in
one room, so the narration loop keeps running while a question is answered),
`ViewerActivity` and `SettingsActivity`; `Components.kt` holds the ground, the
status light, the rail, the sheet and the segmented choice they share.

`--ez phone.seedGate true` raises the gate with a representative plan in a debug
build, so its layout can be photographed or driven in a lab against a wall that
does not answer `Steward` (a wall from before M5a drops the request, and the
phone can only say *did not answer*).

## The one Android-only step

On Android, iroh's `platform-verifier` feature reads the system trust store
through the Android `Context`, so a process with no Context panics at the first
dial. The app calls `NativeBridge.initPlatformVerifier(applicationContext)`
before `Node::start` — `rustls_platform_verifier::android::init_with_env`.
That is the one thing the phone does that the desktop never did.

## Status

The APK builds, installs, and the node binds on-device (the platform-verifier
init works). The cross-network dial is closed: the phone dials the real wall
over the relay and reads its roster and cards digest; `docs/PHONE.md` has what
the two phone-side causes were.

**Finding a wall (2026-11-11).** The app no longer depends on the one wall in
`local.properties`. `sightAny` walks the configured host, the walls the last
sighting showed (persisted beside the host) and finally the flyway's directory,
leaving room in the attempt budget so a stale roster cannot starve the directory
read, so shutting the laptop the phone was pointed at leaves it on the flyway
through another. Proved on the Pixel against the real flyway: a dead configured host
with no remembered list found AU-LT-285 through the directory, and a dead host
with the learned roster went straight to the remembered wall. A tap on a wall
that is off keeps the page on the wall it is really reading, rather than leaving
every later call addressed to the dead one.
