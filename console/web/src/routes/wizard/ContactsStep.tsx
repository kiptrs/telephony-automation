import type { Campaign, ContactPreviewResponse } from "@console/shared";
import { useState } from "react";
import {
  previewContacts,
  useContacts,
  useImportContacts,
} from "../../api/campaigns.js";

export function ContactsStep({ campaign }: { campaign: Campaign }) {
  const { data: contacts } = useContacts(campaign.id);
  const importContacts = useImportContacts(campaign.id);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ContactPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runPreview(body: { csv: string } | { text: string }) {
    setError(null);
    try {
      setPreview(await previewContacts(campaign.id, body));
    } catch (caught) {
      setError(String(caught));
    }
  }

  return (
    <div className="space-y-6 rounded border border-slate-200 bg-white p-6">
      <section>
        <h2 className="mb-2 font-medium text-slate-900">Add numbers</h2>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          placeholder="+37060000001"
          className="w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            onClick={() => void runPreview({ text })}
            disabled={text.trim().length === 0}
            className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            Preview pasted list
          </button>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) await runPreview({ csv: await file.text() });
            }}
            className="text-sm"
          />
        </div>
      </section>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {preview && (
        <section className="space-y-3">
          <h2 className="font-medium text-slate-900">Preview</h2>
          <p className="text-sm text-slate-600">
            {preview.accepted.length} will be imported,{" "}
            {preview.rejected.length} rejected,{" "}
            {preview.duplicatesInInput.length} duplicated in the list,{" "}
            {preview.alreadyInCampaign.length} already in this campaign.
          </p>

          {preview.rejected.length > 0 && (
            <ul className="max-h-40 overflow-y-auto rounded border border-red-200 bg-red-50 p-3 text-sm">
              {preview.rejected.map((row) => (
                <li key={`${row.sourceLine}-${row.raw}`}>
                  Line {row.sourceLine}: {row.raw} - {row.reason}
                </li>
              ))}
            </ul>
          )}

          <button
            onClick={() =>
              importContacts.mutate(preview.accepted, {
                onSuccess: () => {
                  setPreview(null);
                  setText("");
                },
              })
            }
            disabled={preview.accepted.length === 0 || importContacts.isPending}
            className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            Import {preview.accepted.length} contacts
          </button>
        </section>
      )}

      <section>
        <h2 className="mb-2 font-medium text-slate-900">
          In this campaign ({contacts?.length ?? 0})
        </h2>
        <ul className="max-h-64 overflow-y-auto rounded border border-slate-200 text-sm">
          {contacts?.map((contact) => (
            <li
              key={contact.id}
              className="flex justify-between border-b border-slate-100 px-3 py-1.5 last:border-0"
            >
              <span className="font-mono">{contact.e164}</span>
              <span className="text-slate-500">{contact.externalRef ?? ""}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
