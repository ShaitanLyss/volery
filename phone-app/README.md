# The phone companion (Android)

`docs/PHONE.md` M2b — the Android app that wraps the `phone-node` Rust crate and
dials the flyway from the device. A foreground service holds the node alive
while you walk; a home screen shows the roster and the cards digest the dial
came back with.

Two halves, in one directory:

| | what | language |
|---|---|---|
| `ffi/` | the JNI bridge over `phone-node` (a cdylib) | Rust |
| `android/` | the app: foreground service + home + stub settings | Kotlin + Gradle |

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
cd phone-app/ffi
export NDK="/c/Users/flori/AppData/Local/Android/android-ndk-r26d"
export BIN="$NDK/toolchains/llvm/prebuilt/windows-x86_64/bin"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$BIN/aarch64-linux-android24-clang.cmd"
export CC_aarch64_linux_android="$BIN/aarch64-linux-android24-clang.cmd"
export CXX_aarch64_linux_android="$BIN/aarch64-linux-android24-clang++.cmd"
export AR_aarch64_linux_android="$BIN/llvm-ar.exe"
# CARGO_TARGET_DIR reuses the desktop's aarch64 cache (iroh etc. already built).
CARGO_TARGET_DIR="C:/atelier/skein/src-tauri/target" cargo build --target aarch64-linux-android

mkdir -p ../android/app/src/main/jniLibs/arm64-v8a
"$BIN/llvm-strip.exe" --strip-debug \
  -o ../android/app/src/main/jniLibs/arm64-v8a/libphone_ffi.so \
  ../../src-tauri/target/aarch64-linux-android/debug/libphone_ffi.so
```

### 2. Build the APK

```bash
cd phone-app/android
./gradlew assembleDebug     # app/build/outputs/apk/debug/app-debug.apk
```

The wall key phrase is a secret: it lives in `android/local.properties`
(gitignored) as `phone.key`, read into `BuildConfig` at build time. `phone.host`
and `phone.name` default to the `m2` lab wall and `phone`.

## The one Android-only step

On Android, iroh's `platform-verifier` feature reads the system trust store
through the Android `Context`, so a process with no Context panics at the first
dial. The app calls `NativeBridge.initPlatformVerifier(applicationContext)`
before `Node::start` — `rustls_platform_verifier::android::init_with_env`.
That is the one thing the phone does that the desktop never did.

## Status

The APK builds, installs, and the node binds on-device (the platform-verifier
init works). The on-device dial from the phone to a desktop wall across two
networks is the open question — see `docs/PHONE.md`'s "on-device dial" errand.
On this machine the phone was on cellular and the desktop behind NordVPN, so
the dial timed out at the wire's 20s bound; the same code dials the lab wall
from the desktop itself and reads the roster (phone's own entry included) plus
the cards digest.
