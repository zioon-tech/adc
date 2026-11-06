package cloud.agentdevice.node

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityEvent
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowAccessibilityService
import java.lang.reflect.InvocationTargetException

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [AccessibilityObservationTest.RootShadow::class])
class AccessibilityObservationTest {
    @Implements(AccessibilityService::class)
    class RootShadow : ShadowAccessibilityService() {
        @Implementation
        protected fun getRootInActiveWindow(): AccessibilityNodeInfo? =
            root?.let { AccessibilityNodeInfo.obtain(it) }

        companion object {
            var root: AccessibilityNodeInfo? = null
        }
    }

    private lateinit var service: AdcAccessibilityService
    private lateinit var control: ScreenControl
    private lateinit var actor: JSONObject
    private lateinit var operation: ScreenControl.Operation

    @Before fun setup() {
        service = Robolectric.buildService(AdcAccessibilityService::class.java).create().get()
        control = ScreenControl(elapsed = { 0L })
        actor = JSONObject().put("accountId", "test")
            .put("actor", JSONObject().put("id", "agent").put("type", "agent"))
            .put("metadata", JSONObject())
        val token = control.execute(actor, JSONObject().put("action", "begin")).getString("controlSessionId")
        actor.getJSONObject("metadata").put("controlSessionId", token)
        operation = control.acquire(actor)
        RootShadow.root = AccessibilityNodeInfo.obtain().apply {
            packageName = "test.app"; viewIdResourceName = "root"; isClickable = true
        }
        var parent = RootShadow.root!!
        repeat(18) { depth ->
            val child = AccessibilityNodeInfo.obtain().apply {
                packageName = "test.app"; text = "depth-${depth + 1}"
            }
            shadowOf(parent).addChild(child)
            parent = child
        }
    }

    @After fun close() {
        operation.close()
        RootShadow.root = null
    }

    private fun inspect(depth: Int, nodes: Int = 500): JSONObject =
        AdcAccessibilityService::class.java.getDeclaredMethod("inspect", Int::class.java, Int::class.java)
            .apply { isAccessible = true }.invoke(service, depth, nodes) as JSONObject

    private fun action(
        snapshot: JSONObject, includeObservation: Boolean, cancelled: () -> Boolean = { false }
    ): JSONObject {
        val args = JSONObject().put("action", "click").put("postActionWaitMs", 0)
            .put("includeObservation", includeObservation)
            .put("selector", JSONObject().put("resourceId", "root")
                .put("snapshotId", snapshot.getString("snapshotId")))
        try {
            return AdcAccessibilityService::class.java.getDeclaredMethod(
                "performAction", JSONObject::class.java, Function0::class.java, ScreenControl.Operation::class.java
            ).apply { isAccessible = true }.invoke(service, args, cancelled, operation) as JSONObject
        } catch (error: InvocationTargetException) {
            throw error.targetException
        }
    }

    @Test fun returnsTheReferencedObservationDepthAndNodeLimit() {
        for ((depth, nodes) in listOf(18 to 500, 6 to 8)) {
            val before = inspect(depth, nodes)
            val result = action(before, true)
            assertTrue(result.getBoolean("performed"))
            val after = result.getJSONObject("observation")
            assertEquals(before.getJSONArray("nodes").length(), after.getJSONArray("nodes").length())
            assertEquals(before.getBoolean("truncated"), after.getBoolean("truncated"))
        }
    }

    @Test fun legacyActionDoesNotAttachObservation() {
        assertFalse(action(inspect(12), false).has("observation"))
    }

    @Test fun unchangedCompleteScreenAcceptsEventRevalidationWhileLegacyRejectsIt() {
        val before = inspect(30)
        service.onAccessibilityEvent(AccessibilityEvent.obtain(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED))
        assertEquals("conflict", assertThrows(CapabilityException::class.java) { action(before, false) }.code)
        val result = action(before, true)
        assertTrue(result.getBoolean("semanticRevalidated"))
        assertEquals(1, shadowOf(RootShadow.root!!).performedActions.size)
    }

    @Test fun changedTargetAndTakeoverPreventTheEffect() {
        val before = inspect(30)
        RootShadow.root!!.text = "Changed target"
        assertEquals("conflict", assertThrows(CapabilityException::class.java) { action(before, true) }.code)
        assertTrue(shadowOf(RootShadow.root!!).performedActions.isEmpty())
        val fresh = inspect(30)
        control.takeover()
        assertThrows(CapabilityException::class.java) { action(fresh, true) }
        assertTrue(shadowOf(RootShadow.root!!).performedActions.isEmpty())
    }

    @Test fun usesTheGuardedMutationSnapshotAsTheObservationBaseline() {
        val before = inspect(30)
        var firstGuard = true
        val result = action(before, true) {
            if (firstGuard) {
                firstGuard = false
                service.onAccessibilityEvent(AccessibilityEvent.obtain(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED))
            }
            false
        }
        assertTrue(result.getBoolean("semanticRevalidated"))
        assertEquals(1, shadowOf(RootShadow.root!!).performedActions.size)
        assertEquals(result.getString("afterSnapshotId"), result.getString("beforeSnapshotId"))
        assertFalse(result.getBoolean("changed"))
    }
}
