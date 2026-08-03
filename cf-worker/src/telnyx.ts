import type { Command } from "./flow";

const API_BASE = "https://api.telnyx.com/v2";

export class TelnyxError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TelnyxError";
    this.status = status;
  }
}

export interface CreateCallArgs {
  to: string;
  from: string;
  connectionId: string;
  webhookUrl: string;
  apiKey: string;
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

/**
 * Returns Telnyx's response body. A 2xx only means the command was accepted,
 * not that the underlying engine started - transcription_start returned 200
 * once and then produced no transcripts at all, which was undiagnosable
 * because the body was being discarded.
 */
export async function sendCommand(
  callControlId: string,
  command: Command,
  apiKey: string,
): Promise<string> {
  const url = `${API_BASE}/calls/${encodeURIComponent(callControlId)}/actions/${command.action}`;

  const response = await fetch(url, {
    method: command.method ?? "POST",
    headers: headers(apiKey),
    body: JSON.stringify(command.params),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new TelnyxError(response.status, `${command.action} failed: ${text}`);
  }

  return text;
}

export async function createCall(args: CreateCallArgs): Promise<string> {
  const response = await fetch(`${API_BASE}/calls`, {
    method: "POST",
    headers: headers(args.apiKey),
    body: JSON.stringify({
      to: args.to,
      from: args.from,
      connection_id: args.connectionId,
      webhook_url: args.webhookUrl,
      webhook_url_method: "POST",
    }),
  });

  if (!response.ok) {
    throw new TelnyxError(
      response.status,
      `create call failed: ${await response.text()}`,
    );
  }

  const body = (await response.json()) as {
    data?: { call_control_id?: string };
  };
  const id = body.data?.call_control_id;
  if (!id) throw new TelnyxError(response.status, "no call_control_id in response");
  return id;
}
