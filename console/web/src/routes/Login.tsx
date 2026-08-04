import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { apiFetch, ApiError } from "../api/client.js";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await apiFetch("/api/auth/login", {
        method: "POST",
        body: { email, password },
      });
      await queryClient.invalidateQueries({ queryKey: ["session"] });
      await navigate("/campaigns");
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "could not sign in",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-4 rounded-lg bg-white p-8 shadow"
      >
        <h1 className="text-xl font-semibold text-slate-900">Sign in</h1>

        <label className="block text-sm">
          <span className="text-slate-700">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
          />
        </label>

        <label className="block text-sm">
          <span className="text-slate-700">Password</span>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
          />
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded bg-slate-900 px-3 py-2 text-white disabled:opacity-50"
        >
          {pending ? "Signing in" : "Sign in"}
        </button>

        <p className="text-xs text-slate-500">
          Accounts are created by an administrator. There is no self-service
          registration.
        </p>
      </form>
    </div>
  );
}
