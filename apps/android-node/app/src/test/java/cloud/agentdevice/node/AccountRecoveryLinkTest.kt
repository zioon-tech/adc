package cloud.agentdevice.node

import org.junit.Assert.*
import org.junit.Test

class AccountRecoveryLinkTest {
    private val origin = "https://adc.zioon.tech"
    @Test fun acceptsExactEmailRecoveryRoutes() {
        assertEquals(AccountRecoveryLink("reset", "reset_token-123"),
            AccountRecoveryLink.parse("$origin/api/auth/reset-password/reset_token-123?callbackURL=$origin/reset-password", origin))
        assertEquals(AccountRecoveryLink("reset", "reset_token-123"),
            AccountRecoveryLink.parse("$origin/reset-password?token=reset_token-123", origin))
        assertEquals(AccountRecoveryLink("verify", "jwt.header.signature"),
            AccountRecoveryLink.parse("$origin/api/auth/verify-email?token=jwt.header.signature", origin))
    }
    @Test fun rejectsOtherServicesAndAmbiguousRecoveryTokens() {
        listOf("http://adc.zioon.tech/reset-password?token=x",
            "https://other.example/reset-password?token=x",
            "https://user@adc.zioon.tech/reset-password?token=x",
            "$origin/app?token=x", "$origin/reset-password#token=x",
            "$origin/reset-password?token=x&token=y",
            "$origin/api/auth/reset-password/x/extra",
            "$origin/reset-password?token=x%2Fy").forEach {
            assertThrows(it, IllegalArgumentException::class.java) { AccountRecoveryLink.parse(it, origin) }
        }
    }
}
