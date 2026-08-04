import type { CallOutcome } from "@console/shared";

/** Telnyx causes that mean the callee actively refused rather than missed it. */
const REJECTED_CAUSES = new Set(["user_busy", "call_rejected", "busy"]);

/**
 * The Worker's step is the authority. It only exists if audio actually played,
 * which can only happen after the call was answered - so a step present with
 * answered false means the answered webhook was lost, not that the call failed.
 */
export function deriveOutcome(input: {
  step: number | "done" | null;
  answered: boolean;
  hangupCause: string | null;
}): CallOutcome {
  if (input.step === "done") return "completed";
  if (input.step !== null) return "abandoned";
  if (input.answered) return "abandoned";
  if (input.hangupCause && REJECTED_CAUSES.has(input.hangupCause)) return "busy";
  return "no_answer";
}

/** "done" becomes 0 so calls.last_step can stay a plain integer column. */
export function encodeStep(step: number | "done" | null): number | null {
  if (step === null) return null;
  return step === "done" ? 0 : step;
}

export function decodeStep(value: number | null): number | "done" | null {
  if (value === null) return null;
  return value === 0 ? "done" : value;
}
