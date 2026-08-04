import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { RequireAuth } from "./components/RequireAuth.js";
import { AdminNumbers } from "./routes/AdminNumbers.js";
import { CampaignDetail } from "./routes/CampaignDetail.js";
import { CampaignWizard } from "./routes/CampaignWizard.js";
import { Campaigns } from "./routes/Campaigns.js";
import { Login } from "./routes/Login.js";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/campaigns"
            element={
              <RequireAuth>
                <Campaigns />
              </RequireAuth>
            }
          />
          <Route
            path="/campaigns/:id"
            element={
              <RequireAuth>
                <CampaignDetail />
              </RequireAuth>
            }
          />
          <Route
            path="/campaigns/:id/edit"
            element={
              <RequireAuth>
                <CampaignWizard />
              </RequireAuth>
            }
          />
          <Route
            path="/admin/numbers"
            element={
              <RequireAuth>
                <AdminNumbers />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/campaigns" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
