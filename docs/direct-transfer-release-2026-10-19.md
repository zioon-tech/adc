# Direct transfer release — 2026-10-19

The implementation is ready for deployment. The hosted service has **not** switched from its
previous local backend.

## Verified

- Real private OSS PUT/GET with 1,048,593 bytes: matching content and metadata.
- Incorrect Content-MD5: HTTP 400; overwrite: HTTP 409; anonymous GET: HTTP 403.
- Transfer-prefix cleanup: zero objects remaining.
- PostgreSQL: 12 tests, including concurrent admission of eight transfers, idempotent retries,
  released cancellation slots, Agent metadata and cleanup checkpoints.
- Agent upload requires one destination dispatch and retains its original deadline after approval.
- Concurrent identical submissions converge on one approval and transfer.
- Connector 0.1.4, Skill 0.4.0 and harness plugin 0.1.2 distributions are built.
- Final verification: 279 unit/API tests, 12 PostgreSQL tests and 24 E2E tests passed;
  one optional platform test was skipped. TypeScript, ESLint, Prettier, protocol schemas,
  console build/prerender and `git diff --check` passed.

## Hosted infrastructure

Private bucket `adc-zioon-transfers` exists in `oss-cn-shanghai`, with private ACL and ZRS.
The `transfers/` prefix has an enabled one-day expiration and multipart-abort rule.
The public download bucket remains separate.
Versioned Connector archives and prepared Skill/plugin distributions were uploaded and checked
against their size and SHA-256 metadata. Active hosted manifests remain on the preceding release.
Prepared manifests are under `prepared/direct-transfer-0.1.4/` in the download bucket.

The deployment RAM identity can manage ECS and OSS, but Alibaba Cloud rejected `ram:CreateUser`
and `ram:ListRoles` with HTTP 403. ECS instance-role metadata returned HTTP 404.
Do not install the deployment identity as the service's storage credential.

An account administrator must create a dedicated runtime identity and attach
[the restricted storage policy](../deploy/transfer-runtime-policy.json), then provide its key
through the protected service environment. Do not paste credentials into a repository file.

## Activation

1. Back up PostgreSQL, the service environment and the active release link.
2. Confirm no nonterminal local transfers remain.
3. Install the prepared release and its dependencies; publish the Connector distributions.
4. Set `ADC_TRANSFER_BACKEND=oss`, `ADC_TRANSFER_MAX_BYTES=1073741824`,
   `ADC_TRANSFER_OSS_REGION=oss-cn-shanghai`, `ADC_TRANSFER_OSS_BUCKET=adc-zioon-transfers`,
   and the dedicated runtime key in the mode-0600 service environment.
5. Restart ADC and update participating desktop Connectors to 0.1.4.
6. Execute a real Agent upload, verify its destination receipt and file SHA-256, then verify
   transfer-prefix cleanup. Check health, authentication, task execution and cleanup warnings.

Rollback restores the previous release and environment after draining object transfers.
Migration 0013 only adds a cleanup checkpoint and is compatible with the preceding release.
Temporary chunks are not a backup substitute; durable task receipts remain in PostgreSQL.
