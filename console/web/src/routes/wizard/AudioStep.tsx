import type { Campaign } from "@console/shared";
import { useRef } from "react";
import {
  useDeleteQuestion,
  useQuestions,
  useReorderQuestions,
  useUploadAudio,
} from "../../api/campaigns.js";

export function AudioStep({ campaign }: { campaign: Campaign }) {
  const { data: questions } = useQuestions(campaign.id);
  const upload = useUploadAudio(campaign.id);
  const remove = useDeleteQuestion(campaign.id);
  const reorder = useReorderQuestions(campaign.id);
  const questionInput = useRef<HTMLInputElement>(null);
  const thanksInput = useRef<HTMLInputElement>(null);

  function move(index: number, direction: -1 | 1) {
    if (!questions) return;
    const ids = questions.map((question) => question.id);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    const a = ids[index];
    const b = ids[target];
    if (!a || !b) return;
    ids[index] = b;
    ids[target] = a;
    reorder.mutate(ids);
  }

  return (
    <div className="space-y-6 rounded border border-slate-200 bg-white p-6">
      <section>
        <h2 className="mb-2 font-medium text-slate-900">Questions</h2>
        <ol className="mb-3 divide-y divide-slate-200 rounded border border-slate-200">
          {questions?.map((question, index) => (
            <li
              key={question.id}
              className="flex items-center justify-between px-3 py-2 text-sm"
            >
              <span>
                <span className="mr-2 text-slate-400">{question.position}</span>
                {question.originalFilename}
              </span>
              <span className="flex gap-2">
                <button onClick={() => move(index, -1)} className="text-slate-500">
                  Up
                </button>
                <button onClick={() => move(index, 1)} className="text-slate-500">
                  Down
                </button>
                <button
                  onClick={() => remove.mutate(question.id)}
                  className="text-red-600"
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ol>
        {questions?.length === 0 && (
          <p className="mb-3 text-sm text-slate-500">No questions yet.</p>
        )}

        <input
          ref={questionInput}
          type="file"
          accept="audio/mpeg,audio/wav"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate({ file, kind: "question" });
            if (questionInput.current) questionInput.current.value = "";
          }}
          className="text-sm"
        />
      </section>

      <section>
        <h2 className="mb-2 font-medium text-slate-900">Thank-you audio</h2>
        <p className="mb-2 text-sm text-slate-500">
          {campaign.thanksUploaded ? "Uploaded" : "Not uploaded yet"}
        </p>
        <input
          ref={thanksInput}
          type="file"
          accept="audio/mpeg,audio/wav"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate({ file, kind: "thanks" });
            if (thanksInput.current) thanksInput.current.value = "";
          }}
          className="text-sm"
        />
      </section>

      {upload.isError && (
        <p className="text-sm text-red-600">{String(upload.error)}</p>
      )}
    </div>
  );
}
