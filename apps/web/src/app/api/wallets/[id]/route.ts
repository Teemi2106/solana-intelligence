import { z } from "zod";
import { setTrackedWalletStatus } from "@swi/db";
import { requireAdmin } from "../../../../lib/current-user";
import { getDatabase } from "../../../../lib/database";
import { requestSubscriptionReconcile } from "../../../../lib/live";
import { getServerConfig } from "../../../../lib/server-config";

const updateSchema = z.object({ status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]) });

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await requireAdmin();
  if (request.headers.get("origin") !== getServerConfig().APP_URL.origin) return Response.json({ error: "invalid origin" }, { status: 403 });
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid status" }, { status: 400 });
  const { id } = await context.params;
  const wallet = await setTrackedWalletStatus(getDatabase(), { walletId: id, status: parsed.data.status, actorId: user.subject, requestId: request.headers.get("x-request-id") ?? crypto.randomUUID() });
  if (wallet) await requestSubscriptionReconcile("wallet-status-changed");
  return wallet ? Response.json(wallet) : Response.json({ error: "not found" }, { status: 404 });
}
