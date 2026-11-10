package com.volery.phone

import android.content.Context
import org.json.JSONObject

/**
 * The JNI surface of `phone-ffi`, the Rust cdylib. Every call returns a JSON
 * envelope — `{"ok": …}` or `{"err": "…"}` — which [parse] turns into an
 * [Envelope] the app can branch on. `start` and `sight` block (the node binds
 * and dials), so they run off the main thread, on the service's executor;
 * `narrate` is a pure fold and returns at once, but is cheap enough that the
 * narration loop runs it off the main thread too.
 */
object NativeBridge {
    init {
        System.loadLibrary("phone_ffi")
    }

    external fun initPlatformVerifier(context: Context): String
    external fun start(phrase: String, name: String): String
    external fun sight(host: String): String
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
