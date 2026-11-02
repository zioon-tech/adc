ALTER TABLE adc_nodes ADD COLUMN resource_class text NOT NULL DEFAULT 'physical'
  CHECK (resource_class IN ('physical', 'managed', 'platform'));
ALTER TABLE adc_approvals
  ADD COLUMN required_consents jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN consents jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX adc_approval_consents_idx ON adc_approvals USING gin(required_consents);
