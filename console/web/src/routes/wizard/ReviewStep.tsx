import type { Campaign } from "@console/shared";
import { useNavigate } from "react-router";
import { campaignReadiness, useLaunch } from "../../api/campaigns.js";

export function ReviewStep({ campaign }: { campaign: Campaign }) {
  const { ready, blockers } = campaignReadiness(campaign);
  const launch = useLaunch(campaign.id);
  const navigate = useNavigate();

  return (
    <div className="space-y-4 rounded border border-slate-200 bg-white p-6">
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <dt className="text-slate-500">Name</dt>
        <dd className="text-slate-900">{campaign.name}</dd>
        <dt className="text-slate-500">Language</dt>
        <dd className="text-slate-900">{campaign.language}</dd>
        <dt className="text-slate-500">Number country</dt>
        <dd className="text-slate-900">{campaign.defaultCountry}</dd>
        <dt className="text-slate-500">Silence</dt>
        <dd className="text-slate-900">{campaign.silenceMs} ms</dd>
        <dt className="text-slate-500">Questions</dt>
        <dd className="text-slate-900">{campaign.questionCount}</dd>
        <dt className="text-slate-500">Thank-you audio</dt>
        <dd className="text-slate-900">
          {campaign.thanksUploaded ? "Uploaded" : "Missing"}
        </dd>
        <dt className="text-slate-500">Contacts</dt>
        <dd className="text-slate-900">{campaign.contactCount}</dd>
      </dl>

      {ready ? (
        <button
          onClick={() =>
            launch.mutate(undefined, {
              onSuccess: () => void navigate(`/campaigns/${campaign.id}`),
            })
          }
          disabled={launch.isPending}
          className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {launch.isPending ? "Launching" : "Launch campaign"}
        </button>
      ) : (
        <ul className="rounded bg-amber-50 p-3 text-sm text-amber-900">
          {blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
