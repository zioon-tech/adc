package cloud.agentdevice.node

import okhttp3.Dns
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.UnknownHostException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class DeadlineDnsTest {
    private fun resolver(resolve: () -> List<InetAddress>) = object : Dns {
        override fun lookup(hostname: String) = resolve()
    }

    private val addresses = listOf(
        InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)),
        InetAddress.getByAddress(byteArrayOf(127, 0, 0, 2))
    )

    @Test
    fun cachesSuccessfulAddressesInOriginalOrderUntilExpiry() {
        var clock = 1_000L
        val calls = AtomicInteger()
        DeadlineDns(resolver { calls.incrementAndGet(); addresses }, cacheMs = 100, now = { clock }).use {
            assertEquals(addresses, it.lookup("adc.example"))
            assertEquals(addresses, it.lookup("adc.example"))
            assertEquals(1, calls.get())
            clock += 100
            assertEquals(addresses, it.lookup("adc.example"))
            assertEquals(2, calls.get())
        }
    }

    @Test
    fun timesOutNativeResolutionWithoutRepeatingBlockedWork() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val calls = AtomicInteger()
        DeadlineDns(resolver {
            calls.incrementAndGet()
            entered.countDown()
            release.await()
            addresses
        }, timeoutMs = 30).use { dns ->
            try {
                val started = System.nanoTime()
                assertThrows(UnknownHostException::class.java) { dns.lookup("adc.example") }
                assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < 500)
                assertTrue(entered.await(1, TimeUnit.SECONDS))
                repeat(2) { assertThrows(UnknownHostException::class.java) { dns.lookup("adc.example") } }
                assertEquals(1, calls.get())
                release.countDown()
                assertEquals(addresses, dns.lookup("adc.example"))
                assertEquals(1, calls.get())
            } finally {
                release.countDown()
            }
        }
    }

    @Test
    fun doesNotCacheFailedResolutionAndRecoversOnNextLookup() {
        val calls = AtomicInteger()
        DeadlineDns(resolver {
            if (calls.incrementAndGet() == 1) throw UnknownHostException("private hostname")
            addresses
        }).use { dns ->
            val failure = assertThrows(UnknownHostException::class.java) { dns.lookup("adc.example") }
            assertEquals("DNS lookup failed", failure.message)
            assertEquals(addresses, dns.lookup("adc.example"))
            assertEquals(2, calls.get())
        }
    }

    @Test
    fun boundsWorkerCountWhenSeveralHostnamesCannotResolve() {
        val release = CountDownLatch(1)
        val calls = AtomicInteger()
        DeadlineDns(resolver {
            calls.incrementAndGet()
            release.await()
            addresses
        }, timeoutMs = 20).use { dns ->
            try {
                repeat(8) { index ->
                    assertThrows(UnknownHostException::class.java) { dns.lookup("host$index.example") }
                }
                assertEquals(2, calls.get())
            } finally {
                release.countDown()
            }
        }
    }
}
