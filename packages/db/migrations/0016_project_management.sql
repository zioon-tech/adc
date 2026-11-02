ALTER TABLE adc_projects ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE adc_projects ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE adc_roots ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE adc_roots ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE adc_projects DROP CONSTRAINT IF EXISTS adc_projects_account_id_label_key;
CREATE UNIQUE INDEX IF NOT EXISTS adc_projects_active_label_idx
  ON adc_projects (account_id, label) WHERE deleted_at IS NULL;
ALTER TABLE adc_roots DROP CONSTRAINT IF EXISTS adc_roots_project_id_node_id_label_key;
CREATE UNIQUE INDEX IF NOT EXISTS adc_roots_active_label_idx
  ON adc_roots (project_id, node_id, label) WHERE deleted_at IS NULL;
