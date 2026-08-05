import { z } from "zod";
import type { Config } from "../config.js";
import type { TranscriptionClient, TranscriptionResult } from "./transcribe.js";

/**
 * Written to transcripts.engine, which is also how the "Transcribe" button
 * decides a recording needs re-doing: a transcript from any other engine is
 * treated as stale.
 */
export const TRANSCRIPTION_MODEL = "scribe_v2";

const ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text";

/**
 * The call is structurally two speakers - us and the person who answered.
 * Capping it stops the diarizer minting a third out of line noise.
 */
const NUM_SPEAKERS = 2;

/**
 * `type` is deliberately a plain string rather than an enum. An unrecognised
 * kind from a future model version must not fail the whole parse; groupTurns
 * treats anything it does not know as a word.
 */
const wordSchema = z.object({
  text: z.string(),
  type: z.string().nullish(),
  speaker_id: z.string().nullish(),
});

const responseSchema = z.object({
  text: z.string().nullish(),
  words: z.array(wordSchema).nullish(),
  audio_duration_secs: z.number().nullish(),
});

export type ScribeWord = z.infer<typeof wordSchema>;

export interface Turn {
  /** The engine's own speaker id. Null when diarization returned nothing. */
  speaker: string | null;
  text: string;
}

/**
 * Collapses the flat word list into one entry per speaker turn.
 *
 * `audio_event` entries - "(laughs)", "(coughs)" - are dropped here rather than
 * by disabling tag_audio_events on the request. The option costs nothing either
 * way, so leaving it on keeps the events in the raw JSON in S3 for whatever
 * reads it later, while the text stored in Postgres stays clean.
 */
export function groupTurns(words: ScribeWord[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (const word of words) {
    if (word.type === "audio_event") continue;

    // Spacing carries the original whitespace and no speaker of its own, so it
    // extends the open turn instead of starting one.
    if (word.type === "spacing") {
      if (current) current.text += word.text;
      continue;
    }

    const speaker = word.speaker_id ?? null;
    if (!current || current.speaker !== speaker) {
      current = { speaker, text: word.text };
      turns.push(current);
    } else {
      // Only reached when a word follows a word with no spacing between them.
      current.text += current.text.endsWith(" ") ? word.text : ` ${word.text}`;
    }
  }

  return turns
    .map((turn) => ({
      speaker: turn.speaker,
      // Collapsing runs closes the gap a dropped audio event leaves behind.
      text: turn.text.replace(/\s+/g, " ").trim(),
    }))
    .filter((turn) => turn.text.length > 0);
}

/**
 * Speakers are numbered by order of appearance and nothing more.
 *
 * It is tempting to call the first speaker the agent, since question one plays
 * at the start of every call - but record_start fires on call.answered, before
 * any playback, so a recipient who says "Alio?" on pickup takes speaker one and
 * inverts every label on that call. The raw JSON in S3 keeps the engine's own
 * ids for anything that needs to do better than this.
 */
export function renderTranscript(turns: Turn[]): string {
  const speakers = [...new Set(turns.map((turn) => turn.speaker))];

  // A label is noise when there is only one voice, or none to attribute.
  if (speakers.length < 2) return turns.map((turn) => turn.text).join("\n\n");

  return turns
    .map((turn) => `Speaker ${speakers.indexOf(turn.speaker) + 1}: ${turn.text}`)
    .join("\n\n");
}

export class ElevenLabsTranscriptionClient implements TranscriptionClient {
  constructor(private readonly config: Config) {}

  async transcribe(args: {
    audio: Buffer;
    filename: string;
    language: string | null;
  }): Promise<TranscriptionResult> {
    const form = new FormData();
    form.append("model_id", TRANSCRIPTION_MODEL);
    form.append(
      "file",
      new Blob(
        [
          new Uint8Array(
            args.audio.buffer,
            args.audio.byteOffset,
            args.audio.byteLength,
          ),
        ],
        { type: "audio/mpeg" },
      ),
      args.filename,
    );
    form.append("diarize", "true");
    form.append("num_speakers", String(NUM_SPEAKERS));
    form.append("timestamps_granularity", "word");
    // Auto-detection is the documented default; the campaign usually knows.
    if (args.language) form.append("language_code", args.language);

    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "xi-api-key": this.config.elevenLabsApiKey },
      body: form,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `elevenlabs returned ${response.status}: ${detail.slice(0, 500)}`,
      );
    }

    const raw: unknown = await response.json();
    const parsed = responseSchema.parse(raw);
    const turns = groupTurns(parsed.words ?? []);

    return {
      // Falling back to the flat text matters: a response with no word list at
      // all would otherwise store an empty transcript over a successful call.
      text: turns.length > 0 ? renderTranscript(turns) : (parsed.text ?? ""),
      raw,
      durationSecs: parsed.audio_duration_secs ?? null,
    };
  }
}
