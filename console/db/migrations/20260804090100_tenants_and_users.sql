-- migrate:up
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid REFERENCES tenants (id) ON DELETE CASCADE,
  email          citext NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  role           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_role_valid CHECK (role IN ('platform_admin', 'member')),
  -- A platform admin belongs to no tenant; a member must belong to one.
  -- Encoding this here means no application bug can produce a member with
  -- NULL tenant_id, which would silently escape every tenant-scoped query.
  CONSTRAINT users_tenant_matches_role CHECK (
    (role = 'platform_admin' AND tenant_id IS NULL) OR
    (role = 'member' AND tenant_id IS NOT NULL)
  )
);

CREATE INDEX users_tenant_id_idx ON users (tenant_id);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- migrate:down
DROP TABLE sessions;
DROP TABLE users;
DROP TABLE tenants;
