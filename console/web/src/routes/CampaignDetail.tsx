import { Fragment, useState } from "react";
import { Link, useParams } from "react-router";
import {
  useCalls,
  useCampaign,
  useLaunch,
  usePause,
  useProgress,
  useRetry,
  useTranscribeCampaign,
} from "../api/campaigns.js";
import { ApiError } from "../api/client.js";
import { AppShell } from "../components/AppShell.js";
import { CallMedia } from "../components/CallMedia.js";
import { OutcomeBadge } from "../components/OutcomeBadge.js";

export function CampaignDetail() {
  const { id = "" } = useParams();
  const { data: campaign } = useCampaign(id);
  const transcribe = useTranscribeCampaign(id);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data: calls } = useCalls(id, campaign?.status === "running");

  // Poll while any transcript is unfinished too, not only while the campaign
  // runs - otherwise a completed campaign's transcripts never appear without a
  // manual refresh.
  const transcribing = calls?.some(
    (call) =>
      call.transcriptStatus === "pending" || call.transcriptStatus === "running",
  );
  const live = campaign?.status === "running" || transcribing === true;
  const { data: progress } = useProgress(id, live === true);
  const launch = useLaunch(id);
  const pause = usePause(id);
  const retry = useRetry(id);

  if (!campaign) return <AppShell>Loading</AppShell>;

  const percent =
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;

  return (
    <AppShell>
      <div className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">{campaign.name}</h1>
          <p className="text-sm text-slate-500">
            {campaign.questionCount} questions, {campaign.contactCount} contacts,{" "}
            {campaign.language}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to={`/campaigns/${id}/edit`}
            className="rounded px-3 py-2 text-sm text-slate-600 ring-1 ring-slate-200"
          >
            Edit
          </Link>
          <button
            onClick={() => transcribe.mutate()}
            disabled={transcribe.isPending}
            className="rounded px-3 py-2 text-sm text-slate-600 ring-1 ring-slate-200 disabled:opacity-50"
          >
            {transcribe.isPending ? "Queueing" : "Transcribe"}
          </button>
          {campaign.status === "running" ? (
            <button
              onClick={() => pause.mutate()}
              className="rounded bg-amber-600 px-4 py-2 text-sm text-white"
            >
              Pause
            </button>
          ) : campaign.status !== "completed" ? (
            <button
              onClick={() => launch.mutate()}
              className="rounded bg-slate-900 px-4 py-2 text-sm text-white"
            >
              {campaign.status === "paused" ? "Resume" : "Launch"}
            </button>
          ) : null}
        </div>
      </div>

      {launch.isError && (
        <div className="mb-4 rounded bg-amber-50 p-3 text-sm text-amber-900">
          {launch.error instanceof ApiError
            ? launch.error.message
            : "Could not launch"}
        </div>
      )}

      {progress && (
        <div className="mb-6 rounded border border-slate-200 bg-white p-4">
          <div className="mb-2 flex justify-between text-sm text-slate-600">
            <span>
              {progress.done} of {progress.total} done, {progress.dialing} in
              flight, {progress.pending} waiting
            </span>
            <span>{percent}%</span>
          </div>
          <div className="h-2 w-full rounded bg-slate-100">
            <div
              className="h-2 rounded bg-slate-900 transition-all"
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      )}

      <table className="w-full border-collapse rounded border border-slate-200 bg-white text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500">
            <th className="px-3 py-2 font-medium">Number</th>
            <th className="px-3 py-2 font-medium">Attempt</th>
            <th className="px-3 py-2 font-medium">From</th>
            <th className="px-3 py-2 font-medium">Outcome</th>
            <th className="px-3 py-2 font-medium">Ended</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {calls?.map((call) => (
            <Fragment key={call.id}>
              <tr
                onClick={() => setExpanded(expanded === call.id ? null : call.id)}
                className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
              >
                <td className="px-3 py-2 font-mono">{call.e164}</td>
                <td className="px-3 py-2 text-slate-500">{call.attempt}</td>
                <td className="px-3 py-2 font-mono text-slate-500">
                  {call.fromE164 ?? ""}
                </td>
                <td className="px-3 py-2">
                  <OutcomeBadge call={call} />
                </td>
                <td className="px-3 py-2 text-slate-500">
                  {call.endedAt ? new Date(call.endedAt).toLocaleString() : ""}
                </td>
                <td className="px-3 py-2 text-right">
                  {(call.status === "ended" || call.status === "failed") &&
                    call.outcome !== "completed" && (
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          retry.mutate(call.id);
                        }}
                        disabled={retry.isPending}
                        className="text-slate-600 underline disabled:opacity-50"
                      >
                        Retry
                      </button>
                    )}
                </td>
              </tr>
              {expanded === call.id && (
                <tr>
                  <td colSpan={6} className="p-0">
                    <CallMedia call={call} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>

      {calls?.length === 0 && (
        <p className="mt-4 text-sm text-slate-500">
          No calls yet. Launch the campaign to start dialling.
        </p>
      )}
    </AppShell>
  );
}
