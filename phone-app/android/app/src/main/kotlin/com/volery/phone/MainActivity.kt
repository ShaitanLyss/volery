package com.volery.phone

import android.content.Intent
import android.os.Build
import android.os.Bundle
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.roundToInt

/**
 * Home: the roster and a card's page, as one room.
 *
 * The desktop's wall is many cards at once; a phone is one column, so the
 * roster is chat view's sidebar: what waits on you, then needs you, working,
 * finished, and the projects as a strip. A card opens in place rather than in a
 * second activity, and the top of the roster is every parked prompt answerable
 * without opening one. The voice rail is drawn above both, on the parent, so
 * there is one rail and one set of ears however deep the page is. The ears and
 * the narration loop belong to the foreground service (`Narrator`), not to this
 * screen, which is why a question can be heard with the phone in a pocket.
 *
 * The card's page is the digest read in the thread's own visual language: the
 * prompts the card is waiting on, what it last said in the book's face, the
 * machinery folded into one quiet card, and the pool of its status at the foot.
 * The prose that led to a prompt is pulled on demand through the flyway's
 * `tail`; the transcript itself stays on the wall.
 */
class MainActivity : ComponentActivity() {
    /** Debug-only: `--ez phone.seedGate true` raises the gate with a
     *  representative plan. It exists so the gate can be photographed (and a
     *  lab can drive it) against a wall too old to answer `Steward`; nothing in
     *  the app reaches it, and a release build ignores it. */
    companion object {
        const val EXTRA_SEED_GATE = "phone.seedGate"
        /** The same affordance for what waits on a person: four representative
         *  prompts (a question, a delete, a pull request, a notice) stand in for
         *  a parked card so the roster and a card's page can be photographed
         *  without one on the flyway. Debug builds and an explicit extra. */
        const val EXTRA_SEED_PROMPTS = "phone.seedPrompts"
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
        /* The first launch opens on the six slides, over the roster. Shown
           rather than hidden until settings is found — the report was that
           nobody knew what the app was for — and marked seen here, so a skip or
           an interrupted read does not present it again. Settings reopens it. */
        if (!Config.tutorialSeen) {
            Config.tutorialSeen = true
            Config.persistTutorial()
            startActivity(Intent(this, TutorialActivity::class.java))
        }
        val seedGate = BuildConfig.DEBUG && intent.getBooleanExtra(EXTRA_SEED_GATE, false)
        val seedPrompts = BuildConfig.DEBUG && intent.getBooleanExtra(EXTRA_SEED_PROMPTS, false)
        setContent {
            VoleryTheme(theme = Config.theme, motion = Config.motion) {
                VoleryPhone(seedGate = seedGate, seedPrompts = seedPrompts)
            }
        }
    }
}

@Composable
private fun VoleryPhone(seedGate: Boolean = false, seedPrompts: Boolean = false) {
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
            NodeService.dial(context, Config.firstDoor(), Config.walkJson(), Config.key, Config.name)
        }
    }

    /* The narration loop is the foreground service's, not this screen's — see
       `Narration`, which is why a question can be heard with the phone in a
       pocket. This screen only draws what that loop has landed. */

    // The gate's preview seed (debug builds, explicit extra). It is a fold over
    // the same state a real plan sets, so what is photographed is the gate the
    // wall's plan would raise, not a mock of one.
    LaunchedEffect(seedGate) {
        if (seedGate) steer.seedForPreview(previewPlan())
    }
    LaunchedEffect(seedPrompts) {
        if (seedPrompts) {
            /* Attached to the first card the wall actually published, so
               "open the card" lands on a real page and the context fetch has a
               real conversation behind it. The ids are still the seed's and
               answer nothing. */
            val first = NodeState.sighting?.cards?.cards?.firstOrNull()
            NodeState.seedForPreview(
                previewPrompts().map { p ->
                    if (first == null) p else p.copy(card = first.id, title = first.title)
                },
            )
        }
    }

    val cards = sighting?.cards?.cards ?: emptyList()
    val open = if (openId.isNotEmpty()) cards.firstOrNull { it.id == openId } else null
    val plan = steer.pending

    /* Answering by tap is the same wire the spoken answer takes: a prompt's
       `answers` is the id its wall reads, and a sheet of picks is composed by
       the bridge in the shape an agent expects. */
    val prompts = NodeState.prompts
    val isSent: (String) -> Boolean = { answers -> steer.isSent(answers) }
    val answerPicks = { prompt: PromptRow, picks: List<String> -> steer.answerPicks(prompt, picks) }
    val acknowledge = { prompt: PromptRow ->
        steer.answerPrompt(prompt.host, prompt.card, prompt.answers, prompt.ack)
    }

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
                        prompts = prompts,
                        isSent = isSent,
                        onPicks = answerPicks,
                        onAck = acknowledge,
                    )
                } else {
                    RosterScreen(
                        sighting = sighting,
                        working = working,
                        error = error,
                        host = selectedHost,
                        projectFilter = projectFilter,
                        prompts = prompts,
                        isSent = isSent,
                        onHost = { host ->
                            Config.host = host
                            Config.persistWalls()
                            NodeService.sight(context, host)
                        },
                        onProject = { projectFilter = it },
                        onOpen = { openId = it },
                        onPicks = answerPicks,
                        onAck = acknowledge,
                        onSettings = { context.open(Intent(context, SettingsActivity::class.java)) },
                        onDial = {
                            NodeService.dial(context, Config.firstDoor(), Config.walkJson(), Config.key, Config.name)
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

/**
 * One quiet line when the walking mode is not actually on.
 *
 * Lyss's report was not that the feature was broken but that she could not find
 * the state where a question reaches her ear: the listening mode, the chatty
 * level and the microphone permission are three settings on two screens, and
 * only one of them was ever asked for (by holding the orb). So when the three
 * do not add up, the roster says so, in the same quiet sentence the rest of the
 * app uses, and one tap goes where they are set.
 */
@Composable
private fun HandsFreeHint(onSettings: () -> Unit) {
    val p = LocalPalette.current
    val context = LocalContext.current
    val mic = context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) ==
        android.content.pm.PackageManager.PERMISSION_GRANTED
    if (Config.mode == "seamless" && Config.chatty != "off" && mic) return
    /* Three conditions compose this mode, and each missing one fails
       differently: no microphone means nothing can hear you, `off` means
       nothing is said, and push-to-talk means it is said but cannot be
       answered without touching the phone. The line says which one it is
       rather than calling them all "off". */
    val said = when {
        !mic -> "hands-free needs the microphone — turn it on"
        Config.chatty == "off" -> "the phone is set to say nothing — questions are not read aloud. turn the voice on"
        else -> "questions are read aloud, but answering needs the phone in your hand. turn on hands-free"
    }
    val shape = RoundedCornerShape(13.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp)
            .padding(bottom = 6.dp)
            .then(pressable(onSettings, shape, tint = p.surface.copy(alpha = 0.35f)))
            .padding(horizontal = 13.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Glyph.Bird, tint = p.paperMute, size = 15.dp)
        Spacer(Modifier.width(10.dp))
        Text(said, style = Type.note(p), modifier = Modifier.weight(1f))
        Icon(Glyph.ChevronRight, tint = p.paperFaint, size = 16.dp)
    }
}

@Composable
private fun RosterScreen(
    sighting: Sighting?,
    working: Boolean,
    error: String?,
    host: String,
    projectFilter: String,
    prompts: List<PromptRow>,
    isSent: (String) -> Boolean,
    onHost: (String) -> Unit,
    onProject: (String) -> Unit,
    onOpen: (String) -> Unit,
    onPicks: (PromptRow, List<String>) -> Unit,
    onAck: (PromptRow) -> Unit,
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
        HandsFreeHint(onSettings = onSettings)
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                sighting != null -> RosterList(
                    sighting = sighting,
                    projectFilter = projectFilter,
                    prompts = prompts,
                    isSent = isSent,
                    onProject = onProject,
                    onOpen = onOpen,
                    onPicks = onPicks,
                    onAck = onAck,
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
                host.isNotBlank() -> Stood(
                    kind = DotKind.Work,
                    title = "dialing $host…",
                    note = "the flyway takes a moment to answer.",
                ) { ActionButton("dial again", onDial) }
                else -> Stood(
                    kind = DotKind.Work,
                    title = "looking for a wall…",
                    note = "asking the flyway's directory. a wall has to be up somewhere.",
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
        if (chosen == null && selected.isNotBlank()) {
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
    prompts: List<PromptRow>,
    isSent: (String) -> Boolean,
    onProject: (String) -> Unit,
    onOpen: (String) -> Unit,
    onPicks: (PromptRow, List<String>) -> Unit,
    onAck: (PromptRow) -> Unit,
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
        /* What waits on you, before the cards: a question, a delete or a pull
           request is the reason to have opened the phone, and the row that can
           be answered is the one that does not need the card opened at all.
         *
         * **Always present, with a key.** It draws nothing when nothing waits,
         * but it must occupy index 0 from the first frame: a list that anchors
         * to its first item had already laid out without this one, and when a
         * poll brought thirteen questions in the section was drawn above the
         * viewport — the roster opening on "needs you" while everything that
         * needed you was one scroll up. */
        item(key = "waiting") {
            WaitingOnRoster(
                prompts = prompts,
                isSent = isSent,
                onPicks = onPicks,
                onAck = onAck,
                onOpen = onOpen,
            )
        }
        if (groups.needs.isNotEmpty()) {
            item { GroupLabel("needs you", groups.needs.size, Modifier.padding(top = 10.dp, bottom = 2.dp)) }
            items(groups.needs, key = { it.id }) { card ->
                CardRow(card, tall = true, onClick = { onOpen(card.id) })
            }
        }
        if (groups.working.isNotEmpty()) {
            item { GroupLabel("working", groups.working.size, Modifier.padding(top = 10.dp, bottom = 2.dp)) }
            items(groups.working, key = { it.id }) { card ->
                CardRow(card, tall = true, onClick = { onOpen(card.id) })
            }
        }
        if (groups.finished.isNotEmpty()) {
            item { GroupLabel("finished", groups.finished.size, Modifier.padding(top = 10.dp, bottom = 2.dp)) }
            // A wall left up for days carries dozens of dormant cards; a phone
            // that lists them all has buried today under last month. Eight, and
            // then it says how many more are at rest — one tap to open them all.
            val shown = if (finishedOpen) groups.finished else groups.finished.take(FINISHED_SHOWN)
            items(shown, key = { it.id }) { card ->
                CardRow(card, tall = false, onClick = { onOpen(card.id) })
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

/** What the prompt seed stands in with: one of each kind Volery draws, so a
 *  photograph shows the four registers rather than four copies of one. Debug
 *  only, and the ids name nothing on any wall — pressing one sends nothing. */
private fun previewPrompts(): List<PromptRow> = listOf(
    PromptRow(
        host = "preview",
        card = "preview-caravan",
        title = "caravan",
        kind = "question",
        answers = "preview-ask",
        waitedMs = 4 * 60_000,
        blocking = true,
        startsWork = true,
        questions = listOf(
            PromptQuestion(
                header = "the migration",
                body = "The nullable column is the blocker. Do I widen it in place, which locks the " +
                    "table for about four minutes, or add the new column beside it and write to both " +
                    "until the backfill lands?",
                shows = false,
                options = listOf(
                    PromptChoice("widen in place", "four minutes of writes blocked, one migration"),
                    PromptChoice("add beside it", "no lock, two weeks of writing to both"),
                    PromptChoice("stop and write it up", "nothing moves today"),
                ),
            ),
        ),
        ack = "",
    ),
    PromptRow(
        host = "preview",
        card = "preview-orchard",
        title = "orchard",
        kind = "delete",
        answers = "preview-remove",
        waitedMs = 11 * 60_000,
        blocking = true,
        startsWork = false,
        questions = listOf(
            PromptQuestion(
                header = "delete on AU-LT-285",
                body = "A card on AU-LT-285 wants to delete this, on AU-LT-285's disk, not this phone's.\n\n" +
                    "C:/atelier/rise/build\n\na directory, 5.0 MB in 40 files\noutside the card's own working tree\n" +
                    "not in a git work tree, nothing here comes back from a commit\n\n" +
                    "Its reason: the build directory is stale\n\nThis is permanent.",
                shows = false,
                options = listOf(
                    PromptChoice("delete it", "Gone for good, from AU-LT-285."),
                    PromptChoice("keep it", "Nothing is touched."),
                ),
            ),
        ),
        ack = "",
    ),
    PromptRow(
        host = "preview",
        card = "preview-hold",
        title = "hold",
        kind = "confirm",
        answers = "preview-pr",
        waitedMs = 26 * 60_000,
        blocking = true,
        startsWork = false,
        questions = listOf(
            PromptQuestion(
                header = "open a draft pull request on AU-LT-285",
                body = "A card on AU-LT-285 wants to open a draft pull request.\n\nrepository: rise/tx-toolkit\n" +
                    "from: fix/queue-receipt to main\n\nIts reason: the receipt race is proven and green\n\n" +
                    "Nothing happens on this phone.",
                shows = false,
                options = listOf(
                    PromptChoice("open it", "A draft, on the wall's own credential."),
                    PromptChoice("not now", "The branch is kept."),
                ),
            ),
        ),
        ack = "",
    ),
    PromptRow(
        host = "preview",
        card = "preview-caravan",
        title = "caravan",
        kind = "notice",
        answers = "notice:preview-n1",
        waitedMs = 2 * 60_000,
        blocking = false,
        startsWork = true,
        questions = listOf(
            PromptQuestion(
                header = "",
                body = "Finished. The parser change is in and the three suites are green; I left the " +
                    "benchmark alone because it was not what you asked about.",
                shows = false,
                options = emptyList(),
            ),
        ),
        ack = "acknowledged",
    ),
)

/* ── a card's page ──────────────────────────────────────────────────────── */

@Composable
private fun CardScreen(
    card: CardDigest?,
    onBack: () -> Unit,
    onViewer: () -> Unit,
    prompts: List<PromptRow>,
    isSent: (String) -> Boolean,
    onPicks: (PromptRow, List<String>) -> Unit,
    onAck: (PromptRow) -> Unit,
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
            /* The question comes before the machinery. It is the reason the
               page was opened, and the figures are what you read while waiting
               for an answer, not the other way round. */
            if (prompts.any { it.card == card.id }) {
                item { Spacer(Modifier.height(2.dp)) }
                item {
                    PromptsOnCard(
                        card = card.id,
                        prompts = prompts,
                        isSent = isSent,
                        onPicks = onPicks,
                        onAck = onAck,
                    )
                }
            }
            if (card.doing.isNotEmpty()) {
                item { Spacer(Modifier.height(12.dp)) }
                item { Doing(card) }
            }
            item { Spacer(Modifier.height(14.dp)) }
            item { Machinery(card) }
            item {
                Text(
                    "the phone reads the wall's digest. what waits on you is drawn in full; " +
                        "what led to it is a tap away, and the thread itself stays on the wall.",
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

