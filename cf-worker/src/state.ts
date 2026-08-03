export type Step = 1 | 2 | 3 | "done";

/**
 * `playing` while one of our recordings is on the wire, `listening` after
 * call.playback.ended. Only transcripts received while `listening` advance the
 * flow - without this, speech picked up during a question would skip it.
 */
export type Phase = "playing" | "listening";

export interface FlowState {
  step: Step;
  phase: Phase;
}

const VALID_STEPS: readonly unknown[] = [1, 2, 3, "done"];
const VALID_PHASES: readonly unknown[] = ["playing", "listening"];

export function encodeState(state: FlowState): string {
  return btoa(JSON.stringify(state));
}

export function decodeState(raw: string | null | undefined): FlowState | null {
  if (!raw) return null;

  let json: string;
  try {
    json = atob(raw);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const { step, phase } = parsed as { step?: unknown; phase?: unknown };
  if (!VALID_STEPS.includes(step)) return null;
  if (!VALID_PHASES.includes(phase)) return null;

  return { step: step as Step, phase: phase as Phase };
}
