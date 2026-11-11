package com.volery.phone

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import android.util.Log
import java.util.Locale

/**
 * The phone's mouth. One [TextToSpeech] for the whole process, initialised
 * lazily and once, and a voice chosen by [pickVoice] rather than left to the
 * robotic default. Lines the narration loop wants to say are queued until the
 * engine is ready, so a line can be spoken the moment the loop has one without
 * waiting on init. `speak` and **`init` are called from the main thread**, which
 * is the thread [TextToSpeech] delivers its callbacks to: constructing it
 * elsewhere lets `onInit` run before the field is published, and the engine
 * then stays unready for the life of the process.
 *
 * A line that needs her (`needsYou`) also takes transient audio focus for as
 * long as the words are in the air, so her music lowers or pauses for the line
 * and comes back when it is done — the milestone's proof. Focus is taken when
 * the first focus-holding utterance is spoken and released when the last one
 * settles, so a batch of two lines is one duck, not two.
 */
object Speaker {
    private const val TAG = "PhoneSpeaker"

    private var tts: TextToSpeech? = null
    private var ready = false
    private val pending = ArrayDeque<Pending>()

    /** Utterances spoken but not yet settled (done or errored). */
    private var inFlight = 0
    /** In-flight utterances whose words hold audio focus. */
    private val focusIds = mutableSetOf<String>()
    private var context: Context? = null

    /** Fired once, when every utterance has settled (`inFlight` back to 0). The
     *  seamless window hangs its "listen after the line is said" off this, so
     *  the ears do not hear the phone's own voice as an answer. */
    var onQuiet: (() -> Unit)? = null

    private class Pending(val text: String, val needsFocus: Boolean)

    /** Call on the main thread only: `onInit` is delivered there, and the
     *  field must be assigned before that callback can read it. */
    fun init(context: Context) {
        this.context = context.applicationContext
        if (tts != null) return
        tts = TextToSpeech(context.applicationContext) { status -> handleInit(status) }
    }

    /** Speak a line. `needsFocus` lowers or pauses music for the line — the
     *  `duck` vs `pause` setting picks which — so pass it for the things that
     *  need her, not for murmur weather. */
    fun speak(text: String, needsFocus: Boolean = false) {
        if (text.isBlank()) return
        val t = tts
        if (!ready || t == null) {
            pending.addLast(Pending(text, needsFocus))
            return
        }
        speakNow(t, text, needsFocus)
    }

    /** Whether anything is in the air **or waiting for the engine**. The queued
     *  half was missed, and it is the half that matters to the ears: a question
     *  spoken before `TextToSpeech` finished initialising sat in `pending`
     *  while `inFlight` stayed at zero, so the seamless window opened at once
     *  and the recogniser heard the phone's own voice as the answer. */
    fun isSpeaking(): Boolean = inFlight > 0 || pending.isNotEmpty()

    private fun speakNow(t: TextToSpeech, text: String, needsFocus: Boolean) {
        val id = "n-${System.nanoTime()}"
        if (needsFocus) {
            if (focusIds.isEmpty()) acquireFocus()
            focusIds.add(id)
        }
        inFlight++
        t.speak(text, TextToSpeech.QUEUE_ADD, null, id)
    }

    private fun acquireFocus() {
        val ctx = context ?: return
        val granted = AudioFocus.acquire(ctx, pause = Config.music == "pause")
        Log.i(TAG, if (granted) "audio focus taken (${Config.music})" else "audio focus refused")
    }

    private fun handleInit(status: Int) {
        val t = tts ?: return
        if (status != TextToSpeech.SUCCESS) {
            Log.w(TAG, "text-to-speech init failed: $status")
            return
        }
        val voice = pickVoice(t)
        if (voice != null) {
            t.voice = voice
            t.setLanguage(voice.locale)
            Log.i(TAG, "voice: ${voice.name} (quality ${voice.quality})")
        } else {
            t.setLanguage(Locale.US)
            Log.w(TAG, "no en-US voice installed; fell back to the default")
        }
        t.setOnUtteranceProgressListener(progress)
        ready = true
        drain()
    }

    private fun drain() {
        val t = tts ?: return
        while (pending.isNotEmpty()) {
            val p = pending.removeFirst()
            speakNow(t, p.text, p.needsFocus)
        }
    }

    /** One utterance settled. When the last focus-holding one is done, hand the
     *  focus back so music resumes; when everything is done, fire [onQuiet]. */
    private fun settle(id: String) {
        if (inFlight > 0) inFlight--
        if (focusIds.remove(id) && focusIds.isEmpty()) {
            AudioFocus.release()
        }
        if (inFlight <= 0) {
            inFlight = 0
            val cb = onQuiet
            onQuiet = null
            cb?.invoke()
        }
    }

    private val progress = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String) = Unit
        override fun onDone(utteranceId: String) = settle(utteranceId)
        override fun onError(utteranceId: String) = settle(utteranceId)
        override fun onError(utteranceId: String, errorCode: Int) = settle(utteranceId)
    }

    fun shutdown() {
        tts?.stop()
        tts?.shutdown()
        tts = null
        ready = false
        pending.clear()
        inFlight = 0
        focusIds.clear()
        onQuiet = null
        AudioFocus.release()
    }

    /**
     * The best free Google voice for narration: a natural en-US voice, not the
     * robotic default. Natural voices are Google's network-tier ones (quality
     * `VERY_HIGH`); prefer one, else the best installed local voice. Sorting by
     * quality means the default (`NORMAL`/`LOW`) only ever speaks when nothing
     * else is installed.
     */
    private fun pickVoice(tts: TextToSpeech): Voice? {
        val voices = tts.voices ?: return null
        val english = voices.filter { it.locale.language.equals("en", true) }
        val us = english.filter { it.locale.country.equals("US", true) }.ifEmpty { english }
        val natural = us.filter { it.isNetworkConnectionRequired || it.quality >= Voice.QUALITY_VERY_HIGH }
        return (natural.ifEmpty { us }).maxByOrNull { it.quality }
    }
}
