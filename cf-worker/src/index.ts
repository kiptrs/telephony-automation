import {
  decide,
  normaliseSilenceMs,
  type AudioManifest,
  type Command,
  type Env,
} from "./flow";
import { notify, type CallbackEvent } from "./callback";
import { parseManifest } from "./manifest";
import { decodeState } from "./state";
import { createCall, sendCommand, TelnyxError } from "./telnyx";
import { verifyTelnyxSignature } from "./verify";

export { CallSession } from "./session";
export type { Env };

interface TelnyxWebhook {
  data?: {
    event_type?: string;
    payload?: {
      call_control_id?: string;
      client_state?: string | null;
      [key: string]: unknown;
    };
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Length-safe constant-time comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  let diff = aBytes.length ^ bBytes.length;
  const max = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < max; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

function sessionFor(env: Env, callControlId: string): DurableObjectStub {
  return env.CALL_SESSIONS.get(env.CALL_SESSIONS.idFromName(callControlId));
}

async function manifestFor(
  env: Env,
  callControlId: string,
): Promise<AudioManifest | null> {
  const response = await sessionFor(env, callControlId).fetch(
    "https://session/manifest",
  );
  if (!response.ok) return null;
  return (await response.json()) as AudioManifest;
}

async function hangUp(env: Env, callControlId: string): Promise<void> {
  try {
    await sendCommand(
      callControlId,
      { action: "hangup", params: {} },
      env.TELNYX_API_KEY,
    );
  } catch {
    // Nothing further we can do.
  }
}

/**
 * decide() cannot build the stream URL alone: it needs the call_control_id so
 * the media socket lands on the same Durable Object the webhooks address.
 */
function withCallId(command: Command, callControlId: string): Command {
  if (command.action !== "streaming_start") return command;

  const url = new URL(String(command.params.stream_url));
  url.searchParams.set("ccid", callControlId);

  return { ...command, params: { ...command.params, stream_url: url.toString() } };
}

/** Telnyx will reject a bad number anyway; catching it here saves a billed dial. */
const E164 = /^\+[1-9][0-9]{6,14}$/;

const CALLBACK_EVENTS = new Set([
  "call.answered",
  "call.hangup",
  "call.recording.saved",
]);

async function handleWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await request.text();

  const valid = await verifyTelnyxSignature({
    rawBody,
    signature: request.headers.get("telnyx-signature-ed25519"),
    timestamp: request.headers.get("telnyx-timestamp"),
    publicKeyB64: env.TELNYX_PUBLIC_KEY,
  });
  if (!valid) return json({ error: "invalid signature" }, 401);

  let webhook: TelnyxWebhook;
  try {
    webhook = JSON.parse(rawBody) as TelnyxWebhook;
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const eventType = webhook.data?.event_type;
  const callControlId = webhook.data?.payload?.call_control_id;
  if (!eventType || !callControlId) return json({ ok: true });

  const clientState = webhook.data?.payload?.client_state;
  console.log(
    JSON.stringify({
      msg: "webhook",
      event_type: eventType,
      call_control_id: callControlId,
      payload: webhook.data?.payload,
    }),
  );

  const requestUrl = new URL(request.url);
  const origin = requestUrl.origin;

  const callbackUrl = requestUrl.searchParams.get("cb");
  if (callbackUrl && CALLBACK_EVENTS.has(eventType)) {
    const state = decodeState(clientState);
    const event: CallbackEvent = {
      event: eventType,
      call_control_id: callControlId,
      occurred_at: new Date().toISOString(),
      step: state?.step ?? null,
      payload: webhook.data?.payload ?? {},
    };
    // waitUntil, not await: the console must never be able to delay or fail
    // this handler's 200.
    ctx.waitUntil(
      notify({ url: callbackUrl, secret: env.CONSOLE_HMAC_SECRET, event }),
    );
  }

  // A question has finished playing: tell the session to start listening for
  // the answer. This is the only trigger that starts voice detection.
  if (eventType === "call.playback.ended") {
    const state = decodeState(clientState);
    if (state && state.step !== "done") {
      await sessionFor(env, callControlId).fetch(
        `https://session/arm?step=${state.step}`,
      );
    }
  }

  // Per-call manifests must not accumulate in Durable Object storage.
  if (eventType === "call.hangup") {
    await sessionFor(env, callControlId).fetch("https://session/end", {
      method: "POST",
    });
  }

  // Only call.answered needs the manifest, so only it pays for the round trip.
  let audio: AudioManifest | undefined;
  if (eventType === "call.answered") {
    audio = (await manifestFor(env, callControlId)) ?? undefined;
    if (!audio) {
      console.log(
        JSON.stringify({
          msg: "manifest_missing",
          call_control_id: callControlId,
        }),
      );
      await hangUp(env, callControlId);
      return json({ ok: true });
    }
  }

  const commands = decide({
    eventType,
    clientState,
    originUrl: origin,
    audio,
    silenceMs: requestUrl.searchParams.get("silenceMs"),
  });

  for (const command of commands) {
    const finalCommand = withCallId(command, callControlId);
    try {
      const result = await sendCommand(
        callControlId,
        finalCommand,
        env.TELNYX_API_KEY,
      );
      console.log(
        JSON.stringify({
          msg: "command_sent",
          action: finalCommand.action,
          params: finalCommand.params,
          response: result.slice(0, 500),
        }),
      );
    } catch (error) {
      const status = error instanceof TelnyxError ? error.status : 0;
      console.log(
        JSON.stringify({
          msg: "command_failed",
          action: finalCommand.action,
          status,
          error: String(error),
        }),
      );
      // Do not leave the callee on a silent open line.
      if (finalCommand.action !== "hangup") {
        await hangUp(env, callControlId);
      }
      break;
    }
  }

  // Always 200: a non-2xx makes Telnyx retry and double-advance the flow.
  return json({ ok: true });
}

async function handleCreateCall(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!timingSafeEqual(token, env.TRIGGER_SECRET)) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: {
    to?: unknown;
    from?: unknown;
    silenceMs?: unknown;
    audio?: unknown;
    callbackUrl?: unknown;
  };
  try {
    body = (await request.json()) as {
      to?: unknown;
      from?: unknown;
      silenceMs?: unknown;
      audio?: unknown;
      callbackUrl?: unknown;
    };
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const to = body.to;
  if (typeof to !== "string" || to.length === 0) {
    return json({ error: "`to` is required" }, 400);
  }

  const from = body.from ?? env.TELNYX_FROM_NUMBER;
  if (typeof from !== "string" || !E164.test(from)) {
    return json({ error: "`from` must be an E.164 number" }, 400);
  }

  let callbackUrl: string | null = null;
  if (body.callbackUrl !== undefined) {
    if (typeof body.callbackUrl !== "string") {
      return json({ error: "`callbackUrl` must be a string" }, 400);
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(body.callbackUrl);
    } catch {
      return json({ error: "`callbackUrl` is not a valid URL" }, 400);
    }
    // A signed callback sent in clear text leaks its own signature.
    if (parsedUrl.protocol !== "https:") {
      return json({ error: "`callbackUrl` must use https" }, 400);
    }
    callbackUrl = parsedUrl.toString();
  }

  const parsed = parseManifest(body.audio);
  if ("error" in parsed) {
    return json({ error: `${parsed.error.field} ${parsed.error.reason}` }, 400);
  }

  const silenceMs = normaliseSilenceMs(body.silenceMs);
  const origin = new URL(request.url).origin;

  const webhookUrl = new URL(`${origin}/webhooks/telnyx`);
  webhookUrl.searchParams.set("silenceMs", String(silenceMs));
  if (callbackUrl) webhookUrl.searchParams.set("cb", callbackUrl);

  let callControlId: string;
  try {
    callControlId = await createCall({
      to,
      from,
      connectionId: env.TELNYX_CONNECTION_ID,
      webhookUrl: webhookUrl.toString(),
      apiKey: env.TELNYX_API_KEY,
    });
  } catch (error) {
    const status = error instanceof TelnyxError ? error.status : 502;
    return json({ error: String(error) }, status >= 400 && status < 600 ? status : 502);
  }

  // Seeding can only happen after the dial, because the call_control_id does
  // not exist until then. A live call with no audio is worse than a dropped
  // one, so a seeding failure hangs up the call we just placed.
  const seeded = await sessionFor(env, callControlId).fetch(
    "https://session/init",
    { method: "POST", body: JSON.stringify(parsed.manifest) },
  );
  if (!seeded.ok) {
    console.log(
      JSON.stringify({ msg: "seed_failed", call_control_id: callControlId }),
    );
    await hangUp(env, callControlId);
    return json({ error: "failed to seed call session" }, 502);
  }

  return json({ call_control_id: callControlId, silenceMs });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhooks/telnyx") {
      return handleWebhook(request, env, ctx);
    }
    if (request.method === "POST" && url.pathname === "/calls") {
      return handleCreateCall(request, env);
    }
    // Telnyx's media stream. Routed to the session for this call so the audio
    // and the webhooks reach the same object.
    if (url.pathname === "/stream") {
      const ccid = url.searchParams.get("ccid");
      if (!ccid) return json({ error: "ccid required" }, 400);
      return sessionFor(env, ccid).fetch(request);
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
