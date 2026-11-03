# Android Mobile Node distribution

> Android Node is currently in testing. Supported behavior depends on the phone model, OS and
> permissions. The manually installed hosted APK is a test build; availability does not certify all
> phones or operations. The release-channel design below does not change that maturity status.

ADC Mobile Node 0.2.0 provides account login, device management and independent phone permissions.
The native Material 3 client supports system light/dark appearance, larger fonts, device filters
and grouped permission controls.
**Account → Check for updates** checks the paired service and presents localized release notes.
Updates are downloaded and verified before Android asks the device owner to install.

Android updates use a separate release channel from desktop Node archives:

- `GET /downloads/android/manifest.json`
- `GET /downloads/android/adc-mobile-node-<version>-<digest>.apk`

An empty release directory returns HTTP 404 and the App reports that no Android release is
published. It never treats a debug build or a desktop Node archive as a mobile update.

## Manual preview download

Hosted installations may place a manually qualified APK at `preview.apk` in
`ADC_ANDROID_RELEASE_DIR`. The Control Plane then exposes it at
`/downloads/android/preview.apk` and shows the link in the Android tab of **Pair device**.

This stable preview link is separate from `manifest.json`. It is intended for explicit manual
installation and does not make the APK an automatic update. Preview builds must be labeled as using
a development signing key; operators must replace them with a protected production-signed release
before treating the Android channel as production.

## Trust and installation boundary

Before opening Android's package installer, the App verifies all of the following:

1. The manifest and APK use the paired Control Plane's HTTPS origin.
2. The published `versionCode` is greater than the installed `versionCode`.
3. The download has the exact manifest byte count and SHA-256 digest.
4. Android can parse the APK and its package name, version name and version code match the manifest.
5. The APK signing certificate matches both the manifest and the currently installed App.

The App downloads into its private cache and exposes only the verified APK through a non-exported
`FileProvider`. Android still requires the device owner to allow installs from ADC Mobile Node and
confirm each installation. The App does not perform silent installation. Signing-key rotation is
not supported by this initial channel; publish with the same protected release key.

## Publish a signed release

The hosted testing channel preserves the existing development certificate so installed test phones
can upgrade without losing their identity. Its APK is built with the release configuration and is
not debuggable. This is a qualified testing distribution, not a protected production signing key.
The public homepage and Android guide link directly to `/downloads/android/preview.apk`.

For the current ECS release model, `apps/android-node/release.json` pins a qualified APK's package
metadata, signing certificate, size and SHA-256. The signed versioned APK is published as an asset
of `android-v<version>` in this repository's GitHub Releases. Service CI downloads those exact bytes,
verifies the size and digest, and packages `dist/android` alongside the service. Deployment consumes
that complete artifact. No Android build or dependency installation runs on ECS, and CI never
receives the local signing key. If `ADC_ANDROID_RELEASE_DIR` is explicitly configured, operators
must publish into that directory; otherwise the bundled `dist/android` channel is used.

Build and sign the release APK outside the repository using the protected production keystore.
Increment `versionCode` for every release. Do not publish `app-debug.apk` or an unsigned release.

The publisher requires Android SDK build-tools `apksigner` and `aapt2`. It verifies the APK
signature, package name, version, minimum SDK and non-debuggable flag before writing any public
metadata:

```sh
pnpm publish:android -- \
  --apk /secure/build/adc-mobile-node-release.apk \
  --download-url https://devices.example.com/downloads/android \
  --notes-zh-file release-notes.zh-CN.txt \
  --notes-en-file release-notes.en.txt \
  --out-dir dist/android
```

The content-addressed APK is written first and `manifest.json` is replaced last. For a source
deployment, copy the resulting directory to `ADC_ANDROID_RELEASE_DIR`. Compose mounts
`ADC_ANDROID_RELEASE_HOST_DIR` read-only into the Control Plane; publish into that host directory
and leave the in-container path unchanged.

Verify the public files before announcing the release:

```sh
curl -fsS https://devices.example.com/downloads/android/manifest.json
curl -fsS -o /tmp/adc-mobile-node.apk \
  https://devices.example.com/downloads/android/adc-mobile-node-VERSION-DIGEST.apk
```

The publisher accepts `--apksigner PATH` and `--aapt2 PATH` when Android SDK tools are not on
`PATH`. `--required` marks the release as required in the UI, but Android still leaves installation
under device-owner control.

## First updater-enabled installation

The existing 0.1.1 build cannot discover this channel. Install 0.1.2 once through ADB or another
device-owner-approved path. If that installed build uses a debug certificate, a production-signed
APK cannot update it in place; uninstalling the debug build removes its local pairing and requires a
fresh pairing after the production build is installed.
