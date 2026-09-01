import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { githubCredentialsConfigured } from "@/lib/config";
import { GitHubApiProvider } from "@/lib/github/github";
import type { GitHubProvider } from "@/lib/github/types";
import { decryptSessionValue } from "@/lib/security";
import { NotConnectedError } from "@/lib/api-errors";

export interface SessionUser {
  id: string;
  login: string;
  name: string;
  avatarUrl?: string;
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

export { NotConnectedError };

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

/** Returns the signed-in GitHub user, or null when nobody is connected. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await getGitHubSession();
  if (!session) return null;
  return {
    id: session.id,
    login: session.login,
    name: session.name,
    avatarUrl: session.avatarUrl,
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

/** Authorized GitHub client for the current session. Throws when not connected. */
export async function getGitHubProvider(): Promise<GitHubProvider> {
  const session = await getGitHubSession();
  if (!session) throw new NotConnectedError();
  return new GitHubApiProvider({ accessToken: session.accessToken });
}

/** Never throws; used by pages that render a "not connected" state themselves. */
export async function tryGetGitHubProvider(): Promise<GitHubProvider | null> {
  try {
    return await getGitHubProvider();
  } catch {
    return null;
  }
}
