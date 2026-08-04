import { useState } from "react";
import { useParams } from "react-router";
import { useCampaign } from "../api/campaigns.js";
import { AppShell } from "../components/AppShell.js";
import { AudioStep } from "./wizard/AudioStep.js";
import { ContactsStep } from "./wizard/ContactsStep.js";
import { DetailsStep } from "./wizard/DetailsStep.js";
import { ReviewStep } from "./wizard/ReviewStep.js";

const STEPS = ["Details", "Audio", "Contacts", "Review"] as const;

export function CampaignWizard() {
  const { id } = useParams();
  const { data: campaign, isLoading } = useCampaign(id);
  const [step, setStep] = useState(0);

  if (isLoading) return <AppShell>Loading</AppShell>;
  if (!campaign) return <AppShell>Campaign not found.</AppShell>;

  return (
    <AppShell>
      <h1 className="mb-4 text-2xl font-semibold text-slate-900">
        {campaign.name}
      </h1>

      <nav className="mb-6 flex gap-2">
        {STEPS.map((label, index) => (
          <button
            key={label}
            onClick={() => setStep(index)}
            className={
              index === step
                ? "rounded bg-slate-900 px-3 py-1.5 text-sm text-white"
                : "rounded bg-white px-3 py-1.5 text-sm text-slate-600 ring-1 ring-slate-200"
            }
          >
            {label}
          </button>
        ))}
      </nav>

      {step === 0 && <DetailsStep campaign={campaign} />}
      {step === 1 && <AudioStep campaign={campaign} />}
      {step === 2 && <ContactsStep campaign={campaign} />}
      {step === 3 && <ReviewStep campaign={campaign} />}
    </AppShell>
  );
}
