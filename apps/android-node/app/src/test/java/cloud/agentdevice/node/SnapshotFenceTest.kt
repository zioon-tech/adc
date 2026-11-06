package cloud.agentdevice.node

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SnapshotFenceTest {
    private fun screen() = JSONObject().put("packageName", "test.app")
        .put("windows", JSONArray().put(JSONObject().put("id", 3).put("focused", true)))
        .put("display", JSONObject().put("rotation", 0))
        .put("truncated", false)
        .put("nodes", JSONArray().put(JSONObject().put("nodeId", 0).put("ref", "w3")
            .put("text", "Target").put("checked", false).put("password", false)
            .put("bounds", JSONObject().put("left", 10).put("top", 20))))

    private fun rejects(action: () -> Unit) {
        val error = assertThrows(CapabilityException::class.java) { action() }
        assertEquals("conflict", error.code)
    }

    @Test fun completeIdenticalContentCanBeRevalidatedAcrossEventsOnlyWhenOptedIn() {
        val fence = SnapshotFence(elapsed = { 0L })
        val old = fence.record(screen(), 18, 500, 1, 1)
        val fresh = fence.record(screen(), 18, 500, 2, 2)
        fence.requireCurrent(old, fresh, true)
        rejects { fence.requireCurrent(old, fresh, false) }
        fence.requireCurrent(fresh, fresh, false)
    }

    @Test fun rejectsVisibleTargetOrWindowChangesEvenWithoutAnEvent() {
        val changes: List<(JSONObject) -> Unit> = listOf(
            { it.put("packageName", "other.app") },
            { it.getJSONArray("windows").getJSONObject(0).put("id", 4) },
            { it.getJSONObject("display").put("rotation", 1) },
            { it.getJSONArray("nodes").getJSONObject(0).put("text", "Other") },
            { it.getJSONArray("nodes").getJSONObject(0).put("checked", true) },
            { it.getJSONArray("nodes").getJSONObject(0).getJSONObject("bounds").put("left", 11) },
            { it.getJSONArray("nodes").put(JSONObject().put("nodeId", 1).put("text", "Inserted")) }
        )
        for (change in changes) {
            val fence = SnapshotFence(elapsed = { 0L })
            val old = fence.record(screen(), 18, 500, 1, 1)
            val changed = screen().also(change)
            rejects { fence.requireCurrent(old, fence.record(changed, 18, 500, 1, 1), true) }
        }
    }

    @Test fun incompleteOrRedactedScreensKeepStrictEventFencing() {
        for (kind in listOf("truncated", "password")) {
            val content = screen()
            if (kind == "truncated") content.put("truncated", true)
            else content.getJSONArray("nodes").getJSONObject(0).put("password", true).put("text", "[redacted]")
            val fence = SnapshotFence(elapsed = { 0L })
            val old = fence.record(content, 18, 500, 1, 1)
            val fresh = fence.record(content, 18, 500, 2, 2)
            rejects { fence.requireCurrent(old, fresh, true) }
            fence.requireCurrent(fresh, fresh, true)
        }
    }

    @Test fun rejectsTornCapturesAndMismatchedObservationLimits() {
        val fence = SnapshotFence(elapsed = { 0L })
        val old = fence.record(screen(), 18, 500, 1, 1)
        for ((depth, nodes) in listOf(12 to 500, 18 to 100)) {
            val other = fence.record(screen(), depth, nodes, 1, 1)
            assertNotEquals(old.id, other.id)
            rejects { fence.requireCurrent(old, other, true) }
        }
        assertEquals(18, fence.lookup(old.id).maxDepth)
        rejects { fence.requireCurrent(old, fence.record(screen(), 18, 500, 1, 2), true) }
        val torn = fence.record(screen(), 18, 500, 2, 3)
        rejects { fence.requireCurrent(torn, fence.record(screen(), 18, 500, 3, 3), true) }
    }

    @Test fun expiresAndEvictsReferencesWithoutAcceptingOtherSessions() {
        var clock = 0L
        val fence = SnapshotFence(elapsed = { clock }, capacity = 2, ttlMs = 100)
        val first = fence.record(screen(), 18, 500, 1, 1)
        val second = fence.record(screen(), 18, 500, 2, 2)
        fence.record(screen(), 18, 500, 3, 3)
        rejects { fence.lookup(first.id) }
        assertEquals(second, fence.lookup(second.id))
        clock = 100
        rejects { fence.lookup(second.id) }
        val other = SnapshotFence(elapsed = { clock }).record(screen(), 18, 500, 2, 2)
        rejects { fence.lookup(other.id) }
    }

    @Test fun ignoresObjectKeyOrderButPreservesArrayOrder() {
        val fence = SnapshotFence(elapsed = { 0L })
        val content = screen()
        val reordered = JSONObject()
        content.keys().asSequence().toList().reversed().forEach { reordered.put(it, content.get(it)) }
        val old = fence.record(content, 18, 500, 1, 1)
        assertEquals(old.fingerprint, fence.record(reordered, 18, 500, 2, 2).fingerprint)
        val changed = screen().put("nodes", JSONArray()
            .put(JSONObject().put("nodeId", 1)).put(content.getJSONArray("nodes").getJSONObject(0)))
        assertNotEquals(old.fingerprint, fence.record(changed, 18, 500, 2, 2).fingerprint)
    }
}
