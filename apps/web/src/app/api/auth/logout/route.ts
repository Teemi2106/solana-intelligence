import { cookies } from "next/headers";
import { sessionCookieName } from "../../../../lib/session";
import { getServerConfig } from "../../../../lib/server-config";

export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("origin") !== getServerConfig().APP_URL.origin) return Response.json({ error: "invalid origin" }, { status: 403 });
  (await cookies()).delete(sessionCookieName);
  return Response.json({ ok: true });
}
