package cloud.agentdevice.node

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ScreenControlTest {
    private var now = 1000L
    private var saved = JSONObject()
    private fun control() = ScreenControl(elapsed = { now }, wall = { now },
        saved = saved, persist = { saved = JSONObject(it.toString()) })
    private fun invocation(actor: String = "actor_example", token: String? = null, purpose: String? = null) =
        JSONObject().put("tool", "ui.action").put("accountId", "acct_example")
            .put("actor", JSONObject().put("type", "agent").put("id", actor))
            .put("metadata", JSONObject().apply { token?.let { put("controlSessionId", it) }; purpose?.let { put("intent", it) } })
    private fun begin(control: ScreenControl): String = control.execute(invocation(purpose = "查找旅游攻略"),
        JSONObject().put("action", "begin")).getString("controlSessionId")
    private fun failure(code: String, action: () -> Unit) {
        try { action(); fail("Expected $code") } catch (error: CapabilityException) { assertEquals(code, error.code) }
    }

    @Test fun explicitSessionRequiresOwnerAndTokenAndStatusNeverDisclosesIt() {
        val control = control()
        failure("denied") { control.acquire(invocation()) }
        val token = begin(control)
        assertEquals("waiting", control.view().getString("mode"))
        assertFalse(control.execute(invocation(), JSONObject().put("action", "status")).has("controlSessionId"))
        failure("denied") { control.acquire(invocation("actor_other", token)) }
        failure("denied") { control.execute(invocation("actor_other"), JSONObject().put("action", "end").put("controlSessionId", token)) }
        val operation = control.acquire(invocation(token = token, purpose = "打开攻略列表"))
        assertEquals("using", control.view().getString("mode"))
        operation.close()
        assertEquals("waiting", control.view().getString("mode"))
        control.execute(invocation(), JSONObject().put("action", "end").put("controlSessionId", token))
        assertEquals("released", control.view().getString("mode"))
        failure("denied") { control.acquire(invocation(token = token)) }
    }

    @Test fun takeoverFencesQueuedDispatchAndBlocksNewBeginUntilLocalResume() {
        val control = control()
        val token = begin(control)
        val operation = control.acquire(invocation(token = token))
        control.takeover()
        assertEquals("handing_back", control.view().getString("mode"))
        var dispatched = false
        failure("cancelled") { operation.guard({ false }) { dispatched = true } }
        assertFalse(dispatched)
        assertTrue(operation.cancelled())
        failure("conflict") { control.resume() }
        operation.close()
        assertEquals("released", control.view().getString("mode"))
        assertTrue(control.view().getBoolean("paused"))
        failure("denied") { begin(control) }
        control.resume()
        assertNotEquals(token, begin(control))
        failure("denied") { control.acquire(invocation(token = token)) }
    }

    @Test fun pollingAndReadsDoNotRenewLeaseAndExpiryIsInterruption() {
        val control = control()
        val token = begin(control)
        now += 119000
        control.noteIntent(invocation(purpose = "读取电量"))
        assertEquals("查找旅游攻略", control.view().getString("intent"))
        assertEquals(1000L, control.view().getLong("remainingMs"))
        now += 1000
        assertEquals("interrupted", control.view().getString("mode"))
        assertEquals("lease_expired", control.view().getString("reason"))
        failure("denied") { control.acquire(invocation(token = token)) }
        failure("denied") { control.execute(invocation(), JSONObject().put("action", "renew").put("controlSessionId", token)) }
    }

    @Test fun restartNeverRestoresControlAndUnknownActionsNeverLookCompleted() {
        val original = control()
        val token = begin(original)
        val restored = control()
        assertEquals("interrupted", restored.view().getString("mode"))
        failure("denied") { restored.acquire(invocation(token = token)) }
        val fresh = begin(restored)
        val operation = restored.acquire(invocation(token = fresh))
        operation.close(uncertain = true)
        restored.execute(invocation(), JSONObject().put("action", "end").put("controlSessionId", fresh))
        assertEquals("interrupted", restored.view().getString("mode"))
        assertEquals("unknown_outcome", restored.view().getString("reason"))
    }

    @Test fun invalidLeaseCannotPartiallyAcquireAndHistoryStaysBoundedWithoutArgs() {
        val control = control()
        failure("invalid_request") { control.execute(invocation(), JSONObject().put("action", "begin").put("leaseMs", 180001)) }
        assertEquals("idle", control.view().getString("mode"))
        begin(control)
        repeat(60) { control.record(invocation(purpose = "第 $it 步").put("args", JSONObject().put("text", "private")), "succeeded") }
        assertEquals(40, control.records().length())
        assertFalse(control.records().toString().contains("private"))
        assertFalse(control.records().toString().contains("controlSessionId"))
    }
}
