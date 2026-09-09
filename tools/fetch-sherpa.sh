#!/usr/bin/env bash
# Put sherpa-onnx's shared runtime where a build here can find it. Run once.
#
# `sherpa-onnx-sys` downloads this archive itself at build time, and on this
# network that fails: it fetches with ureq/rustls, which bundles its own root
# set, and every request through Netskope's interception comes back
# `invalid peer certificate: UnknownIssuer`. The same wall the `ureq` comment in
# `src-tauri/Cargo.toml` documents for the app's own HTTPS — except the app
# merges the Windows store back in (`forge::tls_config`) and a third-party build
# script cannot be told to. curl uses the system store, so curl can.
#
# So the libs are fetched once, by hand, and `SHERPA_ONNX_LIB_DIR` points the
# crate at them. Nothing here is installed system-wide and nothing needs an
# administrator.
#
# **Two destinations, and the second one is not redundant.** The download is
# cached under LOCALAPPDATA so a fresh clone or a second worktree does not pay
# for it again. The copy under `src-tauri/sherpa/` is what everything actually
# points at, and it has to be inside the repository because `tauri.conf.json`
# names the two DLLs in `bundle.resources` and those paths are resolved relative
# to it.
#
# It cannot instead point at `target/release/`, where `sherpa-onnx-sys` drops
# the DLLs itself, and finding that out cost a full release build: **tauri's
# build script validates every resource path before cargo has built the
# crate**, and a normal dependency's build script is not ordered before its
# dependent's. So the file is not there yet and the build dies with
# `resource path target/release/sherpa-onnx-c-api.dll doesn't exist`. Anything
# named in `bundle.resources` has to exist before the build starts, which means
# it has to be provisioned by something outside cargo — this script.
set -e

VER=1.13.7
# `-MT-Release`, and it is not guessable: `sherpa-onnx-v1.13.7-win-x64-shared-lib.tar.bz2`
# is a plausible-looking name that 404s. The twelve real ones are in
# `archive_name()` in `sherpa-onnx-sys/build.rs`; read them there rather than
# inferring one.
ARCHIVE="sherpa-onnx-v$VER-win-x64-shared-MT-Release-lib.tar.bz2"
URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/v$VER/$ARCHIVE"

DEST="${LOCALAPPDATA:?LOCALAPPDATA is not set — this script is Windows-only}/volery/sherpa-onnx/v$VER/lib"

# Where the build and the bundler both look. Inside the repository, for the
# reason in the header; gitignored, since it is 22MB of someone else's binaries.
REPO="$(git rev-parse --show-toplevel)"
VENDOR="$REPO/src-tauri/sherpa"

install_into_repo() {
  mkdir -p "$VENDOR"
  cp -r "$DEST/." "$VENDOR/"
  # Only these two reach an installed app — measured with `objdump -p`, which
  # gives the chain exe -> sherpa-onnx-c-api.dll -> onnxruntime.dll. The two
  # .lib files are import libraries and are build-time only; the C++ wrapper and
  # the providers shim are neither, and the probe still ran without them.
  test -f "$VENDOR/onnxruntime.dll"
  test -f "$VENDOR/sherpa-onnx-c-api.dll"
  echo "$VENDOR"
}

if [ -f "$DEST/sherpa-onnx-c-api.lib" ] && [ -f "$DEST/onnxruntime.dll" ]; then
  install_into_repo
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -r "$WORK" 2>/dev/null || true' EXIT

echo "fetching $ARCHIVE (7.5MB)" >&2
curl -fsSL --retry 3 -o "$WORK/$ARCHIVE" "$URL"
bzip2 -t "$WORK/$ARCHIVE"

# **Native bsdtar, never cygwin's.** Cygwin's tar silently truncates a large
# archive and exits 0 — measured 2026-09-09, a 453MB archive that passed
# `bzip2 -t` extracted to 170MB with status zero, and every "corrupt download"
# that afternoon was this rather than the network. This archive is small enough
# not to trip it, and using the right tar anyway costs nothing and means nobody
# has to re-derive which one is safe. See sink 113d6b0e.
( cd "$WORK" && /c/Windows/System32/tar.exe -xf "$ARCHIVE" )

mkdir -p "$DEST"
cp -r "$WORK/sherpa-onnx-v$VER-win-x64-shared-MT-Release-lib/lib/." "$DEST/"

test -f "$DEST/onnxruntime.dll"
test -f "$DEST/sherpa-onnx-c-api.dll"

install_into_repo
