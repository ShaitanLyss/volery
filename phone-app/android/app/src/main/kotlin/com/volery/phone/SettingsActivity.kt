package com.volery.phone

import android.app.Activity
import android.os.Bundle

/**
 * A stub, deliberately. The walking modes (push-to-talk, "hey volery",
 * seamless), the chatty level, and duck-vs-pause land here in a later
 * milestone — the plan reserves this screen, and v1 ships nothing to put on it
 * yet.
 */
class SettingsActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)
    }
}
