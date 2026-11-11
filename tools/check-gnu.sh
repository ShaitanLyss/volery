#!/usr/bin/env bash
# `cargo check --lib` on a machine with no MSVC. See .claude/rules/build.md.
#
# This script is the *only* supported way to run cargo here. Bare `cargo check`
# dies inside `tauri-winres` with `windres: preprocessing failed` on a mangled
# path, which reads as a broken tree rather than as a missing shim — see the
# note in `src-tauri/build.rs`, which now says so at the moment it happens.
#
# Arguments are passed through, so `tools/check-gnu.sh --profile test` type-checks
# the test bodies too. They still cannot be *run* here; `cargo test` needs to
# link, and linking is the thing this machine cannot do.
set -e

# Not `dirname "$0"`. This file spent a while unrunnable as a file (CRLF, sink
# `822ad886`) and the obvious workaround — piping it through `tr -d '@@r'` — set
# `$0` to `bash`, so `dirname` answered `.` and the script failed on `cd
# src-tauri` instead. The endings are fixed and `.gitattributes` keeps them
# fixed, but resolving the root from git rather than from argv zero costs
# nothing and means the workaround would have worked too.
cd "$(git rev-parse --show-toplevel)"

# A mingw-w64 compiler, located rather than assumed.
#
# The one this machine has is WinLibs, installed through winget. Its `bin` is on
# the *user* PATH in the registry, and a card's shell does not see it: the
# environment a process gets is the one captured when its parent started, so a
# toolchain installed after the wall was launched is invisible until the wall is
# restarted. That failure is `cc-rs: failed to find tool "gcc.exe"`, which names
# nothing about PATH, so the lookup lives here where the reason does.
#
# `VOLERY_MINGW_BIN` overrides it, for a toolchain somewhere else.
find_mingw() {
  if [ -n "$VOLERY_MINGW_BIN" ] && [ -x "$VOLERY_MINGW_BIN/gcc.exe" ]; then
    printf '%s\n' "$VOLERY_MINGW_BIN"; return 0
  fi
  if command -v gcc >/dev/null 2>&1 && gcc --version 2>/dev/null | grep -qi mingw; then
    dirname "$(command -v gcc)"; return 0
  fi
  local w
  for w in "$HOME"/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.POSIX.UCRT_*/mingw64/bin \
           "$HOME"/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.*/mingw64/bin; do
    [ -x "$w/gcc.exe" ] && { printf '%s\n' "$w"; return 0; }
  done
  [ -x /c/cygwin/bin/x86_64-w64-mingw32-gcc.exe ] && { printf '%s\n' /c/cygwin/bin; return 0; }
  return 1
}

MINGW_BIN="$(find_mingw)" || {
  echo "tools/check-gnu.sh: no mingw-w64 gcc found." >&2
  echo "  Install one (no admin needed):" >&2
  echo "    winget install --id BrechtSanders.WinLibs.POSIX.UCRT" >&2
  echo "  or set VOLERY_MINGW_BIN to the directory holding gcc.exe," >&2
  echo "  or build a terminal windres as .claude/rules/build.md describes." >&2
  exit 1
}
# Windows-style, because the two variables below are read by CreateProcess.
MINGW_WIN="$(cygpath -m "$MINGW_BIN" 2>/dev/null || printf '%s' "$MINGW_BIN")"

export PATH="$MINGW_BIN:$PATH"
export RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu
export CC_x86_64_pc_windows_gnu="$MINGW_WIN/gcc.exe"
export CXX_x86_64_pc_windows_gnu="$MINGW_WIN/g++.exe"
export AR_x86_64_pc_windows_gnu="$MINGW_WIN/ar.exe"

# The windres shim is only needed where the real one cannot read a Windows path,
# which is Cygwin's. A mingw-w64 windres handles it, so the shim is optional
# here and a missing one is no longer an error on this machine.
if [ ! -x "$MINGW_BIN/windres.exe" ]; then
  if [ ! -x .build-tools/windres.exe ]; then
    echo "tools/check-gnu.sh: no windres, and no shim at .build-tools/windres.exe." >&2
    echo "  Build it once with:" >&2
    echo "    gcc -O2 -o .build-tools/windres.exe tools/windres-shim.c" >&2
    exit 1
  fi
  export PATH="$PWD/.build-tools:$PATH"
  export SKEIN_REAL_WINDRES="$MINGW_WIN/windres.exe"
fi

# sherpa-onnx's shared runtime, for `voice.rs`. `tools/fetch-sherpa.sh` is
# idempotent and prints the directory, so this one line both ensures and
# locates it; the script says why the crate cannot fetch it itself here.
SHERPA_ONNX_LIB_DIR="$(tools/fetch-sherpa.sh)"
export SHERPA_ONNX_LIB_DIR

# `zstd-sys` comes in as a build dependency behind sherpa-onnx and will not
# compile without these. cc-rs passes it only `-Izstd/lib -Izstd/lib/common`,
# and the sources reach for `hist.h` and `zstd_decompress_internal.h` which
# live in the sibling directories — so the build dies naming a missing header
# and nothing in that message points at a toolchain. Same family as the `CC_`
# pins above; see .claude/rules/build.md.
export CFLAGS_x86_64_pc_windows_gnu="-Izstd/lib -Izstd/lib/common -Izstd/lib/compress -Izstd/lib/decompress -Izstd/lib/dictBuilder"
# `--all-targets`, not `--lib`, and that word is the whole of this line.
#
# **CI runs `cargo test`, which builds `examples/`, and `--lib` does not.** So an
# example left behind by a change to the library it probes compiles nowhere a
# person can see it and fails on a runner, after the tag has been pushed. That
# has now happened twice: `bb23ca9` ("voice-probe would not compile, so cargo
# test could not run at all"), and again on v0.27.0, where `voice-probe.rs` was
# still calling `hearing()` with no arguments and reading `Hearing::system` after
# the local-engine rewrite had removed both. `cargo check --lib` was green for
# that commit, and so was `--profile test`, because neither compiles an example.
#
# This machine cannot run `cargo test` at all (`.claude/rules/build.md` has the
# 0xC0000139 story), so *checking every target* is the closest it can get to the
# gate CI actually applies — and it is the difference between finding this in a
# second here and finding it in a red release build.
cd src-tauri && exec cargo check --all-targets "$@"
