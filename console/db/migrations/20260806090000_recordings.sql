-- migrate:up
CREATE TABLE recordings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id              uuid NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  -- Telnyx's own id. Unique so a replayed call.recording.saved is absorbed by
  -- the database rather than needing a dedupe table.
  telnyx_recording_id  text NOT NULL UNIQUE,
  source_url           text,
  channels             text,
  s3_key               text,
  bytes                bigint,
  duration_ms          integer,
  ingested_at          timestamptz,
  telnyx_deleted_at    timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX recordings_call_idx ON recordings (call_id);
-- Drives "transcribe everything in this campaign that is ready".
CREATE INDEX recordings_ingested_idx ON recordings (ingested_at)
  WHERE ingested_at IS NOT NULL;

CREATE TABLE transcripts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id  uuid NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
  engine        text NOT NULL,
  language      text,
  text          text,
  raw_s3_key    text,
  status        text NOT NULL DEFAULT 'pending',
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  CONSTRAINT transcripts_status_valid
    CHECK (status IN ('pending', 'running', 'done', 'failed')),
  -- One transcript per recording. Re-transcribing replaces it.
  CONSTRAINT transcripts_one_per_recording UNIQUE (recording_id)
);

-- migrate:down
DROP TABLE transcripts;
DROP TABLE recordings;
