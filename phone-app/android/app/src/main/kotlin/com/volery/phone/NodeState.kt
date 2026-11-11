package com.volery.phone

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * One place the service writes and the screens read, as Compose state rather
 * than the observer callback it was. The node lives in the foreground service
 * (and, on the Rust side, in a process-wide slot), so it outlives any
 * activity; the home screen is a view over this. Writes arrive from the
 * service's background thread — snapshot state is thread-safe, so the setter
 * needs no handler hop.
 */
object NodeState {
    var working by mutableStateOf(false)
    var sighting by mutableStateOf<Sighting?>(null)
    var error by mutableStateOf<String?>(null)

    /** Everything the wall being read is waiting on a person for, newest
     *  digest first. Composed from the same snapshot the page draws, so a
     *  question, a delete or a pull request is one row a tap answers. */
    var prompts by mutableStateOf<List<PromptRow>>(emptyList())
        private set

    /** Debug builds only: a seeded set of prompts stands in for what a wall
     *  would publish, so the surfaces can be photographed and driven without a
     *  card parked on the flyway. A poll does not overwrite it while it stands;
     *  nothing in the app reaches this. */
    private var pinned by mutableStateOf(false)

    fun seedForPreview(rows: List<PromptRow>) {
        pinned = true
        prompts = rows
    }

    fun update(working: Boolean, sighting: Sighting?, error: String?) {
        this.working = working
        this.sighting = sighting
        this.error = error
    }

    /** A sighting landed. A poll passes `settle = false`: it must update what
     *  the page draws without clearing a dial's working indicator, which
     *  belongs to the dial that set it. */
    fun landed(sighting: Sighting, settle: Boolean) {
        this.sighting = sighting
        error = null
        if (!pinned) prompts = sighting.cards?.let { NativeBridge.promptsOf(it.json) } ?: emptyList()
        if (settle) working = false
    }
}
