package cloud.agentdevice.node

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Test

class PostActionObservationTest {
    @Test
    fun attachesOnlyWhenOptedInAndSnapshotIsFresh() {
        for (requested in listOf(false, true)) {
            for (fresh in listOf(false, true)) {
                val snapshot = JSONObject()
                    .put("snapshotId", "uisnap_after")
                    .put("nodes", JSONArray().put(JSONObject().put("text", "[REDACTED]")))
                val result = JSONObject().put("performed", true).put("afterSnapshotId", "uisnap_after")
                val attached = PostActionObservation.attach(result, snapshot, requested, fresh)

                assertSame(result, attached)
                assertEquals(true, attached.getBoolean("performed"))
                if (requested && fresh) {
                    assertSame(snapshot, attached.getJSONObject("observation"))
                    assertEquals(
                        attached.getString("afterSnapshotId"),
                        attached.getJSONObject("observation").getString("snapshotId")
                    )
                    assertEquals("[REDACTED]", snapshot.getJSONArray("nodes").getJSONObject(0).getString("text"))
                } else {
                    assertFalse(attached.has("observation"))
                }
            }
        }
    }
}
