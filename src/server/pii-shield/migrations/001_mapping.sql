/* glirastes:privacy-mapping-schema */
CREATE TABLE IF NOT EXISTS glirastes_privacy_mapping_scopes (
  scope_key text PRIMARY KEY,
  tenant_id text NOT NULL,
  app_id text NOT NULL,
  environment text NOT NULL,
  principal_id text NOT NULL,
  conversation_id text NOT NULL,
  generation text NOT NULL,
  version bigint NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS glirastes_privacy_mapping_scopes_principal_idx
  ON glirastes_privacy_mapping_scopes (tenant_id, principal_id);
CREATE INDEX IF NOT EXISTS glirastes_privacy_mapping_scopes_expiry_idx
  ON glirastes_privacy_mapping_scopes (idle_expires_at);
CREATE TABLE IF NOT EXISTS glirastes_privacy_mapping_entries (
  scope_key text NOT NULL REFERENCES glirastes_privacy_mapping_scopes (scope_key) ON DELETE CASCADE,
  generation text NOT NULL,
  original_digest text NOT NULL,
  pseudonym_digest text NOT NULL,
  key_id text NOT NULL,
  sealed text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (scope_key, generation, original_digest),
  UNIQUE (scope_key, generation, pseudonym_digest)
);
CREATE TABLE IF NOT EXISTS glirastes_privacy_mapping_tokens (
  scope_key text NOT NULL REFERENCES glirastes_privacy_mapping_scopes (scope_key) ON DELETE CASCADE,
  generation text NOT NULL,
  digest text NOT NULL,
  PRIMARY KEY (scope_key, generation, digest)
);
CREATE TABLE IF NOT EXISTS glirastes_privacy_mapping_bindings (
  scope_key text NOT NULL REFERENCES glirastes_privacy_mapping_scopes (scope_key) ON DELETE CASCADE,
  generation text NOT NULL,
  digest text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (scope_key, generation, digest)
);
