import { NextResponse, type NextRequest } from "next/server";
import { githubConfigured } from "@/lib/auth";
import { decryptSessionValue, encryptSessionValue } from "@/lib/security";

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url?: string;
}

export async function GET(request: NextRequest) {
  const errorRedirect = new URL("/?auth_error=github", request.url);
  if (!githubConfigured()) return NextResponse.redirect(errorRedirect);
  const state = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  const stateCookie = request.cookies.get("valmont_oauth_state")?.value;
  if (!state || !code || !stateCookie)
    return NextResponse.redirect(errorRedirect);
  try {
    if (decryptSessionValue(stateCookie) !== state)
      return NextResponse.redirect(errorRedirect);
    const tokenResponse = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          code,
          state,
        }),
        cache: "no-store",
      },
    );
    const tokenData = (await tokenResponse.json()) as {
      access_token?: string;
      error?: string;
    };
    if (!tokenResponse.ok || !tokenData.access_token)
      return NextResponse.redirect(errorRedirect);
    const userResponse = await fetch("https://api.github.com/user", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${tokenData.access_token}`,
        "x-github-api-version": "2022-11-28",
      },
      cache: "no-store",
    });
    if (!userResponse.ok) return NextResponse.redirect(errorRedirect);
    const user = (await userResponse.json()) as GitHubUser;
    const payload = encryptSessionValue(
      JSON.stringify({
        accessToken: tokenData.access_token,
        id: String(user.id),
        login: user.login,
        name: user.name ?? user.login,
        avatarUrl: user.avatar_url,
        expiresAt: Date.now() + 8 * 60 * 60 * 1_000,
      }),
    );
    const response = NextResponse.redirect(new URL("/dashboard", request.url));
    response.cookies.delete("valmont_oauth_state");
    response.cookies.set("valmont_session", payload, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 8 * 60 * 60,
    });
    return response;
  } catch {
    return NextResponse.redirect(errorRedirect);
  }
}
