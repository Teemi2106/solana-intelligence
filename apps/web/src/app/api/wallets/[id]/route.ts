import { z } from "zod";
import { setTrackedWalletStatus, updateTrackedWallet } from "@swi/db";
import { requireAdmin } from "../../../../lib/current-user";
import { getDatabase } from "../../../../lib/database";
import { requestSubscriptionReconcile } from "../../../../lib/live";
import { getServerConfig } from "../../../../lib/server-config";

const updateSchema = z.union([
  z.object({ status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]) }),
  z.object({ displayName: z.string().trim().min(1).max(100).nullable(), labels: z.array(z.string().trim().min(1).max(50)).max(20) }),
]);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await requireAdmin();
  if (request.headers.get("origin") !== getServerConfig().APP_URL.origin) return Response.json({ error: "invalid origin" }, { status: 403 });
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "invalid wallet update", issues: parsed.error.issues }, { status: 400 });
  const { id } = await context.params;
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const wallet = "status" in parsed.data
    ? await setTrackedWalletStatus(getDatabase(), { walletId: id, status: parsed.data.status, actorId: user.subject, requestId })
    : await updateTrackedWallet(getDatabase(), { walletId: id, displayName: parsed.data.displayName, labels: [...new Set(parsed.data.labels)], actorId: user.subject, requestId });
  if (wallet && "status" in parsed.data) await requestSubscriptionReconcile("wallet-status-changed");
  return wallet ? Response.json(wallet) : Response.json({ error: "not found" }, { status: 404 });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await requireAdmin();
  if (request.headers.get("origin") !== getServerConfig().APP_URL.origin) return Response.json({ error: "invalid origin" }, { status: 403 });
  const { id } = await context.params;
  const wallet = await setTrackedWalletStatus(getDatabase(), { walletId: id, status: "ARCHIVED", actorId: user.subject, requestId: request.headers.get("x-request-id") ?? crypto.randomUUID() });
  if (wallet) await requestSubscriptionReconcile("wallet-archived");
  return wallet ? Response.json(wallet) : Response.json({ error: "not found" }, { status: 404 });
}
