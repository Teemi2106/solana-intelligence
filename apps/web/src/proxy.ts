import { NextResponse, type NextRequest } from "next/server";
import { sessionCookieName, verifySessionToken } from "./lib/session";

export async function proxy(request: NextRequest) {
  const session = await verifySessionToken(request.cookies.get(sessionCookieName)?.value);
  if (session) return NextResponse.next();
  const login = new URL("/login", request.url);
  login.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = { matcher: ["/dashboard/:path*", "/wallets/:path*", "/signals/:path*", "/tokens/:path*", "/research/:path*", "/system/:path*"] };
