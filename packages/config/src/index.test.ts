import { describe, expect, it } from "vitest";
import { parseConfig } from "./index.js";

const valid = {
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/app",
  REDIS_URL: "redis://localhost:6379",
  APP_URL: "http://localhost:3000",
  AUTH_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD_HASH: "$argon2id$v=19$m=65536,t=3,p=4$hash",
};

describe("parseConfig", () => {
  it("rejects enabled integrations without credentials", () => {
    expect(() => parseConfig({ ...valid, ENABLE_TELEGRAM: "true" })).toThrow(/TELEGRAM/);
  });

  it("does not require disabled integration credentials", () => {
    expect(parseConfig({ ...valid, HELIUS_WEBHOOK_SECRET: "", SENTRY_DSN: "" }).ENABLE_LIVE_INGESTION).toBe(false);
  });

  it("requires every live-ingestion setting, and only when enabled", () => {
    const live = { ...valid, ENABLE_LIVE_INGESTION: "true" };
    expect(() => parseConfig(live)).toThrow(/HELIUS_API_KEY/);
    expect(() => parseConfig({ ...live, HELIUS_API_KEY: "k", HELIUS_WEBHOOK_SECRET: "s".repeat(32) })).toThrow(/LIVE_WEBHOOK_PUBLIC_URL/);
    expect(() => parseConfig({ ...live, HELIUS_API_KEY: "k", HELIUS_WEBHOOK_SECRET: "s".repeat(32), LIVE_WEBHOOK_PUBLIC_URL: "http://example.com/x" })).toThrow(/https/);
    expect(parseConfig({ ...live, HELIUS_API_KEY: "k", HELIUS_WEBHOOK_SECRET: "s".repeat(32), LIVE_WEBHOOK_PUBLIC_URL: "https://example.com/api/webhooks/helius" }).ENABLE_LIVE_INGESTION).toBe(true);
  });
});
