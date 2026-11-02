package cloud.agentdevice.node

import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class NodeWakeChannelTest {
    private val servers = mutableListOf<MockWebServer>()

    @After
    fun closeServers() {
        servers.forEach(MockWebServer::shutdown)
    }

    @Test
    fun connectsWithSignedHeadersAndAcceptsWakeSignal() {
        val server = MockWebServer().also {
            servers.add(it)
            it.start()
        }
        val nodeId = "node_example"
        val woke = CountDownLatch(1)
        server.enqueue(
            MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        webSocket.send(wakeMessage(nodeId))
                    }
                }
            )
        )
        val channel = NodeWakeChannel(
            requestProvider = {
                NodeWakeRequest(
                    server.url("/api/v1/nodes/$nodeId/events").toString()
                        .replaceFirst("http://", "ws://"),
                    mapOf(
                        "x-adc-node-id" to nodeId,
                        "x-adc-timestamp" to "2026-10-11T00:00:00Z",
                        "x-adc-nonce" to "nonce_example_123",
                        "x-adc-signature" to "signature"
                    )
                )
            },
            expectedNodeId = nodeId,
            onWake = woke::countDown
        )
        try {
            channel.start()
            assertTrue(woke.await(3, TimeUnit.SECONDS))
            assertTrue(channel.connected)
            val request = server.takeRequest(3, TimeUnit.SECONDS)!!
            assertEquals("/api/v1/nodes/$nodeId/events", request.path)
            assertEquals(nodeId, request.getHeader("x-adc-node-id"))
            assertEquals("signature", request.getHeader("x-adc-signature"))
        } finally {
            channel.close()
        }
    }

    @Test
    fun reconnectsAfterWakeSocketCloses() {
        val server = MockWebServer().also {
            servers.add(it)
            it.start()
        }
        val nodeId = "node_example"
        val connections = AtomicInteger()
        val woke = CountDownLatch(1)
        repeat(2) {
            server.enqueue(
                MockResponse().withWebSocketUpgrade(
                    object : WebSocketListener() {
                        override fun onOpen(webSocket: WebSocket, response: Response) {
                            if (connections.incrementAndGet() == 1) {
                                webSocket.close(1012, "restart")
                            } else {
                                webSocket.send(wakeMessage(nodeId))
                            }
                        }
                    }
                )
            )
        }
        val channel = NodeWakeChannel(
            requestProvider = {
                NodeWakeRequest(
                    server.url("/api/v1/nodes/$nodeId/events").toString()
                        .replaceFirst("http://", "ws://"),
                    emptyMap()
                )
            },
            expectedNodeId = nodeId,
            onWake = woke::countDown,
            reconnectInitialMs = 5,
            reconnectMaximumMs = 5,
            random = { 0.5 }
        )
        try {
            channel.start()
            assertTrue(woke.await(3, TimeUnit.SECONDS))
            assertEquals(2, connections.get())
        } finally {
            channel.close()
        }
    }

    private fun wakeMessage(nodeId: String): String =
        """
        {
          "schemaVersion": "0.1",
          "type": "dispatch.available",
          "nodeId": "$nodeId",
          "issuedAt": "${Instant.now()}"
        }
        """.trimIndent()
}
