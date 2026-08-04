# rtc-telnyx

Cloudflare Worker driving a three-question voice survey over a Telnyx number.

## Flow

Outbound call answered -> dual-channel recording + media stream opened ->
question 1 -> caller answers -> question 2 -> answers -> ... -> thank-you ->
hangup.

The audio is supplied per call, 1 to 10 questions plus a thank-you. Nothing is
bundled with the Worker.

Answers end when the caller **stops speaking for `silenceMs`** (default 2500).
Detection is done here, not by Telnyx: `streaming_start` forks the caller's
inbound audio to a WebSocket, and a Durable Object measures the energy of each
20ms mu-law frame.

### Responsibilities

| Piece | Owns |
|---|---|
| `src/vad.ts` | mu-law decoding and the silence decision. Pure, fully unit tested. |
| `src/session.ts` | `CallSession` Durable Object: the media socket, per-call VAD state, and the audio manifest. Plays the next question when an answer ends. |
| `src/flow.ts` | Call setup and hangup. Pure. |
| `src/manifest.ts` | Validating the per-call audio manifest, including SigV4 expiry. Pure, fully unit tested. |
| `src/index.ts` | Routing; validates and seeds the manifest, arms the session when a question finishes playing. |

The Worker itself stays stateless. Only the Durable Object holds state, because
silence is only observable by watching a live stream over time.

### Why not Telnyx's own speech features

Both were tried against a live number and both failed:

- `gather_using_ai` is a conversational LLM assistant, not a silence detector.
  Omitting its `greeting` suppresses only the opening line; it still spoke its
  own follow-up questions in TTS (`Telnyx.KokoroTTS.af`), and returned
  `422 AI Assistant is already in progress` when the flow tried to advance.
- `transcription_start` returned 200 and then emitted no `call.transcription`
  events at all, across several engine configurations.

Media streaming depends on neither subsystem.

### Tuning

`SPEECH_THRESHOLD` in `src/vad.ts` is the mean absolute amplitude (0..32768)
above which a frame counts as speech. If a call never advances, the threshold
is likely too low and background noise is holding the answer open; raise it. A
threshold that is too high degrades safely - the answer ends at the 30 second
`MAX_ANSWER_MS` cap rather than misbehaving.

Watch `stream_open`, `vad_armed`, and `answer_ended` in `wrangler tail`.

## Setup

Set the secrets:

    npx wrangler secret put TELNYX_API_KEY
    npx wrangler secret put TELNYX_PUBLIC_KEY
    npx wrangler secret put TELNYX_CONNECTION_ID
    npx wrangler secret put TELNYX_FROM_NUMBER
    npx wrangler secret put TRIGGER_SECRET

`TELNYX_PUBLIC_KEY` is the base64 Ed25519 public key from the Telnyx portal.
`TELNYX_CONNECTION_ID` is the Voice API application id.
`TELNYX_FROM_NUMBER` is the Telnyx number you bought, in E.164.
`TRIGGER_SECRET` is any long random string you choose.

Deploy:

    npm run deploy

In the Telnyx portal, set the Voice API application's webhook URL to
`https://<worker-host>/webhooks/telnyx`. The Worker also passes `webhook_url`
per call, but setting it in the portal keeps the two consistent.

## Placing a call

PowerShell (note: `curl` is an alias for `Invoke-WebRequest` and will not accept
`-H`; use `Invoke-RestMethod` or the real `curl.exe`):

    Invoke-RestMethod -Uri "https://<worker-host>/calls" -Method Post -Headers @{ Authorization = "Bearer $env:TRIGGER_SECRET" } -ContentType "application/json" -Body '{"to":"+37060000000","audio":{"questions":["https://bucket.s3.amazonaws.com/q1.mp3?X-Amz-..."],"thanks":"https://bucket.s3.amazonaws.com/thanks.mp3?X-Amz-..."}}'

### Audio

`audio` is required. `questions` holds 1 to 10 HTTPS URLs; `thanks` is a single
HTTPS URL. Telnyx fetches each one at the moment it plays, so pre-signed URLs
must stay valid for the whole call - sign for 60 minutes. The Worker rejects the
request without dialling if a SigV4 URL has too little life left, computed from
the question count.

`http:` is rejected outright: Telnyx needs public HTTPS anyway, and a pre-signed
URL sent in clear text leaks its own signature.

### Silence threshold

`silenceMs` is optional and sets how long the caller must be quiet before the
answer is treated as finished. Default 2500, accepted range 500-10000; anything
outside that silently falls back to the default.

    -Body '{"to":"+37069625082","silenceMs":3000}'

The setting travels to the media stream on the `webhook_url` and `stream_url`
query strings.

There is no language setting, because nothing in this flow transcribes speech -
it only measures loudness.

bash:

    curl -X POST https://<worker-host>/calls \
      -H "Authorization: Bearer $TRIGGER_SECRET" \
      -H "Content-Type: application/json" \
      -d '{
            "to": "+37060000000",
            "audio": {
              "questions": ["https://bucket.s3.amazonaws.com/q1.mp3?X-Amz-...", "https://bucket.s3.amazonaws.com/q2.mp3?X-Amz-..."],
              "thanks": "https://bucket.s3.amazonaws.com/thanks.mp3?X-Amz-..."
            }
          }'

Watch it run with `npx wrangler tail`.

## Audio

Audio is supplied per call, not bundled. The caller of `POST /calls` passes
HTTPS URLs; nothing is served from this Worker. `public/audio/` still holds the
original silent placeholders but the flow no longer reads them.

Telnyx fetches each URL over public HTTPS at the moment it plays, so the URLs
must be reachable from the internet and must outlive the call. Replacing a
recording no longer requires a redeploy - it is entirely the caller's concern.

## Tests

    npm test
    npm run typecheck

The call flow in `src/flow.ts` is a pure function, so the whole
question-and-answer sequence is covered without Telnyx credentials or a Workers
runtime.

## Known limitations

- There is a round-trip gap between `call.playback.ended` and the session being
  armed. Answering instantly may clip the first word.
- A pre-signed URL valid at dial time can still expire before the thank-you
  plays. The runway check at `POST /calls` shrinks this window but cannot close
  it.
- A call that never produces a `call.hangup` webhook leaves its manifest in
  Durable Object storage.
