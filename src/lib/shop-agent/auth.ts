import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { NextRequest, NextResponse } from "next/server";
import { NotFoundError, ShopAgentNotSignedInError } from "@/lib/api-errors";
import { publicOrigin } from "@/lib/auth-redirect";
import { getShopAgentStore, type ShopAgentSession } from "./store";

export const SHOP_AGENT_SESSION_COOKIE = "valmont_shop_agent_session";
const SHOP_AGENT_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const secureCookie = process.env.NODE_ENV === "production";

export function setShopAgentSessionCookie(
  response: NextResponse,
  token: string,
): void {
  response.cookies.set({
    name: SHOP_AGENT_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: secureCookie,
    sameSite: "lax",
    path: "/",
    maxAge: SHOP_AGENT_SESSION_MAX_AGE_SECONDS,
  });
}

export function clearShopAgentSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: SHOP_AGENT_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: secureCookie,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export function safeAgentReturnPath(draftId: string, value: unknown): string {
  const home = `/a/${encodeURIComponent(draftId)}`;
  if (typeof value !== "string") return home;
  const path = value.trim();
  if (!path.startsWith(`${home}/`) && path !== home) return home;
  if (path.startsWith("//") || path.includes("\\")) return home;
  return path;
}

async function sessionFromToken(
  token: string | undefined,
  draftId: string,
): Promise<ShopAgentSession | null> {
  if (!token) return null;
  const session = await getShopAgentStore().getSession(token);
  if (!session || session.agent.draftId !== draftId) return null;
  return session;
}

export async function getShopAgentSession(
  draftId: string,
): Promise<ShopAgentSession | null> {
  const token = (await cookies()).get(SHOP_AGENT_SESSION_COOKIE)?.value;
  return sessionFromToken(token, draftId);
}

export async function requireShopAgentSession(
  draftId: string,
  next?: string,
): Promise<ShopAgentSession> {
  const session = await getShopAgentSession(draftId);
  if (!session) {
    const base = `/a/${encodeURIComponent(draftId)}/login`;
    const target = next ? safeAgentReturnPath(draftId, next) : null;
    redirect(target ? `${base}?next=${encodeURIComponent(target)}` : base);
  }
  return session;
}

export async function requireShopAgentApi(
  request: NextRequest,
  draftId: string,
): Promise<ShopAgentSession> {
  const token = request.cookies.get(SHOP_AGENT_SESSION_COOKIE)?.value;
  if (!token) throw new ShopAgentNotSignedInError();
  const session = await getShopAgentStore().getSession(token);
  if (!session) throw new ShopAgentNotSignedInError();
  if (session.agent.draftId !== draftId) throw new NotFoundError();
  return session;
}

export function agentInviteLink(
  requestUrl: string | URL,
  draftId: string,
  token: string,
): string {
  return `${publicOrigin(requestUrl)}/a/${encodeURIComponent(draftId)}/accept-invite?token=${encodeURIComponent(token)}`;
}

export function agentResetLink(
  requestUrl: string | URL,
  draftId: string,
  token: string,
): string {
  return `${publicOrigin(requestUrl)}/a/${encodeURIComponent(draftId)}/reset-password?token=${encodeURIComponent(token)}`;
}
