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
        val remembered = intent?.getStringExtra(EXTRA_REMEMBERED) ?: "[]"
        dial(host, remembered, key, name)
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
                    /* The page goes on drawing the sighting it has, so the
                       wall it draws from must go on being the wall that
                       answers. Bounded to a tap: if a walk has already moved
                       the address somewhere else, that answer is newer than
                       this failure. */
                    restoreShownWall(ifCurrent = host)
                    NodeState.update(false, NodeState.sighting, sight.message)
                }
                is NativeBridge.Envelope.Ok -> landed(parseSighting(sight.payload), choose = true)
            }
        }
    }

    private fun dial(host: String, remembered: String, key: String, name: String) {
        Log.i(TAG, "dial: host=$host name=$name")
        /* The page keeps what it has while a dial runs. At launch there is
           nothing yet, but a redial from the error screen has the last
           sighting on it, and blanking the page to ask again is a worse
           answer than showing it while the retry is under way. */
        NodeState.update(working = true, sighting = NodeState.sighting, error = null)
        executor.execute {
            try {
                // The one thing Android needs that the desktop never did: the
                // platform verifier reads the trust store through the Context.
                val init = NativeBridge.parse(NativeBridge.initPlatformVerifier(applicationContext))
                if (init is NativeBridge.Envelope.Error) {
                    Log.w(TAG, "verifier init failed: ${init.message}")
                    restoreShownWall()
                    NodeState.update(false, NodeState.sighting, init.message)
                    return@execute
                }
                val started = NativeBridge.parse(NativeBridge.start(key, name))
                if (started is NativeBridge.Envelope.Error) {
                    Log.w(TAG, "start failed: ${started.message}")
                    restoreShownWall()
                    NodeState.update(false, NodeState.sighting, started.message)
                    return@execute
                }
                Log.i(TAG, "node started as $name, dialing $host")
                /* `sightAny`, not `sight`: the wall named here may be off
                   while the flyway is still up on others, and the answer
                   names whichever one opened. */
                when (val sight = NativeBridge.walk(host, remembered)) {
                    is NativeBridge.Envelope.Error -> {
                        Log.w(TAG, "sight failed: ${sight.message}")
                        restoreShownWall()
                        NodeState.update(false, NodeState.sighting, sight.message)
                    }
                    is NativeBridge.Envelope.Ok -> {
                        val sighting = parseSighting(sight.payload)
                        Log.i(TAG, "dial result: ${sight.payload.toString(2)}")
                        landed(sighting)
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "the node threw", e)
                restoreShownWall()
                NodeState.update(false, NodeState.sighting, e.message ?: "the node threw")
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
        const val EXTRA_REMEMBERED = "remembered"
        const val EXTRA_ONLY_SIGHT = "only_sight"

        /** Read another wall with the node already up — the roster's chips. */
        fun sight(context: Context, host: String) {
            val intent = Intent(context, NodeService::class.java)
                .putExtra(EXTRA_HOST, host)
                .putExtra(EXTRA_ONLY_SIGHT, true)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
            else context.startService(intent)
        }

        fun dial(context: Context, host: String, remembered: String, key: String, name: String) {
            val intent = Intent(context, NodeService::class.java)
                .putExtra(EXTRA_HOST, host)
                .putExtra(EXTRA_REMEMBERED, remembered)
                .putExtra(EXTRA_KEY, key)
                .putExtra(EXTRA_NAME, name)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
            else context.startService(intent)
        }
    }
}

/** Guards the pair below: a sighting lands from the service executor and from
 *  the narration loop's IO thread, and the address and the roster it sent must
 *  be written together or a walk and a tap can interleave half of each. */
private val landing = Any()

/**
 * The answer is now what this phone knows. The wall that opened is the one
 * every other call addresses — `Ears` sends a transcript to [Config.host],
 * `Steer` confirms a plan there, the viewer fetches there — and the roster it
 * sent is the list a later walk tries before it asks the directory.
 *
 * Written from the service rather than from a screen because the service
 * outlives every screen: a walk that switches walls while the app is in the
 * background must move the address with it, or a spoken sentence would go to
 * the laptop that is off.
 *
 * `settles` is false for a narration poll. A poll refreshes what the page
 * draws, but the working indicator belongs to a dial still walking; a poll
 * landing first must not clear it.
 *
 * `choose` is true only for a tap on a wall chip: a wall the person picked and
 * which answered is a preference from then on. An automatic fallback moves the
 * wall being read and leaves the preference alone, so the laptop you meant is
 * tried again next time.
 */
internal fun landed(sighting: Sighting, settles: Boolean = true, choose: Boolean = false) {
    synchronized(landing) {
        var changed = false
        if (sighting.host.isNotEmpty() && sighting.host != Config.host) {
            Config.host = sighting.host
            changed = true
        }
        val walls = sighting.roster
            .map { it.host }
            .filter { it.isNotBlank() && it != Config.name }
            .distinct()
        if (walls != Config.remembered) {
            Config.remembered = walls
            changed = true
        }
        if (changed) Config.persistWalls()
        if (choose && sighting.host.isNotEmpty() && sighting.host != Config.preferred) {
            Config.preferred = sighting.host
            Config.persistPreferred()
        }
        /* The page's own sighting is part of the landing, not the caller's to
           remember: a narration poll that switches walls must move the roster
           and the address together, or the page keeps drawing one wall while
           every later call names another. */
        NodeState.landed(sighting, settle = settles)
    }
}

/** Put the address back on the wall the page is drawing, after a dial that
 *  proved nothing. `ifCurrent` bounds it to a tap: if a walk has already moved
 *  the address somewhere else, that answer is newer than this failure. */
private fun restoreShownWall(ifCurrent: String? = null) {
    synchronized(landing) {
        val shown = NodeState.sighting?.host
        if (!shown.isNullOrEmpty() && shown != Config.host && (ifCurrent == null || Config.host == ifCurrent)) {
            Config.host = shown
            Config.persistWalls()
        }
    }
}
