ALTER TABLE adc_transfers ADD COLUMN IF NOT EXISTS storage_cleaned_at timestamptz;
CREATE INDEX IF NOT EXISTS adc_transfer_cleanup_idx
  ON adc_transfers (updated_at) WHERE storage_cleaned_at IS NULL;
