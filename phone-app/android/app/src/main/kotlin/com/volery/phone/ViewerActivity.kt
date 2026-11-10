package com.volery.phone

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.webkit.MimeTypeMap
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

/**
 * The viewer: draws what [NativeBridge.fetch] pulls back over the flyway. A
 * picture becomes a bitmap, a file becomes its text (or a note that it is
 * binary), and both are pulled on a background thread because the JNI call
 * blocks.
 *
 * It is still the honest half of M2v — a picture by path or by the copy `show`
 * kept, a file by path, nothing else, so a pinned far-wall image and an
 * `ask_user` preview are deliberately not on offer here (they do not cross the
 * flyway yet). What changed is the page it is drawn on: a picture now stands on
 * a plate with its own caption row rather than on a bare tinted box, a text
 * file is a letter with its name and where it came from, and both are reachable
 * again — `copy path` and `save` at the foot, and `look at another` opening the
 * sheet the screen used to be.
 *
 * A caller may arrive with [EXTRA_PATH] or [EXTRA_KEPT] already set and the
 * thing is fetched on the first frame; with neither, the fetch sheet is open
 * when the screen is, so the viewer never opens onto a page with nothing on it
 * and no way to ask.
 */
class ViewerActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val host = intent.getStringExtra(EXTRA_HOST) ?: Config.host
        val card = intent.getStringExtra(EXTRA_CARD).orEmpty()
        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty()
        val kind = if (intent.getStringExtra(EXTRA_KIND) == "picture") "picture" else "file"
        val path = intent.getStringExtra(EXTRA_PATH).orEmpty()
        val kept = intent.getStringExtra(EXTRA_KEPT).orEmpty()
        setContent {
            VoleryTheme(theme = Config.theme, motion = Config.motion) {
                ViewerScreen(
                    host = host,
                    card = card,
                    title = title,
                    kind0 = kind,
                    path0 = path,
                    kept0 = kept,
                    onBack = { finish() },
                )
            }
        }
    }

    companion object {
        const val EXTRA_HOST = "host"
        const val EXTRA_CARD = "card"
        const val EXTRA_TITLE = "title"

        /** "picture" or "file" — what the caller already knows the thing is, so
         *  the sheet opens on the right half of its choice. */
        const val EXTRA_KIND = "kind"

        /** A path on the wall. Present, the viewer fetches it at once instead of
         *  asking. */
        const val EXTRA_PATH = "path"

        /** The name `show` kept the picture under, for a picture with no path. */
        const val EXTRA_KEPT = "kept"
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

/** One line the phone says back under the actions, and whether it is bad news. */
private data class Said(val text: String, val failed: Boolean = false)

@Composable
private fun ViewerScreen(
    host: String,
    card: String,
    title: String,
    kind0: String,
    path0: String,
    kept0: String,
    onBack: () -> Unit,
) {
    val p = LocalPalette.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    // The rail is the phone's constant: a picture you are looking at is still
    // something you can say a sentence about without leaving it.
    val ears = rememberEars()
    var typing by remember { mutableStateOf(false) }

    var kind by rememberSaveable { mutableStateOf(kind0) }
    var path by rememberSaveable { mutableStateOf(path0) }
    var kept by rememberSaveable { mutableStateOf(kept0) }
    var sheet by rememberSaveable { mutableStateOf(path0.isEmpty() && kept0.isEmpty()) }
    var state by remember { mutableStateOf<FetchState>(FetchState.Idle) }
    var said by remember { mutableStateOf<Said?>(null) }

    // The request actually made, kept across a rotation. The bitmap cannot be
    // saved — a recycled one is a recycled one — so the same fetch is made
    // again rather than the page coming back empty under a head that named
    // something. Empty kind means nothing has been asked for yet.
    var askedKind by rememberSaveable { mutableStateOf("") }
    var askedPath by rememberSaveable { mutableStateOf("") }
    var askedKept by rememberSaveable { mutableStateOf("") }

    fun fetch() {
        if (state is FetchState.Loading) return
        val sendKind = kind
        val sendPath = path.trim()
        val sendKept = kept.trim()
        askedKind = sendKind
        askedPath = sendPath
        askedKept = sendKept
        scope.launch {
            state = FetchState.Loading
            val result = withContext(Dispatchers.IO) {
                val envelope = NativeBridge.parse(
                    NativeBridge.fetch(host, card, sendKind, sendKept, sendPath),
                )
                when (envelope) {
                    is NativeBridge.Envelope.Error -> FetchState.Error(envelope.message)
                    is NativeBridge.Envelope.Ok -> decode(parseFetched(envelope.payload), sendKind)
                }
            }
            state = result
            if (result is FetchState.Done) sheet = false
        }
    }

    fun openSheet() {
        if (state is FetchState.Error) state = FetchState.Idle
        said = null
        sheet = true
    }

    // Arrive already knowing what to look at, or arrive asking. The asked-*
    // branch is the second entry this screen makes — a rotation — and comes
    // first so it wins over the intent's own extras.
    LaunchedEffect(Unit) {
        if (askedKind.isNotEmpty()) {
            kind = askedKind
            path = askedPath
            kept = askedKept
            state = FetchState.Idle
            fetch()
        } else if (path0.isNotEmpty() || kept0.isNotEmpty()) {
            fetch()
        }
    }

    // The confirmation under the actions is a moment, not a message.
    LaunchedEffect(said) {
        if (said != null) {
            delay(2000)
            said = null
        }
    }

    val done = state as? FetchState.Done
    // What is on the page is what was *fetched*, not what the sheet is
    // currently pointed at — flipping the choice and closing the sheet again
    // must not relabel a picture as a file.
    val headName = if (done != null) mediaName(done, askedKind) else "viewer"
    val headSub = when {
        done != null -> buildList {
            add(if (askedKind == "picture") "picture" else "file")
            if (done.media.bytes > 0) add(sizeSaid(done.media.bytes))
            if (title.isNotEmpty()) add("from $title")
        }
        state is FetchState.Loading -> listOf("fetching…")
        else -> listOf("nothing fetched yet")
    }

    fun share() {
        val media = done ?: return
        val body = shareBody(media, askedPath) ?: return
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, body)
        }
        runCatching { context.startActivity(Intent.createChooser(send, null)) }
    }

    fun copyPath() {
        val loaded = done ?: return
        val text = loaded.media.full.ifEmpty { askedPath }
        if (text.isEmpty()) {
            said = Said("this one came back without a path")
            return
        }
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        if (clipboard == null) {
            said = Said("this phone has no clipboard", failed = true)
            return
        }
        clipboard.setPrimaryClip(ClipData.newPlainText("path", text))
        said = Said("copied")
    }

    fun save() {
        val media = done?.media ?: return
        if (media.data.isEmpty()) {
            said = Said("nothing came over to save")
            return
        }
        val name = media.name
        scope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { saveToDownloads(context, name, Base64.decode(media.data, Base64.DEFAULT)) }
            }
            said = result.fold(
                onSuccess = { Said("saved to downloads/$it") },
                onFailure = { Said("could not save it — ${it.message ?: "the phone refused"}", failed = true) },
            )
        }
    }

    Ground(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            ViewerHead(
                name = headName,
                sub = headSub,
                onBack = onBack,
                onShare = if (done != null) ({ share() }) else null,
            )
            Column(
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .windowInsetsPadding(WindowInsets.navigationBars)
                    .padding(start = 18.dp, end = 18.dp, top = 2.dp, bottom = 104.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                val current = state
                when (current) {
                    FetchState.Idle -> NothingYet(onOpen = { openSheet() })
                    FetchState.Loading -> Fetching()
                    is FetchState.Error -> {
                        Note(current.message, color = p.fail)
                        // The sheet stays up on a failed fetch, so this only
                        // shows when it was let go of — and a page that says
                        // why and offers nothing is a page you have to leave.
                        ActionButton(
                            "look at something",
                            onClick = { openSheet() },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    is FetchState.Done -> {
                        ViewerBody(current)
                        Actions(
                            onCopy = { copyPath() },
                            onSave = { save() },
                            onAnother = { openSheet() },
                        )
                    }
                }
                said?.let { Note(it.text, color = if (it.failed) p.fail else p.note) }
            }
        }
        VoiceRail(
            voice = ears.voice,
            status = ears.steer.status,
            onType = { typing = true },
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .windowInsetsPadding(WindowInsets.navigationBars)
                .padding(horizontal = 16.dp)
                .padding(bottom = 26.dp),
        )
        if (sheet) {
            FetchSheet(
                kind = kind,
                onKind = { kind = it },
                path = path,
                onPath = { path = it },
                kept = kept,
                onKept = { kept = it },
                state = state,
                onFetch = { fetch() },
                onDismiss = { sheet = false },
            )
        }
        EarsOverlay(ears = ears, typing = typing, onTyping = { typing = it })
    }
}

/* ── the head ───────────────────────────────────────────────────────────── */

/** Back, what you are looking at, and the one gesture that leaves the phone —
 *  the mockup's `.head`. The title is chrome's own medium sans; the line under
 *  it is three quiet parts with the mockup's small dots between them. */
@Composable
private fun ViewerHead(
    name: String,
    sub: List<String>,
    onBack: () -> Unit,
    onShare: (() -> Unit)?,
) {
    val p = LocalPalette.current
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 62.dp)
            .windowInsetsPadding(WindowInsets.statusBars)
            .padding(start = 8.dp, end = 8.dp, top = 2.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        IconBtn(Glyph.Back, "back", onBack)
        Column(
            Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(
                name,
                style = Type.headTitle(p),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(7.dp),
            ) {
                sub.forEachIndexed { i, part ->
                    if (i > 0) {
                        Box(
                            Modifier
                                .size(4.dp)
                                .clip(CircleShape)
                                .background(p.paperFaint),
                        )
                    }
                    Text(
                        part,
                        style = Type.note(p, p.note),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        // A share button with nothing behind it is a button that does nothing,
        // so it is absent until something has been fetched to share.
        if (onShare != null) IconBtn(Glyph.Share, "share", onShare)
    }
}

/* ── the body ───────────────────────────────────────────────────────────── */

@Composable
private fun NothingYet(onOpen: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Note("a picture or a file the wall can reach.")
        ActionButton(
            "look at something",
            onClick = onOpen,
            modifier = Modifier.fillMaxWidth(),
            primary = true,
        )
    }
}

@Composable
private fun Fetching() {
    val p = LocalPalette.current
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        StatusDot(DotKind.Work)
        Text("fetching…", style = Type.note(p))
    }
}

@Composable
private fun ViewerBody(done: FetchState.Done) {
    when {
        done.image != null -> PicturePlate(done)
        done.text != null -> Letter(done)
        done.binary -> BinaryFile(done)
        // A picture that came back with no bytes is a picture that was too
        // large to draw; the honest answer is the sentence, not a broken frame.
        else -> TooLargeToDraw()
    }
}

@Composable
private fun TooLargeToDraw() {
    Note("too large to draw here — the wall kept the full picture over there.")
}

/**
 * The picture on its plate: an 18 dp slab of surface with a hairline and a real
 * shadow, the picture fitted to its own box, and the caption row inside the
 * plate's foot the way a print carries its own label. Never a bare image on the
 * page — that was the thing the mockup was drawn to stop.
 */
@Composable
private fun PicturePlate(done: FetchState.Done) {
    val p = LocalPalette.current
    val img = done.image ?: return
    val m = done.media
    val aspect = if (img.width > 0 && img.height > 0) {
        img.width.toFloat() / img.height.toFloat()
    } else {
        4f / 3f
    }
    val shape = RoundedCornerShape(18.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .shadow(22.dp, shape, clip = false, ambientColor = p.shade, spotColor = p.shade)
            .clip(shape)
            .background(p.surface)
            .border(1.dp, p.hair, shape),
    ) {
        Image(
            bitmap = img,
            contentDescription = m.name.ifEmpty { "the picture" },
            contentScale = ContentScale.Fit,
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(aspect),
        )
        Hair()
        Row(
            Modifier
                .fillMaxWidth()
                .background(p.surface.copy(alpha = 0.82f))
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            // The name is paper's dim step and the figure beside it is the
            // note's, so the row reads as a label rather than a sentence.
            val caption = buildAnnotatedString {
                withStyle(SpanStyle(color = p.paperDim)) {
                    append(m.name.ifEmpty { "a picture" })
                }
                append(" · ")
                withStyle(SpanStyle(color = p.note)) { append(sizeSaid(m.bytes)) }
            }
            Text(
                caption,
                style = Type.note(p),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (m.sizeWidth != null && m.sizeHeight != null) {
                Text("${m.sizeWidth}×${m.sizeHeight}", style = Type.note(p), maxLines = 1)
            }
        }
    }
}

/**
 * A text file as a letter: the name it came under and where it came from at the
 * head, then the file's own words in the book's face, selectable so a line can
 * be taken out of it.
 */
@Composable
private fun Letter(done: FetchState.Done) {
    val p = LocalPalette.current
    val m = done.media
    val text = done.text ?: return
    val shape = RoundedCornerShape(16.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(p.surface.copy(alpha = 0.46f))
            .border(1.dp, p.hair, shape)
            .padding(start = 15.dp, end = 15.dp, top = 13.dp, bottom = 14.dp),
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                m.name.ifEmpty { "a file" },
                style = Type.mono(p, 12.5f, p.paperDim),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text("came over the flyway", style = Type.note(p), maxLines = 1)
        }
        if (m.full.isNotEmpty()) {
            Text(
                m.full,
                style = Type.mono(p, 11f, p.paperMute),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.height(1.dp))
        SelectionContainer {
            Text(text, style = Type.prose(p))
        }
    }
}

/** A file that is not text says so in a sentence, and says where it is on the
 *  wall in mono — the one thing about it that can be acted on from here. */
@Composable
private fun BinaryFile(done: FetchState.Done) {
    val p = LocalPalette.current
    val m = done.media
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Note("a binary file — ${sizeSaid(m.bytes)}.")
        if (m.full.isNotEmpty()) {
            Text(m.full, style = Type.mono(p, 12f, p.paperMute))
        }
    }
}

/** The three things a fetched thing can be asked to do from here. `save` is the
 *  one lit paper button — the page's only bright object, as in the mockup. */
@Composable
private fun Actions(onCopy: () -> Unit, onSave: () -> Unit, onAnother: () -> Unit) {
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
        ActionButton(
            "copy path",
            onClick = onCopy,
            glyph = Glyph.Copy,
            modifier = Modifier.weight(1.4f),
        )
        ActionButton(
            "save",
            onClick = onSave,
            glyph = Glyph.Share,
            primary = true,
            modifier = Modifier.weight(1f),
        )
        ActionButton(
            "look at another",
            onClick = onAnother,
            modifier = Modifier.weight(1.5f),
        )
    }
}

/* ── the fetch sheet ────────────────────────────────────────────────────── */

/** What the screen used to be, now the sheet behind `look at another`: a
 *  picture or a file, a path on the wall or the name `show` kept it under, and
 *  one button. It closes itself on a good fetch and stays up, with the reason,
 *  on a bad one. */
@Composable
private fun FetchSheet(
    kind: String,
    onKind: (String) -> Unit,
    path: String,
    onPath: (String) -> Unit,
    kept: String,
    onKept: (String) -> Unit,
    state: FetchState,
    onFetch: () -> Unit,
    onDismiss: () -> Unit,
) {
    val p = LocalPalette.current
    VolerySheet(title = "look at something", onDismiss = onDismiss) {
        Segmented(
            options = listOf("picture" to "picture", "file" to "file"),
            selected = kind,
            onSelect = onKind,
        )
        Spacer(Modifier.height(14.dp))
        QuietField(
            value = path,
            onValueChange = onPath,
            label = "a path on the wall",
            mono = true,
            onDone = onFetch,
        )
        if (kind == "picture") {
            Spacer(Modifier.height(12.dp))
            QuietField(
                value = kept,
                onValueChange = onKept,
                label = "or the name show kept",
                mono = true,
                onDone = onFetch,
            )
        }
        if (state is FetchState.Loading) {
            Spacer(Modifier.height(14.dp))
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                StatusDot(DotKind.Work)
                Text("fetching…", style = Type.note(p))
            }
        }
        if (state is FetchState.Error) {
            Spacer(Modifier.height(10.dp))
            Note(state.message, color = p.fail)
        }
        Spacer(Modifier.height(16.dp))
        ActionButton(
            "fetch",
            onClick = { if (state !is FetchState.Loading) onFetch() },
            modifier = Modifier.fillMaxWidth(),
            primary = true,
            height = 56.dp,
        )
        Spacer(Modifier.height(4.dp))
    }
}

/* ── what a fetch turns into, and what can be done with it ──────────────── */

/** What a loaded thing is called: the wall's own name for it, or the quietest
 *  true thing when it came back without one. */
private fun mediaName(done: FetchState.Done, kind: String): String =
    done.media.name.ifEmpty { if (kind == "picture") "a picture" else "a file" }

/** What the share sheet carries: a text file's own words (capped, since a
 *  reader is not a file), else the path it is at, else the name it came under. */
private fun shareBody(done: FetchState.Done, asked: String): String? {
    val m = done.media
    return when {
        done.text != null -> done.text.take(2000)
        m.full.isNotEmpty() -> m.full
        asked.isNotEmpty() -> asked
        m.name.isNotEmpty() -> m.name
        else -> null
    }
}

/**
 * Write the bytes where a person can find them later, and say the name it
 * landed under. On API 29+ that is a `MediaStore.Downloads` row, which needs no
 * permission and shows up in the Files app; on anything older it is the app's
 * own Downloads directory, which also needs no permission and does not. Either
 * way the write is the caller's to have taken off the main thread.
 */
private fun saveToDownloads(context: Context, name: String, bytes: ByteArray): String {
    val fileName = name.ifEmpty { "volery-file" }
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        val resolver = context.contentResolver
        // The column names are asked of `MediaColumns` rather than of
        // `Downloads`: they are inherited from it, and reaching an inherited
        // Java interface field through another class is the kind of thing that
        // compiles in Java and not in Kotlin.
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeOf(fileName))
            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IOException("downloads would not take it")
        try {
            resolver.openOutputStream(uri)?.use { it.write(bytes) }
                ?: throw IOException("downloads would not open it")
            val settled = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
            resolver.update(uri, settled, null, null)
        } catch (e: Exception) {
            // A half-written pending row is invisible until it is not; take it
            // back out rather than leave a file that is 40% of a picture.
            runCatching { resolver.delete(uri, null, null) }
            throw e
        }
        fileName
    } else {
        val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: throw IOException("this phone has no downloads folder")
        dir.mkdirs()
        File(dir, fileName).apply { writeBytes(bytes) }
        fileName
    }
}

private fun mimeOf(name: String): String {
    val ext = name.substringAfterLast('.', "").lowercase()
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
}

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
