import { cookies } from "next/headers";
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

export function githubConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_CLIENT_ID &&
    process.env.GITHUB_CLIENT_SECRET &&
    process.env.SESSION_SECRET,
  );
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

export async function getSessionUser(): Promise<SessionUser> {
  const session = await getGitHubSession();
  if (!session) {
    return {
      id: "demo-user",
      login: "demo-user",
      name: "Demo workspace",
      demo: true,
    };
  }
  return {
    id: session.id,
    login: session.login,
    name: session.name,
    avatarUrl: session.avatarUrl,
    demo: false,
  };
}

export async function getGitHubProvider(): Promise<GitHubProvider> {
  const session = await getGitHubSession();
  return session
    ? new GitHubApiProvider({ accessToken: session.accessToken })
    : new DemoGitHubProvider();
}
