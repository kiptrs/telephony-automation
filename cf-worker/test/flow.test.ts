import { describe, expect, it } from "vitest";
import { decide } from "../src/flow";
import { decodeState, encodeState } from "../src/state";

const ORIGIN = "https://rtc-telnyx.example.workers.dev";

function run(eventType: string, clientState: string | null = null) {
  return decide({ eventType, clientState, originUrl: ORIGIN });
}

describe("decide - call start", () => {
  it("starts recording and plays question 1 on call.answered", () => {
    const commands = run("call.answered");

    expect(commands).toHaveLength(2);
    expect(commands[0]!.action).toBe("record_start");
    expect(commands[0]!.params).toMatchObject({
      format: "mp3",
      channels: "dual",
    });
    expect(commands[1]!.action).toBe("playback_start");
    expect(commands[1]!.params.audio_url).toBe(`${ORIGIN}/audio/q1.mp3`);
    expect(decodeState(commands[1]!.params.client_state as string)).toEqual({
      step: 1,
    });
  });

  it("attaches client_state to record_start too", () => {
    const commands = run("call.answered");
    expect(commands[0]!.params.client_state).toBeTypeOf("string");
  });
});

describe("decide - listening for an answer", () => {
  it.each([1, 2, 3] as const)(
    "listens with gather_using_ai after question %i finishes playing",
    (step) => {
      const commands = run("call.playback.ended", encodeState({ step }));

      expect(commands).toHaveLength(1);
      expect(commands[0]!.action).toBe("gather_using_ai");
      expect(decodeState(commands[0]!.params.client_state as string)).toEqual({
        step,
      });
    },
  );

  it("omits greeting so Telnyx plays no TTS over the recorded question", () => {
    const commands = run("call.playback.ended", encodeState({ step: 1 }));
    expect(commands[0]!.params).not.toHaveProperty("greeting");
  });

  it("supplies the parameters schema gather_using_ai requires", () => {
    const commands = run("call.playback.ended", encodeState({ step: 1 }));
    expect(commands[0]!.params.parameters).toMatchObject({ type: "object" });
  });
});

describe("decide - advancing between questions", () => {
  it.each([
    [1, 2],
    [2, 3],
  ] as const)("plays question %i+1 after answer %i", (from, to) => {
    const commands = run("call.ai_gather.ended", encodeState({ step: from }));

    expect(commands).toHaveLength(1);
    expect(commands[0]!.action).toBe("playback_start");
    expect(commands[0]!.params.audio_url).toBe(`${ORIGIN}/audio/q${to}.mp3`);
    expect(decodeState(commands[0]!.params.client_state as string)).toEqual({
      step: to,
    });
  });

  it("plays the thank-you after the third answer", () => {
    const commands = run("call.ai_gather.ended", encodeState({ step: 3 }));

    expect(commands).toHaveLength(1);
    expect(commands[0]!.action).toBe("playback_start");
    expect(commands[0]!.params.audio_url).toBe(`${ORIGIN}/audio/thanks.mp3`);
    expect(decodeState(commands[0]!.params.client_state as string)).toEqual({
      step: "done",
    });
  });
});

describe("decide - ending the call", () => {
  it("hangs up after the thank-you finishes, not asking a fourth question", () => {
    const commands = run("call.playback.ended", encodeState({ step: "done" }));

    expect(commands).toHaveLength(1);
    expect(commands[0]!.action).toBe("hangup");
  });
});

describe("decide - events that must not produce commands", () => {
  it.each([
    ["call.recording.saved", encodeState({ step: "done" })],
    ["call.hangup", encodeState({ step: "done" })],
    ["call.playback.started", encodeState({ step: 1 })],
    ["call.initiated", null],
    ["some.unknown.event", null],
  ])("returns no commands for %s", (eventType, clientState) => {
    expect(run(eventType, clientState)).toEqual([]);
  });

  it("returns no commands when client_state is missing on a stateful event", () => {
    expect(run("call.playback.ended", null)).toEqual([]);
    expect(run("call.ai_gather.ended", null)).toEqual([]);
  });

  it("returns no commands when client_state is malformed", () => {
    expect(run("call.playback.ended", "!!!garbage!!!")).toEqual([]);
  });
});

describe("decide - full happy path", () => {
  it("walks answered -> 3 rounds -> thanks -> hangup", () => {
    const seen: string[] = [];
    let state: string | null = null;

    const step = (eventType: string) => {
      const commands = decide({ eventType, clientState: state, originUrl: ORIGIN });
      for (const c of commands) seen.push(c.action);
      const last = commands[commands.length - 1];
      if (last) state = last.params.client_state as string;
    };

    step("call.answered");
    step("call.playback.ended");
    step("call.ai_gather.ended");
    step("call.playback.ended");
    step("call.ai_gather.ended");
    step("call.playback.ended");
    step("call.ai_gather.ended");
    step("call.playback.ended");

    expect(seen).toEqual([
      "record_start",
      "playback_start",
      "gather_using_ai",
      "playback_start",
      "gather_using_ai",
      "playback_start",
      "gather_using_ai",
      "playback_start",
      "hangup",
    ]);
  });
});
