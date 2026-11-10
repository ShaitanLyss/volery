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
        if (intent?.getBooleanExtra(EXTRA_ONLY_SIGHT, false) == true) {
            // Another wall was chosen on the roster. The node is already
            // started and is the same node on every wall, so this asks it what
            // the other host publishes rather than throwing the dial away and
            // making a second one.
            sight(host)
            return START_NOT_STICKY
        }
        val key = intent?.getStringExtra(EXTRA_KEY) ?: BuildConfig.PHONE_KEY
        val name = intent?.getStringExtra(EXTRA_NAME) ?: BuildConfig.PHONE_NAME
        dial(host, key, name)
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /** Sight one wall while the node stays as it is: the roster's chips. The
     *  page keeps drawing what it has until the new sighting lands, so
     *  choosing a wall is a change of reading rather than a blank page. */
    private fun sight(host: String) {
        Log.i(TAG, "sight: host=$host")
        NodeState.update(working = true, sighting = NodeState.sighting, error = null)
        executor.execute {
            when (val sight = NativeBridge.parse(NativeBridge.sight(host))) {
                is NativeBridge.Envelope.Error -> {
                    Log.w(TAG, "sight failed: ${sight.message}")
                    NodeState.update(false, NodeState.sighting, sight.message)
                }
                is NativeBridge.Envelope.Ok -> {
                    NodeState.update(false, parseSighting(sight.payload), null)
                }
            }
        }
    }

    private fun dial(host: String, key: String, name: String) {
        Log.i(TAG, "dial: host=$host name=$name")
        NodeState.update(working = true, sighting = null, error = null)
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
                        val sighting = parseSighting(sight.payload)
                        Log.i(TAG, "dial result: ${sight.payload.toString(2)}")
                        NodeState.update(false, sighting, null)
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "the node threw", e)
                NodeState.update(false, null, e.message ?: "the node threw")
            }
        }
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
            .setContentTitle("Volery")
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
        const val EXTRA_ONLY_SIGHT = "only_sight"

        /** Read another wall with the node already up — the roster's chips. */
        fun sight(context: Context, host: String) {
            val intent = Intent(context, NodeService::class.java)
                .putExtra(EXTRA_HOST, host)
                .putExtra(EXTRA_ONLY_SIGHT, true)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
            else context.startService(intent)
        }

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
