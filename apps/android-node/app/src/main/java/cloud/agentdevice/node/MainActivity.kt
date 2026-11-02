package cloud.agentdevice.node

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
    private val executor = Executors.newSingleThreadExecutor()
    private lateinit var store: NodeStore
    private lateinit var registry: CapabilityRegistry
    private lateinit var updateManager: AndroidUpdateManager
    private lateinit var status: TextView
    private lateinit var capabilities: TextView
    private lateinit var versionStatus: TextView
    private lateinit var urlInput: TextInputEditText
    private lateinit var codeInput: TextInputEditText
    private lateinit var labelInput: TextInputEditText
    private lateinit var pairButton: MaterialButton
    private lateinit var startButton: MaterialButton
    private lateinit var stopButton: MaterialButton
    private lateinit var deviceStatusSwitch: MaterialSwitch
    private lateinit var locationSwitch: MaterialSwitch
    private lateinit var notificationSwitch: MaterialSwitch
    private lateinit var screenCaptureSwitch: MaterialSwitch
    private lateinit var uiControlSwitch: MaterialSwitch
    private lateinit var checkUpdateButton: MaterialButton
    private lateinit var releaseNotesButton: MaterialButton
    private lateinit var installUpdateButton: MaterialButton
    private var latestRelease: AndroidRelease? = null
    private var pendingUpdateApk: File? = null
    private var checkedForUpdatesThisSession = false
    private var updateBusy = false
    private var bindingSwitches = false

    private val installPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
            val apk = pendingUpdateApk ?: return@registerForActivityResult
            if (updateManager.canRequestPackageInstalls()) {
                pendingUpdateApk = null
                launchVerifiedUpdate(apk)
            } else {
                versionStatus.text =
                    "The update is verified. Allow installs from ADC Mobile Node, then tap Install update again."
                setUpdateBusy(false)
            }
        }

    private val screenCaptureLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            if (!::store.isInitialized) return@registerForActivityResult
            val granted = result.resultCode == RESULT_OK && result.data != null
            store.setCapabilityEnabled(CapabilityGroup.SCREEN_CAPTURE, granted)
            if (granted) {
                NodeService.startScreenCapture(this, result.resultCode, result.data!!)
            } else {
                NodeService.stopScreenCapture(this)
            }
            bindCapabilitySwitches()
            renderCapabilities()
        }

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            renderStatus(
                intent?.getBooleanExtra(NodeService.EXTRA_CONNECTED, false) == true,
                intent?.getStringExtra(NodeService.EXTRA_ERROR)
            )
        }
    }

    private val capabilityReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            bindCapabilitySwitches()
            renderCapabilities()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = NodeStore(this)
        registry = CapabilityRegistry(this)
        updateManager = AndroidUpdateManager(this)
        setContentView(buildContent())
        bindState()
        ContextCompat.registerReceiver(
            this,
            statusReceiver,
            IntentFilter(NodeService.ACTION_STATUS),
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        ContextCompat.registerReceiver(
            this,
            capabilityReceiver,
            IntentFilter().apply {
                addAction(AdcAccessibilityService.ACTION_CAPABILITY_CHANGED)
                addAction(ScreenCaptureSession.ACTION_CAPABILITY_CHANGED)
            },
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
    }

    override fun onResume() {
        super.onResume()
        AppVisibility.setForeground(true)
        bindCapabilitySwitches()
        renderCapabilities()
        renderStoredStatus()
        maybeCheckForUpdates()
    }

    override fun onPause() {
        AppVisibility.setForeground(false)
        super.onPause()
    }

    override fun onDestroy() {
        unregisterReceiver(statusReceiver)
        unregisterReceiver(capabilityReceiver)
        executor.shutdownNow()
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        renderCapabilities()
    }

    private fun buildContent(): ScrollView {
        val scroll = ScrollView(this).apply {
            setBackgroundColor(0xfff7f8fa.toInt())
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(28), dp(20), dp(36))
        }
        scroll.addView(
            root,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        )

        root.addView(text("ADC Mobile Node", 26f, Typeface.BOLD))
        root.addView(
            text(
                "Expose selected phone capabilities to authorized Agents. Android permissions remain the final boundary.",
                15f,
                Typeface.NORMAL
            ).withMargins(bottom = 20)
        )

        status = text("Not paired", 15f, Typeface.BOLD)
        root.addView(card(status).withMargins(bottom = 18))

        root.addView(sectionTitle("Pair this phone"))
        val urlField = input("ADC HTTPS URL", "https://devices.example.com")
        val codeField = input("Pairing code", "Create one from ADC Devices")
        val labelField = input(
            "Device name",
            defaultDeviceName()
        )
        urlInput = urlField.editText as TextInputEditText
        codeInput = codeField.editText as TextInputEditText
        labelInput = labelField.editText as TextInputEditText
        root.addView(urlField)
        root.addView(codeField.withMargins(top = 8))
        root.addView(labelField.withMargins(top = 8))
        pairButton = button("Pair and start") { pair() }
        root.addView(pairButton.withMargins(top = 12, bottom = 24))

        root.addView(sectionTitle("Node session"))
        val controls = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }
        startButton = button("Start") { NodeService.start(this) }
        stopButton = button("Stop") { NodeService.stop(this) }
        controls.addView(
            startButton,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                .apply { marginEnd = dp(6) }
        )
        controls.addView(
            stopButton,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                .apply { marginStart = dp(6) }
        )
        root.addView(controls.withMargins(bottom = 24))

        root.addView(sectionTitle("Phone permissions"))
        deviceStatusSwitch = capabilitySwitch(
            "Device status",
            CapabilityGroup.DEVICE_STATUS
        )
        locationSwitch = capabilitySwitch(
            "Location while this app is open",
            CapabilityGroup.LOCATION,
            onEnabled = ::requestLocation
        )
        notificationSwitch = capabilitySwitch(
            "Agent notifications",
            CapabilityGroup.NOTIFICATIONS,
            onEnabled = ::requestNotifications
        )
        screenCaptureSwitch = capabilitySwitch(
            "Screen capture",
            CapabilityGroup.SCREEN_CAPTURE,
            onEnabled = ::requestScreenCapture,
            onDisabled = { NodeService.stopScreenCapture(this) }
        )
        uiControlSwitch = capabilitySwitch(
            "UI inspection and control",
            CapabilityGroup.UI_CONTROL,
            onEnabled = ::openAccessibilitySettings
        )
        root.addView(deviceStatusSwitch)
        root.addView(locationSwitch.withMargins(top = 4))
        root.addView(notificationSwitch.withMargins(top = 4))
        root.addView(screenCaptureSwitch.withMargins(top = 4))
        root.addView(uiControlSwitch.withMargins(top = 4))
        root.addView(
            button("Request Android permissions") { requestPhonePermissions() }
                .withMargins(top = 8)
        )

        root.addView(sectionTitle("Advertised capabilities").withMargins(top = 24))
        capabilities = text("", 14f, Typeface.NORMAL)
        root.addView(card(capabilities))

        root.addView(sectionTitle("Version & updates").withMargins(top = 24))
        versionStatus = text("", 14f, Typeface.NORMAL)
        checkUpdateButton = button("Check now") { checkForUpdates(showErrors = true) }
        releaseNotesButton = button("Release notes") { showReleaseNotes() }.apply {
            visibility = View.GONE
        }
        installUpdateButton = button("Install update") { downloadAndInstallUpdate() }.apply {
            visibility = View.GONE
        }
        val versionActions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(
                checkUpdateButton,
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                    .apply { marginEnd = dp(6) }
            )
            addView(
                releaseNotesButton,
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
                    .apply { marginStart = dp(6) }
            )
        }
        val versionContent = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(14))
            addView(versionStatus)
            addView(versionActions.withMargins(top = 12))
            addView(installUpdateButton.withMargins(top = 8))
        }
        root.addView(card(versionContent))

        root.addView(
            button("Forget local pairing") { confirmForget() }.withMargins(top = 24)
        )
        return scroll
    }

    private fun bindState() {
        val config = store.config()
        if (config != null) {
            urlInput.setText(config.controlPlaneUrl)
            labelInput.setText(config.label)
            codeInput.setText("")
        } else {
            labelInput.setText(
                defaultDeviceName()
            )
        }
        pairButton.isEnabled = config == null
        startButton.isEnabled = config != null
        stopButton.isEnabled = config != null
        bindCapabilitySwitches()
        renderStoredStatus()
        renderCapabilities()
        renderInitialVersionStatus()
    }

    private fun pair() {
        val url = urlInput.text?.toString()?.trim()?.trimEnd('/').orEmpty()
        val code = codeInput.text?.toString()?.trim().orEmpty()
        val label = labelInput.text?.toString()?.trim().orEmpty()
        val uri =
            try {
                URI(url)
            } catch (_: Exception) {
                null
            }
        if (uri?.scheme != "https" || uri.host.isNullOrBlank()) {
            showError("Use the HTTPS origin shown by your ADC installation.")
            return
        }
        if (code.length < 8 || label.isBlank()) {
            showError("Enter a valid pairing code and device name.")
            return
        }
        pairButton.isEnabled = false
        status.setText(R.string.node_pairing)
        executor.execute {
            try {
                val config = NodeProtocol(store).pair(url, code, label)
                store.saveConfig(config)
                runOnUiThread {
                    codeInput.setText("")
                    bindState()
                    NodeService.start(this)
                }
            } catch (error: Exception) {
                runOnUiThread {
                    pairButton.isEnabled = true
                    showError(error.message ?: "Pairing failed.")
                    renderStoredStatus()
                }
            }
        }
    }

    private fun requestLocation() {
        requestPermissions(
            arrayOf(
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.ACCESS_FINE_LOCATION
            ),
            REQUEST_LOCATION
        )
    }

    private fun requestNotifications() {
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
        }
    }

    private fun requestPhonePermissions() {
        val permissions = mutableListOf(
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.CAMERA
        )
        if (Build.VERSION.SDK_INT >= 33) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        requestPermissions(permissions.toTypedArray(), REQUEST_PHONE_PERMISSIONS)
    }

    private fun requestScreenCapture() {
        val manager = getSystemService(MediaProjectionManager::class.java)
        screenCaptureLauncher.launch(manager.createScreenCaptureIntent())
    }

    private fun openAccessibilitySettings() {
        startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
    }

    private fun confirmForget() {
        if (store.config() == null) return
        MaterialAlertDialogBuilder(this)
            .setTitle("Forget this pairing?")
            .setMessage(
                "This removes the phone identity locally. The old device remains offline in ADC until you remove it there."
            )
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Forget") { _, _ ->
                NodeService.stop(this)
                try {
                    store.clearConfig()
                    bindState()
                } catch (error: Exception) {
                    showError(error.message ?: "Unable to remove the local pairing.")
                }
            }
            .show()
    }

    private fun renderStoredStatus() {
        val config = store.config()
        if (config == null) {
            status.setText(R.string.node_not_paired)
            return
        }
        val error = store.lastError()
        status.text =
            if (error != null) {
                "${config.label}\nDisconnected: $error"
            } else {
                "${config.label}\nLast connected: ${store.lastSeenAt() ?: "not yet"}"
            }
    }

    private fun renderStatus(connected: Boolean, error: String?) {
        val config = store.config()
        status.text =
            when {
                config == null -> "Not paired"
                connected -> "${config.label}\nConnected to ${config.controlPlaneUrl}"
                else -> "${config.label}\n${error ?: "Disconnected"}"
            }
        renderCapabilities()
    }

    private fun renderCapabilities() {
        val nodeId = store.config()?.nodeId ?: "node_pending"
        val tools = registry.manifest(nodeId).getJSONArray("tools")
        val lines = buildList {
            for (index in 0 until tools.length()) {
                val tool = tools.getJSONObject(index)
                val availability = tool.getJSONObject("availability")
                add(
                    "${tool.getString("name")}\n" +
                        "  ${availability.getString("state")}" +
                        availability.optString("reason")
                            .takeIf(String::isNotBlank)
                            ?.let { " · $it" }
                            .orEmpty()
                )
            }
        }
        capabilities.text = lines.joinToString("\n\n")
    }

    private fun maybeCheckForUpdates() {
        if (checkedForUpdatesThisSession || store.config() == null) return
        val lastCheck =
            try {
                store.lastUpdateCheckAt()?.let(Instant::parse)
            } catch (_: Exception) {
                null
            }
        if (
            lastCheck != null &&
            Duration.between(lastCheck, Instant.now()) < AUTO_UPDATE_CHECK_INTERVAL
        ) {
            return
        }
        checkForUpdates(showErrors = false)
    }

    private fun checkForUpdates(showErrors: Boolean) {
        if (updateBusy) return
        val controlPlaneUrl =
            store.config()?.controlPlaneUrl
                ?: urlInput.text?.toString()?.trim()?.trimEnd('/').orEmpty()
        checkedForUpdatesThisSession = true
        latestRelease = null
        pendingUpdateApk = null
        releaseNotesButton.visibility = View.GONE
        installUpdateButton.visibility = View.GONE
        setUpdateBusy(true)
        versionStatus.text = "${installedVersionLabel()}\nChecking for Android updates…"
        executor.execute {
            try {
                val release = updateManager.check(controlPlaneUrl)
                val checkedAt = Instant.now()
                store.setLastUpdateCheckAt(checkedAt.toString())
                runOnUiThread {
                    latestRelease = release
                    pendingUpdateApk = null
                    renderRelease(release, checkedAt)
                    setUpdateBusy(false)
                }
            } catch (error: Exception) {
                val checkedAt = Instant.now()
                store.setLastUpdateCheckAt(checkedAt.toString())
                val message = error.message ?: "Update check failed."
                runOnUiThread {
                    latestRelease = null
                    pendingUpdateApk = null
                    releaseNotesButton.visibility = View.GONE
                    installUpdateButton.visibility = View.GONE
                    versionStatus.text =
                        "${installedVersionLabel()}\nUnable to check: $message\nLast checked: ${formatTime(checkedAt)}"
                    setUpdateBusy(false)
                    if (showErrors) showError(message)
                }
            }
        }
    }

    private fun renderInitialVersionStatus() {
        if (!::versionStatus.isInitialized || updateBusy || latestRelease != null) return
        val lastCheck =
            try {
                store.lastUpdateCheckAt()?.let(Instant::parse)
            } catch (_: Exception) {
                null
            }
        versionStatus.text = buildString {
            append(installedVersionLabel())
            append("\nTap Check now to query this ADC server.")
            if (lastCheck != null) append("\nLast checked: ").append(formatTime(lastCheck))
        }
    }

    private fun renderRelease(release: AndroidRelease?, checkedAt: Instant) {
        releaseNotesButton.visibility = if (release == null) View.GONE else View.VISIBLE
        val (_, currentVersionCode) = updateManager.currentVersion()
        val updateAvailable =
            release != null &&
                AndroidUpdateManager.isUpdateAvailable(currentVersionCode, release.versionCode)
        val compatible = release != null && release.minSdk <= Build.VERSION.SDK_INT
        installUpdateButton.visibility =
            if (updateAvailable && compatible) View.VISIBLE else View.GONE
        versionStatus.text = buildString {
            append(installedVersionLabel())
            when {
                release == null -> {
                    append("\nThis ADC server has not published an Android release.")
                }
                !updateAvailable -> {
                    append("\nYou are up to date.")
                    append("\nPublished: ").append(formatTime(release.publishedAt))
                }
                !compatible -> {
                    append("\nVersion ").append(release.versionName).append(" is available.")
                    append("\nAndroid ").append(release.minSdk).append(" or later is required.")
                }
                else -> {
                    append("\nVersion ").append(release.versionName).append(" is available")
                    if (release.required) append(" (required)")
                    append(".")
                    append("\nPublished: ").append(formatTime(release.publishedAt))
                }
            }
            append("\nLast checked: ").append(formatTime(checkedAt))
        }
    }

    private fun showReleaseNotes() {
        val release = latestRelease ?: return
        MaterialAlertDialogBuilder(this)
            .setTitle("Version ${release.versionName}")
            .setMessage(release.notesFor())
            .setPositiveButton("Close", null)
            .show()
    }

    private fun downloadAndInstallUpdate() {
        if (updateBusy) return
        val release = latestRelease ?: return
        val existing = pendingUpdateApk
        if (existing != null && existing.isFile) {
            continueInstall(existing)
            return
        }
        setUpdateBusy(true)
        versionStatus.text =
            "${installedVersionLabel()}\nDownloading and verifying version ${release.versionName}…"
        executor.execute {
            try {
                val apk = updateManager.downloadAndVerify(release)
                runOnUiThread {
                    pendingUpdateApk = apk
                    continueInstall(apk)
                }
            } catch (error: Exception) {
                val message = error.message ?: "Unable to verify the Android update."
                runOnUiThread {
                    versionStatus.text = "${installedVersionLabel()}\nUpdate failed: $message"
                    setUpdateBusy(false)
                    showError(message)
                }
            }
        }
    }

    private fun continueInstall(apk: File) {
        if (!updateManager.canRequestPackageInstalls()) {
            versionStatus.text =
                "${installedVersionLabel()}\nThe update is verified. Allow installs from ADC Mobile Node to continue."
            installPermissionLauncher.launch(updateManager.installPermissionIntent())
            return
        }
        pendingUpdateApk = null
        launchVerifiedUpdate(apk)
    }

    private fun launchVerifiedUpdate(apk: File) {
        try {
            versionStatus.text =
                "${installedVersionLabel()}\nUpdate verified. Confirm installation in Android."
            updateManager.launchInstaller(apk)
        } catch (error: Exception) {
            pendingUpdateApk = apk
            val message = error.message ?: "Unable to open the Android package installer."
            versionStatus.text = "${installedVersionLabel()}\n$message"
            showError(message)
        } finally {
            setUpdateBusy(false)
        }
    }

    private fun setUpdateBusy(busy: Boolean) {
        updateBusy = busy
        checkUpdateButton.isEnabled = !busy
        releaseNotesButton.isEnabled = !busy
        installUpdateButton.isEnabled = !busy
    }

    private fun installedVersionLabel(): String {
        val (versionName, versionCode) = updateManager.currentVersion()
        return "Installed: $versionName ($versionCode)"
    }

    private fun formatTime(value: Instant): String = UPDATE_TIME_FORMAT.format(value)

    private fun showError(message: String) {
        MaterialAlertDialogBuilder(this)
            .setTitle("Unable to continue")
            .setMessage(message)
            .setPositiveButton("OK", null)
            .show()
    }

    private fun input(label: String, hint: String): TextInputLayout {
        val edit = TextInputEditText(this).apply {
            this.hint = hint
            setSingleLine(true)
        }
        return TextInputLayout(this).apply {
            this.hint = label
            addView(
                edit,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
            )
        }
    }

    private fun button(label: String, action: () -> Unit): MaterialButton =
        MaterialButton(this).apply {
            text = label
            setOnClickListener { action() }
        }

    private fun capabilitySwitch(
        label: String,
        group: CapabilityGroup,
        onEnabled: (() -> Unit)? = null,
        onDisabled: (() -> Unit)? = null
    ): MaterialSwitch =
        MaterialSwitch(this).apply {
            text = label
            showText = false
            textOn = ""
            textOff = ""
            isClickable = true
            isFocusable = true
            isChecked = store.isCapabilityEnabled(group)
            setOnCheckedChangeListener { _, checked ->
                if (bindingSwitches) return@setOnCheckedChangeListener
                store.setCapabilityEnabled(group, checked)
                if (checked) onEnabled?.invoke() else onDisabled?.invoke()
                renderCapabilities()
            }
        }

    private fun bindCapabilitySwitches() {
        if (!::deviceStatusSwitch.isInitialized) return
        bindingSwitches = true
        try {
            deviceStatusSwitch.isChecked =
                store.isCapabilityEnabled(CapabilityGroup.DEVICE_STATUS)
            locationSwitch.isChecked =
                store.isCapabilityEnabled(CapabilityGroup.LOCATION)
            notificationSwitch.isChecked =
                store.isCapabilityEnabled(CapabilityGroup.NOTIFICATIONS)
            screenCaptureSwitch.isChecked =
                store.isCapabilityEnabled(CapabilityGroup.SCREEN_CAPTURE)
            uiControlSwitch.isChecked =
                store.isCapabilityEnabled(CapabilityGroup.UI_CONTROL)
        } finally {
            bindingSwitches = false
        }
    }

    private fun sectionTitle(value: String): TextView =
        text(value, 17f, Typeface.BOLD).withMargins(bottom = 10)

    private fun text(value: String, size: Float, style: Int): TextView =
        TextView(this).apply {
            text = value
            textSize = size
            setTypeface(typeface, style)
            setTextColor(0xff172033.toInt())
            setLineSpacing(0f, 1.12f)
        }

    private fun card(content: View): MaterialCardView =
        MaterialCardView(this).apply {
            radius = dp(8).toFloat()
            strokeWidth = dp(1)
            strokeColor = 0xffd8dde8.toInt()
            setCardBackgroundColor(0xffffffff.toInt())
            if (content.paddingLeft == 0 && content.paddingTop == 0) {
                content.setPadding(dp(16), dp(14), dp(16), dp(14))
            }
            addView(content)
        }

    private fun <T : android.view.View> T.withMargins(
        left: Int = 0,
        top: Int = 0,
        right: Int = 0,
        bottom: Int = 0
    ): T {
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        ).apply {
            setMargins(dp(left), dp(top), dp(right), dp(bottom))
        }
        return this
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun defaultDeviceName(): String =
        getString(
            R.string.default_device_name,
            Build.MANUFACTURER.replaceFirstChar(Char::uppercase),
            Build.MODEL
        )

    companion object {
        private const val REQUEST_LOCATION = 101
        private const val REQUEST_NOTIFICATIONS = 102
        private const val REQUEST_PHONE_PERMISSIONS = 103
        private val AUTO_UPDATE_CHECK_INTERVAL = Duration.ofHours(24)
        private val UPDATE_TIME_FORMAT =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
                .withZone(ZoneId.systemDefault())
    }
}
