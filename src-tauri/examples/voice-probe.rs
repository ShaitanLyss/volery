/* What the recogniser does on this machine, and what it says when it will not.
 *
 *   cargo run --example voice-probe            # what is installed
 *   cargo run --example voice-probe -- listen  # one utterance, spoken
 *
 * The microphone is the one thing in this app that cannot be tested without a
 * person, so this is how somebody checks theirs — and it is the same code path
 * the key will use, not a rehearsal of it.
 *
 * If `listen` reports the privacy policy, that is the gate `voice.rs` describes
 * and it is not a fault in anything here. Nothing in this app changes that
 * setting.
 */

fn main() {
    match skein_lib::voice::hearing() {
        Ok(h) => {
            println!("system speech language : {}", h.system);
            println!("dictation installed for: {}", h.dictation.join(", "));
            println!(
                "en-US ready            : {}",
                if h.ready { "yes" } else { "NO — the wall's verbs are English" }
            );
        }
        Err(e) => {
            println!("the speech stack would not answer: {e}");
            return;
        }
    }

    if !std::env::args().any(|a| a == "listen") {
        println!("\npass `listen` to speak one utterance into it.");
        return;
    }

    println!("\nspeak now — try \"select the auth work and fit the wall\"");
    match skein_lib::voice::listen(skein_lib::voice::DEFAULT_LANGUAGE) {
        Ok(h) => println!("heard in {}ms ({}): {:?}", h.ms, h.confidence, h.text),
        Err(e) => println!("nothing heard — {e}"),
    }
}
