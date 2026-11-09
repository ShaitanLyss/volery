package com.volery.phone

import android.os.Handler
import android.os.Looper

/**
 * One place the service writes and the screen reads. The node lives in the
 * foreground service (and, on the Rust side, in a process-wide slot), so it
 * outlives the activity; the screen is just a view over this. A single
 * observer, re-posted on the main thread.
 */
object NodeState {
    @Volatile var working = false
    @Volatile var result: String? = null
    @Volatile var error: String? = null

    private val main = Handler(Looper.getMainLooper())
    @Volatile private var observer: (() -> Unit)? = null

    fun observe(fn: () -> Unit) {
        observer = fn
        main.post(fn)
    }

    fun clear() {
        observer = null
    }

    fun update(working: Boolean, result: String?, error: String?) {
        this.working = working
        this.result = result
        this.error = error
        main.post { observer?.invoke() }
    }
}
