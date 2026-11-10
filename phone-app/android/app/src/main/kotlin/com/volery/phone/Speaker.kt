package com.volery.phone

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.Voice
import android.util.Log
import java.util.Locale

/**
 * The phone's mouth. One [TextToSpeech] for the whole process, initialised
 * lazily and once, and a voice chosen by [pickVoice] rather than left to the
 * robotic default. Lines the narration loop wants to say are queued until the
 * engine is ready, so a line can be spoken the moment the loop has one without
 * waiting on init. `speak` is called from the main thread (the loop resumes on
 * it after the blocking JNI calls), which is the thread [TextToSpeech] is
 * happiest on.
 */
object Speaker {
    private const val TAG = "PhoneSpeaker"

    private var tts: TextToSpeech? = null
    private var ready = false
    private val pending = ArrayDeque<String>()

    fun init(context: Context) {
        if (tts != null) return
        // The engine is assigned to the field before its onInit can fire, so
        // the callback reads the field (never a local still being initialised).
        tts = TextToSpeech(context.applicationContext) { status -> handleInit(status) }
    }

    fun speak(text: String) {
        if (text.isBlank()) return
        val t = tts
        if (!ready || t == null) {
            pending.addLast(text)
            return
        }
        t.speak(text, TextToSpeech.QUEUE_ADD, null, "n-${System.nanoTime()}")
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
        ready = true
        drain()
    }

    private fun drain() {
        val t = tts ?: return
        while (pending.isNotEmpty()) {
            t.speak(pending.removeFirst(), TextToSpeech.QUEUE_ADD, null, "n-${System.nanoTime()}")
        }
    }

    fun shutdown() {
        tts?.stop()
        tts?.shutdown()
        tts = null
        ready = false
        pending.clear()
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
