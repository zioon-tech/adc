package cloud.agentdevice.node

import android.app.Activity
import android.content.Intent
import android.os.Binder
import android.os.Bundle
import android.os.IInterface
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.lang.reflect.Proxy

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [28], qualifiers = "w320dp-h640dp-mdpi")
class ScreenCaptureSessionTest {
    @Before fun reset() { ScreenCaptureSession.stop() }
    @After fun close() { ScreenCaptureSession.stop() }
    private fun start() {
        val app = RuntimeEnvironment.getApplication()
        // Android's consent result carries an IMediaProjection Binder. Supply only this
        // system dependency; session creation, display replacement and waiting remain real.
        val binder = systemBinder("android.media.projection.IMediaProjection")
        val consent = Intent().putExtras(Bundle().apply {
            putBinder("android.media.projection.extra.EXTRA_MEDIA_PROJECTION", binder)
        })
        ScreenCaptureSession.start(app, Activity.RESULT_OK, consent)
    }
    private fun systemBinder(name: String): Binder {
        val binder = Binder()
        val type = Class.forName(name)
        val remote = Proxy.newProxyInstance(type.classLoader, arrayOf(type)) { _, method, args ->
            when (method.name) {
                "asBinder" -> binder
                "applyVirtualDisplayFlags" -> args!![0]
                else -> if (method.returnType == Boolean::class.javaPrimitiveType) true else null
            }
        } as IInterface
        binder.attachInterface(remote, name)
        return binder
    }
    private fun field(name: String) = ScreenCaptureSession::class.java.getDeclaredField(name)
        .apply { isAccessible = true }.get(ScreenCaptureSession)

    @Test fun stoppingScreenSharingInterruptsAWaitingCaptureWithoutTheFrameTimeout() {
        start()
        assertTrue(ScreenCaptureSession.isActive())
        val waiting = CountDownLatch(1)
        val checks = AtomicInteger()
        val executor = Executors.newSingleThreadExecutor()
        try {
            val result = executor.submit<String> {
                try {
                    ScreenCaptureSession.capture(320, {
                        if (checks.incrementAndGet() >= 2) waiting.countDown()
                        false
                    })
                    "unexpected"
                } catch (error: CapabilityException) { error.code }
            }
            assertTrue(waiting.await(1, TimeUnit.SECONDS))
            val stop = System.nanoTime()
            ScreenCaptureSession.stop()
            assertTrue("Stop must not wait for a missing frame",
                System.nanoTime() - stop < TimeUnit.SECONDS.toNanos(1))
            assertEquals("denied", result.get(1, TimeUnit.SECONDS))
            assertFalse(ScreenCaptureSession.isActive())
        } finally { ScreenCaptureSession.stop(); executor.shutdownNow() }
    }

    @Test fun missingFramesRebindTheExistingDisplayOnceAndReportStalledSharing() {
        // Robolectric has no compositor: this intentionally exercises the no-frame path.
        start()
        val originalDisplay = field("display")
        val originalStream = field("stream")
        try { ScreenCaptureSession.capture(320, { false }); fail("No frame was produced") }
        catch (error: CapabilityException) {
            assertEquals("execution_failed", error.code)
            assertTrue(error.retryable)
            assertTrue(error.message.contains("surface recovery"))
        }
        assertSame("Recovery must not create a second VirtualDisplay", originalDisplay, field("display"))
        assertNotSame("Recovery must replace the stalled consumer surface", originalStream, field("stream"))
        assertTrue(ScreenCaptureSession.isStalled())
        assertTrue(ScreenCaptureSession.isActive())
        ScreenCaptureSession.stop()
        assertFalse(ScreenCaptureSession.isStalled())
        assertFalse(ScreenCaptureSession.isActive())
    }

    @Test fun missingConsentAndCancelledRequestsNeverWaitForAFrame() {
        try { ScreenCaptureSession.capture(320, { false }); fail("Capture needs local consent") }
        catch (error: CapabilityException) { assertEquals("denied", error.code); assertFalse(error.retryable) }
        try { ScreenCaptureSession.capture(320, { true }); fail("Cancelled capture must stop") }
        catch (error: CapabilityException) { assertEquals("cancelled", error.code) }
        listOf("gif" to 85, "png" to 0, "jpeg" to 101).forEach { (format, quality) ->
            try {
                ScreenCaptureSession.capture(320, { false }, format = format, quality = quality)
                fail("Invalid encoding arguments must be rejected")
            } catch (_: IllegalArgumentException) { /* Expected validation failure. */ }
        }
        assertFalse(ScreenCaptureSession.isActive())
    }
}
