import { useState } from "react";
import { useAddNumber, useNumbers, useTenants, useUpdateNumber } from "../api/numbers.js";
import { ApiError } from "../api/client.js";
import { AppShell } from "../components/AppShell.js";
import { useSession } from "../auth/useSession.js";

export function AdminNumbers() {
  const { user } = useSession();
  const { data: numbers } = useNumbers();
  const { data: tenants } = useTenants();
  const addNumber = useAddNumber();
  const updateNumber = useUpdateNumber();
  const [e164, setE164] = useState("");
  const [telnyxId, setTelnyxId] = useState("");

  if (user && user.role !== "platform_admin") {
    return <AppShell>This page is for platform administrators.</AppShell>;
  }

  return (
    <AppShell>
      <h1 className="mb-4 text-2xl font-semibold text-slate-900">Number pool</h1>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          addNumber.mutate(
            { e164, telnyxNumberId: telnyxId || null },
            { onSuccess: () => { setE164(""); setTelnyxId(""); } },
          );
        }}
        className="mb-6 flex items-end gap-3 rounded border border-slate-200 bg-white p-4"
      >
        <label className="text-sm">
          <span className="block text-slate-700">Number (E.164)</span>
          <input
            value={e164}
            onChange={(e) => setE164(e.target.value)}
            placeholder="+37069000001"
            className="mt-1 rounded border border-slate-300 px-3 py-2 font-mono"
          />
        </label>
        <label className="text-sm">
          <span className="block text-slate-700">Telnyx id (optional)</span>
          <input
            value={telnyxId}
            onChange={(e) => setTelnyxId(e.target.value)}
            className="mt-1 rounded border border-slate-300 px-3 py-2"
          />
        </label>
        <button
          type="submit"
          disabled={addNumber.isPending}
          className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          Add
        </button>
        {addNumber.isError && (
          <span className="text-sm text-red-600">
            {addNumber.error instanceof ApiError
              ? addNumber.error.message
              : "Could not add"}
          </span>
        )}
      </form>

      <p className="mb-2 text-sm text-slate-500">
        Numbers are bought in the Telnyx portal and registered here. A number
        with no tenant is in the shared pool and any campaign may use it.
      </p>

      <table className="w-full border-collapse rounded border border-slate-200 bg-white text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500">
            <th className="px-3 py-2 font-medium">Number</th>
            <th className="px-3 py-2 font-medium">Tenant</th>
            <th className="px-3 py-2 font-medium">In use</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {numbers?.map((number) => (
            <tr key={number.id} className="border-b border-slate-100 last:border-0">
              <td className="px-3 py-2 font-mono">{number.e164}</td>
              <td className="px-3 py-2">
                <select
                  value={number.tenantId ?? ""}
                  onChange={(e) =>
                    updateNumber.mutate({
                      id: number.id,
                      tenantId: e.target.value === "" ? null : e.target.value,
                    })
                  }
                  className="rounded border border-slate-300 px-2 py-1"
                >
                  <option value="">Shared pool</option>
                  {tenants?.map((tenant) => (
                    <option key={tenant.id} value={tenant.id}>
                      {tenant.name}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-3 py-2 text-slate-600">
                {number.activeLeases} of {number.maxConcurrent}
              </td>
              <td className="px-3 py-2">{number.status}</td>
              <td className="px-3 py-2 text-right">
                <button
                  onClick={() =>
                    updateNumber.mutate({
                      id: number.id,
                      status: number.status === "active" ? "paused" : "active",
                    })
                  }
                  className="text-slate-600 underline"
                >
                  {number.status === "active" ? "Pause" : "Activate"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {numbers?.length === 0 && (
        <p className="mt-4 text-sm text-slate-500">
          The pool is empty. Nothing can be dialled until a number is added.
        </p>
      )}
    </AppShell>
  );
}
