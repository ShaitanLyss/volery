package com.volery.phone

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** How long the seamless window listens after a `needs_you` line — the phone's
 *  `SPOKEN_YES_MS`, the same twenty seconds the desktop holds for a spoken yes
 *  (`voice.md`). The transcript it catches is M5's to act on; M4 only produces
 *  it. */
const val SEAMLESS_LISTEN_MS = 20_000L

/**
 * The ears as one thing the home screen's button (push-to-talk) and the
 * seamless window both drive. Compose state, so the listen bar redraws; the
 * recogniser itself is [Listener]. A seamless start arms a timeout — if no
 * final answer lands in [SEAMLESS_LISTEN_MS], the ears close on their own, the
 * way the desktop's yes-window closes.
 */
class VoiceController(context: Context) {
    private val appContext = context.applicationContext
    private val listener = Listener(appContext)
    private val handler = Handler(Looper.getMainLooper())
    private val stopRunnable = Runnable { stop() }

    var listening by mutableStateOf(false)
        private set
    var heard by mutableStateOf("")
        private set
    var error by mutableStateOf<String?>(null)
        private set

    /** A settled transcript, handed to whoever routes it — the steer loop for
     *  M5. Fired after `heard` is set and the ears are closed, so a reader sees
     *  the final words and a listening flag that is already false. */
    var onFinalTranscript: ((String) -> Unit)? = null

    init {
        listener.onHeard = { heard = it }
        listener.onFinal = { final ->
            heard = final
            stop()
            onFinalTranscript?.invoke(final)
        }
        listener.onError = { message -> error = message; stop() }
    }

    /** Whether the microphone permission is already held. */
    fun hasMic(): Boolean =
        appContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /** The push-to-talk tap. The caller has ensured the microphone permission. */
    fun toggle() {
        if (listening) stop() else start(timeoutMs = null)
    }

    /** The seamless window: open the ears, and close them after the yes-window
     *  if no final answer has come. */
    fun startSeamless() = start(SEAMLESS_LISTEN_MS)

    /** Set an error the caller already knows (a denied permission) and stop. */
    fun fail(message: String) {
        handler.removeCallbacks(stopRunnable)
        listener.stop()
        error = message
        listening = false
    }

    private fun start(timeoutMs: Long?) {
        if (listening) return
        listening = true
        heard = ""
        error = null
        listener.start()
        if (timeoutMs != null) {
            handler.removeCallbacks(stopRunnable)
            handler.postDelayed(stopRunnable, timeoutMs)
        }
    }

    fun stop() {
        handler.removeCallbacks(stopRunnable)
        listener.stop()
        listening = false
    }
}
