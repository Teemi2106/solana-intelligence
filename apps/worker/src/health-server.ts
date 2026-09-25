import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Database } from "@swi/db";
import { checkDatabase } from "@swi/db";
import type { MetricsRegistry } from "@swi/observability";
import { checkRedis } from "@swi/queue";
import type { Redis } from "ioredis";

export function startHealthServer(dependencies: {
  database: Database;
  redis: Redis;
  queueRedis?: Redis;
  port: number;
  metrics?: MetricsRegistry;
}): Server {
  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.url === "/health/live") {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ status: "up" }));
      return;
    }
    if (request.url === "/health/ready") {
      const [database, redis, queueRedis] = await Promise.all([
        checkDatabase(dependencies.database),
        checkRedis(dependencies.redis),
        dependencies.queueRedis
          ? checkRedis(dependencies.queueRedis)
          : Promise.resolve(undefined),
      ]);
      const ready =
        database.status === "up" &&
        redis.status === "up" &&
        (!queueRedis || queueRedis.status === "up");
      response
        .writeHead(ready ? 200 : 503, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            status: ready ? "up" : "down",
            checks: { database, redis, ...(queueRedis ? { queueRedis } : {}) },
          }),
        );
      return;
    }
    if (request.url === "/metrics" && dependencies.metrics) {
      response
        .writeHead(200, { "content-type": "text/plain; version=0.0.4" })
        .end(dependencies.metrics.render());
      return;
    }
    response.writeHead(404).end();
  }
  return createServer(
    (request, response) => void handle(request, response),
  ).listen(dependencies.port, "0.0.0.0");
}
