package cloud.agentdevice.node

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.IntentFilter
import android.content.res.Configuration
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.concurrent.Executors
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.min

class NodeService : Service() {
    private val running = AtomicBoolean(false)
    private val executor = Executors.newSingleThreadExecutor()
    private val leaseExecutor = Executors.newSingleThreadScheduledExecutor()
    private lateinit var store: NodeStore
    private lateinit var protocol: NodeProtocol
    private lateinit var registry: CapabilityRegistry
    private lateinit var execution: MobileExecutionEngine
    private var controlFingerprint = ""
    private var lastControlMode = "idle"
    private val wakeSignals = ArrayBlockingQueue<Unit>(1)
    private var wakeChannel: NodeWakeChannel? = null
    private var wakeNodeId: String? = null
    private val languageReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == ScreenControl.ACTION_CHANGED) refreshControl()
            else refreshLocalizedNotification()
        }
    }
    private fun localizedString(id: Int, vararg arguments: Any): String =
        AppLanguage.localizedContext(this).getString(id, *arguments)

    override fun onCreate() {
        super.onCreate()
        store = NodeStore(this)
        protocol = NodeProtocol(store)
        registry = CapabilityRegistry(this)
        execution = MobileExecutionEngine(store, registry)
        createChannel()
        lastControlMode = registry.screenControl.view().optString("mode")
        ContextCompat.registerReceiver(this, languageReceiver, IntentFilter().apply {
            addAction(AppLanguage.ACTION_CHANGED)
            addAction(ScreenControl.ACTION_CHANGED)
        },
            ContextCompat.RECEIVER_NOT_EXPORTED)
        leaseExecutor.scheduleWithFixedDelay({ if (active) refreshControl() }, 1, 1, TimeUnit.SECONDS)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        refreshLocalizedNotification()
    }

    private fun refreshLocalizedNotification() {
        createChannel()
        if (active) updateNotification(when (store.runtimeState()) {
            "online" -> localizedString(R.string.node_connected, store.config()?.label.orEmpty())
            "retrying" -> localizedString(R.string.node_retrying)
            else -> localizedString(R.string.node_service_idle)
        })
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_TAKEOVER) registry.screenControl.takeover()
        if (intent?.action == ACTION_RESUME) runCatching { registry.screenControl.resume() }
        if (intent?.action == ACTION_START) store.setNodeDesired(true)
        if (intent?.action == ACTION_STOP) store.setNodeDesired(false)
        if (!store.isNodeDesired()) {
            stopNode()
            return START_NOT_STICKY
        }
        active = true
        if (!running.get()) store.setRuntimeState("connecting")
        when (intent?.action) {
            ACTION_STOP -> {
                stopNode()
                return START_NOT_STICKY
            }
            ACTION_SCREEN_CAPTURE_GRANTED -> {
                startForegroundNotification(screenCapture = true)
                val resultCode = intent.getIntExtra(EXTRA_SCREEN_CAPTURE_RESULT_CODE, 0)
                try {
                    val captureData =
                        intent.getParcelableExtra<Intent>(EXTRA_SCREEN_CAPTURE_DATA)
                            ?: throw IllegalArgumentException(
                                "Android did not return screen capture consent data."
                            )
                    ScreenCaptureSession.start(this, resultCode, captureData)
                } catch (error: Exception) {
                    store.setCapabilityEnabled(CapabilityGroup.SCREEN_CAPTURE, false)
                    sendBroadcast(
                        Intent(ScreenCaptureSession.ACTION_CAPABILITY_CHANGED)
                            .setPackage(packageName)
                            .putExtra(EXTRA_ERROR, error.message)
                    )
                    startForegroundNotification(screenCapture = false)
                }
                startPollingIfNeeded()
                return START_STICKY
            }
            ACTION_SCREEN_CAPTURE_STOP -> {
                ScreenCaptureSession.stop(this)
                startForegroundNotification(screenCapture = false)
                startPollingIfNeeded()
                return START_STICKY
            }
        }
        startForegroundNotification(screenCapture = ScreenCaptureSession.isActive())
        startPollingIfNeeded()
        return START_STICKY
    }

    override fun onDestroy() {
        registry.screenControl.interrupt("service_stopped")
        unregisterReceiver(languageReceiver)
        active = false
        store.setRuntimeState(if (store.isNodeDesired()) "interrupted" else "stopped")
        running.set(false)
        wakeChannel?.close()
        wakeChannel = null
        ScreenCaptureSession.stop()
        registry.close()
        executor.shutdownNow()
        leaseExecutor.shutdownNow()
        super.onDestroy()
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        stopNode()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startPollingIfNeeded() {
        if (running.compareAndSet(false, true)) executor.execute(::pollLoop)
    }

    private fun pollLoop() {
        var backoffMs = 2_000L
        var pollImmediately = true
        while (running.get()) {
            val config = store.config()
            if (config == null) {
                publishStatus(false, "Pair this phone before starting the Node.")
                stopNode()
                return
            }
            val wake = ensureWakeChannel(config)
            try {
                if (!wake.connected && pollImmediately && !waitForWake(WS_CONNECT_GRACE_MS)) return
                if (wake.connected && !pollImmediately && !waitForWake(DURABLE_POLL_MS)) return
                if (pollImmediately) wakeSignals.clear()
                val response = protocol.poll(
                    config,
                    registry.manifest(config.nodeId),
                    waitForWake = !wake.connected
                )
                if (!running.get() || !store.isNodeDesired()) return
                val now = DateTimeFormatter.ISO_INSTANT.format(Instant.now())
                store.setConnectionState(now, null)
                publishStatus(true, null)
                updateNotification(localizedString(R.string.node_connected, config.label))
                backoffMs = 2_000L
                val dispatch = response.optJSONObject("dispatch")
                dispatch?.let { execute(config, it) }
                pollImmediately = dispatch != null
                if (
                    dispatch == null &&
                    !wake.connected &&
                    !response.optBoolean("longPoll") &&
                    !waitForWake(POLL_INTERVAL_MS)
                ) return
            } catch (error: Exception) {
                if (!running.get() || !store.isNodeDesired()) return
                registry.screenControl.interrupt("connection")
                val message =
                    when (error) {
                        is NodeApiException -> "${error.code}: ${error.message}"
                        else -> error.message ?: error.javaClass.simpleName
                    }
                store.setConnectionState(null, message)
                publishStatus(false, message)
                updateNotification(localizedString(R.string.node_retrying))
                if (error is NodeApiException && error.statusCode in listOf(401, 403)) {
                    store.setNodeDesired(false)
                    store.setRuntimeState("stopped")
                    stopSelf()
                    return
                }
                pollImmediately = true
                if (!waitForWake(backoffMs)) return
                backoffMs = min(backoffMs * 2, 60_000L)
            }
        }
    }

    private fun ensureWakeChannel(config: NodeConfig): NodeWakeChannel {
        val existing = wakeChannel
        if (existing != null && wakeNodeId == config.nodeId) return existing
        existing?.close()
        wakeSignals.clear()
        return NodeWakeChannel(
            requestProvider = { protocol.wakeRequest(config) },
            expectedNodeId = config.nodeId,
            onWake = { wakeSignals.offer(Unit) },
            onConnectionChanged = { wakeSignals.offer(Unit) }
        ).also {
            wakeNodeId = config.nodeId
            wakeChannel = it
            it.start()
        }
    }

    private fun waitForWake(durationMs: Long): Boolean =
        try {
            wakeSignals.poll(durationMs, TimeUnit.MILLISECONDS)
            running.get()
        } catch (_: InterruptedException) {
            false
        }

    private fun execute(config: NodeConfig, dispatch: JSONObject) {
        val dispatchId = dispatch.getString("dispatchId")
        val leaseToken = dispatch.getString("leaseToken")
        val acknowledged = protocol.acknowledge(config, dispatchId, leaseToken)
        val cancelled = AtomicBoolean(acknowledged.optBoolean("cancelRequested"))
        val leaseValid = AtomicBoolean(true)
        val leaseExpiresAt = AtomicLong(
            Instant.parse(acknowledged.getString("leaseExpiresAt")).toEpochMilli()
        )
        val invocation = dispatch.getJSONObject("invocation")
        val executionDeadline = if (invocation.has("executionTimeoutMs")) {
            minOf(
                Instant.parse(invocation.getString("expiresAt")).toEpochMilli(),
                Instant.parse(invocation.getString("issuedAt")).toEpochMilli() +
                    invocation.getLong("executionTimeoutMs")
            )
        } else Long.MAX_VALUE
        val isCancelled = {
            val expired = System.currentTimeMillis() >= leaseExpiresAt.get()
            if (expired) {
                registry.screenControl.interrupt("invocation_lease")
                leaseValid.set(false)
                cancelled.set(true)
            }
            cancelled.get() || !running.get() || System.currentTimeMillis() >= executionDeadline
        }
        val renewal = leaseExecutor.scheduleWithFixedDelay(
            {
                // Keep the lease while a timed-out operation observes cancellation and
                // reconciles its result. The execution budget must not invalidate receipts.
                if (
                    !cancelled.get() && running.get() && leaseValid.get() &&
                    System.currentTimeMillis() < leaseExpiresAt.get()
                ) {
                    try {
                        val response = protocol.renewLease(config, dispatchId, leaseToken)
                        leaseExpiresAt.set(
                            Instant.parse(response.getString("leaseExpiresAt")).toEpochMilli()
                        )
                        if (response.optBoolean("cancelRequested")) cancelled.set(true)
                    } catch (error: Exception) {
                        if (
                            error is NodeApiException &&
                            error.statusCode in listOf(401, 403, 409)
                        ) {
                            registry.screenControl.interrupt("invocation_lease")
                            leaseValid.set(false)
                            cancelled.set(true)
                        }
                    }
                }
            },
            LEASE_RENEW_INTERVAL_MS,
            LEASE_RENEW_INTERVAL_MS,
            TimeUnit.MILLISECONDS
        )
        try {
            val executionResult = execution.execute(config.nodeId, dispatch, isCancelled)
            if (leaseValid.get() && System.currentTimeMillis() < leaseExpiresAt.get()) {
                executionResult.artifacts.forEach {
                    protocol.uploadArtifact(config, dispatchId, it)
                }
                protocol.complete(config, dispatchId, leaseToken, executionResult.result)
            }
        } catch (error: Exception) {
            registry.screenControl.interrupt("result_delivery")
            throw error
        } finally {
            renewal.cancel(true)
        }
    }

    private fun stopNode() {
        registry.screenControl.interrupt("service_stopped")
        store.setNodeDesired(false)
        store.setRuntimeState("stopped")
        running.set(false)
        wakeChannel?.close()
        wakeChannel = null
        ScreenCaptureSession.stop(this)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        publishStatus(false, "Node stopped")
    }

    private fun createChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(
                SERVICE_CHANNEL,
                localizedString(R.string.node_service_channel),
                NotificationManager.IMPORTANCE_LOW
            )
        )
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CONTROL_CHANNEL, localizedString(R.string.screen_channel),
                NotificationManager.IMPORTANCE_HIGH).apply { setSound(null, null); enableVibration(false) }
        )
    }

    private fun serviceNotification(text: String): android.app.Notification {
        val state = registry.screenControl.view()
        val controlling = state.optString("mode") in setOf("using", "waiting", "handing_back")
        val activity = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, NodeService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val controlAction = PendingIntent.getService(this, 2,
            Intent(this, NodeService::class.java).setAction(if (state.optBoolean("paused")) ACTION_RESUME else ACTION_TAKEOVER),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Builder(this, SERVICE_CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(if (state.optString("mode") == "idle") localizedString(R.string.node_service_title)
                else ScreenControlText.title(AppLanguage.localizedContext(this), state))
            .setContentText(if (state.optString("mode") == "idle") text else ScreenControlText.detail(AppLanguage.localizedContext(this), state))
            .setContentIntent(activity)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .apply {
                if (controlling || state.optBoolean("paused")) addAction(0,
                    localizedString(if (state.optBoolean("paused")) R.string.screen_resume else R.string.screen_takeover), controlAction)
            }
            .addAction(0, localizedString(R.string.node_stop), stop)
            .build()
    }

    @Synchronized private fun refreshControl() {
        val state = registry.screenControl.view()
        val fingerprint = state.toString()
        if (fingerprint == controlFingerprint) return
        controlFingerprint = fingerprint
        val mode = state.optString("mode")
        if (mode != lastControlMode) {
            val began = mode in setOf("using", "waiting") && lastControlMode !in setOf("using", "waiting")
            if (began || mode in setOf("released", "interrupted")) {
                runCatching {
                    val vibrator = getSystemService(android.os.Vibrator::class.java)
                    vibrator.vibrate(android.os.VibrationEffect.createWaveform(
                        if (began) longArrayOf(0, 60) else longArrayOf(0, 40, 70, 40), -1))
                    val activity = PendingIntent.getActivity(this, 3, Intent(this, MainActivity::class.java),
                        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                    val takeover = PendingIntent.getService(this, 4,
                        Intent(this, NodeService::class.java).setAction(ACTION_TAKEOVER),
                        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                    getSystemService(NotificationManager::class.java).notify(CONTROL_NOTIFICATION_ID,
                        NotificationCompat.Builder(this, CONTROL_CHANNEL)
                            .setSmallIcon(R.drawable.ic_launcher)
                            .setContentTitle(ScreenControlText.title(AppLanguage.localizedContext(this), state))
                            .setContentText(ScreenControlText.detail(AppLanguage.localizedContext(this), state))
                            .setContentIntent(activity).setAutoCancel(true)
                            .setPriority(NotificationCompat.PRIORITY_HIGH)
                            .apply { if (began) addAction(0, localizedString(R.string.screen_takeover), takeover) }
                            .build())
                }
            }
            lastControlMode = mode
        }
        refreshLocalizedNotification()
    }

    private fun startForegroundNotification(screenCapture: Boolean) {
        val types =
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or
                (if (screenCapture) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
                } else {
                    0
                })
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            serviceNotification(localizedString(R.string.node_service_idle)),
            types
        )
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, serviceNotification(text))
    }

    private fun publishStatus(connected: Boolean, error: String?) {
        store.setRuntimeState(
            if (!store.isNodeDesired()) "stopped" else if (connected) "online" else "retrying"
        )
        sendBroadcast(
            Intent(ACTION_STATUS)
                .setPackage(packageName)
                .putExtra(EXTRA_CONNECTED, connected)
                .putExtra(EXTRA_ERROR, error)
        )
    }

    companion object {
        @Volatile private var active = false
        fun isActive(): Boolean = active
        const val ACTION_STATUS = "cloud.agentdevice.node.STATUS"
        const val EXTRA_CONNECTED = "connected"
        const val EXTRA_ERROR = "error"
        private const val ACTION_START = "cloud.agentdevice.node.START"
        private const val ACTION_STOP = "cloud.agentdevice.node.STOP"
        private const val ACTION_SCREEN_CAPTURE_GRANTED =
            "cloud.agentdevice.node.SCREEN_CAPTURE_GRANTED"
        private const val ACTION_SCREEN_CAPTURE_STOP =
            "cloud.agentdevice.node.SCREEN_CAPTURE_STOP"
        private const val EXTRA_SCREEN_CAPTURE_RESULT_CODE = "screenCaptureResultCode"
        private const val EXTRA_SCREEN_CAPTURE_DATA = "screenCaptureData"
        private const val SERVICE_CHANNEL = "adc-node-service"
        private const val CONTROL_CHANNEL = "adc-screen-control"
        private const val CONTROL_NOTIFICATION_ID = 4102
        private const val ACTION_TAKEOVER = "cloud.agentdevice.node.TAKEOVER_SCREEN"
        private const val ACTION_RESUME = "cloud.agentdevice.node.RESUME_SCREEN"
        private const val NOTIFICATION_ID = 4101
        private const val POLL_INTERVAL_MS = 1_000L
        private const val WS_CONNECT_GRACE_MS = 500L
        private const val DURABLE_POLL_MS = 30_000L
        private const val LEASE_RENEW_INTERVAL_MS = 8_000L

        fun start(context: Context) {
            NodeStore(context).apply {
                setNodeDesired(true)
                setRuntimeState("connecting")
            }
            ContextCompat.startForegroundService(
                context,
                Intent(context, NodeService::class.java).setAction(ACTION_START)
            )
        }

        fun stop(context: Context) {
            NodeStore(context).apply {
                setNodeDesired(false)
                setRuntimeState("stopped")
            }
            context.stopService(Intent(context, NodeService::class.java))
        }

        fun startScreenCapture(context: Context, resultCode: Int, data: Intent) {
            check(NodeStore(context).isNodeDesired()) { "Start the phone Node before sharing the screen." }
            ContextCompat.startForegroundService(
                context,
                Intent(context, NodeService::class.java)
                    .setAction(ACTION_SCREEN_CAPTURE_GRANTED)
                    .putExtra(EXTRA_SCREEN_CAPTURE_RESULT_CODE, resultCode)
                    .putExtra(EXTRA_SCREEN_CAPTURE_DATA, data)
            )
        }

        fun stopScreenCapture(context: Context) {
            if (!active || !NodeStore(context).isNodeDesired()) {
                ScreenCaptureSession.stop(context)
                return
            }
            context.startService(
                Intent(context, NodeService::class.java)
                    .setAction(ACTION_SCREEN_CAPTURE_STOP)
            )
        }
    }
}
