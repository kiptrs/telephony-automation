import { decodeState, encodeState, type FlowState, type Step } from "./state";

export interface Command {
  action: string;
  params: Record<string, unknown>;
  /** Telnyx uses PUT for client_state_update; everything else is POST. */
  method?: "POST" | "PUT";
}

export interface TranscriptionPayload {
  transcription_data?: {
    is_final?: boolean;
    transcript?: string;
    confidence?: number;
  };
}

export interface FlowInput {
  eventType: string;
  clientState: string | null | undefined;
  originUrl: string;
  payload?: TranscriptionPayload;
}

export const QUESTION_COUNT = 3;

function audioUrl(origin: string, file: string): string {
  return `${origin}/audio/${file}`;
}

function play(origin: string, file: string, step: Step): Command {
  return {
    action: "playback_start",
    params: {
      audio_url: audioUrl(origin, file),
      client_state: encodeState({ step, phase: "playing" }),
    },
  };
}

function question(origin: string, step: 1 | 2 | 3): Command {
  return play(origin, `q${step}.mp3`, step);
}

export function decide(input: FlowInput): Command[] {
  const { eventType, clientState, originUrl, payload } = input;
  const state: FlowState | null = decodeState(clientState);

  if (eventType === "call.answered") {
    return [
      {
        action: "record_start",
        params: {
          format: "mp3",
          channels: "dual",
          client_state: encodeState({ step: 1, phase: "playing" }),
        },
      },
      {
        action: "transcription_start",
        params: {
          // Only the caller's audio. Our own playbacks must never transcribe,
          // or a question would advance the flow past itself.
          transcription_tracks: "inbound",
          interim_results: false,
          // Telnyx's own engine is the one that supports auto_detect. The
          // config block repeats transcription_engine as its discriminator.
          transcription_engine: "Telnyx",
          transcription_engine_config: {
            transcription_engine: "Telnyx",
            language: "auto_detect",
            transcription_model: "openai/whisper-large-v3-turbo",
          },
          client_state: encodeState({ step: 1, phase: "playing" }),
        },
      },
      question(originUrl, 1),
    ];
  }

  if (!state) return [];

  if (eventType === "call.playback.ended") {
    if (state.step === "done") {
      return [
        {
          action: "hangup",
          params: { client_state: encodeState({ step: "done", phase: "playing" }) },
        },
      ];
    }
    // The question has finished; start accepting the answer.
    return [
      {
        action: "client_state_update",
        method: "PUT",
        params: {
          client_state: encodeState({ step: state.step, phase: "listening" }),
        },
      },
    ];
  }

  if (eventType === "call.transcription") {
    if (state.phase !== "listening") return [];
    if (state.step === "done") return [];
    if (payload?.transcription_data?.is_final !== true) return [];

    if (state.step < QUESTION_COUNT) {
      return [question(originUrl, (state.step + 1) as 1 | 2 | 3)];
    }
    return [play(originUrl, "thanks.mp3", "done")];
  }

  return [];
}
