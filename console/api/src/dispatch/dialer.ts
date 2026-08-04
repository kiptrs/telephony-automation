import { createHmac, randomUUID } from "node:crypto";
import type { Config } from "../config.js";

export interface DialArgs {
  to: string;
  from: string;
  silenceMs: number;
  audio: { questions: string[]; thanks: string };
  callbackUrl: string;
}

export interface DialerProvider {
  dial(args: DialArgs): Promise<{ callControlId: string }>;
}

export class DialError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DialError";
    this.status = status;
  }
}

export class CfWorkerDialer implements DialerProvider {
  constructor(private readonly config: Config) {}

  async dial(args: DialArgs): Promise<{ callControlId: string }> {
    const response = await fetch(`${this.config.worker.baseUrl}/calls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.worker.triggerSecret}`,
      },
      body: JSON.stringify({
        to: args.to,
        from: args.from,
        silenceMs: args.silenceMs,
        audio: args.audio,
        callbackUrl: args.callbackUrl,
      }),
    });

    const body = (await response.json().catch(() => ({}))) as {
      call_control_id?: string;
      error?: string;
    };

    if (!response.ok) {
      throw new DialError(
        response.status,
        body.error ?? `worker rejected the call with ${response.status}`,
      );
    }
    if (!body.call_control_id) {
      throw new DialError(502, "worker returned no call_control_id");
    }
    return { callControlId: body.call_control_id };
  }
}

/**
 * Stands in for the Worker during local development, where nothing external can
 * reach the console. It plays the same callback sequence a real call produces,
 * signed with the same secret, so the callback route and everything downstream
 * of it run unchanged.
 */
export class FakeDialer implements DialerProvider {
  constructor(private readonly config: Config) {}

  async dial(args: DialArgs): Promise<{ callControlId: string }> {
    const callControlId = `fake-${randomUUID()}`;
    void this.playSequence(callControlId, args);
    return { callControlId };
  }

  private async playSequence(
    callControlId: string,
    args: DialArgs,
  ): Promise<void> {
    const questions = args.audio.questions.length;

    await this.deliver(callControlId, "call.answered", null, {});
    await sleep(50);
    await this.deliver(callControlId, "call.recording.saved", null, {
      recording_id: `fake-rec-${randomUUID()}`,
      channels: "dual",
      recording_urls: { mp3: "https://fake.invalid/recording.mp3" },
    });
    await sleep(50);
    // Most fake calls complete; every fifth abandons partway, so the abandoned
    // path is exercised in development rather than only in production.
    const abandons = Math.random() < 0.2 && questions > 1;
    await this.deliver(
      callControlId,
      "call.hangup",
      abandons ? Math.max(1, questions - 1) : "done",
      { hangup_cause: "normal_clearing" },
    );
  }

  private async deliver(
    callControlId: string,
    event: string,
    step: number | "done" | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const body = JSON.stringify({
      event,
      call_control_id: callControlId,
      occurred_at: new Date().toISOString(),
      step,
      payload,
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", this.config.worker.hmacSecret)
      .update(`${timestamp}.${body}`)
      .digest("hex");

    try {
      await fetch(`${this.config.publicBaseUrl}/callbacks/worker`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-console-timestamp": timestamp,
          "x-console-signature": `sha256=${signature}`,
        },
        body,
      });
    } catch {
      // The fake must not be able to crash the dispatcher.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createDialer(config: Config): DialerProvider {
  return config.dialer === "fake"
    ? new FakeDialer(config)
    : new CfWorkerDialer(config);
}
