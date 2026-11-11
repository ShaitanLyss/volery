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

/** A hold that has run this long ends by itself — a finger that never lifts
 *  must not leave the microphone open for the life of the app. */
const val HOLD_MAX_MS = 60_000L

/** How long a released hold waits for the recogniser to resolve before the
 *  ears are closed anyway. A session that has been asked to finish and says
 *  nothing is one to stop holding open. */
const val HOLD_SETTLE_MS = 4_000L

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
    private val settleRunnable = Runnable { if (listening) stop() }

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

    /** A hold begins: the ears open and stay open while the orb is held. */
    fun holdStart() {
        if (listening) return
        start(timeoutMs = HOLD_MAX_MS)
    }

    /** The hold is released: ask the recogniser to finish, so the session
     *  resolves into a final transcript instead of being cancelled. The ears
     *  stay "listening" until it does, which is what the rail's title reads;
     *  [HOLD_SETTLE_MS] closes a session that never answers. */
    fun holdEnd() {
        if (!listening) return
        handler.removeCallbacks(stopRunnable)
        listener.finish()
        handler.removeCallbacks(settleRunnable)
        handler.postDelayed(settleRunnable, HOLD_SETTLE_MS)
    }

    /** The seamless window: open the ears, and close them after the yes-window
     *  if no final answer has come. */
    fun startSeamless() = start(SEAMLESS_LISTEN_MS)

    /** Set an error the caller already knows (a denied permission) and stop. */
    fun fail(message: String): Unit = onMain {
        onMain {
            handler.removeCallbacks(stopRunnable)
            handler.removeCallbacks(settleRunnable)
            listener.stop()
            error = message
            listening = false
        }
    }

    private fun start(timeoutMs: Long?): Unit = onMain {
        if (listening) return@onMain
        listening = true
        heard = ""
        error = null
        handler.removeCallbacks(settleRunnable)
        listener.start()
        if (timeoutMs != null) {
            handler.removeCallbacks(stopRunnable)
            handler.postDelayed(stopRunnable, timeoutMs)
        }
    }

    fun stop(): Unit = onMain {
        handler.removeCallbacks(stopRunnable)
        handler.removeCallbacks(settleRunnable)
        listener.stop()
        listening = false
    }

    /**
     * Every recogniser call on the thread the platform demands.
     *
     * `SpeechRecognizer` warns (and on some builds misbehaves) when it is
     * created or destroyed off the main thread. The seamless window is opened
     * from `Speaker.onQuiet`, which is a `TextToSpeech` progress callback, and
     * those arrive on a binder thread: the first "try it" created the
     * recogniser there. The hop is here rather than at each caller because the
     * ear must be safe to ask from anywhere, and the callers are a tap, a TTS
     * callback and a timeout. */
    private fun onMain(block: () -> Unit): Unit {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else handler.post(block)
    }
}
