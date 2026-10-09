//! A lab wall of its own, chosen when the process starts rather than when the
//! binary was built.
//!
//! `identifier` is what decides almost everything a wall owns: the `%APPDATA%`
//! folder its database, `control.json` and browser profile live in, the
//! `%LOCALAPPDATA%` folder its webview keeps its profile in, and the name of the
//! mutex `claim_wall` takes. `tauri dev --config` sets it at *compile* time, so
//! every distinct lab used to mean a distinct build of `skein_lib` — and two
//! `tauri dev`s on one target directory cannot both run, since the second one's
//! link has to overwrite an `.exe` the first is executing.
//!
//! So `tools/lab.ts` runs one frozen copy of the debug binary per lab, and this
//! is what tells each copy which lab it is: `VOLERY_LAB=<name>` makes it
//! `dev.skein.lab.<name>`, and `VOLERY_LAB_PORT` points it at that lab's own
//! vite. Everything identifier-keyed then forks in one move, exactly as it does
//! for `bun run lab` — and `claim_wall` refuses a second process under the same
//! name for free, which is the guard the brief would not let anybody weaken.
//!
//! **Debug builds only.** A release build ignores both variables, so nothing a
//! person can set in a shell profile moves the installed wall off its store.
//! And by construction the result can never be `dev.skein.studio`: the name is
//! a suffix on a different prefix, and a name that does not parse is a refusal
//! rather than a fallback — the fallback would be the binary's compiled-in
//! identifier, which for a copy built by `bun run tauri dev` is the real wall.
//!
//! **A lab also flies on a key of its own**, under its own identifier, whichever
//! way it was launched — `bun run lab` as much as `bun run lab <name>`. See
//! `flyway::key::OWN_TARGET` for what sharing the studio's key cost. A named lab
//! comes up holding one: its `--peer`'s (`VOLERY_LAB_PEER`), or a fresh one.
//! `VOLERY_LAB_ON_INSTALLED_FLYWAY=1` is the one way onto the installed wall's
//! flyway — and onto Lyss's roster, her shadows and her sink — and is named so
//! that nobody sets it by accident; a lab on it may use that key, never change it.

/// Take on the lab identity `VOLERY_LAB` names, if it names one.
pub fn assume<R: tauri::Runtime>(mut context: tauri::Context<R>) -> tauri::Context<R> {
    #[allow(unused_mut)]
    let mut named = false;
    #[cfg(debug_assertions)]
    {
        let name = std::env::var("VOLERY_LAB").ok();
        let port = std::env::var("VOLERY_LAB_PORT").ok();
        match identity(name.as_deref(), port.as_deref()) {
            Ok(None) => {}
            Ok(Some(lab)) => {
                named = true;
                let config = context.config_mut();
                config.identifier = lab.identifier;
                config.product_name = Some(lab.product);
                if let Some(url) = lab.url {
                    config.build.dev_url = Some(url.parse().expect("a localhost url parses"));
                }
            }
            /* Before the builder, so there is no window, no log and no box to put
               it in — and `tools/lab.ts` validates first, so this is a backstop
               that only a hand-typed variable reaches. Exiting is the point: the
               alternative is opening whatever wall the binary was built for. */
            Err(why) => {
                eprintln!("volery: {why}");
                std::process::exit(2);
            }
        }
    }
    let identifier = context.config().identifier.clone();
    let installed = std::env::var("VOLERY_LAB_ON_INSTALLED_FLYWAY").ok();
    match flyway_for(&identifier, installed.as_deref()) {
        Flyway::Studio => {}
        Flyway::Borrowed => crate::flyway::key::borrow_the_installed_key(),
        Flyway::Own => {
            crate::flyway::key::keep_to(&identifier);
            if named {
                let peer = std::env::var("VOLERY_LAB_PEER").ok();
                /* A lab without a flyway is still a lab, so this says why and
                   goes on — the launcher has already checked the peer is up. */
                if let Err(why) = crate::flyway::key::settle_lab(peer.as_deref()) {
                    eprintln!("volery: no flyway for this lab: {why}");
                }
            }
        }
    }
    context
}

#[derive(Debug, PartialEq)]
enum Flyway {
    /// The installed wall: the real key, as always.
    Studio,
    /// A lab on a key under its own identifier — the default for every lab.
    Own,
    /// A lab on the installed wall's key, asked for in so many words.
    Borrowed,
}

/// Which key a wall flies on. Keyed on the identifier rather than on
/// `VOLERY_LAB`, so the bare lab — whose identifier is compiled in by
/// `tauri dev --config` — keeps to its own key too.
fn flyway_for(identifier: &str, installed: Option<&str>) -> Flyway {
    if identifier == "dev.skein.studio" {
        Flyway::Studio
    } else if installed.map(str::trim) == Some("1") {
        Flyway::Borrowed
    } else {
        Flyway::Own
    }
}

#[derive(Debug, PartialEq)]
struct Lab {
    identifier: String,
    product: String,
    url: Option<String>,
}

/// What a lab name and port amount to. `Ok(None)` is no lab asked for.
///
/// The name is the same alphabet `tools/lab.ts` accepts, and narrow on purpose:
/// it becomes a folder name twice over and a mutex name, so anything a path or
/// a kernel namespace would read specially is out.
fn identity(name: Option<&str>, port: Option<&str>) -> Result<Option<Lab>, String> {
    let Some(name) = name.map(str::trim).filter(|n| !n.is_empty()) else {
        return Ok(None);
    };
    let ok = name.len() <= 16
        && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !ok {
        return Err(format!(
            "VOLERY_LAB={name:?} is not a lab name — lowercase letters, digits and \
             dashes, at most 16, starting with a letter or digit. Nothing was opened."
        ));
    }
    let url = match port.map(str::trim).filter(|p| !p.is_empty()) {
        None => None,
        Some(p) => match p.parse::<u16>() {
            Ok(n) if n >= 1024 => Some(format!("http://localhost:{n}")),
            _ => {
                return Err(format!(
                    "VOLERY_LAB_PORT={p:?} is not a port this lab can use. Nothing was opened."
                ))
            }
        },
    };
    Ok(Some(Lab {
        identifier: format!("dev.skein.lab.{name}"),
        product: format!("Volery Lab {name}"),
        url,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_name_is_no_lab() {
        assert_eq!(identity(None, Some("1431")), Ok(None));
        assert_eq!(identity(Some("  "), None), Ok(None));
    }

    #[test]
    fn a_name_is_a_wall_of_its_own() {
        let lab = identity(Some("alpha"), Some("1431")).unwrap().unwrap();
        assert_eq!(lab.identifier, "dev.skein.lab.alpha");
        assert_eq!(lab.url.as_deref(), Some("http://localhost:1431"));
        assert_eq!(identity(Some("b-2"), None).unwrap().unwrap().url, None);
    }

    /// The name lands in two folder names and a mutex name, and the refusal is
    /// what stands between a typo and the binary's compiled-in identifier.
    #[test]
    fn a_name_that_could_reach_another_folder_is_refused() {
        for bad in ["..", "a/b", "a\\b", "Alpha", "-x", "a.b", "a b", "seventeen-chars-x", "x:"] {
            assert!(identity(Some(bad), None).is_err(), "{bad:?} was accepted");
        }
        assert!(identity(Some("ok"), Some("80")).is_err());
        assert!(identity(Some("ok"), Some("nope")).is_err());
    }

    /// The studio keeps the real key; every lab keeps to its own unless it
    /// asked for the real one in so many words.
    #[test]
    fn only_the_studio_flies_on_the_real_key_unless_a_lab_asks() {
        assert_eq!(flyway_for("dev.skein.studio", None), Flyway::Studio);
        assert_eq!(flyway_for("dev.skein.studio", Some("1")), Flyway::Studio);
        assert_eq!(flyway_for("dev.skein.lab", None), Flyway::Own);
        assert_eq!(flyway_for("dev.skein.lab.a", None), Flyway::Own);
        assert_eq!(flyway_for("dev.skein.lab.a", Some("yes")), Flyway::Own);
        assert_eq!(flyway_for("dev.skein.lab.a", Some("1")), Flyway::Borrowed);
        assert_eq!(flyway_for("dev.skein.lab", Some(" 1 ")), Flyway::Borrowed);
    }

    /// Whatever the name, the studio is not reachable from here.
    #[test]
    fn a_lab_is_never_the_studio() {
        for name in ["studio", "dev", "0"] {
            let lab = identity(Some(name), None).unwrap().unwrap();
            assert_ne!(lab.identifier, "dev.skein.studio");
            assert!(lab.identifier.starts_with("dev.skein.lab."));
        }
    }
}
