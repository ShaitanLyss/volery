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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
 * and this phone's name — readable and editable. These feed [Config], which
 * the home screen dials with. The walking modes (push-to-talk, "hey volery",
 * seamless), chatty level and duck-vs-pause land here in a later milestone.
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
                Button(
                    onClick = {
                        Config.host = host
                        Config.key = key
                        Config.name = name
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
