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
 * how the phone looks and behaves, and which wall and name it reads — are
 * preferences, and a settings screen that forgets your theme the moment the
 * process dies is not a settings screen. They go through [restore] and
 * [persist], a small `SharedPreferences` file; the wall host and this phone's
 * name persist with them because neither is a secret.
 */
object Config {
    var host by mutableStateOf(BuildConfig.PHONE_HOST)
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
        host = sp.getString("host", host) ?: host
        name = sp.getString("name", name) ?: name
        remembered = readWalls(sp.getString("remembered", null))
    }

    /** The walls last seen, as the JSON array `sightAny` takes. */
    fun rememberedJson(): String = JSONArray(remembered).toString()

    /** Write the preferences back. A key phrase never reaches this. */
    fun persist() {
        prefs?.edit()
            ?.putString("theme", theme)
            ?.putString("motion", motion)
            ?.putString("chatty", chatty)
            ?.putString("mode", mode)
            ?.putString("music", music)
            ?.putString("host", host)
            ?.putString("name", name)
            ?.putString("remembered", rememberedJson())
            ?.apply()
    }

    /** Write only the two fields a sighting owns. [persist] writes every field,
     *  so a sighting landing on the service's thread at the same moment as a
     *  setting was changed would put the old value back; this cannot. */
    fun persistWalls() {
        prefs?.edit()
            ?.putString("host", host)
            ?.putString("remembered", rememberedJson())
            ?.apply()
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
