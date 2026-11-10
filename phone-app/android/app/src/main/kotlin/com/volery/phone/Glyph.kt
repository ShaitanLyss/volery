package com.volery.phone

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The phone's icons, drawn here rather than pulled from Material's set.
 *
 * The mockups are 16-unit stroke drawings at 1.5 units with round caps — a
 * quiet line, not a filled glyph — and Material's icons are a different hand
 * entirely. They are also the one part of Material that would put thirteen
 * point-something pixels of somebody else's drawing on every chrome control,
 * so the set is small on purpose: every symbol the screens use, in one file,
 * in the same 16-unit space, so a new control cannot accidentally ship a
 * Material icon and read as a different app.
 *
 * Coordinates are the SVGs' own (`<symbol viewBox="0 0 16 16">`), scaled once
 * by the canvas size. Keep them there.
 */
enum class Glyph {
    Dial, Gear, Back, More, Mic, Keyboard, Bell, ChevronRight, ChevronLeft,
    Share, Copy, File, Picture, Check, Lock, Queue, Up, Stop, Plan, Terminal,
    Folder, Circle,
}

@Composable
fun Icon(
    glyph: Glyph,
    tint: Color,
    modifier: Modifier = Modifier,
    size: Dp = 18.dp,
    weight: Float = 1.5f,
) {
    Canvas(modifier.size(size)) {
        val u = this.size.minDimension / 16f
        val stroke = Stroke(width = weight * u, cap = StrokeCap.Round, join = StrokeJoin.Round)
        drawGlyph(glyph, tint, u, stroke)
    }
}

private fun DrawScope.drawGlyph(g: Glyph, color: Color, u: Float, stroke: Stroke) {
    fun line(x1: Float, y1: Float, x2: Float, y2: Float) =
        drawLine(color, Offset(x1 * u, y1 * u), Offset(x2 * u, y2 * u), stroke.width, StrokeCap.Round)

    fun rr(x: Float, y: Float, w: Float, h: Float, r: Float) = drawRoundRect(
        color, Offset(x * u, y * u), Size(w * u, h * u), CornerRadius(r * u), style = stroke,
    )

    fun oval(cx: Float, cy: Float, r: Float, style: androidx.compose.ui.graphics.drawscope.DrawStyle? = stroke) =
        drawCircle(color, r * u, Offset(cx * u, cy * u), style = style ?: androidx.compose.ui.graphics.drawscope.Fill)

    fun arc(cx: Float, cy: Float, r: Float, start: Float, sweep: Float) = drawArc(
        color, start, sweep, false,
        topLeft = Offset((cx - r) * u, (cy - r) * u),
        size = Size(2 * r * u, 2 * r * u),
        style = stroke,
    )

    when (g) {
        Glyph.Dial -> {
            arc(8f, 8f, 5.2f, -34f, -292f)
            line(13.4f, 2.6f, 13.4f, 5.8f)
            line(13.4f, 5.8f, 10.2f, 5.8f)
        }
        Glyph.Gear -> {
            oval(8f, 8f, 2.1f)
            val spokes = listOf(
                8f to 1.9f, 8f to 12.4f, 14.1f to 8f, 3.6f to 8f,
                12.3f to 3.7f, 4.9f to 11.1f, 12.3f to 12.3f, 4.9f to 4.9f,
            )
            spokes.forEach { (x, y) ->
                val dx = (x - 8f) * 0.28f
                val dy = (y - 8f) * 0.28f
                line(8f + dx, 8f + dy, x, y)
            }
        }
        Glyph.Back -> {
            line(13f, 8f, 3.4f, 8f)
            line(7.2f, 4.2f, 3.4f, 8f)
            line(3.4f, 8f, 7.2f, 11.8f)
        }
        Glyph.More -> {
            oval(3.6f, 8f, 0.75f, style = null)
            oval(8f, 8f, 0.75f, style = null)
            oval(12.4f, 8f, 0.75f, style = null)
        }
        Glyph.Mic -> {
            rr(6f, 2.4f, 4f, 7.2f, 2f)
            arc(8f, 7.9f, 4.2f, 0f, 180f)
            line(8f, 12.2f, 8f, 13.8f)
        }
        Glyph.Keyboard -> {
            rr(2.2f, 4.2f, 11.6f, 7.6f, 1.8f)
            listOf(4.8f, 7.2f, 9.6f, 11.4f).forEach { x -> oval(x, 6.6f, 0.36f, style = null) }
            line(4.8f, 9.4f, 11.2f, 9.4f)
        }
        Glyph.Bell -> {
            line(4.2f, 10.8f, 4.2f, 7.4f)
            arc(8f, 7.4f, 3.8f, 180f, 180f)
            line(11.8f, 7.4f, 11.8f, 10.8f)
            line(11.8f, 10.8f, 12.8f, 12.1f)
            line(12.8f, 12.1f, 3.2f, 12.1f)
            line(3.2f, 12.1f, 4.2f, 10.8f)
            arc(8f, 13.4f, 1.5f, 0f, 180f)
        }
        Glyph.ChevronRight -> {
            line(6.2f, 4f, 10.2f, 8f)
            line(10.2f, 8f, 6.2f, 12f)
        }
        Glyph.ChevronLeft -> {
            line(9.8f, 4f, 5.8f, 8f)
            line(5.8f, 8f, 9.8f, 12f)
        }
        Glyph.Share -> {
            line(8f, 10.4f, 8f, 2.6f)
            line(4.8f, 5.6f, 8f, 2.4f)
            line(8f, 2.4f, 11.2f, 5.6f)
            line(3.4f, 9.4f, 3.4f, 12.5f)
            line(3.4f, 12.5f, 12.6f, 12.5f)
            line(12.6f, 12.5f, 12.6f, 9.4f)
        }
        Glyph.Copy -> {
            rr(5.5f, 5.5f, 8f, 8f, 1.6f)
            rr(2.5f, 2.5f, 8f, 8f, 1.6f)
        }
        Glyph.File -> {
            val p = Path().apply {
                moveTo(4.2f * u, 2.4f * u)
                lineTo(9.1f * u, 2.4f * u)
                lineTo(12.1f * u, 5.4f * u)
                lineTo(12.1f * u, 13.3f * u)
                lineTo(4.2f * u, 13.3f * u)
                close()
            }
            drawPath(p, color, style = stroke)
            line(9f, 2.5f, 9f, 5.5f)
            line(9f, 5.5f, 12f, 5.5f)
        }
        Glyph.Picture -> {
            rr(2.2f, 3.4f, 11.6f, 9.2f, 2f)
            oval(5.8f, 6.6f, 1.1f)
            val p = Path().apply {
                moveTo(3.2f * u, 12f * u)
                lineTo(6.8f * u, 8.6f * u)
                lineTo(9.6f * u, 11.2f * u)
                lineTo(11.6f * u, 9.4f * u)
                lineTo(13.4f * u, 11.2f * u)
            }
            drawPath(p, color, style = stroke)
        }
        Glyph.Check -> {
            line(3.6f, 8.4f, 6.5f, 11.3f)
            line(6.5f, 11.3f, 12.4f, 4.7f)
        }
        Glyph.Lock -> {
            rr(3.4f, 7f, 9.2f, 6.4f, 1.6f)
            line(5.6f, 7f, 5.6f, 5.4f)
            arc(8f, 5.4f, 2.4f, 180f, 180f)
            line(10.4f, 5.4f, 10.4f, 7f)
        }
        Glyph.Queue -> {
            line(3f, 5.2f, 13f, 5.2f)
            line(3f, 8f, 13f, 8f)
            line(3f, 10.8f, 9f, 10.8f)
        }
        Glyph.Up -> {
            line(8f, 12.8f, 8f, 3.4f)
            line(4.2f, 7.2f, 8f, 3.4f)
            line(8f, 3.4f, 11.8f, 7.2f)
        }
        Glyph.Stop -> rr(3.4f, 3.4f, 9.2f, 9.2f, 2f)
        Glyph.Plan -> {
            // A dashed frame: the plan, not yet the thing.
            val p = Path().apply {
                moveTo(2.6f * u, 3.4f * u)
                lineTo(13.4f * u, 3.4f * u)
                lineTo(13.4f * u, 12.6f * u)
                lineTo(2.6f * u, 12.6f * u)
                close()
            }
            drawPath(
                p, color,
                style = Stroke(
                    width = stroke.width, cap = StrokeCap.Round, join = StrokeJoin.Round,
                    pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(
                        floatArrayOf(2f * u, 1.7f * u),
                    ),
                ),
            )
        }
        Glyph.Terminal -> {
            rr(2.2f, 3f, 11.6f, 10f, 2f)
            line(5f, 6.8f, 7f, 8.3f)
            line(7f, 8.3f, 5f, 9.8f)
            line(8.6f, 10.1f, 11.3f, 10.1f)
        }
        Glyph.Folder -> {
            val p = Path().apply {
                moveTo(2.4f * u, 10.4f * u)
                lineTo(2.4f * u, 4.6f * u)
                lineTo(6.4f * u, 4.6f * u)
                lineTo(7.9f * u, 6.1f * u)
                lineTo(12.5f * u, 6.1f * u)
                lineTo(12.5f * u, 11.9f * u)
                lineTo(2.4f * u, 11.9f * u)
                close()
            }
            drawPath(p, color, style = stroke)
        }
        Glyph.Circle -> oval(8f, 8f, 6f)
    }
}

/**
 * The mark: a ring with a lit arc, work's celadon into ask's amber — the one
 * place the brand's two status hues meet. It is the wall's own logo carried to
 * the roster's head, not decorative colour on a control.
 */
@Composable
fun Mark(modifier: Modifier = Modifier, size: Dp = 24.dp) {
    val p = LocalPalette.current
    Canvas(modifier.size(size)) {
        val u = this.size.minDimension / 24f
        val stroke = Stroke(width = 3.2f * u, cap = StrokeCap.Round, join = StrokeJoin.Round)
        drawCircle(p.edge, 8.2f * u, Offset(12f * u, 12f * u), style = stroke)
        drawArc(
            brush = Brush.linearGradient(
                listOf(p.work, p.ask),
                start = Offset(4f * u, 20.4f * u),
                end = Offset(21.6f * u, 2.4f * u),
            ),
            startAngle = -98f,
            sweepAngle = 300f,
            useCenter = false,
            topLeft = Offset((12f - 8.2f) * u, (12f - 8.2f) * u),
            size = Size(16.4f * u, 16.4f * u),
            style = stroke,
        )
    }
}
