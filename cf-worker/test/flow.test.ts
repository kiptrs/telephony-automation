import { describe, expect, it } from "vitest";
import { decide, type FlowInput } from "../src/flow";
import { decodeState, encodeState, type FlowState } from "../src/state";

const ORIGIN = "https://rtc-telnyx.example.workers.dev";

function run(
  eventType: string,
  state: FlowState | null = null,
  payload: FlowInput["payload"] = undefined,
) {
  return decide({
    eventType,
    clientState: state ? encodeState(state) : null,
    originUrl: ORIGIN,
    payload,
  });
}

function finalTranscript(transcript = "an answer") {
  return { transcription_data: { is_final: true, transcript } };
}

describe("decide - call start", () => {
  it("records, starts inbound transcription, and plays question 1", () => {
    const commands = run("call.answered");

    expect(commands.map((c) => c.action)).toEqual([
      "record_start",
      "transcription_start",
      "playback_start",
    ]);
  });

  it("transcribes only the inbound track so our own playback is never transcribed", () => {
    const commands = run("call.answered");
    const transcription = commands.find((c) => c.action === "transcription_start");
    expect(transcription!.params.transcription_tracks).toBe("inbound");
  });

  it("does not request interim results", () => {
    const commands = run("call.answered");
    const transcription = commands.find((c) => c.action === "transcription_start");
    expect(transcription!.params.interim_results).toBe(false);
  });

  it("uses the Telnyx engine with automatic language detection", () => {
    const commands = run("call.answered");
    const transcription = commands.find((c) => c.action === "transcription_start");

    expect(transcription!.params.transcription_engine).toBe("Telnyx");
    // The config repeats the engine name as its discriminator; without it
    // Telnyx rejects the config block.
    expect(transcription!.params.transcription_engine_config).toEqual({
      transcription_engine: "Telnyx",
      language: "auto_detect",
      transcription_model: "openai/whisper-large-v3-turbo",
    });
  });

  it("starts question 1 in the playing phase", () => {
    const commands = run("call.answered");
    const playback = commands.find((c) => c.action === "playback_start");
    expect(playback!.params.audio_url).toBe(`${ORIGIN}/audio/q1.mp3`);
    expect(decodeState(playback!.params.client_state as string)).toEqual({
      step: 1,
      phase: "playing",
    });
  });
});

describe("decide - switching to listening", () => {
  it.each([1, 2, 3] as const)(
    "moves to listening after question %i finishes playing",
    (step) => {
      const commands = run("call.playback.ended", { step, phase: "playing" });

      expect(commands).toHaveLength(1);
      expect(commands[0]!.action).toBe("client_state_update");
      expect(commands[0]!.method).toBe("PUT");
      expect(decodeState(commands[0]!.params.client_state as string)).toEqual({
        step,
        phase: "listening",
      });
    },
  );

  it("issues no TTS-capable command anywhere in the flow", () => {
    const everything = [
      ...run("call.answered"),
      ...run("call.playback.ended", { step: 1, phase: "playing" }),
      ...run("call.transcription", { step: 1, phase: "listening" }, finalTranscript()),
      ...run("call.transcription", { step: 3, phase: "listening" }, finalTranscript()),
      ...run("call.playback.ended", { step: "done", phase: "playing" }),
    ];
    for (const command of everything) {
      expect(command.action).not.toContain("speak");
      expect(command.action).not.toContain("ai");
      expect(command.params).not.toHaveProperty("voice");
    }
  });
});

describe("decide - advancing on a final transcript", () => {
  it.each([
    [1, 2],
    [2, 3],
  ] as const)("plays question %i+1 after a final transcript at step %i", (from, to) => {
    const commands = run(
      "call.transcription",
      { step: from, phase: "listening" },
      finalTranscript(),
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]!.action).toBe("playback_start");
    expect(commands[0]!.params.audio_url).toBe(`${ORIGIN}/audio/q${to}.mp3`);
    expect(decodeState(commands[0]!.params.client_state as string)).toEqual({
      step: to,
      phase: "playing",
    });
  });

  it("plays the thank-you after a final transcript at step 3", () => {
    const commands = run(
      "call.transcription",
      { step: 3, phase: "listening" },
      finalTranscript(),
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]!.params.audio_url).toBe(`${ORIGIN}/audio/thanks.mp3`);
    expect(decodeState(commands[0]!.params.client_state as string)).toEqual({
      step: "done",
      phase: "playing",
    });
  });
});

describe("decide - transcripts that must be ignored", () => {
  it("ignores a transcript that arrives while the question is still playing", () => {
    expect(
      run("call.transcription", { step: 1, phase: "playing" }, finalTranscript()),
    ).toEqual([]);
  });

  it("ignores a non-final (interim) transcript", () => {
    expect(
      run("call.transcription", { step: 1, phase: "listening" }, {
        transcription_data: { is_final: false, transcript: "partial" },
      }),
    ).toEqual([]);
  });

  it("ignores a transcript with no transcription_data", () => {
    expect(run("call.transcription", { step: 1, phase: "listening" }, {})).toEqual([]);
    expect(run("call.transcription", { step: 1, phase: "listening" })).toEqual([]);
  });

  it("ignores a transcript once the flow is done", () => {
    expect(
      run("call.transcription", { step: "done", phase: "listening" }, finalTranscript()),
    ).toEqual([]);
  });
});

describe("decide - ending the call", () => {
  it("hangs up after the thank-you finishes", () => {
    const commands = run("call.playback.ended", { step: "done", phase: "playing" });

    expect(commands).toHaveLength(1);
    expect(commands[0]!.action).toBe("hangup");
  });
});

describe("decide - events that must not produce commands", () => {
  it.each([
    ["call.recording.saved", { step: "done", phase: "playing" } as FlowState],
    ["call.hangup", { step: "done", phase: "playing" } as FlowState],
    ["call.playback.started", { step: 1, phase: "playing" } as FlowState],
    ["call.initiated", null],
    ["some.unknown.event", null],
  ])("returns no commands for %s", (eventType, state) => {
    expect(run(eventType, state)).toEqual([]);
  });

  it("returns no commands when client_state is missing or malformed", () => {
    expect(run("call.playback.ended", null)).toEqual([]);
    expect(
      decide({
        eventType: "call.transcription",
        clientState: "!!!garbage!!!",
        originUrl: ORIGIN,
        payload: finalTranscript(),
      }),
    ).toEqual([]);
  });
});

describe("decide - full happy path", () => {
  it("walks answered -> 3 listen/answer rounds -> thanks -> hangup", () => {
    const seen: string[] = [];
    let state: string | null = null;

    const step = (eventType: string, payload?: FlowInput["payload"]) => {
      const commands = decide({
        eventType,
        clientState: state,
        originUrl: ORIGIN,
        payload,
      });
      for (const c of commands) seen.push(c.action);
      const last = commands[commands.length - 1];
      if (last?.params.client_state) state = last.params.client_state as string;
    };

    step("call.answered");
    step("call.playback.ended");
    step("call.transcription", finalTranscript("answer one"));
    step("call.playback.ended");
    step("call.transcription", finalTranscript("answer two"));
    step("call.playback.ended");
    step("call.transcription", finalTranscript("answer three"));
    step("call.playback.ended");

    expect(seen).toEqual([
      "record_start",
      "transcription_start",
      "playback_start",
      "client_state_update",
      "playback_start",
      "client_state_update",
      "playback_start",
      "client_state_update",
      "playback_start",
      "hangup",
    ]);
  });
});
