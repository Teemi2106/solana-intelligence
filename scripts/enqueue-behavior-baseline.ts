import process from "node:process";
import { parseConfig } from "@swi/config";
import { createQueues, createRedisConnection, enqueueBehaviorBaselineBuild } from "@swi/queue";

const walletId = process.argv[2];
if (!walletId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(walletId)) throw new Error("Usage: npm run behavior:baseline -- <wallet-uuid>");
const config = parseConfig(process.env);
const redis = createRedisConnection(config.REDIS_URL, "bullmq");
const queues = createQueues(redis);
try {
  await enqueueBehaviorBaselineBuild(queues, walletId);
  process.stdout.write(`Behavior baseline build queued for wallet ${walletId}.\n`);
} finally {
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
  redis.disconnect(false);
}
