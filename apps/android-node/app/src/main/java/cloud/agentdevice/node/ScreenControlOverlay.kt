package cloud.agentdevice.node

import android.accessibilityservice.AccessibilityService
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Optional tiny edge affordance. Never full-screen, never focusable, never a model target. */
class ScreenControlOverlay(private val service: AccessibilityService) {
    private val handler = Handler(Looper.getMainLooper())
    private val manager = service.getSystemService(WindowManager::class.java)
    private val preferences = service.getSharedPreferences("adc_screen_control", 0)
    private var view: View? = null
    private var expanded = false
    private var suppressed = 0
    private var dismissed = false
    private var lastSessionActive = false
    private var params = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
        android.graphics.PixelFormat.TRANSLUCENT
    ).apply { gravity = Gravity.TOP or Gravity.END; x = dp(6); y = dp(64) }
    var windowId = -1
        private set
    private fun dp(value: Int) = (value * service.resources.displayMetrics.density).toInt()

    fun refresh() {
        if (Looper.myLooper() != Looper.getMainLooper()) { handler.post { refresh() }; return }
        val state = ScreenControl.get(service).view()
        val active = state.optString("mode") in setOf("waiting", "using", "handing_back")
        if (active && !lastSessionActive) dismissed = false
        lastSessionActive = active
        remove()
        if (!active || suppressed > 0 || dismissed || !preferences.getBoolean("edge", false)) return
        val context = AppLanguage.localizedContext(service)
        val palette = MobilePalette(context)
        val block = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(8))
            background = GradientDrawable().apply { setColor(palette.controller); cornerRadius = dp(18).toFloat() }
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
        fun label(text: String, action: () -> Unit) = TextView(context).apply {
            this.text = text; textSize = 13f; setTextColor(palette.onController)
            setPadding(0, dp(5), 0, dp(5)); setOnClickListener { action() }
        }
        val handle = label(if (expanded) ScreenControlText.title(context, state) else "ADC") {
            expanded = !expanded; refresh()
            if (expanded) handler.postDelayed({ expanded = false; refresh() }, 5000)
        }
        var startX = 0f; var startY = 0f; var originalX = 0; var originalY = 0; var dragged = false
        handle.setOnTouchListener { target, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    startX = event.rawX; startY = event.rawY; originalX = params.x; originalY = params.y; dragged = false
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    if (kotlin.math.abs(event.rawX - startX) + kotlin.math.abs(event.rawY - startY) > dp(8)) dragged = true
                    if (dragged) {
                        params.x = (originalX - (event.rawX - startX).toInt()).coerceIn(0, service.resources.displayMetrics.widthPixels - dp(80))
                        params.y = (originalY + (event.rawY - startY).toInt()).coerceIn(dp(24), service.resources.displayMetrics.heightPixels - dp(180))
                        view?.let { manager.updateViewLayout(it, params) }
                    }
                    true
                }
                MotionEvent.ACTION_UP -> { if (!dragged) target.performClick(); true }
                else -> false
            }
        }
        block.addView(handle)
        if (expanded) {
            block.addView(label(state.optString("intent").take(28)) { })
            block.addView(label(context.getString(R.string.screen_takeover)) { ScreenControl.get(service).takeover() })
            block.addView(label(context.getString(R.string.screen_hide)) { dismissed = true; refresh() })
        }
        view = block
        manager.addView(block, params)
        handler.post {
            if (view === block) service.windows.forEach { window ->
                val root = window.root
                try {
                    if (window.type == android.view.accessibility.AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY &&
                        root?.packageName == service.packageName) windowId = window.id
                } finally { root?.recycle(); window.recycle() }
            }
        }
    }

    private fun remove() {
        view?.let { runCatching { manager.removeViewImmediate(it) } }
        view = null
    }

    /** Returns a timestamp fence for screenshot frames produced after hiding the overlay. */
    fun hide(): Long {
        val abandoned = AtomicBoolean(false)
        val done = CountDownLatch(1)
        var hiddenAt = 0L
        val hide = {
            if (!abandoned.get()) {
                suppressed++
                if (view != null) { remove(); hiddenAt = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(32) }
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
    fun close() { handler.removeCallbacksAndMessages(null); remove() }
}
