package com.volery.phone

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

/**
 * The phone's ears: Google's recogniser over [SpeechRecognizer], one session at
 * a time. Partial transcripts are handed back as they are heard, the settled
 * one on [onFinal], and an error as a sentence on [onError] — the app shows
 * them as text and, for M3, does nothing further; M5 wires a transcript to a
 * wall's steward. All callbacks arrive on the main thread, so the state setters
 * they drive need no hop.
 */
class Listener(private val context: Context) {
    private var recognizer: SpeechRecognizer? = null

    var onHeard: ((String) -> Unit)? = null
    var onFinal: ((String) -> Unit)? = null
    var onError: ((String) -> Unit)? = null

    fun start() {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            onError?.invoke("speech recognition is not available on this phone")
            return
        }
        stop()
        val sr = SpeechRecognizer.createSpeechRecognizer(context)
        sr.setRecognitionListener(callbacks)
        recognizer = sr
        sr.startListening(
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US")
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            },
        )
    }

    /** Cancel and release the current session, if any. `cancel` before
     *  `destroy` so a user-initiated stop does not surface as an error. */
    fun stop() {
        val sr = recognizer ?: return
        recognizer = null
        sr.cancel()
        sr.destroy()
    }

    private val callbacks = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) = Unit
        override fun onBeginningOfSpeech() = Unit
        override fun onRmsChanged(rmsdB: Float) = Unit
        override fun onBufferReceived(buffer: ByteArray?) = Unit
        override fun onEndOfSpeech() = Unit
        override fun onEvent(eventType: Int, params: Bundle?) = Unit

        override fun onResults(results: Bundle?) {
            results.bestText()?.let { onFinal?.invoke(it) }
        }

        override fun onPartialResults(partialResults: Bundle?) {
            partialResults.bestText()?.let { onHeard?.invoke(it) }
        }

        override fun onError(error: Int) {
            onError?.invoke(errorText(error))
        }
    }

    private fun Bundle?.bestText(): String? =
        this?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()

    private fun errorText(error: Int): String = when (error) {
        SpeechRecognizer.ERROR_NO_MATCH -> "did not catch that"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "no speech heard"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "the ears are busy"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "no microphone permission"
        else -> "the ears failed ($error)"
    }
}
