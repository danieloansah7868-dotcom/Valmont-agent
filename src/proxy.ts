import { NextResponse, type NextRequest } from "next/server";
import { getDomainStore, type DomainRow } from "./lib/studio/domains";
import { checkDomain, needsRecheck } from "./lib/studio/domain-verification";

/**
 * Hostnames whose re-verification is currently in flight, so a burst of
 * requests on a stale domain triggers one DNS check rather than one per hit.
 */
const rechecking = new Set<string>();

/**
 * Re-verifies an active custom domain in the background once its last check
 * is older than the re-check interval. The request being served is never
 * delayed or affected; a domain whose ownership proof or CNAME has since been
 * removed simply stops being served on the NEXT request after the check
 * lands. This is what keeps a domain from remaining attached to a draft
 * after its owner has moved it elsewhere.
 */
function scheduleRecheck(domain: DomainRow): void {
  if (!needsRecheck(domain.last_checked_at)) return;
  if (!domain.verification_token) return;
  if (rechecking.has(domain.hostname)) return;
  rechecking.add(domain.hostname);
  void (async () => {
    try {
      const result = await checkDomain({
        hostname: domain.hostname,
        token: domain.verification_token!,
        platformHost: process.env.STUDIO_PLATFORM_HOST,
      });
      const now = new Date().toISOString();
      await getDomainStore().updateStatus(domain.draft_id, result.status, {
        lastCheckedAt: now,
        ...(result.ownershipProven ? {} : { verifiedAt: null }),
      });
    } catch (err) {
      console.error("Domain re-verification error:", err);
    } finally {
      rechecking.delete(domain.hostname);
    }
  })();
}

export async function proxy(request: NextRequest) {
  const hostHeader = request.headers.get("host") || "";
  const host = hostHeader.split(":")[0];
  const pathname = request.nextUrl.pathname;

  const platformHost = process.env.STUDIO_PLATFORM_HOST || "localhost";
  const isPlatformHost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === platformHost ||
    (process.env.NEXT_PUBLIC_STUDIO_PLATFORM_HOST &&
      host === process.env.NEXT_PUBLIC_STUDIO_PLATFORM_HOST);

  const isProtectedPath =
    pathname.startsWith("/api") ||
    pathname.startsWith("/studio") ||
    pathname.startsWith("/s/") ||
    pathname === "/s" ||
    pathname.startsWith("/pay") ||
    pathname.startsWith("/orders") ||
    pathname.startsWith("/_next");

  let rewriteUrl = null;
  if (
    !isPlatformHost &&
    !isProtectedPath &&
    request.method === "GET" &&
    pathname === "/"
  ) {
    try {
      const domainStore = getDomainStore();
      const domain = await domainStore.getDomainByHostname(host);
      if (domain && domain.status === "active") {
        rewriteUrl = request.nextUrl.clone();
        rewriteUrl.pathname = `/s/${domain.draft_id}`;
        scheduleRecheck(domain);
      }
    } catch (err) {
      console.error("Proxy domain error:", err);
    }
  }

  const response = rewriteUrl
    ? NextResponse.rewrite(rewriteUrl)
    : NextResponse.next();

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
