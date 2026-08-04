import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Reachable from outside the container when run under compose.
    host: true,
    port: 5173,
    // A bind-mounted volume does not deliver inotify events on Windows or
    // macOS, so under compose the watcher has to poll to see a save.
    watch: process.env.VITE_POLL
      ? { usePolling: true, interval: 300 }
      : undefined,
    // Same-origin in the browser, so the session cookie is sent without any
    // CORS configuration on the API.
    proxy: {
      "/api": {
        // 127.0.0.1 rather than localhost: Node resolves localhost to ::1
        // first, and the API listens on IPv4 only. Under compose this is
        // http://api:3000.
        target: process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
});
