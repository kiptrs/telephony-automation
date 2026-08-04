import type { Call } from "@console/shared";

export function outcomeLabel(call: Call): string {
  if (call.status === "queued" || call.status === "dialing") return "Dialing";
  if (call.status === "in_progress") return "In progress";

  switch (call.outcome) {
    case "completed":
      return "Completed";
    case "abandoned":
      return typeof call.lastStep === "number"
        ? `Abandoned at question ${call.lastStep}`
        : "Abandoned before question 1";
    case "no_answer":
      return "No answer";
    case "busy":
      return "Busy";
    case "failed":
      return "Failed to dial";
    default:
      // A lease expired without a hangup. Saying so beats inventing an outcome.
      return "Unknown";
  }
}

const TONE: Record<string, string> = {
  Completed: "bg-emerald-100 text-emerald-800",
  "No answer": "bg-slate-100 text-slate-700",
  Busy: "bg-amber-100 text-amber-800",
  "Failed to dial": "bg-red-100 text-red-800",
  Unknown: "bg-slate-100 text-slate-700",
  Dialing: "bg-blue-100 text-blue-800",
  "In progress": "bg-blue-100 text-blue-800",
};

export function OutcomeBadge({ call }: { call: Call }) {
  const label = outcomeLabel(call);
  const tone = TONE[label] ?? "bg-amber-100 text-amber-800";
  return (
    <span className={`rounded px-2 py-0.5 text-xs ${tone}`}>{label}</span>
  );
}
