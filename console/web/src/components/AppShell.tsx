import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { apiFetch } from "../api/client.js";
import { useSession } from "../auth/useSession.js";

export function AppShell({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function signOut() {
    await apiFetch("/api/auth/logout", { method: "POST" });
    queryClient.clear();
    await navigate("/login");
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <Link to="/campaigns" className="font-semibold text-slate-900">
          Console
        </Link>
        <div className="flex items-center gap-4 text-sm text-slate-600">
          {user?.role === "platform_admin" && (
            <Link to="/admin/numbers" className="underline">
              Numbers
            </Link>
          )}
          <span>{user?.email}</span>
          <button onClick={() => void signOut()} className="underline">
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-6">{children}</main>
    </div>
  );
}
