# Telnyx Voice Survey Worker — Design

Date: 2026-08-03
Status: Approved, pending implementation plan

## Problem

Run a scripted three-question voice survey over a Telnyx phone number. An
outbound call is triggered from the CLI. The callee hears three pre-recorded
questions in the operator's own voice, answers each one by speaking, then hears
a thank-you recording and the call ends. The whole call is recorded.

## Scope

In scope for the MVP:

- Outbound call, triggered by the operator from a CLI.
- Full-call recording, dual channel, stored by Telnyx.
- Three questions played as pre-recorded audio files.
- Spoken (not DTMF) answers, with end-of-speech detected by Telnyx.
- Thank-you recording, then hangup.

Out of scope:

- Inbound calls to the Telnyx number.
- Persisting answers or recordings to a queryable store. Answers and the
  recording URL are written to Worker logs only.
- Retry, voicemail detection, or branching based on answer content.
- Producing the audio files. The operator records these; the repo ships silent
  placeholders so the flow is testable before real audio exists.

## Approach

A single Cloudflare Worker, stateless. There is no KV namespace and no Durable
Object. Flow position is carried in Telnyx's `client_state` field, a base64
string that is attached to an outgoing command and echoed back on every
subsequent webhook for that call.

End-of-speech detection is delegated entirely to Telnyx's `gather_using_ai`
command. The `greeting` parameter is omitted so the command plays nothing and
only listens; end-of-utterance, barge-in, and the silence fallback
(`user_response_timeout_ms`, default 10000) are handled by Telnyx.

This combination — `playback_start` for the question, `gather_using_ai` for the
answer — is what lets the questions stay in the operator's recorded voice while
still getting managed end-of-speech. `gather_using_ai` alone cannot do it: its
`greeting` is a TTS string and accepts no audio URL.

### Approaches considered and rejected

**Inbound-only transcription (`transcription_start` with
`transcription_tracks: "inbound"`), advancing on the first final
`call.transcription` after each question.** Cheaper — speech-to-text only, no
LLM — and yields answer transcripts for free. Rejected because a long answer can
chunk into several final results and advance the flow early, and because a
silent respondent stalls the flow with no built-in timeout.

**Media streaming to a Durable Object running voice-activity detection.** Full
control over the silence threshold. Rejected as disproportionate for an MVP and
the only option requiring stateful infrastructure.

**DTMF turn-taking (`gather_using_audio` with `terminating_digit: "#"`).**
Simplest and cheapest of all. Rejected because it requires the respondent to use
the keypad, which the operator ruled out.

## Interfaces

### Routes

| Route | Purpose |
|---|---|
| `POST /calls` | CLI trigger. Requires `Authorization: Bearer $TRIGGER_SECRET`. Body `{"to": "+E164"}`. Issues Telnyx `POST /v2/calls`. Returns the `call_control_id`. |
| `POST /webhooks/telnyx` | Webhook sink and state machine. Ed25519-verified. |
| `GET /audio/*` | The four recordings, served as Worker static assets. |

Telnyx fetches `audio_url` over public HTTPS, so the audio is served from the
Worker's own public hostname. Because the audio ships in the Worker bundle,
replacing a recording requires a redeploy. This is an accepted tradeoff for
keeping the system to one deploy unit.

### Telnyx command endpoint

`POST https://api.telnyx.com/v2/calls/{call_control_id}/actions/{command}` with
`Authorization: Bearer $TELNYX_API_KEY`.

The API key is held only in Worker secrets. The CLI authenticates to the Worker
with `TRIGGER_SECRET` and never handles the Telnyx key.

## State machine

`client_state` decodes to `{ step: 1 | 2 | 3 | "done" }`.

| Webhook received | Condition | Commands sent |
|---|---|---|
| `call.answered` | — | `record_start` (`channels: "dual"`, `format: "mp3"`), then `playback_start` q1 with `step:1` |
| `call.playback.ended` | `step` is 1..3 | `gather_using_ai` with `step:N`, greeting omitted |
| `call.ai_gather.ended` | `step` < 3 | `playback_start` q(N+1) with `step:N+1` |
| `call.ai_gather.ended` | `step` == 3 | `playback_start` thanks.mp3 with `step:"done"` |
| `call.playback.ended` | `step` == `"done"` | `hangup` |
| `call.recording.saved` | — | none; log recording URL |
| `call.hangup` | — | none; log |
| anything else | — | none |

`step:"done"` is the discriminator that separates the thank-you playback from a
question playback; both arrive as `call.playback.ended`.

Each `gather_using_ai` call supplies the minimal schema required by the
mandatory `parameters` field:

```json
{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}
```

Structured extraction is not the goal here, but this makes the caller's answer
available as text on `call.ai_gather.ended` at no extra cost.

## Module boundaries

The state machine is a pure function with no network access and no environment
dependency:

```
decide(eventType: string, state: FlowState, payload: unknown): Command[]
```

It returns a list because `call.answered` issues two commands (`record_start`
then `playback_start`). An empty array means "do nothing", which is the correct
response to unhandled events.

This is the primary isolation boundary. It makes the entire call flow unit
testable without Telnyx credentials or a Workers runtime, and keeps the I/O
modules free of business logic.

```
cf-worker/
  src/
    index.ts     # routing; verifies, decides, dispatches, returns 200
    flow.ts      # pure decide()
    state.ts     # client_state encode/decode
    telnyx.ts    # createCall(), sendCommand()
    verify.ts    # Ed25519 webhook signature check
  assets/        # q1.mp3 q2.mp3 q3.mp3 thanks.mp3
  test/flow.test.ts
  wrangler.toml
```

Each module has one job: `flow.ts` decides, `telnyx.ts` talks to Telnyx,
`verify.ts` authenticates, `state.ts` serializes. `index.ts` wires them together
and owns no rules of its own.

## Error handling

- Invalid or missing Ed25519 signature returns 401 with no side effects.
- Unrecognised or unhandled `event_type` returns 200 with no command. Returning
  a non-2xx would make Telnyx retry the webhook, which would re-issue commands
  and double-advance the flow.
- A failed Telnyx command is logged and followed by a best-effort `hangup`, so a
  broken flow does not leave the callee on a silent open line.
- Commands are issued before the Worker responds 200. Nothing is deferred to
  `ctx.waitUntil`, so there is no race between the response and the command.

## Security

- `POST /calls` requires a bearer token compared in constant time. Without it,
  the endpoint is an open dialer billable to the operator's Telnyx account.
- Webhooks are verified with Ed25519 over `Telnyx-Timestamp` and the raw body,
  using the `Telnyx-Signature-Ed25519` header and the public key from the Telnyx
  portal. Timestamps older than a five-minute tolerance are rejected to prevent
  replay.
- All secrets are Worker secrets (`wrangler secret put`), never in
  `wrangler.toml`.

## Testing

- `test/flow.test.ts` drives `decide()` through the full happy path — answered,
  three question/answer rounds, thank-you, hangup — asserting the exact command
  and `client_state` at each step.
- Edge cases covered: `call.playback.ended` at `step:"done"` produces `hangup`
  and not a fourth question; unknown event types produce an empty array;
  malformed or absent `client_state` does not throw.
- `verify.ts` is tested against a known-good signature fixture and a tampered
  body.
- Manual verification is a real call to the operator's own phone, confirming the
  recording appears via `call.recording.saved` and the three answers are present
  in the logs.

## Known limitations

- There is a round-trip gap between `call.playback.ended` and `gather_using_ai`
  beginning to listen. A respondent who answers instantly may have the first
  word clipped. This is inherent to combining recorded audio with
  `gather_using_ai` and is not fixable without switching questions to TTS.
- `gather_using_ai` is billed at AI rates, not plain call rates.
- Replacing a recording requires a redeploy, since audio ships as Worker assets.
