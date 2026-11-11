package com.volery.phone

import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * The steer loop (docs/PHONE.md M5): a spoken sentence becomes a plan on the
 * wall, the plan's templated `reads` is spoken back, a yes confirms it, and
 * the wall carries it out — the phone never executes anything itself. A
 * question a card parked is spoken, and the next transcript is sent back down
 * the wall's own `Ask::answers` path. The wall's confirm gate and act verbs
 * are the safety line; this only hears, speaks and relays.
 *
 * Transcripts arrive from push-to-talk and from the seamless window alike, and
 * both funnel into [handle] through [VoiceController.onFinalTranscript]. The
 * blocking JNI calls run on one executor and hop back to the main thread,
 * where [Speaker] and the Compose state are happiest.
 */
/** How long an armed question may take a sentence as its answer. Longer than
 *  the seamless window it exists for, short enough that a command said later in
 *  the walk is a command. */
private const val ARM_WINDOW_MS = 60_000L

/** How long a sent answer is trusted before the row is offered again. A
 *  dial-only node cannot hear a refusal, so this is what stops a refused answer
 *  locking its row for the life of the process. */
private const val SENT_TRUST_MS = 45_000L

class Steer(private val voice: VoiceController) {
    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()

    /** A plan waiting for a yes. Its `id` is the phone's own — what `steward`
     *  handed back — and what `confirm` names. `steps` and `heard` exist for
     *  the gate to draw, never to send: confirmation carries the id alone and
     *  the wall runs the plan it already holds. */
    private var pendingPlan: PendingPlan? = null
    /** A question waiting for an answer, named by its card and its ask id. */
    private var pendingQuestion: PendingQuestion? = null

    var status by mutableStateOf("")
        private set

    /** The plan the gate is showing, so the sheet is a fold over state rather
     *  than a callback a screen can miss. Null means nothing is waiting. */
    var pending by mutableStateOf<PendingPlan?>(null)
        private set

    /** Whether the next transcript will be sent as a question's answer. The
     *  card screen offers "answer aloud" only when this is true; offering it
     *  otherwise would aim a sentence at the steward instead. */
    var awaitingQuestion by mutableStateOf(false)
        private set

    /** The prompts a tap or a sentence has already answered, by their wire id
     *  and the moment they were answered.
     *
     *  **Timed, not permanent**, because a dial-only node cannot hear the wall
     *  say no: a prompt's answer comes back by the wall dialling us, and this
     *  node accepts no dials. A refusal therefore looks exactly like an
     *  acceptance from here, and a mark that never expired would lock a row
     *  that is still in the digest out of ever being answered. After
     *  [`SENT_TRUST_MS`] the row is offered again; an accepted answer has left
     *  the digest by then and the mark is pruned. */
    var sent by mutableStateOf<Map<String, Long>>(emptyMap())
        private set

    fun isSent(answers: String, now: Long = System.currentTimeMillis()): Boolean {
        val at = sent[answers] ?: return false
        return now - at < SENT_TRUST_MS
    }

    init {
        voice.onFinalTranscript = { text -> handle(text) }
    }

    private data class PendingQuestion(
        /** The wall that published it, which is where the answer is dialled. */
        val host: String,
        val card: String,
        val askId: String,
        /** When the arm stops applying. A question spoken and put in a pocket
         *  must not swallow a command said an hour later. */
        val until: Long,
    )
    private var heard = ""

    /** One settled transcript. A yes/no when a plan is waiting; an answer when
     *  a question is; otherwise a new command. */
    fun handle(text: String) {
        val t = text.trim()
        if (t.isEmpty()) return
        val plan = pendingPlan
        if (plan != null) {
            when (answeredIn(t)) {
                "yes" -> confirm(plan)
                "no" -> {
                    pending = null
                    pendingPlan = null
                    status = "let go"
                    Speaker.speak("let go")
                }
                else -> run(t) // not a yes or no — a new command
            }
            return
        }
        val question = pendingQuestion
        if (question != null) {
            if (System.currentTimeMillis() <= question.until) {
                answerQuestion(question, t)
                return
            }
            /* Heard, not answered, and the window is long gone: this is a new
               sentence, not an answer to something said minutes ago. */
            pendingQuestion = null
            awaitingQuestion = false
        }
        run(t)
    }

    /** A question arrived in the digest; stand ready to send the next
     *  transcript as its answer. The line that called this already spoke the
     *  question itself. */
    fun armQuestion(host: String, card: String, askId: String) {
        pendingQuestion = PendingQuestion(host, card, askId, System.currentTimeMillis() + ARM_WINDOW_MS)
        awaitingQuestion = true
    }

    /** The gate's yes. The sheet's button and a spoken "yes" are the same
     *  call: one confirm, carrying the plan's id and nothing else. */
    fun confirmPending() {
        pendingPlan?.let { confirm(it) }
    }

    /** The gate's "no, never mind". Silent, because the person is looking at
     *  it; the spoken no speaks, because they may not be. */
    fun dismissPending() {
        if (pendingPlan == null) return
        pendingPlan = null
        pending = null
        status = "let go"
    }

    /**
     * Debug builds only: stand a representative plan in front of the gate, so
     * its layout can be photographed (or a lab can drive it) without a wall
     * that answers `Steward` — a wall running a build from before the steward
     * crossed the flyway drops the request, and the phone can only say so.
     *
     * There is no UI path to this and it cannot exist in a release: the one
     * caller is guarded by `BuildConfig.DEBUG` *and* an explicit intent extra,
     * the same shape as the desktop's `VOLERY_CRASH_SELF`. It confirms nothing
     * — the id it carries is a preview's, and pressing yes would ask a wall to
     * carry a plan that wall never made.
     */
    fun seedForPreview(plan: PendingPlan) {
        if (pending != null) return
        pendingPlan = plan
        pending = plan
        status = plan.reads
    }

    /** One command: hand the sentence to the wall's steward, off the main
     *  thread. */
    private fun run(text: String) {
        heard = text
        val host = Config.host
        status = "…"
        executor.execute {
            val result = call { NativeBridge.steward(host, text) }
            handler.post { onSteward(result, host, text) }
        }
    }

    /** The steward could not place the sentence as a Volery command, so the
     *  wall's DeepSeek balance answers it. This is the weather, the capital of
     *  Peru, a definition: not work a card should be paid for, and not
     *  something the phone can answer itself.
     *
     *  The wall is the one holding the key (`provider::answer_question`), so
     *  this is one more exchange over the flyway and no secret on the phone. */
    private fun answerGenerally(host: String, text: String) {
        status = "…"
        executor.execute {
            val result = NativeBridge.generalOf(host, text)
            handler.post {
                when (result) {
                    is NativeBridge.Envelope.Error -> {
                        /* A wall from before this word passes the frame over
                           and says nothing; "it did not answer" is true but
                           reads as a fault. Say the old line instead. */
                        val line = if (result.message.contains("did not answer")) "not understood" else result.message
                        status = line
                        Speaker.speak(line)
                    }
                    is NativeBridge.Envelope.Ok -> {
                        val said = result.payload.optString("text").trim()
                        if (said.isEmpty()) {
                            status = "nothing came back"
                            Speaker.speak("nothing came back")
                        } else {
                            status = said
                            Speaker.speak(said, needsFocus = true)
                        }
                    }
                }
            }
        }
    }

    /** A call into the bridge that cannot take the process down with it.
     *
     *  `libphone_ffi.so` is a checked-in artifact, and one built before the
     *  Kotlin that calls it answers `UnsatisfiedLinkError` — on an executor
     *  thread, where nothing catches it and the whole app disappears. That is
     *  what a stale `.so` looks like from the outside: you say a sentence and
     *  the phone is back on the home screen with no message anywhere. So the
     *  call is caught and reported as the failure it is. */
    private fun call(block: () -> String?): NativeBridge.Envelope = try {
        NativeBridge.parse(block())
    } catch (t: Throwable) {
        Log.w("PhoneSteer", "the bridge refused a call", t)
        NativeBridge.Envelope.Error("the phone's bridge is out of date — rebuild libphone_ffi.so")
    }

    /** Confirm a plan and let the wall carry it out. The phone sends only the
     *  id — it never sends the steps back. */
    private fun confirm(plan: PendingPlan) {
        pending = null
        pendingPlan = null
        status = "…"
        executor.execute {
            val result = call { NativeBridge.confirm(Config.host, plan.id) }
            handler.post { onConfirm(result) }
        }
    }

    /** A prompt answered by a tap rather than by ear. `answers` is the wire id
     *  the reader composed (`prompts.rs`): a parked ask, a notice behind
     *  `notice:`, or a pile row behind `deferred:`. The wall hands it to the
     *  same channel a click in its own dock uses, so there is nothing different
     *  about the answer because it came from a phone.
     *
     *  A spoken question waiting on the same ask is let go of: the person
     *  answered it, and leaving the ears armed would send the next unrelated
     *  sentence into a question that is already decided. */
    fun answerPrompt(host: String, card: String, answers: String, text: String) {
        val said = text.trim()
        if (said.isEmpty() || host.isEmpty()) return
        val held = pendingQuestion
        if (held != null && held.card == card && held.askId == answers) {
            pendingQuestion = null
            awaitingQuestion = false
        }
        status = "…"
        markSent(answers)
        executor.execute {
            val result = call { NativeBridge.answer(host, card, answers, said) }
            handler.post {
                when (result) {
                    is NativeBridge.Envelope.Error -> {
                        /* Only this id, never a snapshot: another answer may
                           have been marked while this one was in flight. */
                        sent = sent - answers
                        status = result.message
                        Speaker.speak(result.message)
                    }
                    is NativeBridge.Envelope.Ok -> status = "sent"
                }
            }
        }
    }

    /** A prompt's reply, composed from a sheet of picks by the bridge — one
     *  question bare, several numbered, exactly as an agent reads it. */
    fun answerPicks(prompt: PromptRow, picks: List<String>) {
        executor.execute {
            val composed = NativeBridge.composeOf(prompt.headers, picks)
            handler.post {
                when (composed) {
                    is NativeBridge.Envelope.Error -> {
                        status = composed.message
                        Speaker.speak(composed.message)
                    }
                    is NativeBridge.Envelope.Ok -> {
                        val text = composed.payload.optString("text")
                        if (text.isEmpty()) {
                            status = "nothing to send"
                        } else {
                            answerPrompt(prompt.host, prompt.card, prompt.answers, text)
                        }
                    }
                }
            }
        }
    }

    /** A spoken answer is a tap as far as the screens are concerned: the row
     *  it answered says it is on its way rather than offering a second one.
     *  Old marks are dropped here, so the map cannot grow with the session. */
    private fun markSent(answers: String) {
        val now = System.currentTimeMillis()
        val live = sent.filterValues { now - it < SENT_TRUST_MS }
        sent = if (live.size >= 32) live.toList().takeLast(31).toMap() + (answers to now) else live + (answers to now)
    }

    private fun answerQuestion(question: PendingQuestion, text: String) {
        pendingQuestion = null
        awaitingQuestion = false
        markSent(question.askId)
        status = "…"
        executor.execute {
            val result = call { NativeBridge.answer(question.host, question.card, question.askId, text) }
            handler.post {
                when (result) {
                    is NativeBridge.Envelope.Error -> {
                        sent = sent - question.askId
                        status = result.message
                        Speaker.speak(result.message)
                    }
                    is NativeBridge.Envelope.Ok -> status = "sent"
                }
            }
        }
    }

    private fun onSteward(envelope: NativeBridge.Envelope, host: String, asked: String) {
        when (envelope) {
            is NativeBridge.Envelope.Error -> {
                status = envelope.message
                Speaker.speak(envelope.message)
            }
            is NativeBridge.Envelope.Ok -> {
                val id = envelope.payload.optString("id")
                val answer = envelope.payload.optJSONObject("answer") ?: JSONObject()
                when (answer.optString("kind")) {
                    "plan" -> {
                        val plan = answer.optJSONObject("plan") ?: JSONObject()
                        val reads = plan.optString("reads")
                        val needs = plan.optString("needs")
                        if (reads.isEmpty()) {
                            status = "nothing to do"
                            Speaker.speak("nothing to do")
                        } else if (needs == "confirmation") {
                            val stepList = stepsOf(plan)
                            pendingPlan = PendingPlan(id, reads, stepList, heard)
                            pending = pendingPlan
                            status = reads
                            speakThenListen("$reads — yes?")
                        } else {
                            // A plan that only changes how you look still runs
                            // on the wall; the phone just does not ask first.
                            confirm(PendingPlan(id, reads, emptyList(), heard))
                        }
                    }
                    "ask" -> {
                        val question = answer.optString("question")
                        status = question
                        Speaker.speak(question)
                    }
                    /* Not a Volery command: a question, a sentence it could
                       not place, or a reply it calls unusable. The wall
                       answers it from DeepSeek, and the phone reads that
                       out. */
                    "question", "decline", "unusable", "not understood" -> answerGenerally(host, asked)
                    else -> answerGenerally(host, asked)
                }
            }
        }
    }

    private fun onConfirm(envelope: NativeBridge.Envelope) {
        when (envelope) {
            is NativeBridge.Envelope.Error -> {
                status = envelope.message
                Speaker.speak(envelope.message)
            }
            is NativeBridge.Envelope.Ok -> {
                when (envelope.payload.optString("kind")) {
                    // Success says nothing: the wall's next digest says what
                    // opened, and the narration loop reads it.
                    "done" -> status = "done"
                    else -> {
                        val why = envelope.payload.optString("why").ifEmpty { "did not happen" }
                        status = why
                        Speaker.speak("nothing happened — $why")
                    }
                }
            }
        }
    }

    /** Speak the confirmation line, and — in seamless mode — open the ears for
     *  a yes only once the words are out of the air, so the phone does not hear
     *  its own voice as the answer. Push-to-talk waits for the tap. */
    private fun speakThenListen(line: String) {
        Speaker.speak(line, needsFocus = true)
        if (Config.mode == "seamless" && voice.hasMic()) {
            if (Speaker.isSpeaking()) Speaker.onQuiet = { voice.startSeamless() } else voice.startSeamless()
        }
    }
}

/**
 * One step of a plan, as the gate draws it. `verb` is the op the wall declared
 * (`spawn`, `prompt`, `close`, …), `said` the short phrase the wall templated
 * for it, and `detail` a quiet summary of what it acts on.
 *
 * The steps exist here only so the gate can show the plan in order before
 * anything moves. Confirming sends the plan's id alone; the wall holds the
 * steps and runs them, so nothing the phone draws can alter what happens.
 */
data class PlanStep(val verb: String, val said: String, val detail: String)

/** The plan a gate is standing over: what the wall will do, in order, and the
 *  sentence it understood. */
data class PendingPlan(
    val id: String,
    val reads: String,
    val steps: List<PlanStep>,
    val heard: String,
)

/** The steps out of the steward's `answer.plan`, tolerated the way every read
 *  off the wire in this app is: a step with no op is skipped, a step with no
 *  `said` falls back to its op, and a plan the wall sent with no steps still
 *  reads as one line (`reads`) rather than as nothing. */
private fun stepsOf(plan: JSONObject): List<PlanStep> {
    val arr = plan.optJSONArray("steps") ?: return emptyList()
    return (0 until arr.length()).mapNotNull { i ->
        val s = arr.optJSONObject(i) ?: return@mapNotNull null
        val op = s.optString("op")
        if (op.isEmpty()) return@mapNotNull null
        PlanStep(
            verb = op,
            said = s.optString("said").ifEmpty { op },
            detail = detailOf(s.optJSONObject("args")),
        )
    }
}

/** What a step acts on, in the fewest words that are still true: the first
 *  three of the args that name a thing, each as `name value`, joined with a
 *  quiet dot. An array is joined the way the wall would say it. */
private fun detailOf(args: JSONObject?): String {
    if (args == null) return ""
    val wanted = listOf("project", "card", "cards", "path", "title", "subject", "file", "text", "minutes")
    val parts = wanted.mapNotNull { key ->
        if (!args.has(key) || args.isNull(key)) return@mapNotNull null
        val raw = args.opt(key)
        val value = when (raw) {
            is org.json.JSONArray -> (0 until raw.length()).mapNotNull { raw.opt(it)?.toString() }.joinToString(" and ")
            else -> raw?.toString() ?: return@mapNotNull null
        }.ifEmpty { return@mapNotNull null }
        "$key $value"
    }.take(3)
    return parts.joinToString(" · ").take(96)
}

/** A spoken yes or no, or null for anything that is neither — the desktop's
 *  `answeredIn`, ported so the phone decides the confirm locally (it is the
 *  thing that hears the yes, so it must know one). Exact and whole, as the
 *  desktop's is: "yes, and…" is not a yes. The no list is the more generous of
 *  the two, for the desktop's reason: a missed yes costs saying it again, a
 *  missed no leaves a plan armed. */
private fun answeredIn(text: String): String? {
    val said = text.trim().lowercase().replace(Regex("[.?!,]+$"), "").trim()
    if (said in YES) return "yes"
    if (said in NO) return "no"
    return null
}

private val YES = setOf(
    "yes", "yeah", "yep", "yup", "aye", "ok", "okay", "go ahead", "do it", "go on",
    "please do", "confirm", "sure",
    "oui", "ouais", "ouaip", "vas-y", "vas y", "allez", "allez-y", "allez y",
    "d'accord", "daccord", "confirme", "fais-le", "fais le", "c'est bon", "ça marche",
)

private val NO = setOf(
    "no", "nope", "nah", "cancel", "never mind", "nevermind", "forget it", "stop",
    "dont", "don't", "do not", "dismiss", "no thanks",
    "non", "annule", "annuler", "laisse tomber", "oublie", "oublie ça", "arrête",
    "arrete", "arrêt", "surtout pas", "non merci", "pas ça",
)
