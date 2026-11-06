package cloud.agentdevice.node

import org.junit.Assert.*
import org.junit.Test

class ObservationSettlerTest {
    @Test fun waitsForConsecutiveContentAfterTheMutationRevision() {
        var now = 0L
        val result = ObservationSettler.await(7L, 500L, { now }, { now += it }, { 8L }) {
            val text = if (now < 150L) "loading-$now" else "ready"
            ObservationSettler.Sample(text, text, true)
        }
        assertEquals(250L, now)
        assertTrue(result.settled)
        assertEquals("ready", result.value)
    }

    @Test fun boundsContinuousChangesAndRejectsFailedCaptures() {
        for (failed in listOf(false, true)) {
            var now = 0L
            val result = ObservationSettler.await<String>(7L, 200L, { now }, { now += it }, { 8L }) {
                if (failed) null else ObservationSettler.Sample("$now", "$now", true)
            }
            assertEquals(200L, now)
            assertFalse(result.settled)
            if (failed) assertNull(result.value) else assertEquals("200", result.value)
        }
    }

    @Test fun doesNotTreatPreMutationEventsAsCompletionAndSupportsZeroWait() {
        for (budget in listOf(0L, 500L)) {
            var now = 0L
            val result = ObservationSettler.await(8L, budget, { now }, { now += it }, { 8L }) {
                ObservationSettler.Sample("same", "same", true)
            }
            assertEquals(budget, now)
            assertTrue(result.settled)
        }
    }

    @Test fun unstableCaptureResetsTheQuietIntervalAndShortBudgetDoesNotClaimSettling() {
        for (budget in listOf(50L, 500L)) {
            var now = 0L
            val result = ObservationSettler.await(7L, budget, { now }, { now += it }, { 8L }) {
                ObservationSettler.Sample("same", "same", now != 50L)
            }
            assertEquals(if (budget == 50L) 50L else 200L, now)
            assertEquals(budget > 50L, result.settled)
        }
    }
}
