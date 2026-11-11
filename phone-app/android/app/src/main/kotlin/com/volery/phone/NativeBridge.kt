package com.volery.phone

import android.content.Context
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
