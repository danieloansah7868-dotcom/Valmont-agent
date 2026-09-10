import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  studioShopAgentSessions,
  studioShopAgentSettings,
  studioShopAgentTokens,
  studioShopAgents,
  studioShopWalletEntries,
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
  BadRequestError,
  ShopAgentCapError,
  ShopAgentExistsError,
  WalletInsufficientError,
} from "@/lib/api-errors";
import { MAX_AGENT_DISCOUNT_PERCENT } from "./pricing";

export { MAX_AGENT_DISCOUNT_PERCENT } from "./pricing";

export type ShopAgentStatus = "invited" | "active" | "disabled";
export type ShopAgentTokenPurpose = "invite" | "reset";
export type ShopWalletEntryKind =
  "credit" | "deduct" | "purchase" | "refund" | "topup_online";

export const MAX_SHOP_AGENTS_PER_WEBSITE = 50;
export const SHOP_AGENT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SHOP_AGENT_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
export const SHOP_AGENT_RESET_TTL_MS = 60 * 60 * 1000;
export const MAX_WALLET_ENTRY_MINOR = 500_000;

export interface ShopAgent {
  id: string;
  draftId: string;
  email: string;
  name: string;
  phone: string | null;
  status: ShopAgentStatus;
  balance: number;
  hasPassword: boolean;
  invitedBy: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WalletEntry {
  id: string;
  draftId: string;
  agentId: string;
  kind: ShopWalletEntryKind;
  amount: number;
  balanceAfter: number;
  orderId: string | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export interface ShopAgentInvite {
  agent: ShopAgent;
  token: string;
  expiresAt: string;
}

export interface ShopAgentSession {
  agent: ShopAgent;
  expiresAt: string;
}

export interface ShopAgentStore {
  createInvite(input: {
    draftId: string;
    email: string;
    name: string;
    phone?: string;
    invitedBy: string;
  }): Promise<ShopAgent>;
  createInviteToken(
    agentId: string,
  ): Promise<{ token: string; expiresAt: string }>;
  peekInvite(token: string): Promise<ShopAgent | null>;
  acceptInvite(
    token: string,
    name: string,
    password: string,
  ): Promise<ShopAgent | null>;
  verifyPassword(
    draftId: string,
    email: string,
    password: string,
  ): Promise<ShopAgent | null>;
  createSession(agentId: string): Promise<{ token: string; expiresAt: string }>;
  getSession(token: string): Promise<ShopAgentSession | null>;
  revokeSession(token: string): Promise<void>;
  revokeAllSessions(agentId: string): Promise<void>;
  createResetToken(
    agentId: string,
  ): Promise<{ token: string; expiresAt: string }>;
  consumeResetToken(token: string): Promise<string | null>;
  updatePassword(agentId: string, password: string): Promise<void>;
  setStatus(
    agentId: string,
    status: ShopAgentStatus,
  ): Promise<ShopAgent | null>;
  touchLastLogin(agentId: string): Promise<void>;
  listForDraft(draftId: string): Promise<ShopAgent[]>;
  countForDraft(draftId: string): Promise<number>;
  getById(id: string): Promise<ShopAgent | null>;
  getByEmail(draftId: string, email: string): Promise<ShopAgent | null>;
  deleteForDraft(draftId: string): Promise<number>;
  purgeExpired(now?: Date): Promise<{ sessions: number; tokens: number }>;
  credit(input: {
    agentId: string;
    amountMinor: number;
    note?: string;
    createdBy: string;
  }): Promise<WalletEntry>;
  deduct(input: {
    agentId: string;
    amountMinor: number;
    note?: string;
    createdBy: string;
  }): Promise<WalletEntry>;
  listEntries(agentId: string, limit?: number): Promise<WalletEntry[]>;
  getSettings(draftId: string): Promise<{ discountPercent: number }>;
  setDiscountPercent(
    draftId: string,
    pct: number,
  ): Promise<{ discountPercent: number }>;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function statusOf(value: string): ShopAgentStatus {
  return value === "active" || value === "disabled" ? value : "invited";
}

function kindOf(value: string): ShopWalletEntryKind {
  if (
    value === "credit" ||
    value === "deduct" ||
    value === "purchase" ||
    value === "refund" ||
    value === "topup_online"
  )
    return value;
  return "credit";
}

function toAgent(row: {
  id: string;
  draft_id: string;
  email: string;
  name: string;
  phone: string | null;
  status: string;
  password_hash: string | null;
  balance_minor: number | bigint;
  invited_by: string | null;
  last_login_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}): ShopAgent {
  return {
    id: row.id,
    draftId: row.draft_id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    status: statusOf(row.status),
    balance: Number(row.balance_minor) / 100,
    hasPassword: Boolean(row.password_hash),
    invitedBy: row.invited_by,
    lastLoginAt: iso(row.last_login_at),
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? "",
  };
}

function toEntry(row: {
  id: string;
  draft_id: string;
  agent_id: string;
  kind: string;
  amount_minor: number | bigint;
  balance_after_minor: number | bigint;
  order_id: string | null;
  note: string | null;
  created_by: string;
  created_at: Date | string;
}): WalletEntry {
  return {
    id: row.id,
    draftId: row.draft_id,
    agentId: row.agent_id,
    kind: kindOf(row.kind),
    amount: Number(row.amount_minor) / 100,
    balanceAfter: Number(row.balance_after_minor) / 100,
    orderId: row.order_id,
    note: row.note,
    createdBy: row.created_by,
    createdAt: iso(row.created_at) ?? "",
  };
}

function sortAgents(agents: ShopAgent[]): ShopAgent[] {
  return [...agents].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = "code" in current ? String(current.code) : "";
    if (code === "23505" || /unique|duplicate/i.test(current.message))
      return true;
    current = current.cause;
  }
  return false;
}

function assertWalletAmount(amountMinor: number): void {
  if (
    !Number.isSafeInteger(amountMinor) ||
    amountMinor < 1 ||
    amountMinor > MAX_WALLET_ENTRY_MINOR
  ) {
    throw new BadRequestError(
      "Wallet amounts must be whole pesewas up to GHS 5,000.",
    );
  }
}

function assertDiscount(pct: number): void {
  if (!Number.isInteger(pct) || pct < 0 || pct > MAX_AGENT_DISCOUNT_PERCENT) {
    throw new BadRequestError(
      "Agent discount must be an integer from 0 to 50.",
    );
  }
}

export function ensureShopAgentSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS studio_shop_agents (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      status TEXT NOT NULL DEFAULT 'invited',
      password_hash TEXT,
      balance_minor INTEGER NOT NULL DEFAULT 0,
      invited_by TEXT,
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS studio_shop_agents_draft_email_unique ON studio_shop_agents(draft_id, email);
    CREATE INDEX IF NOT EXISTS studio_shop_agents_draft_idx ON studio_shop_agents(draft_id);
    CREATE TABLE IF NOT EXISTS studio_shop_agent_sessions (
      token_hash TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES studio_shop_agents(id) ON DELETE CASCADE,
      draft_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_shop_agent_sessions_agent_idx ON studio_shop_agent_sessions(agent_id);
    CREATE TABLE IF NOT EXISTS studio_shop_agent_tokens (
      token_hash TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES studio_shop_agents(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_shop_agent_tokens_agent_idx ON studio_shop_agent_tokens(agent_id);
    CREATE TABLE IF NOT EXISTS studio_shop_wallet_entries (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES studio_shop_agents(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      balance_after_minor INTEGER NOT NULL,
      order_id TEXT,
      note TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS studio_shop_wallet_entries_agent_created_idx ON studio_shop_wallet_entries(agent_id, created_at);
    CREATE INDEX IF NOT EXISTS studio_shop_wallet_entries_draft_created_idx ON studio_shop_wallet_entries(draft_id, created_at);
    CREATE TABLE IF NOT EXISTS studio_shop_agent_settings (
      draft_id TEXT PRIMARY KEY,
      discount_percent INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
}

interface SqliteAgentRow {
  id: string;
  draft_id: string;
  email: string;
  name: string;
  phone: string | null;
  status: string;
  password_hash: string | null;
  balance_minor: number | bigint;
  invited_by: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}
interface SqliteSessionRow {
  token_hash: string;
  agent_id: string;
  draft_id: string;
  expires_at: string;
  created_at: string;
}
interface SqliteEntryRow {
  id: string;
  draft_id: string;
  agent_id: string;
  kind: string;
  amount_minor: number | bigint;
  balance_after_minor: number | bigint;
  order_id: string | null;
  note: string | null;
  created_by: string;
  created_at: string;
}

export class SqliteShopAgentStore implements ShopAgentStore {
  private get db(): DatabaseSync {
    const store = getSqliteChatStore();
    ensureShopAgentSchema(store.connection);
    return store.connection;
  }

  private row(id: string): SqliteAgentRow | undefined {
    return this.db
      .prepare("SELECT * FROM studio_shop_agents WHERE id = ?")
      .get(id) as unknown as SqliteAgentRow | undefined;
  }
  private rowByEmail(
    draftId: string,
    email: string,
  ): SqliteAgentRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM studio_shop_agents WHERE draft_id = ? AND email = ?",
      )
      .get(draftId, normalizeCustomerEmail(email)) as unknown as
      SqliteAgentRow | undefined;
  }
  private entry(row: unknown): WalletEntry {
    return toEntry(row as SqliteEntryRow);
  }
  private insertInvite(input: {
    draftId: string;
    email: string;
    name: string;
    phone?: string;
    invitedBy: string;
  }): ShopAgent {
    const now = new Date().toISOString();
    const id = randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO studio_shop_agents(
          id, draft_id, email, name, phone, status, password_hash, balance_minor,
          invited_by, last_login_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'invited', NULL, 0, ?, NULL, ?, ?)`,
        )
        .run(
          id,
          input.draftId,
          normalizeCustomerEmail(input.email),
          input.name,
          input.phone ?? null,
          input.invitedBy,
          now,
          now,
        );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ShopAgentExistsError();
      throw error;
    }
    const row = this.row(id);
    if (!row) throw new Error("Agent could not be created");
    return toAgent(row);
  }
  private issueToken(
    agentId: string,
    purpose: ShopAgentTokenPurpose,
    ttlMs: number,
  ): { token: string; expiresAt: string } {
    const token = createCustomerToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);
    this.db
      .prepare(
        `INSERT INTO studio_shop_agent_tokens(token_hash, agent_id, purpose, expires_at, used_at, created_at)
        VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        hashCustomerToken(token),
        agentId,
        purpose,
        expiresAt.toISOString(),
        now.toISOString(),
      );
    return { token, expiresAt: expiresAt.toISOString() };
  }
  private burnToken(
    token: string,
    purpose: ShopAgentTokenPurpose,
  ): string | null {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `UPDATE studio_shop_agent_tokens SET used_at = ?
        WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
        RETURNING agent_id`,
      )
      .get(now, hashCustomerToken(token), purpose, now) as unknown as
      { agent_id: string } | undefined;
    return row?.agent_id ?? null;
  }
  private validateAgent(agentId: string): SqliteAgentRow {
    const row = this.row(agentId);
    if (!row) throw new Error("Shop agent no longer exists");
    return row;
  }
  private wallet(
    input: {
      agentId: string;
      amountMinor: number;
      note?: string;
      createdBy: string;
    },
    deduct: boolean,
  ): WalletEntry {
    assertWalletAmount(input.amountMinor);
    const db = this.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      const agent = this.validateAgent(input.agentId);
      const signed = deduct ? -input.amountMinor : input.amountMinor;
      const updated = deduct
        ? (db
            .prepare(
              "UPDATE studio_shop_agents SET balance_minor = balance_minor - ?, updated_at = ? WHERE id = ? AND balance_minor >= ? RETURNING balance_minor, draft_id",
            )
            .get(
              input.amountMinor,
              new Date().toISOString(),
              input.agentId,
              input.amountMinor,
            ) as { balance_minor: number; draft_id: string } | undefined)
        : (db
            .prepare(
              "UPDATE studio_shop_agents SET balance_minor = balance_minor + ?, updated_at = ? WHERE id = ? RETURNING balance_minor, draft_id",
            )
            .get(input.amountMinor, new Date().toISOString(), input.agentId) as
            { balance_minor: number; draft_id: string } | undefined);
      if (!updated) throw new WalletInsufficientError();
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      db.prepare(
        `INSERT INTO studio_shop_wallet_entries(
        id, draft_id, agent_id, kind, amount_minor, balance_after_minor,
        order_id, note, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      ).run(
        id,
        updated.draft_id ?? agent.draft_id,
        input.agentId,
        deduct ? "deduct" : "credit",
        signed,
        updated.balance_minor,
        input.note ?? null,
        input.createdBy,
        createdAt,
      );
      const entry = db
        .prepare("SELECT * FROM studio_shop_wallet_entries WHERE id = ?")
        .get(id);
      db.exec("COMMIT");
      return this.entry(entry);
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* preserve original error */
      }
      throw error;
    }
  }

  async createInvite(input: {
    draftId: string;
    email: string;
    name: string;
    phone?: string;
    invitedBy: string;
  }): Promise<ShopAgent> {
    if (
      (await this.countForDraft(input.draftId)) >= MAX_SHOP_AGENTS_PER_WEBSITE
    )
      throw new ShopAgentCapError();
    return this.insertInvite(input);
  }
  async createInviteToken(
    agentId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    this.validateAgent(agentId);
    return this.issueToken(agentId, "invite", SHOP_AGENT_INVITE_TTL_MS);
  }
  async peekInvite(token: string): Promise<ShopAgent | null> {
    const now = new Date().toISOString();
    const live = this.db
      .prepare(
        `SELECT agent_id FROM studio_shop_agent_tokens
      WHERE token_hash = ? AND purpose = 'invite' AND used_at IS NULL AND expires_at > ?`,
      )
      .get(hashCustomerToken(token), now) as unknown as
      { agent_id: string } | undefined;
    if (!live) return null;
    const row = this.row(live.agent_id);
    return row && row.status === "invited" ? toAgent(row) : null;
  }
  async acceptInvite(
    token: string,
    name: string,
    password: string,
  ): Promise<ShopAgent | null> {
    const agentId = this.burnToken(token, "invite");
    if (!agentId) return null;
    const row = this.row(agentId);
    if (!row || row.status !== "invited") return null;
    const passwordHash = await hashCustomerPassword(password);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE studio_shop_agents SET name = ?, password_hash = ?, status = 'active', updated_at = ?
      WHERE id = ? AND status = 'invited'`,
      )
      .run(name, passwordHash, now, agentId);
    this.db
      .prepare(
        "DELETE FROM studio_shop_agent_tokens WHERE agent_id = ? AND purpose = 'invite' AND used_at IS NULL",
      )
      .run(agentId);
    const updated = this.row(agentId);
    return updated ? toAgent(updated) : null;
  }
  async verifyPassword(
    draftId: string,
    email: string,
    password: string,
  ): Promise<ShopAgent | null> {
    const row = this.rowByEmail(draftId, email);
    const usable = Boolean(row && row.status === "active" && row.password_hash);
    const hash =
      usable && row?.password_hash
        ? row.password_hash
        : DUMMY_CUSTOMER_PASSWORD_HASH;
    const ok = await verifyCustomerPassword(password, hash);
    if (!ok || !usable || !row) return null;
    return toAgent(row);
  }
  async createSession(
    agentId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const agent = this.validateAgent(agentId);
    if (agent.status !== "active") throw new Error("Shop agent is not active");
    const token = createCustomerToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SHOP_AGENT_SESSION_TTL_MS);
    this.db
      .prepare(
        `INSERT INTO studio_shop_agent_sessions(token_hash, agent_id, draft_id, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        hashCustomerToken(token),
        agentId,
        agent.draft_id,
        expiresAt.toISOString(),
        now.toISOString(),
      );
    return { token, expiresAt: expiresAt.toISOString() };
  }
  async getSession(token: string): Promise<ShopAgentSession | null> {
    const now = new Date().toISOString();
    const session = this.db
      .prepare(
        "SELECT * FROM studio_shop_agent_sessions WHERE token_hash = ? AND expires_at > ?",
      )
      .get(hashCustomerToken(token), now) as unknown as
      SqliteSessionRow | undefined;
    if (!session) return null;
    const row = this.row(session.agent_id);
    if (!row || row.status !== "active" || row.draft_id !== session.draft_id)
      return null;
    return { agent: toAgent(row), expiresAt: session.expires_at };
  }
  async revokeSession(token: string): Promise<void> {
    this.db
      .prepare("DELETE FROM studio_shop_agent_sessions WHERE token_hash = ?")
      .run(hashCustomerToken(token));
  }
  async revokeAllSessions(agentId: string): Promise<void> {
    this.db
      .prepare("DELETE FROM studio_shop_agent_sessions WHERE agent_id = ?")
      .run(agentId);
  }
  async createResetToken(
    agentId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const agent = this.validateAgent(agentId);
    if (agent.status !== "active") throw new Error("Shop agent is not active");
    return this.issueToken(agentId, "reset", SHOP_AGENT_RESET_TTL_MS);
  }
  async consumeResetToken(token: string): Promise<string | null> {
    const agentId = this.burnToken(token, "reset");
    if (!agentId) return null;
    const row = this.row(agentId);
    return row && row.status === "active" ? agentId : null;
  }
  async updatePassword(agentId: string, password: string): Promise<void> {
    this.validateAgent(agentId);
    this.db
      .prepare(
        "UPDATE studio_shop_agents SET password_hash = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        await hashCustomerPassword(password),
        new Date().toISOString(),
        agentId,
      );
  }
  async setStatus(
    agentId: string,
    status: ShopAgentStatus,
  ): Promise<ShopAgent | null> {
    if (status !== "active" && status !== "disabled")
      throw new BadRequestError("Invalid agent status.");
    const row = this.row(agentId);
    if (!row) return null;
    this.db
      .prepare(
        "UPDATE studio_shop_agents SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, new Date().toISOString(), agentId);
    if (status === "disabled") await this.revokeAllSessions(agentId);
    return this.getById(agentId);
  }
  async touchLastLogin(agentId: string): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE studio_shop_agents SET last_login_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(now, now, agentId);
  }
  async listForDraft(draftId: string): Promise<ShopAgent[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM studio_shop_agents WHERE draft_id = ? ORDER BY created_at ASC",
      )
      .all(draftId) as unknown as SqliteAgentRow[];
    return sortAgents(rows.map(toAgent));
  }
  async countForDraft(draftId: string): Promise<number> {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM studio_shop_agents WHERE draft_id = ?",
      )
      .get(draftId) as unknown as { n: number | bigint };
    return Number(row.n);
  }
  async getById(id: string): Promise<ShopAgent | null> {
    const row = this.row(id);
    return row ? toAgent(row) : null;
  }
  async getByEmail(draftId: string, email: string): Promise<ShopAgent | null> {
    const row = this.rowByEmail(draftId, email);
    return row ? toAgent(row) : null;
  }
  async deleteForDraft(draftId: string): Promise<number> {
    const db = this.db;
    db.prepare(
      "DELETE FROM studio_shop_agent_sessions WHERE agent_id IN (SELECT id FROM studio_shop_agents WHERE draft_id = ?)",
    ).run(draftId);
    db.prepare(
      "DELETE FROM studio_shop_agent_tokens WHERE agent_id IN (SELECT id FROM studio_shop_agents WHERE draft_id = ?)",
    ).run(draftId);
    db.prepare("DELETE FROM studio_shop_wallet_entries WHERE draft_id = ?").run(
      draftId,
    );
    db.prepare("DELETE FROM studio_shop_agent_settings WHERE draft_id = ?").run(
      draftId,
    );
    const result = db
      .prepare("DELETE FROM studio_shop_agents WHERE draft_id = ?")
      .run(draftId);
    return Number(result.changes);
  }
  async purgeExpired(
    now = new Date(),
  ): Promise<{ sessions: number; tokens: number }> {
    const cutoff = now.toISOString();
    const sessions = this.db
      .prepare("DELETE FROM studio_shop_agent_sessions WHERE expires_at <= ?")
      .run(cutoff);
    const tokens = this.db
      .prepare(
        "DELETE FROM studio_shop_agent_tokens WHERE expires_at <= ? OR used_at IS NOT NULL",
      )
      .run(cutoff);
    return {
      sessions: Number(sessions.changes),
      tokens: Number(tokens.changes),
    };
  }
  async credit(input: {
    agentId: string;
    amountMinor: number;
    note?: string;
    createdBy: string;
  }): Promise<WalletEntry> {
    return this.wallet(input, false);
  }
  async deduct(input: {
    agentId: string;
    amountMinor: number;
    note?: string;
    createdBy: string;
  }): Promise<WalletEntry> {
    return this.wallet(input, true);
  }
  async listEntries(agentId: string, limit = 100): Promise<WalletEntry[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = this.db
      .prepare(
        "SELECT * FROM studio_shop_wallet_entries WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(agentId, safeLimit) as unknown as SqliteEntryRow[];
    return rows.map(toEntry);
  }
  async getSettings(draftId: string): Promise<{ discountPercent: number }> {
    const row = this.db
      .prepare(
        "SELECT discount_percent FROM studio_shop_agent_settings WHERE draft_id = ?",
      )
      .get(draftId) as unknown as { discount_percent: number } | undefined;
    return { discountPercent: row?.discount_percent ?? 0 };
  }
  async setDiscountPercent(
    draftId: string,
    pct: number,
  ): Promise<{ discountPercent: number }> {
    assertDiscount(pct);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO studio_shop_agent_settings(draft_id, discount_percent, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(draft_id) DO UPDATE SET discount_percent = excluded.discount_percent, updated_at = excluded.updated_at`,
      )
      .run(draftId, pct, now);
    return { discountPercent: pct };
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

type PgAgentRow = typeof studioShopAgents.$inferSelect;
type PgEntryRow = typeof studioShopWalletEntries.$inferSelect;

function pgAgent(row: PgAgentRow): ShopAgent {
  return toAgent({
    id: row.id,
    draft_id: row.draftId,
    email: row.email,
    name: row.name,
    phone: row.phone,
    status: row.status,
    password_hash: row.passwordHash,
    balance_minor: row.balanceMinor,
    invited_by: row.invitedBy,
    last_login_at: row.lastLoginAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
}
function pgEntry(row: PgEntryRow): WalletEntry {
  return toEntry({
    id: row.id,
    draft_id: row.draftId,
    agent_id: row.agentId,
    kind: row.kind,
    amount_minor: row.amountMinor,
    balance_after_minor: row.balanceAfterMinor,
    order_id: row.orderId,
    note: row.note,
    created_by: row.createdBy,
    created_at: row.createdAt,
  });
}

export class PostgresShopAgentStore implements ShopAgentStore {
  private async row(id: string): Promise<PgAgentRow | undefined> {
    const [row] = await getDatabase()
      .select()
      .from(studioShopAgents)
      .where(eq(studioShopAgents.id, id))
      .limit(1);
    return row;
  }
  private async rowByEmail(
    draftId: string,
    email: string,
  ): Promise<PgAgentRow | undefined> {
    const [row] = await getDatabase()
      .select()
      .from(studioShopAgents)
      .where(
        and(
          eq(studioShopAgents.draftId, draftId),
          eq(studioShopAgents.email, normalizeCustomerEmail(email)),
        ),
      )
      .limit(1);
    return row;
  }
  private async insertInvite(input: {
    draftId: string;
    email: string;
    name: string;
    phone?: string;
    invitedBy: string;
  }): Promise<ShopAgent> {
    try {
      const [row] = await getDatabase()
        .insert(studioShopAgents)
        .values({
          draftId: input.draftId,
          email: normalizeCustomerEmail(input.email),
          name: input.name,
          phone: input.phone,
          status: "invited",
          invitedBy: input.invitedBy,
        })
        .returning();
      if (!row) throw new Error("Agent could not be created");
      return pgAgent(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ShopAgentExistsError();
      throw error;
    }
  }
  private async issueToken(
    agentId: string,
    purpose: ShopAgentTokenPurpose,
    ttlMs: number,
  ): Promise<{ token: string; expiresAt: string }> {
    const token = createCustomerToken();
    const expiresAt = new Date(Date.now() + ttlMs);
    await getDatabase()
      .insert(studioShopAgentTokens)
      .values({
        tokenHash: hashCustomerToken(token),
        agentId,
        purpose,
        expiresAt,
      });
    return { token, expiresAt: expiresAt.toISOString() };
  }
  private async burnToken(
    token: string,
    purpose: ShopAgentTokenPurpose,
  ): Promise<string | null> {
    const [row] = await getDatabase()
      .update(studioShopAgentTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(studioShopAgentTokens.tokenHash, hashCustomerToken(token)),
          eq(studioShopAgentTokens.purpose, purpose),
          isNull(studioShopAgentTokens.usedAt),
          gt(studioShopAgentTokens.expiresAt, new Date()),
        ),
      )
      .returning({ agentId: studioShopAgentTokens.agentId });
    return row?.agentId ?? null;
  }
  private async validateAgent(agentId: string): Promise<PgAgentRow> {
    const row = await this.row(agentId);
    if (!row) throw new Error("Shop agent no longer exists");
    return row;
  }
  async createInvite(input: {
    draftId: string;
    email: string;
    name: string;
    phone?: string;
    invitedBy: string;
  }): Promise<ShopAgent> {
    if (
      (await this.countForDraft(input.draftId)) >= MAX_SHOP_AGENTS_PER_WEBSITE
    )
      throw new ShopAgentCapError();
    return this.insertInvite(input);
  }
  async createInviteToken(
    agentId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    await this.validateAgent(agentId);
    return this.issueToken(agentId, "invite", SHOP_AGENT_INVITE_TTL_MS);
  }
  async peekInvite(token: string): Promise<ShopAgent | null> {
    const [live] = await getDatabase()
      .select({ agentId: studioShopAgentTokens.agentId })
      .from(studioShopAgentTokens)
      .where(
        and(
          eq(studioShopAgentTokens.tokenHash, hashCustomerToken(token)),
          eq(studioShopAgentTokens.purpose, "invite"),
          isNull(studioShopAgentTokens.usedAt),
          gt(studioShopAgentTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!live) return null;
    const row = await this.row(live.agentId);
    return row && row.status === "invited" ? pgAgent(row) : null;
  }
  async acceptInvite(
    token: string,
    name: string,
    password: string,
  ): Promise<ShopAgent | null> {
    const agentId = await this.burnToken(token, "invite");
    if (!agentId) return null;
    const row = await this.row(agentId);
    if (!row || row.status !== "invited") return null;
    await getDatabase()
      .update(studioShopAgents)
      .set({
        name,
        passwordHash: await hashCustomerPassword(password),
        status: "active",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(studioShopAgents.id, agentId),
          eq(studioShopAgents.status, "invited"),
        ),
      );
    await getDatabase()
      .delete(studioShopAgentTokens)
      .where(
        and(
          eq(studioShopAgentTokens.agentId, agentId),
          eq(studioShopAgentTokens.purpose, "invite"),
          isNull(studioShopAgentTokens.usedAt),
        ),
      );
    return this.getById(agentId);
  }
  async verifyPassword(
    draftId: string,
    email: string,
    password: string,
  ): Promise<ShopAgent | null> {
    const row = await this.rowByEmail(draftId, email);
    const usable = Boolean(row && row.status === "active" && row.passwordHash);
    const hash =
      usable && row?.passwordHash
        ? row.passwordHash
        : DUMMY_CUSTOMER_PASSWORD_HASH;
    const ok = await verifyCustomerPassword(password, hash);
    if (!ok || !usable || !row) return null;
    return pgAgent(row);
  }
  async createSession(
    agentId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const agent = await this.validateAgent(agentId);
    if (agent.status !== "active") throw new Error("Shop agent is not active");
    const token = createCustomerToken();
    const expiresAt = new Date(Date.now() + SHOP_AGENT_SESSION_TTL_MS);
    await getDatabase()
      .insert(studioShopAgentSessions)
      .values({
        tokenHash: hashCustomerToken(token),
        agentId,
        draftId: agent.draftId,
        expiresAt,
      });
    return { token, expiresAt: expiresAt.toISOString() };
  }
  async getSession(token: string): Promise<ShopAgentSession | null> {
    const [session] = await getDatabase()
      .select()
      .from(studioShopAgentSessions)
      .where(
        and(
          eq(studioShopAgentSessions.tokenHash, hashCustomerToken(token)),
          gt(studioShopAgentSessions.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!session) return null;
    const row = await this.row(session.agentId);
    if (!row || row.status !== "active" || row.draftId !== session.draftId)
      return null;
    return { agent: pgAgent(row), expiresAt: session.expiresAt.toISOString() };
  }
  async revokeSession(token: string): Promise<void> {
    await getDatabase()
      .delete(studioShopAgentSessions)
      .where(eq(studioShopAgentSessions.tokenHash, hashCustomerToken(token)));
  }
  async revokeAllSessions(agentId: string): Promise<void> {
    await getDatabase()
      .delete(studioShopAgentSessions)
      .where(eq(studioShopAgentSessions.agentId, agentId));
  }
  async createResetToken(
    agentId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    const agent = await this.validateAgent(agentId);
    if (agent.status !== "active") throw new Error("Shop agent is not active");
    return this.issueToken(agentId, "reset", SHOP_AGENT_RESET_TTL_MS);
  }
  async consumeResetToken(token: string): Promise<string | null> {
    const agentId = await this.burnToken(token, "reset");
    if (!agentId) return null;
    const row = await this.row(agentId);
    return row && row.status === "active" ? agentId : null;
  }
  async updatePassword(agentId: string, password: string): Promise<void> {
    await this.validateAgent(agentId);
    await getDatabase()
      .update(studioShopAgents)
      .set({
        passwordHash: await hashCustomerPassword(password),
        updatedAt: new Date(),
      })
      .where(eq(studioShopAgents.id, agentId));
  }
  async setStatus(
    agentId: string,
    status: ShopAgentStatus,
  ): Promise<ShopAgent | null> {
    if (status !== "active" && status !== "disabled")
      throw new BadRequestError("Invalid agent status.");
    const [row] = await getDatabase()
      .update(studioShopAgents)
      .set({ status, updatedAt: new Date() })
      .where(eq(studioShopAgents.id, agentId))
      .returning();
    if (!row) return null;
    if (status === "disabled") await this.revokeAllSessions(agentId);
    return pgAgent(row);
  }
  async touchLastLogin(agentId: string): Promise<void> {
    const now = new Date();
    await getDatabase()
      .update(studioShopAgents)
      .set({ lastLoginAt: now, updatedAt: now })
      .where(eq(studioShopAgents.id, agentId));
  }
  async listForDraft(draftId: string): Promise<ShopAgent[]> {
    const rows = await getDatabase()
      .select()
      .from(studioShopAgents)
      .where(eq(studioShopAgents.draftId, draftId))
      .orderBy(asc(studioShopAgents.createdAt));
    return sortAgents(rows.map(pgAgent));
  }
  async countForDraft(draftId: string): Promise<number> {
    const [row] = await getDatabase()
      .select({ n: sql<number>`count(*)` })
      .from(studioShopAgents)
      .where(eq(studioShopAgents.draftId, draftId));
    return Number(row?.n ?? 0);
  }
  async getById(id: string): Promise<ShopAgent | null> {
    const row = await this.row(id);
    return row ? pgAgent(row) : null;
  }
  async getByEmail(draftId: string, email: string): Promise<ShopAgent | null> {
    const row = await this.rowByEmail(draftId, email);
    return row ? pgAgent(row) : null;
  }
  async deleteForDraft(draftId: string): Promise<number> {
    const db = getDatabase();
    await db
      .delete(studioShopAgentSettings)
      .where(eq(studioShopAgentSettings.draftId, draftId));
    const deleted = await db
      .delete(studioShopAgents)
      .where(eq(studioShopAgents.draftId, draftId))
      .returning({ id: studioShopAgents.id });
    return deleted.length;
  }
  async purgeExpired(
    now = new Date(),
  ): Promise<{ sessions: number; tokens: number }> {
    const db = getDatabase();
    const sessions = await db
      .delete(studioShopAgentSessions)
      .where(lte(studioShopAgentSessions.expiresAt, now))
      .returning({ tokenHash: studioShopAgentSessions.tokenHash });
    const tokens = await db
      .delete(studioShopAgentTokens)
      .where(
        or(
          lte(studioShopAgentTokens.expiresAt, now),
          isNotNull(studioShopAgentTokens.usedAt),
        ),
      )
      .returning({ tokenHash: studioShopAgentTokens.tokenHash });
    return { sessions: sessions.length, tokens: tokens.length };
  }
  async credit(input: {
    agentId: string;
    amountMinor: number;
    note?: string;
    createdBy: string;
  }): Promise<WalletEntry> {
    return this.wallet(input, false);
  }
  async deduct(input: {
    agentId: string;
    amountMinor: number;
    note?: string;
    createdBy: string;
  }): Promise<WalletEntry> {
    return this.wallet(input, true);
  }
  private async wallet(
    input: {
      agentId: string;
      amountMinor: number;
      note?: string;
      createdBy: string;
    },
    deduct: boolean,
  ): Promise<WalletEntry> {
    assertWalletAmount(input.amountMinor);
    return getDatabase().transaction(async (tx) => {
      const [agent] = await tx
        .select()
        .from(studioShopAgents)
        .where(eq(studioShopAgents.id, input.agentId))
        .limit(1);
      if (!agent) throw new Error("Shop agent no longer exists");
      const change = deduct ? -input.amountMinor : input.amountMinor;
      const balanceExpression = deduct
        ? sql`${studioShopAgents.balanceMinor} - ${input.amountMinor}`
        : sql`${studioShopAgents.balanceMinor} + ${input.amountMinor}`;
      const updated = await tx
        .update(studioShopAgents)
        .set({
          balanceMinor: balanceExpression,
          updatedAt: new Date(),
        })
        .where(
          deduct
            ? and(
                eq(studioShopAgents.id, input.agentId),
                gte(studioShopAgents.balanceMinor, input.amountMinor),
              )
            : eq(studioShopAgents.id, input.agentId),
        )
        .returning({ balanceMinor: studioShopAgents.balanceMinor });
      if (!updated[0]) throw new WalletInsufficientError();
      const [entry] = await tx
        .insert(studioShopWalletEntries)
        .values({
          draftId: agent.draftId,
          agentId: input.agentId,
          kind: deduct ? "deduct" : "credit",
          amountMinor: change,
          balanceAfterMinor: updated[0].balanceMinor,
          note: input.note,
          createdBy: input.createdBy,
        })
        .returning();
      if (!entry) throw new Error("Wallet entry could not be written");
      return pgEntry(entry);
    });
  }
  async listEntries(agentId: string, limit = 100): Promise<WalletEntry[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = await getDatabase()
      .select()
      .from(studioShopWalletEntries)
      .where(eq(studioShopWalletEntries.agentId, agentId))
      .orderBy(
        desc(studioShopWalletEntries.createdAt),
        desc(studioShopWalletEntries.id),
      )
      .limit(safeLimit);
    return rows.map(pgEntry);
  }
  async getSettings(draftId: string): Promise<{ discountPercent: number }> {
    const [row] = await getDatabase()
      .select()
      .from(studioShopAgentSettings)
      .where(eq(studioShopAgentSettings.draftId, draftId))
      .limit(1);
    return { discountPercent: row?.discountPercent ?? 0 };
  }
  async setDiscountPercent(
    draftId: string,
    pct: number,
  ): Promise<{ discountPercent: number }> {
    assertDiscount(pct);
    const [row] = await getDatabase()
      .insert(studioShopAgentSettings)
      .values({ draftId, discountPercent: pct, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: studioShopAgentSettings.draftId,
        set: { discountPercent: pct, updatedAt: new Date() },
      })
      .returning();
    return { discountPercent: row?.discountPercent ?? pct };
  }
}

let overrideForTests: ShopAgentStore | null = null;

export function getShopAgentStore(): ShopAgentStore {
  if (overrideForTests) return overrideForTests;
  return process.env.DATABASE_URL
    ? new PostgresShopAgentStore()
    : new SqliteShopAgentStore();
}

export function setShopAgentStoreForTests(store: ShopAgentStore | null): void {
  overrideForTests = store;
}
