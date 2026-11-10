package com.volery.phone

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * The phone's one theme, in the direction of **chat view** rather than the
 * wall: lamplight gradients, soft pools of status colour, warm surfaces with
 * real depth, and motion. A light field still — nothing is pure white, and the
 * ground is a warm vertical gradient rather than flat paper — but colour is
 * allowed to be atmosphere here the way the wall's never is (`--cv-lamp`,
 * `--cv-pool-*`), and a warm tan is the chrome's accent. Status colours stay
 * the five the wall uses, so a card that is working or asking means the same
 * on the phone as on the glass.
 */

/* ── ground: warm paper, lamplit ────────────────────────────────────── */
val WallTop = Color(0xFFF4EEE1)   // where the light falls
val WallBottom = Color(0xFFE4DCC9) // where it falls away
val Surface = Color(0xFFF2EDE1)
val CardTop = Color(0xFFF9F5EA)
val CardBottom = Color(0xFFF0E9DA)
val Lift = Color(0xFFFCF8EE)

val Ink = Color(0xFF2F2A24)
val InkDim = Color(0xFF4A443C)
val InkMute = Color(0xFF6B6357)
val InkFaint = Color(0xFF8A8178)
val Edge = Color(0xFFD2C9B6)

/** A warm tan, the chrome's accent — the one colour that is not status. The
 *  fetch button, the active chip, the header's rule and the "this phone" mark
 *  wear it, so the app has warmth in its furniture the way chat view's
 *  lamplight does. Deliberately distinct from the amber that means *asking*. */
val Lamp = Color(0xFFB87C4A)

/* ── status — the same five families as the wall ────────────────────── */
val Celadon = Color(0xFF2E7A5E)
val Amber = Color(0xFFB06A14)
val SoftAmber = Color(0xFF9A7A3A)
val Rest = Color(0xFF8A8178)
val Rust = Color(0xFFB4502F)

/** The tier a digest carries (`classify.ts::Tier`), as its colour. Unknown
 *  reads as rest — the one that claims nothing. */
fun tierColor(tier: String): Color = when (tier) {
    "work" -> Celadon
    "ask" -> Amber
    "soft" -> SoftAmber
    "fail" -> Rust
    else -> Rest
}

/** The context ring warms as the window fills — the wall's own vocabulary
 *  (`classify.ts::ctxWarmth`): celadon, then amber past 65%, rust past 85%. */
fun ctxWarmth(ctx: Double): Color = when {
    ctx >= 0.85 -> Rust
    ctx >= 0.65 -> Amber
    else -> Celadon
}

/** The tier in words, lowercase and sentence-shaped, for a row's meta line. */
fun tierWord(tier: String): String = when (tier) {
    "work" -> "working"
    "ask" -> "asking"
    "soft" -> "warming"
    "fail" -> "failed"
    else -> "at rest"
}

/** The lamplit ground: light at the top, warm shadow at the foot. */
fun groundBrush() = Brush.verticalGradient(listOf(WallTop, WallBottom))

/** A card's surface, lit from above like a plate under the lamp. */
fun cardBrush() = Brush.verticalGradient(listOf(CardTop, CardBottom))

private val VoleryColors = lightColorScheme(
    primary = Lamp,
    onPrimary = Color(0xFFFCF8EE),
    primaryContainer = Color(0xFFE7CBA4),
    onPrimaryContainer = Ink,
    secondary = InkDim,
    onSecondary = Lift,
    background = WallTop,
    onBackground = Ink,
    surface = Surface,
    onSurface = Ink,
    surfaceVariant = Lift,
    onSurfaceVariant = InkMute,
    outline = Edge,
    outlineVariant = Edge,
    error = Rust,
    onError = Lift,
    errorContainer = Color(0xFFF3D9CD),
    onErrorContainer = Rust,
)

/** Chrome is the system sans; the reading — a fetched file's prose, the
 *  thread's body — is a serif, as chat view keeps the agent's words in the
 *  book's face while the chrome stays in the UI's. */
private val VoleryType = Typography(
    titleLarge = TextStyle(
        fontFamily = FontFamily.Serif,
        fontWeight = FontWeight.Medium,
        fontSize = 20.sp,
        color = Ink,
    ),
    titleMedium = TextStyle(
        fontWeight = FontWeight.Medium,
        fontSize = 16.sp,
        color = Ink,
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.Serif,
        fontSize = 16.sp,
        lineHeight = 25.sp,
        color = InkDim,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.Serif,
        fontSize = 14.sp,
        lineHeight = 21.sp,
        color = InkDim,
    ),
    labelLarge = TextStyle(
        fontWeight = FontWeight.Medium,
        fontSize = 14.sp,
        color = Ink,
    ),
    labelMedium = TextStyle(
        fontSize = 12.sp,
        color = InkMute,
    ),
    labelSmall = TextStyle(
        fontSize = 11.sp,
        color = InkFaint,
    ),
)

@Composable
fun VoleryTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = VoleryColors,
        typography = VoleryType,
        content = content,
    )
}
