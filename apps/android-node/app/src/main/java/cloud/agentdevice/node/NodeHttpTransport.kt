package cloud.agentdevice.node

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Shared connections; a signed POST is sent once, even if its response is lost. */
internal class NodeHttpTransport {
    fun post(url: String, body: JSONObject, headers: Map<String, String>): JSONObject {
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        val requestBody = object : RequestBody() {
            override fun contentType() = JSON
            override fun contentLength() = bytes.size.toLong()
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) { sink.write(bytes) }
        }
        val request = Request.Builder()
            .url(url)
            .post(requestBody)
            .header("accept", "application/json")
            .apply { headers.forEach { (name, value) -> header(name, value) } }
            .build()
        return CLIENT.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val result = if (text.isBlank()) JSONObject() else JSONObject(text)
            if (!response.isSuccessful) {
                val error = result.optJSONObject("error")
                val details = error?.optJSONObject("details")
                throw NodeApiException(
                    response.code,
                    error?.optString("code", "internal") ?: "internal",
                    buildString {
                        append(
                            error?.optString("message", "ADC returned HTTP ${response.code}")
                                ?: "ADC returned HTTP ${response.code}"
                        )
                        if (details != null) append(": ").append(details)
                    }
                )
            }
            result
        }
    }

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()
        private val CLIENT = OkHttpClient.Builder()
            .dns(DeadlineDns.SHARED)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .callTimeout(45, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
    }
}
