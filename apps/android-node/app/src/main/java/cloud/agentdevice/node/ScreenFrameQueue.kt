package cloud.agentdevice.node

import java.util.concurrent.TimeUnit

/** Owns at most one pending frame. A taken frame belongs exclusively to its caller. */
internal class ScreenFrameQueue<T : AutoCloseable>(private val timestamp: (T) -> Long) {
    private val monitor = Object()
    private var latest: T? = null
    private var stopped = false

    fun offer(frame: T) = synchronized(monitor) {
        if (stopped) {
            frame.close()
        } else {
            latest?.close()
            latest = frame
            monitor.notifyAll()
        }
    }

    fun take(freshAfter: Long, timeoutMs: Long, cancelled: () -> Boolean): T? {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        synchronized(monitor) {
            while (true) {
                if (cancelled()) {
                    throw CapabilityException("cancelled", "Invocation was cancelled.", false)
                }
                if (stopped) {
                    throw CapabilityException(
                        "denied", "Screen capture stopped. Allow screen capture in ADC again.", false
                    )
                }
                val frame = latest
                latest = null
                if (frame != null) {
                    if (timestamp(frame) >= freshAfter) return frame
                    frame.close()
                }
                val remaining = deadline - System.nanoTime()
                if (remaining <= 0) return null
                // Cancellation remains bounded even when Android produces no callbacks.
                TimeUnit.NANOSECONDS.timedWait(
                    monitor, remaining.coerceAtMost(TimeUnit.MILLISECONDS.toNanos(50))
                )
            }
        }
    }

    fun stop() = synchronized(monitor) {
        stopped = true
        latest?.close()
        latest = null
        monitor.notifyAll()
    }
}
