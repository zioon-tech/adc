package cloud.agentdevice.node

import org.json.JSONObject

/** Reuse only a fresh, already-redacted snapshot; never substitute an old screen. */
object PostActionObservation {
    fun attach(
        result: JSONObject,
        snapshot: JSONObject,
        requested: Boolean,
        fresh: Boolean
    ): JSONObject {
        if (requested && fresh) result.put("observation", snapshot)
        return result
    }
}
