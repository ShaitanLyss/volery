package com.volery.phone

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * What a wall is waiting on a person for, drawn: an agent's question, a question
 * filed while nobody was there, a delete, a close, a pull request or any other
 * confirmation, and a notice. The rows come from `phone-node`'s prompt reader
 * and carry the exact wire id an answer names, so a tap here is a click in that
 * wall's own dock.
 *
 * **This is the half that works without sound.** Nia walks with earbuds and the
 * narration loop reads a question out; this is what she reads when the words
 * were not enough, when the phone is on a desk, or when a question was missed.
 * Every prompt's `what led to this` pulls the prose that preceded it on demand
 * — never a transcript, and never a poll.
 */
private const val CAUTION = "answering this starts work on the wall"

/** How long a prompt has waited. The reader computed this on *this* phone's
 *  clock from the wall's own two moments, so nothing here compares clocks. */
fun waitedWords(ms: Long): String = when {
    ms < 60_000 -> "just now"
    ms < 3_600_000 -> "${ms / 60_000}m"
    ms < 86_400_000 -> "${ms / 3_600_000}h ${(ms % 3_600_000) / 60_000}m"
    else -> "${ms / 86_400_000}d"
}

/** The prose that led to a prompt, kept **by prompt**, not by card.
 *
 *  The paragraph before a parked question does not change while it is parked,
 *  which is what makes one read enough. It is not the same paragraph for two
 *  questions on one card, though: keying this by card showed the second
 *  prompt's context as whatever preceded the first. The key is the prompt's
 *  wire id for that reason.
 *
 *  A read that is abandoned (the card is left, the row is scrolled away, the
 *  process is closing) clears its marker rather than leaving "reading" for
 *  ever: the next open asks again. */
internal object Reading {
    private val lines = mutableStateMapOf<String, List<Prose>>()
    private val note = mutableStateMapOf<String, String>()

    fun of(key: String): List<Prose>? = lines[key]
    fun state(key: String): String? = note[key]
    fun forget(key: String) {
        lines.remove(key)
        note.remove(key)
    }

    suspend fun load(host: String, card: String, key: String) {
        if (note[key] == "reading") return
        if (lines.containsKey(key)) return
        note[key] = "reading"
        try {
            val result = withContext(Dispatchers.IO) { NativeBridge.proseOf(host, card) }
            when (result) {
                is NativeBridge.Envelope.Ok -> {
                    lines[key] = parseProse(result.payload)
                    note[key] = "done"
                }
                is NativeBridge.Envelope.Error -> note[key] = result.message
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            note.remove(key)
            throw e
        }
    }
}

/* ── the roster's section ───────────────────────────────────────────────── */

/**
 * The head of the roster: what is waiting on you, one row a tap can answer.
 *
 * It stands above the cards because it is the reason to open the app. Only the
 * blocking things are drawn here — a question, a delete, a close, a
 * confirmation — and each one that has a single question with options can be
 * answered without opening its card at all. Anything larger says so and opens
 * the card, where the whole sheet is drawn.
 */
@Composable
fun WaitingOnRoster(
    prompts: List<PromptRow>,
    isSent: (String) -> Boolean,
    onPicks: (PromptRow, List<String>) -> Unit,
    onAck: (PromptRow) -> Unit,
    onOpen: (String) -> Unit,
) {
    val blocking = prompts.filter { it.blocking }
    if (blocking.isEmpty()) return
    val p = LocalPalette.current
    val shown = blocking.take(ROSTER_WAITING_SHOWN)
    /* A row already answered and waiting for the wall to take it is not still
       waiting on a person, so the count is of what is left to decide. */
    val waiting = blocking.count { !isSent(it.answers) }
    Column(Modifier.fillMaxWidth()) {
        GroupLabel("waiting on you", waiting, Modifier.padding(top = 8.dp, bottom = 4.dp))
        shown.forEach { prompt ->
            RosterPrompt(
                prompt = prompt,
                sent = isSent(prompt.answers),
                onPicks = onPicks,
                onAck = onAck,
                onOpen = { onOpen(prompt.card) },
            )
        }
        if (blocking.size > shown.size) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 10.dp, vertical = 3.dp)
                    .then(
                        pressable(
                            onClick = { onOpen(shown.first().card) },
                            shape = RoundedCornerShape(13.dp),
                            tint = p.surface.copy(alpha = 0.35f),
                        ),
                    ),
            ) {
                Text(
                    "and ${blocking.size - shown.size} more — open a card",
                    style = Type.note(p),
                    modifier = Modifier.padding(horizontal = 13.dp, vertical = 11.dp),
                )
            }
        }
    }
}

private const val ROSTER_WAITING_SHOWN = 3

/** One waiting prompt on the roster: the kind, whose card, how long, and — when
 *  it is a single question with options — the options themselves. */
@Composable
private fun RosterPrompt(
    prompt: PromptRow,
    sent: Boolean,
    onPicks: (PromptRow, List<String>) -> Unit,
    onAck: (PromptRow) -> Unit,
    onOpen: () -> Unit,
) {
    val p = LocalPalette.current
    val shape = RoundedCornerShape(15.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 3.dp)
            .clip(shape)
            .background(p.ask.copy(alpha = 0.10f))
            .border(1.dp, p.ask.copy(alpha = if (sent) 0.14f else 0.28f), shape)
            .padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            StatusDot(DotKind.Ask, breathing = false)
            Spacer(Modifier.width(9.dp))
            Text(
                prompt.kind,
                style = Type.group(p, p.ask).copy(letterSpacing = 0.4.sp),
            )
            Spacer(Modifier.width(10.dp))
            /* Weighted and right-aligned rather than pushed by a spacer: a
               long card title with an unweighted tail ran straight into the
               kind word ("left for youN-140..."). */
            Text(
                if (sent) "sent · waiting for the wall" else "${prompt.title} · ${waitedWords(prompt.waitedMs)}",
                style = Type.meta(p, p.note, 11.5f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                textAlign = androidx.compose.ui.text.style.TextAlign.End,
                modifier = Modifier.weight(1f),
            )
        }
        Spacer(Modifier.height(7.dp))
        Text(
            prompt.headline,
            style = Type.label(p, p.paper, 14.5f),
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
        if (sent) return@Column

        val single = prompt.questions.singleOrNull()
        when {
            single != null && single.options.isNotEmpty() -> {
                Spacer(Modifier.height(9.dp))
                single.options.take(3).forEach { option ->
                    ChoiceRow(option) { onPicks(prompt, listOf(option.label)) }
                }
            }
            prompt.ack.isNotEmpty() -> {
                Spacer(Modifier.height(9.dp))
                ActionButton("acknowledge", onClick = { onAck(prompt) }, height = 42.dp)
            }
            else -> {
                Spacer(Modifier.height(9.dp))
                ActionButton(
                    if (prompt.questions.size > 1) "answer ${prompt.questions.size} questions" else "read it",
                    onClick = onOpen,
                    height = 42.dp,
                )
            }
        }
        if (single != null && single.options.isNotEmpty()) {
            Spacer(Modifier.height(6.dp))
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(9.dp))
                    .then(pressable(onOpen, RoundedCornerShape(9.dp), tint = p.surface.copy(alpha = 0.30f)))
                    .padding(horizontal = 6.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "or open the card to read it in full",
                    style = Type.meta(p, p.note, 11.5f),
                    modifier = Modifier.weight(1f),
                )
                Icon(Glyph.ChevronRight, tint = p.paperFaint, size = 13.dp)
            }
        }
    }
}

/* ── a card's own page ──────────────────────────────────────────────────── */

/** Every prompt belonging to one card, drawn in full: each question's words,
 *  its options, a field for the ones answered with a sentence, and the prose
 *  that led to it on request. */
@Composable
fun PromptsOnCard(
    card: String,
    prompts: List<PromptRow>,
    isSent: (String) -> Boolean,
    onPicks: (PromptRow, List<String>) -> Unit,
    onAck: (PromptRow) -> Unit,
) {
    val mine = prompts.filter { it.card == card }
    if (mine.isEmpty()) return
    Column(Modifier.fillMaxWidth()) {
        mine.forEach { prompt ->
            PromptSheet(
                prompt = prompt,
                sent = isSent(prompt.answers),
                onPicks = onPicks,
                onAck = onAck,
            )
            Spacer(Modifier.height(12.dp))
        }
    }
}

@Composable
private fun PromptSheet(
    prompt: PromptRow,
    sent: Boolean,
    onPicks: (PromptRow, List<String>) -> Unit,
    onAck: (PromptRow) -> Unit,
) {
    val p = LocalPalette.current
    val shape = RoundedCornerShape(16.dp)
    /* One slot per question: a picked label, or a typed sentence. Keyed on the
       ask id, so a digest arriving while the sheet is being read does not throw
       an answer away — the same rule the desktop's dock holds. */
    val picks = remember(prompt.answers) { mutableStateMapOf<Int, String>() }
    val typed = remember(prompt.answers) { mutableStateMapOf<Int, String>() }
    var context by remember(prompt.answers) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(p.ask.copy(alpha = 0.09f))
            .border(1.dp, p.ask.copy(alpha = if (sent) 0.14f else 0.28f), shape)
            .padding(horizontal = 15.dp, vertical = 13.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            StatusDot(DotKind.Ask, breathing = false)
            Spacer(Modifier.width(9.dp))
            Text(prompt.kind, style = Type.group(p, p.ask).copy(letterSpacing = 0.4.sp))
            Spacer(Modifier.weight(1f))
            Text(waitedWords(prompt.waitedMs), style = Type.meta(p, p.note, 11.5f))
        }
        Spacer(Modifier.height(8.dp))
        if (sent) {
            Text(
                "sent — waiting for the wall to take it. it goes away when it does.",
                style = Type.note(p),
            )
            return@Column
        }
        prompt.questions.forEachIndexed { i, q ->
            if (i > 0) Spacer(Modifier.height(14.dp))
            if (q.header.isNotEmpty()) {
                Text(q.header, style = Type.label(p, p.paper, 15f))
                Spacer(Modifier.height(3.dp))
            }
            Text(q.body, style = Type.prose(p), modifier = Modifier.fillMaxWidth())
            if (q.shows) {
                Spacer(Modifier.height(5.dp))
                Text(
                    "a design or a file is attached to this question — open the card on the wall to see it.",
                    style = Type.meta(p, p.ask, 11.5f),
                )
            }
            val single = prompt.questions.size == 1
            if (q.options.isNotEmpty()) {
                Spacer(Modifier.height(9.dp))
                q.options.forEach { option ->
                    ChoiceRow(option, chosen = picks[i] == option.label) {
                        picks[i] = option.label
                        if (single) onPicks(prompt, listOf(option.label))
                    }
                }
            } else {
                Spacer(Modifier.height(9.dp))
                QuietField(
                    value = typed[i].orEmpty(),
                    onValueChange = { typed[i] = it },
                    label = "your answer",
                )
            }
        }

        if (prompt.questions.size > 1) {
            val ready = prompt.questions.indices.all { i ->
                val q = prompt.questions[i]
                if (q.options.isNotEmpty()) picks[i] != null else typed[i]?.isNotBlank() == true
            }
            Spacer(Modifier.height(12.dp))
            ActionButton(
                "send ${prompt.questions.size} answers",
                onClick = {
                    /* Nothing is sent until every question has an answer. A
                       half-filled sheet would carry `skipped` for the rest,
                       and a skip is not permission. */
                    if (!ready) return@ActionButton
                    val list = prompt.questions.indices.map { i ->
                        picks[i] ?: typed[i].orEmpty()
                    }
                    onPicks(prompt, list)
                },
                primary = ready,
                modifier = Modifier.fillMaxWidth(),
            )
            if (!ready) {
                Spacer(Modifier.height(5.dp))
                Text("answer every question to send them together.", style = Type.meta(p, p.note, 11f))
            }
        } else if (prompt.questions.singleOrNull()?.options.isNullOrEmpty()) {
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (prompt.ack.isNotEmpty()) {
                    ActionButton("acknowledge", onClick = { onAck(prompt) }, height = 44.dp)
                }
                val said = typed[0].orEmpty().trim()
                ActionButton(
                    "send it",
                    onClick = { if (said.isNotEmpty()) onPicks(prompt, listOf(said)) },
                    primary = said.isNotEmpty(),
                    height = 44.dp,
                )
            }
        }

        if (prompt.startsWork) {
            Spacer(Modifier.height(9.dp))
            Text(
                if (prompt.ack.isNotEmpty() && !prompt.pickable) {
                    "acknowledging takes it down without a word; replying starts work on the wall"
                } else {
                    CAUTION
                },
                style = Type.meta(p, p.note, 11f),
            )
        }
        Spacer(Modifier.height(10.dp))
        Hair()
        ContextLink(
            key = prompt.answers,
            expanded = context,
            onToggle = { open ->
                context = open
                if (open) scope.launch { Reading.load(prompt.host, prompt.card, prompt.answers) }
            },
        )
        if (context) ContextLines(prompt.answers)
    }
}

/** One option: its label, and the cost or the risk under it. Pressing it is the
 *  answer — there is no separate send for a pick. */
@Composable
private fun ChoiceRow(option: PromptChoice, chosen: Boolean = false, onPick: () -> Unit) {
    val p = LocalPalette.current
    val shape = RoundedCornerShape(12.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 3.dp)
            .clip(shape)
            .background(if (chosen) p.paper.copy(alpha = 0.10f) else p.surface.copy(alpha = 0.55f))
            .border(1.dp, if (chosen) p.ask.copy(alpha = 0.55f) else p.hair, shape)
            .then(pressable(onPick, shape, tint = p.surface.copy(alpha = 0.65f)))
            .padding(horizontal = 13.dp, vertical = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (chosen) {
                Icon(Glyph.Check, tint = p.ask, size = 14.dp)
                Spacer(Modifier.width(7.dp))
            }
            Text(option.label, style = Type.label(p, p.paper, 14.5f), modifier = Modifier.weight(1f))
        }
        if (option.detail.isNotEmpty()) {
            Spacer(Modifier.height(2.dp))
            Text(option.detail, style = Type.meta(p, p.note, 11.5f))
        }
    }
}

/* ── what led to this ───────────────────────────────────────────────────── */

@Composable
private fun ContextLink(key: String, expanded: Boolean, onToggle: (Boolean) -> Unit) {
    val p = LocalPalette.current
    Row(
        Modifier
            .fillMaxWidth()
            .then(
                pressable(
                    onClick = { onToggle(!expanded) },
                    shape = RoundedCornerShape(10.dp),
                    tint = p.surface.copy(alpha = 0.40f),
                ),
            )
            .padding(horizontal = 4.dp, vertical = 9.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        /* A disclosure triangle: one glyph turned, so the control says which
           way the words will go rather than pointing back at the page. */
        Icon(
            Glyph.ChevronRight,
            tint = p.paperFaint,
            size = 14.dp,
            modifier = Modifier.graphicsLayer { rotationZ = if (expanded) 90f else 0f },
        )
        Spacer(Modifier.width(8.dp))
        Text(
            if (expanded) "hide what led to this" else "what led to this",
            style = Type.label(p, p.paperDim, 13f),
            modifier = Modifier.weight(1f),
        )
        if (Reading.state(key) == "reading") Text("reading…", style = Type.meta(p, p.note, 11f))
    }
}

/** The prose before the question: the person's own lines and the agent's, and
 *  nothing else. Tool calls and replies' arguments never crossed the wire. */
@Composable
private fun ContextLines(key: String) {
    val p = LocalPalette.current
    val said = Reading.of(key)
    val state = Reading.state(key)
    Column(Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, bottom = 4.dp)) {
        when {
            state == "reading" || (state == null && said == null) ->
                Text("asking the wall for it…", style = Type.note(p))
            said == null ->
                Text(state ?: "the wall did not answer", style = Type.meta(p, p.fail, 11.5f))
            said.isEmpty() ->
                Text("nothing readable came before it.", style = Type.note(p))
            else -> said.forEachIndexed { i, line ->
                if (i > 0) Spacer(Modifier.height(8.dp))
                Row(Modifier.fillMaxWidth()) {
                    Text(
                        if (line.you) "you" else "claude",
                        style = Type.group(p, if (line.you) p.paperDim else p.work).copy(fontSize = 10.sp),
                        modifier = Modifier.width(46.dp).padding(top = 3.dp),
                    )
                    Text(
                        line.text,
                        style = if (line.you) Type.label(p, p.paperDim, 13f) else Type.prose(p).copy(fontSize = 13.5.sp),
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}
