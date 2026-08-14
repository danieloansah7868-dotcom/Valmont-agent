import { randomUUID } from "node:crypto";
import { closeDatabase, getDatabase } from "../src/db/index";
import {
  codingTasks,
  repositoryConnections,
  taskEvents,
  users,
} from "../src/db/schema";

async function seed() {
  const db = getDatabase();
  const userId = randomUUID();
  const repositoryId = randomUUID();
  const taskId = randomUUID();
  await db.insert(users).values({
    id: userId,
    name: "Demo Builder",
    email: "demo@example.invalid",
  });
  await db.insert(repositoryConnections).values({
    id: repositoryId,
    userId,
    githubRepositoryId: "demo-repo-1",
    owner: "acme-labs",
    name: "atlas-web",
    defaultBranch: "main",
    isPrivate: true,
  });
  await db.insert(codingTasks).values({
    id: taskId,
    userId,
    repositoryConnectionId: repositoryId,
    title: "Add empty state to project dashboard",
    description:
      "Show a helpful project empty state with a create-project action.",
    repositoryName: "acme-labs/atlas-web",
    baseBranch: "main",
    state: "awaiting_plan_approval",
    isDemo: true,
  });
  await db.insert(taskEvents).values({
    taskId,
    type: "state",
    title: "Plan approval required",
    detail: "Seed task created for local evaluation.",
    actor: "system",
  });
  console.log(`Seeded demo task ${taskId}`);
}

seed()
  .finally(closeDatabase)
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
