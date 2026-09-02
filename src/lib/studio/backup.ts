import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { SessionUser } from "@/lib/auth";
import { getSqliteChatStore, type ChatMemory } from "@/lib/chat-store";
import type { ChatSession } from "@/lib/types";
import { canonicalUserId } from "@/lib/user-identity";
import {
  siteBriefSchemaV1,
  type SiteBriefV1,
  type StudioDraft,
} from "./site-brief/schema";
import type { ImportJobRecord, ImportLockLease } from "./import-coordinator";
import {
  acquireNewImportLock,
  beginImportJob,
  getImportJob,
  ImportInProgressError,
  ImportLostLeaseError,
  markChatCommitted,
  markCompleted,
  markFailed,
  markStudioCommitted,
  recoverPendingImports,
  refuseIfOwnerImportActive,
  releaseImportLock,
  renewImportLease,
  restoreJob,
  startImportLeaseHeartbeat,
  stopImportLeaseHeartbeat,
} from "./import-coordinator";
import {
  draftIdExists,
  ensureStudioSchema,
  getStudioSqliteStore,
  insertDraftRow,
  PostgresStudioDraftStore,
  STUDIO_SCHEMA_VERSION,
} from "./draft-store";
import { ensureCustomerAccountSchema } from "@/lib/customer-account-store";
import {
  DOMAIN_STATUS,
  ensureDomainsSchema,
  newVerificationToken,
  normalizeHostname,
} from "./domains";

export const BACKUP_VERSION = 2 as const;
export const CHAT_SECTION_VERSION = 1 as const;
export const STUDIO_SECTION_VERSION = 1 as const;

import { BadRequestError } from "@/lib/api-errors";

/** Raised for input the import route must refuse *before* writing anything. */
export class BackupValidationError extends BadRequestError {
  constructor(message: string) {
    super(message);
    this.name = "BackupValidationError";
  }
}

const isoTimestamp = z.string().datetime();

const chatMessageSchema = z.object({
  id: z.string().max(200),
  role: z.enum(["user", "assistant"]),
  content: z.string().max(8000),
  createdAt: isoTimestamp,
  model: z.string().max(200).optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
});

const chatSessionSchema = z.object({
  id: z.string().max(200),
  // Present in the file but deliberately ignored: the importing user always
  // becomes the owner. Kept in the schema so old files still validate.
  userId: z.string().max(200).optional(),
  title: z.string().max(120),
  repository: z
    .object({
      id: z.string().max(120),
      owner: z.string().max(120),
      name: z.string().max(120),
      fullName: z.string().max(250),
      baseBranch: z.string().max(200),
    })
    .optional(),
  messages: z.array(chatMessageSchema).max(100_000),
  archivedAt: isoTimestamp.optional(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

const chatMemorySchema = z.object({
  id: z.string().max(200),
  scope: z.enum(["personal", "repository"]),
  repositoryId: z.string().max(120).optional(),
  category: z.enum(["preference", "fact", "decision", "project"]),
  content: z.string().max(1000),
  sourceSessionId: z.string().max(200).optional(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

/** The chat half of a backup. Identical in shape to the v1 memories export. */
export const chatSectionSchema = z.object({
  version: z.literal(1),
  sessions: z.array(chatSessionSchema).max(10_000),
  memories: z.array(chatMemorySchema).max(100_000),
  memoryEnabled: z.boolean().optional(),
});

/**
 * Draft ids must be UUIDs. The PostgreSQL column is `uuid`, so a hand-edited
 * file containing `"id": "d1"` would otherwise reach the driver and fail
 * mid-import, leaking the driver's message through the 400. Rejecting the id
 * during validation keeps every malformed file a clean pre-write refusal.
 *
 * The rule matches the 8-4-4-4-12 hex form this codebase produces — every id
 * comes from `randomUUID()` — rather than Zod's `.uuid()`, which additionally
 * demands RFC-4122 version and variant bits and would reject ids the database
 * itself stores happily, including ones written by earlier versions.
 *
 * It is not full parity with PostgreSQL's `uuid_in`, which also accepts the
 * braced form, the 32-hex-digit form with no dashes, and mixed dash placement.
 * Refusing those is deliberate: no legitimate round-tripped id is written that
 * way, so the only thing narrower parsing rejects is a hand-crafted file.
 */
const draftId = z
  .string()
  .regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, "must be a UUID");

const studioDraftSchema = z.object({
  id: draftId,
  // Ignored on import — reassigned to the authenticated user.
  ownerId: z.string().max(200).optional(),
  schemaVersion: z.number().int().min(1).max(STUDIO_SCHEMA_VERSION),
  templateRegistryVersion: z.number().int().min(1).optional(),
  themeRegistryVersion: z.number().int().min(1).optional(),
  revision: z.number().int().min(1).optional(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  brief: siteBriefSchemaV1,
});

export const studioSectionSchema = z.object({
  version: z.literal(1),
  schemaVersion: z.literal(1),
  drafts: z.array(studioDraftSchema).max(5_000),
});

/**
 * An scrypt password envelope — the ONLY form a customer password may ever
 * take in a backup. Plaintext never leaves the database; the hash travels
 * as-is so a restored account still accepts its owner's password. Anything
 * that does not carry the scrypt parameter block is refused before a single
 * write happens.
 */
const customerPasswordHash = z
  .string()
  .regex(
    /^scrypt\$N=\d+,r=\d+,p=\d+\$[A-Za-z0-9_-]{16,}\$[A-Za-z0-9_-]{32,}$/,
    "must be a scrypt password hash",
  );

/** Session and one-time token secrets are exported only as SHA-256 digests. */
const customerTokenDigest = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a SHA-256 digest");

const customerAccountBackupSchema = z.object({
  id: draftId,
  email: z.string().email().max(254),
  name: z.string().min(1).max(80),
  passwordHash: customerPasswordHash,
  emailVerifiedAt: isoTimestamp.optional(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

const customerSessionBackupSchema = z.object({
  id: draftId,
  accountId: draftId,
  tokenHash: customerTokenDigest,
  expiresAt: isoTimestamp,
  createdAt: isoTimestamp,
});

const customerTokenBackupSchema = z.object({
  id: draftId,
  accountId: draftId,
  purpose: z.enum(["verify_email", "reset_password"]),
  tokenHash: customerTokenDigest,
  context: z.string().max(200).optional(),
  expiresAt: isoTimestamp,
  usedAt: isoTimestamp.optional(),
  createdAt: isoTimestamp,
});

/**
 * Optional backup section: customer accounts, sessions and one-time tokens.
 * Present so the accounts a shop's customers created survive export and
 * restore. Absent in backups made before the feature existed; payment
 * credentials and environment secrets are never part of any section.
 */
export const customerSectionSchema = z.object({
  version: z.literal(1),
  accounts: z.array(customerAccountBackupSchema).max(100_000),
  sessions: z.array(customerSessionBackupSchema).max(500_000),
  tokens: z.array(customerTokenBackupSchema).max(500_000),
});

/**
 * A custom domain attached to one of the exported drafts. The verification
 * token is deliberately NOT exported: on restore the domain comes back as
 * `pending` with a fresh token, so a file restored on another machine must
 * prove ownership again before the hostname is served there.
 */
const domainBackupSchema = z.object({
  draftId,
  hostname: z.string().min(1).max(253),
  status: z.enum(DOMAIN_STATUS),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

/** Optional backup section: custom domains. Absent in older files. */
export const domainSectionSchema = z.object({
  version: z.literal(1),
  domains: z.array(domainBackupSchema).max(5_000),
});

/** A complete backup: chat, memories and website drafts together. */
export const backupV2Schema = z.object({
  backupVersion: z.literal(2),
  exportedAt: isoTimestamp,
  chat: chatSectionSchema,
  studio: studioSectionSchema,
  customers: customerSectionSchema.optional(),
  domains: domainSectionSchema.optional(),
});

/** The older chat-only file produced by /api/memories/export. */
export const backupV1Schema = chatSectionSchema;

export type BackupV2 = z.infer<typeof backupV2Schema>;
export type StudioSection = z.infer<typeof studioSectionSchema>;
export type CustomerSection = z.infer<typeof customerSectionSchema>;
export type DomainSection = z.infer<typeof domainSectionSchema>;

export interface NormalizedBackup {
  chat: z.infer<typeof chatSectionSchema>;
  studio: StudioSection;
  /** Present only in backups written after customer accounts existed. */
  customers?: CustomerSection;
  /** Present only in backups written after custom domains were exported. */
  domains?: DomainSection;
  sourceVersion: 1 | 2;
}

/**
 * Checks the version *first*, then validates the whole file. Nothing is written
 * until this function has returned successfully, so a bad file can never leave
 * a half-finished import behind.
 */
export function parseBackup(input: unknown): NormalizedBackup {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new BackupValidationError("Backup file is not valid JSON data.");
  }
  const record = input as Record<string, unknown>;
  const declared = record.backupVersion ?? record.version;

  if (declared === 2) {
    const parsed = backupV2Schema.safeParse(record);
    if (!parsed.success) throw validationFailure(parsed.error);
    return {
      chat: parsed.data.chat,
      studio: parsed.data.studio,
      customers: parsed.data.customers,
      domains: parsed.data.domains,
      sourceVersion: 2,
    };
  }

  if (declared === 1) {
    const parsed = backupV1Schema.safeParse(record);
    if (!parsed.success) throw validationFailure(parsed.error);
    return {
      chat: parsed.data,
      studio: { version: 1, schemaVersion: 1, drafts: [] },
      sourceVersion: 1,
    };
  }

  throw new BackupValidationError(
    "Unsupported backup version. This app can import version 1 (chat only) and version 2 (complete) backups.",
  );
}

/**
 * Reports *where* a file is wrong without ever echoing the value found there.
 * Field paths are safe to show; the user's own business details are not.
 */
function validationFailure(error: z.ZodError): BackupValidationError {
  const fields = Array.from(
    new Set(
      error.issues
        .slice(0, 5)
        .map((issue) => issue.path.join(".") || "(top level)"),
    ),
  );
  return new BackupValidationError(
    `Backup file is not valid. Check these fields: ${fields.join(", ")}.`,
  );
}

export async function buildBackup(
  user: SessionUser,
  options: { afterChatReadForTests?: () => void } = {},
): Promise<BackupV2> {
  if (process.env.DATABASE_URL) {
    const chat = await getSqliteChatStore().exportUser(user.id);
    const drafts = await new PostgresStudioDraftStore().list(user);
    const customers = await exportCustomersPostgres(canonicalUserId(user));
    const domains = await exportDomainsPostgres(canonicalUserId(user));
    return assembleBackup(chat, drafts, customers, domains);
  }

  // Chat and drafts are read back to back from the one shared connection
  // inside a single read transaction. The snapshot is fixed at the first read,
  // so a writer committing on another connection between the chat read and the
  // draft read cannot leak a later state into the export: the file is either
  // entirely "before" or entirely "after", never a mixture of the two.
  const store = getStudioSqliteStore();
  const ownerId = canonicalUserId(user);
  // Create the customer tables before opening the read transaction: DDL inside
  // a read snapshot would force a write upgrade and fail under concurrency.
  ensureCustomerAccountSchema(store.connection);
  ensureDomainsSchema(store.connection);
  let chat: {
    version: number;
    sessions: ChatSession[];
    memories: ChatMemory[];
    memoryEnabled: boolean;
  };
  let drafts: StudioDraft[] = [];
  // Customer accounts share the same snapshot so a shopper signing up
  // mid-export cannot split the file between two points in time.
  let customers: CustomerSection | undefined;
  let domains: DomainSection | undefined;
  store.runInReadTransaction(() => {
    chat = store.exportUserSync(user.id);
    // Test hook: proves the export cannot combine records from different
    // points in time by letting another connection commit mid-export.
    options.afterChatReadForTests?.();
    const rows = store.connection
      .prepare(
        "SELECT * FROM studio_drafts WHERE owner_id = ? ORDER BY updated_at DESC",
      )
      .all(ownerId) as unknown as Array<Record<string, string | number>>;
    drafts = rows.map((row) => ({
      id: String(row.id),
      ownerId: String(row.owner_id),
      schemaVersion: Number(row.schema_version),
      templateRegistryVersion: Number(row.template_version),
      themeRegistryVersion: Number(row.theme_version),
      revision: Number(row.revision),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      brief: (() => {
        const parsed = JSON.parse(String(row.brief_json)) as SiteBriefV1;
        if (!parsed.assets || typeof parsed.assets !== "object") {
          parsed.assets = { logo: null, photos: [] };
        } else {
          if (!parsed.assets.logo) parsed.assets.logo = null;
          if (!Array.isArray(parsed.assets.photos)) parsed.assets.photos = [];
        }
        return parsed;
      })(),
    }));
    customers = exportCustomersSnapshot(store.connection, ownerId);
    domains = exportDomainsSnapshot(store.connection, ownerId);
  });
  return assembleBackup(chat!, drafts, customers, domains);
}

function assembleBackup(
  chat: {
    version: number;
    sessions: ChatSession[];
    memories: ChatMemory[];
    memoryEnabled: boolean;
  },
  drafts: StudioDraft[],
  customers?: CustomerSection,
  domains?: DomainSection,
): BackupV2 {
  return {
    backupVersion: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    chat: {
      version: CHAT_SECTION_VERSION,
      sessions: chat.sessions,
      memories: chat.memories,
      memoryEnabled: chat.memoryEnabled,
    },
    studio: {
      version: STUDIO_SECTION_VERSION,
      schemaVersion: 1,
      drafts,
    },
    customers: customers ?? {
      version: 1,
      accounts: [],
      sessions: [],
      tokens: [],
    },
    domains: domains ?? { version: 1, domains: [] },
  };
}

interface SqliteDomainBackupRow {
  draft_id: string;
  hostname: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * The owner's custom domains, read inside the caller's read transaction.
 * Scoped by owner id, like every other section: a hostname belongs to one
 * tenant's draft and never appears in another tenant's file.
 */
function exportDomainsSnapshot(
  db: DatabaseSync,
  ownerId: string,
): DomainSection {
  const rows = db
    .prepare(
      `SELECT draft_id, hostname, status, created_at, updated_at
         FROM studio_domains WHERE owner_id = ? ORDER BY created_at`,
    )
    .all(ownerId) as unknown as SqliteDomainBackupRow[];
  return {
    version: 1,
    domains: rows.map((row) => ({
      draftId: row.draft_id,
      hostname: row.hostname,
      status: (DOMAIN_STATUS as readonly string[]).includes(row.status)
        ? (row.status as (typeof DOMAIN_STATUS)[number])
        : "pending",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

async function exportDomainsPostgres(ownerId: string): Promise<DomainSection> {
  const { eq } = await import("drizzle-orm");
  const { getDatabase } = await import("@/db");
  const { studioDomains } = await import("@/db/schema");
  const rows = await getDatabase()
    .select()
    .from(studioDomains)
    .where(eq(studioDomains.ownerId, ownerId));
  return {
    version: 1,
    domains: rows.map((row) => ({
      draftId: row.draftId,
      hostname: row.hostname,
      status: (DOMAIN_STATUS as readonly string[]).includes(row.status)
        ? (row.status as (typeof DOMAIN_STATUS)[number])
        : "pending",
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

interface SqliteCustomerAccountRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  email_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SqliteCustomerSessionRow {
  id: string;
  account_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
}

interface SqliteCustomerTokenRow {
  id: string;
  account_id: string;
  purpose: string;
  token_hash: string;
  context: string | null;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

/**
 * Reads the customer tables from the open SQLite connection, SCOPED to the
 * customers tied to the exporting owner's orders. Runs inside the caller's
 * read transaction so the export is one consistent snapshot. The schema
 * itself is ensured by the caller BEFORE the read transaction starts — DDL
 * inside a read transaction would try to upgrade it to a write and die with
 * "database is locked" against any concurrent writer.
 *
 * Customer accounts are a global, per-website-opt-in table (a shopper can
 * place orders on more than one business), so a Studio backup must never
 * serialize accounts that never interacted with THIS owner's shops: a
 * backup is per owner and an unscoped dump would copy every other tenant's
 * customers (names, emails, scrypt password envelopes) into this file.
 */
function exportCustomersSnapshot(
  db: DatabaseSync,
  ownerId: string,
): CustomerSection {
  const linked = sqliteScopedCustomerIds(db, ownerId);
  const accounts =
    linked.size === 0
      ? []
      : (db
          .prepare(
            `SELECT * FROM customer_accounts
               WHERE id IN (${placeholders(linked.size)}) ORDER BY created_at`,
          )
          .all(...linked) as unknown as SqliteCustomerAccountRow[]);
  const sessions =
    linked.size === 0
      ? []
      : (db
          .prepare(
            `SELECT * FROM customer_sessions
               WHERE account_id IN (${placeholders(linked.size)})
               ORDER BY created_at`,
          )
          .all(...linked) as unknown as SqliteCustomerSessionRow[]);
  const tokens =
    linked.size === 0
      ? []
      : (db
          .prepare(
            `SELECT * FROM customer_tokens
               WHERE account_id IN (${placeholders(linked.size)})
               ORDER BY created_at`,
          )
          .all(...linked) as unknown as SqliteCustomerTokenRow[]);
  return {
    version: 1,
    accounts: accounts.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      passwordHash: row.password_hash,
      emailVerifiedAt: row.email_verified_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    sessions: sessions.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      tokenHash: row.token_hash,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    })),
    tokens: tokens.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      purpose: row.purpose as "verify_email" | "reset_password",
      tokenHash: row.token_hash,
      context: row.context ?? undefined,
      expiresAt: row.expires_at,
      usedAt: row.used_at ?? undefined,
      createdAt: row.created_at,
    })),
  };
}

/** Builds a `?,?,?` placeholder list of the requested size (bounded by callers). */
function placeholders(count: number): string {
  return Array.from({ length: Math.min(count, 1_000_000) }, () => "?").join(
    ",",
  );
}

/**
 * The customer accounts that belong in THIS owner's backup: every account
 * attached to one of the owner's orders (checkout-session attach or a guest
 * claim). Accounts with no order on any of the owner's shops are other
 * tenants' customers and are excluded.
 */
function sqliteScopedCustomerIds(
  db: DatabaseSync,
  ownerId: string,
): Set<string> {
  // The orders schema is ensured lazily by the orders store; an export
  // running before any order ever existed may not have it yet. Treat a
  // missing orders table the same as "no orders": there is nothing to
  // scope to, so no customer rows are exported.
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT customer_account_id AS id FROM studio_orders
           WHERE owner_id = ? AND customer_account_id IS NOT NULL`,
      )
      .all(ownerId) as unknown as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) {
      return new Set();
    }
    throw error;
  }
}

/**
 * PostgreSQL counterpart of {@link exportCustomersSnapshot}, SCOPED to the
 * customers tied to the exporting owner's orders. The customer tables are
 * global (one set per multi-tenant deployment), so without this scope every
 * Studio owner's backup would contain every other tenant's customers — their
 * names, emails and scrypt password envelopes.
 */
async function exportCustomersPostgres(
  ownerId: string,
): Promise<CustomerSection> {
  const { and, eq, inArray, isNotNull } = await import("drizzle-orm");
  const { getDatabase } = await import("@/db");
  const { customerAccounts, customerSessions, customerTokens, studioOrders } =
    await import("@/db/schema");
  const db = getDatabase();
  // Accounts attached to one of THIS owner's orders (session attach or
  // guest claim). An account that never ordered on the owner's shops is
  // another tenant's customer and never enters the backup file.
  const linkedRows = await db
    .selectDistinct({ id: studioOrders.customerAccountId })
    .from(studioOrders)
    .where(
      and(
        eq(studioOrders.ownerId, ownerId),
        isNotNull(studioOrders.customerAccountId),
      ),
    );
  const linkedIds = [
    ...new Set(
      linkedRows.map((row) => row.id).filter((id): id is string => Boolean(id)),
    ),
  ];
  const [accounts, sessions, tokens] =
    linkedIds.length === 0
      ? [[], [], []]
      : await Promise.all([
          db
            .select()
            .from(customerAccounts)
            .where(inArray(customerAccounts.id, linkedIds)),
          db
            .select()
            .from(customerSessions)
            .where(inArray(customerSessions.accountId, linkedIds)),
          db
            .select()
            .from(customerTokens)
            .where(inArray(customerTokens.accountId, linkedIds)),
        ]);
  return {
    version: 1,
    accounts: accounts.map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      passwordHash: row.passwordHash,
      emailVerifiedAt: row.emailVerifiedAt?.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    sessions: sessions.map((row) => ({
      id: row.id,
      accountId: row.accountId,
      tokenHash: row.tokenHash,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
    tokens: tokens.map((row) => ({
      id: row.id,
      accountId: row.accountId,
      purpose: row.purpose as "verify_email" | "reset_password",
      tokenHash: row.tokenHash,
      context: row.context ?? undefined,
      expiresAt: row.expiresAt.toISOString(),
      usedAt: row.usedAt?.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export interface ImportSummary {
  sourceVersion: 1 | 2;
  /** Chat sessions actually written, not the number the file contained. */
  chatSessions: number;
  /** Memories actually written. Excludes any counted in `skippedMemories`. */
  memories: number;
  /**
   * Memories present in the file but deliberately not imported because their
   * text matched a secret-redaction pattern. Reported so the owner is told the
   * record was dropped rather than silently losing it.
   */
  skippedMemories: number;
  studioDrafts: number;
  /** Drafts whose id already existed and were given a fresh id. */
  remappedDraftIds: number;
  /**
   * Customer accounts actually inserted. An account already present — by id
   * or by email — is left untouched and counted in `skippedCustomerAccounts`,
   * so a restore never overwrites a customer's current password hash.
   */
  customerAccounts: number;
  skippedCustomerAccounts: number;
  /** Customer sessions and one-time tokens actually inserted. */
  customerSessions: number;
  customerTokens: number;
  /**
   * Custom domains re-attached to restored drafts, always as `pending` with
   * a fresh verification token: ownership must be proven again on the
   * machine the file was restored to. A hostname already attached to
   * another draft here, or attached to a draft that was not in the file, is
   * left out and counted in `skippedDomains`.
   */
  customDomains: number;
  skippedDomains: number;
  /**
   * How the import was made atomic across stores.
   *
   * - `"single-transaction"` (SQLite): chat, memories and drafts share one
   *   connection and one transaction. A failure rolls back everything.
   * - `"coordinated"` (PostgreSQL): chat lives in SQLite and studio in
   *   PostgreSQL, so there is no distributed transaction. The durable
   *   cross-store coordinator in `import-coordinator.ts` records a staged
   *   payload and a pre-import snapshot of both stores before any write, then
   *   advances through durable checkpoints. Any failure — or an interrupted
   *   import after a restart — rolls both stores back to their exact previous
   *   state; success is reported only after both halves committed.
   */
  atomicity: "single-transaction" | "coordinated";
}

/**
 * Raised when an import failed AND rolling it back also failed. This is the
 * catastrophic, exceptional case: the normal outcome of a partly-committed
 * import is a successful rollback plus `ImportFailedError`. Only when the
 * rollback itself cannot complete (for example PostgreSQL is unreachable) does
 * this error escape, naming exactly which half is known to have committed so
 * the owner is told what may have landed.
 */
export class PartialImportError extends BadRequestError {
  readonly status = 500;
  readonly committed: { chat: boolean; studio: boolean };
  constructor(cause: unknown, committed: { chat: boolean; studio: boolean }) {
    super(
      "The import failed and, separately, rolling it back also failed, so your data may be " +
        "partly imported. The recovery record is on disk and will be rolled back by the next " +
        "import attempt once the database is reachable again. Re-importing the same file now " +
        "could create duplicate copies, so wait for recovery to finish first.",
    );
    this.name = "PartialImportError";
    this.committed = committed;
    this.cause = cause;
    // Override status to 500 (BadRequestError defaults 400)
    Object.defineProperty(this, "status", { value: 500, writable: false });
  }
}

/**
 * Raised when an import failed at any checkpoint but every write that had
 * already happened was rolled back. Both stores are back to their exact
 * previous state, so this is a plain failure — never a partial success.
 */
export class ImportFailedError extends BadRequestError {
  readonly status = 500;
  constructor(cause: unknown) {
    super(
      "The import did not complete and everything it had written was rolled back. " +
        "Your chats, memories and website drafts are unchanged. Try the import again.",
    );
    this.name = "ImportFailedError";
    this.cause = cause;
    Object.defineProperty(this, "status", { value: 500, writable: false });
  }
}

/**
 * The durable checkpoints of a coordinated (mixed SQLite/PostgreSQL) import.
 * Tests inject a failure at each one and prove both stores are rolled back.
 */
export type ImportCheckpoint =
  | "job-created"
  | "chat-imported"
  | "chat-committed"
  | "studio-imported"
  | "studio-fenced"
  | "studio-committed"
  | "completed";

export interface ImportOptions {
  /** SQLite path only: throws inside the single import transaction. */
  failAfterInsertForTests?: () => void;
  /**
   * Mixed path only: called at each durable checkpoint. Throwing here
   * simulates a failure at that exact stage of the import.
   */
  onCheckpoint?: (checkpoint: ImportCheckpoint) => void | Promise<void>;
  /**
   * Called after the owner lock (and, on the mixed path, the job row) is
   * durably acquired and before either store is written. Tests use this as
   * an explicit latch instead of sleeping.
   */
  onLockAcquired?: () => void | Promise<void>;
}

/**
 * Writes a validated backup for the authenticated user.
 *
 * **SQLite** (default): chat, memories and studio drafts share one connection,
 * so the whole import is a single transaction. A failure anywhere rolls back
 * everything.
 *
 * **PostgreSQL** (`DATABASE_URL` set): chat history still lives in SQLite while
 * studio drafts live in PostgreSQL. Two engines cannot share a transaction, so
 * the durable cross-store coordinator records the staged payload and a
 * pre-import snapshot of both stores before any write, then advances through
 * durable checkpoints. Any failure at any checkpoint — or an interruption that
 * kills the process mid-import — rolls both stores back to their exact previous
 * state, either immediately or on the next import attempt after a restart.
 * Success is reported only after both halves have committed.
 *
 * Owner ids inside the file are never trusted. Chat rows are reassigned by the
 * chat store, studio rows by this function.
 */
export async function importBackup(
  user: SessionUser,
  backup: NormalizedBackup,
  options: ImportOptions = {},
): Promise<ImportSummary> {
  // Counts start empty and are filled in from what each store reports it wrote.
  // Trusting the file's own lengths is what previously let a dropped memory be
  // reported as restored.
  const summary: ImportSummary = {
    sourceVersion: backup.sourceVersion,
    chatSessions: 0,
    memories: 0,
    skippedMemories: 0,
    studioDrafts: 0,
    remappedDraftIds: 0,
    customerAccounts: 0,
    skippedCustomerAccounts: 0,
    customerSessions: 0,
    customerTokens: 0,
    customDomains: 0,
    skippedDomains: 0,
    atomicity: process.env.DATABASE_URL ? "coordinated" : "single-transaction",
  };

  if (process.env.DATABASE_URL) {
    await importIntoPostgres(user, backup, summary, options);
    return summary;
  }

  await importIntoSqlite(user, backup, summary, options);
  return summary;
}

async function importIntoSqlite(
  user: SessionUser,
  backup: NormalizedBackup,
  summary: ImportSummary,
  options: ImportOptions,
): Promise<void> {
  const store = getStudioSqliteStore();
  const ownerId = canonicalUserId(user);
  const db = store.connection;

  refuseIfOwnerImportActive(ownerId);
  await recoverPendingImports(ownerId);
  refuseIfOwnerImportActive(ownerId);

  const jobId = randomUUID();
  const lease = acquireNewImportLock(ownerId, jobId);
  startImportLeaseHeartbeat(lease);
  try {
    await options.onLockAcquired?.();
    renewImportLease(lease);
    // One transaction covering both halves, on the one shared connection. The
    // synchronous import core is required here: an awaited call would let the
    // transaction commit before the studio rows are written.
    store.runInTransaction(() => {
      renewImportLease(lease);
      const counts = store.importUserSync(user.id, {
        sessions: backup.chat.sessions as ChatSession[],
        memories: backup.chat.memories as ChatMemory[],
        memoryEnabled: backup.chat.memoryEnabled,
      });
      summary.chatSessions = counts.chatSessions;
      summary.memories = counts.memories;
      summary.skippedMemories = counts.skippedMemories;
      const draftIds = importStudioDrafts(db, ownerId, backup.studio, summary);
      if (backup.customers) {
        importCustomersSqlite(db, backup.customers, summary);
      }
      if (backup.domains) {
        importDomainsSqlite(db, ownerId, backup.domains, draftIds, summary);
      }
      // Test hook: proves a failure after inserts rolls the whole import back.
      options.failAfterInsertForTests?.();
    });
    releaseImportLock(lease);
  } catch (cause) {
    if (cause instanceof ImportInProgressError) throw cause;
    try {
      releaseImportLock(lease);
    } catch {
      // Lost the lease; do not touch the replacement lock.
    }
    throw cause;
  } finally {
    stopImportLeaseHeartbeat(lease);
  }
}

/**
 * Inserts studio drafts under the authenticated owner. An id that is already
 * taken gets a fresh one, so importing your own backup twice never overwrites
 * or merges the existing copy.
 */
export function importStudioDrafts(
  db: DatabaseSync,
  ownerId: string,
  studio: StudioSection,
  summary: ImportSummary,
): Map<string, string> {
  ensureStudioSchema(db);
  // File draft id → id actually written, so dependent rows (custom domains)
  // follow a draft that was given a fresh id.
  const written = new Map<string, string>();
  for (const incoming of studio.drafts) {
    const collides = draftIdExists(db, incoming.id);
    if (collides) summary.remappedDraftIds += 1;
    const id = collides ? randomUUID() : incoming.id;
    written.set(incoming.id, id);
    insertDraftRow(db, {
      id,
      // The owner in the file is ignored on purpose.
      ownerId,
      schemaVersion: incoming.schemaVersion,
      templateRegistryVersion: incoming.templateRegistryVersion ?? 1,
      themeRegistryVersion: incoming.themeRegistryVersion ?? 1,
      revision: incoming.revision ?? 1,
      createdAt: incoming.createdAt,
      updatedAt: incoming.updatedAt,
      brief: incoming.brief,
    });
    summary.studioDrafts += 1;
  }
  return written;
}

/**
 * Re-attaches custom domains to the drafts restored in this import. Every
 * restored domain starts `pending` with a NEW verification token — the file
 * carries no token — so the hostname is never served from this machine until
 * its owner publishes the new TXT record. Hostnames that fail validation,
 * already belong to another draft here, or reference a draft that was not in
 * this file are skipped and counted, never silently dropped.
 */
export function importDomainsSqlite(
  db: DatabaseSync,
  ownerId: string,
  section: DomainSection,
  draftIds: Map<string, string>,
  summary: ImportSummary,
): void {
  ensureDomainsSchema(db);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO studio_domains (
       draft_id, owner_id, hostname, status, verification_token,
       verified_at, last_checked_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'pending', ?, NULL, NULL, ?, ?)`,
  );
  for (const domain of section.domains) {
    const draftId = draftIds.get(domain.draftId);
    const hostname = normalizeHostname(domain.hostname);
    if (!draftId || !hostname) {
      summary.skippedDomains += 1;
      continue;
    }
    const result = insert.run(
      draftId,
      ownerId,
      hostname,
      newVerificationToken(),
      domain.createdAt,
      domain.updatedAt,
    );
    if (Number(result.changes) > 0) summary.customDomains += 1;
    else summary.skippedDomains += 1;
  }
}

/**
 * Restores customer accounts, sessions and one-time tokens. INSERT OR IGNORE
 * means a row that already exists — same account id OR same email address —
 * is never overwritten, so restoring an older backup cannot roll a customer's
 * current password back and importing a foreign file cannot take over an
 * existing local account. Sessions and tokens are restored only for accounts
 * that are present after this pass, so no orphan rows can be created.
 */
export function importCustomersSqlite(
  db: DatabaseSync,
  customers: CustomerSection,
  summary: ImportSummary,
): void {
  ensureCustomerAccountSchema(db);
  const insertAccount = db.prepare(
    `INSERT OR IGNORE INTO customer_accounts(
       id, email, name, password_hash, email_verified_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const account of customers.accounts) {
    const result = insertAccount.run(
      account.id,
      account.email.trim().toLowerCase(),
      account.name,
      account.passwordHash,
      account.emailVerifiedAt ?? null,
      account.createdAt,
      account.updatedAt,
    );
    if (Number(result.changes) > 0) summary.customerAccounts += 1;
    else summary.skippedCustomerAccounts += 1;
  }

  const usable = new Set(
    (
      db.prepare("SELECT id FROM customer_accounts").all() as unknown as Array<{
        id: string;
      }>
    ).map((row) => row.id),
  );

  const insertSession = db.prepare(
    `INSERT OR IGNORE INTO customer_sessions(
       id, account_id, token_hash, expires_at, created_at
     ) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const session of customers.sessions) {
    if (!usable.has(session.accountId)) continue;
    const result = insertSession.run(
      session.id,
      session.accountId,
      session.tokenHash,
      session.expiresAt,
      session.createdAt,
    );
    if (Number(result.changes) > 0) summary.customerSessions += 1;
  }

  const insertToken = db.prepare(
    `INSERT OR IGNORE INTO customer_tokens(
       id, account_id, purpose, token_hash, context, expires_at, used_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const token of customers.tokens) {
    if (!usable.has(token.accountId)) continue;
    const result = insertToken.run(
      token.id,
      token.accountId,
      token.purpose,
      token.tokenHash,
      token.context ?? null,
      token.expiresAt,
      token.usedAt ?? null,
      token.createdAt,
    );
    if (Number(result.changes) > 0) summary.customerTokens += 1;
  }
}

async function importIntoPostgres(
  user: SessionUser,
  backup: NormalizedBackup,
  summary: ImportSummary,
  options: ImportOptions,
): Promise<void> {
  const { getDatabase } = await import("@/db");
  const {
    customerAccounts,
    customerSessions,
    customerTokens,
    studioDomains,
    studioDrafts,
  } = await import("@/db/schema");
  const { ensureStudioUser } = await import("@/lib/user-identity");
  const { eq, inArray } = await import("drizzle-orm");

  const ownerId = await ensureStudioUser(user);
  // Live leases 409 before recovery. Expired leases are claimed atomically
  // and rolled back before a new import can start.
  refuseIfOwnerImportActive(ownerId);
  await recoverPendingImports(ownerId);

  const started = await beginImportJob(user, ownerId, backup, "mixed");
  const { jobId, lease } = started;

  try {
    await options.onLockAcquired?.();
    renewImportLease(lease);
    await options.onCheckpoint?.("job-created");
    renewImportLease(lease);
    // Chat half: chat history and memories live in SQLite even when studio
    // uses PostgreSQL. The transaction is owned here so a checkpoint failure
    // can prove the chat transaction itself rolls back.
    const store = getSqliteChatStore();
    const chatCounts = store.runInTransaction(() => {
      renewImportLease(lease);
      const counts = store.importUserSync(user.id, {
        sessions: backup.chat.sessions as ChatSession[],
        memories: backup.chat.memories as ChatMemory[],
        memoryEnabled: backup.chat.memoryEnabled,
      });
      // Must stay synchronous: an await would commit the SQLite transaction
      // before this function returns.
      const maybe = options.onCheckpoint?.("chat-imported");
      if (maybe && typeof (maybe as Promise<void>).then === "function") {
        throw new Error(
          "onCheckpoint('chat-imported') must be synchronous because it runs inside a SQLite transaction.",
        );
      }
      return counts;
    });
    summary.chatSessions = chatCounts.chatSessions;
    summary.memories = chatCounts.memories;
    summary.skippedMemories = chatCounts.skippedMemories;
    markChatCommitted(jobId, lease);
    await options.onCheckpoint?.("chat-committed");

    // Studio half: drafts live in PostgreSQL; one transaction, then the
    // durable checkpoint.
    await runStudioImportTransaction(lease);
    await options.onCheckpoint?.("studio-committed");
    await options.onCheckpoint?.("completed");
    markCompleted(
      jobId,
      {
        chatSessions: summary.chatSessions,
        memories: summary.memories,
        studioDrafts: summary.studioDrafts,
      },
      lease,
    );
  } catch (cause) {
    if (cause instanceof ImportInProgressError) throw cause;
    if (cause instanceof ImportLostLeaseError) {
      // Another worker claimed the expired lease. Do not restore, sanitize
      // or release — that worker owns the lock now.
      throw new ImportFailedError(cause);
    }
    // The job's status before the rollback decides which halves were already
    // committed — capture it first, because restoreJob moves the status to
    // "restoring" as soon as it starts.
    const committedBeforeRollback = coordinatorJob(jobId).status;
    try {
      await restoreJob(coordinatorJob(jobId), lease);
    } catch (restoreCause) {
      if (restoreCause instanceof ImportFailedError) throw restoreCause;
      if (restoreCause instanceof ImportLostLeaseError) {
        throw new ImportFailedError(restoreCause);
      }
      markFailed(jobId, restoreCause, lease);
      throw new PartialImportError(restoreCause, {
        chat: committedBeforeRollback !== "prepared",
        studio: committedBeforeRollback === "studio-committed",
      });
    }
    throw new ImportFailedError(cause);
  } finally {
    stopImportLeaseHeartbeat(lease);
  }

  function coordinatorJob(jobId: string): ImportJobRecord {
    const job = getImportJob(jobId);
    if (!job) {
      throw new Error(
        `Import coordinator lost its job record ${jobId}; recovery cannot roll the import back.`,
      );
    }
    return job;
  }

  async function runStudioImportTransaction(
    held: ImportLockLease,
  ): Promise<void> {
    const { verifyStudioImportFenceInTx, touchStudioImportFenceInTx } =
      await import("./import-fence");
    // The SQLite lease must be active and unexpired before any PostgreSQL
    // write — but that check alone cannot close the race (replacement can
    // happen after it and before COMMIT), so the transaction below is
    // additionally fenced inside PostgreSQL itself.
    renewImportLease(held);
    let insertedDrafts = 0;
    await getDatabase().transaction(async (tx) => {
      insertedDrafts = 0;
      summary.customDomains = 0;
      summary.skippedDomains = 0;
      // Early, non-locking fence verification inside this transaction. The
      // authoritative check is the conditional touch just before commit.
      await verifyStudioImportFenceInTx(tx, held);
      // File draft id → id written, so restored domains follow remapped drafts.
      const writtenDraftIds = new Map<string, string>();
      for (const incoming of backup.studio.drafts) {
        const [existing] = await tx
          .select({ id: studioDrafts.id })
          .from(studioDrafts)
          .where(eq(studioDrafts.id, incoming.id))
          .limit(1);
        if (existing) summary.remappedDraftIds += 1;
        const writtenId = existing ? randomUUID() : incoming.id;
        writtenDraftIds.set(incoming.id, writtenId);
        await tx.insert(studioDrafts).values({
          id: writtenId,
          ownerId,
          schemaVersion: incoming.schemaVersion,
          templateVersion: incoming.templateRegistryVersion ?? 1,
          themeVersion: incoming.themeRegistryVersion ?? 1,
          revision: incoming.revision ?? 1,
          createdAt: new Date(incoming.createdAt),
          updatedAt: new Date(incoming.updatedAt),
          brief: incoming.brief,
        });
        insertedDrafts += 1;
      }

      // Customer accounts ride in the same PostgreSQL transaction so a failed
      // or fenced import cannot leave half-restored customer data behind. The
      // onConflictDoNothing + pre-filter combination mirrors the SQLite path:
      // an existing account (by id or unique email) is never overwritten.
      if (backup.customers) {
        const existingRows = await tx
          .select({ id: customerAccounts.id, email: customerAccounts.email })
          .from(customerAccounts);
        const usableAccountIds = new Set(existingRows.map((row) => row.id));
        const existingEmails = new Set(
          existingRows.map((row) => row.email.toLowerCase()),
        );
        const freshAccounts = backup.customers.accounts.filter((account) => {
          const email = account.email.trim().toLowerCase();
          return (
            !usableAccountIds.has(account.id) && !existingEmails.has(email)
          );
        });
        summary.skippedCustomerAccounts =
          backup.customers.accounts.length - freshAccounts.length;
        if (freshAccounts.length > 0) {
          const insertedAccounts = await tx
            .insert(customerAccounts)
            .values(
              freshAccounts.map((account) => ({
                id: account.id,
                email: account.email.trim().toLowerCase(),
                name: account.name,
                passwordHash: account.passwordHash,
                emailVerifiedAt: account.emailVerifiedAt
                  ? new Date(account.emailVerifiedAt)
                  : null,
                createdAt: new Date(account.createdAt),
                updatedAt: new Date(account.updatedAt),
              })),
            )
            .onConflictDoNothing()
            .returning({ id: customerAccounts.id });
          summary.customerAccounts = insertedAccounts.length;
          for (const row of insertedAccounts) usableAccountIds.add(row.id);
        }

        const freshSessions = backup.customers.sessions.filter((session) =>
          usableAccountIds.has(session.accountId),
        );
        if (freshSessions.length > 0) {
          const insertedSessions = await tx
            .insert(customerSessions)
            .values(
              freshSessions.map((session) => ({
                id: session.id,
                accountId: session.accountId,
                tokenHash: session.tokenHash,
                expiresAt: new Date(session.expiresAt),
                createdAt: new Date(session.createdAt),
              })),
            )
            .onConflictDoNothing()
            .returning({ id: customerSessions.id });
          summary.customerSessions = insertedSessions.length;
        }

        const freshTokens = backup.customers.tokens.filter((token) =>
          usableAccountIds.has(token.accountId),
        );
        if (freshTokens.length > 0) {
          const insertedTokens = await tx
            .insert(customerTokens)
            .values(
              freshTokens.map((token) => ({
                id: token.id,
                accountId: token.accountId,
                purpose: token.purpose,
                tokenHash: token.tokenHash,
                context: token.context ?? null,
                expiresAt: new Date(token.expiresAt),
                usedAt: token.usedAt ? new Date(token.usedAt) : null,
                createdAt: new Date(token.createdAt),
              })),
            )
            .onConflictDoNothing()
            .returning({ id: customerTokens.id });
          summary.customerTokens = insertedTokens.length;
        }
      }

      // Custom domains ride in the same transaction. Each comes back
      // `pending` with a fresh verification token (the file carries none),
      // so a restored hostname is never served here until ownership is
      // proven again. Hostnames already attached to another draft, invalid
      // hostnames and domains of drafts absent from the file are skipped.
      if (backup.domains && backup.domains.domains.length > 0) {
        const candidates = backup.domains.domains.flatMap((domain) => {
          const draftId = writtenDraftIds.get(domain.draftId);
          const hostname = normalizeHostname(domain.hostname);
          if (!draftId || !hostname) {
            summary.skippedDomains += 1;
            return [];
          }
          return [{ ...domain, draftId, hostname }];
        });
        const taken = new Set(
          candidates.length === 0
            ? []
            : (
                await tx
                  .select({ hostname: studioDomains.hostname })
                  .from(studioDomains)
                  .where(
                    inArray(
                      studioDomains.hostname,
                      candidates.map((domain) => domain.hostname),
                    ),
                  )
              ).map((row) => row.hostname),
        );
        const seen = new Set<string>();
        const fresh = candidates.filter((domain) => {
          if (taken.has(domain.hostname) || seen.has(domain.hostname)) {
            summary.skippedDomains += 1;
            return false;
          }
          seen.add(domain.hostname);
          return true;
        });
        if (fresh.length > 0) {
          const inserted = await tx
            .insert(studioDomains)
            .values(
              fresh.map((domain) => ({
                draftId: domain.draftId,
                ownerId,
                hostname: domain.hostname,
                status: "pending",
                verificationToken: newVerificationToken(),
                verifiedAt: null,
                lastCheckedAt: null,
                createdAt: new Date(domain.createdAt),
                updatedAt: new Date(domain.updatedAt),
              })),
            )
            .onConflictDoNothing()
            .returning({ draftId: studioDomains.draftId });
          summary.customDomains = inserted.length;
          summary.skippedDomains += fresh.length - inserted.length;
        }
      }
      // A throw here rolls the PostgreSQL transaction back; the coordinator
      // still restores the already-committed chat half.
      await options.onCheckpoint?.("studio-imported");
      // Final fence check, immediately before COMMIT. The conditional
      // UPDATE takes the fence row's lock and matches only the held
      // owner/job/token/generation: if recovery advanced the fence while
      // this transaction was in flight, zero rows match, ImportLostLeaseError
      // is thrown and PostgreSQL rolls back every Studio write above.
      await touchStudioImportFenceInTx(tx, held);
      // Test-only latch between the fence touch and COMMIT: with the fence
      // row lock held, it deterministically reproduces the "obsolete
      // transaction wins the row-lock race" ordering.
      await options.onCheckpoint?.("studio-fenced");
    });
    // Only credited once the transaction above has committed.
    summary.studioDrafts = insertedDrafts;
    markStudioCommitted(jobId, held);
  }
}
