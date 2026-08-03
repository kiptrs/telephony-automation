import { describe, expect, it } from "vitest";
import {
  armedState,
  frameEnergy,
  muLawByteToLinear,
  observeFrame,
  SPEECH_THRESHOLD,
  type VadConfig,
} from "../src/vad";

const CONFIG: VadConfig = {
  silenceMs: 2500,
  maxAnswerMs: 30000,
  threshold: SPEECH_THRESHOLD,
};

/** Encodes raw mu-law bytes the way Telnyx delivers them. */
function frame(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

/** 0xFF is mu-law digital silence. */
function silentFrame(length = 160): string {
  return frame(new Array(length).fill(0xff));
}

/** 0x00 is mu-law full-scale, comfortably above any speech threshold. */
function loudFrame(length = 160): string {
  return frame(new Array(length).fill(0x00));
}

describe("muLawByteToLinear", () => {
  it("decodes digital silence to roughly zero", () => {
    expect(Math.abs(muLawByteToLinear(0xff))).toBeLessThan(10);
  });

  it("decodes full scale to a large magnitude", () => {
    expect(Math.abs(muLawByteToLinear(0x00))).toBeGreaterThan(30000);
  });

  it("is sign-symmetric across the sign bit", () => {
    // 0x00 and 0x80 are the full-scale pair.
    expect(muLawByteToLinear(0x00)).toBeLessThan(0);
    expect(muLawByteToLinear(0x80)).toBeGreaterThan(0);
    expect(muLawByteToLinear(0x00)).toBe(-muLawByteToLinear(0x80));
  });

  it("decodes both mu-law zero codes to zero", () => {
    // 0x7F and 0xFF are negative and positive zero respectively; neither is
    // a sign-symmetric pair with the other.
    expect(muLawByteToLinear(0x7f)).toBe(0);
    expect(muLawByteToLinear(0xff)).toBe(0);
  });
});

describe("frameEnergy", () => {
  it("reports near zero for a silent frame", () => {
    expect(frameEnergy(silentFrame())).toBeLessThan(SPEECH_THRESHOLD);
  });

  it("reports high energy for a loud frame", () => {
    expect(frameEnergy(loudFrame())).toBeGreaterThan(SPEECH_THRESHOLD);
  });

  it("returns 0 rather than throwing on a malformed payload", () => {
    expect(frameEnergy("!!!not base64!!!")).toBe(0);
    expect(frameEnergy("")).toBe(0);
  });
});

describe("observeFrame", () => {
  it("waits through silence when the caller has not spoken yet", () => {
    let state = armedState(0);
    // Far beyond silenceMs, but nothing has been said, so there is no answer
    // to end. This is the case that must not advance.
    for (let t = 20; t <= 10000; t += 20) {
      const result = observeFrame(state, 0, t, CONFIG);
      expect(result.decision).toBe("wait");
      state = result.state;
    }
  });

  it("advances after silenceMs of quiet once speech has been heard", () => {
    let state = armedState(0);

    state = observeFrame(state, 5000, 100, CONFIG).state;
    expect(state.heardSpeech).toBe(true);

    expect(observeFrame(state, 0, 2500, CONFIG).decision).toBe("wait");
    expect(observeFrame(state, 0, 2599, CONFIG).decision).toBe("wait");
    expect(observeFrame(state, 0, 2600, CONFIG).decision).toBe("answered");
  });

  it("does not advance on a pause shorter than silenceMs", () => {
    let state = armedState(0);
    state = observeFrame(state, 5000, 100, CONFIG).state;

    // A one second breath mid-answer.
    for (let t = 120; t < 1100; t += 20) {
      expect(observeFrame(state, 0, t, CONFIG).decision).toBe("wait");
    }

    // Speaking again resets the silence window.
    state = observeFrame(state, 5000, 1100, CONFIG).state;
    expect(state.lastVoiceAt).toBe(1100);
    expect(observeFrame(state, 0, 3000, CONFIG).decision).toBe("wait");
    expect(observeFrame(state, 0, 3600, CONFIG).decision).toBe("answered");
  });

  it("times out a caller who never speaks", () => {
    const state = armedState(0);
    expect(observeFrame(state, 0, 29999, CONFIG).decision).toBe("wait");
    expect(observeFrame(state, 0, 30000, CONFIG).decision).toBe("timeout");
  });

  it("treats energy exactly at the threshold as speech", () => {
    const state = armedState(0);
    expect(observeFrame(state, CONFIG.threshold, 100, CONFIG).state.heardSpeech).toBe(
      true,
    );
    expect(
      observeFrame(state, CONFIG.threshold - 1, 100, CONFIG).state.heardSpeech,
    ).toBe(false);
  });

  it("drives a realistic answer: 3s of speech then 2.5s of silence", () => {
    let state = armedState(0);
    let decision = "wait";

    for (let t = 20; t <= 8000 && decision === "wait"; t += 20) {
      const speaking = t <= 3000;
      const energy = speaking ? 4000 : 0;
      const result = observeFrame(state, energy, t, CONFIG);
      state = result.state;
      decision = result.decision;
      if (decision !== "wait") {
        // 3000ms of speech + 2500ms of silence, within one frame.
        expect(t).toBeGreaterThanOrEqual(5500);
        expect(t).toBeLessThan(5540);
      }
    }

    expect(decision).toBe("answered");
  });
});
