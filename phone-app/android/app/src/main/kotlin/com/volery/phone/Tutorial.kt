package com.volery.phone

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * The six slides a first launch opens on, and the same six from settings.
 *
 * Lyss's report was two complaints wearing one coat: the hands-free path was
 * not working, and nothing said what Volery was for or how to get it into the
 * state where a question reaches your ear. The second is not fixed by making
 * the first work — a feature nobody can find is one nobody has. So this is a
 * short, skippable introduction on first launch, reopenable for ever after from
 * settings, written in the same quiet voice as the rest of the app and drawn
 * rather than described. It teaches Volery, not the operating system: which
 * button holds the orb is a sentence, and the six slides are about what the
 * app is and what it does.
 *
 * It never blocks anything: skip is on every slide, back lets you re-read one,
 * and the last slide is the way out. Marking it seen happens when it is shown,
 * so an interrupted read does not bring it back on the next open.
 */
class TutorialActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            VoleryTheme(theme = Config.theme, motion = Config.motion) {
                Tutorial(onDone = { finish() })
            }
        }
    }
}

private data class Slide(val kicker: String, val title: String, val body: String)

private val SLIDES = listOf(
    Slide(
        kicker = "welcome",
        title = "your wall, in your pocket",
        body = "volery puts every claude conversation on one wall. this phone is a node on that wall: " +
            "it reads what your cards are doing, hears the ones that need you, and answers them — " +
            "without waking a laptop or touching this screen.",
    ),
    Slide(
        kicker = "the flyway",
        title = "it finds a wall that is up",
        body = "set the key phrase once and the phone joins the flyway — the mesh your machines share. " +
            "it tries the wall you prefer, then the ones it has met, then the flyway's directory, so a " +
            "laptop that is off is not a phone that stops working.",
    ),
    Slide(
        kicker = "hands-free",
        title = "a question, read aloud",
        body = "turn on hands-free in settings: seamless listening, speaking what needs you, and the " +
            "microphone. when a card stops on a question the phone says it, your music ducks, and the " +
            "ears open when the words are done. answer in your own words. the screen can stay off.",
    ),
    Slide(
        kicker = "waiting on you",
        title = "everything that is parked, on one page",
        body = "a question, a folder about to be deleted, a pull request, a close — each is drawn with " +
            "its own words and its own buttons at the top of the roster. tap an option to answer it. " +
            "the card hears exactly what a click on its own wall would have said.",
    ),
    Slide(
        kicker = "the context",
        title = "what led to this",
        body = "a short question sometimes needs the paragraph before it. open a prompt and tap " +
            "“what led to this”: the phone pulls the prose that came just before it from the wall — " +
            "yours and claude's, with the tool calls stripped out, never the whole transcript.",
    ),
    Slide(
        kicker = "command",
        title = "and you can speak first",
        body = "hold the orb and say what you want. the wall turns the sentence into a plan and says it " +
            "back; you say yes and it runs there, never here. the gate is the safety line, and the " +
            "phone only ever relays.",
    ),
)

@Composable
private fun Tutorial(onDone: () -> Unit) {
    val p = LocalPalette.current
    val motion = LocalMotion.current
    var step by rememberSaveable { mutableIntStateOf(0) }
    val last = step == SLIDES.size - 1
    val slide = SLIDES[step]

    Ground(poolTier = if (step == 2) "working" else null) {
        Column(
            Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.statusBars)
                .windowInsetsPadding(WindowInsets.navigationBars)
                .padding(horizontal = 22.dp),
        ) {
            Row(
                Modifier.fillMaxWidth().height(58.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Mark(size = 20.dp)
                Spacer(Modifier.width(9.dp))
                Text("how to use volery", style = Type.group(p, p.paperDim))
                Spacer(Modifier.weight(1f))
                Box(
                    Modifier
                        .clip(RoundedCornerShape(999.dp))
                        .background(p.surface.copy(alpha = 0.35f))
                        .padding(horizontal = 2.dp),
                ) {
                    Text(
                        "skip",
                        style = Type.label(p, p.paperDim, 12.5f),
                        modifier = Modifier
                            .clip(RoundedCornerShape(999.dp))
                            .then(pressable(onDone, RoundedCornerShape(999.dp), tint = p.surface.copy(alpha = 0.5f)))
                            .padding(horizontal = 14.dp, vertical = 8.dp),
                    )
                }
            }

            /* The scene changes with the slide; the words cross-fade under it,
               because a slide whose illustration cuts while its title slides is
               two animations saying one thing twice. */
            Crossfade(
                targetState = step,
                animationSpec = tween(motion.duration(Motion.stage)),
                modifier = Modifier.weight(1f).fillMaxWidth(),
                label = "slide",
            ) { at ->
                Column(Modifier.fillMaxSize()) {
                    Stage(pool = when (at) {
                        2 -> p.work
                        3 -> p.ask
                        else -> null
                    }) {
                        when (at) {
                            0 -> SceneWall()
                            1 -> SceneFlyway()
                            2 -> SceneEars()
                            3 -> ScenePrompts()
                            4 -> SceneContext()
                            else -> ScenePlan()
                        }
                    }
                    Spacer(Modifier.height(24.dp))
                    Text(
                        "${when (at) { 0 -> "one" ; 1 -> "two" ; 2 -> "three" ; 3 -> "four" ; 4 -> "five" ; else -> "six" }} · ${SLIDES[at].kicker}",
                        style = Type.group(p, if (at == 3) p.ask else p.paperMute).copy(letterSpacing = 0.5.sp),
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(SLIDES[at].title, style = Type.display(p, 29f, p.paper))
                    Spacer(Modifier.height(10.dp))
                    Text(
                        SLIDES[at].body,
                        style = Type.prose(p).copy(fontSize = 15.sp, lineHeight = 23.sp),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(18.dp))
                }
            }

            /* The controls stand still while the slides move: a button that
               travels with every page is a button you have to chase. */
            Row(
                Modifier.fillMaxWidth().padding(bottom = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                SLIDES.indices.forEach { i ->
                    Box(
                        Modifier
                            .size(width = if (i == step) 20.dp else 6.dp, height = 6.dp)
                            .clip(RoundedCornerShape(999.dp))
                            .background(if (i == step) p.paper else p.paper.copy(alpha = 0.20f)),
                    )
                }
                Spacer(Modifier.weight(1f))
                if (step > 0) {
                    ActionButton(
                        "back",
                        onClick = { step-- },
                        height = 48.dp,
                    )
                }
                ActionButton(
                    if (last) "start using it" else "next",
                    onClick = { if (last) onDone() else step++ },
                    primary = true,
                    height = 48.dp,
                )
            }
        }
    }
}

/* ── the stage ──────────────────────────────────────────────────────────── */

/** The illustration's room: a soft pool of light, a hairline, and whatever the
 *  slide composed. One shape for every slide so the six read as one deck. */
@Composable
private fun ColumnScope.Stage(pool: Color?, content: @Composable BoxScope.() -> Unit) {
    val p = LocalPalette.current
    val shape = RoundedCornerShape(26.dp)
    Box(
        Modifier
            .fillMaxWidth()
            .weight(1f)
            .heightIn(min = 200.dp, max = 360.dp)
            .clip(shape)
            .background(p.surface.copy(alpha = 0.34f))
            .border(1.dp, p.hair, shape)
            .drawWithCache {
                val wash = Brush.radialGradient(
                    listOf((pool ?: lerp(p.paper, p.surface, 0.55f)).copy(alpha = if (pool == null) 0.10f else 0.16f), Color.Transparent),
                    center = Offset(size.width * 0.5f, size.height * 0.30f),
                    radius = size.maxDimension * 0.72f,
                )
                onDrawWithContent {
                    drawRect(wash)
                    drawContent()
                }
            },
        contentAlignment = Alignment.Center,
        content = content,
    )
}

/** A small card as the wall draws one: a title bar and two quieter lines. */
@Composable
private fun MiniCard(
    title: String,
    lines: Int,
    modifier: Modifier = Modifier,
    accent: Color? = null,
    width: Int = 92,
    height: Int = 54,
) {
    val p = LocalPalette.current
    Column(
        modifier
            .width(width.dp)
            .height(height.dp)
            .clip(RoundedCornerShape(9.dp))
            .background(p.raised.copy(alpha = 0.92f))
            .border(1.dp, accent?.copy(alpha = 0.55f) ?: p.hair, RoundedCornerShape(9.dp))
            .padding(horizontal = 8.dp, vertical = 7.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (accent != null) {
                Box(Modifier.size(4.dp).clip(CircleShape).background(accent))
                Spacer(Modifier.width(4.dp))
            }
            Text(title, style = Type.meta(p, if (accent != null) p.paper else p.paperDim, 8.5f), maxLines = 1)
        }
        repeat(lines) { i ->
            Box(
                Modifier
                    .fillMaxWidth(if (i == lines - 1) 0.62f else 1f)
                    .height(3.dp)
                    .clip(RoundedCornerShape(999.dp))
                    .background(p.paperMute.copy(alpha = 0.26f)),
            )
        }
    }
}

/** A dashed connector between two points, drawn by hand because a Compose
 *  divider cannot be dashed. */
@Composable
private fun Halo(radius: Float, alpha: Float, color: Color) {
    Box(
        Modifier
            .size((radius * 2).dp)
            .clip(CircleShape)
            .border(1.dp, color.copy(alpha = alpha), CircleShape),
    )
}

/* ── the six scenes ─────────────────────────────────────────────────────── */

@Composable
private fun SceneWall() {
    val p = LocalPalette.current
    Box(Modifier.fillMaxSize().padding(vertical = 16.dp), contentAlignment = Alignment.Center) {
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
            listOf(
                listOf("caravan", "hold", "orchard"),
                listOf("asset", "nova", "rise"),
                listOf("hold", "eos", "caravan"),
            ).forEachIndexed { r, row ->
                Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                    row.forEachIndexed { c, name ->
                        MiniCard(
                            title = name,
                            lines = 2,
                            accent = if (r == 1 && c == 1) p.work else null,
                            width = 99,
                            height = 56,
                        )
                    }
                }
            }
        }
        /* The phone in front, reading the wall — not beside it, which is the
           whole picture: the wall is already in your pocket. */
        Column(
            Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 6.dp)
                .width(168.dp)
                .height(166.dp)
                .clip(RoundedCornerShape(24.dp))
                .background(p.lift)
                .border(1.5.dp, lerp(p.edge, p.paper, 0.12f), RoundedCornerShape(24.dp))
                .padding(horizontal = 13.dp, vertical = 13.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Box(Modifier.align(Alignment.CenterHorizontally).width(32.dp).height(4.dp).clip(RoundedCornerShape(999.dp)).background(p.paperFaint))
            Spacer(Modifier.height(3.dp))
            Text("waiting on you", style = Type.meta(p, p.ask, 9f))
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(54.dp)
                    .clip(RoundedCornerShape(9.dp))
                    .background(p.ask.copy(alpha = 0.13f))
                    .border(1.dp, p.ask.copy(alpha = 0.42f), RoundedCornerShape(9.dp)),
            ) {
                Column(Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Box(Modifier.fillMaxWidth(0.7f).height(4.dp).clip(RoundedCornerShape(999.dp)).background(p.paperMute.copy(alpha = 0.45f)))
                    Box(Modifier.fillMaxWidth(0.5f).height(4.dp).clip(RoundedCornerShape(999.dp)).background(p.paperMute.copy(alpha = 0.30f)))
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                Box(Modifier.height(18.dp).width(58.dp).clip(RoundedCornerShape(7.dp)).background(p.surface.copy(alpha = 0.65f)))
                Box(Modifier.height(18.dp).width(42.dp).clip(RoundedCornerShape(7.dp)).background(p.surface.copy(alpha = 0.45f)))
            }
        }
    }
}

@Composable
private fun SceneFlyway() {
    val p = LocalPalette.current
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            Modifier.fillMaxSize().padding(22.dp),
            verticalArrangement = Arrangement.SpaceBetween,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                listOf("desk", "annex", "lab").forEachIndexed { i, name ->
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        MiniCard(name, 1, width = 72, height = 40, accent = if (i == 1) p.work else null)
                        Spacer(Modifier.height(3.dp))
                        Text(if (i == 1) "up" else "quiet", style = Type.meta(p, if (i == 1) p.work else p.note, 8.5f))
                    }
                }
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("the flyway's directory", style = Type.meta(p, p.note, 9f))
                Spacer(Modifier.height(6.dp))
                Box(
                    Modifier
                        .width(150.dp)
                        .height(72.dp)
                        .clip(RoundedCornerShape(14.dp))
                        .background(p.lift)
                        .border(1.5.dp, p.edge, RoundedCornerShape(14.dp))
                        .padding(10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("this phone", style = Type.label(p, p.paper, 11f))
                    Box(Modifier.align(Alignment.TopCenter).padding(top = 4.dp).width(26.dp).height(3.dp).clip(RoundedCornerShape(999.dp)).background(p.paperFaint))
                }
            }
        }
        /* Three dashed paths from the phone to the walls, the middle lit. */
        androidx.compose.foundation.Canvas(Modifier.fillMaxSize()) {
            val cx = size.width / 2f
            val from = Offset(cx, size.height - 42.dp.toPx() - 36.dp.toPx())
            val to = listOf(0.2f, 0.5f, 0.8f).map { Offset(size.width * it, 74.dp.toPx()) }
            val dash = androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(7f, 7f))
            to.forEachIndexed { i, end ->
                drawLine(
                    color = if (i == 1) p.work.copy(alpha = 0.65f) else p.paperFaint.copy(alpha = 0.40f),
                    start = from,
                    end = end,
                    strokeWidth = if (i == 1) 2.2f else 1.4f,
                    pathEffect = dash,
                )
            }
        }
    }
}

@Composable
private fun SceneEars() {
    val p = LocalPalette.current
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Box(contentAlignment = Alignment.Center) {
            Halo(86f, 0.08f, p.work)
            Halo(64f, 0.14f, p.work)
            Halo(44f, 0.24f, p.work)
            Box(
                Modifier
                    .size(62.dp)
                    .clip(CircleShape)
                    .background(p.work.copy(alpha = 0.18f))
                    .border(1.5.dp, p.work.copy(alpha = 0.55f), CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Glyph.Mic, tint = p.paper, size = 24.dp)
            }
        }
        /* The question, spoken, above right. */
        Row(
            Modifier.align(Alignment.TopEnd).padding(top = 26.dp, end = 22.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(
                Modifier
                    .width(126.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(p.lift)
                    .border(1.dp, p.work.copy(alpha = 0.30f), RoundedCornerShape(14.dp))
                    .padding(horizontal = 11.dp, vertical = 9.dp),
            ) {
                Text("caravan", style = Type.meta(p, p.note, 8.5f))
                Spacer(Modifier.height(3.dp))
                Text("square or circle?", style = Type.label(p, p.paper, 11f), maxLines = 2)
            }
        }
        /* The words on the air, under it. */
        Row(
            Modifier.align(Alignment.BottomCenter).padding(bottom = 34.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            listOf(8, 16, 24, 14, 20, 10).forEach { h ->
                Box(
                    Modifier
                        .width(3.dp)
                        .height(h.dp)
                        .clip(RoundedCornerShape(2.dp))
                        .background(p.work.copy(alpha = 0.75f)),
                )
            }
            Spacer(Modifier.width(10.dp))
            Text("say your answer", style = Type.meta(p, p.note, 9f))
        }
    }
}

@Composable
private fun ScenePrompts() {
    val p = LocalPalette.current
    Column(
        Modifier.fillMaxSize().padding(horizontal = 34.dp, vertical = 22.dp),
        verticalArrangement = Arrangement.spacedBy(9.dp, Alignment.CenterVertically),
    ) {
        listOf(
            Triple("question", "square or circle?", "yes"),
            Triple("delete", "C:/atelier/rise/build", "delete it"),
            Triple("confirm", "open a draft pull request", "open it"),
        ).forEach { (kind, line, action) ->
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(p.ask.copy(alpha = 0.10f))
                    .border(1.dp, p.ask.copy(alpha = 0.30f), RoundedCornerShape(12.dp))
                    .padding(horizontal = 11.dp, vertical = 9.dp),
            ) {
                Text(kind, style = Type.meta(p, p.ask, 8.5f))
                Spacer(Modifier.height(2.dp))
                Text(line, style = Type.label(p, p.paper, 10.5f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    Box(
                        Modifier
                            .height(18.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(p.surface.copy(alpha = 0.65f))
                            .border(1.dp, p.hair, RoundedCornerShape(6.dp))
                            .padding(horizontal = 8.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(action, style = Type.meta(p, p.paperDim, 8.5f))
                    }
                    Box(
                        Modifier
                            .height(18.dp)
                            .width(44.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(p.surface.copy(alpha = 0.45f)),
                    )
                }
            }
        }
    }
}

@Composable
private fun SceneContext() {
    val p = LocalPalette.current
    Column(
        Modifier.fillMaxSize().padding(horizontal = 30.dp, vertical = 22.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        listOf("you" to "look at the failing test", "claude" to "the failure is in the parser. it drops the last token when the line ends in a comma.").forEach { (who, line) ->
            Row(Modifier.fillMaxWidth().padding(bottom = 7.dp)) {
                Text(who, style = Type.meta(p, if (who == "you") p.paperDim else p.work, 8.5f), modifier = Modifier.width(44.dp))
                Text(line, style = Type.note(p, p.paperDim), modifier = Modifier.weight(1f))
            }
        }
        Spacer(Modifier.height(4.dp))
        Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(p.ask.copy(alpha = 0.11f))
                .border(1.dp, p.ask.copy(alpha = 0.32f), RoundedCornerShape(12.dp))
                .padding(horizontal = 11.dp, vertical = 9.dp),
        ) {
            Text("question · caravan", style = Type.meta(p, p.ask, 8.5f))
            Spacer(Modifier.height(3.dp))
            Text("widen it in place, or add beside it?", style = Type.label(p, p.paper, 10.5f))
            Spacer(Modifier.height(7.dp))
            Text("what led to this", style = Type.meta(p, p.paperDim, 8.5f))
        }
    }
}

@Composable
private fun ScenePlan() {
    val p = LocalPalette.current
    Column(
        Modifier.fillMaxSize().padding(horizontal = 34.dp, vertical = 20.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text("“open a card for the orchard migration”", style = Type.prose(p).copy(fontSize = 12.5.sp))
        Spacer(Modifier.height(10.dp))
        Text("the wall hears a plan", style = Type.meta(p, p.note, 8.5f))
        Spacer(Modifier.height(5.dp))
        listOf("open a card", "send it the plan", "leave the old one").forEachIndexed { i, step ->
            Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(16.dp).clip(CircleShape).border(1.dp, p.edge, CircleShape),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("${i + 1}", style = Type.meta(p, p.paperMute, 8f))
                }
                Spacer(Modifier.width(8.dp))
                Text(step, style = Type.label(p, p.paper, 10.5f), modifier = Modifier.weight(1f))
            }
        }
        Spacer(Modifier.height(9.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .height(26.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(p.paper)
                    .padding(horizontal = 12.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text("yes — do it", style = Type.label(p, p.sheet, 10f))
            }
            Spacer(Modifier.width(9.dp))
            Text("nothing has happened yet", style = Type.meta(p, p.note, 8.5f))
        }
    }
}
