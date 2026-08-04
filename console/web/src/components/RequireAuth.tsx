import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useSession } from "../auth/useSession.js";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading } = useSession();

  if (isLoading) {
    return <div className="p-8 text-slate-500">Loading</div>;
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}
