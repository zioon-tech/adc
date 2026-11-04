package cloud.agentdevice.node

import android.app.LocaleManager
import android.app.Notification
import android.content.Intent
import android.os.Bundle
import android.os.Looper
import android.os.LocaleList
import android.view.View
import android.view.ViewGroup
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import com.google.android.material.bottomnavigation.BottomNavigationView
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-w411dp-h891dp-xxhdpi")
class NavigationLanguageTest {
    private class Sessions(var current: AccountSession? = AccountSession("https://adc.zioon.tech", "first",
        JSONObject("""{"account":{"accountId":"account"},"user":{"name":"Person"}}"""))) : AccountSessionStore {
        override fun origin() = current?.origin ?: "https://adc.zioon.tech"
        override fun setOrigin(origin: String) {}
        override fun session() = current
        override fun save(session: AccountSession) { current = session }
        override fun clear() { current = null }
    }
    private fun node(label: String = "Computer", revision: Int = 1) = JSONObject("""
        {"nodeId":"node","accountId":"account","label":"$label","platform":"linux","online":true,
        "status":"active","revision":$revision,"description":"","accessPolicy":{"maxConcurrency":6,
        "allowExecution":true,"rootAccess":"all","rootIds":[],"readOnlyRootIds":[]}}
    """)
    private fun views(view: View): List<View> = listOf(view) +
        if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()
    private fun field(activity: MainActivity, name: String): Any? =
        MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.get(activity)
    private fun set(activity: MainActivity, name: String, value: Any) =
        MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.set(activity, value)
    private fun call(activity: MainActivity, name: String) =
        MainActivity::class.java.getDeclaredMethod(name).apply { isAccessible = true }.invoke(activity)
    private fun create() = Robolectric.buildActivity(MainActivity::class.java).also {
        // Robolectric does not automatically grant the merged library's signature permission on API 28.
        shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(
            "cloud.agentdevice.node.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
        set(it.get(), "authConfig", JSONObject("""{"githubEnabled":false,"registrationEnabled":true}"""))
        it.create().start().resume().visible()
    }
    private fun await(condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (!condition() && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.yield()
        }
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue("Background refresh did not settle", condition())
    }
    private fun prime(activity: MainActivity, fetch: (AccountSession) -> List<JSONObject>) {
        set(activity, "accounts", Sessions())
        set(activity, "devices", listOf(node()))
        set(activity, "loadedDevices", true)
        set(activity, "fetchDevices", fetch)
        (field(activity, "nav") as BottomNavigationView).selectedItemId = R.id.nav_devices
        shadowOf(Looper.getMainLooper()).idle()
    }

    @Test fun delayedRefreshKeepsCachedPageOpaqueAndNavigationAvailable() {
        val controller = create()
        val activity = controller.get()
        val gate = CountDownLatch(1)
        val entered = CountDownLatch(1)
        val requests = AtomicInteger()
        try {
            prime(activity) { requests.incrementAndGet(); entered.countDown(); gate.await(); listOf(node()) }
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            val page = field(activity, "page") as ViewGroup
            assertEquals(1f, page.alpha)
            assertEquals(0f, page.translationY)
            assertFalse(field(activity, "busy") as Boolean)
            assertTrue(views(page).filterIsInstance<TextView>().any { it.text.toString() == "Computer" })
            call(activity, "refreshDevices")
            assertEquals(1, requests.get())
            (field(activity, "nav") as BottomNavigationView).selectedItemId = R.id.nav_phone
            assertEquals(2, field(activity, "tab"))
            assertEquals(1f, page.alpha)
            assertEquals(View.INVISIBLE, (field(activity, "progress") as View).visibility)
            gate.countDown()
            await { field(activity, "devicesRefreshing") == false }
            assertEquals(2, field(activity, "tab"))
        } finally { gate.countDown(); controller.pause().stop().destroy() }
    }

    @Test fun identicalVisibleResultKeepsRowsButRefreshesRevisionUsedByEditor() {
        val controller = create()
        val activity = controller.get()
        val gate = CountDownLatch(1)
        try {
            prime(activity) { gate.await(); listOf(node(revision = 9)) }
            val page = field(activity, "page") as ViewGroup
            val original = page.getChildAt(0)
            gate.countDown()
            await { field(activity, "devicesRefreshing") == false }
            assertSame(original, page.getChildAt(0))
            val rowLabel = views(page).filterIsInstance<TextView>().first { it.text.toString() == "Computer" }
            (rowLabel.parent.parent as View).performClick()
            assertEquals(9, (field(activity, "selectedDevice") as JSONObject).getInt("revision"))
        } finally { gate.countDown(); controller.pause().stop().destroy() }
    }

    @Test fun refreshNeverOverwritesAnOpenDeviceDraft() {
        val controller = create()
        val activity = controller.get()
        val gate = CountDownLatch(1)
        try {
            prime(activity) { gate.await(); listOf(node("Renamed remotely", 2)) }
            val page = field(activity, "page") as ViewGroup
            val rowLabel = views(page).filterIsInstance<TextView>().first { it.text.toString() == "Computer" }
            (rowLabel.parent.parent as View).performClick()
            val name = field(activity, "deviceName") as com.google.android.material.textfield.TextInputEditText
            name.setText("My unsaved name")
            gate.countDown()
            await { field(activity, "devicesRefreshing") == false }
            assertTrue(field(activity, "showingDevice") as Boolean)
            assertSame(name, field(activity, "deviceName"))
            assertEquals("My unsaved name", name.text.toString())
            activity.onBackPressedDispatcher.onBackPressed()
            assertTrue(views(page).filterIsInstance<TextView>().any { it.text.toString() == "Renamed remotely" })
        } finally { gate.countDown(); controller.pause().stop().destroy() }
    }

    @Test fun supersededAccountResponseCannotClearNewSessionOrReplaceItsDevices() {
        val controller = create()
        val activity = controller.get()
        val gate = CountDownLatch(1)
        val finished = CountDownLatch(1)
        try {
            prime(activity) {
                try { gate.await(); throw AccountApiException(401, "expired", "expired") }
                finally { finished.countDown() }
            }
            val sessions = field(activity, "accounts") as Sessions
            sessions.current = sessions.current!!.copy(origin = "https://other.example", token = "new")
            set(activity, "fetchDevices", { _: AccountSession -> listOf(node("New account device")) })
            call(activity, "refreshDevices")
            await { field(activity, "devicesRefreshing") == false }
            gate.countDown()
            assertTrue(finished.await(5, TimeUnit.SECONDS))
            await { (field(activity, "devices") as List<*>).first().toString().contains("New account device") }
            assertEquals("new", sessions.session()!!.token)
        } finally { gate.countDown(); controller.pause().stop().destroy() }
    }

    @Test fun eachTabRestoresItsOwnScrollAndReselectionDoesNotRebuild() {
        val controller = create()
        val activity = controller.get()
        try {
            val nav = field(activity, "nav") as BottomNavigationView
            val scroll = field(activity, "scroll") as ScrollView
            nav.selectedItemId = R.id.nav_account
            shadowOf(Looper.getMainLooper()).idle()
            scroll.scrollTo(0, 130)
            val accountOffset = scroll.scrollY
            assertTrue(accountOffset > 0)
            nav.selectedItemId = R.id.nav_phone
            nav.selectedItemId = R.id.nav_account
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(accountOffset, scroll.scrollY)
            val page = field(activity, "page") as ViewGroup
            val first = page.getChildAt(0)
            nav.selectedItemId = R.id.nav_account
            assertSame(first, page.getChildAt(0))
        } finally { controller.pause().stop().destroy() }
    }

    @Test fun failedRefreshRetainsCachedRowsAndFirstLoadOffersRetry() {
        val controller = create()
        val activity = controller.get()
        try {
            prime(activity) { throw java.io.IOException("connection failed") }
            await { field(activity, "devicesRefreshing") == false }
            val page = field(activity, "page") as ViewGroup
            assertTrue(views(page).filterIsInstance<TextView>().any { it.text.toString() == "Computer" })
            set(activity, "loadedDevices", false)
            set(activity, "devices", emptyList<JSONObject>())
            call(activity, "refreshDevices")
            await { field(activity, "devicesRefreshing") == false }
            assertTrue(views(page).filterIsInstance<TextView>().any { it.text.toString() == "Try again" })
            assertFalse(field(activity, "busy") as Boolean)
        } finally { controller.pause().stop().destroy() }
    }

    @Test fun androidSystemAppLanguageIsAuthoritativeAndServiceUsesItWithoutStartingNode() {
        val context = RuntimeEnvironment.getApplication()
        val manager = context.getSystemService(LocaleManager::class.java)
        manager.applicationLocales = LocaleList.forLanguageTags("zh-HK")
        assertEquals(AppLanguage.CHINESE, AppLanguage.selected(context))
        assertEquals("ADC 设备云", AppLanguage.localizedContext(context).getString(R.string.app_name))
        val controller = Robolectric.buildService(NodeService::class.java).create()
        try {
            val service = controller.get()
            val notification = NodeService::class.java.getDeclaredMethod("serviceNotification", String::class.java)
                .apply { isAccessible = true }.invoke(service, "status") as Notification
            assertEquals("手机 Node 正在运行", notification.extras.getString(Notification.EXTRA_TITLE))
            assertFalse(NodeService.isActive())
            assertFalse(NodeStore(context).isNodeDesired())
            manager.applicationLocales = LocaleList.forLanguageTags("en")
            context.sendBroadcast(Intent(AppLanguage.ACTION_CHANGED).setPackage(context.packageName))
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals("ADC", AppLanguage.localizedContext(context).getString(R.string.app_name))
            assertFalse(NodeService.isActive())
        } finally { controller.destroy(); manager.applicationLocales = LocaleList.getEmptyLocaleList() }
    }

    @Test
    @Config(sdk = [28], qualifiers = "en-w411dp-h891dp-xxhdpi")
    fun manualLanguagePersistsOnOlderAndroidAndCanReturnToSystem() {
        val controller = create()
        val activity = controller.get()
        try {
            AppLanguage.select(activity, AppLanguage.CHINESE)
            assertEquals(AppLanguage.CHINESE, AppLanguage.selected(activity))
            assertEquals("ADC 设备云", AppLanguage.localizedContext(activity).getString(R.string.app_name))
            assertFalse(NodeStore(activity).isNodeDesired())
            AppLanguage.select(activity, AppLanguage.ENGLISH)
            assertEquals("ADC", AppLanguage.localizedContext(activity).getString(R.string.app_name))
            AppLanguage.select(activity, AppLanguage.SYSTEM)
            assertEquals(AppLanguage.SYSTEM, AppLanguage.selected(activity))
        } finally {
            activity.getSharedPreferences("adc_language", 0).edit().clear().commit()
            AppCompatDelegate.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
            controller.pause().stop().destroy()
        }
    }

    @Test fun chineseReleaseNotesCoverChineseRegionsAndScripts() {
        val release = AndroidRelease("1", 1, 26, java.time.Instant.EPOCH, false,
            mapOf("zh-CN" to "中文说明", "en" to "English notes"), "app",
            java.net.URI("https://example.test/app.apk"), "", 1, "")
        listOf("zh", "zh-Hans", "zh-HK", "zh-TW").forEach {
            assertEquals("中文说明", release.notesFor(java.util.Locale.forLanguageTag(it)))
        }
        assertEquals("English notes", release.notesFor(java.util.Locale.GERMAN))
    }
}
