package cloud.agentdevice.node

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.io.Closeable
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.min
import kotlin.random.Random

class NodeWakeChannel internal constructor(
    private val requestProvider: () -> NodeWakeRequest,
    private val expectedNodeId: String,
    private val onWake: () -> Unit,
    private val onConnectionChanged: (Boolean) -> Unit = {},
    private val onError: (String) -> Unit = {},
    private val webSocketFactory: WebSocket.Factory = DEFAULT_CLIENT,
    private val scheduler: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor(),
    private val now: () -> Long = System::currentTimeMillis,
    private val random: () -> Double = { Random.nextDouble() },
    private val reconnectInitialMs: Long = 1_000,
    private val reconnectMaximumMs: Long = 30_000,
    private val stableConnectionMs: Long = 60_000
) : Closeable {
    private val running = AtomicBoolean()
    private val connectedState = AtomicBoolean()
    private val reconnectScheduled = AtomicBoolean()
    private val reconnectDelayMs = AtomicLong(reconnectInitialMs)
    private val activeSocket = AtomicReference<WebSocket?>()

    val connected: Boolean
        get() = connectedState.get()

    fun start() {
        if (running.compareAndSet(false, true)) scheduleConnect(0)
    }

    override fun close() {
        if (!running.getAndSet(false)) return
        connectedState.set(false)
        reconnectScheduled.set(false)
        activeSocket.getAndSet(null)?.cancel()
        scheduler.shutdownNow()
    }

    private fun scheduleConnect(delayMs: Long) {
        if (!running.get() || !reconnectScheduled.compareAndSet(false, true)) return
        scheduler.schedule(
            {
                reconnectScheduled.set(false)
                connect()
            },
            delayMs,
            TimeUnit.MILLISECONDS
        )
    }

    private fun connect() {
        if (!running.get() || activeSocket.get() != null) return
        try {
            val wake = requestProvider()
            val request = Request.Builder()
                .url(wake.url)
                .apply { wake.headers.forEach(::addHeader) }
                .build()
            val listener = Listener()
            activeSocket.set(webSocketFactory.newWebSocket(request, listener))
        } catch (error: Exception) {
            onError(error.message ?: error.javaClass.simpleName)
            scheduleConnect(advanceReconnectDelay(stable = false))
        }
    }

    private fun advanceReconnectDelay(stable: Boolean): Long {
        if (stable) {
            reconnectDelayMs.set(reconnectInitialMs)
            return reconnectInitialMs
        }
        val current = reconnectDelayMs.get()
        reconnectDelayMs.set(min(current * 2, reconnectMaximumMs))
        return (current * (0.8 + random() * 0.4)).toLong().coerceAtLeast(1)
    }

    private inner class Listener : WebSocketListener() {
        private var openedAt: Long? = null

        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (!running.get()) {
                webSocket.cancel()
                return
            }
            activeSocket.set(webSocket)
            openedAt = now()
            connectedState.set(true)
            onConnectionChanged(true)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (text.toByteArray().size > MAX_MESSAGE_BYTES) {
                webSocket.close(1009, "wake message is too large")
                return
            }
            try {
                val event = JSONObject(text)
                require(event.getString("schemaVersion") == "0.1")
                require(event.getString("type") == "dispatch.available")
                require(event.getString("nodeId") == expectedNodeId)
                Instant.parse(event.getString("issuedAt"))
                onWake()
            } catch (error: Exception) {
                onError("Invalid wake signal: ${error.message ?: error.javaClass.simpleName}")
                webSocket.close(1008, "invalid wake signal")
            }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            webSocket.close(1003, "binary wake messages are unsupported")
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            disconnected(webSocket, null)
        }

        override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
            disconnected(
                webSocket,
                response?.let { "Wake connection returned HTTP ${it.code}." }
                    ?: error.message
                    ?: error.javaClass.simpleName
            )
        }

        private fun disconnected(webSocket: WebSocket, error: String?) {
            if (!activeSocket.compareAndSet(webSocket, null)) return
            connectedState.set(false)
            onConnectionChanged(false)
            if (error != null && running.get()) onError(error)
            if (!running.get()) return
            val stable = openedAt?.let { now() - it >= stableConnectionMs } == true
            scheduleConnect(advanceReconnectDelay(stable))
        }
    }

    companion object {
        private const val MAX_MESSAGE_BYTES = 1024
        private val DEFAULT_CLIENT = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(30, TimeUnit.SECONDS)
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
    }
}
