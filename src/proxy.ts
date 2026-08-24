import { NextResponse, type NextRequest } from "next/server";
import { getDomainStore } from "./lib/studio/domains";

export async function proxy(request: NextRequest) {
  const hostHeader = request.headers.get("host") || "";
  const host = hostHeader.split(":")[0];
  const pathname = request.nextUrl.pathname;
  
  const platformHost = process.env.STUDIO_PLATFORM_HOST || "localhost";
  const isPlatformHost = 
    host === "localhost" || 
    host === "127.0.0.1" || 
    host === platformHost ||
    (process.env.NEXT_PUBLIC_STUDIO_PLATFORM_HOST && host === process.env.NEXT_PUBLIC_STUDIO_PLATFORM_HOST);
    
  const isProtectedPath = 
    pathname.startsWith("/api") || 
    pathname.startsWith("/studio") || 
    pathname.startsWith("/s/") || 
    pathname === "/s" || 
    pathname.startsWith("/pay") || 
    pathname.startsWith("/orders") || 
    pathname.startsWith("/_next");

  let rewriteUrl = null;
  if (!isPlatformHost && !isProtectedPath && request.method === "GET" && pathname === "/") {
    try {
      const domainStore = getDomainStore();
      const domain = await domainStore.getDomainByHostname(host);
      if (domain && domain.status === "active") {
        rewriteUrl = request.nextUrl.clone();
        rewriteUrl.pathname = `/s/${domain.draft_id}`;
      }
    } catch (err) {
      console.error("Proxy domain error:", err);
    }
  }

  const response = rewriteUrl ? NextResponse.rewrite(rewriteUrl) : NextResponse.next();

  if (!request.cookies.has("valmont_csrf")) {
    response.cookies.set(
      "valmont_csrf",
      crypto.randomUUID().replaceAll("-", ""),
      {
        httpOnly: false,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 60 * 60 * 8,
      },
    );
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
