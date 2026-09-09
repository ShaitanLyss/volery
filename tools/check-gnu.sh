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

# The shim is a build artefact and `.build-tools` is gitignored, so a fresh
# clone does not have it. Saying so here is worth it: the failure without it is
# the same misleading windres error.
if [ ! -x .build-tools/windres.exe ]; then
  echo "tools/check-gnu.sh: .build-tools/windres.exe is missing." >&2
  echo "  Build it once with:" >&2
  echo "    gcc -O2 -o .build-tools/windres.exe tools/windres-shim.c" >&2
  echo "  Why it exists: cygwin's windres cannot read a Windows path, and" >&2
  echo "  embed-resource spawns the bare name. See .claude/rules/build.md." >&2
  exit 1
fi

export PATH="$PWD/.build-tools:$PATH"
export RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu
export SKEIN_REAL_WINDRES=C:/cygwin/bin/windres.exe
export CC_x86_64_pc_windows_gnu=C:/cygwin/bin/x86_64-w64-mingw32-gcc.exe
export CXX_x86_64_pc_windows_gnu=C:/cygwin/bin/x86_64-w64-mingw32-g++.exe
export AR_x86_64_pc_windows_gnu=C:/cygwin/bin/x86_64-w64-mingw32-ar.exe

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
