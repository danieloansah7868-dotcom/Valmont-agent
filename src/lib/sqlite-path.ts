import { existsSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Single source of truth for where local SQLite data lives.
 *
 * Chat owns this resolver historically; Website Studio stores its drafts in the
 * *same* database file, so both must derive the path through these helpers
 * rather than re-implementing the rules. Studio deliberately has no environment
 * variable of its own — there is exactly one local database.
 */
export const DEFAULT_CHAT_STORE_PATH = path.join(
  process.cwd(),
  ".data",
  "chat-store.json",
);

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

export function configuredLegacyChatStorePath(): string {
  return process.env.CHAT_STORE_PATH || DEFAULT_CHAT_STORE_PATH;
}

export function configuredSqliteChatStorePath(
  legacyPath = configuredLegacyChatStorePath(),
): string {
  return process.env.CHAT_SQLITE_PATH || deriveSqliteChatStorePath(legacyPath);
}

export function legacyBackupPath(legacyPath: string): string {
  return `${legacyPath}.pre-sqlite-backup`;
}

/**
 * Guards the one mistake that destroys user data: opening the legacy JSON
 * document as a SQLite database, which overwrites it with a binary header.
 */
export function assertDistinctStorePaths(
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

/**
 * Resolves, validates and returns the local storage paths in one call. Studio
 * uses this so it can never disagree with Chat about the active database file.
 */
export function resolveSqliteStorePaths(overrides?: {
  legacyPath?: string;
  sqlitePath?: string;
}): { legacyPath: string; sqlitePath: string; backupPath: string } {
  const legacyPath = overrides?.legacyPath ?? configuredLegacyChatStorePath();
  const sqlitePath =
    overrides?.sqlitePath ?? configuredSqliteChatStorePath(legacyPath);
  assertDistinctStorePaths(legacyPath, sqlitePath);
  return { legacyPath, sqlitePath, backupPath: legacyBackupPath(legacyPath) };
}
