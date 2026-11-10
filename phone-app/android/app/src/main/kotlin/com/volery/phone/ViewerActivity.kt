package com.volery.phone

import android.graphics.BitmapFactory
import android.os.Bundle
import android.util.Base64
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * The viewer: draws what [NativeBridge.fetch] pulls back over the flyway. A
 * picture becomes a bitmap, a file becomes its text (or a note that it is
 * binary), and both are pulled on a background thread because the JNI call
 * blocks. It is the honest half of M2v — a picture by path or by the copy
 * `show` kept, a file by path, nothing else, so a pinned far-wall image and an
 * `ask_user` preview are deliberately not on offer here (they do not cross the
 * flyway yet).
 */
class ViewerActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val host = intent.getStringExtra(EXTRA_HOST) ?: Config.host
        val card = intent.getStringExtra(EXTRA_CARD).orEmpty()
        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty()
        setContent {
            VoleryTheme { ViewerScreen(host, card, title, onBack = { finish() }) }
        }
    }

    companion object {
        const val EXTRA_HOST = "host"
        const val EXTRA_CARD = "card"
        const val EXTRA_TITLE = "title"
    }
}

private sealed interface FetchState {
    data object Idle : FetchState
    data object Loading : FetchState
    data class Error(val message: String) : FetchState
    data class Done(
        val media: FetchedMedia,
        val image: ImageBitmap?,
        val text: String?,
        val binary: Boolean,
    ) : FetchState
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ViewerScreen(host: String, card: String, title: String, onBack: () -> Unit) {
    var kind by rememberSaveable { mutableStateOf("file") }
    var path by rememberSaveable { mutableStateOf("") }
    var kept by rememberSaveable { mutableStateOf("") }
    var state by remember { mutableStateOf<FetchState>(FetchState.Idle) }
    val scope = rememberCoroutineScope()

    fun fetch() {
        scope.launch {
            state = FetchState.Loading
            state = withContext(Dispatchers.IO) {
                val envelope = NativeBridge.parse(
                    NativeBridge.fetch(host, card, kind, kept.trim(), path.trim()),
                )
                when (envelope) {
                    is NativeBridge.Envelope.Error -> FetchState.Error(envelope.message)
                    is NativeBridge.Envelope.Ok -> decode(parseFetched(envelope.payload), kind)
                }
            }
        }
    }

    Box(Modifier.fillMaxSize().background(groundBrush())) {
        Scaffold(
            containerColor = Color.Transparent,
            topBar = {
                TopAppBar(
                    title = {
                        Text(if (title.isEmpty()) "viewer" else "from $title", fontFamily = FontFamily.Serif)
                    },
                    navigationIcon = {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "back", tint = InkMute)
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                )
            },
        ) { padding ->
            Column(
                Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Spacer(Modifier.height(2.dp))
                Text(
                    "a file or picture that card made — fetched over the flyway.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = InkMute,
                )

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    KindButton("file", kind == "file") { kind = "file" }
                    KindButton("picture", kind == "picture") { kind = "picture" }
                }

                ViewerField(
                    value = path,
                    onValueChange = { path = it },
                    label = if (kind == "picture") "picture path" else "file path",
                )
                if (kind == "picture") {
                    ViewerField(
                        value = kept,
                        onValueChange = { kept = it },
                        label = "kept name (optional)",
                    )
                }

                Button(
                    onClick = { fetch() },
                    enabled = state !is FetchState.Loading,
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp),
                ) {
                    Text("fetch")
                }

                Spacer(Modifier.height(4.dp))
                ResultArea(state, kind)
                Spacer(Modifier.height(16.dp))
            }
        }
    }
}

@Composable
private fun KindButton(label: String, selected: Boolean, onClick: () -> Unit) {
    if (selected) {
        FilledTonalButton(onClick = onClick, shape = RoundedCornerShape(10.dp)) { Text(label) }
    } else {
        OutlinedButton(onClick = onClick, shape = RoundedCornerShape(10.dp)) { Text(label) }
    }
}

@Composable
private fun ViewerField(value: String, onValueChange: (String) -> Unit, label: String) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = true,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun ResultArea(state: FetchState, kind: String) {
    when (state) {
        is FetchState.Idle -> Unit
        is FetchState.Loading -> Row(verticalAlignment = Alignment.CenterVertically) {
            StatusMark("work", working = true, dormant = false)
            Spacer(Modifier.size(10.dp))
            Text("fetching…", style = MaterialTheme.typography.bodyMedium, color = InkMute)
        }
        is FetchState.Error -> Text(
            state.message,
            style = MaterialTheme.typography.bodyMedium,
            color = Rust,
        )
        is FetchState.Done -> DoneView(state, kind)
    }
}

@Composable
private fun DoneView(state: FetchState.Done, kind: String) {
    val m = state.media
    when {
        // A picture too large to draw comes back with no bytes; the honest
        // answer is the size, not a broken image.
        kind == "picture" && m.tooLarge -> Text(
            "too large to draw here — the wall kept the full picture over there.",
            style = MaterialTheme.typography.bodyMedium,
            color = InkMute,
        )
        state.image != null -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            val img = state.image
            val aspect = if (img.height > 0 && img.width > 0) img.width.toFloat() / img.height.toFloat() else 4f / 3f
            Image(
                bitmap = img,
                contentDescription = m.name,
                contentScale = ContentScale.Fit,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Lift, RoundedCornerShape(12.dp))
                    .padding(4.dp)
                    .aspectRatio(aspect),
            )
            Text(pictureCaption(m), style = MaterialTheme.typography.labelSmall)
        }
        state.text != null -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(fileCaption(m), style = MaterialTheme.typography.labelSmall)
            SelectionContainer {
                Text(
                    state.text,
                    style = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Serif),
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Lift, RoundedCornerShape(12.dp))
                        .padding(14.dp),
                )
            }
        }
        else -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                "a binary file — ${sizeSaid(m.bytes)}.",
                style = MaterialTheme.typography.bodyMedium,
                color = InkMute,
            )
            if (m.full.isNotEmpty()) {
                Text("on the wall: ${m.full}", style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace)
            }
        }
    }
}

private fun pictureCaption(m: FetchedMedia): String {
    val box = if (m.sizeWidth != null && m.sizeHeight != null) " ${m.sizeWidth}×${m.sizeHeight}" else ""
    return "${m.name}$box · ${sizeSaid(m.bytes)}"
}

private fun fileCaption(m: FetchedMedia): String =
    if (m.full.isEmpty()) "${m.name} · ${sizeSaid(m.bytes)}"
    else "${m.name} · ${sizeSaid(m.bytes)} · ${m.full}"

private fun sizeSaid(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "${bytes / 1024} KB"
    else -> "%.1f MB".format(bytes / 1024.0 / 1024.0)
}

/** Turn a fetch into what the viewer draws: a picture's bytes into a bitmap,
 *  a file's into its text — or into "binary" when the bytes are not UTF-8. */
private fun decode(media: FetchedMedia, kind: String): FetchState {
    if (kind == "picture") {
        if (media.tooLarge || media.data.isEmpty()) {
            return FetchState.Done(media, null, null, false)
        }
        val bytes = Base64.decode(media.data, Base64.DEFAULT)
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            ?: return FetchState.Error("the wall sent bytes that are not a picture")
        return FetchState.Done(media, bitmap.asImageBitmap(), null, false)
    }
    val bytes = Base64.decode(media.data, Base64.DEFAULT)
    val text = bytesToText(bytes)
    return if (text != null) {
        FetchState.Done(media, null, text, false)
    } else {
        FetchState.Done(media, null, null, true)
    }
}

/** A text file, or null when the bytes are not — a NUL, or invalid UTF-8, is
 *  the line between "read it" and "it is not text". */
private fun bytesToText(bytes: ByteArray): String? {
    val decoder = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
    return try {
        val text = decoder.decode(ByteBuffer.wrap(bytes)).toString()
        if (text.indexOf('\u0000') >= 0) null else text
    } catch (e: CharacterCodingException) {
        null
    }
}
