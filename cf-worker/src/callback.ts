export interface CallbackEvent {
  event: string;
  call_control_id: string;
  occurred_at: string;
  /** The flow step decoded from client_state, or null when there was none. */
  step: number | "done" | null;
  payload: Record<string, unknown>;
}

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * HMAC-SHA256 over `${timestamp}.${rawBody}`. The dot is not decoration: it
 * binds the timestamp to the body so the two cannot be re-split, which would
 * let a captured request be replayed under a different timestamp.
 */
export async function signCallback(
  secret: string,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${rawBody}`),
  );
  return toHex(signature);
}

/** Fixed key order, because the receiver verifies the bytes we send. */
export function buildCallbackBody(event: CallbackEvent): string {
  return JSON.stringify({
    event: event.event,
    call_control_id: event.call_control_id,
    occurred_at: event.occurred_at,
    step: event.step,
    payload: event.payload,
  });
}

/**
 * Fire and forget. A console that is down, slow, or misconfigured must never
 * turn the Telnyx webhook response into a non-2xx, because Telnyx would retry
 * and the flow would advance twice.
 */
export async function notify(args: {
  url: string;
  secret: string;
  event: CallbackEvent;
}): Promise<void> {
  try {
    const body = buildCallbackBody(args.event);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await signCallback(args.secret, timestamp, body);

    const response = await fetch(args.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-console-timestamp": timestamp,
        "x-console-signature": `sha256=${signature}`,
      },
      body,
    });

    if (!response.ok) {
      console.log(
        JSON.stringify({
          msg: "callback_rejected",
          status: response.status,
          event: args.event.event,
          call_control_id: args.event.call_control_id,
        }),
      );
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        msg: "callback_failed",
        event: args.event.event,
        call_control_id: args.event.call_control_id,
        error: String(error),
      }),
    );
  }
}
