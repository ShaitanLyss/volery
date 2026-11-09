package com.volery.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * The foreground service that starts the node and holds it alive while the app
 * is backgrounded (walking). The Rust side keeps the node in a process-wide
 * slot; this service is what keeps the process foreground enough that Android
 * will not kill it, and what owns the one background thread the blocking JNI
 * calls run on.
 */
class NodeService : Service() {

    private val executor = Executors.newSingleThreadExecutor()

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIF_ID, notification())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val host = intent?.getStringExtra(EXTRA_HOST) ?: BuildConfig.PHONE_HOST
        val key = intent?.getStringExtra(EXTRA_KEY) ?: BuildConfig.PHONE_KEY
        val name = intent?.getStringExtra(EXTRA_NAME) ?: BuildConfig.PHONE_NAME
        dial(host, key, name)
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun dial(host: String, key: String, name: String) {
        Log.i(TAG, "dial: host=$host name=$name")
        NodeState.update(working = true, result = null, error = null)
        executor.execute {
            try {
                // The one thing Android needs that the desktop never did: the
                // platform verifier reads the trust store through the Context.
                val init = NativeBridge.parse(NativeBridge.initPlatformVerifier(applicationContext))
                if (init is NativeBridge.Envelope.Error) {
                    Log.w(TAG, "verifier init failed: ${init.message}")
                    NodeState.update(false, null, init.message)
                    return@execute
                }
                val started = NativeBridge.parse(NativeBridge.start(key, name))
                if (started is NativeBridge.Envelope.Error) {
                    Log.w(TAG, "start failed: ${started.message}")
                    NodeState.update(false, null, started.message)
                    return@execute
                }
                Log.i(TAG, "node started as $name, dialing $host")
                when (val sight = NativeBridge.parse(NativeBridge.sight(host))) {
                    is NativeBridge.Envelope.Error -> {
                        Log.w(TAG, "sight failed: ${sight.message}")
                        NodeState.update(false, null, sight.message)
                    }
                    is NativeBridge.Envelope.Ok -> {
                        val rendered = render(name, sight.payload)
                        Log.i(TAG, "dial result:\n$rendered")
                        NodeState.update(false, rendered, null)
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "the node threw", e)
                NodeState.update(false, null, e.message ?: "the node threw")
            }
        }
    }

    private fun render(name: String, payload: JSONObject): String {
        val sb = StringBuilder()
        val roster = payload.optJSONArray("roster")
        if (roster != null) {
            sb.append("roster — ${roster.length()} wall(s):\n")
            for (i in 0 until roster.length()) {
                val w = roster.getJSONObject(i)
                val host = w.optString("host")
                val mine = if (host == name) "  ← this phone" else ""
                sb.append("  ${host}  live ${w.optInt("cards_live")}  working ${w.optInt("cards_working")}  build ${w.optString("build", "?")}$mine\n")
            }
        }
        val cards = payload.optJSONObject("cards")
        if (cards != null) {
            sb.append("\ncards digest from ${cards.optString("host")} (v${cards.optLong("version")}):\n")
            val snapshot = cards.optJSONObject("snapshot")
            if (snapshot != null) sb.append(snapshot.toString(2))
        } else {
            sb.append("\nno cards digest yet — the wall may still be painting itself")
        }
        return sb.toString()
    }

    private fun notification(): Notification {
        val channelId = "node"
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(channelId, "Flyway node", NotificationManager.IMPORTANCE_LOW))
        }
        val pi = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val builder =
            if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, channelId)
            else Notification.Builder(this)
        return builder
            .setContentTitle("Volery phone")
            .setContentText("on the flyway")
            .setSmallIcon(R.drawable.ic_stat_node)
            .setContentIntent(pi)
            .build()
    }

    companion object {
        private const val TAG = "PhoneNode"
        private const val NOTIF_ID = 1
        const val EXTRA_HOST = "host"
        const val EXTRA_KEY = "key"
        const val EXTRA_NAME = "name"

        fun dial(context: Context, host: String, key: String, name: String) {
            val intent = Intent(context, NodeService::class.java)
                .putExtra(EXTRA_HOST, host)
                .putExtra(EXTRA_KEY, key)
                .putExtra(EXTRA_NAME, name)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
            else context.startService(intent)
        }
    }
}
