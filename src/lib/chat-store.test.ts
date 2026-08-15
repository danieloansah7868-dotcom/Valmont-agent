import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonChatStore } from "@/lib/chat-store";

const temporaryDirectories: string[] = [];

async function createStore() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "valmont-chat-store-"),
  );
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "chats.json");
  return { filePath, store: new JsonChatStore(filePath) };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("JSON chat store", () => {
  it("keeps reopenable sessions isolated by user", async () => {
    const { store } = await createStore();
    const first = await store.create({ userId: "user-1", title: "First chat" });
    const second = await store.create({
      userId: "user-2",
      title: "Private chat",
    });

    expect(await store.get(first.id, "user-1")).toMatchObject({
      id: first.id,
      title: "First chat",
    });
    expect(await store.get(second.id, "user-1")).toBeNull();
    expect(await store.list("user-1")).toHaveLength(1);
    expect(await store.delete(second.id, "user-1")).toBe(false);
    expect(await store.get(second.id, "user-2")).not.toBeNull();
  });

  it("persists messages, repository selection, and deletion atomically", async () => {
    const { filePath, store } = await createStore();
    const session = await store.create({
      userId: "user-1",
      repository: {
        id: "42",
        owner: "acme",
        name: "app",
        fullName: "acme/app",
        baseBranch: "feature/chat",
      },
    });
    await store.appendMessages(session.id, "user-1", [
      {
        id: "message-1",
        role: "user",
        content: "Explain the architecture",
        createdAt: new Date().toISOString(),
      },
    ]);
    const reopened = new JsonChatStore(filePath);
    expect(await reopened.get(session.id, "user-1")).toMatchObject({
      repository: { fullName: "acme/app", baseBranch: "feature/chat" },
      messages: [{ content: "Explain the architecture" }],
    });
    await expect(readFile(filePath, "utf8")).resolves.toContain("message-1");

    expect(await reopened.delete(session.id, "user-1")).toBe(true);
    expect(await reopened.get(session.id, "user-1")).toBeNull();
  });

  it("serializes concurrent message appends without losing a turn", async () => {
    const { store } = await createStore();
    const session = await store.create({ userId: "user-1" });
    const createdAt = new Date().toISOString();

    await Promise.all([
      store.appendMessages(
        session.id,
        "user-1",
        [{ id: "message-a", role: "user", content: "A", createdAt }],
        "First title",
      ),
      store.appendMessages(
        session.id,
        "user-1",
        [{ id: "message-b", role: "user", content: "B", createdAt }],
        "Second title",
      ),
    ]);

    const reopened = await store.get(session.id, "user-1");
    expect(reopened?.messages.map((message) => message.id).sort()).toEqual([
      "message-a",
      "message-b",
    ]);
    expect(reopened?.title).toBe("First title");
  });

  it("does not return mutable references to stored sessions", async () => {
    const { store } = await createStore();
    const created = await store.create({ userId: "user-1" });
    created.title = "Changed outside the store";

    expect(await store.get(created.id, "user-1")).toMatchObject({
      title: "New conversation",
    });
  });
});
