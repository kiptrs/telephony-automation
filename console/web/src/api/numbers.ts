import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { apiFetch } from "./client.js";

export const phoneNumberSchema = z.object({
  id: z.string().uuid(),
  e164: z.string(),
  telnyxNumberId: z.string().nullable(),
  tenantId: z.string().uuid().nullable(),
  tenantSlug: z.string().nullable(),
  maxConcurrent: z.number().int(),
  status: z.enum(["active", "paused", "released"]),
  activeLeases: z.number().int(),
  lastUsedAt: z.string().nullable(),
});
export type PhoneNumber = z.infer<typeof phoneNumberSchema>;

const tenantSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
});

export function useNumbers() {
  return useQuery({
    queryKey: ["admin", "numbers"],
    // Lease state changes as calls run, so this list is live.
    refetchInterval: 5000,
    queryFn: () =>
      apiFetch("/api/admin/numbers", { schema: z.array(phoneNumberSchema) }),
  });
}

export function useTenants() {
  return useQuery({
    queryKey: ["admin", "tenants"],
    queryFn: () =>
      apiFetch("/api/admin/tenants", { schema: z.array(tenantSchema) }),
  });
}

function useNumbersMutation<T>(fn: (input: T) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "numbers"] });
    },
  });
}

export function useAddNumber() {
  return useNumbersMutation((body: { e164: string; telnyxNumberId: string | null }) =>
    apiFetch("/api/admin/numbers", { method: "POST", body }),
  );
}

export function useUpdateNumber() {
  return useNumbersMutation(
    (args: {
      id: string;
      status?: "active" | "paused";
      tenantId?: string | null;
      maxConcurrent?: number;
    }) => {
      const { id, ...body } = args;
      return apiFetch(`/api/admin/numbers/${id}`, { method: "PATCH", body });
    },
  );
}
