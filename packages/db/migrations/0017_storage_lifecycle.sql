-- Independent retention clock; invocation.expiresAt remains the execution deadline.
ALTER TABLE adc_dispatches
  ADD COLUMN result_bytes bigint NOT NULL DEFAULT 0,
  ADD COLUMN result_initialized boolean NOT NULL DEFAULT false,
  ADD COLUMN input_bytes bigint,
  ADD COLUMN result_sha256 text,
  ADD COLUMN result_expires_at timestamptz,
  ADD COLUMN result_retired_at timestamptz,
  ADD COLUMN result_consumed_at timestamptz,
  ADD COLUMN details_retired_at timestamptz,
  ADD COLUMN summary_retired_at timestamptz;
ALTER TABLE adc_artifacts
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN consumed_at timestamptz,
  ADD COLUMN retired_at timestamptz;
ALTER TABLE adc_approvals
  ADD COLUMN storage_details_retired_at timestamptz,
  ADD COLUMN input_bytes bigint;
CREATE INDEX adc_approval_detail_retention_idx ON adc_approvals(expires_at)
  WHERE storage_details_retired_at IS NULL;
CREATE INDEX adc_result_expiry_idx ON adc_dispatches(result_expires_at)
  WHERE result_retired_at IS NULL;
CREATE INDEX adc_dispatch_detail_retention_idx ON adc_dispatches(updated_at)
  WHERE details_retired_at IS NULL;
CREATE INDEX adc_artifact_expiry_idx ON adc_artifacts(expires_at) WHERE retired_at IS NULL;
CREATE INDEX adc_artifact_content_idx ON adc_artifacts(content_sha256) WHERE retired_at IS NULL;

-- Legacy values are initialized in bounded maintenance batches, not in this DDL transaction.
-- Smaller updates allow ordinary autovacuum to reuse pages; no automatic VACUUM FULL.
ALTER TABLE adc_dispatches SET (autovacuum_vacuum_scale_factor = 0.02);
ALTER TABLE adc_artifacts SET (autovacuum_vacuum_scale_factor = 0.02);
