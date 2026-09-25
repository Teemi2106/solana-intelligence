import { defineConfig } from "vitest/config";

export default defineConfig({
  // Database-backed tests create a throwaway migrated database and replay real transaction fixtures.
  test: { include: ["**/*.test.ts"], testTimeout: 60_000, hookTimeout: 120_000, coverage: { reporter: ["text", "json", "html"] } }
});
