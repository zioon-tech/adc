# Android capture repair verification

2026-11-07. Local candidate installed; 16/16 public ADC capture regression samples succeeded after renewed Android screen-sharing consent.

## Scope

`ScreenCaptureSession`, `ScreenControlOverlay`, `ScreenFrameQueue`, screenshot capability health and the sharing permissions recovery action.

Existing JPEG, inline acknowledgement and full-screen coordinate changes remain in this worktree. No commit, push or Control Plane deployment was performed.

## Implementation

- Remove the artificial future 32 ms overlay frame fence.
- Drain ImageReader continuously into a single-frame ownership queue.
- Serialize consumers independently from the projection lifecycle lock.
- Wake waiting consumers on stop and check cancellation without frame callbacks.
- Reject frames predating the request or overlay hide; never return a consumed cached frame.
- If no eligible frame arrives in 250 ms, replace the consumer Surface on the same VirtualDisplay once and wait another 1750 ms.
- Copy pixels with reader lifetime protection; release the Image before compression.
- Surface projection lifecycle and frame health through bounded logs, stalled availability and a restart sharing action.
- Include `timings.recoveryCount`. Wait/encode timings exclude overlay hiding, queueing and network transport.
- In this candidate, `frameWaitMs` includes pixel copying; `encodeMs` covers scaling, compression and hashing. The stage boundary differs from the former Image-based encoder.

## Tests and checks

The added overlay regression failed on the previous implementation with:

`The first redraw must not be discarded by a future fence`.

After repair:

- `ScreenIndicatorTest`: 7 passing, including 1 new regression.
- `ScreenFrameQueueTest`: 6 passing.
- `ScreenCaptureSessionTest`: 3 passing.
- Full `:app:testReleaseUnitTest`: 90 passing, no failures, errors or skips.
- `:app:lintRelease`: passed, no errors; 81 warnings remain.
- `:app:assembleRelease`: passed.
- `git diff --check`: passed.
- Coverage mode skipped: no configured or requested gate.
- `utree flush`: completed.

Lifecycle tests use Robolectric SDK28 with a simulated consent Binder because Robolectric 4.14.1 does not provide the complete SDK33 projection service. Assertions exercise real session startup, frame waiting, stop and Surface replacement. They do not establish Android 13/14 compositor behavior or image correctness.

The former lock blocking and overwritten Image ownership problems were high-confidence static findings; the old implementation was not reproduced by those new mechanism tests.

## Physical phone

- Original installed APK: 0.2.7/code13, backed up.
- Candidate: 0.2.8/code14, certificate matched and `adb install -r` succeeded.
- Public scoped ADC: phone automatically reconnected; new version advertised.
- Capture availability was initially `permission_required` after the upgrade stopped the old projection process. The system dialog was opened through public ADC and control released; the user renewed consent and availability returned.
- 16/16 PNG captures succeeded at width 720, output 720×1640: 5 static ADC permission-page samples, 3 Settings samples with active control, 3 Xiaohongshu samples after an app transition with active control, and 5 static Settings samples after control ended.
- Device receipt duration: median 261.5 ms, P90 403 ms (nearest rank), range 234–512 ms. These values are not model or tool round-trip time.
- Runtime logs contain 16 accepted frame timestamps, all at or after the request fences, one projection start and no frame timeout or projection stop.
- Eight Settings PNG hashes match across controlled and released captures, supporting exclusion of the local overlays in this sample. App transitions produced different byte counts and hashes.
- All live samples had `recoveryCount=0`. Surface recovery and stop interruption were exercised only in unit tests.
- The connected public MCP returned artifact metadata and had no artifact resource reader. Original pixels were not downloaded or visually inspected; image quality has not been accepted.
- Phone returned to the MIUI home screen and control was released.

USB was used only for installation and diagnostics; screenshots must use public ADC. No owner-account or private endpoint bypass was used.

Workspace artifacts: `/Users/bytedance/Downloads/zion-next/ADC-SCREENSHOT-FIX-20261107/`.
Sample data: `真机截图回归数据.json`; frame diagnostics: `android-capture-runtime.log`.
