package cloud.agentdevice.node

import java.net.URI
import java.net.URLDecoder

data class AccountRecoveryLink(val kind: String, val token: String) {
    companion object {
        /** Only the verified service origin and exact recovery routes can supply a token. */
        fun parse(value: String, origin: String): AccountRecoveryLink {
            val uri = URI(value)
            require(uri.scheme == "https" && uri.rawUserInfo == null && uri.rawFragment == null)
            require(URI(AccountApi.normalizeOrigin(origin)).rawAuthority == uri.rawAuthority)
            val pairs = uri.rawQuery.orEmpty().split('&').filter { it.isNotBlank() }.map {
                val parts = it.split('=', limit = 2)
                URLDecoder.decode(parts[0], "UTF-8") to URLDecoder.decode(parts.getOrElse(1) { "" }, "UTF-8")
            }
            require(pairs.map { it.first }.distinct().size == pairs.size)
            val query = pairs.toMap()
            val kind = if (uri.path == "/api/auth/verify-email") "verify" else "reset"
            val token = when {
                uri.path == "/api/auth/verify-email" -> query["token"]
                uri.path == "/reset-password" -> query["token"]
                uri.path.startsWith("/api/auth/reset-password/") ->
                    uri.path.removePrefix("/api/auth/reset-password/").takeIf { !it.contains('/') }
                else -> throw IllegalArgumentException("Invalid account recovery route.")
            }
            require(!token.isNullOrBlank() && token.length <= 4096 &&
                token.all { it.isLetterOrDigit() || it in "-_." })
            return AccountRecoveryLink(kind, token)
        }
    }
}
