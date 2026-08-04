-- migrate:up
CREATE TABLE campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name             text NOT NULL,
  -- Whisper's language hint, ISO-639-1, e.g. 'lt'.
  language         text NOT NULL,
  -- The region used to parse local-format numbers, ISO-3166-1, e.g. 'LT'.
  -- Separate from language because a Lithuanian-language campaign may call
  -- numbers in another country.
  default_country  char(2) NOT NULL,
  silence_ms       integer NOT NULL DEFAULT 2500,
  thanks_s3_key    text,
  status           text NOT NULL DEFAULT 'draft',
  created_at       timestamptz NOT NULL DEFAULT now(),
  launched_at      timestamptz,
  CONSTRAINT campaigns_status_valid
    CHECK (status IN ('draft', 'running', 'paused', 'completed')),
  -- Mirrors the Worker's accepted range in flow.ts.
  CONSTRAINT campaigns_silence_ms_valid
    CHECK (silence_ms BETWEEN 500 AND 10000)
);

CREATE INDEX campaigns_tenant_id_idx ON campaigns (tenant_id, created_at DESC);

CREATE TABLE campaign_questions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id        uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  position           integer NOT NULL,
  s3_key             text NOT NULL,
  original_filename  text NOT NULL,
  bytes              bigint NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- 1-based to match flow.ts, where question() indexes questions[step - 1].
  CONSTRAINT campaign_questions_position_valid CHECK (position BETWEEN 1 AND 10),
  CONSTRAINT campaign_questions_position_unique UNIQUE (campaign_id, position)
    DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX campaign_questions_campaign_id_idx
  ON campaign_questions (campaign_id, position);

-- migrate:down
DROP TABLE campaign_questions;
DROP TABLE campaigns;
