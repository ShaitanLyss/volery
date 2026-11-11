package com.volery.phone

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * The JNI surface of `phone-ffi`, the Rust cdylib. Every call returns a JSON
 * envelope — `{"ok": …}` or `{"err": "…"}` — which [parse] turns into an
 * [Envelope] the app can branch on. Every call that reaches a wall blocks (the
 * node binds and dials), `sightAny` longest of all since it may dial several,
 * so they all run off the main thread — the service's executor or the
 * narration loop's IO block. `narrate` is the one pure fold and returns at
 * once.
 */
object NativeBridge {
    init {
        System.loadLibrary("phone_ffi")
    }

    external fun initPlatformVerifier(context: Context): String
    external fun start(phrase: String, name: String): String
    external fun sight(host: String): String

    /** The walk: `host` first, then the walls in `remembered` (a JSON array),
     *  then whatever the flyway's directory names. The answer's `host` is the
     *  wall that opened. */
    external fun sightAny(host: String, remembered: String): String

    /** [sightAny], with the one failure that is an `Error` rather than an
     *  `Exception`: a bridge built before the walk has no such symbol, and an
     *  `UnsatisfiedLinkError` would otherwise kill the service's thread with
     *  nothing on screen. The cure is the README's step 1 and a reinstall. */
    fun walk(host: String, remembered: String): Envelope =
        try {
            parse(sightAny(host, remembered))
        } catch (e: UnsatisfiedLinkError) {
            Envelope.Error("the phone's bridge is out of date — rebuild the .so and reinstall")
        }
    external fun fetch(host: String, card: String, kind: String, kept: String, path: String): String
    external fun narrate(prev: String, curr: String, chatty: String): String
    external fun steward(host: String, transcript: String): String
    external fun confirm(host: String, id: String): String
    external fun answer(host: String, card: String, askId: String, text: String): String

    /** Everything a wall is waiting on a person for, read off the `cards`
     *  object `sight` returned: parked and filed questions, removal and close
     *  confirmations, every other confirmation, and the notice queue. Pure. */
    external fun prompts(cards: String): String

    /** The prose that led to a card's prompt, pulled on demand. */
    external fun tail(host: String, card: String): String

    /** The reply a sheet of picks composes, in the shape an agent reads. */
    external fun composeAnswers(headers: String, picks: String): String

    /** [prompts] with the bridge's own failures caught. An artifact built
     *  before this call reads as "nothing is waiting", which is the one wrong
     *  answer that cannot strand a card — the wall's digest still shows its
     *  counts, and the cure is the README's rebuild step. */
    fun promptsOf(cards: String): List<PromptRow> = try {
        when (val e = parse(prompts(cards))) {
            is Envelope.Ok -> parsePrompts(e.payload).also {
                android.util.Log.d("PhonePrompts", "read ${it.size} prompt(s), ${it.count { p -> p.blocking }} blocking")
            }
            is Envelope.Error -> emptyList()
        }
    } catch (e: UnsatisfiedLinkError) {
        emptyList()
    }

    fun proseOf(host: String, card: String): Envelope = try {
        parse(tail(host, card))
    } catch (e: UnsatisfiedLinkError) {
        Envelope.Error("the phone's bridge is out of date — rebuild libphone_ffi.so")
    }

    fun composeOf(headers: List<String>, picks: List<String>): Envelope = try {
        parse(composeAnswers(JSONArray(headers).toString(), JSONArray(picks).toString()))
    } catch (e: UnsatisfiedLinkError) {
        Envelope.Error("the phone's bridge is out of date — rebuild libphone_ffi.so")
    }

    sealed class Envelope {
        class Ok(val payload: JSONObject) : Envelope()
        class Error(val message: String) : Envelope()
    }

    fun parse(envelope: String?): Envelope {
        if (envelope == null) return Envelope.Error("no reply from the node")
        return try {
            val root = JSONObject(envelope)
            if (root.has("err")) Envelope.Error(root.getString("err"))
            else Envelope.Ok(root.getJSONObject("ok"))
        } catch (e: Exception) {
            Envelope.Error("unreadable reply: ${e.message}")
        }
    }
}
