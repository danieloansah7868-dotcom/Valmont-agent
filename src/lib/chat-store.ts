import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type {
  ChatMessage,
  ChatRepositoryContext,
  ChatSession,
} from "@/lib/types";
import { redactSecrets } from "@/lib/security";

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

export function getChatStore(): SqliteChatStore {
  return getSqliteChatStore();
}

export function setChatStoreForTests(store: ChatStore | null) {
  if (store) globalChatStore.__valmontChatStore = store;
  else delete globalChatStore.__valmontChatStore;
}

// SQLite is the active chat store. The JSON class above is deliberately retained
// only as a read-compatible migration source for installations created before
// SQLite-backed chat history.
/**
 * `CHAT_STORE_PATH` remains the legacy JSON input for backwards-compatible
 * upgrades. SQLite always writes to a distinct path, either explicitly via
 * `CHAT_SQLITE_PATH` or next to the legacy source.
 */
export function deriveSqliteChatStorePath(legacyPath: string): string {
  const extension = path.extname(legacyPath);
  const stem = extension ? legacyPath.slice(0, -extension.length) : legacyPath;
  const destination = `${stem}.sqlite`;
  // A legacy JSON file can have any extension, including `.sqlite`. Preserve
  // the safety invariant even for that unusual historical configuration.
  return path.resolve(destination) === path.resolve(legacyPath)
    ? `${legacyPath}.sqlite`
    : destination;
}

function configuredLegacyChatStorePath(): string {
  return process.env.CHAT_STORE_PATH || DEFAULT_CHAT_STORE_PATH;
}

function configuredSqliteChatStorePath(legacyPath: string): string {
  return process.env.CHAT_SQLITE_PATH || deriveSqliteChatStorePath(legacyPath);
}

function legacyBackupPath(legacyPath: string): string {
  return `${legacyPath}.pre-sqlite-backup`;
}

function assertDistinctStorePaths(
  legacyPath: string,
  sqlitePath: string,
): void {
  const source = path.resolve(legacyPath);
  const destination = path.resolve(sqlitePath);
  if (source === destination) {
    throw new Error(
      "CHAT_STORE_PATH (legacy JSON) and CHAT_SQLITE_PATH (SQLite destination) must be distinct",
    );
  }

  // Different spellings can still address the same existing file through a
  // symlink or hard link. Detect that before DatabaseSync gets a chance to
  // write a SQLite header over the legacy JSON source.
  if (existsSync(legacyPath) && existsSync(sqlitePath)) {
    const sourceStat = statSync(legacyPath);
    const destinationStat = statSync(sqlitePath);
    if (
      sourceStat.dev === destinationStat.dev &&
      sourceStat.ino === destinationStat.ino
    ) {
      throw new Error(
        "CHAT_STORE_PATH (legacy JSON) and CHAT_SQLITE_PATH (SQLite destination) must be distinct",
      );
    }
  }

  if (destination === path.resolve(legacyBackupPath(legacyPath))) {
    throw new Error(
      "CHAT_SQLITE_PATH must not use the legacy .pre-sqlite-backup path",
    );
  }
}

export interface ChatMemory {
  id: string;
  scope: "personal" | "repository";
  repositoryId?: string;
  category: "preference" | "fact" | "decision" | "project";
  content: string;
  sourceSessionId?: string;
  createdAt: string;
  updatedAt: string;
}

type SessionRow = {
  id: string;
  user_id: string;
  title: string;
  repository_json: string | null;
  summary: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

/** Local, durable SQLite store. All queries bind the authenticated user id. */
export class SqliteChatStore implements ChatStore {
  private readonly db: DatabaseSync;

  constructor(filePath?: string, legacyPath = configuredLegacyChatStorePath()) {
    const sqlitePath = filePath ?? configuredSqliteChatStorePath(legacyPath);
    assertDistinctStorePaths(legacyPath, sqlitePath);
    mkdirSync(path.dirname(sqlitePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(sqlitePath);
    try {
      chmodSync(sqlitePath, 0o600);
    } catch {
      // The database was still opened with the process umask; this is best effort
      // on filesystems that do not support POSIX permissions.
    }
    this.db.exec(
      "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
    );
    this.initialize();
    this.migrateLegacyJson(legacyPath);
  }

  private initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL,
        repository_json TEXT, summary TEXT NOT NULL DEFAULT '', archived_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_sessions_user_updated ON chat_sessions(user_id, archived_at, updated_at DESC);
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content TEXT NOT NULL, created_at TEXT NOT NULL, model TEXT,
        input_tokens INTEGER, output_tokens INTEGER
      );
      CREATE INDEX IF NOT EXISTS chat_messages_session_created ON chat_messages(session_id, created_at, id);
      CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(content, message_id UNINDEXED, user_id UNINDEXED, session_id UNINDEXED);
      CREATE TABLE IF NOT EXISTS chat_memories (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('personal','repository')),
        repository_id TEXT, category TEXT NOT NULL CHECK(category IN ('preference','fact','decision','project')),
        content TEXT NOT NULL, source_session_id TEXT REFERENCES chat_sessions(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_memories_user_scope ON chat_memories(user_id, scope, repository_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS chat_preferences (user_id TEXT PRIMARY KEY, cross_chat_memory INTEGER NOT NULL DEFAULT 1);
    `);
  }

  private migrateLegacyJson(legacyPath: string) {
    if (this.hasLegacyMigrationMarker() || !existsSync(legacyPath)) return;

    // Copy before beginning the SQLite migration. The source is never opened as
    // a database, and an existing backup is left untouched on every retry.
    this.backupLegacyJson(legacyPath);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Another process can complete the migration while this process waits for
      // the immediate transaction lock. Recheck so a restart is idempotent.
      if (this.hasLegacyMigrationMarker()) {
        this.db.exec("COMMIT");
        return;
      }
      const legacy = parseLegacyChatStore(readFileSyncCompat(legacyPath));
      for (const session of legacy.sessions) this.insertSession(session);
      // The marker is committed in the same transaction as the migrated rows,
      // so a failed parse/insert/commit never records a completed migration.
      this.db
        .prepare("INSERT INTO chat_meta(key, value) VALUES (?, ?)")
        .run("legacy-json-migrated", new Date().toISOString());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private hasLegacyMigrationMarker(): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 FROM chat_meta WHERE key = ?")
        .get("legacy-json-migrated"),
    );
  }

  private backupLegacyJson(legacyPath: string) {
    const backupPath = legacyBackupPath(legacyPath);
    if (existsSync(backupPath)) return;
    try {
      copyFileSync(legacyPath, backupPath, constants.COPYFILE_EXCL);
    } catch (error) {
      // A concurrent startup may have produced the backup after our existence
      // check. It is safe to reuse that immutable copy; all other failures must
      // stop before migration begins.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      chmodSync(backupPath, 0o600);
    } catch {
      // The directory's owner-only mode still protects new default paths; this
      // is best effort for filesystems without POSIX permissions.
    }
  }

  private insertSession(session: ChatSession) {
    const inserted = this.db
      .prepare(
        "INSERT OR IGNORE INTO chat_sessions(id,user_id,title,repository_json,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        session.id,
        session.userId,
        session.title,
        session.repository ? JSON.stringify(session.repository) : null,
        session.createdAt,
        session.updatedAt,
      );
    // A pre-existing session ID must not receive messages from another legacy
    // document. It also ensures retries cannot duplicate FTS entries.
    if (Number(inserted.changes) === 0) return;
    const message = this.db.prepare(
      "INSERT OR IGNORE INTO chat_messages(id,session_id,user_id,role,content,created_at,model,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    const fts = this.db.prepare(
      "INSERT INTO chat_messages_fts(content,message_id,user_id,session_id) VALUES (?,?,?,?)",
    );
    for (const item of session.messages) {
      const result = message.run(
        item.id,
        session.id,
        session.userId,
        item.role,
        item.content,
        item.createdAt,
        item.model ?? null,
        item.inputTokens ?? null,
        item.outputTokens ?? null,
      );
      if (Number(result.changes) > 0)
        fts.run(item.content, item.id, session.userId, session.id);
    }
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
    this.db
      .prepare(
        "INSERT INTO chat_sessions(id,user_id,title,repository_json,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        session.id,
        session.userId,
        session.title,
        session.repository ? JSON.stringify(session.repository) : null,
        now,
        now,
      );
    return structuredClone(session);
  }

  async get(id: string, userId: string): Promise<ChatSession | null> {
    const row = this.db
      .prepare("SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?")
      .get(id, userId) as SessionRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  async list(userId: string): Promise<ChatSession[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM chat_sessions WHERE user_id = ? AND archived_at IS NULL ORDER BY updated_at DESC",
      )
      .all(userId) as SessionRow[];
    return rows.map((row) => this.hydrate(row));
  }

  async appendMessages(
    id: string,
    userId: string,
    messages: ChatMessage[],
    titleIfNew?: string,
  ): Promise<ChatSession> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT * FROM chat_sessions WHERE id = ? AND user_id = ?")
        .get(id, userId) as SessionRow | undefined;
      if (!row) throw new Error("Chat not found");
      const insert = this.db.prepare(
        "INSERT INTO chat_messages(id,session_id,user_id,role,content,created_at,model,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?,?)",
      );
      const fts = this.db.prepare(
        "INSERT INTO chat_messages_fts(content,message_id,user_id,session_id) VALUES (?,?,?,?)",
      );
      for (const item of messages) {
        insert.run(
          item.id,
          id,
          userId,
          item.role,
          item.content,
          item.createdAt,
          item.model ?? null,
          item.inputTokens ?? null,
          item.outputTokens ?? null,
        );
        fts.run(item.content, item.id, userId, id);
      }
      const now = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE chat_sessions SET title = CASE WHEN title = 'New conversation' AND ? IS NOT NULL THEN ? ELSE title END, summary = ?, updated_at = ? WHERE id = ? AND user_id = ?",
        )
        .run(
          titleIfNew ?? null,
          titleIfNew ?? null,
          this.summaryFor(id, userId),
          now,
          id,
          userId,
        );
      this.captureMemories(id, userId, row.repository_json, messages);
      this.db.exec("COMMIT");
      return (await this.get(id, userId))!;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private summaryFor(sessionId: string, userId: string): string {
    // A durable, bounded summary is made solely from redacted user statements.
    const rows = this.db
      .prepare(
        "SELECT content FROM chat_messages WHERE session_id = ? AND user_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 12",
      )
      .all(sessionId, userId) as Array<{ content: string }>;
    return rows
      .reverse()
      .map((row) => row.content)
      .join("\n")
      .slice(0, 6000);
  }

  private captureMemories(
    sessionId: string,
    userId: string,
    repositoryJson: string | null,
    messages: ChatMessage[],
  ) {
    const enabled = this.db
      .prepare(
        "SELECT cross_chat_memory FROM chat_preferences WHERE user_id = ?",
      )
      .get(userId) as { cross_chat_memory: number } | undefined;
    if (enabled && !enabled.cross_chat_memory) return;
    const repository = repositoryJson
      ? (JSON.parse(repositoryJson) as ChatRepositoryContext)
      : undefined;
    for (const message of messages.filter((item) => item.role === "user")) {
      const memory = candidateMemory(message.content);
      if (!memory) continue;
      const now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO chat_memories(id,user_id,scope,repository_id,category,content,source_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          userId,
          repository ? "repository" : "personal",
          repository?.id ?? null,
          memory.category,
          memory.content,
          sessionId,
          now,
          now,
        );
    }
  }

  async delete(id: string, userId: string): Promise<boolean> {
    // Deletion is permanent: transcript, FTS rows, and any memories derived only
    // from this conversation are removed in the same transaction.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const found = this.db
        .prepare("SELECT 1 FROM chat_sessions WHERE id = ? AND user_id = ?")
        .get(id, userId);
      if (!found) {
        this.db.exec("COMMIT");
        return false;
      }
      this.db
        .prepare(
          "DELETE FROM chat_messages_fts WHERE session_id = ? AND user_id = ?",
        )
        .run(id, userId);
      this.db
        .prepare(
          "DELETE FROM chat_memories WHERE source_session_id = ? AND user_id = ?",
        )
        .run(id, userId);
      this.db
        .prepare("DELETE FROM chat_sessions WHERE id = ? AND user_id = ?")
        .run(id, userId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async archive(id: string, userId: string): Promise<boolean> {
    const result = this.db
      .prepare(
        "UPDATE chat_sessions SET archived_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND archived_at IS NULL",
      )
      .run(new Date().toISOString(), new Date().toISOString(), id, userId);
    return Number(result.changes) > 0;
  }

  async search(
    userId: string,
    query: string,
    repositoryId?: string,
  ): Promise<ChatMessage[]> {
    const terms = query
      .replace(/[^\p{L}\p{N}_-]+/gu, " ")
      .trim()
      .split(/\s+/)
      .slice(0, 8)
      .map((term) => `"${term.replaceAll('"', "")}"`)
      .join(" OR ");
    if (!terms) return [];
    const rows = this.db
      .prepare(
        `SELECT m.* FROM chat_messages_fts f JOIN chat_messages m ON m.id = f.message_id JOIN chat_sessions s ON s.id = m.session_id WHERE f.user_id = ? AND chat_messages_fts MATCH ? ${repositoryId ? "AND json_extract(s.repository_json, '$.id') = ?" : "AND s.repository_json IS NULL"} ORDER BY bm25(chat_messages_fts) LIMIT 8`,
      )
      .all(
        ...(repositoryId ? [userId, terms, repositoryId] : [userId, terms]),
      ) as Array<Record<string, unknown>>;
    return rows.map(messageFromRow);
  }

  async summary(id: string, userId: string): Promise<string> {
    const row = this.db
      .prepare("SELECT summary FROM chat_sessions WHERE id = ? AND user_id = ?")
      .get(id, userId) as { summary: string } | undefined;
    return row?.summary ?? "";
  }

  async memories(userId: string, repositoryId?: string): Promise<ChatMemory[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM chat_memories WHERE user_id = ? AND (scope = 'personal' OR (scope = 'repository' AND repository_id = ?)) ORDER BY updated_at DESC`,
      )
      .all(userId, repositoryId ?? "") as Array<Record<string, unknown>>;
    return rows.map(memoryFromRow);
  }
  async addMemory(memory: ChatMemory & { userId: string }): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO chat_memories(id,user_id,scope,repository_id,category,content,source_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        memory.id,
        memory.userId,
        memory.scope,
        memory.repositoryId ?? null,
        memory.category,
        redactSecrets(memory.content),
        memory.sourceSessionId ?? null,
        memory.createdAt,
        memory.updatedAt,
      );
  }

  async updateMemory(
    id: string,
    userId: string,
    content: string,
  ): Promise<boolean> {
    const r = this.db
      .prepare(
        "UPDATE chat_memories SET content = ?, updated_at = ? WHERE id = ? AND user_id = ?",
      )
      .run(
        redactSecrets(content).slice(0, 1000),
        new Date().toISOString(),
        id,
        userId,
      );
    return Number(r.changes) > 0;
  }
  async forgetMemory(id: string, userId: string): Promise<boolean> {
    const r = this.db
      .prepare("DELETE FROM chat_memories WHERE id = ? AND user_id = ?")
      .run(id, userId);
    return Number(r.changes) > 0;
  }
  async memoryEnabled(userId: string): Promise<boolean> {
    const row = this.db
      .prepare(
        "SELECT cross_chat_memory FROM chat_preferences WHERE user_id = ?",
      )
      .get(userId) as { cross_chat_memory: number } | undefined;
    return !row || Boolean(row.cross_chat_memory);
  }
  async setMemoryEnabled(userId: string, enabled: boolean) {
    this.db
      .prepare(
        "INSERT INTO chat_preferences(user_id,cross_chat_memory) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET cross_chat_memory = excluded.cross_chat_memory",
      )
      .run(userId, enabled ? 1 : 0);
  }
  async exportUser(userId: string) {
    return {
      version: 1,
      sessions: await this.list(userId),
      memories: await this.memories(userId),
      memoryEnabled: await this.memoryEnabled(userId),
    };
  }

  async importUser(
    userId: string,
    backup: {
      sessions: ChatSession[];
      memories: ChatMemory[];
      memoryEnabled?: boolean;
    },
  ): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const imported of backup.sessions) {
        const existing = this.db
          .prepare("SELECT 1 FROM chat_sessions WHERE id = ?")
          .get(imported.id);
        const sessionId = existing ? randomUUID() : imported.id;
        const session: ChatSession = {
          ...imported,
          id: sessionId,
          userId,
          title: redactSecrets(imported.title).slice(0, 120),
          messages: [],
        };
        this.db
          .prepare(
            "INSERT INTO chat_sessions(id,user_id,title,repository_json,created_at,updated_at) VALUES (?,?,?,?,?,?)",
          )
          .run(
            session.id,
            userId,
            session.title || "New conversation",
            session.repository ? JSON.stringify(session.repository) : null,
            session.createdAt,
            session.updatedAt,
          );
        for (const importedMessage of imported.messages) {
          const messageId = this.db
            .prepare("SELECT 1 FROM chat_messages WHERE id = ?")
            .get(importedMessage.id)
            ? randomUUID()
            : importedMessage.id;
          const content = redactSecrets(importedMessage.content).slice(0, 8000);
          this.db
            .prepare(
              "INSERT INTO chat_messages(id,session_id,user_id,role,content,created_at,model,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?,?)",
            )
            .run(
              messageId,
              session.id,
              userId,
              importedMessage.role,
              content,
              importedMessage.createdAt,
              importedMessage.model ?? null,
              importedMessage.inputTokens ?? null,
              importedMessage.outputTokens ?? null,
            );
          this.db
            .prepare(
              "INSERT INTO chat_messages_fts(content,message_id,user_id,session_id) VALUES (?,?,?,?)",
            )
            .run(content, messageId, userId, session.id);
        }
        this.db
          .prepare(
            "UPDATE chat_sessions SET summary = ? WHERE id = ? AND user_id = ?",
          )
          .run(this.summaryFor(session.id, userId), session.id, userId);
      }
      for (const memory of backup.memories) {
        const id = this.db
          .prepare("SELECT 1 FROM chat_memories WHERE id = ?")
          .get(memory.id)
          ? randomUUID()
          : memory.id;
        const content = redactSecrets(memory.content).slice(0, 1000);
        if (/\[REDACTED/.test(content)) continue;
        this.db
          .prepare(
            "INSERT INTO chat_memories(id,user_id,scope,repository_id,category,content,source_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            userId,
            memory.scope,
            memory.scope === "repository"
              ? (memory.repositoryId ?? null)
              : null,
            memory.category,
            content,
            null,
            memory.createdAt,
            memory.updatedAt,
          );
      }
      if (typeof backup.memoryEnabled === "boolean")
        await this.setMemoryEnabled(userId, backup.memoryEnabled);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private hydrate(row: SessionRow): ChatSession {
    const messages = this.db
      .prepare(
        "SELECT * FROM chat_messages WHERE session_id = ? AND user_id = ? ORDER BY created_at, id",
      )
      .all(row.id, row.user_id) as Array<Record<string, unknown>>;
    return {
      id: row.id,
      userId: row.user_id,
      title: row.title,
      repository: row.repository_json
        ? JSON.parse(row.repository_json)
        : undefined,
      messages: messages.map(messageFromRow),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function messageFromRow(row: Record<string, unknown>): ChatMessage {
  return {
    id: String(row.id),
    role: row.role as ChatMessage["role"],
    content: String(row.content),
    createdAt: String(row.created_at),
    model: row.model ? String(row.model) : undefined,
    inputTokens:
      typeof row.input_tokens === "number" ? row.input_tokens : undefined,
    outputTokens:
      typeof row.output_tokens === "number" ? row.output_tokens : undefined,
  };
}
function memoryFromRow(row: Record<string, unknown>): ChatMemory {
  return {
    id: String(row.id),
    scope: row.scope as ChatMemory["scope"],
    repositoryId: row.repository_id ? String(row.repository_id) : undefined,
    category: row.category as ChatMemory["category"],
    content: String(row.content),
    sourceSessionId: row.source_session_id
      ? String(row.source_session_id)
      : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
function parseLegacyChatStore(content: string): ChatStoreDocument {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error("Legacy chat JSON is malformed", { cause: error });
  }
  if (!value || typeof value !== "object") {
    throw new Error("Legacy chat JSON is malformed");
  }
  const sessions = (value as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) {
    throw new Error("Legacy chat JSON is malformed");
  }
  if (!sessions.every(isLegacyChatSession)) {
    throw new Error("Legacy chat JSON contains an invalid session");
  }
  return { sessions };
}

function isLegacyChatSession(value: unknown): value is ChatSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<ChatSession>;
  return (
    typeof session.id === "string" &&
    typeof session.userId === "string" &&
    typeof session.title === "string" &&
    typeof session.createdAt === "string" &&
    typeof session.updatedAt === "string" &&
    (session.repository === undefined ||
      isLegacyRepositoryContext(session.repository)) &&
    Array.isArray(session.messages) &&
    session.messages.every(isLegacyChatMessage)
  );
}

function isLegacyRepositoryContext(
  value: unknown,
): value is ChatRepositoryContext {
  if (!value || typeof value !== "object") return false;
  const repository = value as Partial<ChatRepositoryContext>;
  return (
    typeof repository.id === "string" &&
    typeof repository.owner === "string" &&
    typeof repository.name === "string" &&
    typeof repository.fullName === "string" &&
    typeof repository.baseBranch === "string"
  );
}

function isLegacyChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ChatMessage>;
  return (
    typeof message.id === "string" &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string" &&
    typeof message.createdAt === "string" &&
    (message.model === undefined || typeof message.model === "string") &&
    (message.inputTokens === undefined ||
      (typeof message.inputTokens === "number" &&
        Number.isInteger(message.inputTokens) &&
        message.inputTokens >= 0)) &&
    (message.outputTokens === undefined ||
      (typeof message.outputTokens === "number" &&
        Number.isInteger(message.outputTokens) &&
        message.outputTokens >= 0))
  );
}

function readFileSyncCompat(file: string) {
  return readFileSync(file, "utf8");
}
function candidateMemory(
  value: string,
): Pick<ChatMemory, "category" | "content"> | null {
  const content = redactSecrets(value).replace(/\s+/g, " ").trim();
  if (
    content.length < 8 ||
    content.length > 1000 ||
    /\b(ignore|system prompt|repository instruction|developer message)\b/i.test(
      content,
    ) ||
    /\[REDACTED/.test(content)
  )
    return null;
  const patterns: Array<[ChatMemory["category"], RegExp]> = [
    [
      "preference",
      /^(?:remember(?: that)?\s+)?i (?:prefer|like|want|avoid)\b/i,
    ],
    ["fact", /^(?:remember(?: that)?\s+)?(?:my name is|i am|i'm)\b/i],
    ["decision", /^(?:remember(?: that)?\s+)?(?:we decided|decision:)\b/i],
    [
      "project",
      /^(?:remember(?: that)?\s+)?(?:i(?:'m| am) working on|project:)\b/i,
    ],
  ];
  const match = patterns.find(([, expression]) => expression.test(content));
  return match ? { category: match[0], content } : null;
}

const sqliteGlobal = globalThis as typeof globalThis & {
  __valmontSqliteChatStore?: SqliteChatStore;
};
export function getSqliteChatStore(): SqliteChatStore {
  return (sqliteGlobal.__valmontSqliteChatStore ??= new SqliteChatStore());
}
