CREATE TABLE IF NOT EXISTS adc_transfers (
  transfer_id text PRIMARY KEY,
  invocation_id text NOT NULL UNIQUE,
  account_id text NOT NULL REFERENCES adc_accounts(account_id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  grant_id text NOT NULL,
  idempotency_key text,
  input_hash text NOT NULL,
  invocation jsonb NOT NULL,
  args jsonb NOT NULL,
  status text NOT NULL CHECK (
    status IN (
      'awaiting_approval', 'queued', 'transferring', 'verifying',
      'succeeded', 'failed', 'denied', 'cancelled', 'unknown_outcome'
    )
  ),
  source_dispatch_id text REFERENCES adc_dispatches(dispatch_id),
  destination_dispatch_id text REFERENCES adc_dispatches(dispatch_id),
  byte_size bigint,
  chunk_count integer,
  content_sha256 text,
  bytes_transferred bigint NOT NULL DEFAULT 0,
  error jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS adc_transfer_idempotency_idx
  ON adc_transfers (account_id, actor_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS adc_transfer_source_dispatch_idx
  ON adc_transfers (source_dispatch_id);

CREATE INDEX IF NOT EXISTS adc_transfer_destination_dispatch_idx
  ON adc_transfers (destination_dispatch_id);
