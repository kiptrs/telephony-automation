# rtc-telnyx

Cloudflare Worker driving a three-question voice survey over a Telnyx number.

## Flow

Outbound call answered -> start dual-channel recording -> play `q1.mp3` ->
listen via `gather_using_ai` -> `q2.mp3` -> listen -> `q3.mp3` -> listen ->
`thanks.mp3` -> hangup.

Flow position lives in Telnyx's `client_state`, so the Worker is stateless.
There is no KV namespace and no Durable Object.

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

    Invoke-RestMethod -Uri "https://<worker-host>/calls" -Method Post -Headers @{ Authorization = "Bearer $env:TRIGGER_SECRET" } -ContentType "application/json" -Body '{"to":"+37060000000"}'

bash:

    curl -X POST https://<worker-host>/calls \
      -H "Authorization: Bearer $TRIGGER_SECRET" \
      -H "Content-Type: application/json" \
      -d '{"to":"+37060000000"}'

Watch it run with `npx wrangler tail`.

## Audio

`public/audio/` currently holds four three-second silent placeholders so the
flow is testable before real audio exists. Replace them with real recordings.
Because audio ships as Worker assets, changing a recording requires a redeploy.

## Tests

    npm test
    npm run typecheck

The call flow in `src/flow.ts` is a pure function, so the whole
question-and-answer sequence is covered without Telnyx credentials or a Workers
runtime.

## Known limitations

- There is a round-trip gap between `call.playback.ended` and `gather_using_ai`
  beginning to listen. Answering instantly may clip the first word.
- `gather_using_ai` is billed at AI rates, not plain call rates.
