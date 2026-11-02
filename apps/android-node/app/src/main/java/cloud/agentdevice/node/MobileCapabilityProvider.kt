package cloud.agentdevice.node

import org.json.JSONObject

interface MobileCapabilityProvider {
    val toolNames: Set<String>

    fun descriptors(observedAt: String): List<JSONObject>

    fun execute(
        tool: String,
        args: JSONObject,
        cancelled: () -> Boolean
    ): MobileCapabilityResult

    fun close() = Unit
}
