import { describe, expect, it } from "vitest";
import {
  DEFAULT_SILENCE_MS,
  decide,
  nextAfterAnswer,
  normaliseSilenceMs,
  question,
  type AudioManifest,
  type FlowInput,
} from "../src/flow";
import { decodeState, encodeState, type FlowState } from "../src/state";

const ORIGIN = "https://rtc-telnyx.example.workers.dev";

const AUDIO: AudioManifest = {
  questions: [
    "https://cdn.example/a/q1.mp3",
    "https://cdn.example/a/q2.mp3",
    "https://cdn.example/a/q3.mp3",
  ],
  thanks: "https://cdn.example/a/thanks.mp3",
};

function manifestOf(count: number): AudioManifest {
  return {
    questions: Array.from(
      { length: count },
      (_, i) => `https://cdn.example/q${i + 1}.mp3`,
    ),
    thanks: "https://cdn.example/thanks.mp3",
  };
}

function run(
  eventType: string,
  state: FlowState | null = null,
  silenceMs?: FlowInput["silenceMs"],
  audio: AudioManifest | undefined = AUDIO,
) {
  return decide({
    eventType,
    clientState: state ? encodeState(state) : null,
    originUrl: ORIGIN,
    audio,
    silenceMs,
  });
}

describe("decide - call start", () => {
  it("records, opens the media stream, and plays question 1", () => {
    const commands = run("call.answered");

    expect(commands.map((c) => c.action)).toEqual([
      "record_start",
      "streaming_start",
      "playback_start",
    ]);
  });

  it("streams only the inbound track, so our playback is never heard as speech", () => {
    const streaming = run("call.answered").find(
      (c) => c.action === "streaming_start",
    );
    expect(streaming!.params.stream_track).toBe("inbound_track");
    expect(streaming!.params.stream_codec).toBe("PCMU");
  });

  it("points the stream at a wss URL carrying the silence threshold", () => {
    const streaming = run("call.answered", null, 3000).find(
      (c) => c.action === "streaming_start",
    );
    const url = new URL(String(streaming!.params.stream_url));

    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/stream");
    expect(url.searchParams.get("silenceMs")).toBe("3000");
  });

  it("defaults the silence threshold when none is given", () => {
    const streaming = run("call.answered").find(
      (c) => c.action === "streaming_start",
    );
    const url = new URL(String(streaming!.params.stream_url));
    expect(url.searchParams.get("silenceMs")).toBe(String(DEFAULT_SILENCE_MS));
  });

  it("plays the manifest's first question at step 1", () => {
    const playback = run("call.answered").find(
      (c) => c.action === "playback_start",
    );
    expect(playback!.params.audio_url).toBe(AUDIO.questions[0]);
    expect(decodeState(playback!.params.client_state as string)).toEqual({
      step: 1,
    });
  });

  // decide() is called directly here: run()'s `audio` parameter defaults to
  // AUDIO, so passing undefined through it would silently supply the default.
  it("does nothing at all without a manifest", () => {
    expect(
      decide({ eventType: "call.answered", clientState: null, originUrl: ORIGIN }),
    ).toEqual([]);
  });

  it("does not start recording or streaming when the manifest has no questions", () => {
    const empty: AudioManifest = {
      questions: [],
      thanks: "https://cdn.example/t.mp3",
    };
    expect(run("call.answered", null, undefined, empty)).toEqual([]);
  });

  it("involves no AI, speech synthesis, or transcription", () => {
    const everything = [
      ...run("call.answered"),
      ...run("call.playback.ended", { step: "done" }),
      nextAfterAnswer(AUDIO, 1),
      nextAfterAnswer(AUDIO, 3),
    ];
    for (const c of everything) {
      expect(c).not.toBeNull();
      expect(c!.action).not.toContain("ai");
      expect(c!.action).not.toContain("speak");
      expect(c!.action).not.toContain("transcription");
      expect(c!.action).not.toContain("gather");
      expect(c!.params).not.toHaveProperty("voice");
    }
  });
});

describe("question", () => {
  it("is 1-based against a 0-based array", () => {
    expect(question(AUDIO, 2)!.params.audio_url).toBe(AUDIO.questions[1]);
  });

  it.each([0, -1, 4])("returns null for out-of-range step %i", (step) => {
    expect(question(AUDIO, step)).toBeNull();
  });
});

describe("nextAfterAnswer", () => {
  it.each([
    [1, 1],
    [2, 2],
  ] as const)("plays the next question after answer %i", (from, index) => {
    const command = nextAfterAnswer(AUDIO, from)!;

    expect(command.action).toBe("playback_start");
    expect(command.params.audio_url).toBe(AUDIO.questions[index]);
    expect(decodeState(command.params.client_state as string)).toEqual({
      step: from + 1,
    });
  });

  it("plays the thank-you after the last answer", () => {
    const command = nextAfterAnswer(AUDIO, 3)!;

    expect(command.action).toBe("playback_start");
    expect(command.params.audio_url).toBe(AUDIO.thanks);
    expect(decodeState(command.params.client_state as string)).toEqual({
      step: "done",
    });
  });

  it("plays the thank-you immediately in a one-question survey", () => {
    const one = manifestOf(1);
    const command = nextAfterAnswer(one, 1)!;
    expect(command.params.audio_url).toBe(one.thanks);
  });

  it("walks all ten questions then the thank-you", () => {
    const ten = manifestOf(10);
    for (let step = 1; step < 10; step++) {
      expect(nextAfterAnswer(ten, step)!.params.audio_url).toBe(
        ten.questions[step],
      );
    }
    expect(nextAfterAnswer(ten, 10)!.params.audio_url).toBe(ten.thanks);
  });

  it.each([0, -1, 4])("returns null for out-of-range step %i", (step) => {
    expect(nextAfterAnswer(AUDIO, step)).toBeNull();
  });
});

describe("decide - ending the call", () => {
  it("hangs up after the thank-you finishes", () => {
    const commands = run("call.playback.ended", { step: "done" });

    expect(commands).toHaveLength(1);
    expect(commands[0]!.action).toBe("hangup");
  });

  it.each([1, 2, 3] as const)(
    "sends no command when question %i finishes - the session drives the next one",
    (step) => {
      expect(run("call.playback.ended", { step })).toEqual([]);
    },
  );
});

describe("decide - events that must not produce commands", () => {
  it.each([
    ["call.recording.saved", { step: "done" } as FlowState],
    ["call.hangup", { step: "done" } as FlowState],
    ["call.playback.started", { step: 1 } as FlowState],
    ["call.initiated", null],
    ["some.unknown.event", null],
  ])("returns no commands for %s", (eventType, state) => {
    expect(run(eventType, state)).toEqual([]);
  });

  it("returns no commands when client_state is missing or malformed", () => {
    expect(run("call.playback.ended", null)).toEqual([]);
    expect(
      decide({
        eventType: "call.playback.ended",
        clientState: "!!!garbage!!!",
        originUrl: ORIGIN,
        audio: AUDIO,
      }),
    ).toEqual([]);
  });
});

describe("normaliseSilenceMs", () => {
  it("accepts a sane value", () => {
    expect(normaliseSilenceMs(3000)).toBe(3000);
  });

  it("accepts a numeric string, since it arrives from a query param", () => {
    expect(normaliseSilenceMs("3000")).toBe(3000);
  });

  it.each([undefined, null, "abc", NaN, 0, 100, 60000, -2500])(
    "falls back to the default for %s",
    (bad) => {
      expect(normaliseSilenceMs(bad)).toBe(DEFAULT_SILENCE_MS);
    },
  );
});
