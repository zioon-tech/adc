# ADC capture verification

- [x] Step1 测试准备
- [x] Step2 加载语言知识与上下文
- [x] Step3 确定范围
- [x] Step4 分析缺陷
- [x] Step5 生成、验证、修复
- [x] Step6 覆盖率统计与补充
- [x] Step7 输出报告

Scope: JPEG artifact compatibility and MCP resource reads over the existing
authenticated artifact API. Device capture timing and live performance are
validated separately.

LANG=javascript; EXEC_SOURCE empty; no AGENTS/CLAUDE test conventions found.
Existing framework: Vitest and MCP InMemoryTransport.

TARGETS (unstaged diff):

- packages/mcp-adapter/src/index.ts:createMcpServer, lines 341–380:
  resource capability negotiation, URI validation, binary preservation,
  repeated reads must call the authenticated API again.
- packages/protocol/src/index.ts:ArtifactIdSchema and ToolArgsSchemas,
  lines 59 and 389–396: PNG default and explicit JPEG quality bounds.
- apps/control-plane/src/app.ts:createControlPlane artifact routes,
  lines 1982–1990 and 3322–3326: image MIME validation and external storage.

BUG_MAP: [].
Filtered candidates: resource reads do not cache permissions or bytes; the
existing public endpoint enforces current visibility. Old PNG defaults are
preserved. Upload extension/content type matching was updated together with
download storage routing. Performance hypotheses are measured separately and
are not treated as proven correctness defects.

Round 1, generation → verification → no repair:

- MCP: `pnpm exec vitest run packages/mcp-adapter/src/index.test.ts`, exit 0,
  all-pass, 16 tests. Added binary resource/URI/access recheck and absent-client cases.
- Protocol: `pnpm exec vitest run packages/protocol/src/index.test.ts`, exit 0,
  all-pass, 20 tests. Added PNG defaults, JPEG quality bounds and artifact IDs.
- API: `pnpm exec vitest run apps/control-plane/src/app.test.ts`, exit 0,
  all-pass, 21 tests. Extended screenshot storage to PNG/JPG/JPEG, rejects MIME/hash
  mismatches. Fixture now preserves arbitrary binary response bytes.

New/expanded executable cases: 6 (2 MCP, 1 protocol, 3 image formats).
57 total tests passed. Node 22.18.0; no coverage gate was requested or configured,
so coverage statistics were skipped. `utree flush` completed.
Typecheck and generated-schema check passed.
Android `assembleRelease testReleaseUnitTest` passed using SDK 36/build-tools 35.

## Inline acknowledgement follow-up

Scope: signed Android polling may opt into the existing ACK lease transition.
This follow-up uses API integration scenarios, existing Android regression checks
and physical-device verification; it does not generate additional unit tests.

- Seven API cases cover legacy dispatch, long-poll completion without a separate
  ACK, cancellation between claim and ACK, lost-response redelivery with a new
  lease, revoked queued/recovered work, and expiry before ACK.
- `vitest run apps/control-plane/src/app.test.ts packages/db/src/postgres-store.integration.test.ts`:
  40 passed, including 12 real PostgreSQL store cases. The new route scenarios use
  the API fixture's MemoryStore; phone benchmarks exercise that route against PostgreSQL.
- Android `testDebugUnitTest --tests '*NodeProtocolTest' --tests '*ScreenControlIntegrationTest'
--tests '*NodeRecoveryTest'`: 13 passed. These retain existing signing, receipt
  replay and recovery checks; they are not evidence of measured performance.
- An isolated physical-device probe uses one NodeProtocol instance across current
  and baseline services. Upgrade, rollback after a strict 400, preserved long poll,
  and subsequent legacy poll all passed. No production device credentials were used.
- Typecheck, schema check, changed-file formatting and `git diff --check` passed.
- ESLint reports three existing unused bindings in `app.ts`: `NodeReleaseSummary`,
  `_publicKey`, `_requestedBindings`; each is present in HEAD before this change.

Delivery semantics and compatibility are documented in ADR-0007.
End-to-end timing, image freshness and operation correctness are recorded separately
in the workspace's `local-adc-comparison/本地对照报告.md`.

## Real application follow-up: screen coordinate consistency

Physical-device testing in Xiaohongshu exposed a full-screen bottom control rejected
by gesture validation: capture dimensions were 1080×2460 while resource metrics
were 1080×2316. Gestures use screen coordinates including system bars.

`screenDisplayMetrics` now supplies full-screen dimensions to gesture validation,
display status, Accessibility snapshots, and capture setup. API 30+ uses maximum
window bounds; earlier Android uses real display metrics.

- The isolated benchmark connector reported 1080×2460 after the fix and successfully
  tapped the bottom comment control previously rejected as outside the display.
- `:app:testReleaseUnitTest :app:lintRelease :app:assembleRelease`: 80 existing tests,
  zero failures/errors/skips; lint and release build passed.
- `git diff --check` passed. No additional unit-test generation was performed.
- Live exploratory comparison covered Xiaohongshu, Eleduck and Meituan. The H20
  harness also needed full-screen coordinate mapping and content-dependent waits.
  Those harness edits remain experimental; model misclicks are not counted as
  task success merely because a receipt succeeded.
- Full-screen fix is uncommitted and unpublished. The early candidate APK retained
  in the workspace does not include this follow-up.

Sanitized task results and measurement limits:
`WEVISONE-GUI-PILOT-20261107/real-app-tasks-20261107/真实任务对照报告.md`
in the user workspace.

## 2026-11-07 release image delivery

The earlier statements about uncommitted changes and local-only resource reads
describe their original verification time. The release candidate now pins Android
0.2.8/code14, CLI/Connector 0.1.9 and SDK 0.2.5.

Hosted MCP now uses the same caller/account/grant/task/delegation checks as the
artifact HTTP endpoint. Screenshot tools and completed task results return MCP
image content alongside the existing JSON. Image delivery failures retain the
capture metadata and set the MCP error flag.

- Added 10 adapter cases covering PNG/JPEG, direct capture, status/result/wait,
  delivery failures and pending captures. Extended the three asset-format cases
  with hosted resource reads, task image delivery, cross-grant rejection and
  revocation.
- Before repair: 43/54 passed; the 11 failing cases exposed missing image content
  or missing hosted resource support. No unrelated historical failures.
- After repair: 91/91 API/MCP/SDK/protocol tests passed; a missing `rootAccess`
  test-fixture field was fixed after the typecheck identified it.
- Final typecheck and generated schema check passed. Required main CI and public
  release acceptance are recorded separately after the deployment completes.
