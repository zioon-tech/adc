package cloud.agentdevice.node

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.util.concurrent.TimeUnit

class AccountApiException(val status: Int, val code: String, message: String) : Exception(message)

class AccountApi(origin: String, private val token: String? = null) {
    val origin = normalizeOrigin(origin)
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(25, TimeUnit.SECONDS).build()

    fun request(method: String, path: String, body: JSONObject? = null): JSONObject {
        require(path.startsWith("/api/") && !path.contains(".."))
        val builder = Request.Builder().url("$origin$path").header("accept", "application/json")
            .header("origin", origin)
        token?.let { builder.header("authorization", "Bearer $it") }
        builder.method(method, if (method == "GET") null else
            (body ?: JSONObject()).toString().toRequestBody("application/json".toMediaType()))
        client.newCall(builder.build()).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val json = try { if (text.isBlank()) JSONObject() else JSONObject(text) }
                catch (_: Exception) { throw AccountApiException(response.code, "invalid_response", "ADC returned an invalid response.") }
            if (!response.isSuccessful) {
                val detail = json.optJSONObject("error")
                throw AccountApiException(response.code,
                    detail?.optString("code") ?: json.optString("error", "request_failed"),
                    detail?.optString("message") ?: json.optString("error_description",
                        json.optString("message", "ADC returned HTTP ${response.code}")))
            }
            return json
        }
    }

    fun signIn(email: String, password: String): AccountSession {
        val response = request("POST", "/api/auth/sign-in/email",
            JSONObject().put("email", email).put("password", password))
        val token = response.getString("token")
        val me = AccountApi(origin, token).me()
        return AccountSession(origin, token, me)
    }
    fun me(): JSONObject = request("GET", "/api/v1/me").also {
        require(it.optString("kind") == "session") { "An account login is required." }
    }
    fun devices(): List<JSONObject> {
        val array = request("GET", "/api/v1/nodes").getJSONArray("nodes")
        return (0 until array.length()).map { array.getJSONObject(it) }
    }
    fun pairingCode(): String = request("POST", "/api/v1/pairing-codes",
        JSONObject().put("ttlSeconds", 600)).getString("code")
    fun saveDevice(node: JSONObject, label: String, description: String, policy: JSONObject): JSONObject =
        request("PATCH", "/api/v1/nodes/${node.getString("nodeId")}",
            deviceMutation(node, label, description, policy))
    fun deleteDevice(node: JSONObject) = request("DELETE", "/api/v1/nodes/${node.getString("nodeId")}",
        JSONObject().put("revision", node.getInt("revision")))
    fun revokeDevice(node: JSONObject) = request("POST", "/api/v1/nodes/${node.getString("nodeId")}/revoke")
    fun signOut() = request("POST", "/api/auth/sign-out")
    fun beginBrowserLogin(): JSONObject = request("POST", "/api/auth/device/code",
        JSONObject().put("client_id", "adc-android").put("scope", "adc:manage"))
    fun pollBrowserLogin(code: String): AccountSession {
        val response = request("POST", "/api/auth/device/token", JSONObject()
            .put("grant_type", "urn:ietf:params:oauth:grant-type:device_code")
            .put("client_id", "adc-android").put("device_code", code))
        val token = response.getString("access_token")
        return AccountSession(origin, token, AccountApi(origin, token).me())
    }
    companion object {
        fun normalizeOrigin(value: String): String {
            val uri = URI(value.trim().trimEnd('/'))
            require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.rawUserInfo == null &&
                uri.rawQuery == null && uri.rawFragment == null && uri.path.orEmpty().isEmpty()) {
                "Enter an HTTPS service address without a path."
            }
            return uri.toASCIIString()
        }
        /** Renaming preserves the exact folder scope and concurrency from the server. */
        fun deviceMutation(node: JSONObject, label: String, description: String, policy: JSONObject): JSONObject {
            require(label.trim().length in 1..128)
            require(description.trim().length <= 500)
            return JSONObject().put("revision", node.getInt("revision")).put("label", label.trim())
                .put("description", description.trim()).put("accessPolicy", JSONObject(policy.toString()))
        }
    }
}
