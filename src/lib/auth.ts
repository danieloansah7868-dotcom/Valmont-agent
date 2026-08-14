import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { demoModeEnabled, githubCredentialsConfigured } from "@/lib/config";
import { DemoGitHubProvider } from "@/lib/github/demo";
import { GitHubApiProvider } from "@/lib/github/github";
import type { GitHubProvider } from "@/lib/github/types";
import { decryptSessionValue } from "@/lib/security";

export interface SessionUser {
  id: string;
  login: string;
  name: string;
  avatarUrl?: string;
  demo: boolean;
}

interface GitHubSessionPayload {
  accessToken: string;
  id: string;
  login: string;
  name: string;
  avatarUrl?: string;
  expiresAt: number;
}

export const NOT_CONNECTED_MESSAGE =
  "Connect GitHub to continue. Valmont runs against your real repositories.";

export class NotConnectedError extends Error {
  constructor(message = NOT_CONNECTED_MESSAGE) {
    super(message);
    this.name = "NotConnectedError";
  }
}

export function githubConfigured(): boolean {
  return githubCredentialsConfigured();
}

export async function getGitHubSession(): Promise<GitHubSessionPayload | null> {
  if (!githubConfigured()) return null;
  const envelope = (await cookies()).get("valmont_session")?.value;
  if (!envelope) return null;
  try {
    const payload = JSON.parse(
      decryptSessionValue(envelope),
    ) as GitHubSessionPayload;
    if (!payload.accessToken || payload.expiresAt < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

const DEMO_USER: SessionUser = {
  id: "demo-user",
  login: "demo-user",
  name: "Demo workspace",
  demo: true,
};

/**
 * Returns the signed-in GitHub user. In live mode (the default) an
 * unauthenticated visitor gets `null` instead of a fictional demo identity.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await getGitHubSession();
  if (!session) return demoModeEnabled() ? { ...DEMO_USER } : null;
  return {
    id: session.id,
    login: session.login,
    name: session.name,
    avatarUrl: session.avatarUrl,
    demo: false,
  };
}

/** Server-component helper: sends unauthenticated visitors back to the landing page. */
export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/?connect=required");
  return user;
}

/** Route-handler helper: throws a 401-mapped error instead of redirecting. */
export async function requireApiSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new NotConnectedError();
  return user;
}

export async function getGitHubProvider(): Promise<GitHubProvider> {
  const session = await getGitHubSession();
  if (session)
    return new GitHubApiProvider({ accessToken: session.accessToken });
  if (demoModeEnabled()) return new DemoGitHubProvider();
  throw new NotConnectedError();
}

/** Never throws; used by pages that render a "not connected" state themselves. */
export async function tryGetGitHubProvider(): Promise<GitHubProvider | null> {
  try {
    return await getGitHubProvider();
  } catch {
    return null;
  }
}
