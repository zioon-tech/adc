package cloud.agentdevice.node

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.display.DisplayManager
import android.media.AudioManager
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.StatFs
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.view.Display
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt

class AndroidNativeProvider(
    private val context: Context,
    private val store: NodeStore
) : MobileCapabilityProvider {
    override val toolNames = setOf(
        "device.info.get",
        "device.storage.get",
        "device.vibrate",
        "app.open",
        "display.status",
        "audio.status",
        "audio.volume.set",
        "flashlight.status",
        "flashlight.set"
    )

    private val cameraManager = context.getSystemService(CameraManager::class.java)
    private val torchStates = ConcurrentHashMap<String, Boolean>()
    private val torchCallbackRegistered = AtomicBoolean(false)
    private val torchCallback =
        object : CameraManager.TorchCallback() {
            override fun onTorchModeChanged(cameraId: String, enabled: Boolean) {
                torchStates[cameraId] = enabled
            }

            override fun onTorchModeUnavailable(cameraId: String) {
                torchStates.remove(cameraId)
            }
        }

    private fun ensureTorchCallback() {
        if (!hasPermission(Manifest.permission.CAMERA)) return
        if (!torchCallbackRegistered.compareAndSet(false, true)) return
        try {
            cameraManager.registerTorchCallback(
                torchCallback,
                Handler(Looper.getMainLooper())
            )
        } catch (_: Exception) {
            torchCallbackRegistered.set(false)
        }
    }

    override fun close() {
        if (!torchCallbackRegistered.compareAndSet(true, false)) return
        try {
            cameraManager.unregisterTorchCallback(torchCallback)
        } catch (_: Exception) {
            // The camera service may already be unavailable during shutdown.
        } finally {
            torchStates.clear()
        }
    }

    override fun descriptors(observedAt: String): List<JSONObject> =
        listOf(
            descriptor(
                "device.info.get",
                "Device information",
                "Read Android hardware, OS, locale and ADC app details.",
                "read",
                localAvailability(observedAt),
                emptyObjectSchema(),
                objectSchema(
                    "manufacturer",
                    "brand",
                    "model",
                    "device",
                    "product",
                    "androidVersion",
                    "apiLevel",
                    "securityPatch",
                    "supportedAbis",
                    "locale",
                    "timeZone",
                    "uptimeMs",
                    "appVersion"
                )
            ),
            descriptor(
                "device.storage.get",
                "Storage status",
                "Read capacity and available bytes for Android internal storage.",
                "read",
                localAvailability(observedAt),
                emptyObjectSchema(),
                objectSchema("path", "totalBytes", "freeBytes", "availableBytes")
            ),
            descriptor(
                "display.status",
                "Display status",
                "Read display dimensions, density, rotation, refresh rate and power state.",
                "read",
                localAvailability(observedAt),
                emptyObjectSchema(),
                objectSchema(
                    "width",
                    "height",
                    "density",
                    "densityDpi",
                    "rotation",
                    "refreshRateHz",
                    "interactive",
                    "brightness"
                )
            ),
            descriptor(
                "audio.status",
                "Audio status",
                "Read Android ringer state and current stream volumes.",
                "read",
                localAvailability(observedAt),
                emptyObjectSchema(),
                objectSchema("mode", "ringerMode", "microphoneMuted", "streams")
            ),
            descriptor(
                "audio.volume.set",
                "Set audio volume",
                "Set an Android audio stream to a percentage of its supported range.",
                "execute",
                localAvailability(observedAt),
                audioVolumeSchema(),
                objectSchema("stream", "level", "maxLevel", "levelPercent")
            ),
            descriptor(
                "device.vibrate",
                "Vibrate device",
                "Vibrate the Android device for a bounded duration and amplitude.",
                "execute",
                vibrationAvailability(observedAt),
                vibrationSchema(),
                objectSchema("vibrating", "durationMs", "amplitude")
            ),
            descriptor(
                "app.open",
                "Open application",
                "Open an installed launcher application by Android package name.",
                "execute",
                localAvailability(observedAt),
                appOpenSchema(),
                objectSchema(
                    "launched",
                    "packageName",
                    "component",
                    "foregroundConfirmed",
                    "foregroundPackage"
                )
            ),
            descriptor(
                "flashlight.status",
                "Flashlight status",
                "Read available camera flash units and their current torch state.",
                "read",
                flashlightAvailability(observedAt),
                emptyObjectSchema(),
                objectSchema("cameras")
            ),
            descriptor(
                "flashlight.set",
                "Set flashlight",
                "Turn an Android camera flash unit on or off.",
                "execute",
                flashlightAvailability(observedAt),
                flashlightSetSchema(),
                objectSchema("cameraId", "enabled")
            )
        )

    override fun execute(
        tool: String,
        args: JSONObject,
        cancelled: () -> Boolean
    ): MobileCapabilityResult {
        requireEnabled()
        if (cancelled()) {
            throw CapabilityException("cancelled", "Invocation was cancelled.", false)
        }
        val output =
            when (tool) {
                "device.info.get" -> deviceInfo()
                "device.storage.get" -> storageStatus()
                "device.vibrate" -> vibrate(args)
                "app.open" -> openApp(args, cancelled)
                "display.status" -> displayStatus()
                "audio.status" -> audioStatus()
                "audio.volume.set" -> setAudioVolume(args)
                "flashlight.status" -> flashlightStatus()
                "flashlight.set" -> setFlashlight(args)
                else -> throw CapabilityException(
                    "invalid_request",
                    "Capability is not implemented by this Android provider.",
                    false
                )
            }
        return MobileCapabilityResult(output)
    }

    private fun deviceInfo(): JSONObject {
        val locale = context.resources.configuration.locales[0]
        return JSONObject()
            .put("manufacturer", Build.MANUFACTURER)
            .put("brand", Build.BRAND)
            .put("model", Build.MODEL)
            .put("device", Build.DEVICE)
            .put("product", Build.PRODUCT)
            .put("hardware", Build.HARDWARE)
            .put("androidVersion", Build.VERSION.RELEASE)
            .put("apiLevel", Build.VERSION.SDK_INT)
            .put("securityPatch", Build.VERSION.SECURITY_PATCH)
            .put("supportedAbis", JSONArray(Build.SUPPORTED_ABIS.toList()))
            .put("locale", locale.toLanguageTag())
            .put("timeZone", ZoneId.systemDefault().id)
            .put("uptimeMs", SystemClock.elapsedRealtime())
            .put("appVersion", appVersion())
            .put("observedAt", now())
    }

    @Suppress("DEPRECATION")
    private fun appVersion(): String =
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "unknown"

    private fun storageStatus(): JSONObject {
        val directory = Environment.getDataDirectory()
        val stats = StatFs(directory.absolutePath)
        return JSONObject()
            .put("path", directory.absolutePath)
            .put("totalBytes", stats.totalBytes)
            .put("freeBytes", stats.freeBytes)
            .put("availableBytes", stats.availableBytes)
            .put("observedAt", now())
    }

    private fun displayStatus(): JSONObject {
        val metrics = context.resources.displayMetrics
        val display = context.getSystemService(DisplayManager::class.java)
            .getDisplay(Display.DEFAULT_DISPLAY)
        val power = context.getSystemService(PowerManager::class.java)
        val brightness =
            try {
                Settings.System.getInt(context.contentResolver, Settings.System.SCREEN_BRIGHTNESS)
            } catch (_: Settings.SettingNotFoundException) {
                null
            }
        return JSONObject()
            .put("width", metrics.widthPixels)
            .put("height", metrics.heightPixels)
            .put("density", metrics.density.toDouble())
            .put("densityDpi", metrics.densityDpi)
            .put("rotation", display?.rotation ?: 0)
            .put("refreshRateHz", display?.refreshRate?.toDouble() ?: JSONObject.NULL)
            .put("interactive", power.isInteractive)
            .put("brightness", brightness ?: JSONObject.NULL)
            .put("observedAt", now())
    }

    private fun audioStatus(): JSONObject {
        val manager = context.getSystemService(AudioManager::class.java)
        val streams = JSONArray()
        AUDIO_STREAMS.forEach { (name, stream) ->
            streams.put(streamStatus(manager, name, stream))
        }
        return JSONObject()
            .put("mode", audioMode(manager.mode))
            .put("ringerMode", ringerMode(manager.ringerMode))
            .put("microphoneMuted", manager.isMicrophoneMute)
            .put("speakerphoneOn", manager.isSpeakerphoneOn)
            .put("streams", streams)
            .put("observedAt", now())
    }

    private fun setAudioVolume(args: JSONObject): JSONObject {
        val manager = context.getSystemService(AudioManager::class.java)
        val name = args.getString("stream")
        val stream = AUDIO_STREAMS[name]
            ?: throw CapabilityException("invalid_request", "Unsupported audio stream.", false)
        val max = manager.getStreamMaxVolume(stream)
        val minimum = if (Build.VERSION.SDK_INT >= 28) manager.getStreamMinVolume(stream) else 0
        val percent = args.getInt("levelPercent")
        val level = (minimum + ((max - minimum) * percent / 100.0)).roundToInt()
        try {
            manager.setStreamVolume(stream, level, 0)
        } catch (error: SecurityException) {
            throw CapabilityException(
                "denied",
                error.message ?: "Android denied the volume change.",
                false
            )
        }
        return streamStatus(manager, name, stream)
    }

    private fun streamStatus(manager: AudioManager, name: String, stream: Int): JSONObject {
        val max = manager.getStreamMaxVolume(stream)
        val minimum = if (Build.VERSION.SDK_INT >= 28) manager.getStreamMinVolume(stream) else 0
        val current = manager.getStreamVolume(stream)
        val percent =
            if (max == minimum) 0
            else ((current - minimum) * 100.0 / (max - minimum)).roundToInt()
        return JSONObject()
            .put("stream", name)
            .put("level", current)
            .put("minLevel", minimum)
            .put("maxLevel", max)
            .put("levelPercent", percent)
            .put("muted", manager.isStreamMute(stream))
    }

    private fun vibrate(args: JSONObject): JSONObject {
        val vibrator =
            if (Build.VERSION.SDK_INT >= 31) {
                context.getSystemService(VibratorManager::class.java).defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                context.getSystemService(Vibrator::class.java)
            }
        if (!vibrator.hasVibrator()) {
            throw CapabilityException(
                "offline",
                "This Android device does not report a vibrator.",
                false
            )
        }
        val durationMs = args.optLong("durationMs", 300L).coerceIn(1L, 10_000L)
        val amplitude = args.optInt("amplitude", 128).coerceIn(1, 255)
        vibrator.vibrate(VibrationEffect.createOneShot(durationMs, amplitude))
        return JSONObject()
            .put("vibrating", true)
            .put("durationMs", durationMs)
            .put("amplitude", amplitude)
    }

    private fun openApp(args: JSONObject, cancelled: () -> Boolean): JSONObject {
        val packageName = args.getString("packageName")
        val launchIntent = context.packageManager.getLaunchIntentForPackage(packageName)
            ?: throw CapabilityException(
                "not_found",
                "No installed launcher application matched package $packageName.",
                false
            )
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        try {
            context.startActivity(launchIntent)
        } catch (error: Exception) {
            throw CapabilityException(
                "execution_failed",
                error.message ?: "Android could not open the requested application.",
                false
            )
        }
        val waitMs = args.optLong("waitForForegroundMs", 5_000L).coerceIn(0L, 15_000L)
        val deadline = SystemClock.elapsedRealtime() + waitMs
        var foreground = AdcAccessibilityService.currentPackage()
        while (
            AdcAccessibilityService.isConnected() &&
            foreground != packageName &&
            SystemClock.elapsedRealtime() < deadline
        ) {
            if (cancelled()) {
                break
            }
            Thread.sleep(100L)
            foreground = AdcAccessibilityService.currentPackage()
        }
        return JSONObject()
            .put("launched", true)
            .put("packageName", packageName)
            .put(
                "component",
                launchIntent.component?.flattenToShortString() ?: JSONObject.NULL
            )
            .put("foregroundConfirmed", foreground == packageName)
            .put("foregroundPackage", foreground ?: JSONObject.NULL)
    }

    private fun flashlightStatus(): JSONObject {
        requireCameraPermission()
        ensureTorchCallback()
        val cameraIds = flashCameraIds()
        val deadline = SystemClock.elapsedRealtime() + 500L
        while (
            cameraIds.any { !torchStates.containsKey(it) } &&
            SystemClock.elapsedRealtime() < deadline
        ) {
            Thread.sleep(25L)
        }
        val cameras = JSONArray()
        cameraIds.forEach { cameraId ->
            cameras.put(
                JSONObject()
                    .put("cameraId", cameraId)
                    .put("enabled", torchStates[cameraId] ?: JSONObject.NULL)
            )
        }
        return JSONObject().put("cameras", cameras).put("observedAt", now())
    }

    private fun setFlashlight(args: JSONObject): JSONObject {
        requireCameraPermission()
        ensureTorchCallback()
        val available = flashCameraIds()
        val cameraId = args.optString("cameraId").takeIf(String::isNotBlank)
            ?: available.firstOrNull()
            ?: throw CapabilityException(
                "offline",
                "This Android device does not report an available camera flash.",
                false
            )
        if (cameraId !in available) {
            throw CapabilityException(
                "not_found",
                "The requested camera does not expose a flash unit.",
                false
            )
        }
        val enabled = args.getBoolean("enabled")
        try {
            cameraManager.setTorchMode(cameraId, enabled)
        } catch (error: Exception) {
            throw CapabilityException(
                "execution_failed",
                error.message ?: "Android rejected the flashlight change.",
                true
            )
        }
        torchStates[cameraId] = enabled
        return JSONObject().put("cameraId", cameraId).put("enabled", enabled)
    }

    private fun flashCameraIds(): List<String> =
        try {
            cameraManager.cameraIdList.filter { cameraId ->
                cameraManager.getCameraCharacteristics(cameraId)
                    .get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
            }
        } catch (_: Exception) {
            emptyList()
        }

    private fun descriptor(
        name: String,
        title: String,
        description: String,
        risk: String,
        availability: JSONObject,
        inputSchema: JSONObject,
        outputSchema: JSONObject
    ): JSONObject =
        JSONObject()
            .put("name", name)
            .put("version", "0.1.0")
            .put("risk", risk)
            .put("sandboxProfiles", JSONArray().put("native-app"))
            .put("title", title)
            .put("description", description)
            .put("availability", availability)
            .put("inputSchema", inputSchema)
            .put("outputSchema", outputSchema)

    private fun localAvailability(observedAt: String): JSONObject =
        if (store.isCapabilityEnabled(CapabilityGroup.DEVICE_STATUS)) {
            available(observedAt)
        } else {
            unavailable(
                "temporarily_unavailable",
                "Disabled in ADC Mobile Node settings.",
                observedAt
            )
        }

    private fun vibrationAvailability(observedAt: String): JSONObject {
        if (!store.isCapabilityEnabled(CapabilityGroup.DEVICE_STATUS)) {
            return localAvailability(observedAt)
        }
        val vibrator =
            if (Build.VERSION.SDK_INT >= 31) {
                context.getSystemService(VibratorManager::class.java).defaultVibrator
            } else {
                @Suppress("DEPRECATION")
                context.getSystemService(Vibrator::class.java)
            }
        return if (vibrator.hasVibrator()) {
            available(observedAt)
        } else {
            unavailable(
                "temporarily_unavailable",
                "This device has no vibrator.",
                observedAt
            )
        }
    }

    private fun flashlightAvailability(observedAt: String): JSONObject {
        if (!store.isCapabilityEnabled(CapabilityGroup.DEVICE_STATUS)) {
            return localAvailability(observedAt)
        }
        if (!hasPermission(Manifest.permission.CAMERA)) {
            return unavailable(
                "permission_required",
                "Allow camera access for flashlight control.",
                observedAt
            )
        }
        return if (flashCameraIds().isEmpty()) {
            unavailable(
                "temporarily_unavailable",
                "This device has no available camera flash.",
                observedAt
            )
        } else {
            available(observedAt)
        }
    }

    private fun available(observedAt: String): JSONObject =
        JSONObject().put("state", "available").put("observedAt", observedAt)

    private fun unavailable(state: String, reason: String, observedAt: String): JSONObject =
        JSONObject()
            .put("state", state)
            .put("reason", reason)
            .put("observedAt", observedAt)

    private fun requireEnabled() {
        if (!store.isCapabilityEnabled(CapabilityGroup.DEVICE_STATUS)) {
            throw CapabilityException(
                "denied",
                "Device-native capabilities are disabled in ADC Mobile Node settings.",
                false
            )
        }
    }

    private fun requireCameraPermission() {
        if (!hasPermission(Manifest.permission.CAMERA)) {
            throw CapabilityException(
                "denied",
                "Camera permission is required for flashlight control.",
                false
            )
        }
    }

    private fun hasPermission(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    private fun emptyObjectSchema(): JSONObject =
        JSONObject().put("type", "object").put("additionalProperties", false)

    private fun objectSchema(vararg fields: String): JSONObject =
        JSONObject()
            .put("type", "object")
            .put(
                "properties",
                JSONObject().apply {
                    fields.forEach { put(it, JSONObject()) }
                }
            )

    private fun audioVolumeSchema(): JSONObject =
        JSONObject()
            .put("type", "object")
            .put(
                "properties",
                JSONObject()
                    .put(
                        "stream",
                        JSONObject()
                            .put("type", "string")
                            .put("enum", JSONArray(AUDIO_STREAMS.keys.toList()))
                    )
                    .put(
                        "levelPercent",
                        JSONObject()
                            .put("type", "integer")
                            .put("minimum", 0)
                            .put("maximum", 100)
                    )
            )
            .put("required", JSONArray(listOf("stream", "levelPercent")))
            .put("additionalProperties", false)

    private fun vibrationSchema(): JSONObject =
        JSONObject()
            .put("type", "object")
            .put(
                "properties",
                JSONObject()
                    .put(
                        "durationMs",
                        JSONObject()
                            .put("type", "integer")
                            .put("minimum", 1)
                            .put("maximum", 10_000)
                            .put("default", 300)
                    )
                    .put(
                        "amplitude",
                        JSONObject()
                            .put("type", "integer")
                            .put("minimum", 1)
                            .put("maximum", 255)
                            .put("default", 128)
                    )
            )
            .put("additionalProperties", false)

    private fun appOpenSchema(): JSONObject =
        JSONObject()
            .put("type", "object")
            .put(
                "properties",
                JSONObject()
                    .put("packageName", JSONObject().put("type", "string"))
                    .put(
                        "waitForForegroundMs",
                        JSONObject()
                            .put("type", "integer")
                            .put("minimum", 0)
                            .put("maximum", 15_000)
                            .put("default", 5000)
                    )
            )
            .put("required", JSONArray(listOf("packageName")))
            .put("additionalProperties", false)

    private fun flashlightSetSchema(): JSONObject =
        JSONObject()
            .put("type", "object")
            .put(
                "properties",
                JSONObject()
                    .put("enabled", JSONObject().put("type", "boolean"))
                    .put("cameraId", JSONObject().put("type", "string"))
            )
            .put("required", JSONArray(listOf("enabled")))
            .put("additionalProperties", false)

    private fun audioMode(mode: Int): String =
        when (mode) {
            AudioManager.MODE_NORMAL -> "normal"
            AudioManager.MODE_RINGTONE -> "ringtone"
            AudioManager.MODE_IN_CALL -> "in_call"
            AudioManager.MODE_IN_COMMUNICATION -> "in_communication"
            else -> "unknown"
        }

    private fun ringerMode(mode: Int): String =
        when (mode) {
            AudioManager.RINGER_MODE_SILENT -> "silent"
            AudioManager.RINGER_MODE_VIBRATE -> "vibrate"
            AudioManager.RINGER_MODE_NORMAL -> "normal"
            else -> "unknown"
        }

    private fun now(): String = DateTimeFormatter.ISO_INSTANT.format(Instant.now())

    companion object {
        private val AUDIO_STREAMS = linkedMapOf(
            "media" to AudioManager.STREAM_MUSIC,
            "alarm" to AudioManager.STREAM_ALARM,
            "notification" to AudioManager.STREAM_NOTIFICATION,
            "ring" to AudioManager.STREAM_RING,
            "system" to AudioManager.STREAM_SYSTEM,
            "voice_call" to AudioManager.STREAM_VOICE_CALL
        )
    }
}
