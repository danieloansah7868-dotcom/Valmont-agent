import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import {
  getCustomerAccountStore,
  type CustomerAccount,
  type CustomerSession,
} from "@/lib/customer-account-store";

export const CUSTOMER_SESSION_COOKIE = "valmont_customer_session";

export class CustomerNotConnectedError extends Error {
  readonly status = 401;

  constructor(message = "Please sign in to continue.") {
    super(message);
    this.name = "CustomerNotConnectedError";
  }
}

export function safeCustomerReturnPath(value: unknown, fallback = "/account") {
  if (typeof value !== "string") return fallback;
  const path = value.trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    return fallback;
  }
  return path;
}

export async function getCustomerSession(): Promise<CustomerSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(CUSTOMER_SESSION_COOKIE)?.value;
  if (!token) return null;
  return getCustomerAccountStore().getSession(token);
}

export async function requireCustomerSession(): Promise<CustomerSession> {
  const session = await getCustomerSession();
  if (!session) throw new CustomerNotConnectedError();
  return session;
}

export async function getCustomerAccount(): Promise<CustomerAccount | null> {
  return (await getCustomerSession())?.account ?? null;
}

const secureCookie = process.env.NODE_ENV === "production";

export function setCustomerSessionCookie(
  response: NextResponse,
  token: string,
): void {
  response.cookies.set({
    name: CUSTOMER_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: secureCookie,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
}

export function clearCustomerSessionCookie(response: NextResponse): void {
  response.cookies.set({
    name: CUSTOMER_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: secureCookie,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
