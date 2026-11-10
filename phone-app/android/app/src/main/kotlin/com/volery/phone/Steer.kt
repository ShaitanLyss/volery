package com.volery.phone

import android.os.Handler
import android.os.Looper
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
class Steer(private val voice: VoiceController) {
    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()

    /** A plan waiting for a yes. Its `id` is the phone's own — what `steward`
     *  handed back — and what `confirm` names. */
    private var pendingPlan: PendingPlan? = null
    /** A question waiting for an answer, named by its card and its ask id. */
    private var pendingQuestion: PendingQuestion? = null

    var status by mutableStateOf("")
        private set

    init {
        voice.onFinalTranscript = { text -> handle(text) }
    }

    private data class PendingPlan(val id: String, val reads: String)
    private data class PendingQuestion(val card: String, val askId: String)

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
            answerQuestion(question, t)
            return
        }
        run(t)
    }

    /** A question arrived in the digest; stand ready to send the next
     *  transcript as its answer. The line that called this already spoke the
     *  question itself. */
    fun armQuestion(card: String, askId: String) {
        pendingQuestion = PendingQuestion(card, askId)
    }

    /** One command: hand the sentence to the wall's steward, off the main
     *  thread. */
    private fun run(text: String) {
        status = "…"
        executor.execute {
            val result = NativeBridge.parse(NativeBridge.steward(Config.host, text))
            handler.post { onSteward(result) }
        }
    }

    /** Confirm a plan and let the wall carry it out. The phone sends only the
     *  id — it never sends the steps back. */
    private fun confirm(plan: PendingPlan) {
        pendingPlan = null
        status = "…"
        executor.execute {
            val result = NativeBridge.parse(NativeBridge.confirm(Config.host, plan.id))
            handler.post { onConfirm(result) }
        }
    }

    private fun answerQuestion(question: PendingQuestion, text: String) {
        pendingQuestion = null
        status = "…"
        executor.execute {
            val result = NativeBridge.parse(NativeBridge.answer(Config.host, question.card, question.askId, text))
            handler.post {
                when (result) {
                    is NativeBridge.Envelope.Error -> {
                        status = result.message
                        Speaker.speak(result.message)
                    }
                    is NativeBridge.Envelope.Ok -> status = "sent"
                }
            }
        }
    }

    private fun onSteward(envelope: NativeBridge.Envelope) {
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
                            pendingPlan = PendingPlan(id, reads)
                            status = reads
                            speakThenListen("$reads — yes?")
                        } else {
                            // A plan that only changes how you look still runs
                            // on the wall; the phone just does not ask first.
                            confirm(PendingPlan(id, reads))
                        }
                    }
                    "ask" -> {
                        val question = answer.optString("question")
                        status = question
                        Speaker.speak(question)
                    }
                    "question" -> {
                        val line = "that is a question rather than an instruction, and nothing here answers one yet"
                        status = line
                        Speaker.speak(line)
                    }
                    "decline", "unusable" -> {
                        val why = answer.optString("why").ifEmpty { "not understood" }
                        status = why
                        Speaker.speak(why)
                    }
                    else -> {
                        status = "not understood"
                        Speaker.speak("not understood")
                    }
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
