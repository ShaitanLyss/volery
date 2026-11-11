package com.volery.phone

import android.Manifest
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Settings: the phone's one page of choices, in the order they matter — the
 * look and how much of it moves, how it listens, how much it says, and the
 * three fields that join this phone to a wall.
 *
 * There is no save button. A segmented choice is made and it is; a field is
 * kept with "keep it" inside its own sheet, so the keyboard only covers the one
 * line being typed. The key phrase is the exception to everything stored: it
 * lives in memory for the life of the process and [Config.persist] never sees
 * it, which is why the row that shows it shows only its first six characters.
 */
class SettingsActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { SettingsScreen(onBack = { finish() }) }
    }
}

/** The theme is applied here rather than at the activity, so choosing a ground
 *  inside the sheet recolours the page under it in the same frame. */
@Composable
private fun SettingsScreen(onBack: () -> Unit) {
    VoleryTheme(theme = Config.theme, motion = Config.motion) {
        SettingsContent(onBack)
    }
}

@Composable
private fun SettingsContent(onBack: () -> Unit) {
    val context = LocalContext.current
    val ears = rememberEars()
    var typing by remember { mutableStateOf(false) }
    // Which sheet is up: the theme list, or one of the three flyway fields.
    // One at a time — a second sheet replacing the first is the only thing a
    // tap on a covered row could do anyway.
    var sheet by remember { mutableStateOf<String?>(null) }

    Ground {
        Column(Modifier.fillMaxSize()) {
            Head(onBack)
            Box(Modifier.fillMaxWidth().weight(1f)) {
                SettingsBody(onOpen = { sheet = it })
                VoiceRail(
                    ears.voice,
                    ears.steer.status,
                    onType = { typing = true },
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .windowInsetsPadding(WindowInsets.navigationBars)
                        .padding(horizontal = 16.dp)
                        .padding(bottom = 26.dp),
                )
            }
        }

        when (sheet) {
            "theme" -> ThemeSheet(
                current = Config.theme,
                onPick = {
                    Config.theme = it
                    Config.persist()
                    sheet = null
                },
                onDismiss = { sheet = null },
            )
            "key" -> FieldSheet(
                title = "key phrase",
                label = "paste the invite, or the phrase the wall knows you by",
                value = Config.key,
                mono = true,
                masked = true,
                onKeep = {
                    /* Kept wrapped by the Keystore, and dialled at once: a
                       phrase you typed and then had to go and find a redial
                       for is a phrase you would type twice. An invite in the
                       wall's own shape also fills the preferred wall. */
                    Config.keepKey(context, it)
                    if (Config.key.isNotEmpty()) {
                        NodeService.dial(
                            context,
                            Config.firstDoor(),
                            Config.walkJson(),
                            Config.key,
                            Config.name,
                        )
                    }
                },
                onDismiss = { sheet = null },
            )
            "host" -> FieldSheet(
                title = "preferred wall",
                label = "the wall to try first, if you like",
                value = Config.preferred,
                mono = true,
                onKeep = {
                    Config.preferred = it.trim()
                    Config.persist()
                    /* A preference takes effect now, not at the next launch:
                       redial from the wall it names, and the walk falls to
                       the directory when that wall is off. */
                    if (Config.key.isNotEmpty()) {
                        NodeService.dial(context, Config.firstDoor(), Config.walkJson(), Config.key, Config.name)
                    }
                },
                onDismiss = { sheet = null },
            )
            "name" -> FieldSheet(
                title = "this phone",
                label = "what the wall calls it",
                value = Config.name,
                onKeep = {
                    Config.name = it
                    Config.persist()
                },
                onDismiss = { sheet = null },
            )
        }

        EarsOverlay(ears = ears, typing = typing, onTyping = { typing = it })
    }
}

/* ── the head ───────────────────────────────────────────────────────────── */

/** A back button and the name, in the display serif. No bar, no elevation: the
 *  head is the top of the page, not a surface laid over it. */
@Composable
private fun Head(onBack: () -> Unit) {
    val p = LocalPalette.current
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 62.dp)
            .windowInsetsPadding(WindowInsets.statusBars)
            .padding(start = 8.dp, end = 20.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconBtn(Glyph.Back, "back", onBack)
        Spacer(Modifier.width(8.dp))
        Text("settings", style = Type.display(p, 31f), maxLines = 1)
    }
}

/* ── the body ───────────────────────────────────────────────────────────── */

@Composable
private fun SettingsBody(onOpen: (String) -> Unit) {
    val p = LocalPalette.current
    val context = LocalContext.current
    Column(
        Modifier
            .fillMaxSize()
            .fadeAtTheFoot()
            .verticalScroll(rememberScrollState())
            .windowInsetsPadding(WindowInsets.navigationBars)
            .padding(horizontal = 18.dp)
            .padding(bottom = 112.dp),
    ) {
        Section("the look")
        Group {
            SettingRow("theme", onClick = { onOpen("theme") }) {
                Swatch(paletteFor(Config.theme), 13.dp)
                Text(Config.theme, style = Type.label(p, p.paper, 13.5f), maxLines = 1)
            }
            RowNote("studio is volery's own, and what the phone starts on. vellum is studio by day.")
            Control(
                label = "motion",
                note = "full, quietly stepped, or not at all.",
                options = listOf("full" to "full", "spare" to "spare", "still" to "still"),
                selected = Config.motion,
                onSelect = {
                    Config.motion = it
                    Config.persist()
                },
            )
        }

        Section("the ears")
        Group {
            Control(
                label = "how it listens",
                note = modeNote(Config.mode),
                options = listOf(
                    "push-to-talk" to "hold to talk",
                    "hey-volery" to "hey volery",
                    "seamless" to "seamless",
                ),
                selected = Config.mode,
                onSelect = {
                    Config.mode = it
                    Config.persist()
                },
                enabled = { it != "hey-volery" },
            )
        }

        /* The one combination that makes the walking mode true, stated as one
           choice rather than three settings somebody has to discover add up to
           it. Lyss could not find the path: the ears were a listening mode, the
           mouth was a chatty level, and the microphone was a permission nobody
           had been asked for because only the orb asks. */
        Section("hands-free")
        Group {
            val context = LocalContext.current
            val ears = rememberEars()
            var mic by remember { mutableStateOf(ears.voice.hasMic()) }
            val askMic = rememberLauncherForActivityResult(
                ActivityResultContracts.RequestPermission(),
            ) { granted ->
                mic = granted
                /* The foreground service's microphone type can only be added
                   while this screen is in front, which it is right now. */
                if (granted) NodeService.promote(context)
            }
            val on = Config.mode == "seamless" && Config.chatty != "off" && mic
            SettingRow(
                "ask me out loud",
                onClick = {
                    /* Turning it on sets the pair and asks for the microphone;
                       it never turns a deliberate `off` into noise unless the
                       row is what turned the voice on. */
                    if (on) {
                        Config.mode = "push-to-talk"
                        Config.persist()
                    } else {
                        Config.mode = "seamless"
                        if (Config.chatty == "off") Config.chatty = "needs"
                        Config.persist()
                        if (!mic) askMic.launch(Manifest.permission.RECORD_AUDIO)
                        /* Always, not only on the grant path: the permission may
                           have been given in the system settings, in which case
                           the running service still carries data alone. */
                        NodeService.promote(context)
                    }
                },
            ) {
                StatusDot(if (on) DotKind.Work else DotKind.Rest, breathing = on)
                Text(if (on) "on" else "off", style = Type.label(p, if (on) p.paper else p.paperDim, 13.5f))
            }
            RowNote(
                if (on) {
                    "a card that needs you is read aloud, the music ducks, and the ears open when " +
                        "the words are done — answer in your own words without touching the phone. " +
                        "it works with the screen off."
                } else {
                    "turns on seamless listening and speaking what needs you, and asks for the " +
                        "microphone. with it off the phone still reads the wall and draws what waits; " +
                        "it does not listen for the answer."
                },
            )
            if (!mic) {
                Box(Modifier.padding(horizontal = 15.dp).padding(bottom = 12.dp)) {
                    ActionButton(
                        "allow the microphone",
                        onClick = { askMic.launch(Manifest.permission.RECORD_AUDIO) },
                        height = 44.dp,
                    )
                }
            } else if (on) {
                Box(Modifier.padding(horizontal = 15.dp).padding(bottom = 12.dp)) {
                    ActionButton(
                        "try it",
                        onClick = {
                            val voice = ears.voice
                            Speaker.init(context)
                            Speaker.speak("the ears are open. say something after this.")
                            val listen = { voice.startSeamless() }
                            if (Speaker.isSpeaking()) Speaker.onQuiet = listen else listen()
                        },
                        height = 44.dp,
                    )
                }
            }
        }

        Section("the mouth")
        Group {
            Control(
                label = "how much it says",
                note = chattyNote(Config.chatty),
                options = listOf(
                    "off" to "off",
                    "needs" to "what needs you",
                    "murmur" to "murmur",
                ),
                selected = Config.chatty,
                onSelect = {
                    Config.chatty = it
                    Config.persist()
                },
            )
            Seam()
            MusicRow(
                selected = Config.music,
                onSelect = {
                    Config.music = it
                    Config.persist()
                },
            )
        }

        Section("the flyway")
        Group {
            SettingRow("key phrase", onClick = { onOpen("key") }) {
                Text(
                    if (Config.key.isEmpty()) "not set" else Config.key.take(6) + "···",
                    style = Type.mono(p, 12.5f, p.paperDim),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Seam()
            SettingRow("preferred wall", onClick = { onOpen("host") }) {
                Text(
                    Config.preferred.ifEmpty { "any wall" },
                    style = Type.label(p, p.paper, 13.5f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Seam()
            SettingRow("this phone", onClick = { onOpen("name") }) {
                StatusDot(if (NodeState.working) DotKind.Work else DotKind.Done)
                Text(
                    if (NodeState.sighting != null) "${Config.name} · on the flyway"
                    else "${Config.name} · not dialed yet",
                    style = Type.label(p, p.paperDim, 12f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        Section("the guide")
        Group {
            SettingRow(
                "how to use volery",
                onClick = { context.startActivity(android.content.Intent(context, TutorialActivity::class.java)) },
            ) {
                Text("six slides", style = Type.meta(p, p.note, 12f))
            }
            RowNote("the introduction the first launch opens on. nothing here is only in it.")
        }

        About()
    }
}

/** A group heading: "the look", "the ears", small and quiet above its plate. */
@Composable
private fun Section(text: String) {
    val p = LocalPalette.current
    Text(
        text,
        style = Type.group(p),
        modifier = Modifier.padding(start = 4.dp, end = 4.dp, top = 12.dp, bottom = 6.dp),
    )
}

/** One plate of rows: an 18 dp corner, the surface at a third, one hairline
 *  round it. The rows inside carry no shape of their own — the plate clips. */
@Composable
private fun Group(content: @Composable ColumnScope.() -> Unit) {
    val p = LocalPalette.current
    val shape = RoundedCornerShape(18.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(p.surface.copy(alpha = 0.32f))
            .border(1.dp, p.hair, shape),
        content = content,
    )
}

/** The hairline between two rows — a step quieter than the plate's own edge. */
@Composable
private fun Seam() {
    val p = LocalPalette.current
    Box(Modifier.fillMaxWidth().height(1.dp).background(p.seam))
}

/**
 * One row: a key on the left taking whatever room is left, a value at the
 * trailing edge (capped so a long host cannot eat the key), and a chevron when
 * it opens something. The press lightens the row's face; nothing ripples.
 */
@Composable
private fun SettingRow(
    key: String,
    onClick: (() -> Unit)? = null,
    value: @Composable RowScope.() -> Unit,
) {
    val p = LocalPalette.current
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 50.dp)
            .then(
                pressable(
                    onClick,
                    RectangleShape,
                    tint = p.surface.copy(alpha = 0.55f),
                ),
            )
            .padding(horizontal = 15.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            key,
            style = Type.label(p, p.paperDim, 14f),
            modifier = Modifier.weight(1f),
            maxLines = 1,
        )
        Row(
            Modifier.widthIn(max = 200.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            value()
        }
        if (onClick != null) Icon(Glyph.ChevronRight, tint = p.paperFaint, size = 18.dp)
    }
}

/** A sentence under a row, saying what the thing above it is. */
@Composable
private fun RowNote(text: String) {
    val p = LocalPalette.current
    Text(
        text,
        style = Type.note(p),
        modifier = Modifier.padding(start = 15.dp, end = 15.dp, bottom = 13.dp),
    )
}

/** A labelled choice on its own track, with the meaning of the chosen one
 *  underneath — the shape every setting in the middle of this page takes. */
@Composable
private fun Control(
    label: String,
    note: String,
    options: List<Pair<String, String>>,
    selected: String,
    onSelect: (String) -> Unit,
    enabled: (String) -> Boolean = { true },
) {
    val p = LocalPalette.current
    Column(Modifier.fillMaxWidth().padding(horizontal = 15.dp, vertical = 12.dp)) {
        Text(label, style = Type.label(p, p.paperDim, 14f))
        Spacer(Modifier.height(11.dp))
        Segmented(options, selected, onSelect, enabled = enabled)
        Spacer(Modifier.height(9.dp))
        Note(note)
    }
}

/** What happens to your music while the phone speaks a line that needs you:
 *  ducked under it or paused for it, and back either way. It rides in the row
 *  rather than on a track of its own, so it reads as a modifier of "how much it
 *  says" — which is what it is. */
@Composable
private fun MusicRow(selected: String, onSelect: (String) -> Unit) {
    val p = LocalPalette.current
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 50.dp)
            .padding(horizontal = 15.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            "music",
            style = Type.label(p, p.paperDim, 14f),
            modifier = Modifier.weight(1f),
            maxLines = 1,
        )
        Segmented(
            options = listOf("duck" to "duck", "pause" to "pause"),
            selected = selected,
            onSelect = onSelect,
            modifier = Modifier.width(172.dp),
            compact = true,
        )
    }
}

/** The version and the two sentences that say what this thing is. Quiet on
 *  purpose: it is the last thing on the page and the least urgent. */
@Composable
private fun About() {
    val p = LocalPalette.current
    Column(Modifier.padding(start = 4.dp, end = 4.dp, top = 20.dp)) {
        Text(
            "volery ${BuildConfig.VERSION_NAME} · a flock on the flyway.",
            style = Type.note(p, p.paperDim),
        )
        Spacer(Modifier.height(4.dp))
        Text(
            "the phone hears and speaks; every plan is judged, and confirmed, on a wall.",
            style = Type.note(p, p.paperMute),
        )
        Spacer(Modifier.height(4.dp))
        Text(
            "the birds are lucide's and font awesome's, under their open licences " +
                "(assets/icons-license.txt).",
            style = Type.meta(p, p.paperFaint, 11f),
        )
    }
}

/* ── the sheets ─────────────────────────────────────────────────────────── */

/** The ground itself, as a choice: each one is a row with its own swatch, so
 *  picking one is looking at it. The swatch is the only colour in this file —
 *  it is the thing being chosen, not a tint on a control. */
@Composable
private fun ThemeSheet(current: String, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    VolerySheet(title = "the look", onDismiss = onDismiss) {
        PALETTES.forEachIndexed { i, (name, palette) ->
            if (i > 0) Spacer(Modifier.height(4.dp))
            ThemeChoice(name, palette, chosen = name == current) { onPick(name) }
        }
        Spacer(Modifier.height(12.dp))
        Note("studio is volery's own, and what the phone starts on. vellum is studio by day.")
        Spacer(Modifier.height(6.dp))
    }
}

@Composable
private fun ThemeChoice(name: String, palette: Palette, chosen: Boolean, onPick: () -> Unit) {
    val p = LocalPalette.current
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 46.dp)
            .then(
                pressable(
                    onPick,
                    RoundedCornerShape(13.dp),
                    tint = p.surface.copy(alpha = 0.55f),
                    role = Role.RadioButton,
                ),
            )
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Swatch(palette, 20.dp)
        Text(
            name,
            style = Type.label(p, if (chosen) p.paper else p.paperDim, 15f),
            modifier = Modifier.weight(1f),
        )
        if (chosen) Icon(Glyph.Check, tint = p.paper, size = 16.dp)
    }
}

/** A ground as a small circle of itself: lit from the same corner the page is,
 *  so studio reads warm-dark and vellum reads day. */
@Composable
private fun Swatch(palette: Palette, diameter: Dp) {
    val p = LocalPalette.current
    Box(
        Modifier
            .size(diameter)
            .clip(CircleShape)
            .drawWithCache {
                val colours = if (palette.light) {
                    listOf(palette.surface, palette.ground)
                } else {
                    listOf(lerp(palette.surface, palette.paper, 0.10f), palette.sheet)
                }
                val brush = Brush.radialGradient(
                    colours,
                    center = Offset(size.width * 0.35f, size.height * 0.30f),
                    radius = size.maxDimension * 0.85f,
                )
                onDrawBehind { drawRect(brush) }
            }
            .border(1.dp, p.edge, CircleShape),
    )
}

/** One flyway field: the line you came to type, and the one button that keeps
 *  it. Back, the scrim or "keep it" all close the sheet; the microphone behind
 *  it is covered while it is up, as it should be — this is a keyboard. */
@Composable
private fun FieldSheet(
    title: String,
    label: String,
    value: String,
    onKeep: (String) -> Unit,
    onDismiss: () -> Unit,
    mono: Boolean = false,
    masked: Boolean = false,
) {
    var draft by remember(value) { mutableStateOf(value) }
    val keep = {
        onKeep(draft.trim())
        onDismiss()
    }
    VolerySheet(title = title, onDismiss = onDismiss) {
        QuietField(
            value = draft,
            onValueChange = { draft = it },
            label = label,
            mono = mono,
            masked = masked,
            onDone = keep,
        )
        Spacer(Modifier.height(14.dp))
        ActionButton(
            "keep it",
            onClick = keep,
            modifier = Modifier.fillMaxWidth(),
            primary = draft.isNotBlank(),
        )
        Spacer(Modifier.height(6.dp))
    }
}

/* ── the copy ───────────────────────────────────────────────────────────── */

/** What each way of listening means, in the one sentence that matters: what
 *  the microphone is doing when you are not talking to it. */
private fun modeNote(value: String): String = when (value) {
    "seamless" -> "after something needs you, it listens on its own for a moment"
    "hey-volery" -> "not yet — the wake word would keep the microphone open"
    else -> "hold the orb and talk — nothing listens until you do"
}

/** How much of the wall's life becomes speech. */
private fun chattyNote(value: String): String = when (value) {
    "off" -> "nothing, even when a card is asking"
    "needs" -> "only what needs you — a card opened, a question waiting"
    "murmur" -> "everything notable — finishes, starts, notices too"
    else -> ""
}

/* ── the foot ───────────────────────────────────────────────────────────── */

/** The page dissolves into the ground before it reaches the rail, the way the
 *  mockup's mask does — content scrolling under an opaque rail would read as
 *  clipped rather than as continuing. */
private fun Modifier.fadeAtTheFoot(): Modifier = this
    .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
    .drawWithContent {
        drawContent()
        val h = size.height
        if (h <= 0f) return@drawWithContent
        val head = (6.dp.toPx() / h).coerceIn(0f, 1f)
        val start = (head.coerceAtLeast((h - 106.dp.toPx()) / h)).coerceIn(0f, 1f)
        val end = (start.coerceAtLeast((h - 78.dp.toPx()) / h)).coerceIn(0f, 1f)
        drawRect(
            brush = Brush.verticalGradient(
                0f to Color.Transparent,
                head to Color.Black,
                start to Color.Black,
                end to Color.Transparent,
            ),
            blendMode = BlendMode.DstIn,
        )
    }

