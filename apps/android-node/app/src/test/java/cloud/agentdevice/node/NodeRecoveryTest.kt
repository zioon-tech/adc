package cloud.agentdevice.node

import android.content.Intent
import android.content.ContextWrapper
import android.content.ComponentName
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [33])
class NodeRecoveryTest {
    private val app get() = RuntimeEnvironment.getApplication()

    @Before fun reset() {
        app.getSharedPreferences("adc_mobile_node", 0).edit().clear().commit()
        NodeService::class.java.getDeclaredField("active").apply { isAccessible = true }.set(null, false)
    }

    @Test fun packageReplacementHasAnExplicitRecoveryReceiver() {
        val app = RuntimeEnvironment.getApplication()
        val receivers = app.packageManager.queryBroadcastReceivers(
            Intent(Intent.ACTION_MY_PACKAGE_REPLACED).setPackage(app.packageName), 0
        )
        assertEquals(1, receivers.size)
        assertFalse(receivers.single().activityInfo.exported)
    }

    @Test fun replacementRestoresOnlyAPairedDesiredNode() {
        for (paired in listOf(false, true)) for (desired in listOf(false, true)) {
            reset()
            val store = NodeStore(app)
            if (paired) store.saveConfig(NodeConfig("https://example.invalid", "node_test", "acct_test", "test"))
            store.setNodeDesired(desired)
            NodeRecoveryReceiver().onReceive(app, Intent(Intent.ACTION_MY_PACKAGE_REPLACED))
            val started = shadowOf(app).nextStartedService
            assertEquals(paired && desired, started != null)
            assertEquals(desired, store.isNodeDesired())
            if (started != null) {
                assertEquals(NodeService::class.java.name, started.component!!.className)
                assertNull(started.action)
                assertEquals("connecting", store.runtimeState())
            }
        }
    }

    @Test fun activeNodeAndUnrelatedBroadcastsDoNotRestartTheService() {
        NodeStore(app).apply {
            saveConfig(NodeConfig("https://example.invalid", "node_test", "acct_test", "test"))
            setNodeDesired(true)
        }
        NodeRecoveryReceiver().onReceive(app, Intent(Intent.ACTION_BOOT_COMPLETED))
        assertNull(shadowOf(app).nextStartedService)
        val active = NodeService::class.java.getDeclaredField("active").apply { isAccessible = true }
        active.set(null, true)
        try {
            assertFalse(NodeService.restoreDesired(app))
            assertNull(shadowOf(app).nextStartedService)
        } finally { active.set(null, false) }
    }

    @Test fun deniedForegroundStartPreservesIntentAndReportsInterruptedState() {
        NodeStore(app).apply {
            saveConfig(NodeConfig("https://example.invalid", "node_test", "acct_test", "test"))
            setNodeDesired(true)
        }
        val denied = object : ContextWrapper(app) {
            override fun startForegroundService(service: Intent): ComponentName? =
                throw IllegalStateException("start denied")
        }
        assertFalse(NodeService.restoreDesired(denied))
        assertTrue(NodeStore(app).isNodeDesired())
        assertEquals("interrupted", NodeStore(app).runtimeState())
    }

    @Test fun accessibilityRebindRestoresOnlyTheDesiredNode() {
        for (desired in listOf(false, true)) {
            reset()
            NodeStore(app).apply {
                saveConfig(NodeConfig("https://example.invalid", "node_test", "acct_test", "test"))
                setNodeDesired(desired)
            }
            val controller = Robolectric.buildService(AdcAccessibilityService::class.java).create()
            try {
                AdcAccessibilityService::class.java.getDeclaredMethod("onServiceConnected")
                    .apply { isAccessible = true }.invoke(controller.get())
                val started = shadowOf(app).nextStartedService
                assertEquals(desired, started != null)
                assertEquals(desired, NodeStore(app).isNodeDesired())
                if (started != null) assertEquals(NodeService::class.java.name, started.component!!.className)
            } finally { controller.destroy() }
        }
    }
}
