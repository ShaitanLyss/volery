package com.volery.phone

import android.content.Context
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.util.Log

/**
 * The phone's one polite claim on the audio stack. Narration asks for focus the
 * moment it is about to speak and hands it back the moment the last word is
 * done, so the user's music lowers (or pauses) for the line and resumes
 * afterwards — the milestone's proof, on Android's own terms.
 *
 * Two gains, chosen by the `duck` vs `pause` setting:
 *  - `AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK` lowers music rather than stopping it;
 *  - `AUDIOFOCUS_GAIN_TRANSIENT` pauses it outright.
 * Both are transient: the system (not us) is what fades the music back in once
 * the focus is abandoned, so a release is all the resume this file owes.
 */
object AudioFocus {
    private const val TAG = "PhoneAudioFocus"

    private var manager: AudioManager? = null
    private var request: AudioFocusRequest? = null

    /** The one listener, kept on a field so the pre-O `abandonAudioFocus`
     *  overload can name it back. Nothing to do on change: a transient claim is
     *  short, and losing it means music is back — which is the point. */
    private val change = AudioManager.OnAudioFocusChangeListener { change ->
        Log.i(TAG, "focus change: $change")
    }

    /** Take transient focus for the next line. `pause` picks the gain: false
     *  (the default) ducks, true pauses. Returns whether the ask was granted,
     *  so the caller can log rather than assume music actually moved. */
    fun acquire(context: Context, pause: Boolean): Boolean {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        manager = am
        val gain = if (pause) AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
                   else AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
        return if (Build.VERSION.SDK_INT >= 26) {
            val r = AudioFocusRequest.Builder(gain)
                .setOnAudioFocusChangeListener(change)
                .build()
            request = r
            am.requestAudioFocus(r) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        } else {
            @Suppress("DEPRECATION")
            am.requestAudioFocus(change, AudioManager.STREAM_MUSIC, gain) ==
                AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        }
    }

    /** Hand the focus back, so music resumes. Idempotent — nothing held means
     *  nothing to do, and a second release after a first is harmless. */
    fun release() {
        val am = manager ?: return
        val r = request
        if (Build.VERSION.SDK_INT >= 26 && r != null) {
            am.abandonAudioFocusRequest(r)
        } else {
            @Suppress("DEPRECATION")
            am.abandonAudioFocus(change)
        }
        manager = null
        request = null
    }
}
