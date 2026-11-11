package com.volery.phone

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONArray

/**
 * The fields settings edits and the screens read, seeded from `BuildConfig`
 * (which reads `local.properties` at build time, so the committed project
 * carries no key).
 *
 * Two kinds of value live here and they are not kept the same way. The **key
 * phrase** is in memory only, deliberately: it is exactly the thing you type at
 * the wall rather than leave lying around in an app's preferences, and it is
 * seeded from the build when the machine that built the app knew it. The rest —
 * how the phone looks and behaves, and which wall it prefers and reads — are
 * preferences, and a settings screen that forgets your theme the moment the
 * process dies is not a settings screen. They go through [restore] and
 * [persist], a small `SharedPreferences` file; the walls and this phone's name
 * persist with them because neither is a secret.
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

    var key by mutableStateOf(BuildConfig.PHONE_KEY)
    var name by mutableStateOf(BuildConfig.PHONE_NAME)

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
