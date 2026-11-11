package com.volery.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.Manifest
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
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

    /** Whether `NativeBridge.start` has succeeded in this process. A promotion
     *  before the first dial must not start a poll loop with no node behind it:
     *  it would fail every fifteen seconds for ever, under a notification. */
    @Volatile
    private var nodeUp = false

    override fun onCreate() {
        super.onCreate()
        foreground()
    }

    /**
     * Become foreground — with the microphone type only when this app actually
     * holds the microphone.
     *
     * **The manifest declaring a type is not permission to use it.** Android 14
     * refuses `startForeground` for a microphone service whose app has no
     * `RECORD_AUDIO`: it throws `ForegroundServiceStartNotAllowedException`,
     * and because this is called from `onCreate` the whole process dies at
     * launch — which is exactly what happened the first time the type was
     * declared. So the active type is chosen per call: both bits when the
     * permission is held (which is what lets the ears open with the screen
     * off), data alone when it is not (the phone still reads the wall, and a
     * question still arrives on screen).
     *
     * Called again on every start command, because that is where a permission
     * granted in settings becomes an active type: granting happens with the
     * settings screen in front, which is the one moment Android allows this
     * service to widen.
     */
    private fun foreground() {
        val mic = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        /* `specialUse`, not `dataSync`, from Android 14 on: Android 15 caps
           `dataSync` at six hours in the background per day and then kills the
           service, which is exactly the walking day this exists for. A node on
           a private mesh is what `specialUse` is for, and the subtype property
           in the manifest is the sentence the platform asks for. */
        if (Build.VERSION.SDK_INT >= 34) {
            val types = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE or
                (if (mic) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0)
            try {
                startForeground(NOTIF_ID, notification(), types)
                return
            } catch (e: Exception) {
                Log.w(TAG, "the special-use type was refused; falling back for this session", e)
            }
        }
        if (Build.VERSION.SDK_INT >= 30 && mic) {
            /* Refused rather than thrown out of the process: the platform's
               condition for the microphone is the app being visible at this
               moment, and a start that arrives a beat before the window does
               must cost the ears, never the whole app. */
            try {
                startForeground(
                    NOTIF_ID,
                    notification(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
                )
                return
            } catch (e: Exception) {
                Log.w(TAG, "the microphone type was refused; reading without the ears", e)
            }
        }
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIF_ID, notification())
        }
    }

    /**
     * Android 15 tells a service it has overrun its type's background budget
     * before it kills it. This should never fire on `specialUse`; if it does
     * (a fallback type), stopping is the honest end: the next time the app is
     * opened the dial starts the service again, and dying without a word is the
     * outcome this override exists to avoid.
     */
    override fun onTimeout(startId: Int) {
        Log.w(TAG, "the foreground type timed out; the node will restart on the next dial")
        stopSelf()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        /* Re-evaluated every command: a permission granted a moment ago in
           settings widens the type here, and a phone that never granted one
           still runs. */
        foreground()
        if (intent?.getBooleanExtra(EXTRA_PROMOTE, false) == true) {
            /* Only if there is a node: a promotion is a permission change, not
               a reason to start polling a wall this phone has not dialled. */
            if (nodeUp) Narrator.of(applicationContext).ensure()
            return START_NOT_STICKY
        }
        val host = intent?.getStringExtra(EXTRA_HOST) ?: BuildConfig.PHONE_HOST
        if (intent?.getBooleanExtra(EXTRA_ONLY_SIGHT, false) == true) {
            // Another wall was chosen on the roster. The node is already
            // started and is the same node on every wall, so this asks it what
            // the other host publishes rather than throwing the dial away and
            // making a second one.
            sight(host)
            return START_NOT_STICKY
        }
        /* No build-time seed any more: the phrase is typed on the phone and
           kept wrapped by the Keystore, so a service the OS starts with no
           activity in front of it reads it itself. An empty key is answered
           with "not set" on the roster rather than a dial that goes nowhere. */
        if (Config.key.isEmpty()) Config.restoreKey(this)
        val key = intent?.getStringExtra(EXTRA_KEY) ?: Config.key
        val name = intent?.getStringExtra(EXTRA_NAME) ?: BuildConfig.PHONE_NAME
        val remembered = intent?.getStringExtra(EXTRA_REMEMBERED) ?: "[]"
        dial(host, remembered, key, name)
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        Narrator.of(this).stop()
        Speaker.shutdown()
        super.onDestroy()
    }

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
                is NativeBridge.Envelope.Ok -> {
                    landed(parseSighting(sight.payload), choose = true)
                    Narrator.of(applicationContext).ensure()
                }
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
                nodeUp = true
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
                        /* The loop belongs to the service, so it starts where
                           the node does: from here it keeps polling with the
                           screen off, which is the whole of hands-free. */
                        Narrator.of(applicationContext).ensure()
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
        /** Widen the service's foreground type after a permission was granted.
         *  Nothing else: the node keeps reading, the loop keeps polling. */
        const val EXTRA_PROMOTE = "promote"

        /** The microphone was just granted (or hands-free was switched on):
         *  re-enter the service so its foreground type is re-evaluated. It does
         *  start the service if it was not running, and that start fronts it;
         *  it does not start polling unless a node is already up. */
        fun promote(context: Context) {
            val intent = Intent(context, NodeService::class.java).putExtra(EXTRA_PROMOTE, true)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
            else context.startService(intent)
        }

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
