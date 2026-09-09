/* What the recogniser does on this machine, and what it says when it will not.
 *
 *   cargo run --example voice-probe                 # what is installed
 *   cargo run --example voice-probe -- listen       # one utterance, spoken
 *   cargo run --example voice-probe -- listen <dir> # ...against another model dir
 *
 * The microphone is the one thing in this app that cannot be tested without a
 * person, so this is how somebody checks theirs — and it is the same code path
 * the key will use, not a rehearsal of it.
 *
 * ## Where the models live, and why this has to be told
 *
 * `voice.rs` takes the model directory as an argument rather than finding it,
 * because in the app it comes from `AppHandle::path().app_data_dir()` and there
 * is no `AppHandle` here. So this probe defaults to the same place the app would
 * put it — `%APPDATA%/dev.skein.studio/speech` — and takes an override for
 * pointing at a directory you already have, such as the one `earshot` fetched.
 *
 * **`dev.skein.studio` is spelled out here rather than derived**, and it is the
 * identifier CLAUDE.md warns must never be renamed casually: it is the folder
 * the live database sits in. A probe hard-coding it is fine; a probe *changing*
 * it would orphan a wall.
 *
 * Note the first run downloads ~286MB before it can hear anything, which
 * `hearing()` will tell you about in advance via `to_fetch_mb`.
 */

use std::path::PathBuf;

fn default_models_dir() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("dev.skein.studio").join("speech")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = args
        .iter()
        .find(|a| *a != "listen")
        .map(PathBuf::from)
        .unwrap_or_else(default_models_dir);

    println!("models directory       : {}", dir.display());

    match skein_lib::voice::hearing(&dir) {
        Ok(h) => {
            println!("transcribes            : {}", h.language);
            println!(
                "input device           : {}",
                h.device.as_deref().unwrap_or("NONE — nothing to listen with")
            );
            println!(
                "weights on disk        : {}",
                if h.ready {
                    "yes".to_string()
                } else {
                    format!("no — first listen fetches about {}MB", h.to_fetch_mb)
                }
            );
        }
        Err(e) => {
            println!("the speech stack would not answer: {e}");
            return;
        }
    }

    if !args.iter().any(|a| a == "listen") {
        println!("\npass `listen` to speak one utterance into it.");
        return;
    }

    println!("\nspeak now — try \"select the auth work and fit the wall\"");
    /* The partial callback is printed rather than discarded, because *when* the
       recogniser commits to a word is half of what a probe about a speech stack
       is asking. A `|_| {}` here would compile and answer a narrower question
       than the one this file exists for — and with a batch engine behind a VAD,
       what arrives here is one decoded segment at a time, so it is also the only
       way to see the segmentation working. */
    match skein_lib::voice::listen(&dir, skein_lib::voice::DEFAULT_LANGUAGE, |partial| {
        println!("  … {partial}");
    }) {
        Ok(h) => println!("heard in {}ms ({}): {:?}", h.ms, h.confidence, h.text),
        Err(e) => println!("nothing heard — {e}"),
    }
}
