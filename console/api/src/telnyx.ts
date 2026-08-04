const API_BASE = "https://api.telnyx.com/v2";

export class TelnyxError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TelnyxError";
    this.status = status;
  }
}

function stringAt(source: unknown, key: string): string | null {
  if (typeof source !== "object" || source === null) return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * mp3 first: it is what record_start asks for and it is a quarter the size of
 * the wav, which matters against Whisper's 25 MB limit.
 */
export function pickRecordingUrl(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;

  for (const key of ["recording_urls", "public_recording_urls"]) {
    const group = record[key];
    const mp3 = stringAt(group, "mp3");
    if (mp3) return mp3;
    const wav = stringAt(group, "wav");
    if (wav) return wav;
  }
  return null;
}

/**
 * Verifies the body before returning it. An empty or truncated download that
 * reached S3 would look like a successful ingest and then be deleted at
 * Telnyx, destroying the only copy.
 */
export async function downloadRecording(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new TelnyxError(
      response.status,
      `downloading the recording failed: ${await response.text()}`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) {
    throw new TelnyxError(502, "recording download was empty");
  }

  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== buffer.byteLength) {
    throw new TelnyxError(
      502,
      `recording download was truncated: expected ${declared} bytes, got ${buffer.byteLength}`,
    );
  }

  return buffer;
}

export async function deleteRecording(
  apiKey: string,
  recordingId: string,
): Promise<void> {
  const response = await fetch(
    `${API_BASE}/recordings/${encodeURIComponent(recordingId)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${apiKey}` } },
  );

  // Already deleted is the desired state, not a failure to retry.
  if (response.status === 404) return;

  if (!response.ok) {
    throw new TelnyxError(
      response.status,
      `deleting the recording failed: ${await response.text()}`,
    );
  }
}
