import { jwtVerify, SignJWT } from "jose";

export const sessionCookieName = "swi_session";
const issuer = "solana-intelligence";
const audience = "private-dashboard";

function key(): Uint8Array {
  const secret = process.env["AUTH_SECRET"];
  if (!secret || secret.length < 43) throw new Error("AUTH_SECRET is missing or too short");
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(subject: string): Promise<string> {
  return new SignJWT({ role: "admin" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(key());
}

export async function verifySessionToken(token: string | undefined): Promise<{ subject: string } | null> {
  if (!token) return null;
  try {
    const verified = await jwtVerify(token, key(), { algorithms: ["HS256"], issuer, audience });
    return verified.payload.sub ? { subject: verified.payload.sub } : null;
  } catch {
    return null;
  }
}
