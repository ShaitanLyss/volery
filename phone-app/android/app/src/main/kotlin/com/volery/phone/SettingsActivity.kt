package com.volery.phone

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp

/**
 * Settings: the three fields the node needs — the wall host, the key phrase
 * and this phone's name — readable and editable, then the walking knobs: how
 * much the phone says, how you talk back, and what happens to your music while
 * it speaks. These feed [Config], which the home screen dials and narrates
 * with. The wake word is shown disabled — it is deferred, not forgotten.
 */
class SettingsActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            VoleryTheme { SettingsScreen(onSaved = { finish() }) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsScreen(onSaved: () -> Unit) {
    var host by rememberSaveable { mutableStateOf(Config.host) }
    var key by rememberSaveable { mutableStateOf(Config.key) }
    var name by rememberSaveable { mutableStateOf(Config.name) }
    var chatty by rememberSaveable { mutableStateOf(Config.chatty) }
    var mode by rememberSaveable { mutableStateOf(Config.mode) }
    var music by rememberSaveable { mutableStateOf(Config.music) }

    Box(Modifier.fillMaxSize().background(groundBrush())) {
        Scaffold(
            containerColor = Color.Transparent,
            topBar = {
                TopAppBar(
                    title = { Text("settings", fontFamily = FontFamily.Serif) },
                    navigationIcon = {
                        IconButton(onClick = onSaved) {
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
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Spacer(Modifier.height(4.dp))
                Text(
                    "the phone joins a wall by its name and key phrase — the same invite a laptop carries.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = InkMute,
                )
                SettingsField(
                    value = host,
                    onValueChange = { host = it },
                    label = "wall host",
                )
                SettingsField(
                    value = key,
                    onValueChange = { key = it },
                    label = "wall key phrase",
                )
                SettingsField(
                    value = name,
                    onValueChange = { name = it },
                    label = "this phone's name",
                )
                Spacer(Modifier.height(4.dp))
                ChattyControl(selected = chatty, onSelect = { chatty = it })
                Spacer(Modifier.height(4.dp))
                ModeControl(selected = mode, onSelect = { mode = it })
                Spacer(Modifier.height(4.dp))
                MusicControl(selected = music, onSelect = { music = it })
                Spacer(Modifier.height(4.dp))
                Button(
                    onClick = {
                        Config.host = host
                        Config.key = key
                        Config.name = name
                        Config.chatty = chatty
                        Config.mode = mode
                        Config.music = music
                        onSaved()
                    },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(12.dp),
                ) {
                    Text("save")
                }
            }
        }
    }
}

@Composable
private fun SettingsField(value: String, onValueChange: (String) -> Unit, label: String) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = true,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth(),
    )
}

/** The chatty level: three words that gate the narration loop, with the
 *  selected one's meaning said in quiet prose beneath. */
@Composable
private fun ChattyControl(selected: String, onSelect: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("how much the phone says", style = MaterialTheme.typography.labelMedium, color = InkMute)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ChattyOption("off", selected, onSelect)
            ChattyOption("needs", selected, onSelect)
            ChattyOption("murmur", selected, onSelect)
        }
        Text(chattyDetail(selected), style = MaterialTheme.typography.labelMedium, color = InkMute)
    }
}

@Composable
private fun ChattyOption(value: String, selected: String, onSelect: (String) -> Unit) {
    if (selected == value) {
        FilledTonalButton(onClick = { onSelect(value) }, shape = RoundedCornerShape(10.dp)) { Text(value) }
    } else {
        OutlinedButton(onClick = { onSelect(value) }, shape = RoundedCornerShape(10.dp)) { Text(value) }
    }
}

private fun chattyDetail(value: String): String = when (value) {
    "off" -> "nothing, even when a card is asking"
    "needs" -> "only what needs you — a card opened, a question waiting"
    "murmur" -> "everything notable — finishes, starts, notices too"
    else -> ""
}

/** How she talks back: one of the walking modes. The wake word is present but
 *  disabled — it would keep the microphone always on, which is battery-costly
 *  on Android, so it is deferred rather than shipped half-done. */
@Composable
private fun ModeControl(selected: String, onSelect: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("how you talk to it", style = MaterialTheme.typography.labelMedium, color = InkMute)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ModeOption("push-to-talk", selected, onSelect)
            ModeOption("seamless", selected, onSelect)
            OutlinedButton(
                onClick = {},
                enabled = false,
                shape = RoundedCornerShape(10.dp),
            ) { Text("hey-volery") }
        }
        Text(modeDetail(selected), style = MaterialTheme.typography.labelMedium, color = InkMute)
    }
}

@Composable
private fun ModeOption(value: String, selected: String, onSelect: (String) -> Unit) {
    if (selected == value) {
        FilledTonalButton(onClick = { onSelect(value) }, shape = RoundedCornerShape(10.dp)) { Text(value) }
    } else {
        OutlinedButton(onClick = { onSelect(value) }, shape = RoundedCornerShape(10.dp)) { Text(value) }
    }
}

private fun modeDetail(value: String): String = when (value) {
    "push-to-talk" -> "tap to talk — nothing listens until you do"
    "seamless" -> "after something needs you, it listens on its own for a moment"
    else -> ""
}

/** What happens to her music while the phone speaks something that needs her:
 *  duck lowers it, pause stops it — both resume when the line is done. */
@Composable
private fun MusicControl(selected: String, onSelect: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("when it needs you, your music", style = MaterialTheme.typography.labelMedium, color = InkMute)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MusicOption("duck", selected, onSelect)
            MusicOption("pause", selected, onSelect)
        }
        Text(musicDetail(selected), style = MaterialTheme.typography.labelMedium, color = InkMute)
    }
}

@Composable
private fun MusicOption(value: String, selected: String, onSelect: (String) -> Unit) {
    if (selected == value) {
        FilledTonalButton(onClick = { onSelect(value) }, shape = RoundedCornerShape(10.dp)) { Text(value) }
    } else {
        OutlinedButton(onClick = { onSelect(value) }, shape = RoundedCornerShape(10.dp)) { Text(value) }
    }
}

private fun musicDetail(value: String): String = when (value) {
    "duck" -> "lowers for the line, then back up"
    "pause" -> "stops for the line, then resumes"
    else -> ""
}
