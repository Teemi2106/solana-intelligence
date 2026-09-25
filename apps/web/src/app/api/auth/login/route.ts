import { verify } from "@node-rs/argon2";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createRedisConnection } from "@swi/queue";
import { createSessionToken, sessionCookieName } from "../../../../lib/session";
import { getServerConfig } from "../../../../lib/server-config";

const credentialsSchema = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(1_024) });

export async function POST(request: Request): Promise<Response> {
  const config = getServerConfig();
  if (request.headers.get("origin") !== config.APP_URL.origin) return Response.json({ error: "invalid origin" }, { status: 403 });

  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const redis = createRedisConnection(config.REDIS_URL);
  try {
    const key = `auth-rate:${forwardedFor}`;
    const attempts = await redis.incr(key);
    if (attempts === 1) await redis.expire(key, 15 * 60);
    if (attempts > 10) return Response.json({ error: "too many attempts" }, { status: 429 });

    const parsed = credentialsSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "invalid credentials" }, { status: 401 });
    const usernameMatches = parsed.data.username === config.ADMIN_USERNAME;
    const passwordMatches = await verify(config.ADMIN_PASSWORD_HASH, parsed.data.password);
    if (!usernameMatches || !passwordMatches) return Response.json({ error: "invalid credentials" }, { status: 401 });

    await redis.del(key);
    const token = await createSessionToken(config.ADMIN_USERNAME);
    (await cookies()).set(sessionCookieName, token, {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 8 * 60 * 60,
    });
    return NextResponse.json({ ok: true });
  } finally {
    await redis.quit();
  }
}
