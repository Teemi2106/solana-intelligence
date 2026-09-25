import { requireAdmin } from "../../../../lib/current-user";
import { getSystemStatus } from "../../../../lib/system-status";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  await requireAdmin();
  return Response.json(await getSystemStatus(), { headers: { "cache-control": "no-store" } });
}
