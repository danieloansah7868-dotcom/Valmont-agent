import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatRepositoryContext, ChatSession } from "@/lib/types";

const DEFAULT_CHAT_STORE_PATH = path.join(
  process.cwd(),
  ".data",
  "chat-store.json",
);

type ChatStoreDocument = {
  sessions: ChatSession[];
};

export interface ChatStore {
  appendMessages(
    id: string,
    userId: string,
    messages: ChatSession["messages"],
    titleIfNew?: string,
  ): Promise<ChatSession>;
  create(input: {
    userId: string;
    title?: string;
    repository?: ChatRepositoryContext;
  }): Promise<ChatSession>;
  delete(id: string, userId: string): Promise<boolean>;
  get(id: string, userId: string): Promise<ChatSession | null>;
  list(userId: string): Promise<ChatSession[]>;
}

function cloneSession(session: ChatSession): ChatSession {
  return structuredClone(session);
}

function normalizeDocument(value: unknown): ChatStoreDocument {
  if (!value || typeof value !== "object") {
    return { sessions: [] };
  }

  const sessions = (value as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) {
    return { sessions: [] };
  }

  return {
    sessions: sessions.filter(
      (session): session is ChatSession =>
        Boolean(session) &&
        typeof session === "object" &&
        typeof (session as ChatSession).id === "string" &&
        typeof (session as ChatSession).userId === "string" &&
        Array.isArray((session as ChatSession).messages),
    ),
  };
}

export class JsonChatStore implements ChatStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath = process.env.CHAT_STORE_PATH ||
      DEFAULT_CHAT_STORE_PATH,
  ) {}

  async appendMessages(
    id: string,
    userId: string,
    messages: ChatSession["messages"],
    titleIfNew?: string,
  ): Promise<ChatSession> {
    let saved: ChatSession | null = null;
    await this.mutate((document) => {
      const session = document.sessions.find(
        (candidate) => candidate.id === id && candidate.userId === userId,
      );
      if (!session) throw new Error("Chat not found");
      session.messages.push(...structuredClone(messages));
      if (session.title === "New conversation" && titleIfNew) {
        session.title = titleIfNew;
      }
      session.updatedAt = new Date().toISOString();
      saved = cloneSession(session);
    });
    if (!saved) throw new Error("Chat not found");
    return saved;
  }

  async create(input: {
    userId: string;
    title?: string;
    repository?: ChatRepositoryContext;
  }): Promise<ChatSession> {
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: randomUUID(),
      userId: input.userId,
      title: input.title?.trim() || "New conversation",
      repository: input.repository,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };

    await this.mutate((document) => {
      document.sessions.push(session);
    });

    return cloneSession(session);
  }

  async delete(id: string, userId: string): Promise<boolean> {
    let deleted = false;
    await this.mutate((document) => {
      const index = document.sessions.findIndex(
        (session) => session.id === id && session.userId === userId,
      );
      if (index >= 0) {
        document.sessions.splice(index, 1);
        deleted = true;
      }
    });
    return deleted;
  }

  async get(id: string, userId: string): Promise<ChatSession | null> {
    await this.writeQueue;
    const document = await this.read();
    const session = document.sessions.find(
      (candidate) => candidate.id === id && candidate.userId === userId,
    );
    return session ? cloneSession(session) : null;
  }

  async list(userId: string): Promise<ChatSession[]> {
    await this.writeQueue;
    const document = await this.read();
    return document.sessions
      .filter((session) => session.userId === userId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(cloneSession);
  }

  private async mutate(
    update: (document: ChatStoreDocument) => void,
  ): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const document = await this.read();
      update(document);
      await this.write(document);
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  private async read(): Promise<ChatStoreDocument> {
    try {
      const content = await readFile(this.filePath, "utf8");
      return normalizeDocument(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { sessions: [] };
      }
      throw error;
    }
  }

  private async write(document: ChatStoreDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(document, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

const globalChatStore = globalThis as typeof globalThis & {
  __valmontChatStore?: ChatStore;
};

export function getChatStore(): ChatStore {
  globalChatStore.__valmontChatStore ??= new JsonChatStore();
  return globalChatStore.__valmontChatStore;
}

export function setChatStoreForTests(store: ChatStore | null) {
  if (store) globalChatStore.__valmontChatStore = store;
  else delete globalChatStore.__valmontChatStore;
}
