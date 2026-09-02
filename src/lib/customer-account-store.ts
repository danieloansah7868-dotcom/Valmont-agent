import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { and, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  customerAccounts,
  customerSessions,
  customerTokens,
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
import { CustomerAccountExistsError } from "@/lib/api-errors";

export type CustomerTokenPurpose = "verify_email" | "reset_password";

export interface CustomerAccount {
  id: string;
  email: string;
  name: string;
  emailVerifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerSession {
  account: CustomerAccount;
  token: string;
  expiresAt: string;
}

export { CustomerAccountExistsError };

function toAccount(input: {
  id: string;
  email: string;
  name: string;
  emailVerifiedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}): CustomerAccount {
  return {
    id: input.id,
    email: input.email,
    name: input.name,
    emailVerifiedAt: input.emailVerifiedAt
      ? input.emailVerifiedAt instanceof Date
        ? input.emailVerifiedAt.toISOString()
        : input.emailVerifiedAt
      : undefined,
    createdAt:
      input.createdAt instanceof Date
        ? input.createdAt.toISOString()
        : input.createdAt,
    updatedAt:
      input.updatedAt instanceof Date
        ? input.updatedAt.toISOString()
        : input.updatedAt,
  };
}

export interface CustomerAccountStore {
  createAccount(input: {
    email: string;
    name: string;
    password: string;
  }): Promise<CustomerAccount>;
  getByEmail(email: string): Promise<CustomerAccount | null>;
  getById(id: string): Promise<CustomerAccount | null>;
  verifyEmail(accountId: string): Promise<void>;
  updatePassword(accountId: string, password: string): Promise<void>;
  createSession(accountId: string): Promise<CustomerSession>;
  getSession(token: string): Promise<CustomerSession | null>;
  revokeSession(token: string): Promise<void>;
  revokeAllSessions(accountId: string): Promise<void>;
  createToken(
    accountId: string,
    purpose: CustomerTokenPurpose,
    ttlMs: number,
    context?: string,
  ): Promise<string>;
  consumeToken(
    token: string,
    purpose: CustomerTokenPurpose,
  ): Promise<ConsumedCustomerToken | null>;
  /**
   * Deletes expired sessions and expired or already-used one-time tokens.
   * Expiry is enforced on every read, so this is hygiene rather than
   * security: it keeps the tables from growing without bound and removes
   * stale hashed material that has no further use.
   */
  purgeExpired(now?: Date): Promise<{ sessions: number; tokens: number }>;
}

export interface ConsumedCustomerToken {
  accountId: string;
  /** Checkout access code held only until email verification completes. */
  context?: string;
}

export const CUSTOMER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CUSTOMER_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const CUSTOMER_RESET_TTL_MS = 60 * 60 * 1000;

/** Minimum gap between opportunistic purges triggered by session creation. */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
let lastPurgeAt = 0;

/**
 * Runs {@link CustomerAccountStore.purgeExpired} at most once an hour per
 * process, from the hot path that creates new rows. Failures are swallowed —
 * housekeeping must never break a sign-in — and the timer is reset so a
 * transient database error does not turn into a purge storm.
 */
export async function purgeExpiredCustomerRowsOpportunistically(
  store: CustomerAccountStore,
  now = new Date(),
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
export function resetCustomerPurgeClockForTests(): void {
  lastPurgeAt = 0;
}

interface SqliteAccountRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  email_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SqliteSessionRow extends SqliteAccountRow {
  session_expires_at: string;
}

function sqliteAccount(row: SqliteAccountRow): CustomerAccount {
  return toAccount({
    id: row.id,
    email: row.email,
    name: row.name,
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/** Exported for the backup importer, which must create the same tables. */
export function ensureCustomerAccountSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      email_verified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customer_sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customer_tokens (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      context TEXT,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS customer_sessions_account_idx
      ON customer_sessions(account_id);
    CREATE INDEX IF NOT EXISTS customer_tokens_account_purpose_idx
      ON customer_tokens(account_id, purpose);
  `);

  const tokenColumns = new Set(
    (
      db.prepare("PRAGMA table_info(customer_tokens)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
  if (!tokenColumns.has("context")) {
    db.exec("ALTER TABLE customer_tokens ADD COLUMN context TEXT");
  }
}

export class SqliteCustomerAccountStore implements CustomerAccountStore {
  private get db(): DatabaseSync {
    const db = getSqliteChatStore().connection;
    ensureCustomerAccountSchema(db);
    return db;
  }

  async createAccount(input: {
    email: string;
    name: string;
    password: string;
  }): Promise<CustomerAccount> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const passwordHash = await hashCustomerPassword(input.password);
    try {
      this.db
        .prepare(
          `INSERT INTO customer_accounts(
             id, email, name, password_hash, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          normalizeCustomerEmail(input.email),
          input.name,
          passwordHash,
          now,
          now,
        );
    } catch (error) {
      if (error instanceof Error && /unique|constraint/i.test(error.message)) {
        throw new CustomerAccountExistsError();
      }
      throw error;
    }
    const account = await this.getById(id);
    if (!account) throw new Error("Customer account could not be created");
    return account;
  }

  async getByEmail(email: string): Promise<CustomerAccount | null> {
    const row = this.db
      .prepare("SELECT * FROM customer_accounts WHERE email = ?")
      .get(normalizeCustomerEmail(email)) as unknown as
      SqliteAccountRow | undefined;
    return row ? sqliteAccount(row) : null;
  }

  async getById(id: string): Promise<CustomerAccount | null> {
    const row = this.db
      .prepare("SELECT * FROM customer_accounts WHERE id = ?")
      .get(id) as unknown as SqliteAccountRow | undefined;
    return row ? sqliteAccount(row) : null;
  }

  async verifyEmail(accountId: string): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE customer_accounts
            SET email_verified_at = COALESCE(email_verified_at, ?), updated_at = ?
          WHERE id = ?`,
      )
      .run(now, now, accountId);
  }

  async updatePassword(accountId: string, password: string): Promise<void> {
    const passwordHash = await hashCustomerPassword(password);
    this.db
      .prepare(
        `UPDATE customer_accounts SET password_hash = ?, updated_at = ? WHERE id = ?`,
      )
      .run(passwordHash, new Date().toISOString(), accountId);
  }

  async createSession(accountId: string): Promise<CustomerSession> {
    const token = createCustomerToken();
    const now = new Date();
    await purgeExpiredCustomerRowsOpportunistically(this, now);
    const expiresAt = new Date(now.getTime() + CUSTOMER_SESSION_TTL_MS);
    this.db
      .prepare(
        `INSERT INTO customer_sessions(
           id, account_id, token_hash, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        accountId,
        hashCustomerToken(token),
        expiresAt.toISOString(),
        now.toISOString(),
      );
    const account = await this.getById(accountId);
    if (!account) throw new Error("Customer account no longer exists");
    return { account, token, expiresAt: expiresAt.toISOString() };
  }

  async getSession(token: string): Promise<CustomerSession | null> {
    const row = this.db
      .prepare(
        `SELECT a.*, s.expires_at AS session_expires_at
           FROM customer_sessions s
           JOIN customer_accounts a ON a.id = s.account_id
          WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(hashCustomerToken(token), new Date().toISOString()) as unknown as
      SqliteSessionRow | undefined;
    if (!row) return null;
    return {
      account: sqliteAccount(row),
      token,
      expiresAt: row.session_expires_at,
    };
  }

  async revokeSession(token: string): Promise<void> {
    this.db
      .prepare("DELETE FROM customer_sessions WHERE token_hash = ?")
      .run(hashCustomerToken(token));
  }

  async revokeAllSessions(accountId: string): Promise<void> {
    this.db
      .prepare("DELETE FROM customer_sessions WHERE account_id = ?")
      .run(accountId);
  }

  async purgeExpired(
    now = new Date(),
  ): Promise<{ sessions: number; tokens: number }> {
    const cutoff = now.toISOString();
    const sessions = this.db
      .prepare("DELETE FROM customer_sessions WHERE expires_at <= ?")
      .run(cutoff);
    const tokens = this.db
      .prepare(
        "DELETE FROM customer_tokens WHERE expires_at <= ? OR used_at IS NOT NULL",
      )
      .run(cutoff);
    return {
      sessions: Number(sessions.changes),
      tokens: Number(tokens.changes),
    };
  }

  async createToken(
    accountId: string,
    purpose: CustomerTokenPurpose,
    ttlMs: number,
    context?: string,
  ): Promise<string> {
    const token = createCustomerToken();
    const now = new Date();
    const preservedContext =
      context === undefined
        ? ((
            this.db
              .prepare(
                `SELECT context FROM customer_tokens
                  WHERE account_id = ? AND purpose = ? AND used_at IS NULL
                  ORDER BY created_at DESC LIMIT 1`,
              )
              .get(accountId, purpose) as { context: string | null } | undefined
          )?.context ?? undefined)
        : context;
    this.db
      .prepare(
        `DELETE FROM customer_tokens
          WHERE account_id = ? AND purpose = ? AND used_at IS NULL`,
      )
      .run(accountId, purpose);
    this.db
      .prepare(
        `INSERT INTO customer_tokens(
           id, account_id, purpose, token_hash, context, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        accountId,
        purpose,
        hashCustomerToken(token),
        preservedContext ?? null,
        new Date(now.getTime() + ttlMs).toISOString(),
        now.toISOString(),
      );
    return token;
  }

  async consumeToken(
    token: string,
    purpose: CustomerTokenPurpose,
  ): Promise<ConsumedCustomerToken | null> {
    const row = this.db
      .prepare(
        `SELECT id, account_id, context
           FROM customer_tokens
          WHERE token_hash = ?
            AND purpose = ?
            AND used_at IS NULL
            AND expires_at > ?`,
      )
      .get(hashCustomerToken(token), purpose, new Date().toISOString()) as
      { id: string; account_id: string; context: string | null } | undefined;
    if (!row) return null;
    const result = this.db
      .prepare(
        `UPDATE customer_tokens SET used_at = ?
          WHERE id = ? AND used_at IS NULL`,
      )
      .run(new Date().toISOString(), row.id);
    return result.changes === 1
      ? { accountId: row.account_id, context: row.context ?? undefined }
      : null;
  }

  async verifyPassword(
    email: string,
    password: string,
  ): Promise<CustomerAccount | null> {
    const row = this.db
      .prepare("SELECT * FROM customer_accounts WHERE email = ?")
      .get(normalizeCustomerEmail(email)) as unknown as
      (SqliteAccountRow & { password_hash: string }) | undefined;
    const passwordHash = row?.password_hash ?? DUMMY_CUSTOMER_PASSWORD_HASH;
    const valid = await verifyCustomerPassword(password, passwordHash);
    if (!row || !valid) return null;
    return sqliteAccount(row);
  }
}

function pgAccount(row: typeof customerAccounts.$inferSelect): CustomerAccount {
  return toAccount({
    id: row.id,
    email: row.email,
    name: row.name,
    emailVerifiedAt: row.emailVerifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export class PostgresCustomerAccountStore implements CustomerAccountStore {
  async createAccount(input: {
    email: string;
    name: string;
    password: string;
  }): Promise<CustomerAccount> {
    const passwordHash = await hashCustomerPassword(input.password);
    try {
      const [row] = await getDatabase()
        .insert(customerAccounts)
        .values({
          email: normalizeCustomerEmail(input.email),
          name: input.name,
          passwordHash,
        })
        .returning();
      if (!row) throw new Error("Customer account could not be created");
      return pgAccount(row);
    } catch (error) {
      if (error instanceof Error && /unique|duplicate/i.test(error.message)) {
        throw new CustomerAccountExistsError();
      }
      throw error;
    }
  }

  async getByEmail(email: string): Promise<CustomerAccount | null> {
    const [row] = await getDatabase()
      .select()
      .from(customerAccounts)
      .where(eq(customerAccounts.email, normalizeCustomerEmail(email)))
      .limit(1);
    return row ? pgAccount(row) : null;
  }

  async getById(id: string): Promise<CustomerAccount | null> {
    const [row] = await getDatabase()
      .select()
      .from(customerAccounts)
      .where(eq(customerAccounts.id, id))
      .limit(1);
    return row ? pgAccount(row) : null;
  }

  async verifyEmail(accountId: string): Promise<void> {
    const now = new Date();
    await getDatabase()
      .update(customerAccounts)
      .set({ emailVerifiedAt: now, updatedAt: now })
      .where(
        and(
          eq(customerAccounts.id, accountId),
          isNull(customerAccounts.emailVerifiedAt),
        ),
      );
  }

  async updatePassword(accountId: string, password: string): Promise<void> {
    await getDatabase()
      .update(customerAccounts)
      .set({
        passwordHash: await hashCustomerPassword(password),
        updatedAt: new Date(),
      })
      .where(eq(customerAccounts.id, accountId));
  }

  async createSession(accountId: string): Promise<CustomerSession> {
    const token = createCustomerToken();
    const now = new Date();
    await purgeExpiredCustomerRowsOpportunistically(this, now);
    const expiresAt = new Date(now.getTime() + CUSTOMER_SESSION_TTL_MS);
    const [row] = await getDatabase()
      .insert(customerSessions)
      .values({
        accountId,
        tokenHash: hashCustomerToken(token),
        expiresAt,
      })
      .returning();
    const account = await this.getById(accountId);
    if (!row || !account) throw new Error("Customer account no longer exists");
    return { account, token, expiresAt: expiresAt.toISOString() };
  }

  async getSession(token: string): Promise<CustomerSession | null> {
    const now = new Date();
    const [session] = await getDatabase()
      .select()
      .from(customerSessions)
      .where(
        and(
          eq(customerSessions.tokenHash, hashCustomerToken(token)),
          gt(customerSessions.expiresAt, now),
        ),
      )
      .limit(1);
    if (!session) return null;
    const account = await this.getById(session.accountId);
    return account
      ? {
          account,
          token,
          expiresAt: session.expiresAt.toISOString(),
        }
      : null;
  }

  async revokeSession(token: string): Promise<void> {
    await getDatabase()
      .delete(customerSessions)
      .where(eq(customerSessions.tokenHash, hashCustomerToken(token)));
  }

  async revokeAllSessions(accountId: string): Promise<void> {
    await getDatabase()
      .delete(customerSessions)
      .where(eq(customerSessions.accountId, accountId));
  }

  async purgeExpired(
    now = new Date(),
  ): Promise<{ sessions: number; tokens: number }> {
    const sessions = await getDatabase()
      .delete(customerSessions)
      .where(lt(customerSessions.expiresAt, now))
      .returning({ id: customerSessions.id });
    const tokens = await getDatabase()
      .delete(customerTokens)
      .where(
        or(lt(customerTokens.expiresAt, now), isNotNull(customerTokens.usedAt)),
      )
      .returning({ id: customerTokens.id });
    return { sessions: sessions.length, tokens: tokens.length };
  }

  async createToken(
    accountId: string,
    purpose: CustomerTokenPurpose,
    ttlMs: number,
    context?: string,
  ): Promise<string> {
    const token = createCustomerToken();
    const now = new Date();
    let preservedContext = context;
    if (preservedContext === undefined) {
      const [prior] = await getDatabase()
        .select({ context: customerTokens.context })
        .from(customerTokens)
        .where(
          and(
            eq(customerTokens.accountId, accountId),
            eq(customerTokens.purpose, purpose),
            isNull(customerTokens.usedAt),
          ),
        )
        .orderBy(customerTokens.createdAt)
        .limit(1);
      preservedContext = prior?.context ?? undefined;
    }
    await getDatabase()
      .delete(customerTokens)
      .where(
        and(
          eq(customerTokens.accountId, accountId),
          eq(customerTokens.purpose, purpose),
          isNull(customerTokens.usedAt),
        ),
      );
    await getDatabase()
      .insert(customerTokens)
      .values({
        accountId,
        purpose,
        tokenHash: hashCustomerToken(token),
        context: preservedContext ?? null,
        expiresAt: new Date(now.getTime() + ttlMs),
      });
    return token;
  }

  async consumeToken(
    token: string,
    purpose: CustomerTokenPurpose,
  ): Promise<ConsumedCustomerToken | null> {
    const now = new Date();
    const [row] = await getDatabase()
      .update(customerTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(customerTokens.tokenHash, hashCustomerToken(token)),
          eq(customerTokens.purpose, purpose),
          isNull(customerTokens.usedAt),
          gt(customerTokens.expiresAt, now),
        ),
      )
      .returning({
        accountId: customerTokens.accountId,
        context: customerTokens.context,
      });
    return row
      ? { accountId: row.accountId, context: row.context ?? undefined }
      : null;
  }

  async verifyPassword(
    email: string,
    password: string,
  ): Promise<CustomerAccount | null> {
    const [row] = await getDatabase()
      .select()
      .from(customerAccounts)
      .where(eq(customerAccounts.email, normalizeCustomerEmail(email)))
      .limit(1);
    const passwordHash = row?.passwordHash ?? DUMMY_CUSTOMER_PASSWORD_HASH;
    const valid = await verifyCustomerPassword(password, passwordHash);
    if (!row || !valid) return null;
    return pgAccount(row);
  }
}

export type CustomerAccountStoreWithPassword = CustomerAccountStore & {
  verifyPassword(
    email: string,
    password: string,
  ): Promise<CustomerAccount | null>;
};

export function getCustomerAccountStore(): CustomerAccountStoreWithPassword {
  return (
    process.env.DATABASE_URL
      ? new PostgresCustomerAccountStore()
      : new SqliteCustomerAccountStore()
  ) as CustomerAccountStoreWithPassword;
}
