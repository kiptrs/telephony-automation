import type { Campaign } from "@console/shared";
import { useState } from "react";
import { useUpdateCampaign } from "../../api/campaigns.js";

export function DetailsStep({ campaign }: { campaign: Campaign }) {
  const update = useUpdateCampaign(campaign.id);
  const [name, setName] = useState(campaign.name);
  const [language, setLanguage] = useState(campaign.language);
  const [defaultCountry, setDefaultCountry] = useState(campaign.defaultCountry);
  const [silenceMs, setSilenceMs] = useState(campaign.silenceMs);

  return (
    <div className="space-y-4 rounded border border-slate-200 bg-white p-6">
      <label className="block text-sm">
        <span className="text-slate-700">Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
        />
      </label>

      <div className="grid grid-cols-2 gap-4">
        <label className="block text-sm">
          <span className="text-slate-700">Language</span>
          <span className="block text-xs text-slate-500">
            Two letters, used as the transcription hint. Example: lt
          </span>
          <input
            value={language}
            maxLength={2}
            onChange={(e) => setLanguage(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
          />
        </label>

        <label className="block text-sm">
          <span className="text-slate-700">Number country</span>
          <span className="block text-xs text-slate-500">
            Used to read local-format numbers in your contact list. Example: LT
          </span>
          <input
            value={defaultCountry}
            maxLength={2}
            onChange={(e) => setDefaultCountry(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
          />
        </label>
      </div>

      <label className="block text-sm">
        <span className="text-slate-700">Silence before the next question (ms)</span>
        <input
          type="number"
          min={500}
          max={10000}
          step={100}
          value={silenceMs}
          onChange={(e) => setSilenceMs(Number(e.target.value))}
          className="mt-1 w-40 rounded border border-slate-300 px-3 py-2"
        />
      </label>

      <button
        onClick={() =>
          update.mutate({ name, language, defaultCountry, silenceMs })
        }
        disabled={update.isPending}
        className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        {update.isPending ? "Saving" : "Save"}
      </button>
      {update.isError && (
        <p className="text-sm text-red-600">{String(update.error)}</p>
      )}
    </div>
  );
}
