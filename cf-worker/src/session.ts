import {
  DEFAULT_SILENCE_MS,
  MAX_ANSWER_MS,
  nextAfterAnswer,
  type AudioManifest,
  type Env,
} from "./flow";
import { sendCommand } from "./telnyx";
import {
  armedState,
  frameEnergy,
  observeFrame,
  SPEECH_THRESHOLD,
  type VadConfig,
  type VadState,
} from "./vad";

interface TelnyxMediaMessage {
  event?: string;
  media?: { payload?: string };
}

/**
 * One per call. Holds the media WebSocket and the voice-activity state that a
 * stateless Worker cannot: silence is only observable by watching a live audio
 * stream over time. Also holds the per-call audio manifest, seeded by the
 * Worker at dial time.
 *
 * The Worker arms this object when a question finishes playing; the object
 * issues the next question once it hears the caller stop talking.
 */
export class CallSession {
  private readonly env: Env;
  private readonly storage: DurableObjectStorage;

  private manifest: AudioManifest | null = null;
  private callControlId = "";
  private config: VadConfig = {
    silenceMs: DEFAULT_SILENCE_MS,
    maxAnswerMs: MAX_ANSWER_MS,
    threshold: SPEECH_THRESHOLD,
  };

  /** Which question we are collecting an answer for; 0 means not listening. */
  private step = 0;
  private vad: VadState = armedState(0);
  /** Guards against issuing the next question twice for one answer. */
  private advancing = false;

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.storage = state.storage;
    // The Worker seeds the manifest at dial time. Ring time is long enough for
    // an idle object to be evicted, so a woken object must reload it before
    // handling anything.
    state.blockConcurrencyWhile(async () => {
      this.manifest =
        (await this.storage.get<AudioManifest>("manifest")) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/init")) return this.handleInit(request);
    if (url.pathname.endsWith("/manifest")) return this.handleManifest();
    if (url.pathname.endsWith("/end")) return this.handleEnd();
    if (url.pathname.endsWith("/arm")) return this.handleArm(url);
    if (url.pathname.endsWith("/stream")) return this.handleStream(request, url);

    return new Response("not found", { status: 404 });
  }

  /** Seeded by the Worker immediately after the dial succeeds. */
  private async handleInit(request: Request): Promise<Response> {
    let manifest: AudioManifest;
    try {
      manifest = (await request.json()) as AudioManifest;
    } catch {
      return new Response("invalid json", { status: 400 });
    }

    if (
      !Array.isArray(manifest.questions) ||
      manifest.questions.length === 0 ||
      typeof manifest.thanks !== "string"
    ) {
      return new Response("invalid manifest", { status: 400 });
    }

    await this.storage.put("manifest", manifest);
    this.manifest = manifest;

    console.log(
      JSON.stringify({
        msg: "session_init",
        questions: manifest.questions.length,
      }),
    );
    return new Response("ok");
  }

  private handleManifest(): Response {
    if (!this.manifest) return new Response("no manifest", { status: 404 });
    return new Response(JSON.stringify(this.manifest), {
      headers: { "Content-Type": "application/json" },
    });
  }

  /** Called on call.hangup so per-call manifests do not accumulate forever. */
  private async handleEnd(): Promise<Response> {
    await this.storage.deleteAll();
    this.manifest = null;
    this.step = 0;
    console.log(JSON.stringify({ msg: "session_end" }));
    return new Response("ok");
  }

  /** Called by the Worker when a question has finished playing. */
  private handleArm(url: URL): Response {
    // Arming an object that was never seeded is a bug, not a recoverable state.
    if (!this.manifest) return new Response("no manifest", { status: 400 });

    const step = Number(url.searchParams.get("step"));
    if (
      !Number.isInteger(step) ||
      step < 1 ||
      step > this.manifest.questions.length
    ) {
      return new Response("bad step", { status: 400 });
    }

    this.step = step;
    this.advancing = false;
    this.vad = armedState(Date.now());

    console.log(JSON.stringify({ msg: "vad_armed", step }));
    return new Response("ok");
  }

  private handleStream(request: Request, url: URL): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    this.callControlId = url.searchParams.get("ccid") ?? "";
    const silenceMs = Number(url.searchParams.get("silenceMs"));
    if (Number.isFinite(silenceMs) && silenceMs > 0) {
      this.config = { ...this.config, silenceMs };
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    server.addEventListener("message", (event: MessageEvent) => {
      this.onMessage(event.data).catch((error) => {
        console.log(JSON.stringify({ msg: "vad_error", error: String(error) }));
      });
    });
    server.addEventListener("close", () => {
      console.log(JSON.stringify({ msg: "stream_closed" }));
    });

    console.log(
      JSON.stringify({
        msg: "stream_open",
        call_control_id: this.callControlId,
        silence_ms: this.config.silenceMs,
      }),
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  private async onMessage(data: unknown): Promise<void> {
    if (typeof data !== "string") return;

    let message: TelnyxMediaMessage;
    try {
      message = JSON.parse(data) as TelnyxMediaMessage;
    } catch {
      return;
    }

    if (message.event !== "media" || !message.media?.payload) return;
    // Frames still arrive while a question is playing; ignore them until the
    // Worker says the question has ended.
    if (this.step === 0 || this.advancing) return;

    const energy = frameEnergy(message.media.payload);
    const result = observeFrame(this.vad, energy, Date.now(), this.config);
    this.vad = result.state;

    if (result.decision === "wait") return;

    this.advancing = true;
    const answeredStep = this.step;
    this.step = 0;

    console.log(
      JSON.stringify({
        msg: "answer_ended",
        step: answeredStep,
        reason: result.decision,
      }),
    );

    await this.advance(answeredStep);
  }

  private async advance(answeredStep: number): Promise<void> {
    if (!this.callControlId || !this.manifest) return;

    const command = nextAfterAnswer(this.manifest, answeredStep);
    if (!command) {
      console.log(
        JSON.stringify({ msg: "advance_skipped", step: answeredStep }),
      );
      return;
    }

    try {
      await sendCommand(this.callControlId, command, this.env.TELNYX_API_KEY);
    } catch (error) {
      console.log(
        JSON.stringify({ msg: "advance_failed", error: String(error) }),
      );
    }
  }
}
