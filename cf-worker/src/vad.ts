/**
 * Voice activity detection over Telnyx media-streaming frames.
 *
 * Everything here is pure: bytes and numbers in, a decision out. The Durable
 * Object owns the socket and the clock; this file owns the maths, so the
 * silence logic is unit testable without a call.
 */

const MULAW_BIAS = 0x84;

/** G.711 mu-law expansion to signed 16-bit linear PCM. */
export function muLawByteToLinear(byte: number): number {
  const u = ~byte & 0xff;
  let t = ((u & 0x0f) << 3) + MULAW_BIAS;
  t <<= (u & 0x70) >> 4;
  return (u & 0x80) !== 0 ? MULAW_BIAS - t : t - MULAW_BIAS;
}

/**
 * Mean absolute amplitude of one base64 mu-law frame, on the 0..32768 scale of
 * signed 16-bit PCM. Returns 0 for anything unparseable - a malformed frame
 * must never be mistaken for speech.
 */
export function frameEnergy(payloadB64: string): number {
  let binary: string;
  try {
    binary = atob(payloadB64);
  } catch {
    return 0;
  }
  if (binary.length === 0) return 0;

  let total = 0;
  for (let i = 0; i < binary.length; i++) {
    total += Math.abs(muLawByteToLinear(binary.charCodeAt(i)));
  }
  return total / binary.length;
}

/**
 * Telephony noise floor sits well below this; ordinary speech sits well above.
 * Deliberately generous - a false "silence" cuts the caller off mid-answer,
 * which is worse than waiting a beat longer.
 */
export const SPEECH_THRESHOLD = 700;

export interface VadConfig {
  /** Silence after speech that ends the answer. */
  silenceMs: number;
  /** Hard cap so a caller who never speaks cannot stall the call forever. */
  maxAnswerMs: number;
  threshold: number;
}

export interface VadState {
  /** True once the caller has actually said something this turn. */
  heardSpeech: boolean;
  lastVoiceAt: number;
  armedAt: number;
}

export function armedState(now: number): VadState {
  return { heardSpeech: false, lastVoiceAt: now, armedAt: now };
}

export type VadDecision = "wait" | "answered" | "timeout";

export interface VadResult {
  state: VadState;
  decision: VadDecision;
}

/**
 * Fold one frame into the state. Media frames arrive roughly every 20ms, so
 * they double as the clock - no timer is needed anywhere.
 */
export function observeFrame(
  state: VadState,
  energy: number,
  now: number,
  config: VadConfig,
): VadResult {
  const next: VadState = energy >= config.threshold
    ? { heardSpeech: true, lastVoiceAt: now, armedAt: state.armedAt }
    : state;

  if (next.heardSpeech && now - next.lastVoiceAt >= config.silenceMs) {
    return { state: next, decision: "answered" };
  }

  if (now - next.armedAt >= config.maxAnswerMs) {
    return { state: next, decision: "timeout" };
  }

  return { state: next, decision: "wait" };
}
