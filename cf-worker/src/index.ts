import { decide } from "./flow";
import { createCall, sendCommand, TelnyxError } from "./telnyx";
import { verifyTelnyxSignature } from "./verify";

export interface Env {
  TELNYX_API_KEY: string;
  TELNYX_PUBLIC_KEY: string;
  TELNYX_CONNECTION_ID: string;
  TELNYX_FROM_NUMBER: string;
  TRIGGER_SECRET: string;
}

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

  console.log(
    JSON.stringify({
      msg: "webhook",
      event_type: eventType,
      call_control_id: callControlId,
      payload: webhook.data?.payload,
    }),
  );

  const commands = decide({
    eventType,
    clientState: webhook.data?.payload?.client_state,
    originUrl: new URL(request.url).origin,
  });

  for (const command of commands) {
    try {
      await sendCommand(callControlId, command, env.TELNYX_API_KEY);
    } catch (error) {
      const status = error instanceof TelnyxError ? error.status : 0;
      console.log(
        JSON.stringify({
          msg: "command_failed",
          action: command.action,
          status,
          error: String(error),
        }),
      );
      // Do not leave the callee on a silent open line.
      if (command.action !== "hangup") {
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

  let body: { to?: unknown };
  try {
    body = (await request.json()) as { to?: unknown };
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const to = body.to;
  if (typeof to !== "string" || to.length === 0) {
    return json({ error: "`to` is required" }, 400);
  }

  const origin = new URL(request.url).origin;

  try {
    const callControlId = await createCall({
      to,
      from: env.TELNYX_FROM_NUMBER,
      connectionId: env.TELNYX_CONNECTION_ID,
      webhookUrl: `${origin}/webhooks/telnyx`,
      apiKey: env.TELNYX_API_KEY,
    });
    return json({ call_control_id: callControlId });
  } catch (error) {
    const status = error instanceof TelnyxError ? error.status : 502;
    return json({ error: String(error) }, status >= 400 && status < 600 ? status : 502);
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "POST" && pathname === "/webhooks/telnyx") {
      return handleWebhook(request, env);
    }
    if (request.method === "POST" && pathname === "/calls") {
      return handleCreateCall(request, env);
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
