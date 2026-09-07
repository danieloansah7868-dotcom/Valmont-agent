import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest, NextResponse } from "next/server";
import { ShopAdminNotSignedInError, NotFoundError } from "@/lib/api-errors";
import { publicOrigin } from "@/lib/auth-redirect";
import { getShopAdminStore, type ShopAdminSession } from "./store";

/**
 * Stage 6b shop-admin session plumbing.
 *
 * This is the admin side's *only* notion of "who is signed in". It never
 * touches `@/lib/auth` (the agency's GitHub session) or `customer-auth` (the
 * buyer's account): a shop owner is signed in to exactly one shop, by a
 * cookie whose hash lives in `studio_shop_admin_sessions`, and nothing else.
 */

export const SHOP_SESSION_COOKIE = "valmont_shop_session";

const SHOP_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const secureCookie = process.env.NODE_ENV === "production";

export function setShopSessionCookie(
  response: NextResponse,
  token: string,
): void {
  response.cookies.set({
    name: SHOP_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: secureCookie,
    sameSite: "lax",
    path: "/",
    maxAge: SHOP_SESSION_MAX_AGE_SECONDS,
  });
}

export function clearShopSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: SHOP_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: secureCookie,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/**
 * Only same-site paths under this shop's own `/manage/[id]/` prefix are
 * honoured as a post-login destination. Anything else — another shop, another
 * part of Valmont, a protocol-relative URL — falls back to the shop's home.
 */
export function safeShopReturnPath(draftId: string, value: unknown): string {
  const home = `/manage/${encodeURIComponent(draftId)}`;
  if (typeof value !== "string") return home;
  const path = value.trim();
  if (!path.startsWith(`${home}/`) && path !== home) return home;
  if (path.startsWith("//") || path.includes("\\")) return home;
  return path;
}

/**
 * Reads the session for *this* shop from the cookie. A cookie minted for
 * another shop is not "a session for the wrong shop" — from the point of view
 * of `/manage/[id]` it is simply no session, so the caller sees null.
 */
async function sessionFromToken(
  token: string | undefined,
  draftId: string,
): Promise<ShopAdminSession | null> {
  if (!token) return null;
  const session = await getShopAdminStore().getSession(token);
  if (!session || session.admin.draftId !== draftId) return null;
  return session;
}

/** Server-component helper: the session, or null. */
export async function getShopAdminSession(
  draftId: string,
): Promise<ShopAdminSession | null> {
  const token = (await cookies()).get(SHOP_SESSION_COOKIE)?.value;
  return sessionFromToken(token, draftId);
}

/**
 * Server-component helper: redirects to this shop's login page (remembering
 * where the person was going) when nobody is signed in to this shop.
 */
export async function requireShopAdminSession(
  draftId: string,
  next?: string,
): Promise<ShopAdminSession> {
  const session = await getShopAdminSession(draftId);
  if (!session) {
    const base = `/manage/${encodeURIComponent(draftId)}/login`;
    const target = next ? safeShopReturnPath(draftId, next) : null;
    redirect(target ? `${base}?next=${encodeURIComponent(target)}` : base);
  }
  return session;
}

/**
 * Route-handler helper. No cookie or an expired/disabled session → 401. A
 * valid session that belongs to a *different* shop → 404, exactly what an
 * outsider gets for a shop id they have no business knowing exists.
 */
export async function requireShopAdminApi(
  request: NextRequest,
  draftId: string,
): Promise<ShopAdminSession> {
  const token = request.cookies.get(SHOP_SESSION_COOKIE)?.value;
  if (!token) throw new ShopAdminNotSignedInError();
  const session = await getShopAdminStore().getSession(token);
  if (!session) throw new ShopAdminNotSignedInError();
  if (session.admin.draftId !== draftId) throw new NotFoundError();
  return session;
}

/** `${APP_URL}/manage/${draftId}/accept-invite?token=…` */
export function shopInviteLink(
  requestUrl: string | URL,
  draftId: string,
  token: string,
): string {
  return `${publicOrigin(requestUrl)}/manage/${encodeURIComponent(draftId)}/accept-invite?token=${encodeURIComponent(token)}`;
}

/** `${APP_URL}/manage/${draftId}/reset-password?token=…` */
export function shopResetLink(
  requestUrl: string | URL,
  draftId: string,
  token: string,
): string {
  return `${publicOrigin(requestUrl)}/manage/${encodeURIComponent(draftId)}/reset-password?token=${encodeURIComponent(token)}`;
}
