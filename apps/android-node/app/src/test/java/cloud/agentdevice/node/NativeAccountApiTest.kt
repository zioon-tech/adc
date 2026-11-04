package cloud.agentdevice.node

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativeAccountApiTest {
    @Test fun registrationCanRequireEmailVerificationWithoutInventingASession() {
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            assertEquals("/api/auth/sign-up/email", chain.request().url.encodedPath)
            val buffer = okio.Buffer()
            chain.request().body!!.writeTo(buffer)
            val body = JSONObject(buffer.readUtf8())
            assertEquals("https://adc.zioon.tech/login?verification=1", body.getString("callbackURL"))
            assertEquals("Person", body.getString("name"))
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body("""{"token":null,"user":{"email":"person@example.test"}}""".toResponseBody("application/json".toMediaType())).build()
        }.build()
        assertNull(AccountApi("https://adc.zioon.tech", httpClient = client)
            .signUp("Person", "person@example.test", "a valid long password"))
    }
    @Test fun accountMethodsReadArraysAndCarryOnlyTheAuthenticatedBearer() {
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            assertEquals("/api/auth/list-accounts", chain.request().url.encodedPath)
            assertEquals("Bearer account-token", chain.request().header("authorization"))
            assertEquals("https://adc.zioon.tech", chain.request().header("origin"))
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body("""[{"providerId":"credential"},{"providerId":"github"}]""".toResponseBody("application/json".toMediaType())).build()
        }.build()
        assertEquals(listOf("credential", "github"),
            AccountApi("https://adc.zioon.tech", "account-token", client).loginMethods())
    }
    @Test fun nativeLoginRecognizesTheServersEmailVerificationErrorCode() {
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(403).message("Forbidden")
                .body("""{"code":"EMAIL_NOT_VERIFIED","message":"Verify your email"}""".toResponseBody("application/json".toMediaType())).build()
        }.build()
        val failure = assertThrows(AccountApiException::class.java) {
            AccountApi("https://adc.zioon.tech", httpClient = client).signIn("person@example.test", "password")
        }
        assertEquals("EMAIL_NOT_VERIFIED", failure.code)
        assertEquals(403, failure.status)
    }
}
