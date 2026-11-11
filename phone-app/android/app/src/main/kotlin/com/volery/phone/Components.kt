package com.volery.phone

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlin.random.Random

/**
 * The phone's chrome, in one file: everything more than one screen draws the
 * same way. These are deliberately not Material components wearing different
 * colours — a Material surface brings tonal elevation, a ripple and its own
 * padding with it, and the mockups have none of the three. What is shared here
 * is the substrate the screens stand on (ground, lamp, grain, pool), the quiet
 * light status is drawn as, the controls (press, icon button, pill, segmented,
 * sheet), and the voice rail that lives at the thumb on every screen.
 */

/* ── the ground ─────────────────────────────────────────────────────────── */

/** The grain the sheet is printed on: a turbulence field the mockups carry as
 *  an SVG filter, here a 160-unit bitmap generated once per process and
 *  tiled with soft-light. It is atmosphere, so it is the first thing taken
 *  away for a phone that has asked not to animate or has a light ground. */
private val grainBitmap: ImageBitmap by lazy {
    val n = 160
    val pixels = IntArray(n * n)
    val rng = Random(7)
    for (i in pixels.indices) {
        // Warm grey, alpha following the turbulence — the CSS feColorMatrix's
        // constant RGB with an alpha ramp, which is all soft-light reads.
        val a = (rng.nextFloat() * 0.55f * 255f).toInt().coerceIn(0, 255)
        pixels[i] = (a shl 24) or (128 shl 16) or (115 shl 8) or 102
    }
    val bmp = android.graphics.Bitmap.createBitmap(n, n, android.graphics.Bitmap.Config.ARGB_8888)
    bmp.setPixels(pixels, 0, n, 0, 0, n, n)
    bmp.asImageBitmap()
}

/**
 * The ground every screen stands on: the sheet's own gradient, the lamp
 * falling from above the head, an optional pool of the reading's status at the
 * foot, and the grain over all of it. Content goes on top.
 */
@Composable
fun Ground(
    modifier: Modifier = Modifier,
    poolTier: String? = null,
    content: @Composable BoxScope.() -> Unit,
) {
    val p = LocalPalette.current
    val motion = LocalMotion.current
    val pool = poolTier?.let { p.pool(it) }
    Box(
        modifier
            .fillMaxSize()
            .background(Brush.verticalGradient(listOf(p.groundTop, p.groundMid, p.groundBottom))),
    ) {
        Canvas(Modifier.matchParentSize()) {
            val w = size.width
            val h = size.height
            // --cv-lamp: 6% paper, an ellipse wider than the page, centred just
            // above the head. A circle at 0.9w reads the same at this strength.
            drawRect(
                Brush.radialGradient(
                    listOf(p.lamp, Color.Transparent),
                    center = Offset(w / 2f, -h * 0.06f),
                    radius = w * 0.9f,
                ),
            )
            // --pool-work / --pool-ask: the pool a live thread stands in.
            if (pool != null) {
                drawRect(
                    Brush.radialGradient(
                        listOf(pool, Color.Transparent),
                        center = Offset(w / 2f, h * 1.04f),
                        radius = w * 0.66f,
                    ),
                )
            }
            if (motion != MotionLevel.STILL) {
                drawRect(
                    brush = ShaderBrush(
                        androidx.compose.ui.graphics.ImageShader(
                            grainBitmap, TileMode.Repeated, TileMode.Repeated,
                        ),
                    ),
                    alpha = if (p.light) 0.30f else 0.50f,
                    blendMode = BlendMode.Softlight,
                )
            }
        }
        content()
    }
}

/* ── the press ──────────────────────────────────────────────────────────── */

/** A press that is a press, not a ripple: 90 ms to the scale and the tint, and
 *  back. Every tappable thing on the page goes through this or [IconBtn], so
 *  there is exactly one answer to "what happens when I touch it". */
@Composable
fun pressable(
    onClick: (() -> Unit)?,
    shape: androidx.compose.ui.graphics.Shape = RoundedCornerShape(15.dp),
    tint: Color? = null,
    scaleTo: Float = 0.986f,
    role: Role = Role.Button,
): Modifier {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val motion = LocalMotion.current
    val progress by animateFloatAsState(
        targetValue = if (pressed) 1f else 0f,
        animationSpec = tween(motion.duration(Motion.tap), easing = Motion.out),
        label = "press",
    )
    val base = if (onClick != null) {
        Modifier.clickable(
            interactionSource = interaction,
            indication = null,
            role = role,
            onClick = onClick,
        )
    } else {
        Modifier
    }
    val fill = tint ?: Color.Transparent
    return base
        .graphicsLayer {
            val s = 1f - (1f - scaleTo) * progress
            scaleX = s
            scaleY = s
        }
        .clip(shape)
        .background(fill.copy(alpha = fill.alpha * progress))
}

/** A chrome icon button: 44 dp, a 14 dp corner, and the press lightening its
 *  face to the surface's 70% — the mockups' `.iconbtn`. */
@Composable
fun IconBtn(
    glyph: Glyph,
    description: String,
    onClick: (() -> Unit)?,
    modifier: Modifier = Modifier,
    size: Dp = 44.dp,
    glyphSize: Dp = 18.dp,
    tint: Color? = null,
) {
    val p = LocalPalette.current
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val motion = LocalMotion.current
    val progress by animateFloatAsState(
        targetValue = if (pressed) 1f else 0f,
        animationSpec = tween(motion.duration(Motion.tap), easing = Motion.out),
        label = "iconpress",
    )
    val base = if (onClick != null) {
        Modifier.clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick)
    } else {
        Modifier
    }
    Box(
        modifier
            .size(size)
            .then(base)
            .clip(RoundedCornerShape(14.dp))
            .background(lerp(Color.Transparent, p.surface.copy(alpha = 0.70f), progress))
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            glyph,
            tint = tint ?: lerp(p.paperMute, p.paper, progress),
            size = glyphSize,
        )
    }
}

/* ── status: light, never a badge ───────────────────────────────────────── */

enum class DotKind { Work, Ask, Fail, Rest, Done, Chat }

/** A card's or a wall's state as a dot of light — breathing while it works,
 *  still while it asks, a hollow ring when it is finished, a smaller hollow
 *  one for a chat card. It is 16 dp of nothing most of the time, which is the
 *  point: status is a light on the page, not a coloured badge in a row. */
@Composable
fun StatusDot(
    kind: DotKind,
    modifier: Modifier = Modifier,
    faint: Boolean = false,
    breathing: Boolean = true,
) {
    val p = LocalPalette.current
    val motion = LocalMotion.current
    val colour = when (kind) {
        DotKind.Work -> p.work
        DotKind.Ask -> p.ask
        DotKind.Fail -> p.fail
        else -> p.rest
    }
    val alpha = if (faint) 0.4f else 1f
    val glow = when (kind) {
        DotKind.Work -> if (p.light) 0.30f else 0.55f
        DotKind.Ask -> if (p.light) 0.32f else 0.60f
        else -> 0f
    }
    val live = breathing && motion.ambient() && glow > 0f && kind == DotKind.Work
    val pulsing = if (live) {
        val t = rememberInfiniteTransition(label = "breathe")
        val a by t.animateFloat(
            initialValue = 0.25f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(2400), RepeatMode.Reverse),
            label = "breatheAlpha",
        )
        a
    } else {
        1f
    }

    Box(modifier.size(16.dp), contentAlignment = Alignment.Center) {
        if (glow > 0f) {
            Box(
                Modifier
                    .size(16.dp)
                    .background(
                        Brush.radialGradient(listOf(colour.copy(alpha = glow * pulsing), Color.Transparent)),
                        CircleShape,
                    ),
            )
        }
        when (kind) {
            DotKind.Done -> Box(
                Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .border(1.5.dp, p.paperMute.copy(alpha = alpha), CircleShape),
            )
            DotKind.Chat -> Box(
                Modifier
                    .size(6.dp)
                    .clip(CircleShape)
                    .border(1.3.dp, p.paperFaint.copy(alpha = alpha), CircleShape),
            )
            else -> Box(
                Modifier
                    .size(if (kind == DotKind.Rest) 8.dp else 7.dp)
                    .clip(CircleShape)
                    .background(colour.copy(alpha = alpha)),
            )
        }
    }
}

/** The card's context ring: the wall's own ring, smaller. The track is the
 *  edge; the arc warms celadon → amber → rust as the window fills, exactly as
 *  `classify.ts::ctxWarmth` does. */
@Composable
fun ContextRing(ctx: Double?, modifier: Modifier = Modifier, size: Dp = 22.dp, faint: Boolean = false) {
    val p = LocalPalette.current
    val colour = if (ctx != null) p.ctxWarmth(ctx) else p.paperFaint
    Canvas(modifier.size(size)) {
        val sw = 2.4f * (this.size.minDimension / 22f)
        val radius = this.size.minDimension / 2f - sw / 2f
        val centre = Offset(this.size.width / 2f, this.size.height / 2f)
        drawCircle(p.edge, radius, centre, style = androidx.compose.ui.graphics.drawscope.Stroke(sw))
        if (ctx != null) {
            drawArc(
                color = colour.copy(alpha = if (faint) 0.4f else 1f),
                startAngle = -90f,
                sweepAngle = (ctx.coerceIn(0.0, 1.0) * 360.0).toFloat(),
                useCenter = false,
                topLeft = Offset(centre.x - radius, centre.y - radius),
                size = androidx.compose.ui.geometry.Size(radius * 2, radius * 2),
                style = androidx.compose.ui.graphics.drawscope.Stroke(sw, cap = androidx.compose.ui.graphics.StrokeCap.Round),
            )
        }
    }
}

/* ── headings and labels ────────────────────────────────────────────────── */

/** A group heading: "needs you 2", in the quiet voice, with the count a step
 *  lighter than the word. */
@Composable
fun GroupLabel(text: String, count: Int? = null, modifier: Modifier = Modifier) {
    val p = LocalPalette.current
    Row(
        modifier.padding(start = 22.dp, end = 22.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        androidx.compose.material3.Text(text, style = Type.group(p))
        if (count != null) {
            androidx.compose.material3.Text(
                count.toString(),
                style = Type.meta(p, p.note.copy(alpha = 0.85f)),
            )
        }
    }
}

/** A small pill: a wall's name, a plan's chip, a state word. The selected one
 *  is raised off the page; the rest sit on the sheet's own 42%. */
@Composable
fun Pill(
    text: String,
    modifier: Modifier = Modifier,
    selected: Boolean = false,
    onClick: (() -> Unit)? = null,
    leading: (@Composable RowScope.() -> Unit)? = null,
    trailing: String? = null,
) {
    val p = LocalPalette.current
    val shape = RoundedCornerShape(999.dp)
    val face = if (selected) {
        Brush.verticalGradient(listOf(lerp(p.raised, p.paper, 0.05f), p.raised))
    } else {
        SolidColor(p.surface.copy(alpha = 0.42f))
    }
    Row(
        Modifier
            .height(36.dp)
            .then(pressable(onClick, shape, tint = Color.Transparent, role = Role.Tab))
            .clip(shape)
            .background(face)
            .border(
                1.dp,
                if (selected) lerp(p.edge, p.paper, 0.09f) else p.hair,
                shape,
            )
            .padding(horizontal = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (leading != null) leading()
        androidx.compose.material3.Text(
            text,
            style = Type.label(p, if (selected) p.paper else p.paperDim, 12.5f),
            maxLines = 1,
        )
        if (!trailing.isNullOrEmpty()) {
            androidx.compose.material3.Text(trailing, style = Type.meta(p))
        }
    }
}

/** A filled or ghost button in the viewer's and the sheet's proportions: 56 dp
 *  in the gate, 48 dp elsewhere. The primary one is lit paper with the sheet's
 *  ink on it — the sheet's one bright thing, as in the mockups. */
@Composable
fun ActionButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    primary: Boolean = false,
    height: Dp = 48.dp,
    glyph: Glyph? = null,
) {
    val p = LocalPalette.current
    val shape = RoundedCornerShape(if (height >= 56.dp) 18.dp else 15.dp)
    val face = if (primary) {
        Brush.verticalGradient(listOf(lerp(p.paper, Color.White, 0.06f), p.paper))
    } else {
        SolidColor(p.surface.copy(alpha = 0.50f))
    }
    val ink = if (primary) p.sheet else p.paperDim
    Row(
        modifier
            .height(height)
            .then(pressable(onClick, shape, tint = Color.Transparent, scaleTo = 0.98f))
            .clip(shape)
            .background(face)
            .border(1.dp, if (primary) Color.Transparent else lerp(p.edge, p.paper, 0.09f), shape)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
    ) {
        if (glyph != null) {
            Icon(glyph, tint = if (primary) p.sheet else p.paperMute, size = 16.dp)
            Spacer(Modifier.width(9.dp))
        }
        androidx.compose.material3.Text(
            text,
            style = Type.label(p, ink, 15f),
            textAlign = TextAlign.Center,
            maxLines = 1,
        )
    }
}

/** The hairline between two parts of a sheet or a card. */
@Composable
fun Hair(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(1.dp).background(LocalPalette.current.hair))
}

/* ── the segmented choice ───────────────────────────────────────────────── */

/** Three (or two) exclusive choices on one raised track, the chosen one lit on
 *  paper. This is settings' and the gate's one control; nothing else in the
 *  app chooses between alternatives. */
@Composable
fun Segmented(
    options: List<Pair<String, String>>,
    selected: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
    enabled: (String) -> Boolean = { true },
) {
    val p = LocalPalette.current
    val shape = RoundedCornerShape(if (compact) 11.dp else 14.dp)
    Row(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(lerp(p.sheet, p.ground, 0.30f))
            .border(1.dp, p.hair, shape)
            .padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        options.forEach { (value, label) ->
            val on = value == selected
            val usable = enabled(value)
            val itemShape = RoundedCornerShape(if (compact) 9.dp else 11.dp)
            Box(
                Modifier
                    .weight(1f)
                    .height(if (compact) 33.dp else 38.dp)
                    .then(pressable(if (usable) ({ onSelect(value) }) else null, itemShape))
                    .clip(itemShape)
                    .then(
                        if (on) {
                            Modifier
                                .background(Brush.verticalGradient(listOf(lerp(p.raised, p.paper, 0.05f), p.raised)))
                                .border(1.dp, lerp(p.edge, p.paper, 0.06f), itemShape)
                        } else {
                            Modifier
                        },
                    ),
                contentAlignment = Alignment.Center,
            ) {
                androidx.compose.material3.Text(
                    label,
                    style = Type.label(
                        p,
                        when {
                            !usable -> p.paperFaint
                            on -> p.paper
                            else -> p.note
                        },
                        if (compact) 12.5f else 13f,
                    ),
                    maxLines = 1,
                )
            }
        }
    }
}

/* ── the sheet ──────────────────────────────────────────────────────────── */

/** A surface that rises from the foot of the phone, over a scrim, with the
 *  page dimmed and let go behind it. This is the gate and every chooser, and
 *  it is deliberately ours rather than `ModalBottomSheet`: Material's sheet
 *  brings its own tonal surface, its own drag mechanics and its own corner
 *  radius, and the mockups draw a different one. Back, the scrim, or the
 *  handle's pull all let it go. */
@Composable
fun VolerySheet(
    title: String? = null,
    accent: Color? = null,
    onDismiss: () -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    val p = LocalPalette.current
    val motion = LocalMotion.current
    val progress = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()

    fun dismiss() {
        scope.launch {
            progress.animateTo(0f, tween(motion.duration(Motion.step), easing = Motion.out))
            onDismiss()
        }
    }

    LaunchedEffect(Unit) {
        progress.animateTo(1f, tween(motion.duration(Motion.scene), easing = Motion.out))
    }
    BackHandler(enabled = true) { dismiss() }

    Box(Modifier.fillMaxSize()) {
        Box(
            Modifier
                .matchParentSize()
                .graphicsLayer { alpha = progress.value }
                .background(p.shade.copy(alpha = 0.44f))
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                    onClick = { dismiss() },
                ),
        )
        Column(
            Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .graphicsLayer { translationY = (1f - progress.value) * 72.dp.toPx() }
                .clip(RoundedCornerShape(topStart = 32.dp, topEnd = 32.dp))
                .background(Brush.verticalGradient(listOf(lerp(p.lift, p.paper, 0.05f), p.lift)))
                .drawWithCache {
                    // A gate is warmed at its head by the colour of what it is
                    // asking about — ask's light, never a border all the way
                    // round, which would read as an alert rather than a room.
                    val wash = accent?.let {
                        Brush.radialGradient(
                            listOf(it.copy(alpha = 0.14f), Color.Transparent),
                            center = Offset(size.width / 2f, 0f),
                            radius = size.width * 0.80f,
                        )
                    }
                    onDrawWithContent {
                        if (wash != null) drawRect(wash)
                        drawContent()
                    }
                }
                .border(
                    1.dp,
                    accent?.copy(alpha = 0.30f) ?: lerp(p.edge, p.paper, 0.09f),
                    RoundedCornerShape(topStart = 32.dp, topEnd = 32.dp),
                )
                .windowInsetsPadding(WindowInsets.navigationBars)
                .imePadding()
                .padding(start = 20.dp, end = 20.dp, top = 10.dp, bottom = 24.dp),
        ) {
            Box(
                Modifier
                    .align(Alignment.CenterHorizontally)
                    .width(44.dp)
                    .height(4.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(p.paper.copy(alpha = 0.24f)),
            )
            Spacer(Modifier.height(14.dp))
            if (title != null) {
                androidx.compose.material3.Text(
                    title,
                    style = Type.group(p),
                    modifier = Modifier.padding(bottom = 10.dp),
                )
            }
            content()
        }
    }
}

/* ── a quiet text field for a sheet ─────────────────────────────────────── */

/** A row you can type into: the label above, the value in mono, an underline
 *  only when it is the one being edited. Material's text field brings a box,
 *  a floating label and a cursor colour of its own; this brings the sheet's. */
@Composable
fun QuietField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    mono: Boolean = false,
    masked: Boolean = false,
    imeAction: ImeAction = ImeAction.Done,
    onDone: () -> Unit = {},
) {
    val p = LocalPalette.current
    Column(modifier.fillMaxWidth()) {
        androidx.compose.material3.Text(label, style = Type.meta(p), modifier = Modifier.padding(bottom = 6.dp))
        val style: TextStyle = if (mono) Type.mono(p, 13f, p.paper) else Type.label(p, p.paper, 15f)
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            textStyle = style,
            singleLine = true,
            cursorBrush = SolidColor(p.work),
            visualTransformation = if (masked) {
                androidx.compose.ui.text.input.PasswordVisualTransformation()
            } else {
                androidx.compose.ui.text.input.VisualTransformation.None
            },
            keyboardOptions = KeyboardOptions(imeAction = imeAction),
            keyboardActions = KeyboardActions(onDone = { onDone() }),
            modifier = Modifier.fillMaxWidth(),
            decorationBox = { inner ->
                Box(
                    Modifier
                        .fillMaxWidth()
                        .background(p.surface.copy(alpha = 0.55f), RoundedCornerShape(12.dp))
                        .border(1.dp, p.hair, RoundedCornerShape(12.dp))
                        .padding(horizontal = 13.dp, vertical = 13.dp),
                ) {
                    if (value.isEmpty()) {
                        androidx.compose.material3.Text("—", style = style.copy(color = p.paperFaint))
                    }
                    inner()
                }
            },
        )
    }
}

/** A line of quiet prose under a control, saying what the choice means. */
@Composable
fun Note(text: String, modifier: Modifier = Modifier, color: Color? = null) {
    val p = LocalPalette.current
    androidx.compose.material3.Text(
        text,
        style = Type.note(p, color ?: p.note),
        modifier = modifier,
    )
}

/* ── the voice rail ─────────────────────────────────────────────────────── */

/** The ears, at the thumb, on every screen: hold the orb and talk, or take the
 *  keyboard. It stands on the sheet's lift with a halo of the working colour,
 *  and it is the same object on the roster, a card and a setting — the rail is
 *  the phone's one constant. */
@Composable
fun VoiceRail(
    voice: VoiceController,
    status: String,
    onType: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val p = LocalPalette.current
    val listening = voice.listening
    // The microphone is asked for at the press, not at launch: a permission
    // dialog nobody asked for is exactly what a quiet app does not do. A
    // granted permission primes the next hold rather than starting one, since
    // the finger that pressed has already been let go of by the dialog.
    val context = androidx.compose.ui.platform.LocalContext.current
    val permission = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) {
            voice.stop()
            /* Every grant path widens the running service's type, not only
               the one in settings: this orb is where the microphone is
               usually asked for, and a service left as data alone refuses
               the ears with the screen off even though the permission is
               now held. */
            NodeService.promote(context)
        } else {
            voice.fail("the ears need the microphone")
        }
    }
    val title = when {
        listening -> "listening…"
        voice.error != null -> voice.error!!
        else -> "hold to talk"
    }
    val sub = when {
        listening -> voice.heard.ifEmpty { "say it" }
        voice.error != null -> "tap to try again"
        status.isNotEmpty() -> status
        Config.mode == "seamless" -> "seamless · it listens after a card needs you"
        else -> "the same ears as the wall's · music ducks"
    }
    Row(
        modifier
            .fillMaxWidth()
            .height(64.dp)
            .shadow(18.dp, RoundedCornerShape(32.dp), spotColor = p.shade, ambientColor = p.shade)
            .clip(RoundedCornerShape(32.dp))
            .background(Brush.verticalGradient(listOf(lerp(p.lift, p.paper, 0.04f), p.lift)))
            .border(1.dp, lerp(p.edge, p.paper, 0.09f), RoundedCornerShape(32.dp))
            .padding(start = 9.dp, end = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(13.dp),
    ) {
        Box(
            Modifier
                .size(46.dp)
                .clip(CircleShape)
                .drawWithCache {
                    val brush = Brush.radialGradient(
                        listOf(lerp(p.lift, p.paper, 0.07f), p.lift),
                        center = Offset(size.width * 0.35f, size.height * 0.28f),
                        radius = size.maxDimension * 0.82f,
                    )
                    onDrawBehind { drawRect(brush) }
                }
                .border(1.dp, p.hair, CircleShape)
                .pointerInput(listening) {
                    detectTapGestures(
                        onPress = {
                            if (!listening) {
                                if (voice.hasMic()) voice.holdStart() else permission.launch(android.Manifest.permission.RECORD_AUDIO)
                            }
                            tryAwaitRelease()
                            voice.holdEnd()
                        },
                    )
                }
                .semantics { contentDescription = "hold to talk" },
            contentAlignment = Alignment.Center,
        ) {
            // The halo: a ring of work's colour, the rail's only colour.
            Box(
                Modifier
                    .size(46.dp)
                    .border(
                        (7 * (if (listening) 1f else 0.4f)).dp,
                        p.work.copy(alpha = if (listening) 0.14f else 0.07f),
                        CircleShape,
                    ),
            )
            Icon(
                /* Wings open while the ears are: the pose is the status. */
                if (listening) Glyph.BirdFlying else Glyph.Bird,
                tint = if (listening) p.work else p.paperDim,
                size = 25.dp,
            )
        }
        Column(Modifier.weight(1f)) {
            androidx.compose.material3.Text(
                title,
                style = Type.label(p, if (listening) p.paper else p.paperDim, 14f),
                maxLines = 1,
            )
            Spacer(Modifier.height(1.dp))
            androidx.compose.material3.Text(
                sub,
                style = Type.meta(p, if (voice.error != null) p.fail else p.note, 12f),
                maxLines = 1,
                overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
            )
        }
        IconBtn(Glyph.Keyboard, "type instead", onType, size = 40.dp, tint = p.paperMute)
    }
}
