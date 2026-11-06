package cloud.agentdevice.node

import android.app.Notification
import android.graphics.Path
import android.os.Looper
import android.view.View
import android.view.WindowManager
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [33], qualifiers = "zh-rCN-w411dp-h891dp-xxhdpi")
class ScreenIndicatorTest {
    private lateinit var overlay: ScreenControlOverlay
    private lateinit var control: ScreenControl
    private var clock = 0L
    private val actor = JSONObject().put("accountId", "test")
        .put("actor", JSONObject().put("id", "agent").put("type", "agent"))
        .put("metadata", JSONObject().put("intent", "验证屏幕提示"))
    @Before fun setup() {
        val app = RuntimeEnvironment.getApplication()
        app.getSharedPreferences("adc_screen_control", 0).edit().clear().commit()
        control = ScreenControl(elapsed = { clock })
        val service = Robolectric.buildService(AdcAccessibilityService::class.java).create().get()
        overlay = ScreenControlOverlay(service, control)
    }
    @After fun close() { overlay.close() }
    private fun field(name: String) = ScreenControlOverlay::class.java.getDeclaredField(name)
        .apply { isAccessible = true }.get(overlay) as? View
    private fun begin(): String = control.execute(actor, JSONObject().put("action", "begin").put("leaseMs", 10000))
        .getString("controlSessionId").also { overlay.refresh(); shadowOf(Looper.getMainLooper()).idle() }

    @Test fun idleIsQuietAndWaitingKeepsAStopTargetWithoutTouchBlockingStatusWindows() {
        overlay.refresh()
        assertNull(field("view"))
        begin()
        val handle = field("view")!!
        val notice = field("notice")!!
        assertTrue(handle.isAttachedToWindow)
        assertEquals(0, (handle.layoutParams as WindowManager.LayoutParams).flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE)
        assertNotEquals(0,
            (notice.layoutParams as WindowManager.LayoutParams).flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(4))
        assertNull(field("notice"))
        assertSame(handle, field("view"))
        assertTrue(ScreenControlNotifications.active(control.view()))
    }

    @Test fun oneTapTakeoverStopsNewActionsAndWaitsForTheCurrentActionToSettle() {
        val token = begin()
        val operation = control.acquire(JSONObject(actor.toString()).apply {
            getJSONObject("metadata").put("controlSessionId", token)
        })
        overlay.refresh()
        field("view")!!.performClick()
        assertTrue(control.view().getBoolean("paused"))
        assertTrue(operation.cancelled())
        assertEquals("handing_back", control.view().getString("mode"))
        assertNotNull(field("view"))
        assertFalse(field("view")!!.isEnabled)
        operation.close()
        overlay.refresh()
        assertEquals("released", control.view().getString("mode"))
        assertNull(field("view"))
        assertNotNull(field("notice"))
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(4))
        assertNull(field("notice"))
    }

    @Test fun interruptionKeepsStopVisibleUntilPendingActionsCloseAndNeverClaimsSuccess() {
        val token = begin()
        val operation = control.acquire(JSONObject(actor.toString()).apply { getJSONObject("metadata").put("controlSessionId", token) })
        clock = 10001
        overlay.refresh()
        assertEquals("interrupted", control.view().getString("mode"))
        assertNotNull(field("view"))
        assertEquals("正在停止操作…", ScreenControlText.title(RuntimeEnvironment.getApplication(), control.view()))
        operation.close()
        overlay.refresh()
        assertNull(field("view"))
        assertEquals("屏幕控制中断", ScreenControlText.title(RuntimeEnvironment.getApplication(), control.view()))
    }

    @Test fun nestedCaptureSuppressionRestoresAllWindowsAndDoesNotExtendTheControlLease() {
        begin()
        overlay.hide()
        overlay.hide()
        assertNull(field("view")); assertNull(field("notice"))
        overlay.restore()
        shadowOf(Looper.getMainLooper()).idle()
        assertNull(field("view"))
        overlay.restore()
        shadowOf(Looper.getMainLooper()).idle()
        assertNotNull(field("view"))
        assertEquals(10000L, control.view().getLong("remainingMs"))
    }

    @Test fun olderAndroidUsesOrdinaryNotificationsEvenDuringControl() {
        begin()
        val app = RuntimeEnvironment.getApplication()
        val notification = Notification.Builder(app, "test").setContentTitle("Control").setOngoing(true).build()
        assertSame(notification, ScreenControlNotifications.promote(app, notification, control.view()))
        assertFalse(ScreenControlNotifications.isPromoted(app))
    }

    @Test fun coordinatePathsCannotTouchTheLocalTakeoverTarget() {
        begin()
        val handle = field("view")!!
        handle.measure(View.MeasureSpec.makeMeasureSpec(144, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(192, View.MeasureSpec.EXACTLY))
        handle.layout(0, 0, 144, 192)
        val point = IntArray(2)
        handle.getLocationOnScreen(point)
        val blocked = Path().apply { moveTo(point[0] + 10f, point[1] + 10f) }
        try { overlay.requireClearGesture(blocked); fail("Agent gesture targeted local Stop") }
        catch (error: CapabilityException) { assertEquals("denied", error.code) }
        overlay.requireClearGesture(Path().apply { moveTo(point[0] - 100f, point[1] - 100f) })
    }
}
