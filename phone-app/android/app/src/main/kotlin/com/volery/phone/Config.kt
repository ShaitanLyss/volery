package com.volery.phone

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONArray

/**
 * The fields settings edits and the screens read.
 *
 * Two kinds of value live here and they are not kept the same way. The **key
 * phrase** is the one secret: it used to be baked into the APK from
 * `local.properties`, which meant every copy of the APK carried it, and it is
 * now typed in on this phone and kept wrapped by the Android Keystore
 * (`Kept.kt`) — so a preferences file copied off the device carries ciphertext
 * and nothing else. It is read back with [restoreKey] before anything dials.
 * The rest — how the phone looks and behaves, and which wall it prefers and
 * reads — are preferences, and a settings screen that forgets your theme the
 * moment the process dies is not a settings screen. They go through [restore]
 * and [persist], a small `SharedPreferences` file; the walls and this phone's
 * name persist with them because neither is a secret.
 */
object Config {
    /** The wall being read now. Set by a sighting; what `Ears`, `Steer` and the
     *  viewer address. Empty until a wall has answered, which is a real state:
     *  a phone with no configured wall starts by asking the directory. */
    var host by mutableStateOf(BuildConfig.PHONE_HOST)

    /** The wall the person chose to start from, or empty for none. Tried first
     *  when the phone opens or is redialled, and deliberately separate from
     *  [host]: a fallback moves the wall being read, not the preference, so
     *  the laptop you meant is tried again next time rather than being lost to
     *  whichever wall happened to answer. Empty is not a failure; the walk
     *  falls to [host], the roster and then the flyway's directory. */
    var preferred by mutableStateOf(BuildConfig.PHONE_HOST)

    /** The phrase this phone joins the flyway with. Empty until it is typed
     *  in, and empty again only if the device loses the key that wrapped it —
     *  which reads exactly like a fresh install, deliberately. */
    var key by mutableStateOf("")
    var name by mutableStateOf(BuildConfig.PHONE_NAME)

    /** The wall's device id, when the invite carried one (`phrase·host·id`).
     *  Public, so it lives in the ordinary preferences beside the wall names:
     *  it names a machine, it is not a secret, and the enrolment flow needs it
     *  to dial a wall it has never met. Empty is an invite from a wall that
     *  does not carry one yet. */
    var device by mutableStateOf("")

    /** Read the kept phrase before anything dials. Both the activity and the
     *  service call it: the service can be started by the OS with no activity
     *  in front of it, and a dial with an empty key fails silently. */
    fun restoreKey(context: Context) {
        key = Kept.get(context) ?: ""
    }

    /** Keep what was typed. The phrase is stored wrapped; an invite pasted in
     *  the wall's own shape (`phrase · host`) also fills [preferred], because
     *  the wall that handed you the invite is the one you meant to reach. */
    fun keepKey(context: Context, typed: String) {
        val (phrase, wall, wallDevice) = inviteOf(typed)
        key = phrase
        if (phrase.isEmpty()) Kept.forget(context) else Kept.put(context, phrase)
        if (!wall.isNullOrEmpty()) preferred = wall
        if (!wallDevice.isNullOrEmpty()) device = wallDevice
        if (!wall.isNullOrEmpty() || !wallDevice.isNullOrEmpty()) persist()
    }

    /** The walls the last sighting showed, in the order the answering wall
     *  listed them. Kept because the wall in [host] may be off while the
     *  flyway is still up: the node walks these before it asks the flyway's
     *  directory, which is the only place a wall never met can come from. */
    var remembered by mutableStateOf<List<String>>(emptyList())

    /** How much the phone says: "off", "needs" or "murmur" — the same three
     *  words phone-ffi's `narrate` takes. */
    var chatty by mutableStateOf("murmur")

    /** How she talks back: "push-to-talk" (hold the rail) or "seamless"
     *  (listens on its own after something needs her). The wake word is
     *  deferred, not forgotten. */
    var mode by mutableStateOf("push-to-talk")

    /** What happens to her music while the phone speaks something that needs
     *  her: "duck" lowers it, "pause" stops it. */
    var music by mutableStateOf("duck")

    /** The ground settings names first: "studio" (the default) or "vellum". */
    var theme by mutableStateOf("studio")

    /** "full", "spare" or "still" — how much the wall is allowed to move. */
    var motion by mutableStateOf("full")

    /** Whether the first-launch introduction has been shown. Set when it opens,
     *  not when it is finished, so a half-read or skipped one does not come
     *  back on the next launch; settings reopens it for ever after. */
    var tutorialSeen by mutableStateOf(false)

    private const val FILE = "volery"
    private var prefs: SharedPreferences? = null

    /** Read back what was chosen last time, and hold the file for [persist].
     *  Called once, before the first composition; the key phrase is the one
     *  field it will not read or write. */
    fun restore(context: Context) {
        val sp = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
        prefs = sp
        theme = sp.getString("theme", theme) ?: theme
        motion = sp.getString("motion", motion) ?: motion
        chatty = sp.getString("chatty", chatty) ?: chatty
        mode = sp.getString("mode", mode) ?: mode
        music = sp.getString("music", music) ?: music
        /* A missing `preferred` means no preference, not "use the wall being
         * read": the current wall is written on every sighting, so reading it
         * back as a preference would quietly pin a phone that never chose one.
         * A phone from before the preference existed keeps its wall as the
         * first fallback through `host`, which is where it belongs. */
        preferred = sp.getString("preferred", preferred) ?: preferred
        device = sp.getString("device", device) ?: device
        host = sp.getString("host", preferred) ?: preferred
        name = sp.getString("name", name) ?: name
        tutorialSeen = sp.getBoolean("tutorialSeen", tutorialSeen)
        remembered = readWalls(sp.getString("remembered", null))
    }

    /** The wall to try first: the preference when there is one, else the wall
     *  last read. Empty means the walk starts at the directory. */
    fun firstDoor(): String = preferred.trim().ifEmpty { host.trim() }

    /** What the walk takes after its first door: the preference and the wall
     *  being read, then the roster. The node dedupes, so a repeat costs
     *  nothing; putting both first is what lets a poll stay on the wall it is
     *  reading while a startup dial goes back to the preferred one. */
    fun walkJson(): String {
        val seeds = (listOf(preferred, host) + remembered)
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .distinct()
        return JSONArray(seeds).toString()
    }

    private fun wallsJson(): String = JSONArray(remembered).toString()

    /** Write the preferences back. A key phrase never reaches this. */
    fun persist() {
        prefs?.edit()
            ?.putString("theme", theme)
            ?.putString("motion", motion)
            ?.putString("chatty", chatty)
            ?.putString("mode", mode)
            ?.putString("music", music)
            ?.putString("host", host)
            ?.putString("preferred", preferred)
            ?.putString("device", device)
            ?.putString("name", name)
            ?.putBoolean("tutorialSeen", tutorialSeen)
            ?.putString("remembered", wallsJson())
            ?.apply()
    }

    /** The introduction was shown. Its own write so a launch does not push every
     *  setting through the preferences file to record one flag. */
    fun persistTutorial() {
        prefs?.edit()?.putBoolean("tutorialSeen", tutorialSeen)?.apply()
    }

    /** Write only the fields a sighting owns. [persist] writes every field, so
     *  a sighting landing on the service's thread at the same moment as a
     *  setting was changed would put the old value back; this cannot. */
    fun persistWalls() {
        prefs?.edit()
            ?.putString("host", host)
            ?.putString("remembered", wallsJson())
            ?.apply()
    }

    /** Write only the preference. A tap that succeeds becomes the preference
     *  without dragging the rest of the settings through a second write. */
    fun persistPreferred() {
        prefs?.edit()?.putString("preferred", preferred)?.apply()
    }

    /** A stored list that cannot be read is no list, never a crash: the phone
     *  still has the wall in [host], and a walk from one name is what it did
     *  before there was a list. */
    private fun readWalls(raw: String?): List<String> {
        if (raw.isNullOrBlank()) return emptyList()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).mapNotNull { i ->
                (arr.opt(i) as? String)?.trim()?.takeIf { it.isNotEmpty() }
            }
        } catch (e: Exception) {
            emptyList()
        }
    }
}

/**
 * An invite, as a wall hands one over: the phrase, a middle dot, the wall's
 * name, and (since device membership) a second dot and the wall's device id.
 * `key.rs::join` joins the first two and splits on the same character.
 *
 * Typing only the phrase is the ordinary case; pasting the whole line is the
 * reason this exists, and it is also how [Config.preferred] gets filled without
 * a second field — the wall that gave you the invite is the one you meant. The
 * device id is kept for the day the wall refuses strangers: it is what a phone
 * dials a wall it has never met by, and dropping it here would make an invite
 * that arrived in the new shape an invite that works until the enrolment lands.
 *
 * Pure, so the shapes are a thing to read rather than to discover by pasting;
 * the dot is the only separator, because the phrase has spaces in it and a
 * dash-dash spelling would collide with its own punctuation.
 */
fun inviteOf(typed: String): Triple<String, String?, String?> {
    val text = typed.trim()
    val parts = text.split('·')
    val phrase = parts.getOrNull(0)?.trim().orEmpty()
    return Triple(
        phrase,
        parts.getOrNull(1)?.trim()?.ifEmpty { null },
        parts.getOrNull(2)?.trim()?.ifEmpty { null },
    )
}
