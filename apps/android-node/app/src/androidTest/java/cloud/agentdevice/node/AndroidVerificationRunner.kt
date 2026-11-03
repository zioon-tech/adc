package cloud.agentdevice.node

import android.app.Instrumentation
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.SharedPreferences
import android.os.Bundle
import org.json.JSONObject
import java.time.Instant

/** Checks real Keystore and native permission boundaries without touching the user's Node keys. */
class AndroidVerificationRunner : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        val result = Bundle()
        val completed = mutableListOf<String>()
        val isolated = object : ContextWrapper(targetContext) {
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences =
                super.getSharedPreferences("verification_$name", mode)
        }
        val nodePrefs = isolated.getSharedPreferences("adc_mobile_node", Context.MODE_PRIVATE)
        val accountPrefs = isolated.getSharedPreferences("adc_account", Context.MODE_PRIVATE)
        nodePrefs.edit().clear().commit(); accountPrefs.edit().clear().commit()
        try {
            val store = NodeStore(isolated)
            val accounts = AccountStore(isolated)
            val receipt = """{"status":"completed","updatedAt":"2026-11-04T00:00:00Z"}"""
            check(store.writeIdempotency("verification", receipt))
            val session = AccountSession("https://adc.zioon.tech", "verification-secret-only",
                JSONObject("""{"kind":"session","user":{"email":"test@example.invalid"}}"""))
            accounts.save(session)
            check(!accountPrefs.all.toString().contains("verification-secret-only"))
            check(accounts.session()?.token == session.token)
            completed += "Android Keystore AES-GCM encrypt/decrypt"
            accounts.clear()
            check(accounts.session() == null)
            check(store.readIdempotency("verification") == receipt)
            completed += "Account logout preserves Node receipts"

            check(CapabilityGroup.entries.filter { it != CapabilityGroup.DEVICE_STATUS }
                .none { store.isCapabilityEnabled(it) })
            val provider = AndroidNativeProvider(isolated, store)
            val descriptors = provider.descriptors(Instant.now().toString()).associateBy { it.getString("name") }
            for (tool in listOf("audio.volume.set", "device.vibrate", "app.open", "flashlight.set")) {
                check(descriptors.getValue(tool).getJSONObject("availability").getString("state") != "available")
                var denied = false
                try { provider.execute(tool, JSONObject()) { false } }
                catch (error: CapabilityException) { check(error.code == "denied"); denied = true }
                check(denied) { "Mutation was not blocked: $tool" }
            }
            check(descriptors.getValue("device.info.get").getJSONObject("availability").getString("state") == "available")
            provider.close()
            completed += "Read-only status cannot enable four native mutations"

            val activity = startActivitySync(Intent(targetContext, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            waitForIdleSync()
            check(!activity.isFinishing)
            completed += "Native three-tab activity launches"
            result.putString("stream", "Passed ${completed.size} physical-device checks:\n${completed.joinToString("\n")}\n")
            finish(-1, result)
        } catch (error: Throwable) {
            result.putString("stream", "Failed after ${completed.size} checks: ${error.stackTraceToString()}")
            finish(0, result)
        } finally {
            nodePrefs.edit().clear().commit(); accountPrefs.edit().clear().commit()
        }
    }
}
