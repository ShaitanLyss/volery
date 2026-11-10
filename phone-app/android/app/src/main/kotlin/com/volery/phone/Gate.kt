package com.volery.phone

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The gate: the steward's plan, in order, before anything moves.
 *
 * This is the one sheet in the app that stands between a sentence and code
 * running on a wall, so it says three things and says them plainly. What the
 * phone **heard** (the transcript, in the book's face, with the wave still
 * moving so it is obviously a machine's reading rather than a quotation).
 * What the wall **decided** (the plan's steps, numbered, each with the verb the
 * wall will run). And that **nothing has happened yet** — a sentence, not an
 * icon alone, because the point of the gate is that a plan is a proposal.
 *
 * The two answers are the sheet's only controls, and the spoken one still
 * works: "yes" and the button call the same confirm. The phone never sends the
 * steps back; pressing yes confirms the plan's id and the wall runs what it
 * already holds.
 */
@Composable
fun ConfirmGate(
    plan: PendingPlan,
    host: String,
    onYes: () -> Unit,
    onNo: () -> Unit,
) {
    val p = LocalPalette.current
    VolerySheet(accent = p.ask, onDismiss = onNo) {
        Label("heard")
        Row(
            Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Wave(Modifier.padding(end = 14.dp))
            Text(
                "“${plan.heard.ifEmpty { plan.reads }}”",
                style = Type.prose(p).copy(
                    fontSize = Type.serifSize * 1.1f,
                    lineHeight = (Type.serifSize.value * 1.1f * 1.42f).sp,
                    color = p.paper,
                ),
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
            )
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Chip(p.work) { Text("$host · on the wall", style = Type.label(p, p.paperDim, 12f)) }
            Chip(null) { Text("judged by the steward", style = Type.label(p, p.paperDim, 12f)) }
        }

        Hair(Modifier.padding(top = 16.dp, bottom = 15.dp))

        val steps = plan.steps
        Label(if (steps.isEmpty()) "the plan" else "the plan · ${steps.size} ${if (steps.size == 1) "step" else "steps"}")
        if (steps.isEmpty()) {
            // A wall from a build that sends only `reads` still gets a gate:
            // the sentence it will carry out, in one line.
            Text(
                plan.reads,
                style = Type.label(p, p.paper, 15f),
                modifier = Modifier.padding(top = 10.dp),
            )
        } else {
            Column(Modifier.padding(top = 4.dp)) {
                steps.forEachIndexed { i, step ->
                    if (i > 0) Hair()
                    Step(i + 1, step)
                }
            }
        }

        Row(
            Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Glyph.Lock, tint = p.paperFaint, size = 14.dp)
            Spacer(Modifier.width(8.dp))
            Text("nothing has happened yet.", style = Type.note(p))
        }

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ActionButton(
                "no, never mind",
                onClick = onNo,
                modifier = Modifier.weight(1f),
                height = 56.dp,
            )
            ActionButton(
                "yes — do it",
                onClick = onYes,
                modifier = Modifier.weight(1.35f),
                primary = true,
                height = 56.dp,
                glyph = Glyph.Check,
            )
        }

        Row(
            Modifier.fillMaxWidth().padding(top = 13.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Glyph.Mic, tint = p.work, size = 15.dp)
            Spacer(Modifier.width(8.dp))
            Text("say “yes” — or press.", style = Type.note(p))
        }
    }
}

/** The sheet's own small label: heard, the plan. */
@Composable
private fun Label(text: String) {
    val p = LocalPalette.current
    Text(
        text,
        style = Type.group(p).copy(letterSpacing = 0.5.sp),
    )
}

/** A chip on the gate: the wall it will act on, who judged it. */
@Composable
private fun Chip(dot: Color?, content: @Composable () -> Unit) {
    val p = LocalPalette.current
    Row(
        Modifier
            .height(30.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(p.surface.copy(alpha = 0.55f))
            .border(1.dp, p.hair, RoundedCornerShape(999.dp))
            .padding(horizontal = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        if (dot != null) {
            Box(Modifier.size(5.dp).clip(CircleShape).background(dot))
        }
        content()
    }
}

/** One step: a numbered bead, what the wall will do in the words it chose, and
 *  the op it will run at the trailing edge, in mono. */
@Composable
private fun Step(number: Int, step: PlanStep) {
    val p = LocalPalette.current
    Column {
        Row(
            Modifier.fillMaxWidth().padding(vertical = 10.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Box(
                Modifier
                    .size(24.dp)
                    .clip(CircleShape)
                    .border(1.dp, p.edge, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text("$number", style = Type.mono(p, 11f, p.paperMute))
            }
            Spacer(Modifier.width(13.dp))
            Column(Modifier.weight(1f)) {
                Text(step.said, style = Type.label(p, p.paper, 15f))
                if (step.detail.isNotEmpty()) {
                    Spacer(Modifier.height(2.dp))
                    Text(step.detail, style = Type.note(p))
                }
            }
            Spacer(Modifier.width(8.dp))
            Text(
                step.verb.ifEmpty { "—" },
                style = Type.mono(p, 11f, p.paperMute),
                modifier = Modifier.padding(top = 3.dp),
            )
        }
    }
}

/** The heard wave: six bars breathing at their own rates, so the sentence
 *  reads as something the phone caught rather than something it wrote. Still
 *  when motion is. */
@Composable
private fun Wave(modifier: Modifier = Modifier) {
    val p = LocalPalette.current
    val motion = LocalMotion.current
    val heights = listOf(10f, 22f, 34f, 18f, 27f, 12f)
    val scales = if (motion.ambient()) {
        val t = rememberInfiniteTransition(label = "wave")
        heights.mapIndexed { i, _ ->
            val a by t.animateFloat(
                initialValue = 0.55f,
                targetValue = 1f,
                animationSpec = infiniteRepeatable(
                    tween(1600, delayMillis = (i * 190) % 700),
                    RepeatMode.Reverse,
                ),
                label = "bar$i",
            )
            a
        }
    } else {
        heights.map { 1f }
    }
    Row(
        modifier.height(38.dp).padding(top = 4.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        heights.forEachIndexed { i, h ->
            Box(
                Modifier
                    .width(3.dp)
                    .height(h.dp)
                    .graphicsLayer {
                        scaleY = scales[i]
                        transformOrigin = androidx.compose.ui.graphics.TransformOrigin(0.5f, 1f)
                    }
                    .clip(RoundedCornerShape(2.dp))
                    .background(p.work.copy(alpha = 0.85f)),
            )
        }
    }
}
