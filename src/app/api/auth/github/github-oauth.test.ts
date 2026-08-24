import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as beginGitHubOAuth } from "@/app/api/auth/github/route";
import { GET as completeGitHubOAuth } from "@/app/api/auth/github/callback/route";
import { authOrigin, InvalidAuthOriginError } from "@/lib/auth-redirect";
import { decryptSessionValue, encryptSessionValue } from "@/lib/security";

const sessionSecret = "test-session-secret-with-at-least-32-bytes";

function configureGitHub(appUrl: string | null = "http://localhost:3000") {
  vi.stubEnv("GITHUB_CLIENT_ID", "test-client-id");
  vi.stubEnv("GITHUB_CLIENT_SECRET", "test-client-secret");
  vi.stubEnv("SESSION_SECRET", sessionSecret);
  if (appUrl === null) {
    vi.stubEnv("APP_URL", "__test_absent__");
    delete process.env.APP_URL;
  } else vi.stubEnv("APP_URL", appUrl);
}

function stateCookie(state: string): string {
  return `valmont_oauth_state=${encryptSessionValue(state, sessionSecret)}`;
}

function successfulGitHubFetch() {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "github-secret-token" }), {
        status: 200,
      }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: 42,
          login: "octocat",
          name: "Octo Cat",
          avatar_url: "https://avatars.example/octocat",
        }),
        { status: 200 },
      ),
    );
}

describe("GitHub OAuth canonical redirects", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("redirects successful OAuth completion to configured localhost", async () => {
    configureGitHub();
    const fetchMock = successfulGitHubFetch();
    vi.stubGlobal("fetch", fetchMock);
    const state = "valid-state";
    const request = new NextRequest(
      `http://0.0.0.0:3000/api/auth/github/callback?code=test-code&state=${state}`,
      { headers: { cookie: stateCookie(state), host: "attacker.example" } },
    );

    const response = await completeGitHubOAuth(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/dashboard",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses configured localhost for authentication-error redirects", async () => {
    configureGitHub();
    const request = new NextRequest(
      "http://0.0.0.0:3000/api/auth/github/callback?state=missing-code",
      {
        headers: { host: "attacker.example", "x-forwarded-host": "evil.test" },
      },
    );

    const response = await completeGitHubOAuth(request);

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/agent?auth_error=github",
    );
  });

  it("uses configured localhost for the initial GitHub redirect_uri", async () => {
    configureGitHub();

    const response = await beginGitHubOAuth(
      new NextRequest("http://0.0.0.0:3000/api/auth/github"),
    );
    const authorize = new URL(response.headers.get("location")!);

    expect(authorize.origin).toBe("https://github.com");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/auth/github/callback",
    );
    expect(authorize.searchParams.get("scope")).toBe(
      "read:user user:email repo",
    );
  });

  it("uses the canonical origin for the unconfigured-auth redirect", async () => {
    vi.stubEnv("APP_URL", "http://localhost:3000/");
    vi.stubEnv("GITHUB_CLIENT_ID", undefined);
    vi.stubEnv("GITHUB_CLIENT_SECRET", undefined);
    vi.stubEnv("SESSION_SECRET", undefined);

    const response = await beginGitHubOAuth(
      new NextRequest("http://0.0.0.0:3000/api/auth/github"),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/agent?connect=unconfigured",
    );
  });

  it("preserves a configured production HTTPS origin", async () => {
    configureGitHub("https://example.com");

    const initial = await beginGitHubOAuth(
      new NextRequest("http://0.0.0.0:3000/api/auth/github"),
    );
    const authorize = new URL(initial.headers.get("location")!);
    const error = await completeGitHubOAuth(
      new NextRequest("http://0.0.0.0:3000/api/auth/github/callback"),
    );

    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "https://example.com/api/auth/github/callback",
    );
    expect(error.headers.get("location")).toBe(
      "https://example.com/agent?auth_error=github",
    );
  });

  it.each([
    "//evil.example",
    "javascript:alert(1)",
    "https://user:password@example.com",
    "https://example.com/unexpected/path",
    "https://example.com?next=https://evil.example",
    "https://example.com/#fragment",
  ])("fails closed for malformed APP_URL %s", async (appUrl) => {
    configureGitHub(appUrl);

    expect(() => authOrigin("http://safe.example", appUrl)).toThrow(
      InvalidAuthOriginError,
    );
    const response = await beginGitHubOAuth(
      new NextRequest("http://attacker.example/api/auth/github"),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("location")).toBeNull();
  });

  it("falls back to the request origin only when APP_URL is absent", async () => {
    configureGitHub(null);
    expect(process.env.APP_URL).toBeUndefined();

    const initial = await beginGitHubOAuth(
      new NextRequest("http://dev.internal:4123/api/auth/github"),
    );
    expect(initial.status, await initial.clone().text()).toBe(307);
    const authorize = new URL(initial.headers.get("location")!);
    const error = await completeGitHubOAuth(
      new NextRequest("http://dev.internal:4123/api/auth/github/callback"),
    );

    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "http://dev.internal:4123/api/auth/github/callback",
    );
    expect(error.headers.get("location")).toBe(
      "http://dev.internal:4123/agent?auth_error=github",
    );
  });

  it("preserves OAuth state validation and protected session cookies", async () => {
    configureGitHub();
    vi.stubEnv("NODE_ENV", "production");
    const initial = await beginGitHubOAuth(
      new NextRequest("http://0.0.0.0:3000/api/auth/github"),
    );
    const authorize = new URL(initial.headers.get("location")!);
    const state = authorize.searchParams.get("state")!;
    const oauthCookie = initial.cookies.get("valmont_oauth_state")!;

    expect(state).toHaveLength(32);
    expect(oauthCookie.value).not.toContain(state);
    expect(decryptSessionValue(oauthCookie.value, sessionSecret)).toBe(state);
    expect(oauthCookie.httpOnly).toBe(true);
    expect(oauthCookie.secure).toBe(true);
    expect(oauthCookie.sameSite).toBe("lax");
    expect(oauthCookie.path).toBe("/api/auth/github/callback");
    expect(oauthCookie.maxAge).toBe(600);

    const fetchMock = successfulGitHubFetch();
    vi.stubGlobal("fetch", fetchMock);
    const invalidState = await completeGitHubOAuth(
      new NextRequest(
        "http://0.0.0.0:3000/api/auth/github/callback?code=test-code&state=wrong-state",
        { headers: { cookie: `valmont_oauth_state=${oauthCookie.value}` } },
      ),
    );
    expect(invalidState.headers.get("location")).toBe(
      "http://localhost:3000/agent?auth_error=github",
    );
    expect(fetchMock).not.toHaveBeenCalled();

    const completed = await completeGitHubOAuth(
      new NextRequest(
        `http://0.0.0.0:3000/api/auth/github/callback?code=test-code&state=${state}`,
        { headers: { cookie: `valmont_oauth_state=${oauthCookie.value}` } },
      ),
    );
    const sessionCookie = completed.cookies.get("valmont_session")!;
    const session = JSON.parse(
      decryptSessionValue(sessionCookie.value, sessionSecret),
    ) as { accessToken: string; expiresAt: number };

    expect(session.accessToken).toBe("github-secret-token");
    expect(sessionCookie.value).not.toContain("github-secret-token");
    expect(sessionCookie.httpOnly).toBe(true);
    expect(sessionCookie.secure).toBe(true);
    expect(sessionCookie.sameSite).toBe("lax");
    expect(sessionCookie.path).toBe("/");
    expect(sessionCookie.maxAge).toBe(8 * 60 * 60);
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    expect(completed.headers.get("location")).not.toContain(
      "github-secret-token",
    );
  });
});
