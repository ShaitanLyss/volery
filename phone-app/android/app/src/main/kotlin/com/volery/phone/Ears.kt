package com.volery.phone

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp

/**
 * The ears and the mouth as one object a screen can hold: a [VoiceController]
 * (the recogniser), a [Steer] (what a settled sentence becomes), and the two
 * surfaces they need — the keyboard for a sentence typed instead of spoken,
 * and the gate for a plan that must be confirmed before it moves.
 *
 * Every screen that carries the rail carries this too, because the rail is not
 * chrome: it is the only way to say anything to the wall from this phone. A
 * screen that draws a rail without it would be an ornament.
 */
class Ears(val voice: VoiceController, val steer: Steer)

/**
 * The one set of ears this process has.
 *
 * It used to be made per composition, which was right while every surface made
 * its own — a screen constructed one, disposed it leaving, and nothing else
 * existed. The narration loop now lives in the foreground service so it can
 * hear a question with the screen off, and two controllers would be two
 * `SpeechRecognizer` sessions fighting for one microphone: the service's ears
 * would close the moment a screen opened its own. So there is one, made with
 * the application context, owned by the process and shared by every surface
 * that draws the rail.
 */
object Listening {
    @Volatile
    private var shared: Ears? = null

    fun of(context: Context): Ears = synchronized(this) {
        shared ?: run {
            val voice = VoiceController(context.applicationContext)
            Ears(voice, Steer(voice)).also { shared = it }
        }
    }
}

@Composable
fun rememberEars(): Ears {
    val context = LocalContext.current.applicationContext
    return remember(context) { Listening.of(context) }
}

/**
 * The two things the ears can put in front of you: the sheet you type a
 * sentence into (the rail's keyboard), and the gate a plan raises. Hosts draw
 * this above their content and below nothing.
 */
@Composable
fun EarsOverlay(
    ears: Ears,
    typing: Boolean,
    onTyping: (Boolean) -> Unit,
) {
    val p = LocalPalette.current
    if (typing) {
        var draft by remember(typing) { mutableStateOf("") }
        val send = {
            val said = draft.trim()
            if (said.isNotEmpty()) ears.steer.handle(said)
            onTyping(false)
        }
        VolerySheet(title = "say something", onDismiss = { onTyping(false) }) {
            if (ears.steer.awaitingQuestion) {
                Text(
                    "the next sentence is sent as the answer to a question a card is holding.",
                    style = Type.note(p, p.note),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(10.dp))
            }
            QuietField(
                value = draft,
                onValueChange = { draft = it },
                label = if (ears.steer.awaitingQuestion) "the answer" else "a sentence for the wall",
                imeAction = ImeAction.Send,
                onDone = send,
            )
            Spacer(Modifier.height(14.dp))
            ActionButton(
                "send it",
                onClick = send,
                modifier = Modifier.fillMaxWidth(),
                primary = draft.isNotBlank(),
            )
            Spacer(Modifier.height(6.dp))
        }
    }
    val plan = ears.steer.pending
    if (plan != null) {
        ConfirmGate(
            plan = plan,
            host = Config.host,
            onYes = { ears.steer.confirmPending() },
            onNo = { ears.steer.dismissPending() },
        )
    }
}
