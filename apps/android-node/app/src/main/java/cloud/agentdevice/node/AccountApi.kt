package cloud.agentdevice.node

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

class AccountApiException(val status: Int, val code: String, message: String) : Exception(message)

class AccountApi(origin: String, private val token: String? = null, httpClient: OkHttpClient? = null) {
    val origin = normalizeOrigin(origin)
    private val client = httpClient ?: OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(25, TimeUnit.SECONDS).build()

    private fun requestJson(method: String, path: String, body: JSONObject? = null): Any {
        require(path.startsWith("/api/") && !path.contains(".."))
        val builder = Request.Builder().url("$origin$path").header("accept", "application/json")
            .header("origin", origin)
        token?.let { builder.header("authorization", "Bearer $it") }
        builder.method(method, if (method == "GET") null else
            (body ?: JSONObject()).toString().toRequestBody("application/json".toMediaType()))
        client.newCall(builder.build()).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val json = try { if (text.isBlank()) JSONObject() else
                if (text.trimStart().startsWith("[")) JSONArray(text) else JSONObject(text) }
                catch (_: Exception) { throw AccountApiException(response.code, "invalid_response", "ADC returned an invalid response.") }
            if (!response.isSuccessful) {
                val error = json as? JSONObject ?: JSONObject()
                val detail = error.optJSONObject("error")
                throw AccountApiException(response.code,
                    detail?.optString("code") ?: error.optString("code",
                        error.optString("error", "request_failed")),
                    detail?.optString("message") ?: error.optString("error_description",
                        error.optString("message", "ADC returned HTTP ${response.code}")))
            }
            return json
        }
    }
    fun request(method: String, path: String, body: JSONObject? = null): JSONObject =
        requestJson(method, path, body) as? JSONObject
            ?: throw AccountApiException(200, "invalid_response", "ADC returned an invalid response.")

    fun config(): JSONObject = request("GET", "/api/v1/auth/config")
    fun signUp(name: String, email: String, password: String): AccountSession? {
        val response = request("POST", "/api/auth/sign-up/email", JSONObject()
            .put("name", name).put("email", email).put("password", password)
            .put("callbackURL", "$origin/login?verification=1"))
        val sessionToken = response.optString("token").takeIf { it.isNotBlank() && it != "null" } ?: return null
        return AccountSession(origin, sessionToken, AccountApi(origin, sessionToken, client).me())
    }
    fun requestPasswordReset(email: String) = request("POST", "/api/auth/request-password-reset",
        JSONObject().put("email", email).put("redirectTo", "$origin/reset-password"))
    fun sendVerificationEmail(email: String) = request("POST", "/api/auth/send-verification-email",
        JSONObject().put("email", email).put("callbackURL", "$origin/login?verification=1"))
    fun verifyEmail(verificationToken: String) = request("GET",
        "/api/auth/verify-email?token=${URLEncoder.encode(verificationToken, "UTF-8")}")
    fun resetPassword(resetToken: String, password: String) = request("POST", "/api/auth/reset-password",
        JSONObject().put("token", resetToken).put("newPassword", password))
    fun updateProfile(name: String) = request("POST", "/api/auth/update-user", JSONObject().put("name", name))
    fun changePassword(current: String, password: String) = request("POST", "/api/auth/change-password",
        JSONObject().put("currentPassword", current).put("newPassword", password).put("revokeOtherSessions", true))
    fun loginMethods(): List<String> {
        val values = requestJson("GET", "/api/auth/list-accounts") as? JSONArray
            ?: throw AccountApiException(200, "invalid_response", "ADC returned an invalid response.")
        return (0 until values.length()).map { values.getJSONObject(it).getString("providerId") }
    }
    fun revokeOtherSessions() = request("POST", "/api/auth/revoke-other-sessions")

    fun signIn(email: String, password: String): AccountSession {
        val response = request("POST", "/api/auth/sign-in/email",
            JSONObject().put("email", email).put("password", password))
        val token = response.getString("token")
        val me = AccountApi(origin, token, client).me()
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
