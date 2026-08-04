import {
  callSchema,
  campaignProgressSchema,
  campaignSchema,
  MAX_QUESTIONS,
  type Call,
  type Campaign,
  type CampaignProgress,
  transcriptSchema,
  type ContactPreviewResponse,
  type CreateCampaignRequest,
  type ParsedContact,
  type TranscriptStatus,
} from "@console/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { apiFetch } from "./client.js";

const questionSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int(),
  originalFilename: z.string(),
  bytes: z.number().int(),
});
export type Question = z.infer<typeof questionSchema>;

const contactSchema = z.object({
  id: z.string().uuid(),
  e164: z.string(),
  externalRef: z.string().nullable(),
  status: z.enum(["pending", "dialing", "done"]),
});
export type Contact = z.infer<typeof contactSchema>;

/**
 * The single definition of "could this campaign be launched". Plan 2's launch
 * button reads the same function, so the UI and the server cannot drift on
 * what a complete campaign means.
 */
export function campaignReadiness(campaign: Campaign): {
  ready: boolean;
  blockers: string[];
} {
  const blockers: string[] = [];
  if (campaign.questionCount === 0) blockers.push("Upload at least one question");
  if (campaign.questionCount > MAX_QUESTIONS) {
    blockers.push(`A campaign holds at most ${MAX_QUESTIONS} questions`);
  }
  if (!campaign.thanksUploaded) blockers.push("Upload the thank-you audio");
  if (campaign.contactCount === 0) blockers.push("Import at least one contact");
  return { ready: blockers.length === 0, blockers };
}

export function useCampaigns() {
  return useQuery({
    queryKey: ["campaigns"],
    queryFn: () =>
      apiFetch("/api/campaigns", { schema: z.array(campaignSchema) }),
  });
}

export function useCampaign(id: string | undefined) {
  return useQuery({
    queryKey: ["campaigns", id],
    enabled: id !== undefined,
    queryFn: () =>
      apiFetch(`/api/campaigns/${id}`, { schema: campaignSchema }),
  });
}

export function useCreateCampaign() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCampaignRequest) =>
      apiFetch("/api/campaigns", {
        method: "POST",
        body,
        schema: campaignSchema,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["campaigns"] }),
  });
}

export function useUpdateCampaign(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<CreateCampaignRequest>) =>
      apiFetch(`/api/campaigns/${id}`, {
        method: "PATCH",
        body,
        schema: campaignSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });
}

export function useQuestions(campaignId: string | undefined) {
  return useQuery({
    queryKey: ["campaigns", campaignId, "questions"],
    enabled: campaignId !== undefined,
    queryFn: () =>
      apiFetch(`/api/campaigns/${campaignId}/questions`, {
        schema: z.array(questionSchema),
      }),
  });
}

export function useUploadAudio(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: { file: File; kind: "question" | "thanks" }) => {
      const formData = new FormData();
      formData.append("file", args.file);
      const path =
        args.kind === "question"
          ? `/api/campaigns/${campaignId}/questions`
          : `/api/campaigns/${campaignId}/thanks`;
      return apiFetch(path, {
        method: args.kind === "question" ? "POST" : "PUT",
        formData,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns", campaignId] });
    },
  });
}

export function useDeleteQuestion(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (questionId: string) =>
      apiFetch(`/api/campaigns/${campaignId}/questions/${questionId}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns", campaignId] });
    },
  });
}

export function useReorderQuestions(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch(`/api/campaigns/${campaignId}/questions/order`, {
        method: "PATCH",
        body: { ids },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns", campaignId] });
    },
  });
}

export function useContacts(campaignId: string | undefined) {
  return useQuery({
    queryKey: ["campaigns", campaignId, "contacts"],
    enabled: campaignId !== undefined,
    queryFn: () =>
      apiFetch(`/api/campaigns/${campaignId}/contacts`, {
        schema: z.array(contactSchema),
      }),
  });
}

export function previewContacts(
  campaignId: string,
  body: { csv: string } | { text: string },
): Promise<ContactPreviewResponse> {
  return apiFetch(`/api/campaigns/${campaignId}/contacts/preview`, {
    method: "POST",
    body,
  });
}

export function useImportContacts(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rows: ParsedContact[]) =>
      apiFetch<{ imported: number }>(`/api/campaigns/${campaignId}/contacts`, {
        method: "POST",
        body: { rows },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns", campaignId] });
    },
  });
}

/** Polled while a campaign runs; 3 seconds is frequent enough to feel live. */
export const LIVE_POLL_MS = 3000;

export function useCalls(campaignId: string, live: boolean) {
  return useQuery({
    queryKey: ["campaigns", campaignId, "calls"],
    refetchInterval: live ? LIVE_POLL_MS : false,
    queryFn: () =>
      apiFetch(`/api/campaigns/${campaignId}/calls`, {
        schema: z.array(callSchema),
      }),
  });
}

export function useProgress(campaignId: string, live: boolean) {
  return useQuery({
    queryKey: ["campaigns", campaignId, "progress"],
    refetchInterval: live ? LIVE_POLL_MS : false,
    queryFn: () =>
      apiFetch(`/api/campaigns/${campaignId}/progress`, {
        schema: campaignProgressSchema,
      }),
  });
}

function useCampaignAction(campaignId: string, action: "launch" | "pause") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch(`/api/campaigns/${campaignId}/${action}`, {
        method: "POST",
        schema: campaignSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });
}

export const useLaunch = (id: string) => useCampaignAction(id, "launch");
export const usePause = (id: string) => useCampaignAction(id, "pause");

export function useRetry(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (callId: string) =>
      apiFetch(`/api/calls/${callId}/retry`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns", campaignId] });
    },
  });
}

export type { Call, CampaignProgress };

export function useTranscribeCampaign(campaignId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ enqueued: number }>(`/api/campaigns/${campaignId}/transcribe`, {
        method: "POST",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaigns", campaignId] });
    },
  });
}

export function useTranscript(callId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["calls", callId, "transcript"],
    enabled,
    retry: false,
    queryFn: () =>
      apiFetch(`/api/calls/${callId}/transcript`, { schema: transcriptSchema }),
  });
}

export function fetchRecordingUrl(callId: string): Promise<{ url: string }> {
  return apiFetch(`/api/calls/${callId}/recording`);
}

export type { TranscriptStatus };
