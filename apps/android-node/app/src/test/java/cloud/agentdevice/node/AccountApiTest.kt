package cloud.agentdevice.node

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AccountApiTest {
    @Test fun requiresAnExactHttpsOriginForCredentials() {
        assertEquals("https://adc.zioon.tech", AccountApi.normalizeOrigin(" https://adc.zioon.tech/ "))
        listOf("http://adc.zioon.tech", "https://user:secret@adc.zioon.tech",
            "https://adc.zioon.tech/api", "https://adc.zioon.tech?redirect=x",
            "https://adc.zioon.tech#other", "https:///missing-host").forEach { value ->
            assertThrows(IllegalArgumentException::class.java) { AccountApi.normalizeOrigin(value) }
        }
    }
    @Test fun renamePreservesNarrowPolicyAndRevision() {
        val policy = JSONObject("""{"rootAccess":"selected","rootIds":["root_one"],"readOnlyRootIds":["root_one"],"allowExecution":false,"maxConcurrency":2}""")
        val node = JSONObject().put("revision", 19)
        val body = AccountApi.deviceMutation(node, " My phone ", " Notes ", policy)
        assertEquals(19, body.getInt("revision"))
        assertEquals("My phone", body.getString("label"))
        assertEquals(policy.toString(), body.getJSONObject("accessPolicy").toString())
        policy.put("allowExecution", true)
        assertFalse(body.getJSONObject("accessPolicy").getBoolean("allowExecution"))
    }
    @Test fun browserLoginCannotOpenAnotherOriginOrPage() {
        val origin = "https://adc.zioon.tech"
        val valid = "$origin/cli-login?user_code=ABCD-EFGH"
        assertEquals(valid, URIValidation.browserUri(valid, origin))
        listOf("https://evil.example/cli-login", "$origin/app", "$origin/cli-login#x",
            "https://user:secret@adc.zioon.tech/cli-login").forEach { value ->
            assertThrows(IllegalArgumentException::class.java) { URIValidation.browserUri(value, origin) }
        }
    }
    @Test fun nativeMutationsNeverUseReadOnlyDeviceStatusPermission() {
        assertEquals(CapabilityGroup.AUDIO_CONTROL, NativeToolPolicy.group("audio.volume.set"))
        assertEquals(CapabilityGroup.VIBRATION, NativeToolPolicy.group("device.vibrate"))
        assertEquals(CapabilityGroup.APP_LAUNCH, NativeToolPolicy.group("app.open"))
        assertEquals(CapabilityGroup.FLASHLIGHT, NativeToolPolicy.group("flashlight.set"))
        assertEquals(CapabilityGroup.DEVICE_STATUS, NativeToolPolicy.group("audio.status"))
        assertThrows(IllegalArgumentException::class.java) { NativeToolPolicy.group("future.mutation") }
    }
}
