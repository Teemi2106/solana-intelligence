import { checkDatabase } from "@swi/db";
import { checkRedis, createRedisConnection } from "@swi/queue";
import { getDatabase } from "../../../../lib/database";
import { getServerConfig } from "../../../../lib/server-config";

export async function GET(): Promise<Response> {
  const redis = createRedisConnection(getServerConfig().REDIS_URL);
  try {
    const [database, cache] = await Promise.all([checkDatabase(getDatabase()), checkRedis(redis)]);
    const ready = database.status === "up" && cache.status === "up";
    return Response.json({ status: ready ? "up" : "down", checks: { database, redis: cache } }, { status: ready ? 200 : 503 });
  } finally {
    await redis.quit();
  }
}
