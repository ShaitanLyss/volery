/// Tauri's build script, plus one warning that saves an afternoon.
///
/// See `.claude/rules/build.md` for the whole of the no-MSVC story.
fn main() {
    warn_if_gnu_without_the_shim();
    manifest_for_examples();
    tauri_build::build()
}

/// Examples that link `tauri` die at load with `STATUS_ENTRYPOINT_NOT_FOUND`
/// (0xC0000139, exit 127 from a shell) and print nothing: `tauri-build` embeds
/// the Common-Controls v6 manifest in the app's binaries only, and without it
/// Windows binds comctl32 v5, which has no `TaskDialogIndirect`. Found when
/// `examples/cast-probe.rs` started reaching `cast::local` and stopped running
/// at all. MSVC only; the gnu toolchain's linker takes no such flag.
fn manifest_for_examples() {
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if windows && msvc {
        println!("cargo:rustc-link-arg-examples=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-examples=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }
}

/// Say why the build is about to fail, at the moment it is about to fail.
///
/// On the `windows-gnu` target this crate's resource compilation runs
/// `windres`, and `embed-resource` spawns it by bare name. Cygwin's `windres`
/// cannot read a Windows path — it drives `gcc -E` through a shell, which eats
/// the backslashes — so what comes back is:
///
/// ```text
/// cc1: fatal error: C:Userslyss.delpratworkbench...resource.rc: No such file
/// windres: preprocessing failed.
/// thread 'main' panicked at tauri-winres-0.3.6/src/lib.rs:543
/// ```
///
/// Note the mangled path: that is the separators being eaten, and it is the only
/// clue. `tools/windres-shim.c` exists to intercept the call and hand the real
/// `windres` a path it can read, and `tools/check-gnu.sh` puts it on PATH.
///
/// **The failure names nothing that points at the cause**, which is the whole
/// reason for this function. Twice now someone has read that panic as a broken
/// tree and gone looking for what they had done to it — most recently while
/// verifying an unrelated commit, costing a stretch of time and a false alarm
/// sent to three other cards sharing the checkout (sink `822ad886`). The build
/// was fine both times; cargo had simply been invoked without the environment.
///
/// A **warning rather than a panic**, deliberately. `SKEIN_REAL_WINDRES` being
/// unset proves the shim is not configured; it does not prove the build must
/// fail, because a machine with a genuine mingw `windres` first on PATH may well
/// be fine. Refusing to build there would trade a confusing failure for a
/// confident wrong one. So this speaks and gets out of the way — and since
/// cargo prints build-script warnings immediately before the error that
/// follows, it lands exactly where it is needed.
fn warn_if_gnu_without_the_shim() {
    /* Cargo sets these for the *target* being compiled, not the host, which is
       the pair we want: MSVC machines and the CI runner must never see this. */
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let gnu = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu");
    if !(windows && gnu) || std::env::var_os("SKEIN_REAL_WINDRES").is_some() {
        return;
    }
    for line in [
        "building for windows-gnu with SKEIN_REAL_WINDRES unset.",
        "If this build fails in windres with a path that has lost its separators,",
        "that is the cause and not anything you have done to the tree.",
        "Use `tools/check-gnu.sh` (which passes arguments through) rather than bare cargo.",
        "See .claude/rules/build.md.",
    ] {
        println!("cargo:warning={line}");
    }
}
