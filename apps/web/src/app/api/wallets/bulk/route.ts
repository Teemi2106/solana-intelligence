import { z } from "zod";
import { setTrackedWalletStatuses } from "@swi/db";
import { requireAdmin } from "../../../../lib/current-user";
import { getDatabase } from "../../../../lib/database";
import { requestSubscriptionReconcile } from "../../../../lib/live";
import { getServerConfig } from "../../../../lib/server-config";

const bulkSchema = z.object({
  walletIds: z.array(z.string().uuid()).min(1).max(500),
  status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]),
});

export async function PATCH(request: Request): Promise<Response> {
  const user = await requireAdmin();
  if (request.headers.get("origin") !== getServerConfig().APP_URL.origin) return Response.json({ error: "invalid origin" }, { status: 403 });
  const parsed = bulkSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid bulk update", issues: parsed.error.issues }, { status: 400 });
  const wallets = await setTrackedWalletStatuses(getDatabase(), { walletIds: [...new Set(parsed.data.walletIds)], status: parsed.data.status, actorId: user.subject, requestId: request.headers.get("x-request-id") ?? crypto.randomUUID() });
  await requestSubscriptionReconcile("wallets-bulk-status-changed");
  return Response.json({ updated: wallets.length });
}
