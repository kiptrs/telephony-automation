import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Many suites truncate the same tables, so running files concurrently would
    // have one test wipe another's fixtures mid-flight.
    fileParallelism: false,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgres://console:console@localhost:5432/console",
      // The MinIO root credentials from docker-compose.dev.yml. The S3 SDK reads
      // these from the environment; testConfig() only supplies the endpoint.
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "console",
      AWS_SECRET_ACCESS_KEY:
        process.env.AWS_SECRET_ACCESS_KEY ?? "consoleconsole",
    },
  },
});
