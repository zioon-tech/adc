package cloud.agentdevice.node

import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.appcompat.view.ContextThemeWrapper
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputLayout
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.concurrent.TimeUnit

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "zh-rCN-w411dp-h891dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NativeFormsTest {
    private fun descendants(view: View): List<View> = listOf(view) +
        if (view is ViewGroup) (0 until view.childCount).flatMap { descendants(view.getChildAt(it)) } else emptyList()

    @Test fun fieldUsesOneMaterialBoxWithInlineErrorsAndPasswordToggle() {
        val context = ContextThemeWrapper(RuntimeEnvironment.getApplication(), R.style.Theme_AgentDeviceCloud)
        val field = MobileFormField(context, "密码", type = android.text.InputType.TYPE_CLASS_TEXT or
            android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD)
        assertEquals(TextInputLayout.BOX_BACKGROUND_OUTLINE, field.box.boxBackgroundMode)
        assertFalse(field.box.isHintEnabled)
        assertEquals(TextInputLayout.END_ICON_PASSWORD_TOGGLE, field.box.endIconMode)
        assertTrue(field.input.background is com.google.android.material.shape.MaterialShapeDrawable ||
            field.input.background is android.graphics.drawable.RippleDrawable)
        assertFalse(field.input.isSaveEnabled)
        field.showError("请输入密码。")
        assertEquals("请输入密码。", field.box.error)
        field.input.setText("typed password")
        assertNull(field.box.error)
    }

    @Test fun registrationRecoveryAndGuideRemainNativeAndDoNotPersistPasswords() {
        java.util.Locale.setDefault(java.util.Locale.SIMPLIFIED_CHINESE)
        val controller = Robolectric.buildActivity(MainActivity::class.java)
        val activity = controller.get()
        MainActivity::class.java.getDeclaredField("authConfig").apply { isAccessible = true }.set(activity,
            JSONObject("""{"githubEnabled":true,"registrationEnabled":true,"passwordResetEnabled":true}"""))
        controller.create().start().resume().visible()
        try {
            val root = activity.window.decorView
            descendants(root).filterIsInstance<BottomNavigationView>().single().selectedItemId = R.id.nav_account
            shadowOf(android.os.Looper.getMainLooper()).idleFor(1, TimeUnit.SECONDS)
            fun fields() = descendants(root).filterIsInstance<MobileFormField>()
            fun tap(value: String) = descendants(root).filterIsInstance<MaterialButton>()
                .first { it.text.toString() == value }.performClick()
            assertEquals(2, fields().size)
            snapshot(root, "login-native")
            fields()[0].input.setText("person@example.test")
            tap("登录")
            assertEquals("请输入密码。", fields()[1].box.error)
            assertNull(shadowOf(activity).nextStartedActivity)
            tap("还没有账号？注册账号")
            assertEquals(3, fields().size)
            assertEquals("person@example.test", fields()[1].input.text.toString())
            snapshot(root, "register-native")
            activity.onBackPressedDispatcher.onBackPressed()
            assertEquals(2, fields().size)
            tap("忘记密码？")
            assertEquals(1, fields().size)
            snapshot(root, "recovery-native")
            assertNull(shadowOf(activity).nextStartedActivity)
            activity.onBackPressedDispatcher.onBackPressed()
            descendants(root).filterIsInstance<TextView>().first { it.text.toString() == "使用指南" }.parent
                .let { (it.parent as View).performClick() }
            assertTrue(descendants(root).filterIsInstance<TextView>().any { it.text.toString() == "1. 接入手机" })
            assertNull(shadowOf(activity).nextStartedActivity)
            snapshot(root, "guide-native")
            activity.onBackPressedDispatcher.onBackPressed()
            fields()[1].input.setText("do-not-persist-this-password")
            val state = Bundle()
            controller.saveInstanceState(state)
            assertFalse(state.toString().contains("do-not-persist-this-password"))
        } finally {
            controller.pause().stop().destroy()
        }
    }
    @Test
    @Config(sdk = [35], qualifiers = "zh-rCN-w411dp-h891dp-night-xxhdpi")
    fun darkLoginKeepsTheSharedFieldTreatment() {
        java.util.Locale.setDefault(java.util.Locale.SIMPLIFIED_CHINESE)
        val controller = Robolectric.buildActivity(MainActivity::class.java)
        val activity = controller.get()
        MainActivity::class.java.getDeclaredField("authConfig").apply { isAccessible = true }.set(activity,
            JSONObject("""{"githubEnabled":true,"registrationEnabled":true,"passwordResetEnabled":true}"""))
        controller.create().start().resume().visible()
        try {
            val root = activity.window.decorView
            descendants(root).filterIsInstance<BottomNavigationView>().single().selectedItemId = R.id.nav_account
            val fields = descendants(root).filterIsInstance<MobileFormField>()
            assertEquals(2, fields.size)
            assertTrue(MobilePalette(activity).dark)
            assertEquals(MobilePalette(activity).ink, fields[0].input.currentTextColor)
            snapshot(root, "login-dark-native")
        } finally { controller.pause().stop().destroy() }
    }
    @Test fun invalidServiceAddressStaysInTheNativeDialogWithAnInlineError() {
        java.util.Locale.setDefault(java.util.Locale.SIMPLIFIED_CHINESE)
        val controller = Robolectric.buildActivity(MainActivity::class.java)
        val activity = controller.get()
        MainActivity::class.java.getDeclaredField("authConfig").apply { isAccessible = true }.set(activity,
            JSONObject("""{"githubEnabled":false,"registrationEnabled":true,"passwordResetEnabled":true}"""))
        controller.create().start().resume().visible()
        try {
            val root = activity.window.decorView
            descendants(root).filterIsInstance<BottomNavigationView>().single().selectedItemId = R.id.nav_account
            val label = descendants(root).filterIsInstance<TextView>().first { it.text.toString() == "服务地址" }
            (label.parent.parent as View).performClick()
            val dialog = org.robolectric.shadows.ShadowDialog.getLatestDialog() as androidx.appcompat.app.AlertDialog
            shadowOf(android.os.Looper.getMainLooper()).idle()
            val field = descendants(dialog.window!!.decorView).filterIsInstance<MobileFormField>().single()
            field.input.setText("http://example.test/private")
            dialog.getButton(androidx.appcompat.app.AlertDialog.BUTTON_POSITIVE).performClick()
            assertTrue(dialog.isShowing)
            assertEquals("请输入不含路径的 HTTPS 地址。", field.box.error)
            assertEquals("https://adc.zioon.tech", AccountStore(activity).origin())
            assertNull(shadowOf(activity).nextStartedActivity)
            dialog.dismiss()
        } finally { controller.pause().stop().destroy() }
    }
    @Test fun restoringAnAccountFormKeepsEmailButNeverPassword() {
        java.util.Locale.setDefault(java.util.Locale.SIMPLIFIED_CHINESE)
        val state = Bundle().apply {
            putInt("tab", 3)
            putString("authPage", "register")
            putString("authEmail", "restored@example.test")
            putString("authName", "Restored person")
        }
        val controller = Robolectric.buildActivity(MainActivity::class.java)
        val activity = controller.get()
        MainActivity::class.java.getDeclaredField("authConfig").apply { isAccessible = true }.set(activity,
            JSONObject("""{"githubEnabled":true,"registrationEnabled":true,"passwordResetEnabled":true}"""))
        controller.create(state).start().resume().visible()
        try {
            val fields = descendants(activity.window.decorView).filterIsInstance<MobileFormField>()
            assertEquals(3, fields.size)
            assertEquals("Restored person", fields[0].input.text.toString())
            assertEquals("restored@example.test", fields[1].input.text.toString())
            assertEquals("", fields[2].input.text.toString())
        } finally { controller.pause().stop().destroy() }
    }
    private fun snapshot(root: View, name: String) {
        val directory = System.getProperty("adc.snapshots", "").orEmpty().takeIf { it.isNotBlank() } ?: return
        shadowOf(android.os.Looper.getMainLooper()).idleFor(1, TimeUnit.SECONDS)
        val view = (root as ViewGroup).getChildAt(0)
        val width = (411 * view.resources.displayMetrics.density).toInt()
        val height = (891 * view.resources.displayMetrics.density).toInt()
        view.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
        view.layout(0, 0, width, height)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(directory, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
