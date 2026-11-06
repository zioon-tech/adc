package cloud.agentdevice.node

import okhttp3.Dns
import java.io.Closeable
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ExecutionException
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** A native resolver can outlive HTTP cancellation. Bound callers and worker count. */
internal class DeadlineDns(
    private val delegate: Dns = Dns.SYSTEM,
    private val timeoutMs: Long = 3_000,
    private val cacheMs: Long = 60_000,
    private val now: () -> Long = System::currentTimeMillis
) : Dns, Closeable {
    private data class Cached(val addresses: List<InetAddress>, val expiresAt: Long)
    private val lock = Any()
    private val cache = LinkedHashMap<String, Cached>()
    private val pending = mutableMapOf<String, CompletableFuture<List<InetAddress>>>()
    private val workers = ThreadPoolExecutor(
        2, 2, 30, TimeUnit.SECONDS, ArrayBlockingQueue(2),
        { runnable -> Thread(runnable, "adc-dns").apply { isDaemon = true } }
    ).apply { allowCoreThreadTimeOut(true) }

    override fun lookup(hostname: String): List<InetAddress> {
        val future = synchronized(lock) {
            cache[hostname]?.let {
                if (now() < it.expiresAt) return it.addresses.toList()
                cache.remove(hostname)
            }
            pending[hostname] ?: CompletableFuture<List<InetAddress>>().also { created ->
                pending[hostname] = created
                try {
                    workers.execute {
                        try {
                            val addresses = delegate.lookup(hostname).toList()
                            if (addresses.isEmpty()) throw UnknownHostException("Empty DNS response")
                            synchronized(lock) {
                                if (cache.size >= 32) cache.remove(cache.keys.first())
                                cache[hostname] = Cached(addresses, now() + cacheMs)
                                pending.remove(hostname, created)
                            }
                            created.complete(addresses)
                        } catch (error: Exception) {
                            synchronized(lock) { pending.remove(hostname, created) }
                            created.completeExceptionally(error)
                        }
                    }
                } catch (_: RejectedExecutionException) {
                    pending.remove(hostname, created)
                    created.completeExceptionally(UnknownHostException("DNS resolver capacity exhausted"))
                }
            }
        }
        return try {
            future.get(timeoutMs, TimeUnit.MILLISECONDS).toList()
        } catch (_: TimeoutException) {
            // Do not cancel/re-submit shared native work: it may ignore interruption.
            throw UnknownHostException("DNS lookup budget exceeded")
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            throw UnknownHostException("DNS lookup interrupted")
        } catch (_: ExecutionException) {
            throw UnknownHostException("DNS lookup failed")
        }
    }

    override fun close() { workers.shutdownNow() }

    companion object {
        val SHARED = DeadlineDns()
    }
}
