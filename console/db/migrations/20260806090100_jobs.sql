-- migrate:up
CREATE TABLE jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL,
  payload       jsonb NOT NULL,
  run_at        timestamptz NOT NULL DEFAULT now(),
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 5,
  locked_at     timestamptz,
  locked_by     text,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  failed_at     timestamptz,
  CONSTRAINT jobs_kind_valid CHECK (kind IN ('ingest_recording', 'transcribe'))
);

-- The claim query's index: only unfinished jobs are ever scanned.
CREATE INDEX jobs_claimable_idx ON jobs (run_at)
  WHERE completed_at IS NULL AND failed_at IS NULL;

-- migrate:down
DROP TABLE jobs;
