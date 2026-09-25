import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const optionalNonEmptyString = <Schema extends z.ZodType<string>>(schema: Schema) =>
  z.preprocess((value) => value === "" ? undefined : value, schema.optional());

const baseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.url().startsWith("postgresql://"),
  REDIS_URL: z.url().refine((url) => url.startsWith("redis://") || url.startsWith("rediss://"), "must be a Redis URL"),
  APP_URL: z.url().transform((value) => new URL(value)),
  AUTH_SECRET: z.string().min(43, "must contain at least 32 base64-encoded random bytes"),
  ADMIN_USERNAME: z.string().min(3).max(100),
  ADMIN_PASSWORD_HASH: z.string().startsWith("$argon2"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  SENTRY_DSN: optionalNonEmptyString(z.url()),
  ENABLE_LIVE_INGESTION: booleanFromString,
  ENABLE_TELEGRAM: booleanFromString,
  HELIUS_API_KEY: optionalNonEmptyString(z.string().min(1)),
  HELIUS_WEBHOOK_SECRET: optionalNonEmptyString(z.string().min(32)),
  /** Public HTTPS URL Helius delivers webhooks to, e.g. https://example.com/api/webhooks/helius (localhost is rejected by Helius). */
  LIVE_WEBHOOK_PUBLIC_URL: optionalNonEmptyString(z.url().refine((url) => url.startsWith("https://"), "must be an https URL")),
  TELEGRAM_BOT_TOKEN: optionalNonEmptyString(z.string().min(1)),
  TELEGRAM_CHAT_ID: optionalNonEmptyString(z.string().min(1)),
});

export type AppConfig = z.infer<typeof baseSchema>;

export function parseConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const config = baseSchema.parse(environment);
  if (config.ENABLE_LIVE_INGESTION && (!config.HELIUS_API_KEY || !config.HELIUS_WEBHOOK_SECRET)) {
    throw new Error("HELIUS_API_KEY and HELIUS_WEBHOOK_SECRET are required when live ingestion is enabled");
  }
  if (config.ENABLE_LIVE_INGESTION && !config.LIVE_WEBHOOK_PUBLIC_URL) {
    throw new Error("LIVE_WEBHOOK_PUBLIC_URL is required when live ingestion is enabled");
  }
  if (config.ENABLE_TELEGRAM && (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID)) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required when Telegram is enabled");
  }
  return config;
}
