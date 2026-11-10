package com.volery.phone

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * The phone's design system: chat view's lamplight, at arm's length.
 *
 * The tokens are the wall's own (`src/lib/tokens.css`), carried to the phone
 * with the relationships the tokens already state rather than as a second set
 * of values. A [Palette] holds the roles the mockups name — ground, sheet,
 * surface, raised, edge, the four paper steps and the five status colours — and
 * derives the mixed ones (lift, hair, lamp, prose) the way `color-mix(in
 * oklab, …)` does, with `lerp`, which interpolates in the same space. Two
 * palettes are built from them: [Studio], which is the signature and the
 * default, and [Vellum], studio by day. Colour is status only; the warm ink is
 * the ground's own temperature, not an accent.
 *
 * Type follows the same split the wall keeps: chrome is the system sans, the
 * agent's and the card's prose is the serif set at `tx × 1.2` (a serif reads
 * smaller than a sans at the same size) with 1.62 leading, the display serif is
 * for names, and machinery is mono. Android has neither Segoe UI Variable nor
 * Sitka, so this is the platform's sans (`Roboto`) and its serif (`Noto Serif`)
 * at those sizes — the relationships cross, the faces are the device's.
 *
 * Motion is five durations and two easings, transform and opacity only. A
 * preference ([Config.motion]) and the system's animator scale both fold into
 * [LocalMotion]; nothing here animates when it is [MotionLevel.STILL], and
 * [MotionLevel.SPARE] drops the infinite breathing a working card wears.
 */

/* ── the palette ────────────────────────────────────────────────────────── */

/**
 * One ground. Every field is a role from the mockups; the mixed ones are
 * computed in the constructor so a second theme only states the primitives.
 */
class Palette(
    /** Whether this ground is lit: drives system-bar icon colour and whether
     *  a status glow is a halo (dark) or a tint (light). */
    val light: Boolean,
    val ground: Color,
    val sheet: Color,
    val surface: Color,
    val raised: Color,
    val edge: Color,
    val rule: Color,
    val paper: Color,
    val paperDim: Color,
    val paperMute: Color,
    val paperFaint: Color,
    val work: Color,
    val ask: Color,
    val soft: Color,
    val rest: Color,
    val fail: Color,
    /** The ground's own gradient, darkest at the foot. */
    val groundTop: Color,
    val groundMid: Color,
    val groundBottom: Color,
    /** What the lift's pool and border are mixed against. */
    private val liftMix: Float,
    private val poolWorkAlpha: Float,
    private val poolAskAlpha: Float,
    /** The shadow's colour — black in studio, warm ink in vellum. */
    val shade: Color,
) {
    /** `--cv-lift`: the composer's and the sheet's raised field. */
    val lift: Color = lerp(surface, paper, liftMix)

    /** `--cv-hair`: every quiet border on the page. */
    val hair: Color = edge.copy(alpha = 0.80f)

    /** `--cv-lamp`: the light falling from above the head. */
    val lamp: Color = paper.copy(alpha = 0.06f)

    /** `--cv-prose`: the agent's and the card's words — paper, warmed toward
     *  its dim step so a column of it is not a wall of full-contrast ink. */
    val prose: Color = lerp(paperDim, paper, 0.55f)

    /** `--cv-note`: meta lines, group labels, the quiet half of a row. */
    val note: Color = paperMute

    /** `--pool-work` / `--pool-ask`: the pool a live thread stands on. */
    val poolWork: Color = work.copy(alpha = poolWorkAlpha)
    val poolAsk: Color = ask.copy(alpha = poolAskAlpha)

    /** A hairline one step stronger than [hair], for a rule between rows. */
    val seam: Color = edge.copy(alpha = 0.55f)

    /** The chosen row's fill: raised, warmed a touch toward paper. */
    val chosen: Color = lerp(raised, paper, 0.03f)

    fun status(tier: String): Color = when (tier) {
        "work" -> work
        "ask" -> ask
        "soft" -> soft
        "fail" -> fail
        else -> rest
    }

    /** The pool a card of this tier stands on when it is the one you are
     *  reading. Ask gets its own warmth; everything else settles for work's. */
    fun pool(tier: String): Color = if (tier == "ask") poolAsk else poolWork

    /** The text a row's title takes: paper when it needs you or is chosen,
     *  the dim step otherwise. */
    val rowTitle: Color get() = paperDim
}

/** Studio — Volery's own dark: the wall's warm ink, lit from above. */
val Studio = Palette(
    light = false,
    ground = Color(0xFF0F0D0C),
    sheet = Color(0xFF151210),
    surface = Color(0xFF1E1A18),
    raised = Color(0xFF272220),
    edge = Color(0xFF332C29),
    rule = Color(0xFF3D3532),
    paper = Color(0xFFEDE4D8),
    paperDim = Color(0xFFB4A89C),
    paperMute = Color(0xFF8A7E74),
    paperFaint = Color(0xFF615850),
    work = Color(0xFF7FB8A4),
    ask = Color(0xFFE9A13B),
    soft = Color(0xFFA8823F),
    rest = Color(0xFF6B6058),
    fail = Color(0xFFC5603F),
    groundTop = lerp(Color(0xFF151210), Color(0xFFEDE4D8), 0.015f),
    groundMid = Color(0xFF151210),
    groundBottom = Color(0xFF151210),
    liftMix = 3f / 85f,
    poolWorkAlpha = 0.24f,
    poolAskAlpha = 0.26f,
    shade = Color.Black,
)

/** Vellum — studio by day. The same room with the lights on: the ladder runs
 *  the other way (the ground is the darkest, the surface the brightest) and
 *  nothing is anywhere near white, so a phone held at night does not glare. */
val Vellum = Palette(
    light = true,
    ground = Color(0xFFDDD8D1),
    sheet = Color(0xFFECE6DF),
    surface = Color(0xFFF6F0E9),
    raised = Color(0xFFE6E1DA),
    edge = Color(0xFFC1B9AE),
    rule = Color(0xFFB1A89C),
    paper = Color(0xFF352C25),
    paperDim = Color(0xFF514740),
    paperMute = Color(0xFF655A53),
    paperFaint = Color(0xFF958A82),
    work = Color(0xFF22876B),
    ask = Color(0xFFCA7F10),
    soft = Color(0xFFA17740),
    rest = Color(0xFF8B857F),
    fail = Color(0xFFB63D29),
    groundTop = lerp(Color(0xFFECE6DF), Color(0xFFF6F0E9), 0.45f),
    groundMid = Color(0xFFECE6DF),
    groundBottom = lerp(Color(0xFFECE6DF), Color(0xFFDDD8D1), 0.16f),
    liftMix = 0f,
    poolWorkAlpha = 0.09f,
    poolAskAlpha = 0.12f,
    shade = Color(0x3D3E3024),
)

/** The two grounds this build carries, by the name settings shows. */
val PALETTES = listOf("studio" to Studio, "vellum" to Vellum)

fun paletteFor(theme: String): Palette = when (theme) {
    "vellum" -> Vellum
    else -> Studio
}

/** The tier in words, lowercase and sentence-shaped, for a row's meta line. */
fun tierWord(tier: String): String = when (tier) {
    "work" -> "working"
    "ask" -> "asking"
    "soft" -> "warming"
    "fail" -> "failed"
    else -> "at rest"
}

/** The context figure warms as the window fills — the wall's own vocabulary
 *  (`classify.ts::ctxWarmth`), on this palette's status colours. */
fun Palette.ctxWarmth(ctx: Double): Color = when {
    ctx >= 0.85 -> fail
    ctx >= 0.65 -> ask
    else -> work
}

/* ── type ───────────────────────────────────────────────────────────────── */

object Type {
    val ui = FontFamily.SansSerif       // Segoe UI Variable → the platform's sans
    val serif = FontFamily.Serif        // Sitka → the platform's serif
    val display = FontFamily.Serif
    val mono = FontFamily.Monospace     // Cascadia Mono → the platform's mono

    /** The reading size the serif is derived from; `tx × 1.2` is the wall's
     *  rule for prose in the book's face. */
    val tx = 14.sp
    val serifSize = (tx.value * 1.2f).sp
    val serifLeading = 1.62f

    /** The agent's and the card's words. */
    fun prose(p: Palette): TextStyle = TextStyle(
        fontFamily = serif,
        fontSize = serifSize,
        lineHeight = (serifSize.value * serifLeading).sp,
        color = p.prose,
    )

    /** A name: the display serif, for "settings", "volery", the greeting. */
    fun display(p: Palette, size: Float = 31f, color: Color = p.paper): TextStyle = TextStyle(
        fontFamily = display,
        fontWeight = FontWeight.Normal,
        fontSize = size.sp,
        lineHeight = (size * 1.1f).sp,
        letterSpacing = (-0.004f * size).sp,
        color = color,
    )

    /** A row's title. */
    fun rowTitle(p: Palette, color: Color = p.rowTitle): TextStyle = TextStyle(
        fontFamily = ui,
        fontSize = 15.5.sp,
        lineHeight = 19.sp,
        color = color,
    )

    /** A row's second line, and every quiet sentence. */
    fun note(p: Palette, color: Color = p.note): TextStyle = TextStyle(
        fontFamily = ui,
        fontSize = 12.5.sp,
        lineHeight = 17.sp,
        color = color,
    )

    /** The small figure a row carries at its trailing edge, and every quiet
     *  sub-line under a head. */
    fun meta(p: Palette, color: Color = p.note, size: Float = 11.5f): TextStyle = TextStyle(
        fontFamily = ui,
        fontSize = size.sp,
        lineHeight = (size * 1.4f).sp,
        color = color,
    )

    /** A group heading: "needs you 2". */
    fun group(p: Palette, color: Color = p.note): TextStyle = TextStyle(
        fontFamily = ui,
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp,
        lineHeight = 16.sp,
        color = color,
    )

    /** A head's title, where a card or a picture is named. */
    fun headTitle(p: Palette): TextStyle = TextStyle(
        fontFamily = ui,
        fontWeight = FontWeight.Medium,
        fontSize = 16.5.sp,
        lineHeight = 20.sp,
        color = p.paper,
    )

    /** Machinery, paths, sizes. */
    fun mono(p: Palette, size: Float = 12f, color: Color = p.paperDim): TextStyle = TextStyle(
        fontFamily = mono,
        fontSize = size.sp,
        lineHeight = (size * 1.5f).sp,
        color = color,
    )

    /** The composer's placeholder and its typed text. */
    fun composer(p: Palette, color: Color = p.note): TextStyle = TextStyle(
        fontFamily = ui,
        fontSize = 15.5.sp,
        lineHeight = 22.sp,
        color = color,
    )

    /** A button's or a segmented choice's label. */
    fun label(p: Palette, color: Color, size: Float = 14f): TextStyle = TextStyle(
        fontFamily = ui,
        fontSize = size.sp,
        lineHeight = (size * 1.25f).sp,
        color = color,
    )
}

/* ── motion ─────────────────────────────────────────────────────────────── */

/**
 * Full: everything the mockups draw. Spare: no infinite breathing and no
 * sheet flourish — motion still marks a change, quietly stepped. Still: no
 * duration at all, so every animation lands on its end state at once.
 */
enum class MotionLevel { FULL, SPARE, STILL }

object Motion {
    const val tap = 90
    const val quick = 160
    const val step = 240
    const val scene = 360
    const val stage = 520

    val out: Easing = CubicBezierEasing(0.2f, 0.8f, 0.3f, 1f)
    val pop: Easing = CubicBezierEasing(0.34f, 1.36f, 0.64f, 1f)
}

private fun levelFor(motion: String): MotionLevel = when (motion) {
    "still" -> MotionLevel.STILL
    "spare" -> MotionLevel.SPARE
    else -> MotionLevel.FULL
}

/** How long [base] may take under [level] — zero when the phone is still. */
fun MotionLevel.duration(base: Int): Int = if (this == MotionLevel.STILL) 0 else base

/** Whether an endless, ambient animation (a working dot's breath) may run. */
fun MotionLevel.ambient(): Boolean = this == MotionLevel.FULL

/* ── the ambient values ─────────────────────────────────────────────────── */

val LocalPalette = staticCompositionLocalOf { Studio }
val LocalMotion = staticCompositionLocalOf { MotionLevel.FULL }

/* ── the theme ──────────────────────────────────────────────────────────── */

/**
 * The one theme every screen is drawn in. Material is kept underneath for its
 * mechanics — insets, touch, text selection, accessibility — but everything it
 * would paint is ours: no tonal elevation, no default palette, no ripple. A
 * screen that reaches for `MaterialTheme.colorScheme` gets this ground's
 * colours, not Material's purple.
 */
@Composable
fun VoleryTheme(
    theme: String = Config.theme,
    motion: String = Config.motion,
    content: @Composable () -> Unit,
) {
    val p = paletteFor(theme)
    val scheme = if (p.light) {
        lightColorScheme(
            primary = p.work,
            onPrimary = p.sheet,
            secondary = p.paperDim,
            onSecondary = p.surface,
            background = p.sheet,
            onBackground = p.paper,
            surface = p.surface,
            onSurface = p.paper,
            surfaceVariant = p.raised,
            onSurfaceVariant = p.paperDim,
            outline = p.edge,
            outlineVariant = p.hair,
            error = p.fail,
            onError = p.surface,
            scrim = p.shade,
        )
    } else {
        darkColorScheme(
            primary = p.work,
            onPrimary = p.ground,
            secondary = p.paperDim,
            onSecondary = p.surface,
            background = p.sheet,
            onBackground = p.paper,
            surface = p.surface,
            onSurface = p.paper,
            surfaceVariant = p.raised,
            onSurfaceVariant = p.paperDim,
            outline = p.edge,
            outlineVariant = p.hair,
            error = p.fail,
            onError = p.surface,
            scrim = p.shade,
        )
    }
    val typography = Typography(
        bodyLarge = Type.prose(p),
        titleMedium = Type.headTitle(p),
        labelMedium = Type.note(p),
        labelSmall = Type.meta(p),
    )
    // The system bars are the phone's, so they are drawn by us in the sense
    // that matters: transparent, over this ground, with their icons flipped to
    // whichever way it is lit. Doing it here rather than in each activity is
    // the ambient-capability rule — a screen cannot forget it, including a
    // screen nobody has written yet.
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = view.context.findActivity()?.window ?: return@SideEffect
            window.statusBarColor = android.graphics.Color.TRANSPARENT
            window.navigationBarColor = android.graphics.Color.TRANSPARENT
            androidx.core.view.WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = p.light
                isAppearanceLightNavigationBars = p.light
            }
        }
    }

    CompositionLocalProvider(
        LocalPalette provides p,
        LocalMotion provides levelFor(motion),
    ) {
        // MaterialTheme's own selection colours derive from `primary`, which is
        // this ground's working status colour — so a selected line of the
        // card's prose is tinted the house's way without a second local.
        MaterialTheme(
            colorScheme = scheme,
            typography = typography,
            content = content,
        )
    }
}

/** The activity a composed view is in, however many wrappers the window has
 *  put between them. */
private fun Context.findActivity(): Activity? {
    var c: Context = this
    while (c is ContextWrapper) {
        if (c is Activity) return c
        c = c.baseContext
    }
    return null
}
