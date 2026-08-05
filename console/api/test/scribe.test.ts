import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ElevenLabsTranscriptionClient,
  groupTurns,
  renderTranscript,
  TRANSCRIPTION_MODEL,
  type ScribeWord,
} from "../src/media/scribe.js";
import { testConfig } from "./helpers.js";

/** Shorthand for the shape ElevenLabs returns in `words`. */
function word(text: string, speaker: string | null): ScribeWord {
  return { text, type: "word", speaker_id: speaker };
}
function spacing(): ScribeWord {
  return { text: " ", type: "spacing", speaker_id: null };
}
function event(text: string, speaker: string | null): ScribeWord {
  return { text, type: "audio_event", speaker_id: speaker };
}

/** Words and spacing interleaved the way a real response arrives. */
function utterance(text: string, speaker: string | null): ScribeWord[] {
  return text
    .split(" ")
    .flatMap((part, index) =>
      index === 0 ? [word(part, speaker)] : [spacing(), word(part, speaker)],
    );
}

describe("groupTurns", () => {
  it("merges consecutive words from one speaker into a single turn", () => {
    const turns = groupTurns(utterance("Pirmas klausimas", "speaker_0"));
    expect(turns).toEqual([{ speaker: "speaker_0", text: "Pirmas klausimas" }]);
  });

  it("starts a new turn when the speaker changes", () => {
    const turns = groupTurns([
      ...utterance("Pirmas klausimas", "speaker_0"),
      spacing(),
      ...utterance("Sakyciau septyni", "speaker_1"),
    ]);
    expect(turns).toEqual([
      { speaker: "speaker_0", text: "Pirmas klausimas" },
      { speaker: "speaker_1", text: "Sakyciau septyni" },
    ]);
  });

  it("returns to the first speaker as its own third turn", () => {
    const turns = groupTurns([
      ...utterance("Antras klausimas", "speaker_0"),
      ...utterance("Septyni", "speaker_1"),
      ...utterance("Trecias klausimas", "speaker_0"),
    ]);
    expect(turns.map((turn) => turn.speaker)).toEqual([
      "speaker_0",
      "speaker_1",
      "speaker_0",
    ]);
  });

  // Kept in the raw JSON in S3, dropped from the text stored in Postgres.
  it("drops audio events without breaking the turn around them", () => {
    const turns = groupTurns([
      ...utterance("Sakyciau", "speaker_1"),
      spacing(),
      event("(laughs)", "speaker_1"),
      spacing(),
      ...utterance("septyni", "speaker_1"),
    ]);
    expect(turns).toEqual([{ speaker: "speaker_1", text: "Sakyciau septyni" }]);
  });

  it("separates words that arrive with no spacing between them", () => {
    const turns = groupTurns([
      word("Laba", "speaker_0"),
      word("diena", "speaker_0"),
    ]);
    expect(turns).toEqual([{ speaker: "speaker_0", text: "Laba diena" }]);
  });

  it("treats an unrecognised type as a word rather than failing", () => {
    const turns = groupTurns([
      { text: "Labas", type: "something_new", speaker_id: "speaker_0" },
    ]);
    expect(turns).toEqual([{ speaker: "speaker_0", text: "Labas" }]);
  });

  it("produces one unattributed turn when diarization returns no speaker", () => {
    const turns = groupTurns(utterance("Laba diena", null));
    expect(turns).toEqual([{ speaker: null, text: "Laba diena" }]);
  });

  it("returns nothing for an empty word list", () => {
    expect(groupTurns([])).toEqual([]);
  });

  it("drops a turn that is only spacing", () => {
    expect(groupTurns([spacing(), spacing()])).toEqual([]);
  });
});

describe("renderTranscript", () => {
  // The number follows the speaker, not the turn: whoever spoke first is
  // Speaker 1 every time they come back, whatever id the engine gave them.
  it("numbers speakers by order of first appearance", () => {
    const text = renderTranscript([
      { speaker: "speaker_3", text: "Pirmas klausimas" },
      { speaker: "speaker_1", text: "Septyni" },
      { speaker: "speaker_3", text: "Antras klausimas" },
    ]);
    expect(text).toBe(
      "Speaker 1: Pirmas klausimas\n\n" +
        "Speaker 2: Septyni\n\n" +
        "Speaker 1: Antras klausimas",
    );
  });

  it("omits labels when there is only one voice", () => {
    const text = renderTranscript([
      { speaker: "speaker_0", text: "Laba diena" },
      { speaker: "speaker_0", text: "Viso gero" },
    ]);
    expect(text).toBe("Laba diena\n\nViso gero");
  });

  it("omits labels when nothing was attributed", () => {
    expect(renderTranscript([{ speaker: null, text: "Laba diena" }])).toBe(
      "Laba diena",
    );
  });

  it("renders nothing for no turns", () => {
    expect(renderTranscript([])).toBe("");
  });
});

describe("ElevenLabsTranscriptionClient", () => {
  const config = testConfig();

  /** Captures the one request the client makes and replies with `reply`. */
  function stubFetch(reply: Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return reply;
    });
    return calls;
  }

  function ok(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  function transcribe(language: string | null = "lt") {
    return new ElevenLabsTranscriptionClient(config).transcribe({
      audio: Buffer.from("fake mp3 bytes"),
      filename: "recording.mp3",
      language,
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the audio to the speech-to-text endpoint with the api key", async () => {
    const calls = stubFetch(ok({ text: "labas", words: [] }));
    await transcribe();

    expect(calls[0]?.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(calls[0]?.init.method).toBe("POST");
    expect(
      (calls[0]?.init.headers as Record<string, string>)["xi-api-key"],
    ).toBe(config.elevenLabsApiKey);
  });

  it("asks for the diarized two-speaker transcript we rely on", async () => {
    const calls = stubFetch(ok({ text: "labas", words: [] }));
    await transcribe();

    const form = calls[0]?.init.body as FormData;
    expect(form.get("model_id")).toBe(TRANSCRIPTION_MODEL);
    expect(form.get("diarize")).toBe("true");
    expect(form.get("num_speakers")).toBe("2");
    expect(form.get("timestamps_granularity")).toBe("word");
    expect(form.get("language_code")).toBe("lt");
  });

  it("sends the audio under its filename", async () => {
    const calls = stubFetch(ok({ text: "labas", words: [] }));
    await transcribe();

    const file = (calls[0]?.init.body as FormData).get("file");
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe("recording.mp3");
    expect((file as Blob).size).toBe("fake mp3 bytes".length);
  });

  // Omitted rather than sent empty, so the engine falls back to auto-detection.
  it("omits the language hint when the campaign has none", async () => {
    const calls = stubFetch(ok({ text: "labas", words: [] }));
    await transcribe(null);

    expect((calls[0]?.init.body as FormData).has("language_code")).toBe(false);
  });

  it("returns the diarized turns, the duration and the untouched response", async () => {
    const payload = {
      text: "Pirmas klausimas Septyni",
      audio_duration_secs: 12.5,
      words: [
        { text: "Pirmas", type: "word", speaker_id: "speaker_0" },
        { text: " ", type: "spacing", speaker_id: null },
        { text: "klausimas", type: "word", speaker_id: "speaker_0" },
        { text: " ", type: "spacing", speaker_id: null },
        { text: "Septyni", type: "word", speaker_id: "speaker_1" },
      ],
    };
    stubFetch(ok(payload));

    const result = await transcribe();
    expect(result.text).toBe(
      "Speaker 1: Pirmas klausimas\n\nSpeaker 2: Septyni",
    );
    expect(result.durationSecs).toBe(12.5);
    // The raw response goes to S3 whole, speaker ids and all.
    expect(result.raw).toEqual(payload);
  });

  // Otherwise a response shaped unexpectedly would store an empty transcript
  // over a call that actually transcribed fine.
  it("falls back to the flat text when no words come back", async () => {
    stubFetch(ok({ text: "labas rytas", words: [] }));
    expect((await transcribe()).text).toBe("labas rytas");
  });

  it("reports a null duration when the engine omits it", async () => {
    stubFetch(ok({ text: "labas", words: [] }));
    expect((await transcribe()).durationSecs).toBeNull();
  });

  it("throws with the status and body when the engine rejects the call", async () => {
    stubFetch(new Response("quota exceeded", { status: 401 }));
    await expect(transcribe()).rejects.toThrow(/401.*quota exceeded/s);
  });
});
