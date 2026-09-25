import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sessionCookieName, verifySessionToken } from "./session";

export async function requireAdmin(): Promise<{ subject: string }> {
  const token = (await cookies()).get(sessionCookieName)?.value;
  const session = await verifySessionToken(token);
  if (!session) redirect("/login");
  return session;
}
