package com.volery.phone

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlin.math.roundToInt

/**
 * Home: the roster and a card's page, as one room.
 *
 * The desktop's wall is many cards at once; a phone is one column, so the
 * roster is chat view's sidebar — needs you, working, finished, the projects as
 * a strip — and a card opens in place rather than in a second activity, because
 * the narration loop lives on this screen and a question answered from a card
 * has to have been heard first. The voice rail is drawn above both, on the
 * parent, so there is one rail and one set of ears however deep the page is.
 *
 * The card's page is the digest read in the thread's own visual language:
 * what it last said in the book's face, the machinery folded into one quiet
 * card, and the pool of its status at the foot. The transcript itself does not
 * cross the flyway yet (that is M7's `prompt`/`tail`), so the page says what it
 * is rather than pretending to scroll.
 */
class MainActivity : ComponentActivity() {
    /** Debug-only: `--ez phone.seedGate true` raises the gate with a
     *  representative plan. It exists so the gate can be photographed (and a
     *  lab can drive it) against a wall too old to answer `Steward`; nothing in
     *  the app reaches it, and a release build ignores it. */
    companion object {
        const val EXTRA_SEED_GATE = "phone.seedGate"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Config.restore(this)
        // The window behind the first Compose frame, in whichever ground was
        // chosen — so vellum opens vellum instead of opening dark and blinking.
        window.setBackgroundDrawable(
            android.graphics.drawable.ColorDrawable(
                paletteFor(Config.theme).sheet.toArgb(),
            ),
        )
        enableEdgeToEdge()
        val seedGate = BuildConfig.DEBUG && intent.getBooleanExtra(EXTRA_SEED_GATE, false)
        setContent {
            VoleryTheme(theme = Config.theme, motion = Config.motion) {
                VoleryPhone(seedGate = seedGate)
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        Speaker.shutdown()
    }
}

@Composable
private fun VoleryPhone(seedGate: Boolean = false) {
    val context = LocalContext.current
    val working = NodeState.working
    val sighting = NodeState.sighting
    val error = NodeState.error

    val ears = rememberEars()
    val steer = ears.steer

    var openId by rememberSaveable { mutableStateOf("") }
    var typing by remember { mutableStateOf(false) }
    var projectFilter by rememberSaveable { mutableStateOf("") }
    /* The wall being read is Config's, not a copy of it: a walk that opens on
       another wall writes it from the service, and every screen and every
       spoken sentence follows without a second place to keep in step. */
    val selectedHost = Config.host

    // Dial on open when a key is already configured. The phone joins the
    // flyway the moment you open it, walking the walls it last saw if the one
    // it was pointed at is off.
    LaunchedEffect(Unit) {
        if (Config.key.isNotEmpty()) {
            NodeService.dial(context, Config.host, Config.rememberedJson(), Config.key, Config.name)
        }
    }

    // The narration loop: re-sight the wall and speak what changed, gated by
    // the chatty level. It stays mounted while a card is open, which is what
    // lets a question be read out and then answered from that card.
    NarrationLoop(context, selectedHost, Config.chatty, Config.mode, steer, onNeedsYou = {
        if (Config.mode == "seamless") {
            if (ears.voice.hasMic()) ears.voice.startSeamless() else ears.voice.fail("the ears need the microphone")
        }
    })

    // The gate's preview seed (debug builds, explicit extra). It is a fold over
    // the same state a real plan sets, so what is photographed is the gate the
    // wall's plan would raise, not a mock of one.
    LaunchedEffect(seedGate) {
        if (seedGate) steer.seedForPreview(previewPlan())
    }

    val cards = sighting?.cards?.cards ?: emptyList()
    val open = if (openId.isNotEmpty()) cards.firstOrNull { it.id == openId } else null
    val plan = steer.pending

    val motion = LocalMotion.current
    val enter = remember { Animatable(if (motion == MotionLevel.STILL) 1f else 0f) }
    LaunchedEffect(Unit) {
        enter.animateTo(1f, tween(motion.duration(Motion.stage), easing = Motion.out))
    }

    BackHandler(enabled = openId.isNotEmpty()) { openId = "" }

    val openViewer = { card: CardDigest ->
        context.open(
            Intent(context, ViewerActivity::class.java)
                .putExtra(ViewerActivity.EXTRA_HOST, selectedHost)
                .putExtra(ViewerActivity.EXTRA_CARD, card.id)
                .putExtra(ViewerActivity.EXTRA_TITLE, card.word()),
        )
    }

    Box(Modifier.fillMaxSize()) {
        Ground(poolTier = if (openId.isNotEmpty()) open?.tier else null) {
            // The page is let go soft and dim behind the gate: what you were
            // reading is still there, demoted, rather than covered by a blur
            // that says nothing.
            val behind = if (plan != null) {
                Modifier
                    .graphicsLayer { alpha = 0.42f }
                    .then(if (Build.VERSION.SDK_INT >= 31) Modifier.blur(2.6.dp) else Modifier)
            } else {
                Modifier
            }
            Column(
                Modifier
                    .fillMaxSize()
                    .then(behind)
                    .graphicsLayer {
                        alpha = enter.value
                        translationY = (1f - enter.value) * 24.dp.toPx()
                    },
            ) {
                if (openId.isNotEmpty()) {
                    CardScreen(
                        card = open,
                        onBack = { openId = "" },
                        onViewer = { open?.let(openViewer) },
                        ears = ears,
                    )
                } else {
                    RosterScreen(
                        sighting = sighting,
                        working = working,
                        error = error,
                        host = selectedHost,
                        projectFilter = projectFilter,
                        onHost = { host ->
                            Config.host = host
                            Config.persistWalls()
                            NodeService.sight(context, host)
                        },
                        onProject = { projectFilter = it },
                        onOpen = { openId = it.id },
                        onSettings = { context.open(Intent(context, SettingsActivity::class.java)) },
                        onDial = {
                            NodeService.dial(context, Config.host, Config.rememberedJson(), Config.key, Config.name)
                        },
                    )
                }
            }

            VoiceRail(
                voice = ears.voice,
                status = steer.status,
                onType = { typing = true },
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .windowInsetsPadding(WindowInsets.navigationBars)
                    .padding(horizontal = 16.dp)
                    .padding(bottom = 26.dp),
            )
        }
        EarsOverlay(ears = ears, typing = typing, onTyping = { typing = it })
    }
}

/* ── the roster ─────────────────────────────────────────────────────────── */

@Composable
private fun RosterScreen(
    sighting: Sighting?,
    working: Boolean,
    error: String?,
    host: String,
    projectFilter: String,
    onHost: (String) -> Unit,
    onProject: (String) -> Unit,
    onOpen: (CardDigest) -> Unit,
    onSettings: () -> Unit,
    onDial: () -> Unit,
) {
    Column(
        Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.statusBars)
            .windowInsetsPadding(WindowInsets.navigationBars),
    ) {
        RosterHead(onDial = onDial)
        Walls(sighting = sighting, selected = host, working = working, onHost = onHost)
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                sighting != null -> RosterList(
                    sighting = sighting,
                    projectFilter = projectFilter,
                    onProject = onProject,
                    onOpen = onOpen,
                )
                error != null -> Stood(
                    kind = DotKind.Fail,
                    title = "could not reach the wall",
                    note = error,
                ) { ActionButton("dial again", onDial) }
                Config.key.isEmpty() -> Stood(
                    kind = DotKind.Rest,
                    title = "no key yet",
                    note = "set the wall's key phrase in settings and the phone will join the flyway.",
                ) { ActionButton("open settings", onSettings) }
                else -> Stood(
                    kind = DotKind.Work,
                    title = "dialing $host…",
                    note = "the flyway takes a moment to answer.",
                ) { ActionButton("dial again", onDial) }
            }
        }
        Me(onSettings = onSettings)
        Spacer(Modifier.height(106.dp))
    }
}

@Composable
private fun RosterHead(onDial: () -> Unit) {
    val p = LocalPalette.current
    Row(
        Modifier
            .fillMaxWidth()
            .height(54.dp)
            .padding(start = 14.dp, end = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Mark(size = 24.dp)
        Spacer(Modifier.width(10.dp))
        Text("volery", style = Type.display(p, 20f, p.paper))
        Spacer(Modifier.weight(1f))
        IconBtn(Glyph.Dial, "dial again", onDial)
    }
}

/** One wall as the strip draws it. */
private data class WallChip(val host: String, val lived: Int, val working: Boolean)

/** The walls, as chips: the phone is itself a node, so which wall it is reading
 *  is a first-class thing rather than a setting. Each carries what it is doing
 *  — live count, or quiet — and the one you are reading is raised.
 *
 *  The wall being read is always the first chip, even when the roster has not
 *  heard it announce: the cards below came from somewhere, and a strip that
 *  cannot name where you are is worse than one that has not heard a count. */
@Composable
private fun Walls(sighting: Sighting?, selected: String, working: Boolean, onHost: (String) -> Unit) {
    val roster = sighting?.roster.orEmpty()
    val chips = buildList {
        val chosen = roster.firstOrNull { it.host == selected }
        if (chosen == null) {
            add(WallChip(selected, sighting?.cards?.cards?.size ?: 0, working))
        }
        roster.forEach { wall ->
            add(WallChip(wall.host, wall.cardsLive, wall.cardsWorking > 0))
        }
    }
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(start = 16.dp, end = 26.dp)
            .padding(bottom = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        chips.forEach { wall ->
            Pill(
                text = wall.host,
                selected = wall.host == selected,
                onClick = { onHost(wall.host) },
                leading = {
                    StatusDot(
                        if (wall.working) DotKind.Work else DotKind.Rest,
                        breathing = wall.working,
                    )
                },
                trailing = when {
                    working && wall.host == selected -> "…"
                    wall.lived > 0 -> "${wall.lived}"
                    else -> "quiet"
                },
            )
        }
    }
}

@Composable
private fun RosterList(
    sighting: Sighting,
    projectFilter: String,
    onProject: (String) -> Unit,
    onOpen: (CardDigest) -> Unit,
) {
    val p = LocalPalette.current
    val all = sighting.cards?.cards.orEmpty()
    val cards = if (projectFilter.isEmpty()) all else all.filter { it.project == projectFilter }
    val groups = groupsOf(cards)
    val projects = projectsOf(all)
    var finishedOpen by rememberSaveable { mutableStateOf(false) }

    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 8.dp),
    ) {
        if (groups.total == 0) {
            item {
                Box(Modifier.fillMaxWidth().padding(horizontal = 22.dp, vertical = 28.dp)) {
                    Text(
                        if (projectFilter.isNotEmpty()) {
                            "nothing in $projectFilter right now."
                        } else {
                            "no cards — the wall has none open yet."
                        },
                        style = Type.note(p),
                    )
                }
            }
        }
        if (groups.needs.isNotEmpty()) {
            item { GroupLabel("needs you", groups.needs.size, Modifier.padding(top = 10.dp, bottom = 2.dp)) }
            items(groups.needs, key = { it.id }) { card ->
                CardRow(card, tall = true, onClick = { onOpen(card) })
            }
        }
        if (groups.working.isNotEmpty()) {
            item { GroupLabel("working", groups.working.size, Modifier.padding(top = 10.dp, bottom = 2.dp)) }
            items(groups.working, key = { it.id }) { card ->
                CardRow(card, tall = true, onClick = { onOpen(card) })
            }
        }
        if (groups.finished.isNotEmpty()) {
            item { GroupLabel("finished", groups.finished.size, Modifier.padding(top = 10.dp, bottom = 2.dp)) }
            // A wall left up for days carries dozens of dormant cards; a phone
            // that lists them all has buried today under last month. Eight, and
            // then it says how many more are at rest — one tap to open them all.
            val shown = if (finishedOpen) groups.finished else groups.finished.take(FINISHED_SHOWN)
            items(shown, key = { it.id }) { card ->
                CardRow(card, tall = false, onClick = { onOpen(card) })
            }
            if (groups.finished.size > FINISHED_SHOWN) {
                item {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 10.dp)
                            .then(
                                pressable(
                                    onClick = { finishedOpen = !finishedOpen },
                                    shape = RoundedCornerShape(13.dp),
                                    tint = p.surface.copy(alpha = 0.35f),
                                ),
                            ),
                    ) {
                        Text(
                            if (finishedOpen) {
                                "show fewer"
                            } else {
                                "and ${groups.finished.size - FINISHED_SHOWN} more at rest"
                            },
                            style = Type.note(p),
                            modifier = Modifier.padding(horizontal = 13.dp, vertical = 11.dp),
                        )
                    }
                }
            }
        }
        if (projects.isNotEmpty()) {
            item { GroupLabel("projects", modifier = Modifier.padding(top = 14.dp, bottom = 6.dp)) }
            item {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = 20.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    projects.forEach { project ->
                        Pill(
                            text = project.name,
                            selected = project.name == projectFilter,
                            onClick = { onProject(if (project.name == projectFilter) "" else project.name) },
                            leading = { StatusDot(project.dot, breathing = false) },
                            trailing = project.count.toString(),
                        )
                    }
                }
            }
        }
    }
}

/** One conversation in the roster. Flat on the page, not a card: the only wash
 *  is the warm one a card that needs you wears, from the left, because that is
 *  the one row the page is asking you to stop at. */
@Composable
private fun CardRow(card: CardDigest, tall: Boolean, onClick: () -> Unit) {
    val p = LocalPalette.current
    val needs = card.asks > 0 || card.notices > 0
    val shape = RoundedCornerShape(15.dp)
    Box(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp)
            .clip(shape)
            .then(
                if (needs) {
                    Modifier.background(
                        Brush.horizontalGradient(
                            0f to p.ask.copy(alpha = 0.13f),
                            0.8f to Color.Transparent,
                        ),
                    )
                } else {
                    Modifier
                },
            )
            .then(pressable(onClick, shape, tint = p.surface.copy(alpha = 0.45f))),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(if (tall) 66.dp else 58.dp)
                .padding(start = 11.dp, end = 13.dp, top = 9.dp, bottom = 9.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StatusDot(card.dot(), breathing = card.working)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        card.word(),
                        style = Type.rowTitle(p, if (needs) p.paper else p.paperDim),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.width(8.dp))
                    Text(card.trailing(), style = Type.meta(p), maxLines = 1)
                }
                Spacer(Modifier.height(2.dp))
                Text(
                    card.subline(),
                    style = Type.note(p, if (needs) lerp(p.ask, p.paperDim, 0.52f) else p.note),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/** The foot of the roster: who this phone is, and the one way from here to the
 *  settings that make it so. */
@Composable
private fun Me(onSettings: () -> Unit) {
    val p = LocalPalette.current
    val sighting = NodeState.sighting
    Column(Modifier.fillMaxWidth()) {
        Hair(Modifier.padding(horizontal = 24.dp))
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp)
                .padding(top = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(32.dp)
                    .clip(CircleShape)
                    .drawWithCache {
                        val brush = Brush.radialGradient(
                            listOf(lerp(p.raised, p.paper, 0.10f), p.raised),
                            center = Offset(size.width * 0.30f, size.height * 0.25f),
                            radius = size.maxDimension * 0.9f,
                        )
                        onDrawBehind { drawRect(brush) }
                    }
                    .border(1.5.dp, p.edge, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    Config.name.take(1).uppercase().ifEmpty { "·" },
                    style = Type.label(p, p.paper, 13f).copy(fontWeight = FontWeight.SemiBold),
                )
            }
            Spacer(Modifier.width(11.dp))
            Column(Modifier.weight(1f)) {
                Text(Config.name.ifEmpty { "this phone" }, style = Type.label(p, p.paper, 14f), maxLines = 1)
                Spacer(Modifier.height(1.dp))
                Text(
                    if (sighting != null) {
                        "${sighting.host.ifEmpty { Config.host }} · on the flyway"
                    } else {
                        "not on the flyway yet"
                    },
                    style = Type.meta(p, p.note, 12f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            IconBtn(Glyph.Gear, "settings", onSettings, size = 40.dp)
        }
    }
}

/** A centred state — dialing, an error, no key — in the same quiet voice as the
 *  rest of the page, with one thing to do under it. */
@Composable
private fun Stood(
    kind: DotKind,
    title: String,
    note: String,
    action: @Composable () -> Unit,
) {
    val p = LocalPalette.current
    Column(
        Modifier.fillMaxSize().padding(horizontal = 30.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        StatusDot(kind, breathing = kind == DotKind.Work)
        Spacer(Modifier.height(14.dp))
        Text(title, style = Type.label(p, p.paper, 15f))
        Spacer(Modifier.height(5.dp))
        Text(note, style = Type.note(p), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        Spacer(Modifier.height(18.dp))
        action()
    }
}

/** How many at-rest cards the roster shows before folding the rest behind one
 *  line. A wall left up for days carries dozens, and a phone that lists them
 *  all has buried today under last month. */
private const val FINISHED_SHOWN = 8

/** The plan the gate's debug seed stands in with — the design's own example,
 *  so the photograph is of the layout the mockup specifies. Debug only. */
private fun previewPlan() = PendingPlan(
    id = "preview",
    reads = "open a card for the orchard migration, and brief it from the plan",
    steps = listOf(
        PlanStep("spawn", "open a card", "project caravan"),
        PlanStep("prompt", "send it the plan", "the orchard note · 2 files"),
        PlanStep("—", "leave the old card open", "nothing is closed"),
    ),
    heard = "open a card for the orchard migration, and brief it from the plan",
)

/* ── a card's page ──────────────────────────────────────────────────────── */

@Composable
private fun CardScreen(
    card: CardDigest?,
    onBack: () -> Unit,
    onViewer: () -> Unit,
    ears: Ears,
) {
    val p = LocalPalette.current
    if (card == null) {
        Column(
            Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.statusBars)
                .windowInsetsPadding(WindowInsets.navigationBars),
        ) {
            Row(Modifier.height(64.dp).padding(start = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                IconBtn(Glyph.Back, "back", onBack)
            }
            Stood(
                kind = DotKind.Rest,
                title = "this card is not on the wall",
                note = "it may have closed, or the phone may be reading another wall now.",
            ) { ActionButton("back to the roster", onBack) }
        }
        return
    }

    Column(
        Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.statusBars)
            .windowInsetsPadding(WindowInsets.navigationBars),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(64.dp)
                .padding(start = 8.dp, end = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconBtn(Glyph.Back, "back", onBack)
            Spacer(Modifier.width(4.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusDot(card.dot(), breathing = card.working)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        card.word(),
                        style = Type.headTitle(p),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Spacer(Modifier.height(3.dp))
                Text(
                    card.headLine(),
                    style = Type.meta(p, p.note, 12f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            ContextRing(card.ctx, faint = card.dormant)
            IconBtn(Glyph.Picture, "look at a file or picture", onViewer)
        }

        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(start = 18.dp, end = 18.dp, top = 2.dp, bottom = 104.dp),
        ) {
            item { Spacer(Modifier.height(8.dp)) }
            if (card.said.isNotEmpty()) {
                item {
                    Text(
                        card.said,
                        style = Type.prose(p),
                        modifier = Modifier.fillMaxWidth().padding(bottom = 14.dp),
                    )
                }
            }
            if (card.doing.isNotEmpty()) {
                item { Doing(card) }
            }
            item { Spacer(Modifier.height(14.dp)) }
            item { Machinery(card) }
            if (card.asks > 0 || card.notices > 0) {
                item { Spacer(Modifier.height(14.dp)) }
                item { Waiting(card, ears) }
            }
            item {
                Text(
                    "the phone reads the wall's digest — the thread itself stays on the wall.",
                    style = Type.note(p),
                    modifier = Modifier.padding(top = 18.dp),
                )
            }
        }
    }
}

/** What the card is doing now, in the machinery's own card: live while the
 *  turn runs, its border warmed by the working colour. */
@Composable
private fun Doing(card: CardDigest) {
    val p = LocalPalette.current
    val shape = RoundedCornerShape(16.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(p.surface.copy(alpha = 0.55f))
            .border(1.dp, if (card.working) p.work.copy(alpha = 0.30f) else p.hair, shape),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 13.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Glyph.Terminal, tint = p.paperMute, size = 16.dp)
            Spacer(Modifier.width(10.dp))
            Text(
                card.doing,
                style = Type.label(p, if (card.working) p.paper else p.paperDim, 13.5f),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (card.working) {
                Spacer(Modifier.width(10.dp))
                StatusDot(DotKind.Work)
            }
        }
    }
}

/** The card's figures, folded into one quiet plate: what the wall publishes
 *  about it, which is all this phone has of it. */
@Composable
private fun Machinery(card: CardDigest) {
    val p = LocalPalette.current
    val shape = RoundedCornerShape(16.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(p.surface.copy(alpha = 0.55f))
            .border(1.dp, p.hair, shape),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 13.dp, vertical = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Glyph.Terminal, tint = p.paperMute, size = 16.dp)
            Spacer(Modifier.width(10.dp))
            Text("what the wall says", style = Type.label(p, p.paper, 13.5f), modifier = Modifier.weight(1f))
            Text(card.model ?: "—", style = Type.mono(p, 12f, p.note))
        }
        Fact("state", card.stateWord())
        Fact("turns", card.turns?.toString() ?: "—")
        Fact("context", card.ctx?.let { "${(it * 100).roundToInt()}% full" } ?: "—")
        Fact(
            "cost",
            card.costUsd?.let { String.format(java.util.Locale.ROOT, "$%.2f", it) } ?: "—",
        )
        if (card.jobs > 0) Fact("jobs", card.jobs.toString())
        if (card.asks > 0) Fact("questions", card.asks.toString())
        if (card.notices > 0) Fact("notices", card.notices.toString())
    }
}

@Composable
private fun Fact(key: String, value: String) {
    val p = LocalPalette.current
    Hair()
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 13.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(key, style = Type.note(p), modifier = Modifier.weight(1f))
        Text(value, style = Type.mono(p, 12f, p.paperDim))
    }
}

/** What is waiting on a person: a parked question (answerable here, by voice,
 *  once it has been read out and the phone is listening for its answer) or a
 *  notice the card has put up. */
@Composable
private fun Waiting(card: CardDigest, ears: Ears) {
    val p = LocalPalette.current
    val shape = RoundedCornerShape(15.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(p.ask.copy(alpha = 0.10f))
            .border(1.dp, p.ask.copy(alpha = 0.30f), shape)
            .padding(horizontal = 15.dp, vertical = 13.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            StatusDot(DotKind.Ask, breathing = false)
            Spacer(Modifier.width(9.dp))
            Text(
                if (card.asks > 0) {
                    "${card.asks} ${if (card.asks == 1) "question" else "questions"} waiting"
                } else {
                    "a notice is waiting"
                },
                style = Type.label(p, p.paper, 14f),
            )
        }
        Spacer(Modifier.height(6.dp))
        Text(
            when {
                card.asks > 0 && ears.steer.awaitingQuestion ->
                    "the phone is listening for its answer — hold the orb, or start it here."
                card.asks > 0 -> "it is read out when the phone next narrates, and then the next sentence is its answer."
                else -> "a card that finished or gave up says so; it is read out with the next narration."
            },
            style = Type.note(p),
        )
        if (card.asks > 0 && ears.steer.awaitingQuestion) {
            Spacer(Modifier.height(11.dp))
            ActionButton(
                "answer aloud",
                onClick = { ears.voice.startSeamless() },
                primary = true,
            )
        }
    }
}

/* ── narration: the digest→speech loop ─────────────────────────────────── */

/** Sight the wall and speak its changes, only while this screen is shown.
 *  `repeatOnLifecycle(RESUMED)` is the gate: the block runs once on every
 *  return to the front (so a reopen narrates what changed while away, against
 *  the persisted digest) and then on a modest cadence, and it is cancelled the
 *  moment the screen stops being shown.
 *
 *  **`chatty = off` silences, it does not stop the poll.** The poll is also the
 *  only thing that walks to another wall when the one the phone was on goes
 *  off; gating it on a speech setting left `Ears` and `Steer` addressing a dead
 *  laptop until somebody pressed dial. What is said, and whether a question
 *  opens the ears, is gated in `sightAndNarrate` instead. */
@Composable
private fun NarrationLoop(context: Context, host: String, chatty: String, mode: String, steer: Steer, onNeedsYou: () -> Unit) {
    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(host, chatty, mode) {
        /* The walk runs at every level, but a phone set to say nothing does not
           bind a speech engine it will never use. */
        if (chatty != "off") Speaker.init(context)
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            try {
                narrateOnce(context, host, chatty, steer, onNeedsYou)
                while (true) {
                    delay(NARRATION_CADENCE_MS)
                    narrateOnce(context, host, chatty, steer, onNeedsYou)
                }
            } finally {
                // Leaving the screen cancels this block; a needs_you line still
                // mid-speech must not open the ears on another screen.
                Speaker.onQuiet = null
            }
        }
    }
}

/** One poll, folded against the persisted digest and spoken. The blocking JNI
 *  calls and the store read/write run off the main thread; [Speaker.speak] is
 *  back on it, where `TextToSpeech` is happiest. A turn that needs her ducks
 *  her music for the line, then hands the caller `onNeedsYou` once the words
 *  are out of the air. */
private suspend fun narrateOnce(context: Context, host: String, chatty: String, steer: Steer, onNeedsYou: () -> Unit) {
    val prev = withContext(Dispatchers.IO) { NarrationStore.load(context) }
    val turn = sightAndNarrate(host, Config.rememberedJson(), prev, chatty) ?: return
    if (turn.lines.isNotEmpty()) {
        Log.i("PhoneNarration", "spoke ${turn.lines.size} line(s): ${turn.lines.joinToString(" · ") { it.text }}")
    }
    for (line in turn.lines) {
        // A question with a parked id arms the answer *before* it is spoken, so
        // the seamless window that follows (and the hold in push-to-talk)
        // knows the next transcript is the answer, not a command.
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
