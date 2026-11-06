package cloud.agentdevice.node

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import org.json.JSONObject

/** Uses public Android APIs. Permission to request promotion is not proof of presentation. */
object ScreenControlNotifications {
    const val ID = 4102

    fun active(state: JSONObject): Boolean =
        state.optString("mode") in setOf("using", "waiting", "handing_back") ||
            state.optInt("pendingActions") > 0

    fun promote(context: Context, notification: Notification, state: JSONObject): Notification {
        if (Build.VERSION.SDK_INT < 36 || !active(state)) return notification
        val manager = context.getSystemService(NotificationManager::class.java)
        if (!manager.canPostPromotedNotifications()) return notification
        return Notification.Builder.recoverBuilder(context, notification)
            .addExtras(Bundle().apply { putBoolean(NotificationCompat.EXTRA_REQUEST_PROMOTED_ONGOING, true) })
            .setShortCriticalText(context.getString(when {
                state.optString("mode") == "handing_back" || state.optString("mode") == "interrupted" -> R.string.indicator_chip_stopping
                state.optString("mode") == "using" -> R.string.indicator_chip_using
                else -> R.string.indicator_chip_waiting
            }))
            .build()
    }

    /** Keep the fallback until Android actually reports a promoted, ongoing notification. */
    fun isPromoted(context: Context): Boolean = Build.VERSION.SDK_INT >= 36 && runCatching {
        context.getSystemService(NotificationManager::class.java).activeNotifications.any {
            it.id == ID && it.notification.flags and Notification.FLAG_PROMOTED_ONGOING != 0 &&
                it.notification.flags and Notification.FLAG_ONGOING_EVENT != 0
        }
    }.getOrDefault(false)
}
