import { useState } from "react";
import { useNavigate } from "react-router";
import { useCampaigns, useCreateCampaign } from "../api/campaigns.js";
import { AppShell } from "../components/AppShell.js";

export function Campaigns() {
  const { data: campaigns, isLoading } = useCampaigns();
  const createCampaign = useCreateCampaign();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  async function create() {
    const campaign = await createCampaign.mutateAsync({
      name: "Untitled campaign",
      language: "lt",
      defaultCountry: "LT",
      silenceMs: 2500,
    });
    await navigate(`/campaigns/${campaign.id}/edit`);
  }

  return (
    <AppShell>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Campaigns</h1>
        <button
          onClick={() => {
            setCreating(true);
            void create().finally(() => setCreating(false));
          }}
          disabled={creating}
          className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          New campaign
        </button>
      </div>

      {isLoading && <p className="text-slate-500">Loading</p>}

      {campaigns?.length === 0 && (
        <p className="text-slate-500">
          No campaigns yet. Create one to upload audio and import contacts.
        </p>
      )}

      <ul className="divide-y divide-slate-200 rounded border border-slate-200 bg-white">
        {campaigns?.map((campaign) => (
          <li key={campaign.id}>
            <button
              onClick={() => void navigate(`/campaigns/${campaign.id}`)}
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-slate-50"
            >
              <span>
                <span className="font-medium text-slate-900">{campaign.name}</span>
                <span className="ml-3 text-sm text-slate-500">
                  {campaign.questionCount} questions, {campaign.contactCount}{" "}
                  contacts
                </span>
              </span>
              <span className="rounded bg-slate-100 px-2 py-1 text-xs uppercase text-slate-600">
                {campaign.status}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </AppShell>
  );
}
