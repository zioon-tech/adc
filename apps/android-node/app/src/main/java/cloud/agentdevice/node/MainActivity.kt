package cloud.agentdevice.node

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.ClipData
import android.content.ClipboardManager
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.LinearLayout
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.activity.addCallback
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.Locale
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var store: NodeStore
    private lateinit var accounts: AccountStore
    private lateinit var registry: CapabilityRegistry
    private lateinit var updater: AndroidUpdateManager
    private lateinit var page: LinearLayout
    private lateinit var scroll: ScrollView
    private lateinit var title: TextView
    private lateinit var message: TextView
    private lateinit var progress: ProgressBar
    private lateinit var nav: BottomNavigationView
    private lateinit var toolbarBack: ImageButton
    private lateinit var toolbarAction: ImageButton
    private var tab = 2
    private var busy = false
    private var devices = emptyList<JSONObject>()
    private var loadedDevices = false
    private var deviceFilter = 0
    private var rowContainer: LinearLayout? = null
    private var phoneStatus: TextView? = null
    private var nodeButton: MaterialButton? = null
    private var pendingGroup: CapabilityGroup? = null
    private var pendingApk: File? = null
    private var browserCode: String? = null
    private var browserDeadline = 0L
    private var browserInterval = 2_000L
    private var browserOrigin: String? = null
    private var showingPermissions = false
    private var showingDevice = false
    private var selectedDevice: JSONObject? = null
    private var editingPolicy: JSONObject? = null
    private var deviceName: TextInputEditText? = null
    private var deviceDescription: TextInputEditText? = null
    private var deviceConcurrency: TextInputEditText? = null
    private var detailPage: String? = null
    private var authPage = "login"
    private var authEmail = ""
    private var authName = ""
    private var authEmailInput: TextInputEditText? = null
    private var authNameInput: TextInputEditText? = null
    private var authConfig: JSONObject? = null
    private var authConfigRequested = false
    private var recoveryLink: AccountRecoveryLink? = null
    private val formInputs = mutableListOf<TextInputEditText>()
    private var verificationResendAt = 0L
    private val chinese get() = Locale.getDefault().language == "zh"
    private val palette by lazy { MobilePalette(this) }
    private val ink get() = palette.ink
    private val muted get() = palette.muted
    private val green get() = palette.accent
    private val line get() = palette.line
    private fun text(en: String, zh: String) = if (chinese) zh else en

    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        pendingGroup?.let { group ->
            val allowed = when (group) {
                CapabilityGroup.LOCATION -> has(Manifest.permission.ACCESS_COARSE_LOCATION) || has(Manifest.permission.ACCESS_FINE_LOCATION)
                CapabilityGroup.FLASHLIGHT -> has(Manifest.permission.CAMERA)
                CapabilityGroup.NOTIFICATIONS -> Build.VERSION.SDK_INT < 33 || has(Manifest.permission.POST_NOTIFICATIONS)
                else -> true
            }
            store.setCapabilityEnabled(group, allowed)
        }
        pendingGroup = null
        renderPermissions()
    }
    private val capture = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val granted = result.resultCode == RESULT_OK && result.data != null && store.isNodeDesired()
        store.setCapabilityEnabled(CapabilityGroup.SCREEN_CAPTURE, granted)
        if (granted) {
            try { NodeService.startScreenCapture(this, result.resultCode, result.data!!) }
            catch (error: Exception) { store.setCapabilityEnabled(CapabilityGroup.SCREEN_CAPTURE, false); error(error) }
        } else NodeService.stopScreenCapture(this)
        renderPermissions()
    }
    private val installer = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        pendingApk?.let { apk ->
            if (updater.canRequestPackageInstalls()) {
                pendingApk = null
                try { updater.launchInstaller(apk) } catch (error: Exception) { error(error) }
            } else notice(text("Allow installation in Android settings, then check again.", "请在系统设置允许安装后，再次检查更新。"))
        }
    }
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            updatePhoneStatus()
            if (intent?.action == ScreenCaptureSession.ACTION_CAPABILITY_CHANGED && showingPermissions) renderPermissions()
        }
    }
    private val browserPoll = object : Runnable {
        override fun run() {
            val code = browserCode ?: return
            val origin = browserOrigin ?: return
            if (System.currentTimeMillis() >= browserDeadline) {
                cancelBrowserLogin()
                notice(text("Login expired. Try again.", "登录已过期，请重试。"))
                return
            }
            executor.execute {
                try {
                    val session = AccountApi(origin).pollBrowserLogin(code)
                    runOnUiThread {
                        if (browserCode != code || isDestroyed) return@runOnUiThread
                        cancelBrowserLogin()
                        signedIn(session)
                    }
                } catch (error: Exception) {
                    runOnUiThread {
                        if (browserCode != code || isDestroyed) return@runOnUiThread
                        if (error is AccountApiException && error.code == "slow_down") browserInterval += 5_000
                        if (error is AccountApiException && error.code !in listOf("authorization_pending", "slow_down")) {
                            cancelBrowserLogin()
                            error(error)
                        } else handler.postDelayed(this, browserInterval)
                    }
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = NodeStore(this)
        store.migrateOfficialOrigin()
        if (store.isNodeDesired() && !NodeService.isActive()) store.setRuntimeState("interrupted")
        accounts = AccountStore(this)
        registry = CapabilityRegistry(this)
        updater = AndroidUpdateManager(this)
        tab = savedInstanceState?.getInt("tab", if (accounts.session() == null) 2 else 1)
            ?: if (accounts.session() == null) 2 else 1
        authEmail = savedInstanceState?.getString("authEmail").orEmpty()
        authName = savedInstanceState?.getString("authName").orEmpty()
        authPage = savedInstanceState?.getString("authPage") ?: "login"
        setContentView(buildRoot())
        onBackPressedDispatcher.addCallback(this) {
            if (showingPermissions || showingDevice || detailPage != null || authPage != "login") goBack()
            else { isEnabled = false; onBackPressedDispatcher.onBackPressed(); isEnabled = true }
        }
        ContextCompat.registerReceiver(this, receiver, IntentFilter().apply {
            addAction(NodeService.ACTION_STATUS)
            addAction(ScreenCaptureSession.ACTION_CAPABILITY_CHANGED)
        }, ContextCompat.RECEIVER_NOT_EXPORTED)
        render()
        if (savedInstanceState?.getBoolean("permissions") == true) renderPermissions()
        else savedInstanceState?.getString("device")?.let { draft ->
            runCatching { renderDevice(JSONObject(draft)) }
        }
        savedInstanceState?.getString("detailPage")?.let { renderDetail(it) }
        if (savedInstanceState == null || authPage == "reset") handleAccountLink(intent)
        val offset = savedInstanceState?.getInt("scroll", 0) ?: 0
        scroll.post { scroll.scrollTo(0, offset) }
    }
    override fun onResume() {
        super.onResume()
        AppVisibility.setForeground(true)
        if (!::store.isInitialized) return
        updatePhoneStatus()
        if (showingPermissions) renderPermissions()
        if (tab == 1 && !showingDevice && detailPage == null && accounts.session() != null && !busy) refreshDevices()
    }
    override fun onPause() { AppVisibility.setForeground(false); super.onPause() }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putInt("tab", tab)
        outState.putBoolean("permissions", showingPermissions)
        outState.putInt("scroll", scroll.scrollY)
        captureAuthDraft()
        outState.putString("authPage", authPage)
        outState.putString("authEmail", authEmail)
        outState.putString("authName", authName)
        outState.putString("detailPage", detailPage)
        if (showingDevice) selectedDevice?.let { node ->
            val draft = JSONObject(node.toString())
            draft.put("label", deviceName?.text?.toString() ?: node.optString("label"))
            draft.put("description", deviceDescription?.text?.toString() ?: node.optString("description"))
            draft.put("_concurrencyInput", deviceConcurrency?.text?.toString())
            editingPolicy?.let { policy ->
                val copy = JSONObject(policy.toString())
                deviceConcurrency?.text?.toString()?.toIntOrNull()?.let { copy.put("maxConcurrency", it) }
                draft.put("accessPolicy", copy)
            }
            outState.putString("device", draft.toString())
        }
        super.onSaveInstanceState(outState)
    }
    override fun onDestroy() {
        cancelBrowserLogin()
        unregisterReceiver(receiver)
        registry.close()
        executor.shutdownNow()
        super.onDestroy()
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleAccountLink(intent)
    }

    private fun buildRoot(): View {
        @Suppress("DEPRECATION")
        window.statusBarColor = palette.canvas
        @Suppress("DEPRECATION")
        window.navigationBarColor = if (Build.VERSION.SDK_INT < 27) Color.parseColor("#17231D") else palette.canvas
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = !palette.dark
            isAppearanceLightNavigationBars = !palette.dark
        }
        val root = column().apply { setBackgroundColor(palette.canvas) }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.setPadding(0, bars.top, 0, bars.bottom)
            if (::nav.isInitialized) nav.visibility = if (insets.isVisible(WindowInsetsCompat.Type.ime())) View.GONE else View.VISIBLE
            insets
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(4), dp(12), dp(4))
        }
        toolbarBack = iconButton(MobileGlyph.BACK, text("Back", "返回")) { goBack() }
        header.addView(toolbarBack)
        title = label("", 24, ink, true).apply { setPadding(dp(8), 0, 0, 0) }
        header.addView(title, LinearLayout.LayoutParams(0, -2, 1f))
        toolbarAction = iconButton(MobileGlyph.REFRESH, text("Refresh devices", "刷新设备")) { refreshDevices() }
        header.addView(toolbarAction)
        root.addView(header, LinearLayout.LayoutParams(-1, dp(64)))
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            isIndeterminate = true; visibility = View.GONE; indeterminateTintList = ColorStateList.valueOf(green)
        }
        root.addView(progress, LinearLayout.LayoutParams(-1, dp(2)))
        message = label("", 13, green).apply {
            setPadding(dp(24), dp(10), dp(24), dp(10)); visibility = View.GONE
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        root.addView(message)
        scroll = ScrollView(this).apply {
            isFillViewport = true; clipToPadding = false
            // Restore only the offset belonging to the restored native page.
            isSaveEnabled = false
        }
        page = column().apply { setPadding(dp(20), dp(8), dp(20), dp(28)) }
        scroll.addView(page, FrameLayout.LayoutParams(
            if (resources.configuration.screenWidthDp > 600) dp(600) else -1, -2, Gravity.CENTER_HORIZONTAL))
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        nav = BottomNavigationView(this).apply {
            setBackgroundColor(palette.canvas); elevation = 0f
            isItemActiveIndicatorEnabled = true
            itemActiveIndicatorColor = ColorStateList.valueOf(palette.tonal)
            itemIconSize = dp(24)
            itemIconTintList = ColorStateList(arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()),
                intArrayOf(green, muted))
            itemTextColor = itemIconTintList
            menu.add(0, R.id.nav_devices, 0, text("Devices", "设备")).icon = MobileGlyph.DEVICES.drawable(ink)
            menu.add(0, R.id.nav_phone, 1, text("This phone", "此手机")).icon = MobileGlyph.PHONE.drawable(ink)
            menu.add(0, R.id.nav_account, 2, text("Account", "我的")).icon = MobileGlyph.ACCOUNT.drawable(ink)
            selectedItemId = when (tab) { 1 -> R.id.nav_devices; 2 -> R.id.nav_phone; else -> R.id.nav_account }
            setOnItemSelectedListener {
                if (busy) return@setOnItemSelectedListener false
                tab = when (it.itemId) { R.id.nav_devices -> 1; R.id.nav_phone -> 2; else -> 3 }
                captureAuthDraft()
                detailPage = null; authPage = "login"
                showingPermissions = false; showingDevice = false
                message.visibility = View.GONE
                phoneStatus = null; render()
                if (tab == 1 && accounts.session() != null) refreshDevices()
                true
            }
        }
        root.addView(nav)
        return root
    }

    private fun render() {
        if (!::page.isInitialized) return
        clearPage(); phoneStatus = null; nodeButton = null; showingPermissions = false; showingDevice = false
        detailPage = null
        selectedDevice = null; editingPolicy = null; deviceName = null; deviceDescription = null; deviceConcurrency = null
        toolbar(when (tab) { 1 -> text("Devices", "设备"); 2 -> text("This phone", "此手机"); else -> text("Account", "我的") })
        when (tab) { 1 -> renderDevices(); 2 -> renderPhone(); else -> renderAccount() }
    }

    private fun renderDevices() {
        val session = accounts.session()
        if (session == null) {
            emptyState(MobileGlyph.DEVICES, text("Your devices", "你的设备"),
                text("Sign in to manage your computers and phones.", "登录后即可查看和管理电脑与手机。"))
            action(text("Sign in", "登录账号")) { tab = 3; nav.selectedItemId = R.id.nav_account }
            return
        }
        val summary = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(4), dp(8), dp(4), dp(20))
        }
        summary.addView(column().apply {
            addView(label(if (loadedDevices) text("${devices.size} devices", "${devices.size} 台设备")
                else text("Your devices", "你的设备"), 27, ink, true))
            addView(label(if (loadedDevices) text("${devices.count { it.optBoolean("online") }} online",
                "${devices.count { it.optBoolean("online") }} 台在线") else text("Syncing…", "正在同步…"), 14, muted)
                .apply { setPadding(0, dp(6), 0, 0) })
        }, LinearLayout.LayoutParams(0, -2, 1f))
        summary.addView(iconButton(MobileGlyph.PLUS, text("Connect this phone", "接入此手机")) {
            tab = 2; nav.selectedItemId = R.id.nav_phone
        }.apply { background = ripple(palette.tonal, 18); setImageDrawable(MobileGlyph.PLUS.drawable(green)) })
        page.addView(summary)
        if (devices.isEmpty()) {
            emptyState(MobileGlyph.PHONE,
                text(if (loadedDevices) "Connect a device" else "Loading devices",
                    if (loadedDevices) "接入一台设备" else "正在加载设备"),
                text("Connect this phone or follow the computer setup guide.",
                    "可接入此手机，也可按指南接入电脑。"))
        } else {
            val filters = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; setPadding(0, 0, 0, dp(16))
            }
            listOf(text("All", "全部"), text("Online", "在线"), text("Offline", "离线")).forEachIndexed { index, value ->
                filters.addView(MaterialButton(this, null, com.google.android.material.R.attr.borderlessButtonStyle).apply {
                    this.text = value; textSize = 13f; isAllCaps = false
                    cornerRadius = dp(18); minHeight = dp(40); minimumHeight = dp(40)
                    insetTop = 0; insetBottom = 0
                    setTextColor(if (deviceFilter == index) green else muted)
                    backgroundTintList = ColorStateList.valueOf(if (deviceFilter == index) palette.tonal else Color.TRANSPARENT)
                    setOnClickListener { if (!busy) { deviceFilter = index; clearPage(); renderDevices(); animatePage() } }
                }, LinearLayout.LayoutParams(0, dp(40), 1f).apply { if (index > 0) marginStart = dp(8) })
            }
            page.addView(filters)
            val filtered = devices.filter {
                deviceFilter == 0 || (deviceFilter == 1 && it.optBoolean("online")) ||
                    (deviceFilter == 2 && !it.optBoolean("online"))
            }
            if (filtered.isEmpty()) caption(text("No devices in this view.", "暂无符合条件的设备。"))
            settingsGroup {
                filtered.forEach { node ->
                    val current = store.config()?.let { it.controlPlaneUrl == session.origin && it.nodeId == node.optString("nodeId") } == true
                    val online = node.optBoolean("online")
                    val active = node.optString("status") == "active"
                    val state = if (!active) text("Revoked", "已撤销") else if (online) text("Online", "在线") else text("Offline", "离线")
                    val mobile = node.optString("platform").lowercase() in setOf("android", "ios")
                    row(node.optString("label").ifBlank { text("Unnamed device", "未命名设备") },
                        node.optString("platform").replaceFirstChar { it.uppercase() } +
                            if (current) text(" · This phone", " · 此手机") else "",
                        state, if (mobile) MobileGlyph.PHONE else MobileGlyph.COMPUTER,
                        if (active && online) green else muted) { renderDevice(node) }
                }
            }
        }
        space(16)
        settingsGroup {
            row(text("Add a computer", "接入电脑"), text("Installation and pairing instructions", "查看安装与配对步骤"), "›", MobileGlyph.COMPUTER) {
                renderDetail("computer")
            }
        }
    }

    private fun refreshDevices() {
        val session = accounts.session() ?: return
        work({ AccountApi(session.origin, session.token).devices() }) { result ->
            if (accounts.session()?.token != session.token) return@work
            devices = result; loadedDevices = true
            store.config()?.let { config ->
                if (config.controlPlaneUrl == session.origin) result.find {
                    it.optString("nodeId") == config.nodeId && it.optString("accountId") == config.accountId
                }?.let { node ->
                    store.saveConfig(config.copy(label = node.getString("label")))
                    if (node.optString("status") != "active") NodeService.stop(this)
                }
            }
            if (tab == 1 || (tab == 2 && !showingDevice && !showingPermissions)) render()
        }
    }

    private fun renderDevice(node: JSONObject) {
        showingDevice = true; showingPermissions = false; phoneStatus = null; clearPage()
        selectedDevice = node
        toolbar(text("Device settings", "设备设置"), true)
        lead(node.optString("label"), text("Changes apply to this device.", "修改仅应用于这台设备。"))
        val name = field(text("Device name", "设备名称"), node.optString("label"))
        val description = field(text("Description", "备注"), node.optString("description"),
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE, maxLength = 500, multiline = true)
        deviceName = name; deviceDescription = description
        caption(node.optString("platform").replaceFirstChar { it.uppercase() })
        val policy = JSONObject(node.getJSONObject("accessPolicy").toString())
        editingPolicy = policy
        section(text("Account access", "账号访问策略"))
        caption(text("These settings limit existing local permissions. The device keeps the final say.",
            "这些设置约束设备已共享的能力，手机本地权限仍拥有最终决定权。"))
        toggle(text("Allow execution", "允许执行操作"), text("Includes app actions and commands.", "包括应用操作和命令执行。"),
            policy.optBoolean("allowExecution")) { policy.put("allowExecution", it) }
        val concurrency = field(text("Concurrent tasks (1–32)", "同时执行任务数（1–32）"),
            node.optString("_concurrencyInput", policy.optInt("maxConcurrency", 6).toString()), InputType.TYPE_CLASS_NUMBER)
        deviceConcurrency = concurrency
        val roots = node.optJSONObject("capability")?.optJSONArray("roots") ?: JSONArray()
        if (roots.length() > 0) {
            section(text("Shared folders", "共享文件夹"))
            val all = localSwitch().apply {
                text = this@MainActivity.text("All locally shared folders", "全部本地共享文件夹")
                isChecked = policy.optString("rootAccess") == "all"; minHeight = dp(52)
            }
            page.addView(all)
            val rootRows = column(); page.addView(rootRows)
            fun drawRoots() {
                rootRows.removeAllViews()
                for (index in 0 until roots.length()) {
                    val root = roots.getJSONObject(index)
                    val id = root.getString("rootId")
                    val chosen = policy.getJSONArray("rootIds")
                    val readOnly = policy.getJSONArray("readOnlyRootIds")
                    val allowed = all.isChecked || contains(chosen, id)
                    val row = column().apply { setPadding(0, dp(8), 0, dp(8)) }
                    val share = localSwitch().apply {
                        text = root.optString("label", root.optString("path", id))
                        isChecked = allowed; isEnabled = !all.isChecked
                        setOnCheckedChangeListener { _, value ->
                            setMember(policy, "rootIds", id, value); drawRoots()
                        }
                    }
                    row.addView(share)
                    val read = localSwitch().apply {
                        text = this@MainActivity.text("Read only", "只读")
                        isChecked = contains(readOnly, id) || !root.optBoolean("writable")
                        isEnabled = allowed && root.optBoolean("writable")
                        setOnCheckedChangeListener { _, value -> setMember(policy, "readOnlyRootIds", id, value) }
                    }
                    row.addView(read); rootRows.addView(row)
                }
            }
            all.setOnCheckedChangeListener { _, value ->
                policy.put("rootAccess", if (value) "all" else "selected")
                if (value) policy.put("rootIds", JSONArray())
                drawRoots()
            }
            drawRoots()
        }
        action(text("Save changes", "保存修改")) {
            val count = concurrency.text.toString().toIntOrNull()
            if (count == null || count !in 1..32) { fieldError(concurrency, text("Choose 1–32 concurrent tasks.", "任务数需在 1–32 之间。")); return@action }
            if (!validateName(name) || description.text.toString().trim().length > 500) return@action
            policy.put("maxConcurrency", count)
            val session = accounts.session() ?: return@action
            val labelValue = name.text.toString().trim()
            val descriptionValue = description.text.toString()
            val policyValue = JSONObject(policy.toString())
            work({ AccountApi(session.origin, session.token).saveDevice(node, labelValue, descriptionValue, policyValue) }) {
                store.config()?.let { config ->
                    if (config.controlPlaneUrl == session.origin && config.nodeId == node.getString("nodeId") &&
                        config.accountId == node.optString("accountId")) store.saveConfig(config.copy(label = it.getString("label")))
                }
                notice(text("Device updated.", "设备已更新。")); showingDevice = false; refreshDevices()
            }
        }
        section(text("Connection", "连接管理"))
        if (node.optString("status") == "active") action(text("Revoke connection", "撤销连接"), false) {
            confirm(text("Revoke this device?", "撤销这台设备的连接？"),
                text("Its existing key will stop working. Pair it again to reconnect.", "当前设备密钥会失效，重新接入需要再次配对。")) {
                mutateDevice(node, false)
            }
        }
        action(text("Delete device", "删除设备"), false) {
            confirm(text("Delete this device?", "删除这台设备？"),
                text("The device will be removed from your account.", "设备将从账号中移除，现有连接会失效。")) { mutateDevice(node, true) }
        }
    }

    private fun mutateDevice(node: JSONObject, delete: Boolean) {
        val session = accounts.session() ?: return
        work({
            val api = AccountApi(session.origin, session.token)
            if (delete) api.deleteDevice(node) else api.revokeDevice(node)
        }) {
            store.config()?.let { config ->
                if (config.controlPlaneUrl == session.origin && config.nodeId == node.getString("nodeId")) {
                    NodeService.stop(this)
                    if (delete) store.clearConfig()
                }
            }
            showingDevice = false; refreshDevices()
        }
    }

    private fun renderPhone() {
        val config = store.config()
        val name = config?.label ?: "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}"
        val controller = column().apply {
            background = rounded(palette.controller, 28)
            setPadding(dp(24), dp(24), dp(24), dp(20))
        }
        val identity = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        }
        identity.addView(iconView(MobileGlyph.PHONE, palette.onController, 46),
            LinearLayout.LayoutParams(dp(46), dp(54)).apply { marginEnd = dp(16) })
        identity.addView(column().apply {
            addView(label("ANDROID NODE", 11, palette.controllerMuted, true).apply { letterSpacing = 0.1f })
            addView(label(name, 21, palette.onController, true).apply { setPadding(0, dp(5), 0, 0) })
        }, LinearLayout.LayoutParams(0, -2, 1f))
        controller.addView(identity)
        phoneStatus = label("", 14, palette.controllerMuted).apply {
            setPadding(0, dp(22), 0, dp(10))
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        controller.addView(phoneStatus)
        page.addView(controller)
        updatePhoneStatus()
        if (config == null) {
            caption(text("Connect this phone, then choose what agents may use.", "接入此手机后，选择允许 Agent 使用的能力。"))
            val nameInput = field(text("Phone name", "手机名称"), name)
            if (accounts.session() != null) {
                action(text("Connect to my account", "接入我的账号")) {
                    val session = accounts.session() ?: return@action
                    val label = nameInput.text.toString().trim()
                    if (!validateName(nameInput)) return@action
                    work({
                        val code = AccountApi(session.origin, session.token).pairingCode()
                        NodeProtocol(store).pair(session.origin, code, label)
                    }) { paired -> store.saveConfig(paired); render(); notice(text("Phone connected. Choose permissions and start the Node.", "手机已接入，请选择权限并启动 Node。")) }
                }
            } else action(text("Sign in to connect", "登录并接入手机")) { tab = 3; nav.selectedItemId = R.id.nav_account }
            section(text("Have a pairing code?", "使用配对码接入"))
            caption(text("For self-hosted services or pairing from another device.", "适用于自托管服务，或从其他设备完成配对。"))
            val origin = field(text("Service address", "服务地址"), accounts.origin(),
                InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI, maxLength = 2048)
            val code = field(text("Pairing code", "配对码"))
            action(text("Pair phone", "配对手机"), false) {
                val label = nameInput.text.toString().trim()
                if (!validateName(nameInput)) return@action
                if (code.text.isNullOrBlank()) { fieldError(code, text("Enter the pairing code.", "请输入配对码。")); return@action }
                val originValue = origin.text.toString()
                try { AccountApi.normalizeOrigin(originValue) }
                catch (_: Exception) { fieldError(origin, text("Enter an HTTPS service address without a path.", "请输入不含路径的 HTTPS 服务地址。")); return@action }
                val codeValue = code.text.toString().trim()
                work({ NodeProtocol(store).pair(AccountApi.normalizeOrigin(originValue), codeValue, label) }) {
                    store.saveConfig(it); render()
                }
            }
        } else {
            nodeButton = action(if (nodeStartingOrRunning()) text("Stop Node", "停止 Node") else text("Start Node", "启动 Node"), parent = controller) {
                try {
                    if (nodeStartingOrRunning()) NodeService.stop(this) else NodeService.start(this)
                    render()
                } catch (error: Exception) { NodeService.stop(this); error(error) }
            }.apply {
                backgroundTintList = ColorStateList.valueOf(palette.controllerAction)
                setTextColor(Color.parseColor("#153D2B"))
                icon = MobileGlyph.POWER.drawable(Color.parseColor("#153D2B"))
                iconTint = ColorStateList.valueOf(Color.parseColor("#153D2B"))
                iconGravity = MaterialButton.ICON_GRAVITY_TEXT_START
                iconSize = dp(20); iconPadding = dp(10)
            }
        }
        section(text("Sharing & connection", "共享与连接"))
        val count = CapabilityGroup.entries.count { store.isCapabilityEnabled(it) }
        settingsGroup {
            row(text("Sharing permissions", "管理共享权限"), text("$count of 10 enabled", "已开启 $count / 10 项能力"),
                "›", MobileGlyph.SHIELD) { renderPermissions() }
            if (config != null) {
            row(text("Phone name", "手机名称"), config.label, "›", MobileGlyph.EDIT) {
                val session = accounts.session()
                if (session == null || session.origin != config.controlPlaneUrl ||
                    session.me.optJSONObject("account")?.optString("accountId") != config.accountId) {
                    notice(text("Sign in to the account that owns this phone to rename it.", "请登录此手机所属账号后修改名称。"))
                    return@row
                }
                work({ AccountApi(session.origin, session.token).devices() }) { list ->
                    list.find { it.getString("nodeId") == config.nodeId }?.let { renderDevice(it) }
                        ?: notice(text("This phone is no longer in the account.", "账号中已找不到此手机。"))
                }
            }
            row(text("Connection details", "连接详情"), Uri.parse(config.controlPlaneUrl).host ?: config.controlPlaneUrl,
                "›", MobileGlyph.LINK) { connectionDetails(config) }
            }
        }
        if (config != null) {
            section(text("Run reliably", "后台运行"))
            settingsGroup {
                row(text("Battery & autostart", "省电与自启动"), text("Configure in Android settings", "在系统设置中调整后台策略"),
                    "›", MobileGlyph.BATTERY) { openAppSettings() }
            }
            caption(text("For Xiaomi / Redmi, allow autostart and choose unrestricted battery use.",
                "小米 / 红米建议允许自启动，并将省电策略设为不限制。"))
        } else {
            caption(text("Only device status is shared by default.", "默认仅共享设备状态。"))
        }
    }

    private fun connectionDetails(config: NodeConfig) {
        val dialog = BottomSheetDialog(this)
        val content = column().apply {
            setPadding(dp(24), dp(12), dp(24), dp(28))
            background = rounded(palette.surface, 28)
        }
        content.addView(View(this).apply { background = rounded(line, 4) },
            LinearLayout.LayoutParams(dp(36), dp(4)).apply { gravity = Gravity.CENTER_HORIZONTAL; bottomMargin = dp(24) })
        content.addView(label(text("Connection details", "连接详情"), 22, ink, true))
        content.addView(label(text("Service", "连接服务"), 12, muted).apply { setPadding(0, dp(24), 0, dp(6)) })
        content.addView(label(config.controlPlaneUrl, 14, ink).apply { setTextIsSelectable(true) })
        content.addView(label(text("Device ID", "设备标识"), 12, muted).apply { setPadding(0, dp(20), 0, dp(6)) })
        content.addView(label(config.nodeId, 13, ink).apply { setTextIsSelectable(true) })
        action(text("Remove local pairing", "解除本机配对"), false, content) {
            dialog.dismiss()
            confirm(text("Remove local pairing?", "解除本机配对？"),
                text("The Node will stop. You can remove its old record from the device list.",
                    "Node 将停止，可在设备列表中移除旧记录。")) {
                NodeService.stop(this); store.clearConfig(); render()
                }
        }
        dialog.setContentView(content)
        dialog.show()
    }

    private fun updatePhoneStatus() {
        nodeButton?.text = if (nodeStartingOrRunning()) text("Stop Node", "停止 Node") else text("Start Node", "启动 Node")
        phoneStatus?.text = when {
            store.config() == null -> text("Not connected", "尚未接入")
            !store.isNodeDesired() -> text("Node stopped", "Node 已停止")
            store.runtimeState() == "connecting" -> text("Connecting…", "正在连接…")
            !NodeService.isActive() -> text("Node interrupted · tap Start to reconnect", "Node 已中断 · 点击启动重新连接")
            store.runtimeState() == "online" -> text("Node online", "Node 在线")
            else -> text("Connection lost · retrying", "连接中断 · 正在重试")
        } + (if (store.isNodeDesired() && store.lastError() != null) "\n${store.lastError()}" else "")
    }

    private fun renderPermissions() {
        if (!::page.isInitialized) return
        clearPage(if (showingPermissions) scroll.scrollY else 0)
        showingPermissions = true; showingDevice = false; phoneStatus = null
        toolbar(text("Permissions", "共享权限"), true)
        caption(text("Your local choices apply to every agent. Account and agent policies can restrict them further.",
            "选择允许 Agent 使用的能力，手机始终保留最终控制权。"))
        val definitions = listOf(
            Triple(CapabilityGroup.DEVICE_STATUS, text("Device status", "设备状态"), text("Battery, network and hardware information", "电量、网络与硬件信息")),
            Triple(CapabilityGroup.LOCATION, text("Location", "前台位置"), text("Read location while this app is visible", "仅在 App 前台时读取位置")),
            Triple(CapabilityGroup.NOTIFICATIONS, text("Show notifications", "发送通知"), text("Display notifications; no message reading", "显示通知，不读取消息")),
            Triple(CapabilityGroup.AUDIO_CONTROL, text("Volume control", "音量控制"), text("Adjust media and other supported volumes", "调整媒体等音频流的音量")),
            Triple(CapabilityGroup.VIBRATION, text("Vibration", "振动"), text("Trigger short vibrations", "触发有时长限制的短振动")),
            Triple(CapabilityGroup.APP_LAUNCH, text("Open apps", "打开应用"), text("Launch installed apps within Android limits", "启动应用，仍受系统后台限制")),
            Triple(CapabilityGroup.FLASHLIGHT, text("Flashlight", "手电筒"), text("Control flash; requires camera permission", "控制闪光灯，需系统相机权限")),
            Triple(CapabilityGroup.SCREEN_CAPTURE, text("Screen sharing", "屏幕共享"), text("Share screen images with per-session consent", "共享屏幕图像，每次需系统确认")),
            Triple(CapabilityGroup.UI_OBSERVE, text("Read visible interface", "读取可见界面"), text("Read text and structure; passwords redacted", "读取文字与结构，密码字段脱敏")),
            Triple(CapabilityGroup.UI_CONTROL, text("Accessibility actions", "无障碍操作"), text("Tap and type; may change other apps' data", "点击与输入，可能修改其他应用数据"))
        )
        val categories = listOf(text("Information", "信息读取"), text("Device actions", "设备操作"), text("Screen & interface", "屏幕与界面"))
        listOf(definitions.take(2), definitions.subList(2, 7), definitions.drop(7)).forEachIndexed { index, items ->
            section(categories[index])
            val container = column().apply { background = rounded(palette.surface, 22); clipToOutline = true }
            page.addView(container)
            items.forEachIndexed { rowIndex, (group, name, description) ->
                if (rowIndex > 0) groupDivider(container)
                val block = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(16), dp(15), dp(14), dp(15)); minimumHeight = dp(88)
                }
                val glyph = when (group) {
                    CapabilityGroup.DEVICE_STATUS -> MobileGlyph.INFO
                    CapabilityGroup.LOCATION -> MobileGlyph.LOCATION
                    CapabilityGroup.NOTIFICATIONS -> MobileGlyph.NOTIFICATION
                    CapabilityGroup.AUDIO_CONTROL -> MobileGlyph.AUDIO
                    CapabilityGroup.VIBRATION -> MobileGlyph.VIBRATION
                    CapabilityGroup.APP_LAUNCH -> MobileGlyph.APPS
                    CapabilityGroup.FLASHLIGHT -> MobileGlyph.FLASHLIGHT
                    CapabilityGroup.SCREEN_CAPTURE -> MobileGlyph.SCREEN
                    CapabilityGroup.UI_OBSERVE -> MobileGlyph.SCAN
                    CapabilityGroup.UI_CONTROL -> MobileGlyph.TOUCH
                }
                block.addView(iconView(glyph, muted, 22), LinearLayout.LayoutParams(dp(24), dp(24)).apply { marginEnd = dp(14) })
                block.addView(column().apply {
                    addView(label(name, 15, ink, true))
                    addView(label(description, 12, muted).apply { setPadding(0, dp(4), 0, 0) })
                    if (store.isCapabilityEnabled(group)) addView(label(permissionState(group), 11, green).apply { setPadding(0, dp(4), 0, 0) })
                }, LinearLayout.LayoutParams(0, -2, 1f))
                val switch = localSwitch().apply {
                    contentDescription = name
                    isChecked = store.isCapabilityEnabled(group)
                    minHeight = dp(48)
                    setOnCheckedChangeListener { _, enabled -> changePermission(group, enabled) }
                }
                block.addView(switch, LinearLayout.LayoutParams(dp(56), dp(48)).apply { marginStart = dp(10) })
                block.background = ripple(Color.TRANSPARENT, 0)
                block.setOnClickListener { if (!busy) switch.performClick() }
                container.addView(block)
                if (store.isCapabilityEnabled(group) && group in setOf(CapabilityGroup.UI_CONTROL, CapabilityGroup.UI_OBSERVE) && !AdcAccessibilityService.isConnected()) {
                    action(text("Open accessibility settings", "打开无障碍设置"), false, container) { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
                }
                if (store.isCapabilityEnabled(group) && group == CapabilityGroup.SCREEN_CAPTURE && !ScreenCaptureSession.isActive()) {
                    action(text("Authorize this screen session", "授权本次屏幕共享"), false, container) { requestCapture() }
                }
            }
        }
        caption(text("Account and agent policies may further limit these choices. Turn off interface reading to block actions too.",
            "账号策略与 Agent 授权会进一步限制。关闭界面读取，也会阻止无障碍操作。"))
    }

    private fun permissionState(group: CapabilityGroup): String {
        if (!store.isCapabilityEnabled(group)) return text("Local access off", "本地允许：关闭")
        val tools = registry.manifest(store.config()?.nodeId ?: "nod_local").getJSONArray("tools")
        val names = when (group) {
            CapabilityGroup.DEVICE_STATUS -> setOf("device.battery.get")
            CapabilityGroup.LOCATION -> setOf("location.get")
            CapabilityGroup.NOTIFICATIONS -> setOf("notification.show")
            CapabilityGroup.SCREEN_CAPTURE -> setOf("screen.capture")
            CapabilityGroup.UI_OBSERVE -> setOf("ui.inspect")
            CapabilityGroup.UI_CONTROL -> setOf("ui.action")
            else -> (0 until tools.length()).map { tools.getJSONObject(it).optString("name") }
                .filter { runCatching { NativeToolPolicy.group(it) == group }.getOrDefault(false) }.toSet()
        }
        val availability = (0 until tools.length()).map { tools.getJSONObject(it) }
            .firstOrNull { it.optString("name") in names }?.optJSONObject("availability")
        val state = availability?.optString("state")
        val status = when (state) {
            "available" -> text("Available", "当前可用")
            "permission_required" -> text("System authorization required", "等待系统授权")
            "foreground_required" -> text("Available while app is visible", "仅 App 前台可用")
            else -> text("Currently unavailable", "当前不可用")
        }
        return status
    }

    private fun changePermission(group: CapabilityGroup, enabled: Boolean) {
        if (!enabled) {
            store.setCapabilityEnabled(group, false)
            if (group == CapabilityGroup.SCREEN_CAPTURE) NodeService.stopScreenCapture(this)
            renderPermissions(); return
        }
        when (group) {
            CapabilityGroup.LOCATION -> requestPermission(group, arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION))
            CapabilityGroup.FLASHLIGHT -> requestPermission(group, arrayOf(Manifest.permission.CAMERA))
            CapabilityGroup.NOTIFICATIONS -> if (Build.VERSION.SDK_INT >= 33) requestPermission(group, arrayOf(Manifest.permission.POST_NOTIFICATIONS))
                else { store.setCapabilityEnabled(group, true); renderPermissions() }
            CapabilityGroup.SCREEN_CAPTURE -> requestCapture()
            CapabilityGroup.UI_OBSERVE, CapabilityGroup.UI_CONTROL -> {
                renderPermissions()
                confirm(if (group == CapabilityGroup.UI_OBSERVE) text("Allow reading other apps?", "允许读取其他应用界面？") else text("Allow control of other apps?", "允许操作其他应用？"),
                    if (group == CapabilityGroup.UI_OBSERVE) text("Authorized agents can read visible text and interface structure. Turn this switch off to block ADC inspection.", "已授权的 Agent 可以读取可见文字与界面结构，关闭此开关即可阻止 ADC 读取。")
                    else text("This also enables interface reading to locate and verify actions. Authorized agents may tap and enter text. Turn this switch off to block actions.",
                        "操作需要读取界面进行定位与验证，将同时开启界面读取。已授权的 Agent 可以点击和输入，关闭此开关即可阻止操作。")) {
                    store.setCapabilityEnabled(group, true)
                    if (group == CapabilityGroup.UI_CONTROL) store.setCapabilityEnabled(CapabilityGroup.UI_OBSERVE, true)
                    startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                }
            }
            else -> { store.setCapabilityEnabled(group, true); renderPermissions() }
        }
    }
    private fun requestPermission(group: CapabilityGroup, values: Array<String>) {
        if (values.all(::has)) { store.setCapabilityEnabled(group, true); renderPermissions() }
        else { pendingGroup = group; permissions.launch(values) }
    }
    private fun requestCapture() {
        if (store.config() == null || !store.isNodeDesired()) {
            notice(text("Connect and start the phone Node before sharing the screen.", "请先接入并启动手机 Node，再授权屏幕共享。"))
            renderPermissions(); return
        }
        capture.launch(getSystemService(MediaProjectionManager::class.java).createScreenCaptureIntent())
    }

    private fun renderAccount() {
        if (authPage != "login") { renderAuth(); ensureAuthConfig(); return }
        val session = accounts.session()
        if (session == null) {
            renderAuth()
            ensureAuthConfig()
            if (authPage != "login") return
        } else {
            val user = session.me.optJSONObject("user")
            val userName = user?.optString("name")?.takeIf { it.isNotBlank() } ?: text("ADC account", "ADC 账号")
            val profile = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(4), dp(20), dp(4), dp(28))
            }
            profile.addView(label(userName.take(1).uppercase(), 26, green, true).apply {
                gravity = Gravity.CENTER; background = rounded(palette.tonal, 24)
            }, LinearLayout.LayoutParams(dp(68), dp(68)).apply { marginEnd = dp(16) })
            profile.addView(column().apply {
                addView(label("ADC", 11, green, true).apply { letterSpacing = 0.12f })
                addView(label(userName, 23, ink, true).apply { setPadding(0, dp(4), 0, dp(4)) })
                addView(label(user?.optString("email").orEmpty(), 13, muted))
            }, LinearLayout.LayoutParams(0, -2, 1f))
            page.addView(profile)
            settingsGroup {
                row(text("Account settings", "账号设置"), text("Profile, password and sign-in methods", "账号资料、密码与登录方式"),
                    "›", MobileGlyph.ACCOUNT) { renderDetail("account") }
            }
        }
        section(text("Service", "服务"))
        settingsGroup {
        row(text("Service address", "服务地址"), accounts.origin(), if (session == null) "›" else null, MobileGlyph.GLOBE,
            click = if (session == null) ({
                val wrapper = column().apply { setPadding(dp(24), dp(8), dp(24), 0) }
                val input = field(text("HTTPS service address", "HTTPS 服务地址"), accounts.origin(),
                    InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI, wrapper, maxLength = 2048)
                MaterialAlertDialogBuilder(this).setTitle(text("Service address", "服务地址")).setView(wrapper)
                    .setNegativeButton(text("Cancel", "取消"), null).setPositiveButton(text("Save", "保存"), null)
                    .create().apply {
                        setOnShowListener {
                            getButton(androidx.appcompat.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                                try {
                                    val origin = AccountApi.normalizeOrigin(input.text.toString())
                                    cancelBrowserLogin(); accounts.setOrigin(origin); authConfig = null; authConfigRequested = false
                                    dismiss(); render()
                                } catch (_: Exception) {
                                    fieldError(input, text("Use an HTTPS address without a path.", "请输入不含路径的 HTTPS 地址。"))
                                }
                            }
                        }
                        show()
                    }
            }) else null)
        }
        section(text("About", "关于"))
        settingsGroup {
            row(text("Check for updates", "检查更新"), "Android Node v${updater.currentVersion().first} · " + text("Preview", "测试版"),
                "›", MobileGlyph.DOWNLOAD) { checkUpdate() }
            row(text("Android guide", "使用指南"), text("Setup, permissions and background use", "接入、权限与后台运行"),
                "›", MobileGlyph.BOOK) { renderDetail("guide") }
        }
        if (session != null) {
            space(24)
            settingsGroup {
            row(text("Sign out", "退出登录"), "", "›", MobileGlyph.LOGOUT, palette.danger) {
                confirm(text("Sign out of this account?", "退出当前账号？"),
                    text("This login will be revoked. The phone Node keeps running until you stop it.",
                        "此登录会话会被撤销，手机 Node 会继续运行，直到你手动停止。")) {
                    work({ AccountApi(session.origin, session.token).signOut() }) {
                        accounts.clear(); devices = emptyList(); loadedDevices = false; render()
                    }
                }
            }
            }
        }
    }
    private fun signedIn(session: AccountSession) {
        authPage = "login"; authEmail = ""; authName = ""; recoveryLink = null
        hideKeyboard()
        accounts.save(session); devices = emptyList(); loadedDevices = false
        tab = 1; nav.selectedItemId = R.id.nav_devices; render()
        notice(text("Signed in.", "登录成功。"))
        if (!busy) refreshDevices()
    }
    private fun renderAuth() {
        toolbar(if (authPage == "login") text("Account", "我的") else when (authPage) {
            "register" -> text("Create account", "注册账号")
            "forgot", "sent" -> text("Password recovery", "找回密码")
            "verify" -> text("Verify email", "验证邮箱")
            "reset" -> text("New password", "设置新密码")
            else -> text("Account", "我的")
        }, authPage != "login")
        val identity = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL; orientation = LinearLayout.HORIZONTAL
            setPadding(dp(4), dp(12), dp(4), dp(20))
        }
        identity.addView(ImageView(this).apply {
            setImageResource(R.drawable.ic_launcher)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, LinearLayout.LayoutParams(dp(44), dp(44)).apply { marginEnd = dp(12) })
        identity.addView(column().apply {
            addView(label("ADC", 22, ink, true))
            addView(label(text("Your devices, connected", "连接你的设备"), 12, muted).apply { setPadding(0, dp(3), 0, 0) })
        })
        page.addView(identity)
        val headline = when (authPage) {
            "register" -> text("Create your account", "创建账号")
            "forgot" -> text("Forgot your password?", "忘记密码？")
            "sent" -> text("Check your email", "查看你的邮箱")
            "verify" -> text("Verify your email", "验证你的邮箱")
            "reset" -> text("Choose a new password", "设置新密码")
            else -> text("Welcome back", "欢迎回来")
        }
        val description = when (authPage) {
            "register" -> text("Use your email to get started.", "使用邮箱注册，即可管理设备。")
            "forgot" -> text("We will send you a secure reset link.", "我们会发送一封包含安全链接的邮件。")
            "sent" -> text("If this address has an account, a reset link is on its way to $authEmail.",
                "如果 $authEmail 对应已注册账号，我们会向它发送重置链接。")
            "verify" -> text("Open the verification link sent to $authEmail, then sign in.",
                "打开 $authEmail 收到的验证链接，然后登录。")
            "reset" -> text("Choose 12–128 characters. Existing sessions will be signed out.",
                "使用 12–128 个字符，重置后已有登录会话会退出。")
            else -> text("Sign in to manage your devices.", "登录后，管理电脑和手机。")
        }
        lead(headline, description)
        if (authPage in setOf("sent", "verify")) {
            caption(text("If the message is missing, check your spam folder. Official service links open in the app when Android link handling is enabled.",
                "未收到邮件时，请检查垃圾邮件。允许 App 打开受支持链接后，官方服务的邮件链接可在 App 内完成。"))
            if (authPage == "verify") action(text("Resend verification email", "重新发送验证邮件"), false) {
                if (System.currentTimeMillis() < verificationResendAt) {
                    notice(text("Wait a minute before sending again.", "请稍后再发送验证邮件。")); return@action
                }
                work({ AccountApi(accounts.origin()).sendVerificationEmail(authEmail) }) {
                    verificationResendAt = System.currentTimeMillis() + 60_000
                    notice(text("Verification email requested.", "已请求发送验证邮件。"))
                }
            }
            action(text("Return to sign in", "返回登录")) { showAuth("login") }
            return
        }
        if (authPage == "register") {
            authNameInput = field(text("Name", "名称"), authName, maxLength = 128).apply {
                setAutofillHints(View.AUTOFILL_HINT_NAME)
            }
        }
        val email = if (authPage != "reset") field(text("Email", "邮箱"), authEmail,
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS, maxLength = 254).also {
                authEmailInput = it
            } else null
        val password = if (authPage != "forgot") field(text("Password", "密码"), "",
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD).apply {
                if (authPage in setOf("register", "reset")) setAutofillHints("newPassword")
            } else null
        if (authPage == "login" && authConfig?.optBoolean("passwordResetEnabled", true) != false) {
            val links = LinearLayout(this).apply { gravity = Gravity.END }
            action(text("Forgot password?", "忘记密码？"), false, links) { showAuth("forgot") }.apply {
                layoutParams = LinearLayout.LayoutParams(-2, dp(44))
            }
            page.addView(links)
        }
        if (authPage in setOf("register", "reset")) caption(text("12–128 characters.", "密码需为 12–128 个字符。"))
        val currentPage = authPage
        val submit = action(when (currentPage) {
            "register" -> text("Create account", "注册账号")
            "forgot" -> text("Send reset link", "发送重置链接")
            "reset" -> text("Save new password", "保存新密码")
            else -> text("Sign in", "登录")
        }) {
            if (email != null && !validateEmail(email)) return@action
            if (currentPage == "register" && authNameInput?.let { validateName(it) } != true) return@action
            if (password != null && !validatePassword(password, currentPage != "login")) return@action
            captureAuthDraft()
            val emailValue = authEmail
            val nameValue = authName
            val passwordValue = password?.text?.toString().orEmpty()
            val api = AccountApi(accounts.origin())
            cancelBrowserLogin()
            work({
                when (currentPage) {
                    "register" -> api.signUp(nameValue, emailValue, passwordValue)
                    "forgot" -> { api.requestPasswordReset(emailValue); null }
                    "reset" -> {
                        val link = recoveryLink ?: throw IllegalStateException(text("Request a new reset link.", "请重新请求重置链接。"))
                        api.resetPassword(link.token, passwordValue); null
                    }
                    else -> api.signIn(emailValue, passwordValue)
                }
            }, failure = { failure ->
                if (failure is AccountApiException && failure.code == "EMAIL_NOT_VERIFIED") {
                    showAuth("verify")
                } else if (password != null) fieldError(password, accountError(failure))
                else if (email != null) fieldError(email, accountError(failure))
                else error(failure)
            }) { session ->
                password?.text?.clear()
                hideKeyboard()
                if (session != null) signedIn(session)
                else when (currentPage) {
                    "forgot" -> showAuth("sent")
                    "register" -> { verificationResendAt = System.currentTimeMillis() + 60_000; showAuth("verify") }
                    "reset" -> {
                        recoveryLink = null; intent.data = null
                        accounts.clear(); devices = emptyList(); loadedDevices = false
                        showAuth("login"); notice(text("Password updated. Sign in again.", "密码已更新，请重新登录。"))
                    }
                }
            }
        }
        submitFrom(password ?: email!!, submit)
        if (currentPage == "login") {
            if (authConfig?.optBoolean("githubEnabled", true) != false) {
                space(12)
                action(text("GitHub / browser sign-in", "GitHub / 浏览器账号登录"), false) { beginBrowserLogin() }.apply {
                    strokeWidth = dp(1); strokeColor = ColorStateList.valueOf(palette.outline)
                    backgroundTintList = ColorStateList.valueOf(palette.surface); minHeight = dp(48)
                }
            }
            if (browserCode != null) action(text("Cancel pending authorization", "取消待确认授权"), false) {
                cancelBrowserLogin(); render()
            }
            if (authConfig?.optBoolean("registrationEnabled", true) != false) {
                action(text("New here? Create an account", "还没有账号？注册账号"), false) { showAuth("register") }
            }
        } else action(text("Return to sign in", "返回登录"), false) { showAuth("login") }
    }
    private fun showAuth(value: String) {
        captureAuthDraft(); hideKeyboard()
        authPage = value; detailPage = null
        if (value != "reset") { recoveryLink = null; intent.data = null }
        message.visibility = View.GONE
        render()
    }
    private fun captureAuthDraft() {
        authEmailInput?.let { authEmail = it.text.toString().trim() }
        authNameInput?.let { authName = it.text.toString().trim() }
    }
    private fun ensureAuthConfig() {
        if (authConfig != null || authConfigRequested) return
        authConfigRequested = true
        val origin = accounts.origin()
        handler.post {
            if (busy || isDestroyed) { authConfigRequested = false; return@post }
            work({ AccountApi(origin).config() }) { config ->
                if (accounts.origin() != origin) return@work
                authConfig = config
                if (tab == 3 && detailPage == null && accounts.session() == null) render()
            }
        }
    }
    private fun handleAccountLink(intent: Intent) {
        if (intent.action != Intent.ACTION_VIEW || intent.data == null) return
        if (busy) { notice(text("Finish the current action, then open the email link again.", "请完成当前操作后，重新打开邮件链接。")); return }
        val link = try { AccountRecoveryLink.parse(intent.data.toString(), accounts.origin()) }
        catch (_: Exception) {
            intent.data = null
            notice(text("This account link is invalid or belongs to another service.", "账号链接无效，或不属于当前连接的服务。"), true)
            return
        }
        recoveryLink = link
        tab = 3; nav.selectedItemId = R.id.nav_account
        if (link.kind == "reset") {
            authPage = "reset"
            clearPage(); detailPage = null
            renderAuth()
        } else {
            intent.data = null
            confirm(text("Verify your email?", "验证邮箱？"), text("Confirm the email address associated with this link.", "确认验证此邮件链接对应的邮箱地址。")) {
                work({ AccountApi(accounts.origin()).verifyEmail(link.token) }) {
                    authPage = "login"; recoveryLink = null; render()
                    notice(text("Email verified. You can now sign in.", "邮箱已验证，可以登录了。"))
                }
            }
        }
    }
    private fun renderDetail(value: String) {
        clearPage(); phoneStatus = null; showingDevice = false; showingPermissions = false
        detailPage = value
        when (value) {
            "account" -> renderAccountSettings()
            "password" -> renderPasswordSettings()
            "guide" -> renderGuide()
            "computer" -> renderComputerGuide()
            "recovery" -> renderAuth()
            else -> render()
        }
    }
    private fun renderAccountSettings() {
        val session = accounts.session() ?: run { render(); return }
        toolbar(text("Account settings", "账号设置"), true)
        lead(text("Your profile", "账号资料"), text("Keep your name and sign-in methods up to date.", "管理账号名称与登录方式。"))
        val name = field(text("Name", "名称"), session.me.optJSONObject("user")?.optString("name").orEmpty())
        caption(session.me.optJSONObject("user")?.optString("email").orEmpty())
        val save = action(text("Save name", "保存名称")) {
            if (!validateName(name)) return@action
            val nameValue = name.text.toString().trim()
            work({
                val api = AccountApi(session.origin, session.token)
                api.updateProfile(nameValue)
                AccountSession(session.origin, session.token, api.me())
            }) {
                accounts.save(it); hideKeyboard()
                notice(text("Name updated.", "名称已更新。"))
            }
        }
        submitFrom(name, save)
        section(text("Sign-in methods", "登录方式"))
        val methods = column()
        page.addView(methods)
        work({ AccountApi(session.origin, session.token).loginMethods() }) { providers ->
            if (detailPage != "account" || accounts.session()?.token != session.token) return@work
            methods.addView(label(providers.map {
                when (it) { "credential" -> text("Email & password", "邮箱与密码"); "github" -> "GitHub"; else -> it }
            }.joinToString(" · "), 14, ink).apply { setPadding(dp(4), dp(12), dp(4), dp(12)) })
            action(if ("credential" in providers) text("Change password", "修改密码")
                else text("Set an email password", "设置邮箱密码"), false, methods) {
                if ("credential" in providers) renderDetail("password")
                else {
                    authEmail = session.me.optJSONObject("user")?.optString("email").orEmpty()
                    renderPasswordRecovery()
                }
            }
        }
        section(text("Security", "安全"))
        settingsGroup {
            row(text("Sign out other sessions", "退出其他登录会话"),
                text("Keep this app signed in", "保留此 App 的当前登录"), "›", MobileGlyph.SHIELD) {
                confirm(text("Sign out other sessions?", "退出其他登录会话？"),
                    text("Other browsers and clients will need to sign in again.", "其他浏览器和客户端需要重新登录。")) {
                    work({ AccountApi(session.origin, session.token).revokeOtherSessions() }) {
                        notice(text("Other sessions signed out.", "其他登录会话已退出。"))
                    }
                }
            }
        }
    }
    private fun renderPasswordRecovery() {
        clearPage(); authPage = "forgot"; detailPage = "recovery"
        renderAuth()
    }
    private fun renderPasswordSettings() {
        val session = accounts.session() ?: run { render(); return }
        toolbar(text("Change password", "修改密码"), true)
        lead(text("Update your password", "更新密码"), text("Other sessions will be signed out.", "修改后，其他登录会话会退出。"))
        val current = field(text("Current password", "当前密码"), type = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        val password = field(text("New password", "新密码"), type = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
            .apply { setAutofillHints("newPassword") }
        caption(text("12–128 characters.", "新密码需为 12–128 个字符。"))
        val submit = action(text("Save password", "保存密码")) {
            if (!validatePassword(current, false) || !validatePassword(password, true)) return@action
            val currentValue = current.text.toString()
            val passwordValue = password.text.toString()
            work({
                val api = AccountApi(session.origin, session.token)
                api.changePassword(currentValue, passwordValue)
                AccountSession(session.origin, session.token, api.me())
            }, failure = { fieldError(current, accountError(it)) }) {
                accounts.save(it); current.text?.clear(); password.text?.clear(); hideKeyboard()
                renderDetail("account"); notice(text("Password changed.", "密码已修改。"))
            }
        }
        submitFrom(password, submit)
    }
    private fun renderGuide() {
        toolbar(text("Using ADC", "使用指南"), true)
        lead(text("Connect, choose, start", "接入、授权、启动"), text("Your phone stays in control.", "手机始终保留最终控制权。"))
        section(text("1. Connect this phone", "1. 接入手机"))
        caption(text("Sign in, then open This phone and choose Connect to my account. Pairing alone does not start the Node.",
            "登录后，在「此手机」选择「接入我的账号」。完成接入不会自动启动 Node。"))
        section(text("2. Choose permissions", "2. 选择共享权限"))
        caption(text("Only device status is enabled by default. Enable each additional capability you need. Screen sharing needs Android consent for every session; interface reading and actions need Accessibility permission.",
            "新安装默认只共享设备状态。按需开启其他能力；每次屏幕共享需要系统确认，界面读取和操作需要系统无障碍授权。"))
        section(text("3. Start the Node", "3. 启动 Node"))
        caption(text("Start and stop it from This phone. For Xiaomi / Redmi, allow autostart and unrestricted battery use in system settings. Location works only while this app is visible.",
            "在「此手机」启动或停止。小米 / 红米可在系统设置允许自启动并关闭省电限制；位置读取仅在 App 前台可用。"))
        section(text("Account & device connections", "账号与设备连接"))
        caption(text("Signing out does not stop the phone Node. Removing local pairing stops it; revoke or delete a device in Devices to disable its account connection.",
            "退出账号不会停止手机 Node。解除本机配对会停止 Node；在「设备」中撤销或删除设备，可停用账号侧连接。"))
        section(text("Agent access", "Agent 访问"))
        caption(text("Each agent needs a separate grant for a device and its tools. Account and agent permissions can narrow your phone's local choices.",
            "每个 Agent 需单独授权设备与工具；账号和 Agent 权限会进一步约束手机本地共享的能力。"))
        action(text("Open phone controls", "打开手机控制页")) { tab = 2; nav.selectedItemId = R.id.nav_phone }
    }
    private fun renderComputerGuide() {
        toolbar(text("Add a computer", "接入电脑"), true)
        lead(text("Connect another device", "连接另一台设备"), text("Generate a code, then run the installer on that computer.", "生成配对码，在目标电脑运行安装命令。"))
        caption(text("The code expires after 10 minutes and is used only for pairing. Do not share it with others.",
            "配对码 10 分钟后过期，仅用于接入设备，请勿分享给他人。"))
        val result = column(); page.addView(result)
        action(text("Generate pairing instructions", "生成配对指引")) {
            val session = accounts.session() ?: return@action
            work({ AccountApi(session.origin, session.token).pairingCode() }) { code ->
                if (detailPage != "computer") return@work
                result.removeAllViews()
                result.addView(label(text("Pairing code: $code", "配对码：$code"), 20, green, true).apply {
                    setTextIsSelectable(true); setPadding(dp(4), dp(20), dp(4), dp(12))
                })
                fun shellQuote(value: String) = "'" + value.replace("'", "'\\''") + "'"
                val command = "curl -fsSL ${shellQuote(session.origin + "/downloads/node/install.sh")} | sh -s -- --url ${shellQuote(session.origin)} --code ${shellQuote(code)}"
                action(text("Copy macOS / Linux command", "复制 macOS / Linux 命令"), false, result) { copyText(command) }
                val psOrigin = session.origin.replace("'", "''")
                val psCode = code.replace("'", "''")
                val windows = "\$p = Join-Path \$env:TEMP 'adc-install.ps1'\nInvoke-WebRequest -UseBasicParsing -Uri '$psOrigin/downloads/node/install.ps1' -OutFile \$p\n& \$p -Url '$psOrigin' -Code '$psCode'"
                action(text("Copy Windows command", "复制 Windows 命令"), false, result) { copyText(windows) }
            }
        }
        section(text("After pairing", "接入完成后"))
        caption(text("Return to Devices and refresh. You can rename the computer and adjust its account access here. The computer chooses its own local folders and permissions.",
            "返回「设备」并刷新，即可修改电脑名称和账号访问策略。电脑本地共享的文件夹与权限仍由电脑端决定。"))
    }
    private fun copyText(value: String) {
        getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("ADC", value))
        notice(text("Copied.", "已复制。"))
    }
    private fun goBack() {
        captureAuthDraft(); hideKeyboard()
        when {
            detailPage == "password" || detailPage == "recovery" -> { authPage = "login"; renderDetail("account") }
            detailPage != null -> { authPage = "login"; render() }
            authPage != "login" -> showAuth("login")
            else -> render()
        }
    }
    private fun beginBrowserLogin() {
        cancelBrowserLogin()
        val origin = accounts.origin()
        work({ AccountApi(origin).beginBrowserLogin() }) { authorization ->
            val uri = URIValidation.browserUri(authorization.getString("verification_uri_complete"), origin)
            browserCode = authorization.getString("device_code")
            browserOrigin = origin
            browserDeadline = System.currentTimeMillis() + authorization.getLong("expires_in").coerceIn(1, 600) * 1000
            browserInterval = authorization.optLong("interval", 2).coerceAtLeast(2) * 1000
            notice(text("Approve code ${authorization.getString("user_code")} in the browser, then return here.",
                "请在浏览器中确认代码 ${authorization.getString("user_code")}，然后回到 App。"))
            render()
            openAuthorization(uri)
            handler.postDelayed(browserPoll, browserInterval)
        }
    }
    private fun cancelBrowserLogin() {
        browserCode = null; browserOrigin = null; handler.removeCallbacks(browserPoll)
    }
    private fun checkUpdate() {
        work({ updater.check(store.config()?.controlPlaneUrl ?: accounts.origin()) }) { release ->
            if (release == null || release.versionCode <= updater.currentVersion().second) {
                notice(text("You have the latest available version.", "已是当前可用版本。")); return@work
            }
            confirm(text("Update to ${release.versionName}?", "更新至 ${release.versionName}？"), release.notesFor()) {
                work({ updater.downloadAndVerify(release) }) { apk ->
                    if (updater.canRequestPackageInstalls()) updater.launchInstaller(apk)
                    else { pendingApk = apk; installer.launch(updater.installPermissionIntent()) }
                }
            }
        }
    }

    private fun <T> work(task: () -> T, failure: ((Exception) -> Unit)? = null, success: (T) -> Unit) {
        if (busy || isDestroyed) return
        setBusy(true)
        executor.execute {
            try {
                val result = task()
                runOnUiThread {
                    if (isDestroyed) return@runOnUiThread
                    setBusy(false)
                    try { success(result) } catch (error: Exception) { error(error) }
                }
            } catch (error: Exception) {
                runOnUiThread {
                    if (!isDestroyed) {
                        setBusy(false)
                        if (error is AccountApiException && error.status == 401 && accounts.session() != null) error(error)
                        else if (failure != null) failure(error) else error(error)
                    }
                }
            }
        }
    }
    private fun setBusy(value: Boolean) {
        busy = value; progress.visibility = if (value) View.VISIBLE else View.GONE
        fun enable(view: View) {
            if (view is MaterialButton || view is TextInputLayout || view is TextInputEditText) view.isEnabled = !value
            if (view is ViewGroup) for (i in 0 until view.childCount) enable(view.getChildAt(i))
        }
        enable(page)
    }
    private fun error(error: Exception) {
        if (error is AccountApiException && error.status == 401 && accounts.session() != null) {
            accounts.clear(); devices = emptyList(); loadedDevices = false; tab = 3; nav.selectedItemId = R.id.nav_account; render()
            notice(text("Your login expired. Sign in again.", "登录已过期，请重新登录。")); return
        }
        val conflict = error is AccountApiException && error.status == 409
        notice(if (conflict) text("This device changed elsewhere. Refresh it before saving again.",
            "设备已在其他地方更新，请刷新后重新修改。") else error.message ?: text("Operation failed. Try again.", "操作失败，请重试。"), true)
        if (conflict) { showingDevice = false; refreshDevices() }
    }
    private fun notice(value: String, failed: Boolean = false) {
        message.text = value; message.setTextColor(if (failed) palette.danger else green); message.visibility = View.VISIBLE
    }
    private fun confirm(title: String, description: String, action: () -> Unit) {
        MaterialAlertDialogBuilder(this).setTitle(title).setMessage(description)
            .setNegativeButton(text("Cancel", "取消"), null)
            .setPositiveButton(text("Continue", "确认")) { _, _ -> action() }.show()
    }
    private fun lead(headline: String, description: String) {
        page.addView(label(headline, 23, ink, true).apply { setPadding(dp(4), dp(4), dp(4), dp(8)) })
        page.addView(label(description, 14, muted).apply { setPadding(dp(4), 0, dp(4), dp(12)) })
    }
    private fun caption(value: String) { page.addView(label(value, 12, muted).apply { setPadding(dp(4), dp(10), dp(4), dp(8)) }) }
    private fun section(value: String) { space(22); page.addView(label(value, 12, muted, true).apply { setPadding(dp(8), 0, 0, 0) }); space(10) }
    private fun settingsGroup(content: () -> Unit) {
        val container = column().apply { background = rounded(palette.surface, 22); clipToOutline = true }
        page.addView(container)
        val previous = rowContainer
        rowContainer = container
        try { content() } finally { rowContainer = previous }
    }
    private fun row(name: String, description: String, trailing: String? = null,
        glyph: MobileGlyph = MobileGlyph.INFO, trailingColor: Int = muted, click: (() -> Unit)? = null) {
        val parent = rowContainer ?: page
        if (parent != page && parent.childCount > 0) groupDivider(parent)
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16)); minimumHeight = dp(if (description.isBlank()) 64 else 82)
            background = ripple(if (parent == page) palette.surface else Color.TRANSPARENT, if (parent == page) 20 else 0)
            if (click != null) { isClickable = true; isFocusable = true; setOnClickListener { if (!busy) click() } }
        }
        row.addView(iconView(glyph, if (trailingColor == palette.danger) palette.danger else muted, 22),
            LinearLayout.LayoutParams(dp(24), dp(24)).apply { marginEnd = dp(16) })
        row.addView(column().apply {
            addView(label(name, 15, if (trailingColor == palette.danger) palette.danger else ink, true))
            if (description.isNotBlank()) addView(label(description, 12, muted).apply { setPadding(0, dp(4), 0, 0) })
        },
            LinearLayout.LayoutParams(0, -2, 1f))
        if (trailing != null && trailing != "›") row.addView(label(trailing, 12, trailingColor).apply { setPadding(dp(12), 0, dp(6), 0) })
        if (click != null) row.addView(iconView(MobileGlyph.CHEVRON, muted, 16),
            LinearLayout.LayoutParams(dp(16), dp(20)).apply { marginStart = dp(8) })
        parent.addView(row, LinearLayout.LayoutParams(-1, -2).apply { if (parent == page) topMargin = dp(8) })
    }
    private fun action(value: String, primary: Boolean = true, parent: LinearLayout = page, click: () -> Unit): MaterialButton {
        val button = MaterialButton(this, null, if (primary) com.google.android.material.R.attr.materialButtonStyle else com.google.android.material.R.attr.borderlessButtonStyle).apply {
            text = value; isAllCaps = false; textSize = 15f; minHeight = dp(52); cornerRadius = dp(18)
            insetTop = 0; insetBottom = 0
            elevation = 0f; stateListAnimator = null
            if (primary) { backgroundTintList = ColorStateList.valueOf(green); setTextColor(if (palette.dark) Color.parseColor("#143D2B") else Color.WHITE) }
            else { setTextColor(green); textSize = 13f; setPadding(dp(12), 0, dp(12), 0) }
            setOnClickListener { if (!busy) click() }
        }
        parent.addView(button, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(10) })
        return button
    }
    private fun field(hint: String, value: String = "", type: Int = InputType.TYPE_CLASS_TEXT,
        parent: LinearLayout = page, maxLength: Int = 128, multiline: Boolean = false): TextInputEditText {
        val field = MobileFormField(this, hint, value, type, maxLength, multiline)
        parent.addView(field, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(14); bottomMargin = dp(2) })
        if (parent == page) {
            formInputs.lastOrNull()?.nextFocusForwardId = field.input.id
            formInputs += field.input
        }
        return field.input
    }
    private fun fieldError(input: TextInputEditText, value: String) {
        (input.getTag(R.id.form_field) as MobileFormField).showError(value)
    }
    private fun validateName(input: TextInputEditText): Boolean {
        if (input.text.toString().trim().length in 1..128) return true
        fieldError(input, text("Use 1–128 characters.", "名称需为 1–128 个字符。")); return false
    }
    private fun validateEmail(input: TextInputEditText): Boolean {
        if (android.util.Patterns.EMAIL_ADDRESS.matcher(input.text.toString().trim()).matches()) return true
        fieldError(input, text("Enter a valid email address.", "请输入有效的邮箱地址。")); return false
    }
    private fun validatePassword(input: TextInputEditText, new: Boolean): Boolean {
        if (input.text.toString().length in (if (new) 12 else 1)..128) return true
        fieldError(input, if (new) text("Use 12–128 characters.", "密码需为 12–128 个字符。")
            else text("Enter your password.", "请输入密码。")); return false
    }
    private fun accountError(error: Exception): String = when ((error as? AccountApiException)?.code) {
        "INVALID_EMAIL_OR_PASSWORD", "INVALID_PASSWORD" -> text("Email or password is incorrect.", "邮箱或密码不正确。")
        "USER_ALREADY_EXISTS", "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" -> text("This email is already registered. Sign in instead.", "此邮箱已注册，请直接登录。")
        "PASSWORD_TOO_SHORT", "PASSWORD_TOO_LONG" -> text("Use 12–128 characters for your password.", "密码需为 12–128 个字符。")
        "INVALID_TOKEN", "TOKEN_EXPIRED" -> text("This link has expired. Request a new one.", "链接已失效，请重新请求。")
        "SIGNUP_DISABLED" -> text("Registration is disabled for this service.", "此服务已关闭注册。")
        "RESET_PASSWORD_DISABLED" -> text("Password recovery is disabled for this service.", "此服务未启用密码找回。")
        else -> if (error is java.io.IOException) text("Cannot connect. Check your network and try again.", "连接失败，请检查网络后重试。")
            else error.message ?: text("Please try again.", "请重试。")
    }
    private fun submitFrom(input: TextInputEditText, button: MaterialButton) {
        input.imeOptions = EditorInfo.IME_ACTION_DONE
        input.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_DONE) { if (!busy) button.performClick(); true } else false
        }
    }
    private fun hideKeyboard() {
        currentFocus?.let { getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(it.windowToken, 0); it.clearFocus() }
    }
    private fun toggle(name: String, description: String, checked: Boolean, changed: (Boolean) -> Unit) {
        val block = column().apply { background = rounded(palette.surface, 20); setPadding(dp(16), dp(8), dp(16), dp(14)) }
        block.addView(localSwitch().apply {
            text = name; isChecked = checked; minHeight = dp(48)
            setOnCheckedChangeListener { _, value -> changed(value) }
        })
        block.addView(label(description, 12, muted))
        page.addView(block)
    }
    private fun label(value: String, size: Float, color: Int, bold: Boolean = false): TextView = TextView(this).apply {
        text = value; textSize = size; setTextColor(color); setLineSpacing(dp(2).toFloat(), 1f)
        includeFontPadding = false
        if (bold) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    }
    private fun label(value: String, size: Int, color: Int, bold: Boolean = false) = label(value, size.toFloat(), color, bold)
    private fun column() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    private fun localSwitch() = MaterialSwitch(this).apply {
        // Some MIUI themes enable SwitchCompat's text layout with null on/off labels.
        showText = false
        textOn = ""
        textOff = ""
        thumbTintList = ColorStateList.valueOf(if (palette.dark) Color.parseColor("#DCEADF") else Color.WHITE)
        trackTintList = ColorStateList(arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()),
            intArrayOf(green, if (palette.dark) Color.parseColor("#5B6C61") else Color.parseColor("#A8B5AC")))
        setTextColor(ink); textSize = 15f
        layoutParams = LinearLayout.LayoutParams(-1, -2)
        switchPadding = dp(16)
    }
    private fun clearPage(offset: Int = 0) {
        captureAuthDraft()
        authEmailInput = null; authNameInput = null; formInputs.clear()
        page.animate().cancel()
        page.removeAllViews()
        page.alpha = 1f; page.translationY = 0f
        scroll.post { scroll.scrollTo(0, offset) }
    }
    private fun toolbar(value: String, back: Boolean = false) {
        title.text = value
        toolbarBack.visibility = if (back) View.VISIBLE else View.GONE
        toolbarAction.visibility = if (!back && tab == 1 && accounts.session() != null) View.VISIBLE else View.GONE
        animatePage()
    }
    private fun animatePage() {
        if (!android.animation.ValueAnimator.areAnimatorsEnabled()) return
        page.alpha = 0f; page.translationY = dp(6).toFloat()
        page.animate().alpha(1f).translationY(0f).setDuration(180)
            .setInterpolator(android.view.animation.DecelerateInterpolator()).start()
    }
    private fun emptyState(glyph: MobileGlyph, headline: String, description: String) {
        val block = column().apply { gravity = Gravity.CENTER; setPadding(dp(20), dp(42), dp(20), dp(34)) }
        block.addView(iconView(glyph, green, 40).apply {
            background = rounded(palette.tonal, 28); setPadding(dp(22), dp(22), dp(22), dp(22))
        }, LinearLayout.LayoutParams(dp(88), dp(88)).apply { bottomMargin = dp(24) })
        block.addView(label(headline, 21, ink, true).apply { gravity = Gravity.CENTER })
        block.addView(label(description, 14, muted).apply { gravity = Gravity.CENTER; setPadding(0, dp(10), 0, 0) })
        page.addView(block)
    }
    private fun iconView(glyph: MobileGlyph, color: Int, size: Int) = ImageView(this).apply {
        setImageDrawable(glyph.drawable(color)); scaleType = ImageView.ScaleType.FIT_CENTER
        minimumWidth = dp(size); minimumHeight = dp(size)
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    private fun iconButton(glyph: MobileGlyph, name: String, click: () -> Unit) = ImageButton(this).apply {
        setImageDrawable(glyph.drawable(ink)); contentDescription = name
        scaleType = ImageView.ScaleType.FIT_CENTER
        setPadding(dp(12), dp(12), dp(12), dp(12)); background = ripple(Color.TRANSPARENT, 24)
        layoutParams = LinearLayout.LayoutParams(dp(48), dp(48))
        setOnClickListener { if (!busy) click() }
    }
    private fun rounded(color: Int, radius: Int) = GradientDrawable().apply {
        setColor(color); cornerRadius = dp(radius).toFloat()
    }
    private fun ripple(color: Int, radius: Int) = RippleDrawable(
        ColorStateList.valueOf(if (palette.dark) Color.parseColor("#334E6B53") else Color.parseColor("#18255336")),
        rounded(color, radius), rounded(Color.WHITE, radius))
    private fun groupDivider(parent: LinearLayout) {
        parent.addView(View(this).apply { setBackgroundColor(line) },
            LinearLayout.LayoutParams(-1, dp(1)).apply { marginStart = dp(56) })
    }
    private fun divider() { page.addView(View(this).apply { setBackgroundColor(line) }, LinearLayout.LayoutParams(-1, dp(1))) }
    private fun space(height: Int) { page.addView(View(this), LinearLayout.LayoutParams(1, dp(height))) }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun has(permission: String) = ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
    private fun nodeStartingOrRunning() = store.isNodeDesired() &&
        (NodeService.isActive() || store.runtimeState() == "connecting")
    private fun openAuthorization(url: String) {
        try {
            CustomTabsIntent.Builder().setShowTitle(true).setShareState(CustomTabsIntent.SHARE_STATE_OFF)
                .setColorScheme(if (palette.dark) CustomTabsIntent.COLOR_SCHEME_DARK else CustomTabsIntent.COLOR_SCHEME_LIGHT)
                .setDefaultColorSchemeParams(CustomTabColorSchemeParams.Builder()
                    .setToolbarColor(palette.canvas).setNavigationBarColor(palette.canvas).build())
                .build().launchUrl(this, Uri.parse(url))
        } catch (error: Exception) { cancelBrowserLogin(); error(error) }
    }
    private fun openAppSettings() { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
    private fun contains(array: JSONArray, id: String) = (0 until array.length()).any { array.optString(it) == id }
    private fun setMember(policy: JSONObject, field: String, id: String, add: Boolean) {
        val values = policy.getJSONArray(field)
        val result = JSONArray()
        for (index in 0 until values.length()) if (values.getString(index) != id) result.put(values.getString(index))
        if (add) result.put(id)
        policy.put(field, result)
    }
}

object URIValidation {
    fun browserUri(value: String, origin: String): String {
        val uri = java.net.URI(value)
        require(uri.scheme == "https" && uri.rawUserInfo == null &&
            java.net.URI(origin).authority == uri.authority && uri.path == "/cli-login" && uri.fragment == null) {
            "ADC returned an invalid login URL."
        }
        return uri.toASCIIString()
    }
}
