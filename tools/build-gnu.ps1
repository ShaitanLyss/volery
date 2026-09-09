#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Build Skein's installers on a machine with no MSVC toolchain and no local admin.

.DESCRIPTION
  `bun run tauri build` wants the MSVC toolchain, and Visual Studio Build Tools wants a
  local administrator. This builds the same two installers against
  x86_64-pc-windows-gnu with Cygwin's mingw-w64 cross gcc — both of which install
  per-user. See CLAUDE.md ("Building without MSVC") for what was probed and when.

  Three things bite on this target, and this script exists to handle all three:

    1. Cygwin's `windres` cannot read a Windows path — it drives `gcc -E` through a
       shell command string, so cargo's backslashed OUT_DIR arrives at the preprocessor
       with the separators eaten (C:\a\b -> C:ab) and tauri-build panics compiling
       resource.rc. tools/windres-shim.c is a `windres` that rewrites its arguments and
       delegates; it goes on PATH *for this build only*, since installed under the real
       PATH it would shadow the genuine windres for everything else on the machine.
       embed-resource 3.0.11 spawns the bare name `windres` on non-msvc targets and
       reads no $RC override there, so the interception has to be by name.

    2. The gnu exe needs WebView2Loader.dll beside it and the bundler doesn't know.
       webview2-com-sys hardcodes target_env = "msvc" -> WebView2LoaderStatic, anything
       else -> #[link(name = "WebView2Loader.dll")]; there is no feature to choose. A
       copy is dropped into target/release so the app runs from the build directory, and
       shipped as a bundle resource through a --config overlay — not in tauri.conf.json,
       where it would be a missing resource under MSVC.

    3. The failure without MSVC does not mention MSVC. rustc runs bare `link.exe`, which
       resolves to GNU coreutils' `link` from Git Bash or Cygwin, and every build script
       dies with `link: extra operand`. Pinning RUSTUP_TOOLCHAIN to the gnu toolchain is
       what keeps us off that path.

.PARAMETER NoBundle
  Just the exe — skips WiX and NSIS. With the dependency tree warm this relinks only the
  final crate, so a front-end change costs a relink rather than a build (a release build
  embeds dist/, so every front-end edit needs one).

.PARAMETER Dev
  Does not work, and says why. See the note in the -Dev arm below.

.EXAMPLE
  pwsh tools/build-gnu.ps1              # release + msi + nsis
  pwsh tools/build-gnu.ps1 -NoBundle    # just the exe
#>
[CmdletBinding()]
param(
  [switch]$NoBundle,
  [switch]$Dev
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root       = Split-Path -Parent $PSScriptRoot
$buildTools = Join-Path $root '.build-tools'
$targetDir  = Join-Path $root 'src-tauri\target\release'
$GnuChain   = 'stable-x86_64-pc-windows-gnu'

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Note($msg) { Write-Host "    $msg" -ForegroundColor DarkGray }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------------------
# -Dev: there is no hot-reload loop on this target, and pretending otherwise
# would waste an afternoon per person. Probed 2026-08-13: `tauri dev` builds the
# *debug* cdylib, which overruns mingw ld's export table
# (`export ordinal too large: 104203`) after compiling all 405 crates. The
# release build never hits it. So say so, and name the thing that does work.
# ---------------------------------------------------------------------------
if ($Dev) {
  Write-Host ''
  Warn 'bun run tauri dev cannot work on x86_64-pc-windows-gnu.'
  Write-Host ''
  Note 'tauri dev builds the debug cdylib, and mingw ld cannot export it:'
  Note '  fatal error: export ordinal too large: 104203'
  Note 'It dies after compiling all 405 crates. The release build never hits this'
  Note '(and `cargo test --lib` links, but the harness exe then dies at load with'
  Note '0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND — so the Rust suites need MSVC too).'
  Write-Host ''
  Note 'To look at the running app without MSVC, build the release exe and run it:'
  Write-Host ''
  Write-Host '      pwsh tools/build-gnu.ps1 -NoBundle' -ForegroundColor Gray
  Write-Host '      $env:SKEIN_CONTROL="1"; $env:SKEIN_NO_SERVERS="1"; ./src-tauri/target/release/skein.exe' -ForegroundColor Gray
  Write-Host ''
  Note 'SKEIN_NO_SERVERS matters: this exe reads the *real* store, and without it a'
  Note 'second instance beside an installed one races the first for every port in the'
  Note 'workspace, leaving both walls showing `exited`.'
  Note 'A release build embeds dist/, so every front-end edit needs another -NoBundle'
  Note 'run — warm, that is a relink of the final crate rather than a build.'
  Note 'And prefer `bun run test:wall` over driving the real wall by hand.'
  Write-Host ''
  exit 1
}

# ---------------------------------------------------------------------------
# The toolchain has to be there before anything else is worth doing.
# ---------------------------------------------------------------------------
Step 'checking the gnu toolchain'

if (-not (Get-Command rustup -ErrorAction SilentlyContinue)) {
  throw 'rustup is not on PATH. Install it per-user from https://rustup.rs.'
}
# -join first: `-match` against an *array* filters it rather than answering yes/no, so
# the empty-result case reads as $false and the no-match case as a truthy array — i.e.
# exactly backwards, and it fails on the machine that is set up correctly.
if (((rustup toolchain list) -join "`n") -notmatch [regex]::Escape($GnuChain)) {
  throw @"
The $GnuChain toolchain is not installed. It installs per-user:

    rustup toolchain install $GnuChain
"@
}
Note "toolchain $GnuChain"

# Resolve the real windres *before* .build-tools goes on PATH, or we find the shim
# and it delegates to itself.
$realWindres = (Get-Command windres.exe -ErrorAction SilentlyContinue)
if (-not $realWindres) {
  throw @"
Cygwin's windres is not on PATH. Skein needs Cygwin's mingw-w64 cross toolchain,
which installs per-user via setup-x86_64.exe; the packages are:

    mingw64-x86_64-gcc-core  mingw64-x86_64-gcc-g++  binutils

Then put C:\cygwin\bin on PATH.
"@
}
$realWindres = $realWindres.Source
Note "windres    $realWindres"

$mingwGcc = Get-Command x86_64-w64-mingw32-gcc.exe -ErrorAction SilentlyContinue
if (-not $mingwGcc) {
  throw 'x86_64-w64-mingw32-gcc is not on PATH (Cygwin package: mingw64-x86_64-gcc-core).'
}
Note "gcc        $($mingwGcc.Source)"

New-Item -ItemType Directory -Force -Path $buildTools | Out-Null

# ---------------------------------------------------------------------------
# The windres shim. Built with the *cross* gcc rather than Cygwin's own, so the
# shim is a plain Windows exe with no cygwin1.dll to find at spawn time.
# ---------------------------------------------------------------------------
Step 'the windres shim'

$shimSrc = Join-Path $PSScriptRoot 'windres-shim.c'
$shimExe = Join-Path $buildTools 'windres.exe'
if (-not (Test-Path $shimSrc)) { throw "missing $shimSrc" }

$stale = -not (Test-Path $shimExe) -or
         (Get-Item $shimSrc).LastWriteTimeUtc -gt (Get-Item $shimExe).LastWriteTimeUtc
if ($stale) {
  & $mingwGcc.Source -O2 -o $shimExe $shimSrc
  if ($LASTEXITCODE -ne 0) { throw 'failed to compile the windres shim' }
  Note 'compiled'
} else {
  Note 'up to date'
}

# ---------------------------------------------------------------------------
# WebView2Loader.dll, out of the crate that expects to link it. Taken from the
# registry rather than committed, so it tracks the webview2-com-sys we build
# against. Note this does not make Skein self-contained: the loader is a 160 KB
# shim whose whole job is to LoadLibrary the WebView2 *runtime* on the machine.
# ---------------------------------------------------------------------------
Step 'WebView2Loader.dll'

$cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $HOME '.cargo' }
$loader = Get-ChildItem -Path (Join-Path $cargoHome 'registry\src') -Recurse -Force `
            -Filter 'WebView2Loader.dll' -ErrorAction SilentlyContinue |
          Where-Object { $_.FullName -match '\\webview2-com-sys-[^\\]+\\x64\\' } |
          Sort-Object FullName -Descending |
          Select-Object -First 1
if (-not $loader) {
  throw @"
Could not find x64/WebView2Loader.dll under $cargoHome\registry\src.
It ships inside the webview2-com-sys crate, so `cargo fetch` in src-tauri first.
"@
}
Note $loader.FullName
Copy-Item $loader.FullName (Join-Path $buildTools 'WebView2Loader.dll') -Force

# The --config overlay that ships it. Forward slashes: this string reaches the
# bundler and a JSON escape is not what we want to be debugging.
$overlayPath = Join-Path $buildTools 'tauri.gnu.conf.json'
$resourceSrc = (Join-Path $buildTools 'WebView2Loader.dll').Replace('\', '/')
$overlay = @{ bundle = @{ resources = @{ $resourceSrc = 'WebView2Loader.dll' } } } |
           ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($overlayPath, $overlay, (New-Object System.Text.UTF8Encoding $false))
Note "overlay    $overlayPath"

# ---------------------------------------------------------------------------
# Build. The environment is scoped to this script: PATH is only shadowed for as
# long as the build runs.
# ---------------------------------------------------------------------------
Step $(if ($NoBundle) { 'building the exe' } else { 'building release + msi + nsis' })

$saved = @{}
foreach ($k in 'PATH', 'RUSTUP_TOOLCHAIN', 'SKEIN_REAL_WINDRES',
               'CC_x86_64_pc_windows_gnu', 'CXX_x86_64_pc_windows_gnu',
               'AR_x86_64_pc_windows_gnu') {
  $saved[$k] = [Environment]::GetEnvironmentVariable($k)
}
try {
  $env:PATH               = "$buildTools;$env:PATH"
  $env:RUSTUP_TOOLCHAIN   = $GnuChain
  $env:SKEIN_REAL_WINDRES = $realWindres

  # Pin the C compiler for the `cc` crate, or bundled sqlite is built for the wrong
  # target. This toolchain's *host* is x86_64-pc-windows-gnu, so cc sees host == target,
  # decides the build is native, and spawns the bare name `gcc` — which on this PATH is
  # Cygwin's own gcc, targeting Cygwin rather than mingw. It compiles happily and the
  # failure lands at link time, in the linker's voice, naming nothing recognisable:
  #
  #   liblibsqlite3_sys-*.rlib(sqlite3.o): undefined reference to `cygwin_conv_path'
  #   liblibsqlite3_sys-*.rlib(sqlite3.o): undefined reference to `__errno'
  #
  # rustc itself already links with x86_64-w64-mingw32-gcc, which is why only the C
  # dependencies are affected. Probed 2026-08-13 against libsqlite3-sys 0.30.1 with
  # Cygwin's GCC 13.4.0.
  $mingwPrefix = $mingwGcc.Source -replace 'gcc\.exe$', ''
  $env:CC_x86_64_pc_windows_gnu  = $mingwGcc.Source
  $env:CXX_x86_64_pc_windows_gnu = "${mingwPrefix}g++.exe"
  $env:AR_x86_64_pc_windows_gnu  = "${mingwPrefix}ar.exe"

  # zstd-sys arrives as a build dependency behind sherpa-onnx and will not compile
  # without these. cc-rs passes it only `-Izstd/lib -Izstd/lib/common`, and the sources
  # include "hist.h" and "zstd_decompress_internal.h" from the sibling directories, so
  # the build dies naming a missing header with nothing pointing at a toolchain. Same
  # family as the CC pins above.
  $env:CFLAGS_x86_64_pc_windows_gnu = '-Izstd/lib -Izstd/lib/common -Izstd/lib/compress -Izstd/lib/decompress -Izstd/lib/dictBuilder'

  # sherpa-onnx's shared runtime, for voice.rs. The crate downloads this itself at build
  # time and that fails on this network with `UnknownIssuer` — it bundles its own TLS
  # roots and the Netskope CA is only in the Windows store. tools/fetch-sherpa.sh is
  # idempotent and prints the directory, so this both ensures and locates it.
  $sherpaLib = (& bash "$root/tools/fetch-sherpa.sh") | Select-Object -Last 1
  if ($LASTEXITCODE -ne 0 -or -not $sherpaLib) { throw 'could not fetch the sherpa-onnx runtime' }
  $env:SHERPA_ONNX_LIB_DIR = $sherpaLib
  Note "sherpa runtime: $sherpaLib"

  Push-Location $root
  try {
    $tauriArgs = @('run', 'tauri', 'build', '--config', $overlayPath)
    if ($NoBundle) { $tauriArgs += '--no-bundle' }
    Note "bun $($tauriArgs -join ' ')"
    & bun @tauriArgs
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed ($LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
} finally {
  foreach ($k in $saved.Keys) {
    [Environment]::SetEnvironmentVariable($k, $saved[$k])
  }
}

# The exe has to find the loader when run straight out of the build directory,
# which is how anybody looks at the app on a machine with no hot-reload loop.
Copy-Item (Join-Path $buildTools 'WebView2Loader.dll') (Join-Path $targetDir 'WebView2Loader.dll') -Force

# ---------------------------------------------------------------------------
# The check that matters. An installer that produces something dying on launch
# with "WebView2Loader.dll was not found" looks fine from the build directory,
# so `objdump -p` on the exe is the thing to read: it must name no non-system
# DLL but that one, and in particular none of mingw's runtime.
# ---------------------------------------------------------------------------
Step 'checking the exe imports'

$exe = Join-Path $targetDir 'skein.exe'
if (-not (Test-Path $exe)) { throw "no exe at $exe" }

$dlls = & objdump -p $exe |
        Select-String -Pattern '^\s*DLL Name:\s*(.+)$' |
        ForEach-Object { $_.Matches[0].Groups[1].Value.Trim() } |
        Sort-Object -Unique

# The mingw runtime is the hazard: these are beside the exe in the build
# directory or on the Cygwin PATH, and on nobody else's machine.
$runtime = $dlls | Where-Object {
  $_ -match '^(cygwin1|libgcc_s|libstdc\+\+|libwinpthread|msys-2\.0)'
}
$loaderNamed = $dlls | Where-Object { $_ -ieq 'WebView2Loader.dll' }

Note "imports: $($dlls -join ', ')"
if ($runtime) {
  throw "the exe imports mingw runtime DLLs that will not exist on a clean machine: $($runtime -join ', ')"
}
if (-not $loaderNamed) {
  Warn 'the exe does not import WebView2Loader.dll — webview2-com-sys may have started linking it statically on this target, in which case the bundle resource is now dead weight.'
} elseif ($NoBundle) {
  Note 'WebView2Loader.dll named, and copied beside the exe'
} else {
  Note 'WebView2Loader.dll named, copied beside the exe and shipped as a bundle resource'
}

# ---------------------------------------------------------------------------
Step 'built'
Note ('{0,10:N1} MB  {1}' -f ((Get-Item $exe).Length / 1MB), $exe)
if (-not $NoBundle) {
  Get-ChildItem (Join-Path $targetDir 'bundle') -Recurse -Include '*.msi', '*.exe' -ErrorAction SilentlyContinue |
    ForEach-Object { Note ('{0,10:N1} MB  {1}' -f ($_.Length / 1MB), $_.FullName) }
  Write-Host ''
  Note 'The NSIS setup installs per-user (tauri defaults nsis.installMode to currentUser),'
  Note 'so it needs no admin. The msi does. To install without a UAC prompt:'
  Write-Host ''
  Write-Host ('      & "{0}" /S' -f (Join-Path $targetDir 'bundle\nsis\Skein_0.1.0_x64-setup.exe')) -ForegroundColor Gray
  Write-Host ''
}
