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
cd src-tauri && exec cargo check --lib "$@"
