package com.volery.phone

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
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
internal data class NarrationTurn(
    val lines: List<NarrationLine>,
    val curr: String,
    val needsYou: Boolean,
    /** The wall that published this digest. A question spoken from it is
     *  answered there, even if the walk has moved on by the time somebody
     *  speaks. */
    val host: String,
)

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
        val sighting = parseSighting(payload)
        landed(sighting, settles = false)
        val cards = payload.optJSONObject("cards") ?: return@withContext null
        val curr = cards.toString()
        val published = sighting.cards?.host?.ifEmpty { sighting.host } ?: sighting.host
        /* The walk above ran whatever the voice setting is, because it is also
           how the phone moves to a wall that is up. `off` only stops the
           speaking: no lines, and no question opening the ears unspoken. The
           baseline still advances, so turning the voice back on does not read
           out everything that happened while it was quiet. */
        if (chatty == "off") {
            return@withContext NarrationTurn(lines = emptyList(), curr = curr, needsYou = false, host = published)
        }
        val n = when (val narr = NativeBridge.parse(NativeBridge.narrate(prev.orEmpty(), curr, chatty))) {
            is NativeBridge.Envelope.Error -> return@withContext null
            is NativeBridge.Envelope.Ok -> parseNarration(narr.payload)
        }
        NarrationTurn(lines = n.lines, curr = curr, needsYou = n.needsYou, host = published)
    }

/* ── the loop, owned by the service ─────────────────────────────────────── */

/**
 * The phone's ear and mouth, polled for as long as the process is on the
 * flyway.
 *
 * **It lives here rather than on a screen, and that was the bug.** It used to
 * be a `LaunchedEffect` gated on `repeatOnLifecycle(RESUMED)` in `MainActivity`,
 * so the whole hands-free story stopped the moment the phone went in a pocket:
 * the screen off is the activity stopped, the coroutine cancelled, and no
 * digest was read until somebody opened the app — while the foreground service
 * beside it kept the process alive and read nothing. A question parked at the
 * wall was simply never spoken, and the only fix that makes the mode mean what
 * it says is for the loop to belong to the thing that outlives every screen.
 *
 * One instance, started when the node comes up and stopped with the service.
 * Every setting is read per tick rather than captured, so turning the voice on
 * or off, or moving to seamless, takes effect on the next poll.
 */
class Narrator private constructor(private val app: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null

    /** Start the loop if it is not already running. Idempotent: every path that
     *  brings the node up calls it, and the second call does nothing. Declared
     *  synchronized because it is called from the service's single-thread
     *  executor and from the main thread (a permission promotion), and a check
     *  and a launch that can interleave are two loops whose speech doubles. */
    @Synchronized
    fun ensure() {
        if (job?.isActive == true) return
        job = scope.launch {
            Log.i(TAG, "narration loop started")
            while (isActive) {
                try {
                    once()
                } catch (e: Exception) {
                    /* A poll that throws must not end the loop: the phone would
                       go quiet for good on one bad digest. */
                    Log.w(TAG, "a poll threw", e)
                }
                delay(NARRATION_CADENCE_MS)
            }
        }
    }

    /** Stop polling without killing the scope, so a service Android recreated
     *  can start the loop again. Nothing here outlives the process. */
    @Synchronized
    fun stop() {
        job?.cancel()
        job = null
    }

    /** One poll, folded against the persisted digest and spoken. */
    private suspend fun once() {
        val prev = withContext(Dispatchers.IO) { NarrationStore.load(app) }
        val turn = sightAndNarrate(Config.host, Config.walkJson(), prev, Config.chatty) ?: return
        /* One line a poll, which is what tells a support session whether the
           loop is alive with the screen off. */
        Log.d(TAG, "poll: ${turn.lines.size} line(s), needsYou=${turn.needsYou}")
        if (turn.lines.isNotEmpty()) {
            Log.i(TAG, "spoke ${turn.lines.size} line(s): ${turn.lines.joinToString(" · ") { it.text }}")
        }
        withContext(Dispatchers.Main) {
            /* **On the main thread, not merely before the speak.** The engine
               assigns itself to its field before its `onInit` can fire only
               when it is constructed on the thread that callback is delivered
               to. Built on the IO dispatcher, `onInit` can run before the field
               is published, `handleInit` returns early, and every line queues
               in `pending` for the life of the process. It is initialised on
               the first poll that will use it rather than at launch, so a phone
               set to say nothing never binds one. */
            if (Config.chatty != "off") Speaker.init(app)
            for (line in turn.lines) {
                /* A question with a parked id arms the answer *before* it is
                   spoken, so the seamless window that follows knows the next
                   transcript is the answer rather than a command. */
                if (line.kind == "ask" && line.askId != null) {
                    Listening.of(app).steer.armQuestion(turn.host, line.card, line.askId)
                }
                Speaker.speak(line.text, needsFocus = turn.needsYou)
            }
        }
        withContext(Dispatchers.IO) { NarrationStore.save(app, turn.curr) }
        if (turn.needsYou) {
            /* Listen only after the words are out of the air, so the ears do
               not hear the phone's own voice as an answer. */
            withContext(Dispatchers.Main) {
                val listen = {
                    if (Config.mode == "seamless") {
                        val voice = Listening.of(app).voice
                        if (voice.hasMic()) voice.startSeamless() else voice.fail("the ears need the microphone")
                    }
                }
                if (Speaker.isSpeaking()) Speaker.onQuiet = listen else listen()
            }
        }
    }

    companion object {
        private const val TAG = "PhoneNarration"

        @Volatile
        private var shared: Narrator? = null

        fun of(context: Context): Narrator = synchronized(this) {
            shared ?: Narrator(context.applicationContext).also { shared = it }
        }
    }
}
