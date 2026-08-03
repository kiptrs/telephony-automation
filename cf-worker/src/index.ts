import { decide, normaliseSilenceMs, type Command, type Env } from "./flow";
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

/**
 * decide() cannot build the stream URL alone: it needs the call_control_id so
 * the media socket lands on the same Durable Object the webhooks address.
 */
function withCallId(command: Command, callControlId: string, origin: string): Command {
  if (command.action !== "streaming_start") return command;

  const url = new URL(String(command.params.stream_url));
  url.searchParams.set("ccid", callControlId);
  url.searchParams.set("origin", origin);

  return { ...command, params: { ...command.params, stream_url: url.toString() } };
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
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

  const commands = decide({
    eventType,
    clientState,
    originUrl: origin,
    silenceMs: requestUrl.searchParams.get("silenceMs"),
  });

  for (const command of commands) {
    const finalCommand = withCallId(command, callControlId, origin);
    try {
      const result = await sendCommand(callControlId, finalCommand, env.TELNYX_API_KEY);
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

  let body: { to?: unknown; silenceMs?: unknown };
  try {
    body = (await request.json()) as { to?: unknown; silenceMs?: unknown };
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const to = body.to;
  if (typeof to !== "string" || to.length === 0) {
    return json({ error: "`to` is required" }, 400);
  }

  const silenceMs = normaliseSilenceMs(body.silenceMs);
  const origin = new URL(request.url).origin;

  const webhookUrl = new URL(`${origin}/webhooks/telnyx`);
  webhookUrl.searchParams.set("silenceMs", String(silenceMs));

  try {
    const callControlId = await createCall({
      to,
      from: env.TELNYX_FROM_NUMBER,
      connectionId: env.TELNYX_CONNECTION_ID,
      webhookUrl: webhookUrl.toString(),
      apiKey: env.TELNYX_API_KEY,
    });
    return json({ call_control_id: callControlId, silenceMs });
  } catch (error) {
    const status = error instanceof TelnyxError ? error.status : 502;
    return json({ error: String(error) }, status >= 400 && status < 600 ? status : 502);
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhooks/telnyx") {
      return handleWebhook(request, env);
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
