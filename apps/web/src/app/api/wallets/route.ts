import { z } from "zod";
import {
  createTrackedWallet,
  listTrackedWallets,
  startWalletIngestion,
} from "@swi/db";
import { createQueues, createRedisConnection } from "@swi/queue";
import { solanaAddressSchema } from "@swi/validation";
import { requireAdmin } from "../../../lib/current-user";
import { getDatabase } from "../../../lib/database";
import { requestSubscriptionReconcile } from "../../../lib/live";
import { getServerConfig } from "../../../lib/server-config";

const createWalletSchema = z.object({
  address: solanaAddressSchema,
  displayName: z.string().trim().min(1).max(100).optional(),
  labels: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
});

export async function GET(): Promise<Response> {
  await requireAdmin();
  return Response.json(await listTrackedWallets(getDatabase()));
}

export async function POST(request: Request): Promise<Response> {
  const user = await requireAdmin();
  if (request.headers.get("origin") !== getServerConfig().APP_URL.origin)
    return Response.json({ error: "invalid origin" }, { status: 403 });
  const parsed = createWalletSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return Response.json(
      { error: "invalid wallet", issues: parsed.error.issues },
      { status: 400 },
    );
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const wallet = await createTrackedWallet(getDatabase(), {
    address: parsed.data.address,
    labels: parsed.data.labels,
    ...(parsed.data.displayName
      ? { displayName: parsed.data.displayName }
      : {}),
    actorId: user.subject,
    requestId,
  });
  const run = await startWalletIngestion(
    getDatabase(),
    wallet.id,
    `initial:${wallet.id}`,
  );
  if (run) {
    const redis = createRedisConnection(getServerConfig().REDIS_URL, "bullmq");
    const queues = createQueues(redis);
    try {
      await queues.analysis.add(
        "wallet-history",
        { walletId: wallet.id, runId: run.id, correlationId: requestId },
        { jobId: `wallet-history-${run.id}` },
      );
    } finally {
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
      await redis.quit();
    }
  }
  await requestSubscriptionReconcile("wallet-created");
  return Response.json({ wallet, ingestion: run }, { status: 201 });
}
