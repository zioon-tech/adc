package cloud.agentdevice.node

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class ScreenFrameQueueTest {
    private class Frame(val timestamp: Long) : AutoCloseable {
        val closes = AtomicInteger()
        override fun close() { closes.incrementAndGet() }
    }
    private fun queue() = ScreenFrameQueue<Frame> { it.timestamp }

    @Test fun newestFrameHasOneOwnerAndAllUnusedFramesAreReleased() {
        val queue = queue()
        val frames = (1L..100L).map(::Frame)
        frames.forEach(queue::offer)
        assertTrue(frames.dropLast(1).all { it.closes.get() == 1 })
        val taken = queue.take(100, 0) { false }!!
        assertSame(frames.last(), taken)
        assertEquals(0, taken.closes.get())
        assertNull(queue.take(0, 0) { false })
        queue.stop()
        assertEquals(0, taken.closes.get())
        taken.close()
        assertTrue(frames.all { it.closes.get() == 1 })
    }

    @Test fun onlyFramesAtOrAfterTheFenceAreAccepted() {
        listOf(99L, 100L, 101L).forEach { timestamp ->
            val queue = queue()
            val frame = Frame(timestamp)
            queue.offer(frame)
            val taken = queue.take(100, 0) { false }
            if (timestamp < 100) {
                assertNull(taken)
                assertEquals(1, frame.closes.get())
            } else {
                assertSame(frame, taken)
                assertEquals(0, frame.closes.get())
                taken!!.close()
            }
            queue.stop()
            assertEquals(1, frame.closes.get())
        }
    }

    @Test fun aStoppedProducerClosesPendingAndLateFramesAndWakesTheConsumer() {
        val queue = queue()
        val pending = Frame(1)
        queue.offer(pending)
        queue.stop()
        queue.stop()
        val late = Frame(2)
        queue.offer(late)
        assertEquals(1, pending.closes.get())
        assertEquals(1, late.closes.get())
        try { queue.take(0, 5000) { false }; fail("Stopped capture must require consent") }
        catch (error: CapabilityException) {
            assertEquals("denied", error.code)
            assertFalse(error.retryable)
        }

        val waitingQueue = queue()
        val started = CountDownLatch(1)
        val executor = Executors.newSingleThreadExecutor()
        try {
            val result = executor.submit<String> {
                try {
                    waitingQueue.take(0, 5000) { started.countDown(); false }
                    "unexpected"
                } catch (error: CapabilityException) { error.code }
            }
            assertTrue(started.await(1, TimeUnit.SECONDS))
            waitingQueue.stop()
            assertEquals("denied", result.get(1, TimeUnit.SECONDS))
        } finally { waitingQueue.stop(); executor.shutdownNow() }
    }

    @Test fun arrivingFramesWakeTheConsumerAndTransferOwnership() {
        val queue = queue()
        val started = CountDownLatch(1)
        val executor = Executors.newSingleThreadExecutor()
        val frame = Frame(10)
        try {
            val result = executor.submit<Frame?> {
                queue.take(10, 5000) { started.countDown(); false }
            }
            assertTrue(started.await(1, TimeUnit.SECONDS))
            queue.offer(frame)
            assertSame(frame, result.get(1, TimeUnit.SECONDS))
            assertEquals(0, frame.closes.get())
            frame.close()
        } finally { queue.stop(); executor.shutdownNow() }
        assertEquals(1, frame.closes.get())
    }

    @Test fun cancellationIsObservedWithoutAFrameCallbackAndDoesNotConsumeAFrame() {
        val queue = queue()
        val frame = Frame(1)
        queue.offer(frame)
        try { queue.take(0, 0) { true }; fail("Cancelled capture must not return an image") }
        catch (error: CapabilityException) { assertEquals("cancelled", error.code) }
        assertSame(frame, queue.take(0, 0) { false })
        frame.close()

        val started = CountDownLatch(1)
        val cancel = AtomicBoolean()
        val executor = Executors.newSingleThreadExecutor()
        try {
            val result = executor.submit<String> {
                try {
                    queue.take(0, 5000) { started.countDown(); cancel.get() }
                    "unexpected"
                } catch (error: CapabilityException) { error.code }
            }
            assertTrue(started.await(1, TimeUnit.SECONDS))
            cancel.set(true)
            assertEquals("cancelled", result.get(1, TimeUnit.SECONDS))
        } finally { queue.stop(); executor.shutdownNow() }
        assertEquals(1, frame.closes.get())
    }

    @Test fun timeoutNeverReturnsAPreviouslyConsumedOrRejectedImage() {
        val queue = queue()
        val stale = Frame(1)
        queue.offer(stale)
        assertNull(queue.take(2, 10) { false })
        assertEquals(1, stale.closes.get())
        assertNull(queue.take(0, 0) { false })
        queue.stop()
    }
}
