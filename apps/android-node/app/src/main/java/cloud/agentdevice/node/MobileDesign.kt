package cloud.agentdevice.node

import android.content.Context
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import androidx.core.graphics.PathParser

/** One quiet surface system and one rounded line icon family across the native client. */
class MobilePalette(context: Context) {
    val dark = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK ==
        Configuration.UI_MODE_NIGHT_YES
    val canvas = Color.parseColor(if (dark) "#101714" else "#F4F6F3")
    val surface = Color.parseColor(if (dark) "#1C2520" else "#FFFFFF")
    val ink = Color.parseColor(if (dark) "#E7EEE8" else "#17231D")
    val muted = Color.parseColor(if (dark) "#A0AFA5" else "#6B7870")
    val accent = Color.parseColor(if (dark) "#8ED8B4" else "#087A5B")
    val tonal = Color.parseColor(if (dark) "#2B4437" else "#E4F0E8")
    val line = Color.parseColor(if (dark) "#303C34" else "#EDF0EB")
    val danger = Color.parseColor(if (dark) "#FFB4A8" else "#B33F32")
    val controller = Color.parseColor(if (dark) "#203D31" else "#183E31")
    val onController = Color.parseColor("#F3FAF4")
    val controllerMuted = Color.parseColor("#B5D1BF")
    val controllerAction = Color.parseColor("#B5E7C8")
}

enum class MobileGlyph(val path: String) {
    DEVICES("M3,4 H18 Q20,4 20,6 V15 H3 Q2,15 2,14 V5 Q2,4 3,4 M7,20 H13 M10,15 V20 M17,11 H21 Q22,11 22,12 V20 Q22,21 21,21 H17 Q16,21 16,20 V12 Q16,11 17,11"),
    PHONE("M8,2 H16 Q18,2 18,4 V20 Q18,22 16,22 H8 Q6,22 6,20 V4 Q6,2 8,2 M10,5 H14 M11,19 H13"),
    COMPUTER("M4,4 H20 Q22,4 22,6 V15 Q22,17 20,17 H4 Q2,17 2,15 V6 Q2,4 4,4 M8,21 H16 M12,17 V21"),
    ACCOUNT("M16,7 A4,4 0,1 1,8,7 A4,4 0,1 1,16,7 M4,21 V19 Q4,14 9,14 H15 Q20,14 20,19 V21"),
    BACK("M19,12 H5 M11,6 L5,12 L11,18"),
    CHEVRON("M9,5 L16,12 L9,19"),
    REFRESH("M20,7 V3 M20,7 H16 M20,7 A9,9 0,0 0,4,7 M4,17 V21 M4,17 H8 M4,17 A9,9 0,0 0,20,17"),
    PLUS("M12,5 V19 M5,12 H19"),
    POWER("M12,2 V11 M6,5 A9,9 0,1 0,18,5"),
    SHIELD("M12,2 L21,6 V12 Q21,19 12,22 Q3,19 3,12 V6 Z M8,12 L11,15 L16,9"),
    GLOBE("M22,12 A10,10 0,1 1,2,12 A10,10 0,1 1,22,12 M2,12 H22 M12,2 Q4,12 12,22 M12,2 Q20,12 12,22"),
    EDIT("M14,4 L20,10 M3,21 L4,15 L16,3 Q17,2 18,3 L21,6 Q22,7 21,8 L9,20 Z"),
    INFO("M22,12 A10,10 0,1 1,2,12 A10,10 0,1 1,22,12 M12,11 V17 M12,7 V7.2"),
    LINK("M10,13 Q7,10 10,7 L13,4 Q17,1 20,4 Q23,7 20,10 L17,13 M14,11 Q17,14 14,17 L11,20 Q7,23 4,20 Q1,17 4,14 L7,11"),
    BATTERY("M4,6 H18 Q20,6 20,8 V16 Q20,18 18,18 H4 Q2,18 2,16 V8 Q2,6 4,6 M23,10 V14 M6,10 V14 M10,10 V14"),
    LOCATION("M19,9 Q19,15 12,22 Q5,15 5,9 A7,7 0,1 1,19,9 M15,9 A3,3 0,1 1,9,9 A3,3 0,1 1,15,9"),
    NOTIFICATION("M18,8 A6,6 0,0 0,6,8 Q6,15 3,17 H21 Q18,15 18,8 M9,21 Q12,23 15,21"),
    AUDIO("M11,4 L5,9 H2 V15 H5 L11,20 Z M15,8 Q19,12 15,16 M18,5 Q25,12 18,19"),
    VIBRATION("M9,3 H15 Q16,3 16,4 V20 Q16,21 15,21 H9 Q8,21 8,20 V4 Q8,3 9,3 M5,7 L3,10 L5,13 L3,16 M19,7 L21,10 L19,13 L21,16"),
    APPS("M3,3 H10 V10 H3 Z M14,3 H21 V10 H14 Z M3,14 H10 V21 H3 Z M14,14 H21 V21 H14 Z"),
    FLASHLIGHT("M8,2 H16 V6 L19,10 L15,14 V22 H9 V14 L5,10 L8,6 Z M8,6 H16 M9,14 H15 M11,17 H13"),
    SCREEN("M4,3 H20 Q22,3 22,5 V15 Q22,17 20,17 H4 Q2,17 2,15 V5 Q2,3 4,3 M8,21 H16 M12,17 V21 M8,10 L11,7 L16,12"),
    SCAN("M8,3 H5 Q3,3 3,5 V8 M16,3 H19 Q21,3 21,5 V8 M3,16 V19 Q3,21 5,21 H8 M21,16 V19 Q21,21 19,21 H16 M7,12 Q12,6 17,12 Q12,18 7,12 M12,12 V12.2"),
    TOUCH("M9,12 V4 Q9,1 12,2 Q13,2 13,4 V11 M13,9 Q16,7 17,11 Q20,10 21,13 V17 Q21,22 16,22 H12 Q10,22 8,19 L4,14 Q2,11 5,10 Q6,10 9,14"),
    LOGOUT("M9,3 H5 Q3,3 3,5 V19 Q3,21 5,21 H9 M9,12 H22 M17,7 L22,12 L17,17"),
    DOWNLOAD("M12,3 V15 M7,10 L12,15 L17,10 M4,16 V20 Q4,21 5,21 H19 Q20,21 20,20 V16"),
    BOOK("M12,5 Q8,2 2,4 V20 Q8,18 12,21 Q16,18 22,20 V4 Q16,2 12,5 Z M12,5 V21");

    fun drawable(color: Int) = object : Drawable() {
        private val shape = PathParser.createPathFromPathData(path)!!
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            this.color = color
            style = Paint.Style.STROKE
            strokeWidth = 1.7f
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        override fun draw(canvas: Canvas) {
            canvas.save()
            canvas.translate(bounds.left.toFloat(), bounds.top.toFloat())
            canvas.scale(bounds.width() / 24f, bounds.height() / 24f)
            canvas.drawPath(shape, paint)
            canvas.restore()
        }
        override fun setAlpha(alpha: Int) { paint.alpha = alpha; invalidateSelf() }
        override fun setColorFilter(colorFilter: ColorFilter?) { paint.colorFilter = colorFilter; invalidateSelf() }
        @Suppress("DEPRECATION")
        override fun getOpacity() = PixelFormat.TRANSLUCENT
        override fun getIntrinsicWidth() = 24
        override fun getIntrinsicHeight() = 24
    }
}
