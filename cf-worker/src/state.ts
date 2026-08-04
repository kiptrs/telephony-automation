export type Step = number | "done";

export interface FlowState {
  step: Step;
}

/** Upper bound on questions in one survey. Also bounds what client_state accepts. */
export const MAX_QUESTIONS = 10;

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

  const step = (parsed as { step?: unknown }).step;

  if (step === "done") return { step: "done" };

  if (
    typeof step === "number" &&
    Number.isInteger(step) &&
    step >= 1 &&
    step <= MAX_QUESTIONS
  ) {
    return { step };
  }

  return null;
}
