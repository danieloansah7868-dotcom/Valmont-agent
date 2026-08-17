import { createHash } from "node:crypto";
import type { SessionUser } from "@/lib/auth";
import { getDatabase } from "@/db";
import { users } from "@/db/schema";

export function canonicalUserId(session: SessionUser): string {
  return deterministicUuid(`github:${session.id}`);
}

export async function ensureStudioUser(session: SessionUser): Promise<string> {
  const id = canonicalUserId(session);
  if (!process.env.DATABASE_URL) return id;
  const db = getDatabase();
  await db
    .insert(users)
    .values({
      id,
      githubId: session.id,
      name: session.name,
      avatarUrl: session.avatarUrl,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        name: session.name,
        avatarUrl: session.avatarUrl,
        updatedAt: new Date(),
      },
    });
  return id;
}

export function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
