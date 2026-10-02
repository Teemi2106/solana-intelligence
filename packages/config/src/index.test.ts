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
    expect(() => parseConfig({ ...valid, ENABLE_TELEGRAM: "true" })).toThrow(
      /TELEGRAM/,
    );
  });

  it("does not require disabled integration credentials", () => {
    expect(
      parseConfig({ ...valid, HELIUS_WEBHOOK_SECRET: "", SENTRY_DSN: "" })
        .ENABLE_LIVE_INGESTION,
    ).toBe(false);
  });

  it("requires every live-ingestion setting, and only when enabled", () => {
    const live = { ...valid, ENABLE_LIVE_INGESTION: "true" };
    expect(() => parseConfig(live)).toThrow(/HELIUS_API_KEY/);
    expect(() =>
      parseConfig({
        ...live,
        HELIUS_API_KEY: "k",
        HELIUS_WEBHOOK_SECRET: "s".repeat(32),
      }),
    ).toThrow(/LIVE_WEBHOOK_PUBLIC_URL/);
    expect(() =>
      parseConfig({
        ...live,
        HELIUS_API_KEY: "k",
        HELIUS_WEBHOOK_SECRET: "s".repeat(32),
        LIVE_WEBHOOK_PUBLIC_URL: "http://example.com/x",
      }),
    ).toThrow(/https/);
    expect(
      parseConfig({
        ...live,
        HELIUS_API_KEY: "k",
        HELIUS_WEBHOOK_SECRET: "s".repeat(32),
        LIVE_WEBHOOK_PUBLIC_URL: "https://example.com/api/webhooks/helius",
      }).ENABLE_LIVE_INGESTION,
    ).toBe(true);
  });

  it("normalizes a production site origin to the webhook receiver route", () => {
    const config = parseConfig({
      ...valid,
      ENABLE_LIVE_INGESTION: "true",
      HELIUS_API_KEY: "k",
      HELIUS_WEBHOOK_SECRET: "s".repeat(32),
      LIVE_WEBHOOK_PUBLIC_URL: "https://example.com/",
    });
    expect(config.LIVE_WEBHOOK_PUBLIC_URL).toBe(
      "https://example.com/api/webhooks/helius",
    );
  });

  it("defaults recovery to 24-hour shadow mode and accepts evidence-based longer intervals", () => {
    expect(parseConfig(valid)).toMatchObject({ RECOVERY_INTEGRITY_INTERVAL_HOURS: 24, RECOVERY_SHADOW_MODE: true });
    expect(parseConfig({ ...valid, RECOVERY_INTEGRITY_INTERVAL_HOURS: "168", RECOVERY_SHADOW_MODE: "false" }))
      .toMatchObject({ RECOVERY_INTEGRITY_INTERVAL_HOURS: 168, RECOVERY_SHADOW_MODE: false });
    expect(() => parseConfig({ ...valid, RECOVERY_INTEGRITY_INTERVAL_HOURS: "12" })).toThrow();
  });

  it("defaults Phase 4 freshness without enabling enrichment and requires Helius when enabled", () => {
    expect(parseConfig(valid)).toMatchObject({
      ENABLE_TOKEN_INTELLIGENCE: false,
      TOKEN_MARKET_FRESHNESS_MINUTES: 5,
      TOKEN_HOLDER_FRESHNESS_HOURS: 24,
      TOKEN_METADATA_FRESHNESS_HOURS: 24,
      TOKEN_AUTHORITIES_FRESHNESS_HOURS: 6,
      ENABLE_BEHAVIOR_ANOMALIES: false,
      ENABLE_BEHAVIOR_SHADOW_EVALUATION: false,
      BEHAVIOR_RECENT_WINDOW_DAYS: 30,
      BEHAVIOR_LONG_TERM_WINDOW_DAYS: 180,
      BEHAVIOR_MAX_OBSERVATIONS: 2000,
      BEHAVIOR_INCIDENT_WINDOW_MINUTES: 30,
    });
    expect(() => parseConfig({ ...valid, ENABLE_TOKEN_INTELLIGENCE: "true" })).toThrow(/HELIUS_API_KEY/);
  });

  it("separates internal behavior evaluation from user-facing anomaly alerting", () => {
    expect(parseConfig({ ...valid, ENABLE_BEHAVIOR_SHADOW_EVALUATION: "true", ENABLE_BEHAVIOR_ANOMALIES: "false" }))
      .toMatchObject({ ENABLE_BEHAVIOR_SHADOW_EVALUATION: true, ENABLE_BEHAVIOR_ANOMALIES: false });
  });
});
