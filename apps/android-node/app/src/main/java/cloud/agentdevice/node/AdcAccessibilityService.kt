package cloud.agentdevice.node

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.hardware.display.DisplayManager
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

class AdcAccessibilityService : AccessibilityService() {
    private val snapshotSession = UUID.randomUUID().toString().replace("-", "").take(12)
    private val snapshotRevision = AtomicLong()

    @Volatile
    private var lastEventAt = 0L

    override fun onServiceConnected() {
        active = this
        snapshotRevision.incrementAndGet()
        lastEventAt = SystemClock.elapsedRealtime()
        notifyCapabilityChanged()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        snapshotRevision.incrementAndGet()
        lastEventAt = SystemClock.elapsedRealtime()
    }

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        if (active === this) active = null
        notifyCapabilityChanged()
        super.onDestroy()
    }

    private fun inspect(maxDepth: Int, maxNodes: Int): JSONObject =
        snapshot(maxDepth, maxNodes).json

    private fun snapshot(maxDepth: Int, maxNodes: Int): UiSnapshot {
        val revision = snapshotRevision.get()
        val root = rootInActiveWindow
            ?: throw CapabilityException(
                "offline",
                "Android did not expose an active accessibility window.",
                true
            )
        val nodes = JSONArray()
        val packageName = root.packageName?.toString()
        val queue = ArrayDeque<QueuedNode>()
        queue.add(QueuedNode(root, 0, null, "w${root.windowId}"))
        var truncated = false
        try {
            while (queue.isNotEmpty()) {
                if (nodes.length() >= maxNodes) {
                    truncated = true
                    break
                }
                val current = queue.removeFirst()
                val node = current.node
                val id = nodes.length()
                nodes.put(nodeJson(node, id, current.parentId, current.depth, current.ref))
                if (current.depth < maxDepth) {
                    for (index in 0 until node.childCount) {
                        node.getChild(index)?.let {
                            queue.add(
                                QueuedNode(
                                    it,
                                    current.depth + 1,
                                    id,
                                    "${current.ref}/$index"
                                )
                            )
                        }
                    }
                } else if (node.childCount > 0) {
                    truncated = true
                }
                node.recycle()
            }
        } finally {
            while (queue.isNotEmpty()) queue.removeFirst().node.recycle()
        }
        val windowSnapshot = windowJson()
        val content = JSONObject()
            .put("packageName", packageName ?: JSONObject.NULL)
            .put("windowCount", windowSnapshot.length())
            .put("windows", windowSnapshot)
            .put("display", displayJson())
            .put("bounds", boundsJson(rootBounds(nodes)))
            .put("nodes", nodes)
            .put("truncated", truncated)
        val snapshotId = "uisnap_${snapshotSession}_$revision"
        return UiSnapshot(
            JSONObject(content.toString())
                .put("snapshotId", snapshotId)
                .put("observedAt", DateTimeFormatter.ISO_INSTANT.format(Instant.now())),
            snapshotId,
            packageName,
            revision
        )
    }

    private fun performAction(args: JSONObject): JSONObject {
        val selector = args.getJSONObject("selector")
        val requested = args.getString("action")
        val before = snapshot(DEFAULT_MAX_DEPTH, DEFAULT_MAX_NODES)
        selector.optString("snapshotId")
            .takeIf(String::isNotBlank)
            ?.let {
                if (it != before.id) {
                    throw CapabilityException(
                        "conflict",
                        "The UI changed after the referenced snapshot; inspect it again.",
                        false
                    )
                }
            }
        val matched = findNode(selector)
            ?: throw CapabilityException("not_found", "No visible UI element matched.", false)
        val matchedSummary = nodeSummary(matched)
        try {
            val target =
                if (requested == "click" || requested == "long_click") {
                    clickableNode(matched, requested == "long_click")
                            ?: throw CapabilityException(
                                "not_found",
                                "The matched element has no clickable ancestor.",
                                false
                            )
                } else {
                    AccessibilityNodeInfo.obtain(matched)
                }
            try {
                val action =
                    when (requested) {
                        "click" -> AccessibilityNodeInfo.ACTION_CLICK
                        "long_click" -> AccessibilityNodeInfo.ACTION_LONG_CLICK
                        "focus" -> AccessibilityNodeInfo.ACTION_FOCUS
                        "scroll_forward" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
                        "scroll_backward" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
                        "set_text" -> AccessibilityNodeInfo.ACTION_SET_TEXT
                        "clear_text" -> AccessibilityNodeInfo.ACTION_SET_TEXT
                        else -> throw CapabilityException(
                            "invalid_request",
                            "Unsupported accessibility action.",
                            false
                        )
                    }
                val arguments =
                    if (requested == "set_text" || requested == "clear_text") {
                        Bundle().apply {
                            putCharSequence(
                                AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                                if (requested == "clear_text") "" else args.getString("text")
                            )
                        }
                    } else {
                        null
                    }
                val performed =
                    onMainThread {
                        if (
                            selector.optString("snapshotId").isNotBlank() &&
                            snapshotRevision.get() != before.revision
                        ) {
                            throw CapabilityException(
                                "conflict",
                                "The UI changed after the referenced snapshot; inspect it again.",
                                false
                            )
                        }
                        if (arguments == null) {
                            target.performAction(action)
                        } else {
                            target.performAction(action, arguments)
                        }
                    }
                if (!performed) {
                    throw CapabilityException(
                        "execution_failed",
                        "Android rejected the requested accessibility action.",
                        false
                    )
                }
                val after = waitForChangedSnapshot(
                    before,
                    args.optLong("postActionWaitMs", 500L).coerceIn(0L, 5_000L)
                )
                return JSONObject()
                    .put("performed", true)
                    .put("action", requested)
                    .put("matched", matchedSummary)
                    .put("beforeSnapshotId", before.id)
                    .put("afterSnapshotId", after.id)
                    .put("changed", before.id != after.id)
                    .put(
                        "foregroundPackage",
                        after.packageName ?: JSONObject.NULL
                    )
            } finally {
                target.recycle()
            }
        } finally {
            matched.recycle()
        }
    }

    private fun performGesture(args: JSONObject): JSONObject {
        val metrics = resources.displayMetrics
        val type = args.getString("type")
        val path = Path()
        val durationMs =
            when (type) {
                "tap" -> {
                    val x = args.getInt("x")
                    val y = args.getInt("y")
                    requireCoordinates(x, y, metrics.widthPixels, metrics.heightPixels)
                    path.moveTo(x.toFloat(), y.toFloat())
                    80L
                }
                "swipe" -> {
                    val startX = args.getInt("startX")
                    val startY = args.getInt("startY")
                    val endX = args.getInt("endX")
                    val endY = args.getInt("endY")
                    requireCoordinates(startX, startY, metrics.widthPixels, metrics.heightPixels)
                    requireCoordinates(endX, endY, metrics.widthPixels, metrics.heightPixels)
                    path.moveTo(startX.toFloat(), startY.toFloat())
                    path.lineTo(endX.toFloat(), endY.toFloat())
                    args.optLong("durationMs", 300L).coerceIn(50L, 5_000L)
                }
                else -> throw CapabilityException(
                    "invalid_request",
                    "Unsupported gesture type.",
                    false
                )
            }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs))
            .build()
        val completed = CountDownLatch(1)
        var succeeded = false
        val accepted =
            onMainThread {
                dispatchGesture(
                    gesture,
                    object : GestureResultCallback() {
                        override fun onCompleted(gestureDescription: GestureDescription?) {
                            succeeded = true
                            completed.countDown()
                        }

                        override fun onCancelled(gestureDescription: GestureDescription?) {
                            completed.countDown()
                        }
                    },
                    null
                )
            }
        if (!accepted || !completed.await(durationMs + 2_000L, TimeUnit.MILLISECONDS) || !succeeded) {
            throw CapabilityException(
                "execution_failed",
                "Android did not complete the requested gesture.",
                true
            )
        }
        return JSONObject().put("performed", true).put("type", type)
    }

    private fun performNavigation(action: String): JSONObject {
        val globalAction =
            when (action) {
                "back" -> GLOBAL_ACTION_BACK
                "home" -> GLOBAL_ACTION_HOME
                "recents" -> GLOBAL_ACTION_RECENTS
                "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
                "quick_settings" -> GLOBAL_ACTION_QUICK_SETTINGS
                else -> throw CapabilityException(
                    "invalid_request",
                    "Unsupported navigation action.",
                    false
                )
            }
        if (!onMainThread { performGlobalAction(globalAction) }) {
            throw CapabilityException(
                "execution_failed",
                "Android rejected the requested navigation action.",
                false
            )
        }
        return JSONObject().put("performed", true).put("action", action)
    }

    private fun findNode(selector: JSONObject): AccessibilityNodeInfo? {
        val root = rootInActiveWindow ?: return null
        val queue = ArrayDeque<QueuedNode>()
        queue.add(QueuedNode(root, 0, null, "w${root.windowId}"))
        val wantedIndex = selector.optInt("index", 0)
        var matchedIndex = 0
        var nodeId = 0
        try {
            while (queue.isNotEmpty()) {
                val current = queue.removeFirst()
                val node = current.node
                if (matches(node, selector, nodeId, current.ref)) {
                    if (matchedIndex == wantedIndex) {
                        while (queue.isNotEmpty()) queue.removeFirst().node.recycle()
                        return node
                    }
                    matchedIndex += 1
                }
                for (index in 0 until node.childCount) {
                    node.getChild(index)?.let {
                        queue.add(
                            QueuedNode(
                                it,
                                current.depth + 1,
                                nodeId,
                                "${current.ref}/$index"
                            )
                        )
                    }
                }
                nodeId += 1
                node.recycle()
            }
        } finally {
            while (queue.isNotEmpty()) queue.removeFirst().node.recycle()
        }
        return null
    }

    private fun matches(
        node: AccessibilityNodeInfo,
        selector: JSONObject,
        nodeId: Int,
        ref: String
    ): Boolean {
        val contains = selector.optString("match", "exact") == "contains"
        fun field(name: String, actual: CharSequence?): Boolean {
            if (!selector.has(name)) return true
            val expected = selector.optString(name)
            val value = actual?.toString() ?: return false
            return if (contains) value.contains(expected, ignoreCase = true) else value == expected
        }
        fun state(name: String, actual: Boolean): Boolean =
            !selector.has(name) || selector.optBoolean(name) == actual
        return (!selector.has("nodeId") || selector.optInt("nodeId", -1) == nodeId) &&
            (!selector.has("ref") || selector.optString("ref") == ref) &&
            field("resourceId", node.viewIdResourceName) &&
            field("text", if (node.isPassword) null else node.text) &&
            field("contentDescription", node.contentDescription) &&
            field("className", node.className) &&
            field("packageName", node.packageName) &&
            (!selector.has("role") || selector.optString("role") == roleOf(node)) &&
            state("clickable", node.isClickable) &&
            state("longClickable", node.isLongClickable) &&
            state("editable", node.isEditable) &&
            state("scrollable", node.isScrollable) &&
            state("enabled", node.isEnabled) &&
            state("focused", node.isFocused) &&
            state("selected", node.isSelected) &&
            state("checked", node.isChecked)
    }

    private fun clickableNode(
        source: AccessibilityNodeInfo,
        longClick: Boolean
    ): AccessibilityNodeInfo? {
        var current = AccessibilityNodeInfo.obtain(source)
        while (true) {
            if (if (longClick) current.isLongClickable else current.isClickable) return current
            val parent = current.parent
            if (parent == null) {
                current.recycle()
                return null
            }
            current.recycle()
            current = parent
        }
    }

    private fun nodeJson(
        node: AccessibilityNodeInfo,
        id: Int,
        parentId: Int?,
        depth: Int,
        ref: String
    ): JSONObject {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        return JSONObject()
            .put("id", id)
            .put("nodeId", id)
            .put("ref", ref)
            .put("parentId", parentId ?: JSONObject.NULL)
            .put("depth", depth)
            .put("role", roleOf(node))
            .put("packageName", node.packageName?.toString() ?: JSONObject.NULL)
            .put("className", node.className?.toString() ?: JSONObject.NULL)
            .put("resourceId", node.viewIdResourceName ?: JSONObject.NULL)
            .put(
                "text",
                when {
                    node.isPassword -> "[redacted]"
                    node.text != null -> node.text.toString()
                    else -> JSONObject.NULL
                }
            )
            .put(
                "contentDescription",
                node.contentDescription?.toString() ?: JSONObject.NULL
            )
            .put("password", node.isPassword)
            .put("clickable", node.isClickable)
            .put("longClickable", node.isLongClickable)
            .put("editable", node.isEditable)
            .put("scrollable", node.isScrollable)
            .put("enabled", node.isEnabled)
            .put("focused", node.isFocused)
            .put("selected", node.isSelected)
            .put("checked", node.isChecked)
            .put(
                "bounds",
                JSONObject()
                    .put("left", bounds.left)
                    .put("top", bounds.top)
                    .put("right", bounds.right)
                    .put("bottom", bounds.bottom)
            )
    }

    private fun nodeSummary(node: AccessibilityNodeInfo): JSONObject {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        return JSONObject()
            .put("role", roleOf(node))
            .put("packageName", node.packageName?.toString() ?: JSONObject.NULL)
            .put("className", node.className?.toString() ?: JSONObject.NULL)
            .put("resourceId", node.viewIdResourceName ?: JSONObject.NULL)
            .put("text", if (node.isPassword) "[redacted]" else node.text?.toString() ?: JSONObject.NULL)
            .put(
                "bounds",
                JSONObject()
                    .put("left", bounds.left)
                    .put("top", bounds.top)
                    .put("right", bounds.right)
                    .put("bottom", bounds.bottom)
            )
    }

    private fun performWait(args: JSONObject, cancelled: () -> Boolean): JSONObject {
        val condition = args.getString("condition")
        val timeoutMs = args.optLong("timeoutMs", 10_000L).coerceIn(0L, 30_000L)
        val pollIntervalMs =
            args.optLong("pollIntervalMs", if (condition == "idle") 100L else 200L)
                .coerceIn(50L, 1_000L)
        val startedAt = SystemClock.elapsedRealtime()
        val deadline = startedAt + timeoutMs
        var lastSnapshot: UiSnapshot? = null
        while (true) {
            if (cancelled()) {
                throw CapabilityException("cancelled", "Invocation was cancelled.", false)
            }
            val satisfied =
                when (condition) {
                    "element" -> {
                        val found = findNode(args.getJSONObject("selector"))
                        val present = found != null
                        found?.recycle()
                        present == (args.optString("state", "present") == "present")
                    }
                    "app" -> currentPackage() == args.getString("packageName")
                    "idle" -> {
                        val idleMs = args.optLong("idleMs", 500L).coerceIn(100L, 5_000L)
                        SystemClock.elapsedRealtime() - lastEventAt >= idleMs
                    }
                    else -> throw CapabilityException(
                        "invalid_request",
                        "Unsupported UI wait condition.",
                        false
                    )
                }
            if (satisfied) {
                lastSnapshot =
                    try {
                        snapshot(DEFAULT_MAX_DEPTH, DEFAULT_MAX_NODES)
                    } catch (_: CapabilityException) {
                        null
                    }
                return JSONObject()
                    .put("satisfied", true)
                    .put("condition", condition)
                    .put("waitedMs", SystemClock.elapsedRealtime() - startedAt)
                    .put("observedAt", DateTimeFormatter.ISO_INSTANT.format(Instant.now()))
                    .apply {
                        if (args.has("state")) put("state", args.getString("state"))
                        if (lastSnapshot != null) {
                            put("snapshotId", lastSnapshot.id)
                            put(
                                "foregroundPackage",
                                lastSnapshot.packageName ?: JSONObject.NULL
                            )
                        }
                    }
            }
            val remaining = deadline - SystemClock.elapsedRealtime()
            if (remaining <= 0L) {
                throw CapabilityException(
                    "not_found",
                    "The requested UI condition was not reached before timeout.",
                    true
                )
            }
            Thread.sleep(minOf(pollIntervalMs, remaining))
        }
    }

    private fun waitForChangedSnapshot(before: UiSnapshot, waitMs: Long): UiSnapshot {
        val deadline = SystemClock.elapsedRealtime() + waitMs
        while (
            snapshotRevision.get() == before.revision &&
            SystemClock.elapsedRealtime() < deadline
        ) {
            val remaining = deadline - SystemClock.elapsedRealtime()
            if (remaining > 0L) Thread.sleep(minOf(50L, remaining))
        }
        return try {
            snapshot(DEFAULT_MAX_DEPTH, DEFAULT_MAX_NODES)
        } catch (_: CapabilityException) {
            before
        }
    }

    private fun currentPackage(): String? {
        val root = rootInActiveWindow ?: return null
        return try {
            root.packageName?.toString()
        } finally {
            root.recycle()
        }
    }

    private fun displayJson(): JSONObject {
        val metrics = resources.displayMetrics
        val display = getSystemService(DisplayManager::class.java)
            .getDisplay(Display.DEFAULT_DISPLAY)
        return JSONObject()
            .put("width", metrics.widthPixels)
            .put("height", metrics.heightPixels)
            .put("density", metrics.density.toDouble())
            .put("densityDpi", metrics.densityDpi)
            .put("rotation", display?.rotation ?: 0)
            .put("refreshRateHz", display?.refreshRate?.toDouble() ?: JSONObject.NULL)
    }

    private fun windowJson(): JSONArray {
        val currentWindows = windows
        return try {
            JSONArray().apply {
                currentWindows.forEach { window ->
                    val bounds = Rect()
                    window.getBoundsInScreen(bounds)
                    put(
                        JSONObject()
                            .put("id", window.id)
                            .put("type", windowType(window.type))
                            .put("layer", window.layer)
                            .put("active", window.isActive)
                            .put("focused", window.isFocused)
                            .put("title", window.title?.toString() ?: JSONObject.NULL)
                            .put("bounds", boundsJson(bounds))
                    )
                }
            }
        } finally {
            @Suppress("DEPRECATION")
            currentWindows.forEach { it.recycle() }
        }
    }

    private fun rootBounds(nodes: JSONArray): Rect {
        if (nodes.length() == 0) return Rect()
        val bounds = nodes.getJSONObject(0).getJSONObject("bounds")
        return Rect(
            bounds.getInt("left"),
            bounds.getInt("top"),
            bounds.getInt("right"),
            bounds.getInt("bottom")
        )
    }

    private fun boundsJson(bounds: Rect): JSONObject =
        JSONObject()
            .put("left", bounds.left)
            .put("top", bounds.top)
            .put("right", bounds.right)
            .put("bottom", bounds.bottom)

    private fun roleOf(node: AccessibilityNodeInfo): String {
        val className = node.className?.toString().orEmpty()
        return when {
            node.collectionItemInfo != null -> "list_item"
            className.endsWith("Button") -> "button"
            className.endsWith("CheckBox") -> "checkbox"
            className.endsWith("Switch") -> "switch"
            node.isEditable || className.endsWith("EditText") -> "edit_text"
            className.endsWith("TextView") -> "text"
            className.endsWith("ImageView") || className.endsWith("ImageButton") -> "image"
            className.endsWith("RecyclerView") || className.endsWith("ListView") -> "list"
            className.endsWith("WebView") -> "web_view"
            className.endsWith("ViewGroup") || className.endsWith("Layout") -> "container"
            else -> "unknown"
        }
    }

    private fun windowType(type: Int): String =
        when (type) {
            AccessibilityWindowInfo.TYPE_APPLICATION -> "application"
            AccessibilityWindowInfo.TYPE_INPUT_METHOD -> "input_method"
            AccessibilityWindowInfo.TYPE_SYSTEM -> "system"
            AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY -> "accessibility_overlay"
            AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER -> "split_screen_divider"
            else -> "unknown"
        }

    private fun requireCoordinates(x: Int, y: Int, width: Int, height: Int) {
        if (x !in 0 until width || y !in 0 until height) {
            throw CapabilityException(
                "invalid_request",
                "Gesture coordinates are outside the current display.",
                false
            )
        }
    }

    private fun <T> onMainThread(action: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) return action()
        val latch = CountDownLatch(1)
        var result: Result<T>? = null
        Handler(Looper.getMainLooper()).post {
            result = runCatching(action)
            latch.countDown()
        }
        if (!latch.await(5, TimeUnit.SECONDS)) {
            throw CapabilityException(
                "execution_failed",
                "Android accessibility service did not respond.",
                true
            )
        }
        return result!!.getOrThrow()
    }

    private fun notifyCapabilityChanged() {
        sendBroadcast(Intent(ACTION_CAPABILITY_CHANGED).setPackage(packageName))
    }

    private data class QueuedNode(
        val node: AccessibilityNodeInfo,
        val depth: Int,
        val parentId: Int?,
        val ref: String
    )

    private data class UiSnapshot(
        val json: JSONObject,
        val id: String,
        val packageName: String?,
        val revision: Long
    )

    companion object {
        private const val DEFAULT_MAX_DEPTH = 12
        private const val DEFAULT_MAX_NODES = 500

        const val ACTION_CAPABILITY_CHANGED =
            "cloud.agentdevice.node.ACCESSIBILITY_CAPABILITY_CHANGED"

        @Volatile
        private var active: AdcAccessibilityService? = null

        fun isConnected(): Boolean = active != null

        fun inspect(maxDepth: Int, maxNodes: Int): JSONObject =
            requireService().inspect(maxDepth.coerceIn(1, 30), maxNodes.coerceIn(1, 1000))

        fun wait(args: JSONObject, cancelled: () -> Boolean): JSONObject =
            requireService().performWait(args, cancelled)

        fun action(args: JSONObject): JSONObject = requireService().performAction(args)

        fun gesture(args: JSONObject): JSONObject = requireService().performGesture(args)

        fun navigation(action: String): JSONObject = requireService().performNavigation(action)

        fun currentPackage(): String? = active?.currentPackage()

        private fun requireService(): AdcAccessibilityService =
            active ?: throw CapabilityException(
                "denied",
                "Enable ADC UI control in Android Accessibility settings.",
                false
            )
    }
}
