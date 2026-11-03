package cloud.agentdevice.node

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class AccountSession(val origin: String, val token: String, val me: JSONObject)

/** Account sessions are encrypted separately from the phone's signed Node identity. */
class AccountStore(context: Context) {
    private val prefs = context.getSharedPreferences("adc_account", Context.MODE_PRIVATE)
    fun origin(): String = prefs.getString("origin", "https://adc.zioon.tech")!!
    fun setOrigin(origin: String) { check(prefs.edit().putString("origin", origin).commit()) }

    @Synchronized fun session(): AccountSession? {
        val stored = prefs.getString("session", null) ?: return null
        return try {
            val parts = stored.split(".")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(),
                GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
            val json = JSONObject(String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8))
            AccountSession(json.getString("origin"), json.getString("token"), json.getJSONObject("me"))
        } catch (_: Exception) {
            clear()
            null
        }
    }

    @Synchronized fun save(session: AccountSession) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val content = JSONObject().put("origin", session.origin).put("token", session.token)
            .put("me", session.me).toString().toByteArray(Charsets.UTF_8)
        val encrypted = "${Base64.encodeToString(cipher.iv, Base64.NO_WRAP)}." +
            Base64.encodeToString(cipher.doFinal(content), Base64.NO_WRAP)
        check(prefs.edit().putString("session", encrypted).putString("origin", session.origin).commit())
    }

    @Synchronized fun clear() { check(prefs.edit().remove("session").commit()) }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build())
        }.generateKey()
    }
    companion object { private const val ALIAS = "adc-android-account-v1" }
}
