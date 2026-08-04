import type { Call, TranscriptStatus } from "@console/shared";
import { useState } from "react";
import { fetchRecordingUrl, useTranscript } from "../api/campaigns.js";

export function transcriptLabel(
  status: TranscriptStatus | null,
  hasRecording: boolean,
): string {
  if (status === null) return hasRecording ? "Not transcribed" : "No recording yet";
  switch (status) {
    case "pending":
      return "Queued";
    case "running":
      return "Transcribing";
    case "done":
      return "Transcript ready";
    case "failed":
      return "Transcription failed";
  }
}

export function CallMedia({ call }: { call: Call }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const transcript = useTranscript(call.id, call.transcriptStatus === "done");

  async function loadAudio() {
    setError(null);
    try {
      // Presigned on demand rather than with the row, so a list of 500 calls
      // does not mint 500 URLs nobody opens.
      setUrl((await fetchRecordingUrl(call.id)).url);
    } catch {
      setError("Could not load the recording");
    }
  }

  return (
    <div className="space-y-3 bg-slate-50 px-3 py-3 text-sm">
      <div className="flex items-center gap-3">
        {call.hasRecording ? (
          url ? (
            <audio controls src={url} className="h-8 w-full max-w-md" />
          ) : (
            <button onClick={() => void loadAudio()} className="underline text-slate-600">
              Load recording
            </button>
          )
        ) : (
          <span className="text-slate-500">No recording stored for this call.</span>
        )}
        <span className="text-slate-500">
          {transcriptLabel(call.transcriptStatus, call.hasRecording)}
        </span>
      </div>

      {error && <p className="text-red-600">{error}</p>}

      {call.transcriptStatus === "failed" && (
        <p className="rounded bg-red-50 p-2 text-red-800">
          Transcription failed. Use Transcribe again to retry it.
        </p>
      )}

      {transcript.data?.text && (
        <p className="whitespace-pre-wrap rounded border border-slate-200 bg-white p-3 text-slate-800">
          {transcript.data.text}
        </p>
      )}
    </div>
  );
}
