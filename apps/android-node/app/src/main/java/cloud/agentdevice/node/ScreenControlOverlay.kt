package cloud.agentdevice.node

import android.accessibilityservice.AccessibilityService
import android.animation.ValueAnimator
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.TextUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Native activity first; a single local stop target otherwise. */
class ScreenControlOverlay(
    private val service: AccessibilityService,
    private val control: ScreenControl = ScreenControl.get(service)
) {
    private val handler = Handler(Looper.getMainLooper())
    private val manager = service.getSystemService(WindowManager::class.java)
    private val preferences = service.getSharedPreferences("adc_screen_control", 0)
    private var view: LinearLayout? = null
    private var notice: LinearLayout? = null
    private var noticeTitle: TextView? = null
    private var noticeDetail: TextView? = null
    private var actionText: TextView? = null
    private var suppressed = 0
    private var lastSessionActive = false
    private var lastMode = ""
    private var noticeUntil = 0L
    private var closed = false
    private var configuration = ""
    private var rendered = ""
    private val windowIds = linkedSetOf<Int>()
    private var position = preferences.getFloat("stop_position", 0.22f)
    private val tick = Runnable { refresh() }
    private val handleParams = params(dp(48), dp(64), touchable = true).apply { gravity = Gravity.TOP or Gravity.RIGHT }
    private fun dp(value: Int) = (value * service.resources.displayMetrics.density).toInt()
    private fun dimensions() = if (Build.VERSION.SDK_INT >= 30) manager.currentWindowMetrics.bounds
        else android.graphics.Rect(0, 0, service.resources.displayMetrics.widthPixels, service.resources.displayMetrics.heightPixels)
    private fun topInset(): Int {
        if (Build.VERSION.SDK_INT >= 30) return manager.currentWindowMetrics.windowInsets
            .getInsetsIgnoringVisibility(WindowInsets.Type.statusBars() or WindowInsets.Type.displayCutout()).top
        val id = service.resources.getIdentifier("status_bar_height", "dimen", "android")
        return if (id != 0) service.resources.getDimensionPixelSize(id) else dp(28)
    }
    private fun params(width: Int, height: Int, touchable: Boolean = false) = WindowManager.LayoutParams(
        width, height, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            (if (touchable) 0 else WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE),
        PixelFormat.TRANSLUCENT
    ).apply {
        gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
        if (Build.VERSION.SDK_INT >= 30) setFitInsetsTypes(0)
    }

    fun ownsWindow(id: Int) = id >= 0 && id in windowIds

    /** Called on the main thread immediately before dispatch; the Agent cannot tap local stop. */
    fun requireClearGesture(path: android.graphics.Path) {
        val handle = view ?: return
        val point = IntArray(2)
        if (handle.width > 0 && handle.height > 0) handle.getLocationOnScreen(point)
        else {
            point[0] = dimensions().width() - handleParams.width - handleParams.x
            point[1] = handleParams.y
        }
        val target = android.graphics.RectF(point[0].toFloat(), point[1].toFloat(),
            (point[0] + handle.width.takeIf { it > 0 }.let { it ?: handleParams.width }).toFloat(),
            (point[1] + handle.height.takeIf { it > 0 }.let { it ?: handleParams.height }).toFloat())
        val bounds = android.graphics.RectF()
        path.computeBounds(bounds, true)
        bounds.inset(-1f, -1f)
        if (android.graphics.RectF.intersects(bounds, target))
            throw CapabilityException("denied", "This gesture crosses the local screen-control Stop button. Choose another path.", false)
    }

    fun refresh() {
        if (Looper.myLooper() != Looper.getMainLooper()) { handler.post { refresh() }; return }
        if (closed) return
        handler.removeCallbacks(tick)
        val state = control.view()
        val active = ScreenControlNotifications.active(state)
        val mode = state.optString("mode")
        val now = SystemClock.elapsedRealtime()
        if (active && !lastSessionActive) noticeUntil = now + 3500
        if ((!active && lastSessionActive) || (active && mode != lastMode && mode in setOf("handing_back", "interrupted")))
            noticeUntil = now + 3500
        lastSessionActive = active
        lastMode = mode
        if (active || now < noticeUntil) handler.postDelayed(tick,
            if (now < noticeUntil) (noticeUntil - now).coerceAtMost(1000) else 1000)
        if (suppressed > 0 || !preferences.getBoolean("activity_indicator", true)) { remove(); return }
        val context = AppLanguage.localizedContext(service)
        val palette = MobilePalette(context)
        val size = dimensions()
        val config = "${context.resources.configuration}:${palette.dark}:${size.width()}:${size.height()}"
        if (configuration != config) { remove(); configuration = config }
        val local = active && !ScreenControlNotifications.isPromoted(service)
        val stopping = mode in setOf("handing_back", "interrupted") && active
        val textId = when {
            stopping -> R.string.indicator_stopping
            mode == "interrupted" -> R.string.indicator_interrupted
            state.optBoolean("paused") -> R.string.indicator_taken_over
            mode == "using" -> R.string.indicator_using
            mode == "waiting" -> R.string.indicator_waiting
            else -> R.string.indicator_released
        }
        if (local) {
            if (view == null) createHandle()
            actionText?.text = context.getString(if (stopping) R.string.indicator_handle_stopping else R.string.indicator_stop)
            view?.isEnabled = !stopping
            view?.alpha = if (stopping) 0.7f else 1f
            view?.contentDescription = "${context.getString(textId)}. ${context.getString(R.string.screen_takeover)}"
            val previousY = handleParams.y
            val previousX = handleParams.x
            clampPosition()
            if (previousX != handleParams.x || previousY != handleParams.y)
                view?.let { manager.updateViewLayout(it, handleParams) }
        } else removeHandle()
        if (now < noticeUntil) {
            if (notice == null) createNotice()
            val fingerprint = "$textId:${state.optString("intent")}:$stopping"
            if (rendered != fingerprint) {
                noticeTitle?.text = context.getString(textId)
                noticeDetail?.text = when {
                    stopping -> context.getString(R.string.indicator_settling)
                    mode == "interrupted" -> context.getString(R.string.screen_check_phone)
                    active -> state.optString("intent").ifBlank { context.getString(R.string.indicator_no_intent) }
                    else -> context.getString(R.string.indicator_finished)
                }
                rendered = fingerprint
            }
        } else removeNotice()
    }

    private fun createHandle() {
        val context = AppLanguage.localizedContext(service)
        val palette = MobilePalette(context)
        val block = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                setColor(palette.controller)
                cornerRadii = floatArrayOf(dp(14).toFloat(), dp(14).toFloat(), 0f, 0f, 0f, 0f, dp(14).toFloat(), dp(14).toFloat())
            }
            isClickable = true
            isFocusable = true
            setOnClickListener { control.takeover(); refresh() }
        }
        block.addView(TextView(context).apply {
            text = "ADC"; textSize = 10f; setTextColor(palette.controllerMuted)
            gravity = Gravity.CENTER
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        })
        actionText = TextView(context).apply {
            textSize = 11f; setTextColor(palette.controllerAction)
            isSingleLine = true; ellipsize = TextUtils.TruncateAt.END
            gravity = Gravity.CENTER
            setPadding(0, dp(4), 0, 0)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }.also { block.addView(it) }
        var startY = 0f; var originalY = 0; var dragged = false
        block.setOnTouchListener { target, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    startY = event.rawY; originalY = handleParams.y; dragged = false; true
                }
                MotionEvent.ACTION_MOVE -> {
                    if (kotlin.math.abs(event.rawY - startY) > ViewConfiguration.get(context).scaledTouchSlop) dragged = true
                    if (dragged) {
                        position = (originalY + event.rawY - startY) / dimensions().height()
                        clampPosition()
                        manager.updateViewLayout(block, handleParams)
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (dragged) preferences.edit().putFloat("stop_position", position).apply()
                    else target.performClick()
                    true
                }
                MotionEvent.ACTION_CANCEL -> true
                else -> false
            }
        }
        view = block
        handleParams.width = dp(48)
        handleParams.height = dp(64)
        clampPosition()
        attach(block, handleParams)
    }

    private fun clampPosition() {
        val height = dimensions().height()
        val low = topInset() + dp(48)
        val high = (height - dp(160)).coerceAtLeast(low)
        handleParams.y = (position * height).toInt().coerceIn(low, high)
        position = handleParams.y.toFloat() / height
        if (Build.VERSION.SDK_INT >= 30) handleParams.x = manager.currentWindowMetrics.windowInsets
            .getInsetsIgnoringVisibility(WindowInsets.Type.displayCutout()).right
    }

    private fun createNotice() {
        val context = AppLanguage.localizedContext(service)
        val palette = MobilePalette(context)
        val block = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(12))
            background = GradientDrawable().apply { setColor(palette.controller); cornerRadius = dp(12).toFloat() }
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
        noticeTitle = TextView(context).apply {
            textSize = 14f; setTextColor(palette.onController)
            typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
            isSingleLine = true; ellipsize = TextUtils.TruncateAt.END
        }.also { block.addView(it) }
        noticeDetail = TextView(context).apply {
            textSize = 12f; setTextColor(palette.controllerMuted)
            setPadding(0, dp(4), 0, 0)
            maxLines = 2; ellipsize = TextUtils.TruncateAt.END
        }.also { block.addView(it) }
        notice = block
        attach(block, params(dimensions().width() - dp(32), WindowManager.LayoutParams.WRAP_CONTENT).apply { y = topInset() + dp(10) })
        if (ValueAnimator.areAnimatorsEnabled()) {
            block.alpha = 0f
            block.animate().alpha(1f).setDuration(160).start()
        }
    }

    private fun attach(target: View, layout: WindowManager.LayoutParams) {
        manager.addView(target, layout)
        handler.post {
            if (!target.isAttachedToWindow) return@post
            service.windows.forEach { window ->
                val root = window.root
                try {
                    if (window.type == android.view.accessibility.AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY &&
                        root?.packageName == service.packageName) windowIds.add(window.id)
                } finally { root?.recycle(); window.recycle() }
            }
            while (windowIds.size > 24) windowIds.remove(windowIds.first())
        }
    }

    private fun detach(target: View?) { target?.let { runCatching { manager.removeViewImmediate(it) } } }
    private fun removeHandle() { detach(view); view = null; actionText = null }
    private fun removeNotice() { detach(notice); notice = null; noticeTitle = null; noticeDetail = null; rendered = "" }
    private fun remove() { removeHandle(); removeNotice() }

    /** Timestamp fence for screenshot frames produced after all local indicator windows hide. */
    fun hide(): Long {
        val abandoned = AtomicBoolean(false)
        val done = CountDownLatch(1)
        var hiddenAt = 0L
        val hide = {
            if (!abandoned.get()) {
                suppressed++
                if (view != null || notice != null) {
                    remove(); hiddenAt = System.nanoTime()
                }
            }
            done.countDown()
        }
        if (Looper.myLooper() == Looper.getMainLooper()) hide() else handler.post { hide() }
        if (!done.await(2, TimeUnit.SECONDS)) {
            abandoned.set(true)
            throw CapabilityException("offline", "Unable to hide the local screen indicator.", false)
        }
        if (hiddenAt > 0 && Looper.myLooper() != Looper.getMainLooper()) Thread.sleep(100)
        return hiddenAt
    }

    fun restore() { handler.post { suppressed = (suppressed - 1).coerceAtLeast(0); refresh() } }
    fun close() { closed = true; handler.removeCallbacksAndMessages(null); remove() }
}
