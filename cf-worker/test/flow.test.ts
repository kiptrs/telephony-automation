import { describe, expect, it } from "vitest";
import {
  DEFAULT_SILENCE_MS,
  decide,
  nextAfterAnswer,
  normaliseSilenceMs,
  type FlowInput,
} from "../src/flow";
import { decodeState, encodeState, type FlowState } from "../src/state";

const ORIGIN = "https://rtc-telnyx.example.workers.dev";

function run(
  eventType: string,
  state: FlowState | null = null,
  silenceMs?: FlowInput["silenceMs"],
) {
  return decide({
    eventType,
    clientState: state ? encodeState(state) : null,
    originUrl: ORIGIN,
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

  it("starts question 1 at step 1", () => {
    const playback = run("call.answered").find((c) => c.action === "playback_start");
    expect(playback!.params.audio_url).toBe(`${ORIGIN}/audio/q1.mp3`);
    expect(decodeState(playback!.params.client_state as string)).toEqual({ step: 1 });
  });

  it("involves no AI, speech synthesis, or transcription", () => {
    const everything = [
      ...run("call.answered"),
      ...run("call.playback.ended", { step: "done" }),
      nextAfterAnswer(ORIGIN, 1),
      nextAfterAnswer(ORIGIN, 3),
    ];
    for (const c of everything) {
      expect(c.action).not.toContain("ai");
      expect(c.action).not.toContain("speak");
      expect(c.action).not.toContain("transcription");
      expect(c.action).not.toContain("gather");
      expect(c.params).not.toHaveProperty("voice");
    }
  });
});

describe("nextAfterAnswer", () => {
  it.each([
    [1, 2],
    [2, 3],
  ] as const)("plays question %i+1 after answer %i", (from, to) => {
    const command = nextAfterAnswer(ORIGIN, from);

    expect(command.action).toBe("playback_start");
    expect(command.params.audio_url).toBe(`${ORIGIN}/audio/q${to}.mp3`);
    expect(decodeState(command.params.client_state as string)).toEqual({ step: to });
  });

  it("plays the thank-you after the third answer", () => {
    const command = nextAfterAnswer(ORIGIN, 3);

    expect(command.action).toBe("playback_start");
    expect(command.params.audio_url).toBe(`${ORIGIN}/audio/thanks.mp3`);
    expect(decodeState(command.params.client_state as string)).toEqual({
      step: "done",
    });
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
