package com.volery.phone

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * The three fields the node needs — the wall host, the key phrase, and this
 * phone's name — as editable state, seeded from `BuildConfig` (which reads
 * `local.properties` at build time, so the committed project carries no key).
 * Settings edits them; the home screen dials with them. In-memory only, as
 * the classic app was: a key phrase is exactly the kind of thing you type at
 * the wall rather than leave lying around.
 */
object Config {
    var host by mutableStateOf(BuildConfig.PHONE_HOST)
    var key by mutableStateOf(BuildConfig.PHONE_KEY)
    var name by mutableStateOf(BuildConfig.PHONE_NAME)

    // How much the phone says: "off", "needs" or "murmur" — the same three
    // words phone-ffi's `narrate` takes. Default "murmur", so the milestone
    // proof (a card finishing, a question arriving) speaks without any setup,
    // and the user can quiet it down. In-memory only, as the rest of Config is;
    // the narration *digest* is persisted separately (`NarrationStore`) because
    // a reopen must not re-speak everything, but a chatty choice is a
    // preference, not something to recover.
    var chatty by mutableStateOf("murmur")

    // How she talks back: the walking mode. "push-to-talk" is the tap and does
    // nothing until she does; "seamless" listens on its own after something
    // needs her; "hey-volery" is the wake word, deferred (not built). Default
    // push-to-talk, the one that does nothing without her.
    var mode by mutableStateOf("push-to-talk")

    // What happens to her music while the phone speaks something that needs
    // her: "duck" lowers it, "pause" stops it. Both resume when the line is
    // done — the transient focus is handed back, not held.
    var music by mutableStateOf("duck")
}
