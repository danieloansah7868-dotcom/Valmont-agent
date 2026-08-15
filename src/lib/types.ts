export const TASK_STATES = [
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
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export interface PlanStep {
  title: string;
  description: string;
  files: string[];
}

export interface TaskPlan {
  summary: string;
  steps: PlanStep[];
  validationCommands: string[];
  risk: "low" | "medium" | "high";
  generatedBy: "model";
}

export interface TaskEvent {
  id: string;
  taskId: string;
  type: "state" | "tool" | "approval" | "model" | "system" | "error";
  title: string;
  detail: string;
  actor: "user" | "agent" | "system";
  createdAt: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface Approval {
  id: string;
  taskId: string;
  stage: "plan" | "final";
  decision: "approved" | "rejected";
  actorId: string;
  note?: string;
  createdAt: string;
}

export interface ToolExecution {
  id: string;
  taskId: string;
  tool: string;
  inputSummary: string;
  outputSummary: string;
  status: "running" | "succeeded" | "failed";
  durationMs: number;
  createdAt: string;
}

export interface ValidationResult {
  command: string;
  status: "passed" | "failed" | "timed_out";
  output: string;
  durationMs: number;
}

export interface PullRequestRecord {
  id: string;
  taskId: string;
  providerId: string;
  number: number;
  url: string;
  title: string;
  branch: string;
  baseBranch: string;
  status: "open";
  createdAt: string;
}

export interface CodingTask {
  id: string;
  /** Session owner; required by the PostgreSQL store. */
  userId?: string;
  title: string;
  description: string;
  repositoryId: string;
  repositoryName: string;
  baseBranch: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  plan?: TaskPlan;
  diff?: string;
  validations: ValidationResult[];
  events: TaskEvent[];
  approvals: Approval[];
  toolExecutions: ToolExecution[];
  pullRequest?: PullRequestRecord;
}

export interface RepositorySummary {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  defaultBranch: string;
  private: boolean;
  language: string;
  updatedAt: string;
}

export interface ChatRepositoryContext {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  baseBranch: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ChatSession {
  id: string;
  userId: string;
  title: string;
  repository?: ChatRepositoryContext;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}
