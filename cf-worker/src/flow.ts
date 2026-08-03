import { decodeState, encodeState, type Step } from "./state";

export interface Command {
  action: string;
  params: Record<string, unknown>;
}

export interface FlowInput {
  eventType: string;
  clientState: string | null | undefined;
  originUrl: string;
}

export const QUESTION_COUNT = 3;

/**
 * gather_using_ai requires a `parameters` schema. Structured extraction is not
 * the goal here - the command is used for its managed end-of-speech detection -
 * but a single free-text field means the caller's answer arrives as text on
 * call.ai_gather.ended at no extra cost.
 */
export const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    answer: {
      type: "string",
      description: "The caller's spoken answer to the question just played.",
    },
  },
  required: ["answer"],
} as const;

function audioUrl(origin: string, file: string): string {
  return `${origin}/audio/${file}`;
}

function questionCommand(origin: string, step: 1 | 2 | 3): Command {
  return {
    action: "playback_start",
    params: {
      audio_url: audioUrl(origin, `q${step}.mp3`),
      client_state: encodeState({ step }),
    },
  };
}

export function decide(input: FlowInput): Command[] {
  const { eventType, clientState, originUrl } = input;
  const state = decodeState(clientState);

  if (eventType === "call.answered") {
    return [
      {
        action: "record_start",
        params: {
          format: "mp3",
          channels: "dual",
          client_state: encodeState({ step: 1 }),
        },
      },
      questionCommand(originUrl, 1),
    ];
  }

  if (!state) return [];

  if (eventType === "call.playback.ended") {
    if (state.step === "done") {
      return [
        {
          action: "hangup",
          params: { client_state: encodeState({ step: "done" }) },
        },
      ];
    }
    return [
      {
        action: "gather_using_ai",
        params: {
          parameters: ANSWER_SCHEMA,
          client_state: encodeState({ step: state.step }),
        },
      },
    ];
  }

  if (eventType === "call.ai_gather.ended") {
    if (state.step === "done") return [];

    const next: Step = state.step < QUESTION_COUNT
      ? ((state.step + 1) as 1 | 2 | 3)
      : "done";

    if (next === "done") {
      return [
        {
          action: "playback_start",
          params: {
            audio_url: audioUrl(originUrl, "thanks.mp3"),
            client_state: encodeState({ step: "done" }),
          },
        },
      ];
    }

    return [questionCommand(originUrl, next)];
  }

  return [];
}
