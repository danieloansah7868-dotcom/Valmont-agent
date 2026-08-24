import type { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { studioDomains } from "@/db/schema";
import { getSqliteChatStore } from "@/lib/chat-store";
import type { SessionUser } from "@/lib/auth";

export const DOMAIN_STATUS = ["not_set", "pending", "active", "error"] as const;
export type DomainStatus = (typeof DOMAIN_STATUS)[number];

export interface DomainRow {
  draft_id: string;
  owner_id: string;
  hostname: string;
  status: DomainStatus;
  created_at: string;
  updated_at: string;
}

export function ensureDomainsSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS studio_domains (
      draft_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      hostname TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'not_set',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

interface DomainStore {
  getDomain(draftId: string): Promise<DomainRow | null>;
  getDomainsForOwner(ownerId: string): Promise<DomainRow[]>;
  getDomainByHostname(hostname: string): Promise<DomainRow | null>;
  setDomain(draftId: string, ownerId: string, hostname: string, status: DomainStatus): Promise<void>;
  updateStatus(draftId: string, status: DomainStatus): Promise<void>;
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
      .get(draftId) as DomainRow | undefined;
    return row ?? null;
  }

  async getDomainsForOwner(ownerId: string): Promise<DomainRow[]> {
    return this.db
      .prepare(`SELECT * FROM studio_domains WHERE owner_id = ?`)
      .all(ownerId) as DomainRow[];
  }

  async getDomainByHostname(hostname: string): Promise<DomainRow | null> {
    const row = this.db
      .prepare(`SELECT * FROM studio_domains WHERE hostname = ?`)
      .get(hostname) as DomainRow | undefined;
    return row ?? null;
  }

  async setDomain(draftId: string, ownerId: string, hostname: string, status: DomainStatus): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO studio_domains (draft_id, owner_id, hostname, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(draft_id) DO UPDATE SET
           hostname = excluded.hostname,
           status = excluded.status,
           updated_at = excluded.updated_at`
      )
      .run(draftId, ownerId, hostname, status, now, now);
  }

  async updateStatus(draftId: string, status: DomainStatus): Promise<void> {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE studio_domains SET status = ?, updated_at = ? WHERE draft_id = ?`)
      .run(status, now, draftId);
  }

  async deleteDomain(draftId: string): Promise<void> {
    this.db.prepare(`DELETE FROM studio_domains WHERE draft_id = ?`).run(draftId);
  }
}

export class PostgresDomainStore implements DomainStore {
  async getDomain(draftId: string): Promise<DomainRow | null> {
    const db = await getDatabase();
    const rows = await db
      .select()
      .from(studioDomains)
      .where(eq(studioDomains.draftId, draftId))
      .limit(1);
    
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      draft_id: r.draftId,
      owner_id: r.ownerId,
      hostname: r.hostname,
      status: r.status as DomainStatus,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    };
  }

  async getDomainsForOwner(ownerId: string): Promise<DomainRow[]> {
    const db = await getDatabase();
    const rows = await db
      .select()
      .from(studioDomains)
      .where(eq(studioDomains.ownerId, ownerId));
    
    return rows.map(r => ({
      draft_id: r.draftId,
      owner_id: r.ownerId,
      hostname: r.hostname,
      status: r.status as DomainStatus,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    }));
  }

  async getDomainByHostname(hostname: string): Promise<DomainRow | null> {
    const db = await getDatabase();
    const rows = await db
      .select()
      .from(studioDomains)
      .where(eq(studioDomains.hostname, hostname))
      .limit(1);
    
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      draft_id: r.draftId,
      owner_id: r.ownerId,
      hostname: r.hostname,
      status: r.status as DomainStatus,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    };
  }

  async setDomain(draftId: string, ownerId: string, hostname: string, status: DomainStatus): Promise<void> {
    const db = await getDatabase();
    const now = new Date();
    await db
      .insert(studioDomains)
      .values({
        draftId,
        ownerId,
        hostname,
        status,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: studioDomains.draftId,
        set: {
          hostname,
          status,
          updatedAt: now,
        },
      });
  }

  async updateStatus(draftId: string, status: DomainStatus): Promise<void> {
    const db = await getDatabase();
    await db
      .update(studioDomains)
      .set({ status, updatedAt: new Date() })
      .where(eq(studioDomains.draftId, draftId));
  }

  async deleteDomain(draftId: string): Promise<void> {
    const db = await getDatabase();
    await db.delete(studioDomains).where(eq(studioDomains.draftId, draftId));
  }
}

export function getDomainStore(): DomainStore {
  if (process.env.USE_POSTGRES_FOR_CHAT === "true") {
    return new PostgresDomainStore();
  }
  return new SqliteDomainStore();
}
