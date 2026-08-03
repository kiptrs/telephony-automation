export type Step = 1 | 2 | 3 | "done";

export interface FlowState {
  step: Step;
}

const VALID_STEPS: readonly unknown[] = [1, 2, 3, "done"];

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
  if (!VALID_STEPS.includes(step)) return null;

  return { step: step as Step };
}
