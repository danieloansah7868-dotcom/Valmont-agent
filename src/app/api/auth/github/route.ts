import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { githubConfigured } from "@/lib/auth";
import { encryptSessionValue } from "@/lib/security";

export async function GET(request: NextRequest) {
  if (!githubConfigured())
    return NextResponse.redirect(new URL("/dashboard?mode=demo", request.url));
  const state = randomBytes(24).toString("base64url");
  const callback = `${process.env.APP_URL ?? request.nextUrl.origin}/api/auth/github/callback`;
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID!);
  authorize.searchParams.set("redirect_uri", callback);
  authorize.searchParams.set("scope", "read:user user:email repo");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("allow_signup", "true");
  const response = NextResponse.redirect(authorize);
  response.cookies.set("valmont_oauth_state", encryptSessionValue(state), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/auth/github/callback",
    maxAge: 600,
  });
  return response;
}
