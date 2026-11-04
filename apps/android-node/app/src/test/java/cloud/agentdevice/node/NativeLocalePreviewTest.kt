package cloud.agentdevice.node

import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NativeLocalePreviewTest {
    private fun views(view: View): List<View> = listOf(view) +
        if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()

    @Test fun englishPhoneAndLanguageChoiceRenderNatively() = verify(false)

    @Test
    @Config(qualifiers = "zh-rHK-w411dp-h891dp-xxhdpi")
    fun chineseOutsideMainlandGetsChineseAppNameAndControls() = verify(true)

    private fun verify(chinese: Boolean) {
        val controller = Robolectric.buildActivity(MainActivity::class.java)
        val activity = controller.get()
        MainActivity::class.java.getDeclaredField("authConfig").apply { isAccessible = true }
            .set(activity, JSONObject("""{"githubEnabled":false,"registrationEnabled":true}"""))
        controller.create().start().resume().visible()
        try {
            assertEquals(if (chinese) "ADC 设备云" else "ADC", activity.getString(R.string.app_name))
            val root = activity.window.decorView
            assertTrue(views(root).filterIsInstance<TextView>().any {
                it.text.toString() == if (chinese) "我的 Android 手机" else "My Android phone"
            })
            snapshot(root, "phone-" + if (chinese) "zh" else "en")
            val nav = views(root).filterIsInstance<com.google.android.material.bottomnavigation.BottomNavigationView>().single()
            nav.selectedItemId = R.id.nav_account
            assertTrue(views(root).filterIsInstance<TextView>().any { it.text.toString() == activity.getString(R.string.language) })
            val label = views(root).filterIsInstance<TextView>().first { it.text.toString() == activity.getString(R.string.language) }
            (label.parent.parent as View).performClick()
            val dialog = org.robolectric.shadows.ShadowDialog.getLatestDialog()
            val choices = (dialog as androidx.appcompat.app.AlertDialog).listView.adapter
            assertEquals(3, choices.count)
            assertEquals(if (chinese) "跟随系统" else "Follow system", choices.getItem(0))
            snapshot(dialog.window!!.decorView, "language-" + if (chinese) "zh" else "en", dialog = true)
            dialog.dismiss()
            MainActivity::class.java.getDeclaredMethod("renderDetail", String::class.java).apply { isAccessible = true }
                .invoke(activity, "guide")
            assertFalse(views(root).filterIsInstance<TextView>().any {
                it.text.contains("Xiaomi") || it.text.contains("Redmi") || it.text.contains("小米") || it.text.contains("红米")
            })
        } finally { controller.pause().stop().destroy() }
    }

    private fun snapshot(root: View, name: String, dialog: Boolean = false) {
        val directory = System.getProperty("adc.snapshots", "").orEmpty().takeIf { it.isNotBlank() } ?: return
        shadowOf(Looper.getMainLooper()).idle()
        val view = if (dialog) root else (root as ViewGroup).getChildAt(0)
        val width = (411 * view.resources.displayMetrics.density).toInt()
        val height = (891 * view.resources.displayMetrics.density).toInt()
        view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, if (dialog) View.MeasureSpec.AT_MOST else View.MeasureSpec.EXACTLY))
        view.layout(0, 0, width, view.measuredHeight)
        val bitmap = Bitmap.createBitmap(width, view.measuredHeight, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(MobilePalette(view.context).surface)
        view.draw(canvas)
        File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
