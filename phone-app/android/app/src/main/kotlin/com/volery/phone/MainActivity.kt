package com.volery.phone

import android.Manifest
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlin.math.roundToInt

/**
 * Home: the roster and the cards digest the dial came back with, as a lamplit
 * column in chat view's direction — warm gradient ground, cards as soft plates
 * with a pool of status colour, a context ring that warms as it fills, and
 * motion where there is life. The node lives in [NodeService]; this screen is
 * a view over [NodeState]. Tapping a card opens [ViewerActivity] for it.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            VoleryTheme { HomeScreen() }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        Speaker.shutdown()
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomeScreen() {
    val context = LocalContext.current
    val working = NodeState.working
    val sighting = NodeState.sighting
    val error = NodeState.error

    val host = Config.host
    val chatty = Config.chatty

    val dial = {
        NodeService.dial(context, Config.host, Config.key, Config.name)
    }

    // Dial on open when a key is already configured — the phone joins the
    // flyway the moment you open it; the re-dial button is for later.
    LaunchedEffect(Unit) {
        if (Config.key.isNotEmpty()) dial()
    }

    // The ears, as one controller the tap and the seamless window both drive.
    val voice = remember { VoiceController(context.applicationContext) }
    // The steer loop: a transcript becomes a plan on the wall, spoken back and
    // confirmed aloud; a question is spoken and answered. Hooks itself into
    // `voice`'s settled transcript.
    val steer = remember { Steer(voice) }
    DisposableEffect(voice) { onDispose { voice.stop() } }

    val mode = Config.mode

    // The narration loop: while this screen is shown, re-sight the wall and
    // speak what changed, gated by the chatty level. A line that needs her
    // ducks her music (every mode) and, in seamless mode, opens the ears for a
    // short yes-window once the words are out of the air.
    NarrationLoop(context, host, chatty, mode, steer, onNeedsYou = {
        if (mode == "seamless") {
            if (voice.hasMic()) voice.startSeamless() else voice.fail("the ears need the microphone")
        }
    })

    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) voice.toggle() else voice.fail("the ears need the microphone")
    }
    val toggleListen = {
        if (voice.listening) {
            voice.stop()
        } else if (voice.hasMic()) {
            voice.toggle()
        } else {
            permission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    // The column rises and settles once, so the first paint is a motion rather
    // than a pop.
    val enter = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        enter.animateTo(1f, tween(440, easing = FastOutSlowInEasing))
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(groundBrush()),
    ) {
        Scaffold(
            containerColor = Color.Transparent,
            topBar = {
                TopAppBar(
                    title = { Text("volery", fontFamily = FontFamily.Serif) },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = Color.Transparent,
                    ),
                    actions = {
                        IconButton(onClick = dial) {
                            Icon(Icons.Default.Refresh, contentDescription = "dial again", tint = Lamp)
                        }
                        IconButton(onClick = {
                            context.open(Intent(context, SettingsActivity::class.java))
                        }) {
                            Icon(Icons.Default.Settings, contentDescription = "settings", tint = InkMute)
                        }
                    },
                )
            },
            bottomBar = {
                ListenBar(
                    listening = voice.listening,
                    heard = voice.heard,
                    status = steer.status,
                    error = voice.error,
                    onToggle = toggleListen,
                )
            },
        ) { padding ->
            Box(
                Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .graphicsLayer {
                        alpha = enter.value
                        translationY = (1f - enter.value) * 28.dp.toPx()
                    },
            ) {
                when {
                    working -> StatusLine("dialing…")
                    error != null -> ErrorState(error, onRetry = dial)
                    sighting != null -> SightingList(sighting) { card, host ->
                        context.open(
                            Intent(context, ViewerActivity::class.java)
                                .putExtra(ViewerActivity.EXTRA_HOST, host)
                                .putExtra(ViewerActivity.EXTRA_CARD, card.id)
                                .putExtra(ViewerActivity.EXTRA_TITLE, card.title.ifEmpty { card.project }),
                        )
                    }
                    else -> EmptyState(onSettings = {
                        context.open(Intent(context, SettingsActivity::class.java))
                    })
                }
            }
        }
    }
}

@Composable
private fun StatusLine(text: String) {
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        StatusMark("work", working = true, dormant = false)
        Spacer(Modifier.height(14.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = InkMute)
    }
}

@Composable
private fun ErrorState(message: String, onRetry: () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        StatusMark("fail", working = false, dormant = false)
        Spacer(Modifier.height(14.dp))
        Text(
            "could not reach the wall",
            style = MaterialTheme.typography.bodyMedium,
            color = Ink,
        )
        Spacer(Modifier.height(4.dp))
        Text(message, style = MaterialTheme.typography.labelMedium)
        Spacer(Modifier.height(16.dp))
        FilledTonalButton(onClick = onRetry) { Text("dial again") }
    }
}

@Composable
private fun EmptyState(onSettings: () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("no key yet", style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(6.dp))
        Text(
            "set the wall key phrase in settings and the phone will join the flyway.",
            style = MaterialTheme.typography.bodyMedium,
            color = InkMute,
        )
        Spacer(Modifier.height(16.dp))
        FilledTonalButton(onClick = onSettings) { Text("open settings") }
    }
}

@Composable
private fun SightingList(sighting: Sighting, onCard: (CardDigest, String) -> Unit) {
    val cardsHost = sighting.cards?.host
    LazyColumn(Modifier.fillMaxSize()) {
        if (sighting.roster.isNotEmpty()) {
            item { SectionLabel("the walls") }
            items(sighting.roster, key = { "wall:${it.host}" }) { wall -> RosterRowView(wall) }
        }
        val cards = sighting.cards
        if (cards != null) {
            item {
                SectionLabel(if (cardsHost.isNullOrEmpty()) "cards" else "cards on $cardsHost")
            }
            if (cards.cards.isEmpty()) {
                item {
                    Text(
                        "no cards — the wall has none open yet.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = InkMute,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
            } else {
                items(cards.cards, key = { it.id }) { card ->
                    CardPlate(card) { onCard(card, cardsHost ?: Config.host) }
                }
            }
        } else if (sighting.roster.isEmpty()) {
            item {
                Text(
                    "no walls heard — the wall may still be painting itself; dial again in a moment.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = InkMute,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
        }
        item { Spacer(Modifier.height(16.dp)) }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 6.dp),
    ) {
        Box(
            Modifier
                .width(3.dp)
                .height(14.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(Brush.verticalGradient(listOf(Lamp, Color.Transparent))),
        )
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.labelMedium, color = InkMute)
    }
}

@Composable
private fun RosterRowView(wall: RosterRow) {
    val mine = wall.host == Config.name
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                wall.host,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                listOfNotNull(
                    "live ${wall.cardsLive}",
                    "working ${wall.cardsWorking}",
                    if (wall.build.isEmpty()) null else "build ${wall.build}",
                ).joinToString(" · "),
                style = MaterialTheme.typography.labelSmall,
            )
        }
        if (mine) {
            Spacer(Modifier.width(8.dp))
            Box(
                Modifier
                    .clip(RoundedCornerShape(50))
                    .background(Lamp.copy(alpha = 0.16f))
                    .padding(horizontal = 10.dp, vertical = 3.dp),
            ) {
                Text("this phone", style = MaterialTheme.typography.labelSmall, color = Lamp)
            }
        }
    }
}

@Composable
private fun CardPlate(card: CardDigest, onClick: () -> Unit) {
    val color = tierColor(card.tier)
    val dormant = card.dormant || card.aside
    val titleColor = if (dormant) InkFaint else Ink
    val sub = when {
        card.working -> card.doing
        card.said.isNotEmpty() -> card.said
        else -> "no word yet"
    }
    val meta = listOfNotNull(
        stateWords(card),
        card.model,
        if (card.ctx != null) "${(card.ctx * 100).roundToInt()}% ctx" else "— ctx",
    ).joinToString(" · ")

    Box(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 5.dp)
            .shadow(6.dp, RoundedCornerShape(16.dp), spotColor = Color(0x55987C4E), ambientColor = Color(0x55987C4E))
            .background(cardBrush())
            .clickable(onClick = onClick),
    ) {
        // The pool: a wash of the card's status colour falling from the left,
        // chat view's `--cv-pool-*` on paper rather than on a dark ground.
        Box(
            Modifier
                .matchParentSize()
                .background(Brush.horizontalGradient(listOf(color.copy(alpha = 0.16f), Color.Transparent))),
        )
        Row(
            Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StatusMark(card.tier, card.working, dormant)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    card.title.ifEmpty { card.project.ifEmpty { "unnamed" } },
                    style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Medium),
                    color = titleColor,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    sub,
                    style = MaterialTheme.typography.labelMedium,
                    color = if (dormant) InkFaint else InkMute,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(meta, style = MaterialTheme.typography.labelSmall)
            }
            Spacer(Modifier.width(12.dp))
            ContextRing(card.ctx, dormant)
        }
    }
}

/** The leading word of the meta line: a card set aside or dormant says that
 *  rather than its tier — the tier is the dot's to carry. */
private fun stateWords(card: CardDigest): String = when {
    card.dormant -> "dormant"
    card.aside -> "aside"
    else -> tierWord(card.tier)
}

/** A card's status as a soft pool: a glow of the tier colour with the dot
 *  inside, filled while alive, hollow at rest, breathing while it works. */
@Composable
fun StatusMark(tier: String, working: Boolean, dormant: Boolean) {
    val color = tierColor(tier)
    val alpha = if (dormant) 0.4f else 1f
    val hollow = tier == "rest"
    Box(Modifier.size(30.dp), contentAlignment = Alignment.Center) {
        Box(
            Modifier
                .size(26.dp)
                .background(
                    Brush.radialGradient(listOf(color.copy(alpha = 0.30f * alpha), Color.Transparent)),
                    CircleShape,
                ),
        )
        if (working) {
            val t = rememberInfiniteTransition(label = "working")
            val s by t.animateFloat(1f, 1.45f, infiniteRepeatable(tween(820), RepeatMode.Reverse))
            Dot(Modifier.size(8.dp).scale(s), color, alpha, hollow)
        } else {
            Dot(Modifier.size(8.dp), color, alpha, hollow)
        }
    }
}

@Composable
fun Dot(modifier: Modifier, color: Color, alpha: Float, hollow: Boolean) {
    if (hollow) {
        Box(modifier.clip(CircleShape).border(1.5.dp, color.copy(alpha = alpha), CircleShape))
    } else {
        Box(modifier.clip(CircleShape).background(color.copy(alpha = alpha)))
    }
}

/** The wall's context ring, smaller: celadon warming to amber and rust as the
 *  window fills, faint when the card is dormant. */
@Composable
private fun ContextRing(ctx: Double?, dormant: Boolean) {
    val color = if (ctx != null) ctxWarmth(ctx) else InkFaint
    val alpha = if (dormant) 0.4f else 1f
    Canvas(Modifier.size(20.dp)) {
        val strokeWidth = 2.dp.toPx()
        val stroke = Stroke(width = strokeWidth, cap = StrokeCap.Round)
        val d = size.minDimension - strokeWidth
        val topLeft = Offset((size.width - d) / 2, (size.height - d) / 2)
        val arcSize = Size(d, d)
        drawArc(
            color = Edge,
            startAngle = 0f,
            sweepAngle = 360f,
            useCenter = false,
            style = stroke,
            topLeft = topLeft,
            size = arcSize,
        )
        if (ctx != null) {
            val frac = ctx.coerceIn(0.0, 1.0)
            drawArc(
                color = color.copy(alpha = alpha),
                startAngle = -90f,
                sweepAngle = (frac * 360f).toFloat(),
                useCenter = false,
                style = stroke,
                topLeft = topLeft,
                size = arcSize,
            )
        }
    }
}

/* ── narration: the digest→speech loop ─────────────────────────────────── */

/** Sight the wall and speak its changes, only while the home screen is shown.
 *  `repeatOnLifecycle(RESUMED)` is the gate: the block runs once on every
 *  return to the front (so a reopen narrates what changed while away, against
 *  the persisted digest) and then on a modest cadence, and it is cancelled the
 *  moment the screen stops being shown. `off` gates it entirely — no sighting,
 *  no voice. */
@Composable
private fun NarrationLoop(context: Context, host: String, chatty: String, mode: String, steer: Steer, onNeedsYou: () -> Unit) {
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(host, chatty, mode) {
        if (chatty == "off") return@LaunchedEffect
        Speaker.init(context)
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            try {
                narrateOnce(context, host, chatty, steer, onNeedsYou)
                while (true) {
                    delay(NARRATION_CADENCE_MS)
                    narrateOnce(context, host, chatty, steer, onNeedsYou)
                }
            } finally {
                // Leaving the home screen cancels this block; a needs_you line
                // still mid-speech must not open the ears on another screen.
                Speaker.onQuiet = null
            }
        }
    }
}

/** One poll, folded against the persisted digest and spoken. The blocking JNI
 *  calls and the store read/write run off the main thread; [Speaker.speak] is
 *  back on it, where [android.speech.tts.TextToSpeech] is happiest. A turn that
 *  needs her ducks her music for the line, then hands the caller `onNeedsYou`
 *  once the words are out of the air — seamless mode opens the ears on it. */
private suspend fun narrateOnce(context: Context, host: String, chatty: String, steer: Steer, onNeedsYou: () -> Unit) {
    val prev = withContext(Dispatchers.IO) { NarrationStore.load(context) }
    val turn = sightAndNarrate(host, prev, chatty) ?: return
    if (turn.lines.isNotEmpty()) {
        Log.i("PhoneNarration", "spoke ${turn.lines.size} line(s): ${turn.lines.joinToString(" · ") { it.text }}")
    }
    for (line in turn.lines) {
        // A question with a parked id arms the answer *before* it is spoken, so
        // the seamless window that follows (and the tap in push-to-talk) knows
        // the next transcript is the answer, not a command.
        if (line.kind == "ask" && line.askId != null) {
            steer.armQuestion(line.card, line.askId)
        }
        Speaker.speak(line.text, needsFocus = turn.needsYou)
    }
    withContext(Dispatchers.IO) { NarrationStore.save(context, turn.curr) }
    if (turn.needsYou) {
        // Listen only after the words are out of the air, so the ears do not
        // hear the phone's own voice as an answer.
        if (Speaker.isSpeaking()) Speaker.onQuiet = onNeedsYou else onNeedsYou()
    }
}

/* ── the ears: the listen button and its transcript ────────────────────── */

@Composable
private fun ListenBar(listening: Boolean, heard: String, status: String, error: String?, onToggle: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(Surface)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        when {
            listening -> Row(verticalAlignment = Alignment.CenterVertically) {
                StatusMark("ask", working = true, dormant = false)
                Spacer(Modifier.width(10.dp))
                Text(
                    heard.ifEmpty { "listening…" },
                    style = MaterialTheme.typography.bodyMedium,
                    color = InkDim,
                )
            }
            error != null -> Text(error, style = MaterialTheme.typography.bodyMedium, color = Rust)
            heard.isNotEmpty() -> Text(heard, style = MaterialTheme.typography.bodyMedium, color = InkDim)
            else -> Text("speak and your words appear here", style = MaterialTheme.typography.labelMedium, color = InkMute)
        }
        // What became of the last thing said — the plan read back, "done",
        // "let go", a refusal. Kept on the bar so the phone never reads as
        // having heard nothing.
        if (status.isNotEmpty()) {
            Text(status, style = MaterialTheme.typography.labelMedium, color = InkMute)
        }
        FilledTonalButton(onClick = onToggle, shape = RoundedCornerShape(12.dp)) {
            Text(if (listening) "stop" else "listen")
        }
    }
}

