import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  approvals,
  codingTasks,
  pullRequests,
  taskEvents,
  toolExecutions,
  users,
} from "@/db/schema";
import type { SessionUser } from "@/lib/auth";
import { ForbiddenError } from "@/lib/api-errors";
import type {
  Approval,
  CodingTask,
  PullRequestRecord,
  TaskEvent,
  ToolExecution,
} from "@/lib/types";

interface StoreData {
  version: 1;
  tasks: CodingTask[];
}

export interface TaskStore {
  list(): Promise<CodingTask[]>;
  get(id: string): Promise<CodingTask | undefined>;
  save(task: CodingTask): Promise<void>;
}

export class JsonTaskStore implements TaskStore {
  private readonly file: string;
  private writeQueue = Promise.resolve();

  constructor(file = path.join(process.cwd(), ".data", "task-store.json")) {
    this.file = file;
  }

  async list(): Promise<CodingTask[]> {
    const data = await this.load();
    return structuredClone(data.tasks).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  async get(id: string): Promise<CodingTask | undefined> {
    const data = await this.load();
    const task = data.tasks.find((item) => item.id === id);
    return task ? structuredClone(task) : undefined;
  }

  async save(task: CodingTask): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const data = await this.load();
      const index = data.tasks.findIndex((item) => item.id === task.id);
      if (index >= 0) data.tasks[index] = structuredClone(task);
      else data.tasks.push(structuredClone(task));
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(data, null, 2), {
        mode: 0o600,
      });
      await rename(temporary, this.file);
    });
    await this.writeQueue;
  }

  private async load(): Promise<StoreData> {
    try {
      const value = JSON.parse(await readFile(this.file, "utf8")) as StoreData;
      if (value.version !== 1 || !Array.isArray(value.tasks))
        throw new Error("Invalid store data");
      return value;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code !== "ENOENT")
        throw error;
      return { version: 1, tasks: [] };
    }
  }
}

export class PostgresTaskStore implements TaskStore {
  private readonly databaseUserId: string;

  constructor(private readonly user: SessionUser) {
    this.databaseUserId = deterministicUuid(`github:${user.id}`);
  }

  async list(): Promise<CodingTask[]> {
    const rows = await getDatabase()
      .select({ id: codingTasks.id })
      .from(codingTasks)
      .where(eq(codingTasks.userId, this.databaseUserId))
      .orderBy(desc(codingTasks.updatedAt));
    return Promise.all(rows.map(({ id }) => this.requiredHydrated(id)));
  }

  async get(id: string): Promise<CodingTask | undefined> {
    if (!isUuid(id)) return undefined;
    const [row] = await getDatabase()
      .select()
      .from(codingTasks)
      .where(
        and(
          eq(codingTasks.id, id),
          eq(codingTasks.userId, this.databaseUserId),
        ),
      )
      .limit(1);
    if (!row) return undefined;

    const [eventRows, approvalRows, toolRows, pullRows] = await Promise.all([
      getDatabase()
        .select()
        .from(taskEvents)
        .where(eq(taskEvents.taskId, id))
        .orderBy(taskEvents.createdAt),
      getDatabase()
        .select()
        .from(approvals)
        .where(eq(approvals.taskId, id))
        .orderBy(approvals.createdAt),
      getDatabase()
        .select()
        .from(toolExecutions)
        .where(eq(toolExecutions.taskId, id))
        .orderBy(toolExecutions.createdAt),
      getDatabase()
        .select()
        .from(pullRequests)
        .where(eq(pullRequests.taskId, id))
        .limit(1),
    ]);

    const events: TaskEvent[] = eventRows.map((event) => ({
      id: event.id,
      taskId: event.taskId,
      type: event.type as TaskEvent["type"],
      title: event.title,
      detail: event.detail,
      actor: event.actor as TaskEvent["actor"],
      createdAt: event.createdAt.toISOString(),
      metadata: event.metadata ?? undefined,
    }));
    const taskApprovals: Approval[] = approvalRows.map((approval) => ({
      id: approval.id,
      taskId: approval.taskId,
      stage: approval.stage,
      decision: approval.decision,
      actorId: this.user.id,
      note: approval.note ?? undefined,
      createdAt: approval.createdAt.toISOString(),
    }));
    const tools: ToolExecution[] = toolRows.map((tool) => ({
      id: tool.id,
      taskId: tool.taskId,
      tool: tool.tool,
      inputSummary: tool.inputSummary,
      outputSummary: tool.outputSummary,
      status: tool.status === "succeeded" ? "succeeded" : "failed",
      durationMs: tool.durationMs,
      createdAt: tool.createdAt.toISOString(),
    }));
    const pull = pullRows[0];
    const pullRequest: PullRequestRecord | undefined = pull
      ? {
          id: pull.id,
          taskId: pull.taskId,
          providerId: pull.githubId,
          number: pull.number,
          url: pull.url,
          title: pull.title,
          branch: pull.branch,
          baseBranch: pull.baseBranch,
          status: "open",
          createdAt: pull.createdAt.toISOString(),
        }
      : undefined;
    return {
      id: row.id,
      userId: this.user.id,
      title: row.title,
      description: row.description,
      repositoryId: row.repositoryConnectionId ?? row.repositoryName,
      repositoryName: row.repositoryName,
      baseBranch: row.baseBranch,
      state: row.state,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      plan: row.plan ?? undefined,
      diff: row.diff ?? undefined,
      validations: row.validations,
      events,
      approvals: taskApprovals,
      toolExecutions: tools,
      pullRequest,
    };
  }

  async save(task: CodingTask): Promise<void> {
    if (!isUuid(task.id))
      throw new Error("PostgreSQL tasks require UUID identifiers");
    if (task.userId && task.userId !== this.user.id) {
      throw new ForbiddenError("Task ownership check failed");
    }
    const db = getDatabase();
    await db
      .insert(users)
      .values({
        id: this.databaseUserId,
        githubId: this.user.id,
        name: this.user.name,
        avatarUrl: this.user.avatarUrl,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          name: this.user.name,
          avatarUrl: this.user.avatarUrl,
          updatedAt: new Date(),
        },
      });
    await db
      .insert(codingTasks)
      .values({
        id: task.id,
        userId: this.databaseUserId,
        title: task.title,
        description: task.description,
        repositoryName: task.repositoryName,
        baseBranch: task.baseBranch,
        state: task.state,
        plan: task.plan,
        diff: task.diff,
        validations: task.validations,
        createdAt: new Date(task.createdAt),
        updatedAt: new Date(task.updatedAt),
      })
      .onConflictDoUpdate({
        target: codingTasks.id,
        set: {
          title: task.title,
          description: task.description,
          state: task.state,
          plan: task.plan,
          diff: task.diff,
          validations: task.validations,
          updatedAt: new Date(task.updatedAt),
        },
      });

    if (task.events.length) {
      await db
        .insert(taskEvents)
        .values(
          task.events.map((event) => ({
            id: event.id,
            taskId: task.id,
            type: event.type,
            title: event.title,
            detail: event.detail,
            actor: event.actor,
            metadata: event.metadata,
            createdAt: new Date(event.createdAt),
          })),
        )
        .onConflictDoNothing();
    }
    if (task.approvals.length) {
      await db
        .insert(approvals)
        .values(
          task.approvals.map((approval) => ({
            id: approval.id,
            taskId: task.id,
            userId: this.databaseUserId,
            stage: approval.stage,
            decision: approval.decision,
            note: approval.note,
            createdAt: new Date(approval.createdAt),
          })),
        )
        .onConflictDoNothing();
    }
    if (task.toolExecutions.length) {
      await db
        .insert(toolExecutions)
        .values(
          task.toolExecutions.map((tool) => ({
            id: tool.id,
            taskId: task.id,
            tool: tool.tool,
            inputSummary: tool.inputSummary,
            outputSummary: tool.outputSummary,
            status:
              tool.status === "succeeded"
                ? ("succeeded" as const)
                : ("failed" as const),
            durationMs: tool.durationMs,
            createdAt: new Date(tool.createdAt),
          })),
        )
        .onConflictDoNothing();
    }
    if (task.pullRequest) {
      const pull = task.pullRequest;
      await db
        .insert(pullRequests)
        .values({
          id: isUuid(pull.id) ? pull.id : deterministicUuid(pull.id),
          taskId: task.id,
          githubId: pull.providerId,
          number: pull.number,
          url: pull.url,
          title: pull.title,
          branch: pull.branch,
          baseBranch: pull.baseBranch,
          status: pull.status,
          createdAt: new Date(pull.createdAt),
        })
        .onConflictDoUpdate({
          target: pullRequests.taskId,
          set: {
            githubId: pull.providerId,
            number: pull.number,
            url: pull.url,
            status: pull.status,
          },
        });
    }
  }

  private async requiredHydrated(id: string): Promise<CodingTask> {
    const task = await this.get(id);
    if (!task) throw new Error("Task disappeared during database read");
    return task;
  }
}

const globalStore = globalThis as typeof globalThis & {
  __valmontTaskStore?: JsonTaskStore;
  __valmontPostgresStores?: Map<string, PostgresTaskStore>;
};

export function getTaskStore(user?: SessionUser): TaskStore {
  if (!process.env.DATABASE_URL) {
    globalStore.__valmontTaskStore ??= new JsonTaskStore();
    return globalStore.__valmontTaskStore;
  }
  if (!user)
    throw new Error("A session user is required for PostgreSQL task access");
  globalStore.__valmontPostgresStores ??= new Map();
  const existing = globalStore.__valmontPostgresStores.get(user.id);
  if (existing) return existing;
  const store = new PostgresTaskStore(user);
  globalStore.__valmontPostgresStores.set(user.id, store);
  return store;
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
