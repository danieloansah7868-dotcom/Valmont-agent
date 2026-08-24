import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { githubConfigured } from "@/lib/auth";
import { authOrigin } from "@/lib/auth-redirect";
import { encryptSessionValue } from "@/lib/security";

export async function GET(request: NextRequest) {
  let origin: URL;
  try {
    origin = authOrigin(request.url);
  } catch {
    return NextResponse.json(
      { error: "APP_URL must be an absolute HTTP or HTTPS origin" },
      { status: 500 },
    );
  }

  if (!githubConfigured()) {
    return NextResponse.redirect(
      new URL("/agent?connect=unconfigured", origin),
    );
  }
  const state = randomBytes(24).toString("base64url");
  const callback = new URL("/api/auth/github/callback", origin);
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID!);
  authorize.searchParams.set("redirect_uri", callback.toString());
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
