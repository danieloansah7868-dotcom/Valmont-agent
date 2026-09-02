import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { studioDomains } from "@/db/schema";
import { getSqliteChatStore } from "@/lib/chat-store";

export const DOMAIN_STATUS = ["not_set", "pending", "active", "error"] as const;
export type DomainStatus = (typeof DOMAIN_STATUS)[number];

/**
 * A custom domain attached to a Studio website.
 *
 * `verification_token` is the per-draft ownership proof: the owner publishes
 * it as a DNS TXT record and the domain is served only once that record AND
 * the CNAME both resolve. Without the proof, anybody could point a hostname
 * they do not control — or a dangling CNAME they found — at this platform
 * and have another merchant's site (or a phishing page) served under it.
 */
export interface DomainRow {
  draft_id: string;
  owner_id: string;
  hostname: string;
  status: DomainStatus;
  verification_token: string | null;
  verified_at: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

/** DNS name under the customer's hostname that must carry the TXT proof. */
export const DOMAIN_VERIFICATION_LABEL = "_valmont-verify";
/** Prefix of the TXT record value, so unrelated TXT records are ignored. */
export const DOMAIN_VERIFICATION_PREFIX = "valmont-verify=";

/** Where the TXT record lives for a hostname. */
export function verificationRecordName(hostname: string): string {
  return `${DOMAIN_VERIFICATION_LABEL}.${hostname}`;
}

/** The exact TXT value the owner must publish. */
export function verificationRecordValue(token: string): string {
  return `${DOMAIN_VERIFICATION_PREFIX}${token}`;
}

/** 32 hex chars from 16 random bytes: unguessable, DNS-safe. */
export function newVerificationToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * A conservative public-hostname rule: two or more DNS labels of letters,
 * digits and inner hyphens, an alphabetic TLD, no trailing dot, total length
 * within the 253-octet limit. Deliberately rejects IP literals, `localhost`,
 * single labels, underscores and anything that is not a bare hostname (no
 * scheme, port, path or userinfo) — those can never be a legitimate customer
 * domain and several would let the DNS check be pointed at internal names.
 */
const HOSTNAME_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function normalizeHostname(input: string): string | null {
  const value = input.trim().toLowerCase().replace(/\.$/, "");
  if (value.length === 0 || value.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(value)) return null;
  const labels = value.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((label) => HOSTNAME_LABEL.test(label))) return null;
  const tld = labels[labels.length - 1]!;
  if (!/^[a-z]{2,63}$/.test(tld)) return null;
  if (value === "localhost" || value.endsWith(".localhost")) return null;
  if (value.endsWith(".local") || value.endsWith(".internal")) return null;
  return value;
}

export function ensureDomainsSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS studio_domains (
      draft_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      hostname TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'not_set',
      verification_token TEXT,
      verified_at TEXT,
      last_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const existing = new Set(
    (
      db.prepare("PRAGMA table_info(studio_domains)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
  for (const column of [
    "verification_token",
    "verified_at",
    "last_checked_at",
  ]) {
    if (!existing.has(column)) {
      db.exec(`ALTER TABLE studio_domains ADD COLUMN ${column} TEXT`);
    }
  }
}

export interface SetDomainInput {
  draftId: string;
  ownerId: string;
  hostname: string;
  status: DomainStatus;
  verificationToken: string;
  verifiedAt?: string | null;
  lastCheckedAt?: string | null;
}

export interface DomainStore {
  getDomain(draftId: string): Promise<DomainRow | null>;
  getDomainsForOwner(ownerId: string): Promise<DomainRow[]>;
  getDomainByHostname(hostname: string): Promise<DomainRow | null>;
  setDomain(input: SetDomainInput): Promise<void>;
  updateStatus(
    draftId: string,
    status: DomainStatus,
    check?: { verifiedAt?: string | null; lastCheckedAt?: string },
  ): Promise<void>;
  deleteDomain(draftId: string): Promise<void>;
}

export class SqliteDomainStore implements DomainStore {
  private db: DatabaseSync;

  constructor() {
    this.db = getSqliteChatStore().connection;
    ensureDomainsSchema(this.db);
  }

  async getDomain(draftId: string): Promise<DomainRow | null> {
    const row = this.db
      .prepare(`SELECT * FROM studio_domains WHERE draft_id = ?`)
      .get(draftId) as unknown as DomainRow | undefined;
    return row ?? null;
  }

  async getDomainsForOwner(ownerId: string): Promise<DomainRow[]> {
    return this.db
      .prepare(`SELECT * FROM studio_domains WHERE owner_id = ?`)
      .all(ownerId) as unknown as DomainRow[];
  }

  async getDomainByHostname(hostname: string): Promise<DomainRow | null> {
    const row = this.db
      .prepare(`SELECT * FROM studio_domains WHERE hostname = ?`)
      .get(hostname) as unknown as DomainRow | undefined;
    return row ?? null;
  }

  async setDomain(input: SetDomainInput): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO studio_domains (
           draft_id, owner_id, hostname, status, verification_token,
           verified_at, last_checked_at, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(draft_id) DO UPDATE SET
           hostname = excluded.hostname,
           status = excluded.status,
           verification_token = excluded.verification_token,
           verified_at = excluded.verified_at,
           last_checked_at = excluded.last_checked_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.draftId,
        input.ownerId,
        input.hostname,
        input.status,
        input.verificationToken,
        input.verifiedAt ?? null,
        input.lastCheckedAt ?? null,
        now,
        now,
      );
  }

  async updateStatus(
    draftId: string,
    status: DomainStatus,
    check: { verifiedAt?: string | null; lastCheckedAt?: string } = {},
  ): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE studio_domains
            SET status = ?,
                verified_at = CASE WHEN ? THEN ? ELSE verified_at END,
                last_checked_at = COALESCE(?, last_checked_at),
                updated_at = ?
          WHERE draft_id = ?`,
      )
      .run(
        status,
        check.verifiedAt === undefined ? 0 : 1,
        check.verifiedAt ?? null,
        check.lastCheckedAt ?? null,
        now,
        draftId,
      );
  }

  async deleteDomain(draftId: string): Promise<void> {
    this.db
      .prepare(`DELETE FROM studio_domains WHERE draft_id = ?`)
      .run(draftId);
  }
}

function pgRow(r: typeof studioDomains.$inferSelect): DomainRow {
  return {
    draft_id: r.draftId,
    owner_id: r.ownerId,
    hostname: r.hostname,
    status: r.status as DomainStatus,
    verification_token: r.verificationToken ?? null,
    verified_at: r.verifiedAt?.toISOString() ?? null,
    last_checked_at: r.lastCheckedAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

export class PostgresDomainStore implements DomainStore {
  async getDomain(draftId: string): Promise<DomainRow | null> {
    const rows = await getDatabase()
      .select()
      .from(studioDomains)
      .where(eq(studioDomains.draftId, draftId))
      .limit(1);
    return rows[0] ? pgRow(rows[0]) : null;
  }

  async getDomainsForOwner(ownerId: string): Promise<DomainRow[]> {
    const rows = await getDatabase()
      .select()
      .from(studioDomains)
      .where(eq(studioDomains.ownerId, ownerId));
    return rows.map(pgRow);
  }

  async getDomainByHostname(hostname: string): Promise<DomainRow | null> {
    const rows = await getDatabase()
      .select()
      .from(studioDomains)
      .where(eq(studioDomains.hostname, hostname))
      .limit(1);
    return rows[0] ? pgRow(rows[0]) : null;
  }

  async setDomain(input: SetDomainInput): Promise<void> {
    const now = new Date();
    const verifiedAt = input.verifiedAt ? new Date(input.verifiedAt) : null;
    const lastCheckedAt = input.lastCheckedAt
      ? new Date(input.lastCheckedAt)
      : null;
    await getDatabase()
      .insert(studioDomains)
      .values({
        draftId: input.draftId,
        ownerId: input.ownerId,
        hostname: input.hostname,
        status: input.status,
        verificationToken: input.verificationToken,
        verifiedAt,
        lastCheckedAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: studioDomains.draftId,
        set: {
          hostname: input.hostname,
          status: input.status,
          verificationToken: input.verificationToken,
          verifiedAt,
          lastCheckedAt,
          updatedAt: now,
        },
      });
  }

  async updateStatus(
    draftId: string,
    status: DomainStatus,
    check: { verifiedAt?: string | null; lastCheckedAt?: string } = {},
  ): Promise<void> {
    await getDatabase()
      .update(studioDomains)
      .set({
        status,
        updatedAt: new Date(),
        ...(check.verifiedAt !== undefined
          ? { verifiedAt: check.verifiedAt ? new Date(check.verifiedAt) : null }
          : {}),
        ...(check.lastCheckedAt
          ? { lastCheckedAt: new Date(check.lastCheckedAt) }
          : {}),
      })
      .where(eq(studioDomains.draftId, draftId));
  }

  async deleteDomain(draftId: string): Promise<void> {
    await getDatabase()
      .delete(studioDomains)
      .where(eq(studioDomains.draftId, draftId));
  }
}

/**
 * Same rule as every other Studio store: PostgreSQL when `DATABASE_URL` is
 * set, otherwise the shared SQLite file. (An earlier version keyed this on a
 * variable nothing else set, so a PostgreSQL deployment silently wrote its
 * domains into the SQLite file — and the migration that created the table
 * was never exercised.)
 */
export function getDomainStore(): DomainStore {
  if (process.env.DATABASE_URL) return new PostgresDomainStore();
  return new SqliteDomainStore();
}
