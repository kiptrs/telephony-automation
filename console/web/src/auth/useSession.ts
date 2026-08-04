import { meResponseSchema, type MeResponse } from "@console/shared";
import { useQuery } from "@tanstack/react-query";
import { ApiError, apiFetch } from "../api/client.js";

export function useSession() {
  const query = useQuery<MeResponse | null>({
    queryKey: ["session"],
    retry: false,
    queryFn: async () => {
      try {
        return await apiFetch("/api/auth/me", { schema: meResponseSchema });
      } catch (error) {
        // A 401 is the normal logged-out state, not a failure to report.
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
  });

  return { user: query.data ?? null, isLoading: query.isLoading };
}
