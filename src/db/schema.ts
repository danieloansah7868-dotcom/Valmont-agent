import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { TaskPlan, ValidationResult } from "@/lib/types";

export const taskStateEnum = pgEnum("task_state", [
  "draft",
  "planning",
  "awaiting_plan_approval",
  "executing",
  "testing",
  "awaiting_final_approval",
  "creating_pull_request",
  "completed",
  "failed",
  "cancelled",
]);
export const approvalStageEnum = pgEnum("approval_stage", ["plan", "final"]);
export const approvalDecisionEnum = pgEnum("approval_decision", [
  "approved",
  "rejected",
]);
export const executionStatusEnum = pgEnum("execution_status", [
  "running",
  "succeeded",
  "failed",
  "timed_out",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubId: text("github_id").unique(),
  name: text("name").notNull(),
  email: text("email"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    // OAuth credentials must be AES-GCM encrypted before storage; never select into client data.
    encryptedAccessToken: text("encrypted_access_token"),
    scope: text("scope"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("accounts_provider_unique").on(
      table.provider,
      table.providerAccountId,
    ),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

export const repositoryConnections = pgTable(
  "repository_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    githubRepositoryId: text("github_repository_id").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    isPrivate: boolean("is_private").notNull().default(true),
    authorizedAt: timestamp("authorized_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("repository_connection_unique").on(
      table.userId,
      table.githubRepositoryId,
    ),
  ],
);

export const codingTasks = pgTable(
  "coding_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    repositoryConnectionId: uuid("repository_connection_id").references(
      () => repositoryConnections.id,
    ),
    title: text("title").notNull(),
    description: text("description").notNull(),
    repositoryName: text("repository_name").notNull(),
    baseBranch: text("base_branch").notNull(),
    state: taskStateEnum("state").notNull().default("draft"),
    plan: jsonb("plan").$type<TaskPlan>(),
    diff: text("diff"),
    validations: jsonb("validations")
      .$type<ValidationResult[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("coding_tasks_user_updated_idx").on(table.userId, table.updatedAt),
  ],
);

export const taskEvents = pgTable(
  "task_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => codingTasks.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    actor: text("actor").notNull(),
    metadata:
      jsonb("metadata").$type<Record<string, string | number | boolean>>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("task_events_task_created_idx").on(table.taskId, table.createdAt),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => codingTasks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    stage: approvalStageEnum("stage").notNull(),
    decision: approvalDecisionEnum("decision").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("approvals_task_stage_idx").on(table.taskId, table.stage)],
);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => codingTasks.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  externalId: text("external_id").notNull(),
  status: text("status").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const modelExecutions = pgTable(
  "model_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => codingTasks.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    purpose: text("purpose").notNull(),
    status: executionStatusEnum("status").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("model_executions_task_idx").on(table.taskId)],
);

export const toolExecutions = pgTable(
  "tool_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => codingTasks.id, { onDelete: "cascade" }),
    tool: text("tool").notNull(),
    inputSummary: text("input_summary").notNull(),
    outputSummary: text("output_summary").notNull(),
    status: executionStatusEnum("status").notNull(),
    durationMs: integer("duration_ms").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("tool_executions_task_idx").on(table.taskId)],
);

export const studioDrafts = pgTable(
  "studio_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    schemaVersion: integer("schema_version").notNull().default(1),
    templateVersion: integer("template_version").notNull().default(1),
    themeVersion: integer("theme_version").notNull().default(1),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    brief: jsonb("brief").notNull(),
  },
  (table) => [
    index("studio_drafts_owner_updated_idx").on(table.ownerId, table.updatedAt),
  ],
);

/**
 * Durable per-owner import fence for PostgreSQL Studio writes.
 *
 * Mixed complete-backup imports write Chat into SQLite and Studio into
 * PostgreSQL. The SQLite lease alone cannot fence an in-flight PostgreSQL
 * transaction: the lease can expire and be replaced *after* a SQLite token
 * check but *before* the PostgreSQL COMMIT. This row closes that gap: every
 * PostgreSQL Studio import/restore transaction must end with a conditional
 * touch of this row (matching owner, job, token and generation) immediately
 * before commit, and recovery advances it inside the same transaction that
 * restores Studio state. PostgreSQL row-level locking then serializes the
 * two, so an obsolete transaction either fails its final fence check and
 * rolls back, or commits strictly before the replacement fence is installed
 * and is then fully undone by the recovery restore that serialized after it.
 *
 * The row deliberately persists after a successful release so generations
 * stay monotonic for the owner even if the SQLite file is replaced. It holds
 * identity only — never a backup payload, pre-state snapshot, credential or
 * any other sensitive data — and it is never included in exported backups.
 */
export const studioImportFences = pgTable("studio_import_fences", {
  /** Canonical owner id — the Studio/PostgreSQL identity. */
  ownerId: uuid("owner_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Coordinator job id the fence currently belongs to. */
  jobId: text("job_id").notNull(),
  /** Cryptographically random lock token issued with the SQLite lease. */
  lockToken: text("lock_token").notNull(),
  /** Monotonic per-owner generation; never decreases, never resets. */
  generation: bigint("generation", { mode: "number" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Phase 3 orders. A customer basket that has been checked out. Rows are created
 * by the public checkout endpoint and advanced by the payments webhook. The
 * `access_code` is an unguessable secret that both the hosted payment page and
 * the webhook are keyed on, so no row is addressable without it.
 */
export const studioOrders = pgTable(
  "studio_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => studioDrafts.id, { onDelete: "cascade" }),
    accessCode: text("access_code").notNull().unique(),
    status: text("status").notNull().default("pending"),
    currency: text("currency").notNull().default("GHS"),
    subtotal: integer("subtotal").notNull().default(0),
    deliveryFee: integer("delivery_fee").notNull().default(0),
    total: integer("total").notNull().default(0),
    linesJson: jsonb("lines_json").notNull(),
    customerName: text("customer_name").notNull(),
    customerPhone: text("customer_phone").notNull(),
    customerEmail: text("customer_email"),
    customerAddress: text("customer_address"),
    paymentMethod: text("payment_method").notNull(),
    paymentRef: text("payment_ref"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    preparingAt: timestamp("preparing_at", { withTimezone: true }),
    outForDeliveryAt: timestamp("out_for_delivery_at", { withTimezone: true }),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    statusHistory: jsonb("status_history").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    merchantNote: text("merchant_note"),
  },
  (table) => [
    index("studio_orders_owner_created_idx").on(table.ownerId, table.createdAt),
    index("studio_orders_draft_idx").on(table.draftId),
    uniqueIndex("studio_orders_access_code_idx").on(table.accessCode),
  ],
);

/**
 * Studio payment settings — a single row (id always 1) holding the Valmont
 * Pay account details saved on the Studio → Settings → Payments page. The
 * secret fields are AES-256-GCM envelopes (see `encryptSessionValue`); the
 * plaintext never leaves the server and is never included in backups or API
 * responses.
 */
/**
 * Phase 5 custom domains.
 */
export const studioDomains = pgTable(
  "studio_domains",
  {
    draftId: uuid("draft_id")
      .primaryKey()
      .references(() => studioDrafts.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull().unique(),
    status: text("status").notNull().default("not_set"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("studio_domains_owner_idx").on(table.ownerId),
  ],
);

export const studioSettings = pgTable("studio_settings", {
  id: integer("id").primaryKey(),
  mode: text("mode").notNull().default("test"),
  apiUrlEnc: text("api_url_enc"),
  apiKeyEnc: text("api_key_enc"),
  webhookSecretEnc: text("webhook_secret_enc"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedBy: text("updated_by"),
});

export const pullRequests = pgTable("pull_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .notNull()
    .unique()
    .references(() => codingTasks.id, { onDelete: "cascade" }),
  githubId: text("github_id").notNull(),
  number: integer("number").notNull(),
  url: text("url").notNull(),
  title: text("title").notNull(),
  branch: text("branch").notNull(),
  baseBranch: text("base_branch").notNull(),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
