package cloud.agentdevice.node

import android.app.Notification
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.time.Instant

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "zh-rCN-w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ScreenControlIntegrationTest {
    @Before fun reset() {
        val app = RuntimeEnvironment.getApplication()
        app.getSharedPreferences("adc_mobile_node", 0).edit().clear().commit()
        app.getSharedPreferences("adc_screen_control", 0).edit().clear().commit()
        ScreenControl::class.java.getDeclaredField("instance").apply { isAccessible = true }.set(null, null)
    }
    private fun invocation(tool: String, key: String? = null, purpose: String = "读取设备状态") = JSONObject()
        .put("schemaVersion", "0.1").put("invocationId", "inv_example").put("attemptId", "att_example")
        .put("accountId", "acct_example").put("actor", JSONObject().put("id", "actor_example").put("type", "agent"))
        .put("target", JSONObject().put("nodeId", "node_android"))
        .put("issuedAt", Instant.now().toString()).put("expiresAt", Instant.now().plusSeconds(120).toString())
        .put("tool", tool).put("args", JSONObject()).put("metadata", JSONObject().put("source", "mcp").put("intent", purpose))
        .apply { key?.let { put("idempotencyKey", it) } }
    private fun dispatch(invocation: JSONObject, allow: Boolean = true) = JSONObject().put("invocation", invocation)
        .put("policyDecision", JSONObject().put("outcome", if (allow) "allow" else "deny").put("decisionHash", "sha256:" + "a".repeat(64)))

    @Test fun backgroundReadLeavesScreenIdleAndReceiptCarriesDeclaredIntent() {
        val app = RuntimeEnvironment.getApplication()
        val registry = CapabilityRegistry(app)
        try {
            val result = MobileExecutionEngine(NodeStore(app), registry).execute("node_android",
                dispatch(invocation("device.battery.get"))).result
            assertEquals("succeeded", result.getString("status"))
            assertEquals("读取设备状态", result.getJSONObject("receipt").getString("intent"))
            assertEquals("idle", registry.screenControl.view().getString("mode"))
        } finally { registry.close() }
    }

    @Test fun denialReplaysWithoutReacquiringAndIntentDoesNotChangeExecutionIdentity() {
        val app = RuntimeEnvironment.getApplication()
        val registry = CapabilityRegistry(app)
        try {
            val engine = MobileExecutionEngine(NodeStore(app), registry)
            val first = invocation("device.navigation", "navigate-home").put("args", JSONObject().put("action", "home"))
            val denied = engine.execute("node_android", dispatch(first)).result
            assertEquals("denied", denied.getString("status"))
            val again = JSONObject(first.toString()).put("invocationId", "inv_again")
                .put("metadata", JSONObject().put("source", "mcp").put("intent", "换一个目的"))
            val replay = engine.execute("node_android", dispatch(again)).result
            assertEquals("denied", replay.getString("status"))
            assertTrue(replay.getJSONObject("receipt").getBoolean("replayed"))
            assertEquals(denied.getJSONObject("receipt").getString("argsHash"), replay.getJSONObject("receipt").getString("argsHash"))
            assertEquals(1, registry.screenControl.records().length())
            assertEquals("idle", registry.screenControl.view().getString("mode"))
        } finally { registry.close() }
    }

    @Test fun nativePhoneAndNotificationShowWaitingAndLocalTakeover() {
        val app = RuntimeEnvironment.getApplication()
        NodeStore(app).saveConfig(NodeConfig("https://adc.zioon.tech", "node_android", "acct_example", "我的手机"))
        val control = ScreenControl.get(app)
        val token = control.execute(invocation("screen.control", "begin", "查找西湖旅游攻略"), JSONObject().put("action", "begin"))
            .getString("controlSessionId")
        val activityController = Robolectric.buildActivity(MainActivity::class.java)
        MainActivity::class.java.getDeclaredField("authConfig").apply { isAccessible = true }.set(activityController.get(),
            JSONObject("""{"githubEnabled":false,"registrationEnabled":true}"""))
        activityController.create().start().resume().visible()
        val serviceController = Robolectric.buildService(NodeService::class.java).create()
        try {
            val activity = activityController.get()
            val root = activity.window.decorView
            assertTrue(views(root).filterIsInstance<TextView>().any { it.text.toString() == "ADC 正在等待下一步" })
            val notification = NodeService::class.java.getDeclaredMethod("serviceNotification", String::class.java)
                .apply { isAccessible = true }.invoke(serviceController.get(), "connected") as Notification
            assertEquals("ADC 正在等待下一步", notification.extras.getString(Notification.EXTRA_TITLE))
            assertTrue(notification.extras.getString(Notification.EXTRA_TEXT)!!.contains("查找西湖旅游攻略"))
            assertTrue(notification.actions.any { it.title.toString() == "我来接管" })
            snapshot(root, "screen-waiting-zh")
            val operation = control.acquire(invocation("ui.action").apply { getJSONObject("metadata").put("controlSessionId", token) })
            control.takeover()
            assertEquals("正在交还屏幕…", ScreenControlText.title(activity, control.view()))
            operation.close()
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue(views(root).filterIsInstance<TextView>().any { it.text.toString() == "屏幕由你使用 · Agent 已暂停" })
            snapshot(root, "screen-paused-zh")
        } finally {
            serviceController.destroy()
            activityController.pause().stop().destroy()
        }
    }

    private fun views(view: View): List<View> = listOf(view) +
        if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun snapshot(root: View, name: String) {
        val directory = System.getProperty("adc.snapshots", "").orEmpty().takeIf { it.isNotBlank() } ?: return
        shadowOf(Looper.getMainLooper()).idle()
        val view = (root as ViewGroup).getChildAt(0)
        val density = view.resources.displayMetrics.density
        val width = (411 * density).toInt(); val height = (891 * density).toInt()
        view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
        view.layout(0, 0, width, height)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap); canvas.drawColor(MobilePalette(view.context).surface); view.draw(canvas)
        File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
