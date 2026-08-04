-- migrate:up
CREATE TABLE phone_numbers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  e164              text NOT NULL UNIQUE,
  telnyx_number_id  text,
  -- NULL means the number is in the shared pool. Set it to dedicate the number
  -- to one tenant; the allocator already honours it.
  tenant_id         uuid REFERENCES tenants (id) ON DELETE SET NULL,
  max_concurrent    integer NOT NULL DEFAULT 1,
  status            text NOT NULL DEFAULT 'active',
  last_used_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT phone_numbers_status_valid
    CHECK (status IN ('active', 'paused', 'released')),
  CONSTRAINT phone_numbers_max_concurrent_valid CHECK (max_concurrent >= 1),
  CONSTRAINT phone_numbers_e164_format CHECK (e164 ~ '^\+[1-9][0-9]{6,14}$')
);

CREATE INDEX phone_numbers_available_idx
  ON phone_numbers (last_used_at NULLS FIRST) WHERE status = 'active';

CREATE TABLE number_leases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_number_id  uuid NOT NULL REFERENCES phone_numbers (id) ON DELETE CASCADE,
  -- Set once the call row exists. The lease is taken first, in the same
  -- transaction, so this is filled in immediately after.
  call_id          uuid,
  acquired_at      timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  released_at      timestamptz
);

-- The allocator counts unreleased, unexpired leases per number, so this index
-- is what keeps that count cheap.
CREATE INDEX number_leases_active_idx
  ON number_leases (phone_number_id) WHERE released_at IS NULL;

CREATE INDEX number_leases_call_id_idx ON number_leases (call_id);

-- migrate:down
DROP TABLE number_leases;
DROP TABLE phone_numbers;
