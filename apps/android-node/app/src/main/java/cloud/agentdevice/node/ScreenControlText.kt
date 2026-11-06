package cloud.agentdevice.node

import android.content.Context
import org.json.JSONObject

object ScreenControlText {
    fun title(context: Context, state: JSONObject): String = context.getString(when {
        state.optString("mode") == "interrupted" && state.optInt("pendingActions") > 0 -> R.string.indicator_stopping
        state.optString("mode") == "handing_back" -> R.string.screen_handing_back
        state.optString("mode") == "interrupted" -> R.string.screen_interrupted
        state.optBoolean("paused") -> R.string.screen_paused
        state.optString("mode") == "using" -> R.string.screen_using
        state.optString("mode") == "waiting" -> R.string.screen_waiting
        state.optString("mode") == "released" -> R.string.screen_released
        else -> R.string.screen_idle
    })

    fun detail(context: Context, state: JSONObject): String {
        val purpose = state.optString("intent")
        val suffix = when {
            state.optString("mode") == "handing_back" || state.optInt("pendingActions") > 0 && state.optString("mode") == "interrupted" ->
                context.getString(R.string.indicator_settling)
            state.optString("mode") == "interrupted" -> context.getString(R.string.screen_check_phone)
            state.optBoolean("paused") -> context.getString(R.string.screen_resume_hint)
            state.optString("mode") in setOf("using", "waiting") ->
                context.getString(R.string.screen_lease_hint, (state.optLong("remainingMs") + 999) / 1000)
            else -> ""
        }
        return listOf(purpose, suffix).filter { it.isNotBlank() }.joinToString(" · ")
    }
}
