package cloud.agentdevice.node

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock

data class CapturedScreen(
    val data: ByteArray,
    val width: Int,
    val height: Int,
    val sha256: String,
    val frameWaitMs: Long,
    val encodeMs: Long,
    val recoveryCount: Int = 0
)

object ScreenCaptureSession {
    private val lock = Any()
    private val captureLock = ReentrantLock()

    private class Stream(val reader: ImageReader, val width: Int, val height: Int) {
        val frames = ScreenFrameQueue<Image> { it.timestamp }
    }

    @Volatile
    private var projection: MediaProjection? = null
    private var stream: Stream? = null
    private var display: VirtualDisplay? = null
    private var handlerThread: HandlerThread? = null
    private var handler: Handler? = null
    private var sessionContext: Context? = null
    private var stalled = false
    private var frameCount = 0L
    private var lastFrameAt = 0L
    private var lastFrameTimestamp = 0L

    fun isActive(): Boolean = synchronized(lock) {
        projection != null && stream != null && display != null
    }

    fun isStalled(): Boolean = synchronized(lock) { stalled }

    fun start(context: Context, resultCode: Int, data: Intent) {
        require(resultCode == Activity.RESULT_OK) { "Screen capture consent was not granted" }
        synchronized(lock) {
            stopLocked()
            val manager = context.getSystemService(MediaProjectionManager::class.java)
            val nextProjection = manager.getMediaProjection(resultCode, data)
                ?: throw IllegalStateException("Android did not provide a screen capture session")
            val metrics = screenDisplayMetrics(context)
            val nextThread = HandlerThread("adc-screen-capture").apply { start() }
            val nextHandler = Handler(nextThread.looper)
            projection = nextProjection
            handlerThread = nextThread
            handler = nextHandler
            sessionContext = context.applicationContext
            frameCount = 0
            lastFrameAt = 0
            lastFrameTimestamp = 0
            try {
                val nextStream = createStreamLocked(metrics.widthPixels, metrics.heightPixels)
                stream = nextStream
                nextProjection.registerCallback(
                    object : MediaProjection.Callback() {
                        override fun onStop() {
                            synchronized(lock) {
                                if (projection === nextProjection) {
                                    Log.i(TAG, "projection_stopped")
                                    stopLocked(stopProjection = false)
                                }
                            }
                            notifyCapabilityChanged(context)
                        }
                    },
                    nextHandler
                )
                display = nextProjection.createVirtualDisplay(
                    "ADC screen capture",
                    metrics.widthPixels,
                    metrics.heightPixels,
                    metrics.densityDpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    nextStream.reader.surface,
                    object : VirtualDisplay.Callback() {
                        override fun onPaused() { Log.i(TAG, "display_paused") }
                        override fun onResumed() { Log.i(TAG, "display_resumed") }
                        override fun onStopped() { Log.i(TAG, "display_stopped") }
                    },
                    nextHandler
                ) ?: error("Android did not create a screen capture display")
                Log.i(TAG, "session_started width=${metrics.widthPixels} height=${metrics.heightPixels}")
            } catch (error: RuntimeException) {
                stopLocked()
                throw error
            }
        }
        notifyCapabilityChanged(context)
    }

    fun stop(context: Context? = null) {
        synchronized(lock) {
            stopLocked()
        }
        context?.let(::notifyCapabilityChanged)
    }

    fun capture(
        maxWidth: Int,
        cancelled: () -> Boolean,
        freshAfter: Long = 0L,
        format: String = "png",
        quality: Int = 85
    ): CapturedScreen {
        require(format == "png" || format == "jpeg") { "Unsupported screenshot format" }
        require(quality in 1..100) { "Screenshot quality must be between 1 and 100" }
        // Serialize consumers, but never hold the lifecycle lock while waiting or compressing.
        while (!captureLock.tryLock(50, TimeUnit.MILLISECONDS)) {
            requireNotCancelled(cancelled)
        }
        try {
            requireNotCancelled(cancelled)
            val started = System.nanoTime()
            val fence = maxOf(started, freshAfter)
            var current = synchronized(lock) { requireStreamLocked() }
            var recoveryCount = 0
            var image = current.frames.take(fence, INITIAL_FRAME_WAIT_MS, cancelled)
            if (image == null) {
                requireNotCancelled(cancelled)
                current = synchronized(lock) {
                    requireCurrentLocked(current)
                    replaceSurfaceLocked(current)
                }
                recoveryCount = 1
                image = current.frames.take(fence, RECOVERY_FRAME_WAIT_MS, cancelled)
            }
            val captured = image ?: synchronized(lock) {
                requireCurrentLocked(current)
                stalled = true
                sessionContext?.let(::notifyCapabilityChanged)
                Log.w(TAG, "frame_timeout frames=$frameCount lastTimestamp=$lastFrameTimestamp " +
                    "lastArrivalAgeMs=${frameAgeMs()} fence=$fence recovery=$recoveryCount")
                throw CapabilityException(
                    "execution_failed",
                    "Android did not provide a current screen frame after surface recovery. " +
                        "Restart screen sharing in ADC if it remains stalled.",
                    true
                )
            }
            // Closing an ImageReader invalidates outstanding Images. Copy pixels under the
            // lifecycle lock, then release the Image before potentially expensive compression.
            val bitmap = synchronized(lock) {
                try {
                    requireCurrentLocked(current)
                    requireNotCancelled(cancelled)
                    Log.d(TAG, "frame_ready timestamp=${captured.timestamp} fence=$fence recovery=$recoveryCount")
                    copyBitmap(captured, current.width, current.height)
                } finally { captured.close() }
            }
            val frameWaitMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
            val result = encode(bitmap, maxWidth.coerceIn(320, 2160), format, quality, frameWaitMs)
                .copy(recoveryCount = recoveryCount)
            requireNotCancelled(cancelled)
            synchronized(lock) {
                requireCurrentLocked(current)
                stalled = false
            }
            Log.d(TAG, "capture_complete waitMs=$frameWaitMs encodeMs=${result.encodeMs} recovery=$recoveryCount")
            return result
        } finally {
            captureLock.unlock()
        }
    }

    private fun copyBitmap(image: Image, width: Int, height: Int): Bitmap {
        val plane = image.planes.first()
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val paddedWidth = width + (rowStride - pixelStride * width) / pixelStride
        val padded = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888)
        return try {
            padded.copyPixelsFromBuffer(plane.buffer)
            Bitmap.createBitmap(padded, 0, 0, width, height).also {
                if (it !== padded) padded.recycle()
            }
        } catch (error: RuntimeException) {
            padded.recycle()
            throw error
        }
    }

    private fun encode(
        cropped: Bitmap, maxWidth: Int, format: String, quality: Int, frameWaitMs: Long
    ): CapturedScreen {
        val started = System.nanoTime()
        val width = cropped.width
        val height = cropped.height
        val output =
            if (width > maxWidth) {
                val scaledHeight = (height.toLong() * maxWidth / width).toInt().coerceAtLeast(1)
                Bitmap.createScaledBitmap(cropped, maxWidth, scaledHeight, true).also {
                    if (it !== cropped) cropped.recycle()
                }
            } else {
                cropped
            }
        val stream = ByteArrayOutputStream()
        try {
            val compression = if (format == "jpeg") Bitmap.CompressFormat.JPEG else Bitmap.CompressFormat.PNG
            if (!output.compress(compression, if (format == "jpeg") quality else 100, stream)) {
                throw CapabilityException(
                    "execution_failed",
                    "Android could not encode the captured screen.",
                    true
                )
            }
            val bytes = stream.toByteArray()
            val digest = MessageDigest.getInstance("SHA-256")
                .digest(bytes)
                .joinToString("") { "%02x".format(it) }
            return CapturedScreen(
                data = bytes,
                width = output.width,
                height = output.height,
                sha256 = "sha256:$digest",
                frameWaitMs = frameWaitMs,
                encodeMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
            )
        } finally {
            output.recycle()
            stream.close()
        }
    }

    private fun createStreamLocked(width: Int, height: Int): Stream {
        // Allow two free slots even if a consumer and the queue each temporarily own one frame.
        val next = Stream(ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 4), width, height)
        next.reader.setOnImageAvailableListener({ source ->
            synchronized(lock) {
                if (stream !== next) return@synchronized
                try {
                    val image = source.acquireLatestImage() ?: return@synchronized
                    frameCount++
                    lastFrameAt = System.nanoTime()
                    lastFrameTimestamp = image.timestamp
                    next.frames.offer(image)
                    if (stalled) {
                        stalled = false
                        sessionContext?.let(::notifyCapabilityChanged)
                        Log.i(TAG, "frame_stream_resumed")
                    }
                } catch (error: IllegalStateException) {
                    Log.w(TAG, "frame_acquire_failed", error)
                }
            }
        }, handler ?: error("Screen capture handler is missing"))
        return next
    }

    private fun replaceSurfaceLocked(previous: Stream): Stream {
        val currentDisplay = display ?: throw stoppedException()
        val next = createStreamLocked(previous.width, previous.height)
        try {
            // Reuse the authorized VirtualDisplay. Android 14+ forbids recreating it from the
            // same consent Intent. A new consumer surface also requests a frame on static pages.
            currentDisplay.surface = null
            currentDisplay.surface = next.reader.surface
            stream = next
            previous.frames.stop()
            previous.reader.close()
            Log.i(TAG, "surface_rebound frames=$frameCount lastArrivalAgeMs=${frameAgeMs()}")
            return next
        } catch (error: RuntimeException) {
            next.frames.stop()
            next.reader.close()
            val context = sessionContext
            stopLocked()
            context?.let(::notifyCapabilityChanged)
            Log.w(TAG, "surface_recovery_failed", error)
            throw stoppedException()
        }
    }

    private fun requireStreamLocked(): Stream =
        stream?.takeIf { projection != null && display != null } ?: throw stoppedException()

    private fun requireCurrentLocked(expected: Stream) {
        if (stream !== expected || projection == null || display == null) throw stoppedException()
    }

    private fun stoppedException() = CapabilityException(
        "denied", "Screen capture stopped. Allow screen capture in ADC again.", false
    )

    private fun requireNotCancelled(cancelled: () -> Boolean) {
        if (cancelled()) throw CapabilityException("cancelled", "Invocation was cancelled.", false)
    }

    private fun frameAgeMs(): Long =
        if (lastFrameAt == 0L) -1 else TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - lastFrameAt)

    private fun stopLocked(stopProjection: Boolean = true) {
        val currentProjection = projection
        projection = null
        display?.release()
        display = null
        stream?.frames?.stop()
        stream?.reader?.close()
        stream = null
        handlerThread?.quitSafely()
        handlerThread = null
        handler = null
        stalled = false
        sessionContext = null
        if (stopProjection) currentProjection?.stop()
    }

    private fun notifyCapabilityChanged(context: Context) {
        context.sendBroadcast(
            Intent(ACTION_CAPABILITY_CHANGED).setPackage(context.packageName)
        )
    }

    const val ACTION_CAPABILITY_CHANGED =
        "cloud.agentdevice.node.SCREEN_CAPTURE_CAPABILITY_CHANGED"

    private const val TAG = "AdcScreenCapture"
    private const val INITIAL_FRAME_WAIT_MS = 250L
    private const val RECOVERY_FRAME_WAIT_MS = 1750L
}
