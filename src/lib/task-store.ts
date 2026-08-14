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
import { demoModeEnabled } from "@/lib/config";
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

const SEED_TASK: CodingTask = {
  id: "task-demo-1042",
  title: "Add empty state to project dashboard",
  description:
    "Show a helpful empty state when a workspace has no active projects, including a link to create the first project.",
  repositoryId: "demo-repo-1",
  repositoryName: "acme-labs/atlas-web",
  baseBranch: "main",
  state: "awaiting_plan_approval",
  createdAt: "2026-08-14T09:14:00.000Z",
  updatedAt: "2026-08-14T09:15:23.000Z",
  demo: true,
  plan: {
    summary:
      "Add an accessible project-dashboard empty state by reusing the existing Button and EmptyState primitives, then cover both empty and populated paths.",
    risk: "low",
    generatedBy: "demo",
    validationCommands: ["npm test", "npm run typecheck"],
    steps: [
      {
        title: "Add an empty project state",
        description:
          "Render the shared EmptyState component when the projects query succeeds with zero records.",
        files: ["src/features/projects/project-grid.tsx"],
      },
      {
        title: "Preserve dashboard behavior",
        description:
          "Keep loading, error, and populated project-grid branches unchanged and add a clear create-project action.",
        files: ["src/features/projects/project-grid.tsx"],
      },
      {
        title: "Cover both render paths",
        description:
          "Add focused component tests for zero projects and a populated project response.",
        files: ["src/features/projects/project-grid.test.tsx"],
      },
    ],
  },
  validations: [],
  approvals: [],
  toolExecutions: [
    {
      id: "tool-seed-1",
      taskId: "task-demo-1042",
      tool: "list_files",
      inputSummary: "src/features/projects (depth 3)",
      outputSummary:
        "Found 12 relevant source and test files (demo repository)",
      status: "succeeded",
      durationMs: 81,
      createdAt: "2026-08-14T09:14:15.000Z",
    },
    {
      id: "tool-seed-2",
      taskId: "task-demo-1042",
      tool: "search_code",
      inputSummary: 'Search: "project grid empty loading"',
      outputSummary:
        "Matched project-grid.tsx, project-card.tsx, and 2 test files (demo data)",
      status: "succeeded",
      durationMs: 128,
      createdAt: "2026-08-14T09:14:17.000Z",
    },
    {
      id: "tool-seed-3",
      taskId: "task-demo-1042",
      tool: "read_file",
      inputSummary: "3 files selected by lexical retrieval",
      outputSummary:
        "Retrieved 286 lines; secrets and excluded paths were not accessed (demo data)",
      status: "succeeded",
      durationMs: 94,
      createdAt: "2026-08-14T09:14:19.000Z",
    },
  ],
  events: [
    {
      id: "event-seed-1",
      taskId: "task-demo-1042",
      type: "state",
      title: "Task submitted",
      detail: "Task moved from draft to planning.",
      actor: "user",
      createdAt: "2026-08-14T09:14:00.000Z",
    },
    {
      id: "event-seed-2",
      taskId: "task-demo-1042",
      type: "tool",
      title: "Repository context retrieved",
      detail:
        "Inspected 12 files and selected 3 relevant files. Demo repository data was used.",
      actor: "agent",
      createdAt: "2026-08-14T09:14:19.000Z",
    },
    {
      id: "event-seed-3",
      taskId: "task-demo-1042",
      type: "model",
      title: "Implementation plan prepared",
      detail:
        "Deterministic demo planner produced a 3-step plan. No external model was called.",
      actor: "agent",
      createdAt: "2026-08-14T09:15:20.000Z",
    },
    {
      id: "event-seed-4",
      taskId: "task-demo-1042",
      type: "state",
      title: "Plan approval required",
      detail:
        "Execution is blocked until you approve or reject the implementation plan.",
      actor: "system",
      createdAt: "2026-08-14T09:15:23.000Z",
    },
  ],
};

export class JsonTaskStore implements TaskStore {
  private readonly file: string;
  private writeQueue = Promise.resolve();

  constructor(file = path.join(process.cwd(), ".data", "demo-store.json")) {
    this.file = file;
  }

  async list(): Promise<CodingTask[]> {
    const data = await this.load();
    const visible = demoModeEnabled()
      ? data.tasks
      : data.tasks.filter((task) => !task.demo);
    return structuredClone(visible).sort((a, b) =>
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
      // The fictional seed task exists only for explicitly enabled demo mode.
      return {
        version: 1,
        tasks: demoModeEnabled() ? [structuredClone(SEED_TASK)] : [],
      };
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
          demo: pull.isDemo,
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
      demo: row.isDemo,
    };
  }

  async save(task: CodingTask): Promise<void> {
    if (!isUuid(task.id))
      throw new Error("PostgreSQL tasks require UUID identifiers");
    if (task.userId && task.userId !== this.user.id) {
      throw new Error("Task ownership check failed");
    }
    const db = getDatabase();
    await db
      .insert(users)
      .values({
        id: this.databaseUserId,
        githubId: this.user.demo ? null : this.user.id,
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
        isDemo: task.demo,
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
          isDemo: pull.demo,
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
