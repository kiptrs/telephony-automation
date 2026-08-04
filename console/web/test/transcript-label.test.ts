import { describe, expect, it } from "vitest";
import { transcriptLabel } from "../src/components/CallMedia.js";

describe("transcriptLabel", () => {
  it("says nothing is stored yet while ingest is pending", () => {
    expect(transcriptLabel(null, false)).toBe("No recording yet");
  });

  it("offers transcription once the recording is stored", () => {
    expect(transcriptLabel(null, true)).toBe("Not transcribed");
  });

  it("shows a queued transcript as queued", () => {
    expect(transcriptLabel("pending", true)).toBe("Queued");
  });

  it("shows a running transcript as transcribing", () => {
    expect(transcriptLabel("running", true)).toBe("Transcribing");
  });

  it("shows a finished transcript as ready", () => {
    expect(transcriptLabel("done", true)).toBe("Transcript ready");
  });

  it("shows a failure as failed rather than hiding it", () => {
    expect(transcriptLabel("failed", true)).toBe("Transcription failed");
  });
});
