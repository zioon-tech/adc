package cloud.agentdevice.node

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.concurrent.TimeUnit

class NodeHttpTransportTest {
    private val server = MockWebServer()

    @After
    fun closeServer() { server.shutdown() }

    @Test
    fun reusesConnectionAcrossTransportInstancesAndPreservesProof() {
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        repeat(2) {
            val response = NodeHttpTransport().post(
                server.url("/request").toString(),
                JSONObject().put("claim", true),
                mapOf("x-adc-signature" to "proof")
            )
            assertTrue(response.getBoolean("ok"))
        }
        val first = server.takeRequest(1, TimeUnit.SECONDS)!!
        val second = server.takeRequest(1, TimeUnit.SECONDS)!!
        assertEquals(0, first.sequenceNumber)
        assertEquals(1, second.sequenceNumber)
        assertEquals("POST", second.method)
        assertEquals("proof", second.getHeader("x-adc-signature"))
        assertEquals("application/json; charset=utf-8", second.getHeader("content-type"))
        assertEquals("""{"claim":true}""", second.body.readUtf8())
    }

    @Test
    fun doesNotReplayWhenResponseIsLostAfterRequest() {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        assertThrows(IOException::class.java) {
            NodeHttpTransport().post(server.url("/receipt").toString(), JSONObject(), emptyMap())
        }
        assertEquals(1, server.requestCount)
    }

    @Test
    fun doesNotFollowRedirectOrReplayServiceUnavailable() {
        for (status in listOf(307, 503)) {
            server.enqueue(MockResponse().setResponseCode(status)
                .setHeader("Location", server.url("/unexpected"))
                .setHeader("Retry-After", "0")
                .setBody("""{"error":{"code":"busy","message":"Try later"}}"""))
            val error = assertThrows(NodeApiException::class.java) {
                NodeHttpTransport().post(server.url("/request").toString(), JSONObject(), emptyMap())
            }
            assertEquals(status, error.statusCode)
            assertEquals("busy", error.code)
            assertEquals("Try later", error.message)
        }
        assertEquals(2, server.requestCount)
    }

    @Test
    fun preservesStructuredErrorsAndReleasesConnection() {
        server.enqueue(MockResponse().setResponseCode(409).setBody(
            """{"error":{"code":"conflict","message":"Changed","details":{"revision":7}}}"""
        ))
        server.enqueue(MockResponse().setResponseCode(204))
        val transport = NodeHttpTransport()
        val error = assertThrows(NodeApiException::class.java) {
            transport.post(server.url("/request").toString(), JSONObject(), emptyMap())
        }
        assertEquals(409, error.statusCode)
        assertEquals("conflict", error.code)
        assertEquals("""Changed: {"revision":7}""", error.message)
        assertEquals(0, transport.post(server.url("/request").toString(), JSONObject(), emptyMap()).length())
        server.takeRequest(1, TimeUnit.SECONDS)
        assertEquals(1, server.takeRequest(1, TimeUnit.SECONDS)!!.sequenceNumber)
    }
}
