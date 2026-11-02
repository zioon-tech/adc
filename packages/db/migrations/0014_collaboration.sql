ALTER TABLE adc_accounts ADD COLUMN kind text NOT NULL DEFAULT 'personal'
  CHECK (kind IN ('personal', 'team'));
ALTER TABLE adc_agent_grants
  ADD COLUMN responsible_user_id text,
  ADD COLUMN resource_bindings jsonb NOT NULL DEFAULT '[]'::jsonb;
UPDATE adc_agent_grants g SET responsible_user_id = a.user_id
  FROM adc_accounts a WHERE a.account_id = g.account_id;

CREATE TABLE adc_team_members (
  account_id text NOT NULL REFERENCES adc_accounts(account_id) ON DELETE CASCADE,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  state text NOT NULL CHECK (state IN ('active', 'removed')),
  revision integer NOT NULL DEFAULT 1,
  rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX adc_team_member_user_idx ON adc_team_members(user_id, state);

CREATE TABLE adc_resource_bindings (
  binding_id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('share', 'team')),
  node_id text NOT NULL REFERENCES adc_nodes(node_id),
  resource_account_id text NOT NULL REFERENCES adc_accounts(account_id),
  recipient_account_id text NOT NULL REFERENCES adc_accounts(account_id),
  recipient_user_id text,
  state text NOT NULL CHECK (state IN ('active', 'paused', 'revoked')),
  revision integer NOT NULL DEFAULT 1,
  record jsonb NOT NULL
);
CREATE UNIQUE INDEX adc_binding_active_recipient_idx
  ON adc_resource_bindings(node_id, recipient_account_id, kind)
  WHERE state <> 'revoked';
CREATE INDEX adc_binding_recipient_idx ON adc_resource_bindings(recipient_account_id, state);
CREATE INDEX adc_binding_owner_idx ON adc_resource_bindings(resource_account_id, state);
CREATE TABLE adc_binding_revisions (
  binding_id text NOT NULL REFERENCES adc_resource_bindings(binding_id),
  revision integer NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY(binding_id, revision)
);

CREATE TABLE adc_collaboration_invitations (
  invitation_id text PRIMARY KEY,
  sender_account_id text NOT NULL REFERENCES adc_accounts(account_id),
  recipient_email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('pending', 'accepted', 'declined', 'revoked')),
  revision integer NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  record jsonb NOT NULL
);
CREATE INDEX adc_invitation_inbox_idx
  ON adc_collaboration_invitations(recipient_email, state, expires_at);
CREATE INDEX adc_invitation_sender_idx ON adc_collaboration_invitations(sender_account_id);
CREATE TABLE adc_collaboration_outbox (
  event_id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES adc_accounts(account_id),
  user_id text,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  delivered_at timestamptz
);
CREATE INDEX adc_dispatch_delegation_idx
  ON adc_dispatches((invocation->'delegation'->>'bindingId'), status);
