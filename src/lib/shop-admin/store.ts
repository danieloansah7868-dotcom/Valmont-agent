import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { and, asc, eq, gt, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  studioShopAdminSessions,
  studioShopAdminTokens,
  studioShopAdmins,
} from "@/db/schema";
import { getSqliteChatStore } from "@/lib/chat-store";
import {
  createCustomerToken,
  DUMMY_CUSTOMER_PASSWORD_HASH,
  hashCustomerPassword,
  hashCustomerToken,
  normalizeCustomerEmail,
  verifyCustomerPassword,
} from "@/lib/customer-password";
import {
  ShopAdminExistsError,
  ShopLoginCapError,
  ShopOwnerExistsError,
} from "@/lib/api-errors";
import {
  MAX_SHOP_LOGINS_PER_WEBSITE,
  parsePermissions,
  serializePermissions,
  type ShopAdminRole,
  type ShopPermission,
} from "./permissions";

/**
 * Stage 6b shop-admin store.
 *
 * Shop admins are the third kind of login in Valmont: not the agency's GitHub
 * session (`@/lib/auth`), not a customer account (`customer-account-store`).
 * This module deliberately imports neither of those stores. It reuses the
 * *primitives* from `customer-password.ts` — scrypt hashing, the fixed-cost
 * dummy hash, email normalisation and token hashing — because they are
 * generic and already reviewed, but every table, cookie and query here is
 * scoped to a single website (`draftId`).
 *
 * The same rules as the customer store apply: passwords are only ever stored
 * as scrypt envelopes, session cookies and one-time links are only ever stored
 * as SHA-256 hashes, and every read enforces expiry itself so `purgeExpired`
 * is hygiene rather than security.
 */

export type ShopAdminStatus = "invited" | "active" | "disabled";
export type ShopAdminTokenPurpose = "invite" | "reset";

export const SHOP_ADMIN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SHOP_ADMIN_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
export const SHOP_ADMIN_RESET_TTL_MS = 60 * 60 * 1000;

/** A shop admin as the rest of the application sees it. Never carries a hash. */
export interface ShopAdmin {
  id: string;
  draftId: string;
  email: string;
  name: string;
  role: ShopAdminRole;
  permissions: ShopPermission[];
  status: ShopAdminStatus;
  invitedBy: string | null;
  /** False until the invite has been accepted. */
  hasPassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ShopAdminInvite {
  admin: ShopAdmin;
  /** The raw one-time token. Returned exactly once; only its hash is stored. */
  token: string;
  expiresAt: string;
}

export interface ShopAdminSession {
  admin: ShopAdmin;
  expiresAt: string;
}

export interface ShopAdminStore {
  /** Creates the single owner login for a website and its first invite link. */
  createOwnerInvite(input: {
    draftId: string;
    email: string;
    name: string;
    invitedBy: string;
  }): Promise<ShopAdminInvite>;
  /** Creates a member login (owner-ticked permissions) and its invite link. */
  createMemberInvite(input: {
    draftId: string;
    email: string;
    name: string;
    permissions: readonly string[];
    invitedBy: string;
  }): Promise<ShopAdminInvite>;
  /** A fresh 24-hour invite link for an admin who has not accepted yet. */
  createInviteToken(
    adminId: string,
  ): Promise<{ token: string; expiresAt: string }>;
  listForDraft(draftId: string): Promise<ShopAdmin[]>;
  countForDraft(draftId: string): Promise<number>;
  getById(id: string): Promise<ShopAdmin | null>;
  getByEmail(draftId: string, email: string): Promise<ShopAdmin | null>;
  /**
   * Looks an invite token up *without* consuming it, so the accept page can
   * greet the person by name and prefill the form. Null for an unknown,
   * expired or used token, or an admin no longer waiting for an invite.
   */
  peekInvite(token: string): Promise<ShopAdmin | null>;
  /**
   * Burns an invite token and activates the admin with their chosen name and
   * password. Returns null for an unknown, expired, already-used token or an
   * admin that is no longer waiting for an invite.
   */
  acceptInvite(
    token: string,
    name: string,
    password: string,
  ): Promise<ShopAdmin | null>;
  /**
   * Password check that always performs one scrypt derivation, whether or not
   * the email exists, has a password yet, or is disabled — so the response
   * time cannot tell an attacker which of those is true.
   */
  verifyPassword(
    draftId: string,
    email: string,
    password: string,
  ): Promise<ShopAdmin | null>;
  createSession(adminId: string): Promise<{ token: string; expiresAt: string }>;
  /** Null when expired, unknown, or the admin is no longer active. */
  getSession(token: string): Promise<ShopAdminSession | null>;
  revokeSession(token: string): Promise<void>;
  revokeAllSessions(adminId: string): Promise<void>;
  /** A one-hour password-reset link for an *active* admin. */
  createResetToken(
    adminId: string,
  ): Promise<{ token: string; expiresAt: string }>;
  /** Burns a reset token; returns the admin id or null. */
  consumeResetToken(token: string): Promise<string | null>;
  updatePassword(adminId: string, password: string): Promise<void>;
  /** Disabling also revokes every session, so the change bites immediately. */
  setStatus(
    adminId: string,
    status: ShopAdminStatus,
  ): Promise<ShopAdmin | null>;
  setPermissions(
    adminId: string,
    permissions: readonly string[],
  ): Promise<ShopAdmin | null>;
  touchLastLogin(adminId: string): Promise<void>;
  /** Removes every login, session and link that belonged to a deleted website. */
  deleteForDraft(draftId: string): Promise<number>;
  purgeExpired(now?: Date): Promise<{ sessions: number; tokens: number }>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function toAdmin(row: {
  id: string;
  draft_id: string;
  email: string;
  name: string;
  role: string;
  permissions: string;
  password_hash: string | null;
  status: string;
  invited_by: string | null;
  last_login_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): ShopAdmin {
  return {
    id: row.id,
    draftId: row.draft_id,
    email: row.email,
    name: row.name,
    role: row.role === "owner" ? "owner" : "member",
    permissions: parsePermissions(row.permissions),
    status:
      row.status === "active" || row.status === "disabled"
        ? row.status
        : "invited",
    invitedBy: row.invited_by,
    hasPassword: Boolean(row.password_hash),
    lastLoginAt: iso(row.last_login_at),
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? "",
  };
}

/** Owner first, then in the order people were added. */
function sortAdmins(admins: ShopAdmin[]): ShopAdmin[] {
  return [...admins].sort((a, b) => {
    if (a.role !== b.role) return a.role === "owner" ? -1 : 1;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    /unique|duplicate/i.test(
      `${error.message} ${"code" in error ? String(error.code) : ""}`,
    )
  );
}

/** Minimum gap between opportunistic purges triggered by session creation. */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
let lastPurgeAt = 0;

async function purgeOpportunistically(
  store: ShopAdminStore,
  now: Date,
): Promise<void> {
  if (now.getTime() - lastPurgeAt < PURGE_INTERVAL_MS) return;
  lastPurgeAt = now.getTime();
  try {
    await store.purgeExpired(now);
  } catch {
    // Hygiene only; expiry is still enforced on every read.
  }
}

/** Test seam: forget the last purge time so the next call runs immediately. */
export function resetShopAdminPurgeClockForTests(): void {
  lastPurgeAt = 0;
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

/**
 * Creates the Stage 6b tables on the shared local database. Mirrors migration
 * `0015_shop_admins.sql`; the PostgreSQL side is created by `db:migrate`.
 * `draft_id` carries no foreign key here because none of the other Studio
 * tables on SQLite do — `SqliteStudioDraftStore.delete` calls
 * {@link ShopAdminStore.deleteForDraft} instead. The two child tables do
 * cascade from the admin row, which the chat connection's
 * `PRAGMA foreign_keys = ON` enforces.
 */
export function ensureShopAdminSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS studio_shop_admins (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      permissions TEXT NOT NULL DEFAULT '[]',
      password_hash TEXT,
      status TEXT NOT NULL DEFAULT 'invited',
      invited_by TEXT,
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS studio_shop_admins_draft_email_unique ON studio_shop_admins(draft_id, email);
    CREATE INDEX IF NOT EXISTS studio_shop_admins_draft_idx ON studio_shop_admins(draft_id);
    CREATE TABLE IF NOT EXISTS studio_shop_admin_sessions (
      token_hash TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL REFERENCES studio_shop_admins(id) ON DELETE CASCADE,
      draft_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_shop_admin_sessions_admin_idx ON studio_shop_admin_sessions(admin_id);
    CREATE TABLE IF NOT EXISTS studio_shop_admin_tokens (
      token_hash TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL REFERENCES studio_shop_admins(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_shop_admin_tokens_admin_idx ON studio_shop_admin_tokens(admin_id);
  `);
}

interface SqliteAdminRow {
  id: string;
  draft_id: string;
  email: string;
  name: string;
  role: string;
  permissions: string;
  password_hash: string | null;
  status: string;
  invited_by: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SqliteSessionRow {
  token_hash: string;
  admin_id: string;
  draft_id: string;
  expires_at: string;
  created_at: string;
}

export class SqliteShopAdminStore implements ShopAdminStore {
  private get db(): DatabaseSync {
    const store = getSqliteChatStore();
    ensureShopAdminSchema(store.connection);
    return store.connection;
  }

  private row(id: string): SqliteAdminRow | undefined {
    return this.db
      .prepare("SELECT * FROM studio_shop_admins WHERE id = ?")
      .get(id) as unknown as SqliteAdminRow | undefined;
  }

  private rowByEmail(
    draftId: string,
    email: string,
  ): SqliteAdminRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM studio_shop_admins WHERE draft_id = ? AND email = ?",
      )
      .get(draftId, normalizeCustomerEmail(email)) as unknown as
      SqliteAdminRow | undefined;
  }

  private insertAdmin(input: {
    draftId: string;
    email: string;
    name: string;
    role: ShopAdminRole;
    permissions: readonly string[];
    invitedBy: string;
  }): ShopAdmin {
    const now = new Date().toISOString();
    const id = randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO studio_shop_admins(
             id, draft_id, email, name, role, permissions, password_hash,
             status, invited_by, last_login_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'invited', ?, NULL, ?, ?)`,
        )
        .run(
          id,
          input.draftId,
          normalizeCustomerEmail(input.email),
          input.name,
          input.role,
          serializePermissions(input.permissions),
          input.invitedBy,
          now,
          now,
        );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ShopAdminExistsError();
      throw error;
    }
    const row = this.row(id);
    if (!row) throw new Error("Shop login could not be created");
    return toAdmin(row);
  }

  private issueToken(
    adminId: string,
    purpose: ShopAdminTokenPurpose,
    ttlMs: number,
  ): { token: string; expiresAt: string } {
    const token = createCustomerToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    this.db
      .prepare(
        `INSERT INTO studio_shop_admin_tokens(
           token_hash, admin_id, purpose, expires_at, used_at, created_at
         ) VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        hashCustomerToken(token),
        adminId,
        purpose,
        expiresAt.toISOString(),
        now.toISOString(),
      );
    return { token, expiresAt: expiresAt.toISOString() };
  }

  /** Marks a live token used and returns its admin id, atomically. */
  private burnToken(
    token: string,
    purpose: ShopAdminTokenPurpose,
  ): string | null {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `UPDATE studio_shop_admin_tokens SET used_at = ?
         WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
         RETURNING admin_id`,
      )
      .get(now, hashCustomerToken(token), purpose, now) as unknown as
      { admin_id: string } | undefined;
    return row?.admin_id ?? null;
  }

  async createOwnerInvite(input: {
    draftId: string;
    email: string;
    name: string;
    invitedBy: string;
  }): Promise<ShopAdminInvite> {
    const existingOwner = this.db
      .prepare(
        "SELECT 1 FROM studio_shop_admins WHERE draft_id = ? AND role = 'owner'",
      )
      .get(input.draftId);
    if (existingOwner) throw new ShopOwnerExistsError();
    if (
      (await this.countForDraft(input.draftId)) >= MAX_SHOP_LOGINS_PER_WEBSITE
    )
      throw new ShopLoginCapError();
    const admin = this.insertAdmin({
      ...input,
      role: "owner",
      permissions: [],
    });
    const issued = this.issueToken(
      admin.id,
      "invite",
      SHOP_ADMIN_INVITE_TTL_MS,
    );
    return { admin, ...issued };
  }

  async createMemberInvite(input: {
    draftId: string;
    email: string;
    name: string;
    permissions: readonly string[];
    invitedBy: string;
  }): Promise<ShopAdminInvite> {
    if (
      (await this.countForDraft(input.draftId)) >= MAX_SHOP_LOGINS_PER_WEBSITE
    )
      throw new ShopLoginCapError();
    const admin = this.insertAdmin({ ...input, role: "member" });
    const issued = this.issueToken(
      admin.id,
      "invite",
      SHOP_ADMIN_INVITE_TTL_MS,
    );
    return { admin, ...issued };
  }

  async createInviteToken(
    adminId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    return this.issueToken(adminId, "invite", SHOP_ADMIN_INVITE_TTL_MS);
  }

  async listForDraft(draftId: string): Promise<ShopAdmin[]> {
    const rows = this.db
      .prepare("SELECT * FROM studio_shop_admins WHERE draft_id = ?")
      .all(draftId) as unknown as SqliteAdminRow[];
    return sortAdmins(rows.map(toAdmin));
  }

  async countForDraft(draftId: string): Promise<number> {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM studio_shop_admins WHERE draft_id = ?",
      )
      .get(draftId) as unknown as { n: number | bigint };
    return Number(row.n);
  }

  async getById(id: string): Promise<ShopAdmin | null> {
    const row = this.row(id);
    return row ? toAdmin(row) : null;
  }

  async getByEmail(draftId: string, email: string): Promise<ShopAdmin | null> {
    const row = this.rowByEmail(draftId, email);
    return row ? toAdmin(row) : null;
  }

  async peekInvite(token: string): Promise<ShopAdmin | null> {
    const now = new Date().toISOString();
    const live = this.db
      .prepare(
        `SELECT admin_id FROM studio_shop_admin_tokens
         WHERE token_hash = ? AND purpose = 'invite' AND used_at IS NULL AND expires_at > ?`,
      )
      .get(hashCustomerToken(token), now) as unknown as
      { admin_id: string } | undefined;
    if (!live) return null;
    const row = this.row(live.admin_id);
    if (!row || row.status !== "invited") return null;
    return toAdmin(row);
  }

  async acceptInvite(
    token: string,
    name: string,
    password: string,
  ): Promise<ShopAdmin | null> {
    const adminId = this.burnToken(token, "invite");
    if (!adminId) return null;
    const row = this.row(adminId);
    if (!row || row.status !== "invited") return null;
    const passwordHash = await hashCustomerPassword(password);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE studio_shop_admins
         SET name = ?, password_hash = ?, status = 'active', updated_at = ?
         WHERE id = ? AND status = 'invited'`,
      )
      .run(name, passwordHash, now, adminId);
    // Any other invite links still in flight for this person are now moot.
    this.db
      .prepare(
        "DELETE FROM studio_shop_admin_tokens WHERE admin_id = ? AND purpose = 'invite' AND used_at IS NULL",
      )
      .run(adminId);
    const updated = this.row(adminId);
    return updated ? toAdmin(updated) : null;
  }

  async verifyPassword(
    draftId: string,
    email: string,
    password: string,
  ): Promise<ShopAdmin | null> {
    const row = this.rowByEmail(draftId, email);
    const usable = Boolean(row && row.status === "active" && row.password_hash);
    const hash =
      usable && row?.password_hash
        ? row.password_hash
        : DUMMY_CUSTOMER_PASSWORD_HASH;
    const ok = await verifyCustomerPassword(password, hash);
    if (!ok || !usable || !row) return null;
    return toAdmin(row);
  }

  async createSession(
    adminId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const admin = this.row(adminId);
    if (!admin) throw new Error("Shop login no longer exists");
    const token = createCustomerToken();
    const now = new Date();
    await purgeOpportunistically(this, now);
    const expiresAt = new Date(now.getTime() + SHOP_ADMIN_SESSION_TTL_MS);
    this.db
      .prepare(
        `INSERT INTO studio_shop_admin_sessions(
           token_hash, admin_id, draft_id, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        hashCustomerToken(token),
        adminId,
        admin.draft_id,
        expiresAt.toISOString(),
        now.toISOString(),
      );
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async getSession(token: string): Promise<ShopAdminSession | null> {
    const now = new Date().toISOString();
    const session = this.db
      .prepare(
        "SELECT * FROM studio_shop_admin_sessions WHERE token_hash = ? AND expires_at > ?",
      )
      .get(hashCustomerToken(token), now) as unknown as
      SqliteSessionRow | undefined;
    if (!session) return null;
    const row = this.row(session.admin_id);
    if (!row || row.status !== "active" || row.draft_id !== session.draft_id)
      return null;
    return { admin: toAdmin(row), expiresAt: session.expires_at };
  }

  async revokeSession(token: string): Promise<void> {
    this.db
      .prepare("DELETE FROM studio_shop_admin_sessions WHERE token_hash = ?")
      .run(hashCustomerToken(token));
  }

  async revokeAllSessions(adminId: string): Promise<void> {
    this.db
      .prepare("DELETE FROM studio_shop_admin_sessions WHERE admin_id = ?")
      .run(adminId);
  }

  async createResetToken(
    adminId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    return this.issueToken(adminId, "reset", SHOP_ADMIN_RESET_TTL_MS);
  }

  async consumeResetToken(token: string): Promise<string | null> {
    const adminId = this.burnToken(token, "reset");
    if (!adminId) return null;
    const row = this.row(adminId);
    if (!row || row.status !== "active") return null;
    return adminId;
  }

  async updatePassword(adminId: string, password: string): Promise<void> {
    const passwordHash = await hashCustomerPassword(password);
    this.db
      .prepare(
        "UPDATE studio_shop_admins SET password_hash = ?, updated_at = ? WHERE id = ?",
      )
      .run(passwordHash, new Date().toISOString(), adminId);
  }

  async setStatus(
    adminId: string,
    status: ShopAdminStatus,
  ): Promise<ShopAdmin | null> {
    const row = this.row(adminId);
    if (!row) return null;
    this.db
      .prepare(
        "UPDATE studio_shop_admins SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, new Date().toISOString(), adminId);
    if (status === "disabled") await this.revokeAllSessions(adminId);
    return this.getById(adminId);
  }

  async setPermissions(
    adminId: string,
    permissions: readonly string[],
  ): Promise<ShopAdmin | null> {
    const row = this.row(adminId);
    if (!row) return null;
    this.db
      .prepare(
        "UPDATE studio_shop_admins SET permissions = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        serializePermissions(permissions),
        new Date().toISOString(),
        adminId,
      );
    return this.getById(adminId);
  }

  async touchLastLogin(adminId: string): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE studio_shop_admins SET last_login_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(now, now, adminId);
  }

  async deleteForDraft(draftId: string): Promise<number> {
    const db = this.db;
    // Explicit child deletes so the outcome never depends on the connection's
    // foreign-key pragma.
    db.prepare(
      "DELETE FROM studio_shop_admin_sessions WHERE admin_id IN (SELECT id FROM studio_shop_admins WHERE draft_id = ?)",
    ).run(draftId);
    db.prepare(
      "DELETE FROM studio_shop_admin_tokens WHERE admin_id IN (SELECT id FROM studio_shop_admins WHERE draft_id = ?)",
    ).run(draftId);
    db.prepare("DELETE FROM studio_shop_admin_sessions WHERE draft_id = ?").run(
      draftId,
    );
    const result = db
      .prepare("DELETE FROM studio_shop_admins WHERE draft_id = ?")
      .run(draftId);
    return Number(result.changes);
  }

  async purgeExpired(
    now = new Date(),
  ): Promise<{ sessions: number; tokens: number }> {
    const cutoff = now.toISOString();
    const sessions = this.db
      .prepare("DELETE FROM studio_shop_admin_sessions WHERE expires_at <= ?")
      .run(cutoff);
    const tokens = this.db
      .prepare(
        "DELETE FROM studio_shop_admin_tokens WHERE expires_at <= ? OR used_at IS NOT NULL",
      )
      .run(cutoff);
    return {
      sessions: Number(sessions.changes),
      tokens: Number(tokens.changes),
    };
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

type PgAdminRow = typeof studioShopAdmins.$inferSelect;

function pgAdmin(row: PgAdminRow): ShopAdmin {
  return toAdmin({
    id: row.id,
    draft_id: row.draftId,
    email: row.email,
    name: row.name,
    role: row.role,
    permissions: row.permissions,
    password_hash: row.passwordHash,
    status: row.status,
    invited_by: row.invitedBy,
    last_login_at: row.lastLoginAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
}

export class PostgresShopAdminStore implements ShopAdminStore {
  private async row(id: string): Promise<PgAdminRow | undefined> {
    const [row] = await getDatabase()
      .select()
      .from(studioShopAdmins)
      .where(eq(studioShopAdmins.id, id))
      .limit(1);
    return row;
  }

  private async rowByEmail(
    draftId: string,
    email: string,
  ): Promise<PgAdminRow | undefined> {
    const [row] = await getDatabase()
      .select()
      .from(studioShopAdmins)
      .where(
        and(
          eq(studioShopAdmins.draftId, draftId),
          eq(studioShopAdmins.email, normalizeCustomerEmail(email)),
        ),
      )
      .limit(1);
    return row;
  }

  private async insertAdmin(input: {
    draftId: string;
    email: string;
    name: string;
    role: ShopAdminRole;
    permissions: readonly string[];
    invitedBy: string;
  }): Promise<ShopAdmin> {
    try {
      const [row] = await getDatabase()
        .insert(studioShopAdmins)
        .values({
          draftId: input.draftId,
          email: normalizeCustomerEmail(input.email),
          name: input.name,
          role: input.role,
          permissions: serializePermissions(input.permissions),
          status: "invited",
          invitedBy: input.invitedBy,
        })
        .returning();
      if (!row) throw new Error("Shop login could not be created");
      return pgAdmin(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ShopAdminExistsError();
      throw error;
    }
  }

  private async issueToken(
    adminId: string,
    purpose: ShopAdminTokenPurpose,
    ttlMs: number,
  ): Promise<{ token: string; expiresAt: string }> {
    const token = createCustomerToken();
    const expiresAt = new Date(Date.now() + ttlMs);
    await getDatabase()
      .insert(studioShopAdminTokens)
      .values({
        tokenHash: hashCustomerToken(token),
        adminId,
        purpose,
        expiresAt,
      });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  private async burnToken(
    token: string,
    purpose: ShopAdminTokenPurpose,
  ): Promise<string | null> {
    const now = new Date();
    const [row] = await getDatabase()
      .update(studioShopAdminTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(studioShopAdminTokens.tokenHash, hashCustomerToken(token)),
          eq(studioShopAdminTokens.purpose, purpose),
          isNull(studioShopAdminTokens.usedAt),
          gt(studioShopAdminTokens.expiresAt, now),
        ),
      )
      .returning({ adminId: studioShopAdminTokens.adminId });
    return row?.adminId ?? null;
  }

  async createOwnerInvite(input: {
    draftId: string;
    email: string;
    name: string;
    invitedBy: string;
  }): Promise<ShopAdminInvite> {
    const [existingOwner] = await getDatabase()
      .select({ id: studioShopAdmins.id })
      .from(studioShopAdmins)
      .where(
        and(
          eq(studioShopAdmins.draftId, input.draftId),
          eq(studioShopAdmins.role, "owner"),
        ),
      )
      .limit(1);
    if (existingOwner) throw new ShopOwnerExistsError();
    if (
      (await this.countForDraft(input.draftId)) >= MAX_SHOP_LOGINS_PER_WEBSITE
    )
      throw new ShopLoginCapError();
    const admin = await this.insertAdmin({
      ...input,
      role: "owner",
      permissions: [],
    });
    const issued = await this.issueToken(
      admin.id,
      "invite",
      SHOP_ADMIN_INVITE_TTL_MS,
    );
    return { admin, ...issued };
  }

  async createMemberInvite(input: {
    draftId: string;
    email: string;
    name: string;
    permissions: readonly string[];
    invitedBy: string;
  }): Promise<ShopAdminInvite> {
    if (
      (await this.countForDraft(input.draftId)) >= MAX_SHOP_LOGINS_PER_WEBSITE
    )
      throw new ShopLoginCapError();
    const admin = await this.insertAdmin({ ...input, role: "member" });
    const issued = await this.issueToken(
      admin.id,
      "invite",
      SHOP_ADMIN_INVITE_TTL_MS,
    );
    return { admin, ...issued };
  }

  async createInviteToken(
    adminId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    return this.issueToken(adminId, "invite", SHOP_ADMIN_INVITE_TTL_MS);
  }

  async listForDraft(draftId: string): Promise<ShopAdmin[]> {
    const rows = await getDatabase()
      .select()
      .from(studioShopAdmins)
      .where(eq(studioShopAdmins.draftId, draftId))
      .orderBy(asc(studioShopAdmins.createdAt));
    return sortAdmins(rows.map(pgAdmin));
  }

  async countForDraft(draftId: string): Promise<number> {
    const [row] = await getDatabase()
      .select({ n: sql<number>`count(*)` })
      .from(studioShopAdmins)
      .where(eq(studioShopAdmins.draftId, draftId));
    return Number(row?.n ?? 0);
  }

  async getById(id: string): Promise<ShopAdmin | null> {
    const row = await this.row(id);
    return row ? pgAdmin(row) : null;
  }

  async getByEmail(draftId: string, email: string): Promise<ShopAdmin | null> {
    const row = await this.rowByEmail(draftId, email);
    return row ? pgAdmin(row) : null;
  }

  async peekInvite(token: string): Promise<ShopAdmin | null> {
    const now = new Date();
    const [live] = await getDatabase()
      .select({ adminId: studioShopAdminTokens.adminId })
      .from(studioShopAdminTokens)
      .where(
        and(
          eq(studioShopAdminTokens.tokenHash, hashCustomerToken(token)),
          eq(studioShopAdminTokens.purpose, "invite"),
          isNull(studioShopAdminTokens.usedAt),
          gt(studioShopAdminTokens.expiresAt, now),
        ),
      )
      .limit(1);
    if (!live) return null;
    const row = await this.row(live.adminId);
    if (!row || row.status !== "invited") return null;
    return pgAdmin(row);
  }

  async acceptInvite(
    token: string,
    name: string,
    password: string,
  ): Promise<ShopAdmin | null> {
    const adminId = await this.burnToken(token, "invite");
    if (!adminId) return null;
    const row = await this.row(adminId);
    if (!row || row.status !== "invited") return null;
    const passwordHash = await hashCustomerPassword(password);
    const db = getDatabase();
    await db
      .update(studioShopAdmins)
      .set({ name, passwordHash, status: "active", updatedAt: new Date() })
      .where(
        and(
          eq(studioShopAdmins.id, adminId),
          eq(studioShopAdmins.status, "invited"),
        ),
      );
    await db
      .delete(studioShopAdminTokens)
      .where(
        and(
          eq(studioShopAdminTokens.adminId, adminId),
          eq(studioShopAdminTokens.purpose, "invite"),
          isNull(studioShopAdminTokens.usedAt),
        ),
      );
    return this.getById(adminId);
  }

  async verifyPassword(
    draftId: string,
    email: string,
    password: string,
  ): Promise<ShopAdmin | null> {
    const row = await this.rowByEmail(draftId, email);
    const usable = Boolean(row && row.status === "active" && row.passwordHash);
    const hash =
      usable && row?.passwordHash
        ? row.passwordHash
        : DUMMY_CUSTOMER_PASSWORD_HASH;
    const ok = await verifyCustomerPassword(password, hash);
    if (!ok || !usable || !row) return null;
    return pgAdmin(row);
  }

  async createSession(
    adminId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const admin = await this.row(adminId);
    if (!admin) throw new Error("Shop login no longer exists");
    const token = createCustomerToken();
    const now = new Date();
    await purgeOpportunistically(this, now);
    const expiresAt = new Date(now.getTime() + SHOP_ADMIN_SESSION_TTL_MS);
    await getDatabase()
      .insert(studioShopAdminSessions)
      .values({
        tokenHash: hashCustomerToken(token),
        adminId,
        draftId: admin.draftId,
        expiresAt,
      });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async getSession(token: string): Promise<ShopAdminSession | null> {
    const now = new Date();
    const [session] = await getDatabase()
      .select()
      .from(studioShopAdminSessions)
      .where(
        and(
          eq(studioShopAdminSessions.tokenHash, hashCustomerToken(token)),
          gt(studioShopAdminSessions.expiresAt, now),
        ),
      )
      .limit(1);
    if (!session) return null;
    const row = await this.row(session.adminId);
    if (!row || row.status !== "active" || row.draftId !== session.draftId)
      return null;
    return { admin: pgAdmin(row), expiresAt: session.expiresAt.toISOString() };
  }

  async revokeSession(token: string): Promise<void> {
    await getDatabase()
      .delete(studioShopAdminSessions)
      .where(eq(studioShopAdminSessions.tokenHash, hashCustomerToken(token)));
  }

  async revokeAllSessions(adminId: string): Promise<void> {
    await getDatabase()
      .delete(studioShopAdminSessions)
      .where(eq(studioShopAdminSessions.adminId, adminId));
  }

  async createResetToken(
    adminId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    return this.issueToken(adminId, "reset", SHOP_ADMIN_RESET_TTL_MS);
  }

  async consumeResetToken(token: string): Promise<string | null> {
    const adminId = await this.burnToken(token, "reset");
    if (!adminId) return null;
    const row = await this.row(adminId);
    if (!row || row.status !== "active") return null;
    return adminId;
  }

  async updatePassword(adminId: string, password: string): Promise<void> {
    await getDatabase()
      .update(studioShopAdmins)
      .set({
        passwordHash: await hashCustomerPassword(password),
        updatedAt: new Date(),
      })
      .where(eq(studioShopAdmins.id, adminId));
  }

  async setStatus(
    adminId: string,
    status: ShopAdminStatus,
  ): Promise<ShopAdmin | null> {
    const [row] = await getDatabase()
      .update(studioShopAdmins)
      .set({ status, updatedAt: new Date() })
      .where(eq(studioShopAdmins.id, adminId))
      .returning();
    if (!row) return null;
    if (status === "disabled") await this.revokeAllSessions(adminId);
    return pgAdmin(row);
  }

  async setPermissions(
    adminId: string,
    permissions: readonly string[],
  ): Promise<ShopAdmin | null> {
    const [row] = await getDatabase()
      .update(studioShopAdmins)
      .set({
        permissions: serializePermissions(permissions),
        updatedAt: new Date(),
      })
      .where(eq(studioShopAdmins.id, adminId))
      .returning();
    return row ? pgAdmin(row) : null;
  }

  async touchLastLogin(adminId: string): Promise<void> {
    const now = new Date();
    await getDatabase()
      .update(studioShopAdmins)
      .set({ lastLoginAt: now, updatedAt: now })
      .where(eq(studioShopAdmins.id, adminId));
  }

  async deleteForDraft(draftId: string): Promise<number> {
    // Sessions and tokens cascade from the admin row (migration 0015).
    const deleted = await getDatabase()
      .delete(studioShopAdmins)
      .where(eq(studioShopAdmins.draftId, draftId))
      .returning({ id: studioShopAdmins.id });
    return deleted.length;
  }

  async purgeExpired(
    now = new Date(),
  ): Promise<{ sessions: number; tokens: number }> {
    const db = getDatabase();
    const sessions = await db
      .delete(studioShopAdminSessions)
      .where(lte(studioShopAdminSessions.expiresAt, now))
      .returning({ tokenHash: studioShopAdminSessions.tokenHash });
    const tokens = await db
      .delete(studioShopAdminTokens)
      .where(
        or(
          lte(studioShopAdminTokens.expiresAt, now),
          isNotNull(studioShopAdminTokens.usedAt),
        ),
      )
      .returning({ tokenHash: studioShopAdminTokens.tokenHash });
    return { sessions: sessions.length, tokens: tokens.length };
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

let overrideForTests: ShopAdminStore | null = null;

/** SQLite locally, PostgreSQL when `DATABASE_URL` is set — like every other store. */
export function getShopAdminStore(): ShopAdminStore {
  if (overrideForTests) return overrideForTests;
  return process.env.DATABASE_URL
    ? new PostgresShopAdminStore()
    : new SqliteShopAdminStore();
}

/** Test-only seam for route tests that want an in-memory store. */
export function setShopAdminStoreForTests(store: ShopAdminStore | null): void {
  overrideForTests = store;
}
