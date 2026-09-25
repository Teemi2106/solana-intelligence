import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, MetricsRegistry } from "./index.js";

describe("MetricsRegistry", () => {
  it("counts per label set and renders Prometheus text deterministically", () => {
    const metrics = new MetricsRegistry();
    metrics.increment("webhook_events_total", { result: "accepted" }, 2);
    metrics.increment("webhook_events_total", { result: "accepted" });
    metrics.increment("webhook_events_total", { result: "duplicate" });
    metrics.observe("job_duration_ms", 10, { job: "a" });
    metrics.observe("job_duration_ms", 30, { job: "a" });
    expect(metrics.counter("webhook_events_total", { result: "accepted" })).toBe(3);
    expect(metrics.counter("webhook_events_total", { result: "missing" })).toBe(0);
    expect(metrics.render()).toBe([
      'job_duration_ms_count{job="a"} 2', 'job_duration_ms_max{job="a"} 30', 'job_duration_ms_sum{job="a"} 40',
      'webhook_events_total{result="accepted"} 3', 'webhook_events_total{result="duplicate"} 1', "",
    ].join("\n"));
  });

  it("escapes label values so a hostile value cannot break the exposition format", () => {
    const metrics = new MetricsRegistry();
    metrics.increment("x_total", { reason: 'a"b\nc\\d' });
    expect(metrics.render()).toBe('x_total{reason="a\\"b c\\\\d"} 1\n');
  });
});

describe("logger redaction", () => {
  it("never emits secrets, credentials or authorization headers", () => {
    const chunks: string[] = [];
    const destination = new Writable({ write(chunk: Buffer, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
    const logger = createLogger({ service: "test", destination });
    logger.info({
      apiKey: "key-123", authHeader: "Bearer secret-456", webhookSecret: "secret-789", authorization: "Bearer top", HELIUS_API_KEY: "key-abc", HELIUS_WEBHOOK_SECRET: "secret-def",
      req: { headers: { authorization: "Bearer nested", cookie: "session=abc" } }, config: { apiKey: "nested-key", authHeader: "nested-auth" }, harmless: "visible",
    }, "event");
    const output = chunks.join("");
    for (const secret of ["key-123", "secret-456", "secret-789", "Bearer top", "key-abc", "secret-def", "Bearer nested", "session=abc", "nested-key", "nested-auth"]) expect(output).not.toContain(secret);
    expect(output).toContain("visible");
    expect(output).toContain("[REDACTED]");
  });
});
