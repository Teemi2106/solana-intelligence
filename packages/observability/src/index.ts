import pino, { type Logger, type LoggerOptions } from "pino";

const redactPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "password",
  "passwordHash",
  "AUTH_SECRET",
  "HELIUS_API_KEY",
  "HELIUS_WEBHOOK_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "LIVE_WEBHOOK_PUBLIC_URL",
  "req.headers[\"x-api-key\"]",
  "headers.cookie",
  "apiKey",
  "authHeader",
  "webhookSecret",
  "authorization",
  "*.apiKey",
  "*.authHeader",
  "*.webhookSecret",
];

export function createLogger(options: { service: string; level?: string; destination?: NodeJS.WritableStream }): Logger {
  const config: LoggerOptions = {
    name: options.service,
    level: options.level ?? "info",
    base: { service: options.service },
    redact: { paths: redactPaths, censor: "[REDACTED]" },
  };
  return options.destination ? pino(config, options.destination) : pino(config);
}

export function errorDetails(error: unknown): { error: { name: string; message: string; stack?: string } } {
  if (error instanceof Error) {
    return { error: { name: error.name, message: error.message, ...(error.stack ? { stack: error.stack } : {}) } };
  }
  return { error: { name: "UnknownError", message: String(error) } };
}

// ---- Metrics ------------------------------------------------------------------------------------

type Labels = Readonly<Record<string, string>>;

/** Minimal in-process metrics registry with Prometheus text output. Label values must be low-cardinality. */
export class MetricsRegistry {
  private readonly counters = new Map<string, { name: string; labels: Labels; value: number }>();
  private readonly summaries = new Map<string, { name: string; labels: Labels; count: number; sum: number; max: number }>();

  increment(name: string, labels: Labels = {}, by = 1): void {
    const key = seriesKey(name, labels);
    const series = this.counters.get(key) ?? { name, labels, value: 0 };
    series.value += by;
    this.counters.set(key, series);
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const key = seriesKey(name, labels);
    const series = this.summaries.get(key) ?? { name, labels, count: 0, sum: 0, max: 0 };
    series.count += 1;
    series.sum += value;
    series.max = Math.max(series.max, value);
    this.summaries.set(key, series);
  }

  /** Current value of one counter series (0 if never incremented). */
  counter(name: string, labels: Labels = {}): number {
    return this.counters.get(seriesKey(name, labels))?.value ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    for (const { name, labels, value } of this.counters.values()) lines.push(`${name}${formatLabels(labels)} ${String(value)}`);
    for (const { name, labels, count, sum, max } of this.summaries.values()) {
      lines.push(`${name}_count${formatLabels(labels)} ${String(count)}`, `${name}_sum${formatLabels(labels)} ${String(sum)}`, `${name}_max${formatLabels(labels)} ${String(max)}`);
    }
    return `${lines.sort().join("\n")}\n`;
  }
}

const seriesKey = (name: string, labels: Labels) => `${name}|${Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join(",")}`;
const formatLabels = (labels: Labels) => {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? "" : `{${entries.map(([key, value]) => `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", " ")}"`).join(",")}}`;
};
