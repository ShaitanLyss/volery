#!/usr/bin/env bash
# `cargo check --lib` on a machine with no MSVC. See .claude/rules/build.md.
set -e
cd "$(dirname "$0")/.."
export PATH="$PWD/.build-tools:$PATH"
export RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu
export SKEIN_REAL_WINDRES=C:/cygwin/bin/windres.exe
export CC_x86_64_pc_windows_gnu=C:/cygwin/bin/x86_64-w64-mingw32-gcc.exe
export CXX_x86_64_pc_windows_gnu=C:/cygwin/bin/x86_64-w64-mingw32-g++.exe
export AR_x86_64_pc_windows_gnu=C:/cygwin/bin/x86_64-w64-mingw32-ar.exe
cd src-tauri && exec cargo check --lib "$@"
