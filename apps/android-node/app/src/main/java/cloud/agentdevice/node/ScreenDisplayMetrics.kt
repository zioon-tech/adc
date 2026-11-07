package cloud.agentdevice.node

import android.content.Context
import android.os.Build
import android.util.DisplayMetrics
import android.view.WindowManager

/** Screen coordinates include system bars, just like captures and Accessibility gestures. */
internal fun screenDisplayMetrics(context: Context): DisplayMetrics {
    val manager = context.getSystemService(WindowManager::class.java)
    return DisplayMetrics().apply {
        setTo(context.resources.displayMetrics)
        if (Build.VERSION.SDK_INT >= 30) {
            val bounds = manager.maximumWindowMetrics.bounds
            widthPixels = bounds.width()
            heightPixels = bounds.height()
        } else {
            @Suppress("DEPRECATION")
            manager.defaultDisplay.getRealMetrics(this)
        }
    }
}
