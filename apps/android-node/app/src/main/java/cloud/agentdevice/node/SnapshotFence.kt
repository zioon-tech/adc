package cloud.agentdevice.node

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID

/** Bounded metadata only: never retain the screen or password values. */
internal class SnapshotFence(
    private val elapsed: () -> Long,
    private val capacity: Int = 64,
    private val ttlMs: Long = 120_000L
) {
    data class Ticket(
        val id: String,
        val maxDepth: Int,
        val maxNodes: Int,
        val revision: Long,
        val fingerprint: String,
        val strict: Boolean,
        val stable: Boolean,
        val at: Long
    )

    private val session = UUID.randomUUID().toString().replace("-", "").take(12)
    private val tickets = LinkedHashMap<String, Ticket>()

    @Synchronized
    fun record(content: JSONObject, maxDepth: Int, maxNodes: Int, revision: Long, finalRevision: Long): Ticket {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(canonical(content).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        val nodes = content.optJSONArray("nodes") ?: JSONArray()
        val strict = content.optBoolean("truncated") ||
            (0 until nodes.length()).any { nodes.optJSONObject(it)?.optBoolean("password") == true }
        val ticket = Ticket(
            "uisnap_${session}_${revision}_${maxDepth}_${maxNodes}_${digest.take(32)}",
            maxDepth, maxNodes, revision, digest, strict, revision == finalRevision, elapsed()
        )
        tickets.remove(ticket.id)
        tickets[ticket.id] = ticket
        while (tickets.size > capacity) tickets.remove(tickets.keys.first())
        return ticket
    }

    @Synchronized
    fun lookup(id: String): Ticket {
        val ticket = tickets[id] ?: conflict()
        if (elapsed() - ticket.at >= ttlMs) {
            tickets.remove(id)
            conflict()
        }
        return ticket
    }

    fun requireCurrent(reference: Ticket, current: Ticket, semantic: Boolean) {
        lookup(reference.id)
        if (!reference.stable || !current.stable ||
            reference.maxDepth != current.maxDepth || reference.maxNodes != current.maxNodes ||
            reference.fingerprint != current.fingerprint ||
            ((!semantic || reference.strict || current.strict) && reference.revision != current.revision)
        ) conflict()
    }

    private fun conflict(): Nothing = throw CapabilityException(
        "conflict", "The UI changed after the referenced snapshot; inspect it again.", false
    )

    private fun canonical(value: Any?): String = when (value) {
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") {
            JSONObject.quote(it) + ":" + canonical(value.get(it))
        }
        is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
        null, JSONObject.NULL -> "null"
        is String -> JSONObject.quote(value)
        else -> value.toString()
    }
}
