package cloud.agentdevice.node

import android.content.Context
import android.content.Intent
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * The phone owns screen control. Transport polling cannot renew it.
 * A persisted active session is interrupted after process restart, never resumed.
 */
class ScreenControl(
    private val elapsed: () -> Long = { SystemClock.elapsedRealtime() },
    private val wall: () -> Long = { System.currentTimeMillis() },
    saved: JSONObject = JSONObject(),
    private val persist: (JSONObject) -> Unit = {},
    private val changed: () -> Unit = {}
) {
    private var paused = saved.optBoolean("paused")
    private var mode = saved.optString("mode", "idle")
    private var reason = saved.optString("reason")
    private var intent = saved.optString("intent")
    private var sessionId: String? = null
    private var owner: String? = null
    private var deadline = 0L
    private var accepting = false
    private val operations = mutableSetOf<Operation>()
    private val history = saved.optJSONArray("history") ?: JSONArray()

    init {
        if (mode in setOf("using", "waiting", "handing_back")) {
            mode = "interrupted"
            reason = "restart"
            save()
        }
    }

    @Synchronized
    fun execute(invocation: JSONObject, args: JSONObject): JSONObject {
        expire()
        val requester = ownerOf(invocation)
        val token = args.optString("controlSessionId")
        return when (args.getString("action")) {
            "begin" -> {
                if (paused) deny("Screen control is paused by you. Resume it in ADC → This phone.")
                if (accepting || operations.isNotEmpty()) conflict("Screen control is already in use or still settling.")
                val duration = lease(args)
                intent = declaredIntent(invocation).orEmpty()
                sessionId = "ctl_" + UUID.randomUUID().toString().replace("-", "")
                owner = requester
                deadline = elapsed() + duration
                accepting = true
                mode = "waiting"
                reason = ""
                save()
                status(requester, sessionId.orEmpty())
            }
            "renew" -> {
                requireSession(requester, token)
                deadline = elapsed() + lease(args)
                declaredIntent(invocation)?.let { intent = it }
                save()
                status(requester, token)
            }
            "end" -> {
                if (requester != owner || token != sessionId || token.isBlank()) deny("The screen control token does not belong to this actor.")
                if (accepting) release("model")
                status(requester, token)
            }
            "status" -> status(requester, token)
            else -> throw CapabilityException("invalid_request", "Unsupported screen control action.", false)
        }
    }

    @Synchronized
    fun acquire(invocation: JSONObject): Operation {
        expire()
        requireSession(ownerOf(invocation), invocation.optJSONObject("metadata")?.optString("controlSessionId").orEmpty())
        val operation = Operation()
        operations.add(operation)
        declaredIntent(invocation)?.let { intent = it }
        mode = "using"
        save()
        return operation
    }

    @Synchronized
    fun noteIntent(invocation: JSONObject) {
        expire()
        if (accepting && ownerOf(invocation) == owner &&
            invocation.optJSONObject("metadata")?.optString("controlSessionId") == sessionId) {
            declaredIntent(invocation)?.let { intent = it; save() }
        }
    }

    @Synchronized
    fun takeover() {
        paused = true
        release("user")
    }

    @Synchronized
    fun resume() {
        if (operations.isNotEmpty()) conflict("Screen actions are still settling. Try again shortly.")
        paused = false
        mode = "idle"
        reason = ""
        intent = ""
        sessionId = null
        owner = null
        save()
    }

    @Synchronized
    fun interrupt(cause: String) {
        expire()
        if (!accepting && operations.isEmpty()) return
        accepting = false
        mode = "interrupted"
        reason = cause
        save()
    }

    @Synchronized
    fun view(): JSONObject {
        expire()
        return JSONObject()
            .put("mode", mode).put("paused", paused).put("intent", intent)
            .put("reason", reason).put("remainingMs", if (accepting) (deadline - elapsed()).coerceAtLeast(0) else 0)
            .put("pendingActions", operations.size)
    }

    @Synchronized
    fun records(): JSONArray = JSONArray(history.toString())

    @Synchronized
    fun record(invocation: JSONObject, status: String) {
        val rows = (0 until history.length()).map { history.getJSONObject(it) }.takeLast(39)
        while (history.length() > 0) history.remove(0)
        rows.forEach { history.put(it) }
        history.put(JSONObject().put("tool", invocation.getString("tool"))
            .put("intent", runCatching { declaredIntent(invocation) }.getOrNull().orEmpty()).put("status", status).put("at", wall()))
        save()
    }

    inner class Operation internal constructor() {
        private var closed = false

        fun cancelled(): Boolean = synchronized(this@ScreenControl) {
            expire()
            closed || !accepting
        }

        /** Fence check and the actual short Android dispatch share a lock with takeover. */
        fun <T> guard(cancelled: () -> Boolean, action: () -> T): T = synchronized(this@ScreenControl) {
            expire()
            if (closed || !accepting || cancelled()) throw CapabilityException("cancelled", "Screen control was released before this action.", false)
            action()
        }

        fun close(uncertain: Boolean = false) = synchronized(this@ScreenControl) {
            if (closed) return@synchronized
            closed = true
            operations.remove(this)
            if (uncertain) {
                accepting = false
                mode = "interrupted"
                reason = "unknown_outcome"
            } else if (mode == "handing_back" && operations.isEmpty()) {
                mode = "released"
            } else if (accepting && operations.isEmpty()) {
                mode = "waiting"
            }
            save()
        }
    }

    private fun release(cause: String) {
        accepting = false
        reason = cause
        if (mode != "interrupted") mode = if (operations.isEmpty()) "released" else "handing_back"
        save()
    }

    private fun expire() {
        if (accepting && elapsed() >= deadline) {
            accepting = false
            mode = "interrupted"
            reason = "lease_expired"
            save()
        }
    }

    private fun requireSession(requester: String, token: String) {
        if (!accepting || paused || token.isBlank() || token != sessionId || owner != requester) {
            deny("Begin screen.control first and pass its active controlSessionId on this action. User takeover requires local resume in ADC.")
        }
    }

    private fun status(requester: String, token: String): JSONObject =
        view().apply {
            if (accepting && requester == owner && token == sessionId) put("controlSessionId", sessionId)
        }

    private fun lease(args: JSONObject): Long {
        val duration = args.optLong("leaseMs", 120_000L)
        if (duration !in 10_000L..180_000L) throw CapabilityException("invalid_request", "Screen control lease must be 10–180 seconds.", false)
        return duration
    }

    private fun save() {
        persist(viewWithoutExpiry().put("history", history))
        changed()
    }

    private fun viewWithoutExpiry(): JSONObject =
        JSONObject().put("mode", mode).put("paused", paused).put("reason", reason).put("intent", intent)

    private fun deny(message: String): Nothing = throw CapabilityException("denied", message, false)
    private fun conflict(message: String): Nothing = throw CapabilityException("conflict", message, false)

    companion object {
        const val ACTION_CHANGED = "cloud.agentdevice.node.SCREEN_CONTROL_CHANGED"
        val MUTATIONS = setOf("ui.action", "ui.gesture", "device.navigation", "app.open")
        @Volatile private var instance: ScreenControl? = null
        fun get(context: Context): ScreenControl = instance ?: synchronized(this) {
            instance ?: run {
                val app = context.applicationContext
                val preferences = app.getSharedPreferences("adc_screen_control", Context.MODE_PRIVATE)
                val saved = runCatching { JSONObject(preferences.getString("state", "{}")!!) }.getOrDefault(JSONObject())
                ScreenControl(saved = saved,
                    persist = { check(preferences.edit().putString("state", it.toString()).commit()) { "Unable to persist screen control state." } },
                    changed = { app.sendBroadcast(Intent(ACTION_CHANGED).setPackage(app.packageName)) }
                ).also { instance = it }
            }
        }

        private fun ownerOf(invocation: JSONObject): String {
            val actor = invocation.getJSONObject("actor")
            return "${invocation.getString("accountId")}:${actor.getString("type")}:${actor.getString("id")}"
        }

        fun declaredIntent(invocation: JSONObject): String? {
            val metadata = invocation.optJSONObject("metadata") ?: return null
            if (!metadata.has("intent")) return null
            val value = metadata.getString("intent").trim()
            if (value.isBlank() || value.length > 160 || value.any { it.code < 32 || it.code == 127 }) {
                throw CapabilityException("invalid_request", "Intent must be a short single line of at most 160 characters.", false)
            }
            return value
        }
    }
}
