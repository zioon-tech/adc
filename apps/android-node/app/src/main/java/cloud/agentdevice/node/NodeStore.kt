package cloud.agentdevice.node

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.spec.ECGenParameterSpec

data class NodeConfig(
    val controlPlaneUrl: String,
    val nodeId: String,
    val accountId: String,
    val label: String
)

enum class CapabilityGroup(
    val preferenceKey: String,
    val defaultEnabled: Boolean
) {
    DEVICE_STATUS("capability_device_status", true),
    LOCATION("capability_location", false),
    NOTIFICATIONS("capability_notifications", false),
    AUDIO_CONTROL("capability_audio_control", false),
    VIBRATION("capability_vibration", false),
    APP_LAUNCH("capability_app_launch", false),
    FLASHLIGHT("capability_flashlight", false),
    SCREEN_CAPTURE("capability_screen_capture", false),
    UI_OBSERVE("capability_ui_observe", false),
    UI_CONTROL("capability_ui_control", false)
}

class NodeStore(context: Context) {
    private val controlContext = context.applicationContext
    private val preferences =
        context.getSharedPreferences("adc_mobile_node", Context.MODE_PRIVATE)

    fun config(): NodeConfig? {
        val url = preferences.getString("controlPlaneUrl", null) ?: return null
        val nodeId = preferences.getString("nodeId", null) ?: return null
        val accountId = preferences.getString("accountId", null) ?: return null
        val label = preferences.getString("label", null) ?: return null
        return NodeConfig(url, nodeId, accountId, label)
    }

    fun saveConfig(config: NodeConfig) {
        check(
            preferences.edit()
                .putString("controlPlaneUrl", config.controlPlaneUrl)
                .putString("nodeId", config.nodeId)
                .putString("accountId", config.accountId)
                .putString("label", config.label)
                .commit()
        ) { "Unable to persist paired node configuration" }
    }

    /** The official legacy ADC endpoint shares the same database and Node identities. */
    fun migrateOfficialOrigin() {
        val config = config() ?: return
        if (config.controlPlaneUrl == "https://adc.47-101-150-8.nip.io:8443") {
            saveConfig(config.copy(controlPlaneUrl = "https://adc.zioon.tech"))
        }
    }

    fun clearConfig() {
        val editor = preferences.edit()
        listOf("controlPlaneUrl", "nodeId", "accountId", "label", "lastSeenAt", "lastError",
            "nodeDesired", "runtimeState").forEach { editor.remove(it) }
        check(editor.commit()) {
            "Unable to remove the local pairing configuration"
        }
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        if (keyStore.containsAlias(KEY_ALIAS)) keyStore.deleteEntry(KEY_ALIAS)
    }

    fun setConnectionState(lastSeenAt: String?, error: String?) {
        preferences.edit()
            .apply {
                if (lastSeenAt != null) putString("lastSeenAt", lastSeenAt)
                if (error == null) remove("lastError") else putString("lastError", error.take(500))
            }
            .apply()
    }

    fun lastSeenAt(): String? = preferences.getString("lastSeenAt", null)

    fun lastError(): String? = preferences.getString("lastError", null)

    fun isNodeDesired(): Boolean = preferences.getBoolean("nodeDesired", false)

    fun setNodeDesired(enabled: Boolean) {
        check(preferences.edit().putBoolean("nodeDesired", enabled).commit())
    }

    fun runtimeState(): String = preferences.getString("runtimeState", "stopped") ?: "stopped"

    fun setRuntimeState(state: String) {
        preferences.edit().putString("runtimeState", state).apply()
    }

    fun setLastUpdateCheckAt(value: String) {
        preferences.edit().putString("lastUpdateCheckAt", value).apply()
    }

    fun lastUpdateCheckAt(): String? = preferences.getString("lastUpdateCheckAt", null)

    fun isCapabilityEnabled(group: CapabilityGroup): Boolean =
        preferences.getBoolean(group.preferenceKey, group.defaultEnabled)

    fun setCapabilityEnabled(group: CapabilityGroup, enabled: Boolean) {
        check(preferences.edit().putBoolean(group.preferenceKey, enabled).commit()) {
            "Unable to persist the local capability setting"
        }
        if (!enabled && group in setOf(CapabilityGroup.UI_CONTROL, CapabilityGroup.UI_OBSERVE)) {
            ScreenControl.get(controlContext).interrupt("permission")
        }
    }

    fun readIdempotency(key: String): String? =
        preferences.getString("$IDEMPOTENCY_PREFIX$key", null)

    @Synchronized
    fun writeIdempotency(key: String, value: String): Boolean {
        val written = preferences.edit()
            .putString("$IDEMPOTENCY_PREFIX$key", value)
            .commit()
        if (written) pruneIdempotencyEntries()
        return written
    }

    private fun pruneIdempotencyEntries() {
        val entries = preferences.all
            .filterKeys { it.startsWith(IDEMPOTENCY_PREFIX) }
            .map { (key, value) ->
                val updatedAt =
                    try {
                        JSONObject(value as? String ?: "").optString("updatedAt")
                    } catch (_: Exception) {
                        ""
                    }
                key to updatedAt
            }
            .sortedBy { it.second }
        if (entries.size <= MAX_IDEMPOTENCY_ENTRIES) return
        val editor = preferences.edit()
        entries.take(entries.size - MAX_IDEMPOTENCY_ENTRIES).forEach { editor.remove(it.first) }
        editor.apply()
    }

    fun publicKeyPem(): String {
        val encoded = keyPair().public.encoded
        val body = Base64.encodeToString(encoded, Base64.NO_WRAP).chunked(64).joinToString("\n")
        return "-----BEGIN PUBLIC KEY-----\n$body\n-----END PUBLIC KEY-----\n"
    }

    fun privateKey(): PrivateKey = keyPair().private

    private fun keyPair(): java.security.KeyPair {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        val existingPrivate = keyStore.getKey(KEY_ALIAS, null) as? PrivateKey
        val existingPublic = keyStore.getCertificate(KEY_ALIAS)?.publicKey
        if (existingPrivate != null && existingPublic != null) {
            return java.security.KeyPair(existingPublic, existingPrivate)
        }
        val generator = KeyPairGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_EC,
            KEYSTORE
        )
        generator.initialize(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
            )
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .build()
        )
        return generator.generateKeyPair()
    }

    companion object {
        private const val KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "adc-mobile-node-identity-v1"
        private const val IDEMPOTENCY_PREFIX = "idem_"
        private const val MAX_IDEMPOTENCY_ENTRIES = 256
    }
}
