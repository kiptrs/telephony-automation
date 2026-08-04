import { decodeState, encodeState, type FlowState, type Step } from "./state";

export interface Env {
  TELNYX_API_KEY: string;
  TELNYX_PUBLIC_KEY: string;
  TELNYX_CONNECTION_ID: string;
  TELNYX_FROM_NUMBER: string;
  TRIGGER_SECRET: string;
  CONSOLE_HMAC_SECRET: string;
  CALL_SESSIONS: DurableObjectNamespace;
}

/** The audio for one call. Supplied per call, validated in manifest.ts. */
export interface AudioManifest {
  questions: string[];
  thanks: string;
}

export interface Command {
  action: string;
  params: Record<string, unknown>;
  method?: "POST" | "PUT";
}

export interface FlowInput {
  eventType: string;
  clientState: string | null | undefined;
  /** Used only to build the stream URL. No longer an audio concern. */
  originUrl: string;
  /** Required for call.answered, unused for every other event. */
  audio?: AudioManifest;
  silenceMs?: number | string | null;
}

/** Silence after speech that ends an answer. */
export const DEFAULT_SILENCE_MS = 2500;
const MIN_SILENCE_MS = 500;
const MAX_SILENCE_MS = 10000;

/** Hard cap so a caller who never speaks cannot hold the call open. */
export const MAX_ANSWER_MS = 30000;

export function normaliseSilenceMs(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_SILENCE_MS;
  if (n < MIN_SILENCE_MS || n > MAX_SILENCE_MS) return DEFAULT_SILENCE_MS;
  return Math.round(n);
}

function play(audioUrl: string, step: Step): Command {
  return {
    action: "playback_start",
    params: {
      audio_url: audioUrl,
      client_state: encodeState({ step }),
    },
  };
}

/** `step` is 1-based; the questions array is 0-based. Null means out of range. */
export function question(audio: AudioManifest, step: number): Command | null {
  const url = audio.questions[step - 1];
  if (!url) return null;
  return play(url, step);
}

/**
 * What to play once an answer ends. Shared with the Durable Object, which is
 * what actually detects the end of speech and issues this command.
 */
export function nextAfterAnswer(
  audio: AudioManifest,
  answeredStep: number,
): Command | null {
  if (answeredStep < 1 || answeredStep > audio.questions.length) return null;
  if (answeredStep < audio.questions.length) {
    return question(audio, answeredStep + 1);
  }
  return play(audio.thanks, "done");
}

export function decide(input: FlowInput): Command[] {
  const { eventType, clientState, originUrl, audio } = input;
  const silenceMs = normaliseSilenceMs(input.silenceMs);
  const state: FlowState | null = decodeState(clientState);

  if (eventType === "call.answered") {
    if (!audio) return [];

    const first = question(audio, 1);
    // A recording and a live media stream with nothing to play is worse than
    // no call at all.
    if (!first) return [];

    const streamUrl = new URL(originUrl.replace(/^http/, "ws"));
    streamUrl.pathname = "/stream";
    streamUrl.searchParams.set("silenceMs", String(silenceMs));

    return [
      {
        action: "record_start",
        params: {
          format: "mp3",
          channels: "dual",
          client_state: encodeState({ step: 1 }),
        },
      },
      {
        action: "streaming_start",
        params: {
          // Placeholder: the Worker rewrites this with the call_control_id,
          // which decide() has no access to.
          stream_url: streamUrl.toString(),
          // The caller only. Our own playbacks are on the outbound track, so
          // they can never be mistaken for the caller speaking.
          stream_track: "inbound_track",
          stream_codec: "PCMU",
          client_state: encodeState({ step: 1 }),
        },
      },
      first,
    ];
  }

  if (!state) return [];

  // The Durable Object drives question-to-question movement. The Worker only
  // has to end the call once the thank-you has played.
  if (eventType === "call.playback.ended" && state.step === "done") {
    return [
      {
        action: "hangup",
        params: { client_state: encodeState({ step: "done" }) },
      },
    ];
  }

  return [];
}
