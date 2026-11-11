package com.volery.phone

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.FileNotFoundException

/**
 * The narration loop's one persisted piece: the previous wall digest, as the
 * `cards` JSON `sight` returns. `phone-ffi`'s `narrate` folds the next digest
 * against it, so a reopen hears only what changed since the phone last looked —
 * not a fresh baseline that would never mention the changes it missed, and not
 * a re-speak of everything. A plain file rather than SharedPreferences because
 * a digest snapshot is a blob, not a preference.
 */
object NarrationStore {
    private const val FILE = "narration-prev.json"

    fun load(context: Context): String? = try {
        context.openFileInput(FILE).bufferedReader().use { it.readText() }.ifEmpty { null }
    } catch (e: FileNotFoundException) {
        null
    } catch (e: Exception) {
        null // an unreadable store is "no baseline", not a crash
    }

    fun save(context: Context, json: String) {
        context.openFileOutput(FILE, Context.MODE_PRIVATE).bufferedWriter().use { it.write(json) }
    }
}

/** The poll's answer: the lines to speak (possibly none), the digest to
 *  persist as the new baseline, and whether anything needs Lyss right now.
 *  A plain finish at `needs`, for instance, is a real digest worth persisting
 *  even though it has nothing to say; `needsYou` is the flag that ducks music
 *  and (in seamless mode) opens the ears. Lines keep their `kind`, `card` and
 *  `askId`, so the loop can route an answer to a question. */
internal data class NarrationTurn(val lines: List<NarrationLine>, val curr: String, val needsYou: Boolean)

/** How often the loop re-sights the wall. A modest poll is the honest first
 *  cut: the node is dial-only, so there is no push stream to fold, and each
 *  sight is a full dial — fifteen seconds is reactive enough for a question to
 *  be heard walking, gentle enough to not wake the radio every heartbeat. */
internal const val NARRATION_CADENCE_MS = 15_000L

/** One poll: sight the wall, fold it against [prev] through the brain, and
 *  return what to say and what to persist. Null only when there is no digest
 *  to hold onto — the wall unreachable, no `cards` yet, or a fold that failed —
 *  so a reachable wall with nothing new still advances the baseline. */
internal suspend fun sightAndNarrate(
    host: String,
    remembered: String,
    prev: String?,
    chatty: String,
): NarrationTurn? =
    withContext(Dispatchers.IO) {
        /* `sightAny`, the same walk the launch dial makes: a poll is where a
           wall going off is felt first, and the loop must move to one that is
           up rather than fail every fifteen seconds until someone opens the
           settings screen. `landed` writes the wall that opened, so the loop's
           key changes and the next poll goes straight there. */
        val payload = when (val envelope = NativeBridge.walk(host, remembered)) {
            is NativeBridge.Envelope.Error -> return@withContext null
            is NativeBridge.Envelope.Ok -> envelope.payload
        }
        /* A poll refreshes the page but does not settle a dial's indicator:
           that one is the dial's to clear when its own walk returns. */
        landed(parseSighting(payload), settles = false)
        val cards = payload.optJSONObject("cards") ?: return@withContext null
        val curr = cards.toString()
        /* The walk above ran whatever the voice setting is, because it is also
           how the phone moves to a wall that is up. `off` only stops the
           speaking: no lines, and no question opening the ears unspoken. The
           baseline still advances, so turning the voice back on does not read
           out everything that happened while it was quiet. */
        if (chatty == "off") {
            return@withContext NarrationTurn(lines = emptyList(), curr = curr, needsYou = false)
        }
        val n = when (val narr = NativeBridge.parse(NativeBridge.narrate(prev.orEmpty(), curr, chatty))) {
            is NativeBridge.Envelope.Error -> return@withContext null
            is NativeBridge.Envelope.Ok -> parseNarration(narr.payload)
        }
        NarrationTurn(lines = n.lines, curr = curr, needsYou = n.needsYou)
    }
