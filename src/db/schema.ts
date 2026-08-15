import {
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
