package cloud.agentdevice.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URI
import java.util.Locale

class AndroidUpdateManagerTest {
    private val manifestUrl =
        URI("https://devices.example.com/downloads/android/manifest.json")

    @Test
    fun parsesTrustedReleaseManifestAndLocalizedNotes() {
        val release = AndroidUpdateManager.parseManifest(validManifest(), manifestUrl)

        assertEquals("0.1.2", release.versionName)
        assertEquals(3L, release.versionCode)
        assertEquals(26, release.minSdk)
        assertEquals(
            URI(
                "https://devices.example.com/downloads/android/" +
                    "adc-mobile-node-0.1.2-aaaaaaaaaaaaaaaa.apk"
            ),
            release.apkUrl
        )
        assertEquals("修复连接稳定性。", release.notesFor(Locale.SIMPLIFIED_CHINESE))
        assertEquals("Connection stability fixes.", release.notesFor(Locale.US))
    }

    @Test
    fun rejectsCrossOriginAndParameterizedApkUrls() {
        val crossOrigin = validManifest().replace(
            "https://devices.example.com/downloads/android/",
            "https://downloads.example.com/downloads/android/"
        )
        val parameterized = validManifest().replace(
            ".apk\"",
            ".apk?token=secret\""
        )

        assertThrows(AndroidUpdateException::class.java) {
            AndroidUpdateManager.parseManifest(crossOrigin, manifestUrl)
        }
        assertThrows(AndroidUpdateException::class.java) {
            AndroidUpdateManager.parseManifest(parameterized, manifestUrl)
        }
    }

    @Test
    fun rejectsManifestWithoutRequiredReleaseNotes() {
        val missingChineseNotes = validManifest().replace(
            "\"zh-CN\": \"修复连接稳定性。\",",
            ""
        )

        assertThrows(AndroidUpdateException::class.java) {
            AndroidUpdateManager.parseManifest(missingChineseNotes, manifestUrl)
        }
    }

    @Test
    fun acceptsOnlySecureOrLoopbackControlPlaneOrigins() {
        assertEquals(
            manifestUrl,
            AndroidUpdateManager.manifestUri("https://devices.example.com/")
        )
        assertEquals(
            URI("http://localhost:8787/downloads/android/manifest.json"),
            AndroidUpdateManager.manifestUri("http://localhost:8787")
        )
        assertThrows(AndroidUpdateException::class.java) {
            AndroidUpdateManager.manifestUri("http://devices.example.com")
        }
        assertThrows(AndroidUpdateException::class.java) {
            AndroidUpdateManager.manifestUri("https://devices.example.com/private")
        }
    }

    @Test
    fun comparesMonotonicVersionCodesAndHashesBytes() {
        assertTrue(AndroidUpdateManager.isUpdateAvailable(2, 3))
        assertFalse(AndroidUpdateManager.isUpdateAvailable(3, 3))
        assertFalse(AndroidUpdateManager.isUpdateAvailable(4, 3))
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            AndroidUpdateManager.sha256("abc".toByteArray())
        )
    }

    private fun validManifest(): String =
        """
        {
          "schemaVersion": 1,
          "packageName": "cloud.agentdevice.node",
          "versionName": "0.1.2",
          "versionCode": 3,
          "minSdk": 26,
          "publishedAt": "2026-10-11T08:00:00Z",
          "required": false,
          "releaseNotes": {
            "zh-CN": "修复连接稳定性。",
            "en": "Connection stability fixes."
          },
          "apk": {
            "url": "https://devices.example.com/downloads/android/adc-mobile-node-0.1.2-aaaaaaaaaaaaaaaa.apk",
            "sha256": "${"a".repeat(64)}",
            "bytes": 123456,
            "signingCertificateSha256": "${"b".repeat(64)}"
          }
        }
        """.trimIndent()
}
