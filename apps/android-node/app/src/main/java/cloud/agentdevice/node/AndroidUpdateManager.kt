package cloud.agentdevice.node

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.DigestInputStream
import java.security.MessageDigest
import java.time.Instant
import java.util.Locale

data class AndroidRelease(
    val versionName: String,
    val versionCode: Long,
    val minSdk: Int,
    val publishedAt: Instant,
    val required: Boolean,
    val releaseNotes: Map<String, String>,
    val packageName: String,
    val apkUrl: URI,
    val apkSha256: String,
    val apkBytes: Long,
    val signingCertificateSha256: String
) {
    fun notesFor(locale: Locale = Locale.getDefault()): String {
        val exact = locale.toLanguageTag()
        return releaseNotes[exact]
            ?: releaseNotes[locale.language]
            ?: releaseNotes["en"]
            ?: releaseNotes.values.first()
    }
}

class AndroidUpdateManager(
    private val context: Context
) {
    private val packageManager = context.packageManager

    fun currentVersion(): Pair<String, Long> {
        val info = packageManager.getPackageInfo(context.packageName, 0)
        return (info.versionName ?: "unknown") to versionCode(info)
    }

    fun check(controlPlaneUrl: String): AndroidRelease? {
        val manifestUrl = manifestUri(controlPlaneUrl)
        val connection = open(manifestUrl)
        return try {
            when (val status = connection.responseCode) {
                HttpURLConnection.HTTP_NOT_FOUND -> null
                HttpURLConnection.HTTP_OK -> {
                    val body = readBounded(connection, MAX_MANIFEST_BYTES)
                    parseManifest(body, manifestUrl)
                }
                else -> throw AndroidUpdateException("Update server returned HTTP $status.")
            }
        } finally {
            connection.disconnect()
        }
    }

    fun downloadAndVerify(release: AndroidRelease): File {
        requireCompatibleRelease(release)
        val directory = File(context.cacheDir, UPDATE_DIRECTORY).apply { mkdirs() }
        check(directory.isDirectory) { "Unable to create the update directory." }
        directory.listFiles()?.forEach { file ->
            if (file.name.endsWith(".apk") || file.name.endsWith(".part")) file.delete()
        }
        val fileName = release.apkUrl.path.substringAfterLast('/')
        val temporary = File(directory, "$fileName.part")
        val destination = File(directory, fileName)
        val connection = open(release.apkUrl)
        try {
            val status = connection.responseCode
            if (status != HttpURLConnection.HTTP_OK) {
                throw AndroidUpdateException("APK download returned HTTP $status.")
            }
            val declaredLength = connection.contentLengthLong
            if (declaredLength > MAX_APK_BYTES || declaredLength > release.apkBytes) {
                throw AndroidUpdateException("APK download is larger than the release manifest.")
            }
            val digest = MessageDigest.getInstance("SHA-256")
            var copied = 0L
            DigestInputStream(connection.inputStream, digest).use { input ->
                FileOutputStream(temporary).use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        copied += count
                        if (copied > release.apkBytes || copied > MAX_APK_BYTES) {
                            throw AndroidUpdateException(
                                "APK download is larger than the release manifest."
                            )
                        }
                        output.write(buffer, 0, count)
                    }
                    output.fd.sync()
                }
            }
            if (copied != release.apkBytes) {
                throw AndroidUpdateException(
                    "APK size mismatch: expected ${release.apkBytes} bytes, received $copied."
                )
            }
            val actualSha256 = digest.digest().toHex()
            if (actualSha256 != release.apkSha256) {
                throw AndroidUpdateException("APK SHA-256 verification failed.")
            }
            verifyPackage(temporary, release)
            if (!temporary.renameTo(destination)) {
                throw AndroidUpdateException("Unable to finalize the verified APK.")
            }
            return destination
        } catch (error: Exception) {
            temporary.delete()
            destination.delete()
            throw error
        } finally {
            connection.disconnect()
        }
    }

    fun canRequestPackageInstalls(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            packageManager.canRequestPackageInstalls()

    fun installPermissionIntent(): Intent =
        Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${context.packageName}")
        )

    fun launchInstaller(apk: File) {
        if (!canRequestPackageInstalls()) {
            throw InstallPermissionRequiredException()
        }
        val uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.updates",
            apk
        )
        context.startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        )
    }

    private fun requireCompatibleRelease(release: AndroidRelease) {
        val (_, currentVersionCode) = currentVersion()
        if (!isUpdateAvailable(currentVersionCode, release.versionCode)) {
            throw AndroidUpdateException("The selected release is not newer than this App.")
        }
        if (release.minSdk > Build.VERSION.SDK_INT) {
            throw AndroidUpdateException(
                "Android ${release.minSdk} or later is required for this update."
            )
        }
        if (release.packageName != context.packageName) {
            throw AndroidUpdateException("The release package name does not match this App.")
        }
    }

    @Suppress("DEPRECATION")
    private fun verifyPackage(apk: File, release: AndroidRelease) {
        val flags =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                PackageManager.GET_SIGNING_CERTIFICATES
            } else {
                PackageManager.GET_SIGNATURES
            }
        val archive = packageManager.getPackageArchiveInfo(apk.absolutePath, flags)
            ?: throw AndroidUpdateException("Android could not read the downloaded APK.")
        if (archive.packageName != release.packageName) {
            throw AndroidUpdateException("Downloaded APK package name does not match the manifest.")
        }
        if (versionCode(archive) != release.versionCode) {
            throw AndroidUpdateException("Downloaded APK version code does not match the manifest.")
        }
        if (archive.versionName != release.versionName) {
            throw AndroidUpdateException("Downloaded APK version name does not match the manifest.")
        }
        val installed = packageManager.getPackageInfo(context.packageName, flags)
        val archiveCertificates = signingCertificateDigests(archive, includeHistory = false)
        val installedCertificates = signingCertificateDigests(installed, includeHistory = true)
        if (release.signingCertificateSha256 !in archiveCertificates) {
            throw AndroidUpdateException("Downloaded APK signing certificate is not trusted.")
        }
        if (release.signingCertificateSha256 !in installedCertificates) {
            throw AndroidUpdateException(
                "Update certificate does not match the currently installed App."
            )
        }
    }

    @Suppress("DEPRECATION")
    private fun signingCertificateDigests(
        info: PackageInfo,
        includeHistory: Boolean
    ): Set<String> {
        val signatures =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                val signingInfo = info.signingInfo
                    ?: throw AndroidUpdateException("APK signing information is missing.")
                if (includeHistory && !signingInfo.hasMultipleSigners()) {
                    signingInfo.signingCertificateHistory
                } else {
                    signingInfo.apkContentsSigners
                }
            } else {
                info.signatures
                    ?: throw AndroidUpdateException("APK signing information is missing.")
            }
        return signatures.mapTo(mutableSetOf()) { signature ->
            MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).toHex()
        }
    }

    private fun open(uri: URI): HttpURLConnection =
        (URL(uri.toASCIIString()).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            instanceFollowRedirects = false
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            setRequestProperty("accept", "application/json, application/vnd.android.package-archive")
            setRequestProperty("user-agent", "ADC-Mobile-Node/${currentVersion().first}")
        }

    companion object {
        private const val UPDATE_DIRECTORY = "verified-updates"
        private const val MAX_MANIFEST_BYTES = 256 * 1024L
        private const val MAX_APK_BYTES = 250L * 1024L * 1024L
        private const val CONNECT_TIMEOUT_MS = 15_000
        private const val READ_TIMEOUT_MS = 120_000
        private val VERSION_NAME_PATTERN =
            Regex("""^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$""")
        private val SHA256_PATTERN = Regex("""^[a-f0-9]{64}$""")
        private val APK_FILE_PATTERN =
            Regex("""^adc-mobile-node-[0-9A-Za-z._+-]+-[a-f0-9]{16}\.apk$""")

        internal fun manifestUri(controlPlaneUrl: String): URI {
            val origin =
                try {
                    URI(controlPlaneUrl.trim())
                } catch (_: Exception) {
                    throw AndroidUpdateException("ADC URL is invalid.")
                }
            val loopback =
                origin.scheme == "http" &&
                    origin.host in setOf("localhost", "127.0.0.1", "[::1]", "::1")
            if (
                (origin.scheme != "https" && !loopback) ||
                origin.host.isNullOrBlank() ||
                origin.userInfo != null ||
                origin.rawQuery != null ||
                origin.rawFragment != null ||
                (origin.path.isNotEmpty() && origin.path != "/")
            ) {
                throw AndroidUpdateException(
                    "ADC URL must be an HTTPS origin without credentials, path, query or fragment."
                )
            }
            return URI(
                origin.scheme,
                null,
                origin.host,
                origin.port,
                "/downloads/android/manifest.json",
                null,
                null
            )
        }

        internal fun parseManifest(body: String, manifestUrl: URI): AndroidRelease {
            val json =
                try {
                    JSONObject(body)
                } catch (_: Exception) {
                    throw AndroidUpdateException("Android release manifest is not valid JSON.")
                }
            if ((json.opt("schemaVersion") as? Number)?.toInt() != 1) {
                throw AndroidUpdateException("Android release manifest version is unsupported.")
            }
            val versionName = json.requiredString("versionName")
            if (!VERSION_NAME_PATTERN.matches(versionName)) {
                throw AndroidUpdateException("Android release version name is invalid.")
            }
            val versionCode = json.requiredLong("versionCode", 1, Long.MAX_VALUE)
            val minSdk = json.requiredLong("minSdk", 21, 10_000).toInt()
            val publishedAt =
                try {
                    Instant.parse(json.requiredString("publishedAt"))
                } catch (_: Exception) {
                    throw AndroidUpdateException("Android release timestamp is invalid.")
                }
            val notesObject = json.optJSONObject("releaseNotes")
                ?: throw AndroidUpdateException("Android release notes are missing.")
            val notes = notesObject.keys().asSequence().associateWith { language ->
                (notesObject.opt(language) as? String)?.trim()?.also {
                    if (it.isBlank() || it.length > 20_000) {
                        throw AndroidUpdateException("Android release notes are invalid.")
                    }
                } ?: throw AndroidUpdateException("Android release notes are invalid.")
            }
            if (notes["zh-CN"].isNullOrBlank() || notes["en"].isNullOrBlank()) {
                throw AndroidUpdateException("Android release notes must include zh-CN and en.")
            }
            val apk = json.optJSONObject("apk")
                ?: throw AndroidUpdateException("Android release APK metadata is missing.")
            val apkUrl =
                try {
                    manifestUrl.resolve(apk.requiredString("url"))
                } catch (_: Exception) {
                    throw AndroidUpdateException("Android release APK URL is invalid.")
                }
            validateApkUri(apkUrl, manifestUrl)
            val sha256 = apk.requiredString("sha256").lowercase()
            val certificate = apk.requiredString("signingCertificateSha256")
                .replace(":", "")
                .lowercase()
            if (!SHA256_PATTERN.matches(sha256) || !SHA256_PATTERN.matches(certificate)) {
                throw AndroidUpdateException("Android release SHA-256 metadata is invalid.")
            }
            val bytes = apk.requiredLong("bytes", 1, MAX_APK_BYTES)
            return AndroidRelease(
                versionName = versionName,
                versionCode = versionCode,
                minSdk = minSdk,
                publishedAt = publishedAt,
                required = json.optBoolean("required", false),
                releaseNotes = notes,
                packageName = json.requiredString("packageName"),
                apkUrl = apkUrl,
                apkSha256 = sha256,
                apkBytes = bytes,
                signingCertificateSha256 = certificate
            )
        }

        internal fun isUpdateAvailable(currentVersionCode: Long, latestVersionCode: Long): Boolean =
            latestVersionCode > currentVersionCode

        internal fun sha256(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

        private fun validateApkUri(apkUrl: URI, manifestUrl: URI) {
            val sameOrigin =
                apkUrl.scheme == manifestUrl.scheme &&
                    apkUrl.host == manifestUrl.host &&
                    effectivePort(apkUrl) == effectivePort(manifestUrl)
            val fileName = apkUrl.path.substringAfterLast('/')
            if (
                !sameOrigin ||
                apkUrl.scheme !in setOf("https", "http") ||
                apkUrl.userInfo != null ||
                apkUrl.rawQuery != null ||
                apkUrl.rawFragment != null ||
                !apkUrl.path.startsWith("/downloads/android/") ||
                !APK_FILE_PATTERN.matches(fileName)
            ) {
                throw AndroidUpdateException(
                    "Android release APK URL must be an approved same-origin download."
                )
            }
        }

        private fun effectivePort(uri: URI): Int =
            when {
                uri.port >= 0 -> uri.port
                uri.scheme == "https" -> 443
                else -> 80
            }

        private fun readBounded(connection: HttpURLConnection, maximumBytes: Long): String {
            if (connection.contentLengthLong > maximumBytes) {
                throw AndroidUpdateException("Android release manifest is too large.")
            }
            val output = ByteArrayOutputStream()
            connection.inputStream.use { input ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                var total = 0L
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    total += count
                    if (total > maximumBytes) {
                        throw AndroidUpdateException("Android release manifest is too large.")
                    }
                    output.write(buffer, 0, count)
                }
            }
            return output.toString(StandardCharsets.UTF_8.name())
        }

        private fun JSONObject.requiredString(name: String): String =
            (opt(name) as? String)?.trim()?.takeIf(String::isNotEmpty)
                ?: throw AndroidUpdateException("Android release field '$name' is missing.")

        private fun JSONObject.requiredLong(name: String, minimum: Long, maximum: Long): Long {
            val number = opt(name) as? Number
                ?: throw AndroidUpdateException("Android release field '$name' is invalid.")
            val value = number.toLong()
            if (number.toDouble() != value.toDouble()) {
                throw AndroidUpdateException("Android release field '$name' is invalid.")
            }
            if (value !in minimum..maximum) {
                throw AndroidUpdateException("Android release field '$name' is out of range.")
            }
            return value
        }

        @Suppress("DEPRECATION")
        private fun versionCode(info: PackageInfo): Long =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                info.longVersionCode
            } else {
                info.versionCode.toLong()
            }

        private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }
    }
}

class AndroidUpdateException(
    override val message: String
) : Exception(message)

class InstallPermissionRequiredException :
    Exception("Allow ADC Mobile Node to install this verified update in Android settings.")
