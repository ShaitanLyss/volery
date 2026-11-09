package com.volery.phone

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView

/**
 * Home: the fields the node needs (wall host, key phrase, this phone's name),
 * a "start and dial" button, and the roster + digest the dial came back with.
 * The node itself lives in [NodeService]; this screen is a view over
 * [NodeState].
 */
class MainActivity : Activity() {

    private lateinit var status: TextView
    private lateinit var host: EditText
    private lateinit var key: EditText
    private lateinit var name: EditText
    private lateinit var result: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        status = findViewById(R.id.status)
        host = findViewById(R.id.host)
        key = findViewById(R.id.key)
        name = findViewById(R.id.name)
        result = findViewById(R.id.result)

        host.setText(BuildConfig.PHONE_HOST)
        key.setText(BuildConfig.PHONE_KEY)
        name.setText(BuildConfig.PHONE_NAME)

        findViewById<Button>(R.id.dial).setOnClickListener {
            NodeService.dial(this, host.text.toString(), key.text.toString(), name.text.toString())
        }
        findViewById<Button>(R.id.settings).setOnClickListener {
            startActivity(Intent(this, SettingsActivity::class.java))
        }

        // Dial on open when a key is already configured — the phone joins the
        // flyway the moment you open it; the button is the re-dial.
        if (key.text.isNotEmpty()) {
            NodeService.dial(this, host.text.toString(), key.text.toString(), name.text.toString())
        }
    }

    override fun onResume() {
        super.onResume()
        NodeState.observe { redraw() }
    }

    override fun onPause() {
        super.onPause()
        NodeState.clear()
    }

    private fun redraw() {
        status.text = when {
            NodeState.working -> "dialing…"
            NodeState.error != null -> "failed"
            NodeState.result != null -> "done"
            else -> "idle"
        }
        result.text = NodeState.error ?: NodeState.result ?: ""
    }
}
