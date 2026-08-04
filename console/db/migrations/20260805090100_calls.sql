-- migrate:up
CREATE TABLE calls (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id              uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  contact_id               uuid NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  phone_number_id          uuid REFERENCES phone_numbers (id) ON DELETE SET NULL,
  attempt                  integer NOT NULL DEFAULT 1,
  telnyx_call_control_id   text UNIQUE,
  status                   text NOT NULL DEFAULT 'queued',
  outcome                  text,
  -- The flow step the caller reached, copied from the Worker's client_state.
  -- 0 encodes "done"; a positive number is the question they were on.
  last_step                integer,
  hangup_cause             text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  dialed_at                timestamptz,
  answered_at              timestamptz,
  ended_at                 timestamptz,
  CONSTRAINT calls_status_valid
    CHECK (status IN ('queued', 'dialing', 'in_progress', 'ended', 'failed')),
  CONSTRAINT calls_outcome_valid
    CHECK (outcome IS NULL OR outcome IN
      ('completed', 'abandoned', 'no_answer', 'busy', 'failed', 'unknown'))
);

CREATE INDEX calls_campaign_idx ON calls (campaign_id, created_at DESC);
CREATE INDEX calls_contact_idx ON calls (contact_id);

-- Finding the call a callback belongs to is the hottest lookup in the system.
CREATE INDEX calls_ccid_idx ON calls (telnyx_call_control_id)
  WHERE telnyx_call_control_id IS NOT NULL;

ALTER TABLE number_leases
  ADD CONSTRAINT number_leases_call_id_fkey
  FOREIGN KEY (call_id) REFERENCES calls (id) ON DELETE SET NULL;

-- migrate:down
ALTER TABLE number_leases DROP CONSTRAINT number_leases_call_id_fkey;
DROP TABLE calls;
