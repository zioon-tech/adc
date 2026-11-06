package cloud.agentdevice.node

/** Bounded consecutive-content checks. A failed or changing capture is never reusable. */
internal object ObservationSettler {
    data class Sample<T>(val value: T, val fingerprint: String, val stable: Boolean)
    data class Result<T>(val value: T?, val settled: Boolean)

    fun <T> await(
        beforeRevision: Long,
        waitMs: Long,
        elapsed: () -> Long,
        pause: (Long) -> Unit,
        revision: () -> Long,
        capture: () -> Sample<T>?
    ): Result<T> {
        val deadline = elapsed() + waitMs
        var fingerprint: String? = null
        var unchangedSince = elapsed()
        while (true) {
            val sample = capture()
            val now = elapsed()
            if (sample?.stable != true) {
                fingerprint = null
                unchangedSince = now
            } else if (sample.fingerprint != fingerprint) {
                fingerprint = sample.fingerprint
                unchangedSince = now
            }
            val settled = sample?.stable == true &&
                (waitMs == 0L || now - unchangedSince >= 100L)
            if (now >= deadline || settled && revision() != beforeRevision) {
                return Result(sample?.value, settled)
            }
            pause(minOf(50L, deadline - now))
        }
    }
}
