/* What the recogniser does on this machine, and what it says when it will not.
 *
 *   cargo run --example voice-probe                      # what is installed
 *   cargo run --example voice-probe -- listen            # one utterance, spoken
 *   cargo run --example voice-probe -- listen fr         # ...in a language
 *   cargo run --example voice-probe -- record out.wav    # keep one, to measure with
 *   cargo run --example voice-probe -- decode out.wav fr # what an engine makes of it
 *
 * `record` and `decode` are the pair that make a *measurement* rather than an
 * impression. Every number in `voice.rs`'s header table was taken against
 * Windows TTS clips, and that file says so and calls them upper bounds: no room
 * tone, no accent, no disfluency. A real clip from the real microphone can be
 * decoded by every candidate engine in turn, which is the only way to compare
 * two of them on the same words — and the only way to run the comparison again
 * after changing something.
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

/// A language tag out of the arguments, or the default. Anything two letters
/// long that is not a verb — so `listen fr` and `decode clip.wav fr` both read
/// the way somebody would write them.
fn language_in(args: &[String]) -> String {
    args.iter()
        .find(|a| a.len() == 2 && a.chars().all(|c| c.is_ascii_alphabetic()))
        .cloned()
        .unwrap_or_else(|| skein_lib::voice::DEFAULT_LANGUAGE.to_string())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let verbs = ["listen", "record", "decode"];
    let language = language_in(&args);
    let dir = args
        .iter()
        .find(|a| {
            !verbs.contains(&a.as_str()) && !a.ends_with(".wav") && a.len() != 2 && !a.contains('-')
        })
        .map(PathBuf::from)
        .unwrap_or_else(default_models_dir);

    println!("models directory       : {}", dir.display());

    /* ── keep one utterance, so a measurement can be repeated ── */
    if args.iter().any(|a| a == "record") {
        let Some(out) = args.iter().find(|a| a.ends_with(".wav")) else {
            println!("name the file to write, e.g. `record fr1.wav`");
            return;
        };
        match skein_lib::voice::record(&dir, &PathBuf::from(out), &|line| println!("  {line}")) {
            Ok(seconds) => println!("wrote {out} — {seconds:.1}s"),
            Err(e) => println!("nothing recorded — {e}"),
        }
        return;
    }

    /* ── what an engine makes of a clip, and what it cost ── */
    if args.iter().any(|a| a == "decode") {
        let Some(wav) = args.iter().find(|a| a.ends_with(".wav")) else {
            println!("name the file to read, e.g. `decode fr1.wav fr`");
            return;
        };
        let engine = args.iter().find(|a| a.contains('-') && !a.ends_with(".wav"));
        match skein_lib::voice::decode(
            &dir,
            &language,
            &PathBuf::from(wav),
            engine.map(String::as_str),
            &|line| println!("  {line}"),
        ) {
            Ok(d) => {
                println!("engine                 : {}", d.engine);
                println!("language               : {language}");
                println!("audio                  : {}ms", d.audio_ms);
                println!("load                   : {}ms", d.load_ms);
                println!("decode                 : {}ms", d.decode_ms);
                /* The column that decides. Above 1.0 and the engine falls behind
                   a live microphone faster than you can speak. */
                println!("rtf                    : {:.2}", d.rtf);
                println!("heard                  : {:?}", d.text);
            }
            Err(e) => println!("could not decode — {e}"),
        }
        return;
    }

    match skein_lib::voice::hearing(&dir, &language) {
        Ok(h) => {
            println!("asked about            : {}", h.language);
            println!("can listen in          : {}", h.languages.join(", "));
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
    match skein_lib::voice::listen(&dir, &language, |partial| {
        println!("  … {partial}");
    }) {
        Ok(h) => println!("heard in {}ms ({}): {:?}", h.ms, h.confidence, h.text),
        Err(e) => println!("nothing heard — {e}"),
    }
}
