-- migrate:up
CREATE TABLE contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  e164          text NOT NULL,
  external_ref  text,
  status        text NOT NULL DEFAULT 'pending',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contacts_status_valid
    CHECK (status IN ('pending', 'dialing', 'done')),
  CONSTRAINT contacts_e164_format CHECK (e164 ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT contacts_unique_per_campaign UNIQUE (campaign_id, e164)
);

-- Supports the dispatcher's "next pending contact" claim in Plan 2.
CREATE INDEX contacts_pending_idx
  ON contacts (campaign_id, created_at) WHERE status = 'pending';

-- migrate:down
DROP TABLE contacts;
