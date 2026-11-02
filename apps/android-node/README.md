# ADC Mobile Node for Android

This module is the first native mobile Node. It connects an Android phone to the same Control Plane,
authorization and receipt path used by desktop Nodes without exposing a shell or filesystem.

## MVP capabilities

| Capability           | Local requirement                                     |
| -------------------- | ----------------------------------------------------- |
| `device.battery.get` | None                                                  |
| `device.info.get`    | None                                                  |
| `device.network.get` | Android network-state access                          |
| `device.storage.get` | None                                                  |
| `device.vibrate`     | Device with vibration hardware                        |
| `app.open`           | Installed app with a launcher activity                |
| `display.status`     | None                                                  |
| `audio.status`       | None                                                  |
| `audio.volume.set`   | None                                                  |
| `flashlight.status`  | Camera permission and camera flash hardware           |
| `flashlight.set`     | Camera permission and camera flash hardware           |
| `location.get`       | Location permission, location enabled and App visible |
| `notification.show`  | Notification permission on Android 13 and later       |
| `screen.capture`     | Local capability switch and MediaProjection consent   |
| `ui.inspect`         | Local capability switch and Accessibility service     |
| `ui.wait`            | Local capability switch and Accessibility service     |
| `ui.action`          | Local capability switch and Accessibility service     |
| `ui.gesture`         | Local capability switch and Accessibility service     |
| `device.navigation`  | Local capability switch and Accessibility service     |

The Node always advertises its installed capability descriptors. A capability whose Android
permission or runtime condition is missing is marked unavailable and is excluded from dispatch by
the Control Plane. New capabilities are not added to an existing Agent grant automatically.

The broader Android surface, including Bluetooth, NFC, Wi-Fi, hotspot, display controls, media,
sensors and managed-device-only operations, is classified in the
[Android capability matrix](../../docs/android-capability-matrix.md). A local switch cannot turn a
privileged Android operation into an ordinary App capability.

## Build

Use JDK 17 and Android SDK Platform 35:

```bash
cd apps/android-node
./gradlew test assembleDebug
```

The debug APK is written to `app/build/outputs/apk/debug/app-debug.apk`. Install it with:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## Pair and run

1. Sign in to the ADC Console and create a device pairing code.
2. Open ADC Mobile Node, enter the HTTPS Control Plane origin, pairing code and phone name.
3. Select **Pair and start**. The phone generates a P-256 key inside Android Keystore; the private
   key is non-exportable.
4. Enable only the local capability groups needed by the Agents you intend to authorize. Android
   permission, screen-share and Accessibility consent remain separate system-level boundaries.
5. In ADC Agent access, select this device and explicitly enable its device-native capabilities.

The MVP uses a user-started foreground service and a persistent notification. While connected, it
keeps an authenticated WebSocket wake channel aligned with desktop Nodes. Wake messages contain no
task data; the App claims work through the signed poll API. It falls back to a server-woken
ten-second long poll while the socket reconnects, and to one-second polling with older Control
Planes. A 30-second durable poll covers a lost wake without claiming to be an unrestricted
always-on Android daemon.

## Version and updates

The App's **Version & updates** section shows the installed version, the latest version published by
the paired Control Plane, localized release notes and the last check time. The App validates the
download size, SHA-256, package metadata and signing certificate before opening Android's package
installer. Installation always requires device-owner confirmation.

The first updater-enabled build must still be installed manually. Signed release publication and
the trust boundary are documented in
[Android Mobile Node distribution](../../docs/android-node-distribution.md). Debug APKs are for
local development and must not be published through the production update channel.

## Xiaomi and HyperOS

For a longer foreground session, allow ADC Mobile Node to run in the background and remove battery
restrictions for the App in the phone's system settings. Exact labels vary by MIUI/HyperOS version.
These settings improve availability but do not override Android permission checks. If the system
stops the service, ADC reports the Node offline.

`location.get` remains foreground-only in this release. Keep the App visible for a location request.
A future explicit trip mode may use Android's location foreground-service contract; the general Node
service does not request continuous background location.

Screen capture uses Android MediaProjection and remains available only while its foreground
screen-share session is active. PNG bytes are uploaded as an opaque Artifact reference; hosted
deployments must configure the external content-addressed asset directory.

UI inspection and control use an Android Accessibility service that the device owner must enable in
system settings. Snapshots include display/window metadata, versioned snapshot IDs, node
references, semantic roles and state. The Node supports waiting for UI/app/idle conditions,
selector-based click/long-click/focus/scroll/set/clear text actions with before/after verification,
coordinate tap/swipe gestures and Back/Home/Recents/system-shade navigation. Password field
contents are redacted from snapshots.

The Android native provider exposes app launch, device/build/storage/display/audio status, bounded
volume and vibration controls, and flashlight status/control. These capabilities use Android public
APIs and share the Device status local switch; flashlight access also requires camera permission.

## Security boundary

- The Control Plane accepts Android Keystore P-256 identities in addition to desktop Ed25519 keys.
- Every poll, acknowledgement and receipt is signed over method, path, timestamp, nonce and
  canonical request-body hash.
- Active invocations renew their Control Plane lease and stop on cancellation or lease loss.
- The App exposes no shell, arbitrary HTTP proxy, file browser, contacts, SMS or unrestricted intent
  execution. Accessibility and screen capture are separately disabled by default and remain
  revocable from the App and Android system settings.
- Capability execution rechecks Android permission and foreground state instead of trusting the last
  advertised snapshot.
- `notification.show` uses a durable local idempotency record. An interrupted uncertain action is
  reported as `unknown_outcome`, not repeated automatically. The latest 256 records are retained;
  forgetting the pairing removes them and the Android Keystore identity.

The current build has been exercised on a physical Xiaomi 22041216C running Android 13 / MIUI 14,
but this is not a claim of compatibility with every Android or Xiaomi model. Release qualification
must record Android version, MIUI/HyperOS version, permission behavior, lock-screen behavior,
battery policy and reconnect results for each tested device.
