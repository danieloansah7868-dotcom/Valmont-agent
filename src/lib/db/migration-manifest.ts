import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

export interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

export interface ManifestEntry {
  idx: number;
  tag: string;
  when: number;
  hash: string;
  filePath: string;
  sql: string;
}

const MIGRATIONS_DIR = join(process.cwd(), "src/db/migrations");
const JOURNAL_PATH = join(MIGRATIONS_DIR, "meta/_journal.json");

export function loadJournal(): Journal {
  if (!existsSync(JOURNAL_PATH)) {
    throw new Error(`Can't find meta/_journal.json file at ${JOURNAL_PATH}`);
  }
  const raw = readFileSync(JOURNAL_PATH, "utf8");
  let journal: Journal;
  try {
    journal = JSON.parse(raw) as Journal;
  } catch {
    throw new Error("Invalid _journal.json: not valid JSON");
  }

  if (!journal || typeof journal !== "object") {
    throw new Error("Invalid _journal.json: not an object");
  }
  if (!Array.isArray(journal.entries)) {
    throw new Error("Invalid _journal.json: entries must be an array");
  }
  if (journal.entries.length === 0) {
    throw new Error("Invalid _journal.json: entries is empty");
  }

  // Validate structure and ordering
  const seenIdx = new Set<number>();
  const seenTag = new Set<string>();

  for (let i = 0; i < journal.entries.length; i += 1) {
    const entry = journal.entries[i]!;
    if (typeof entry.idx !== "number" || !Number.isInteger(entry.idx)) {
      throw new Error(
        `Invalid journal entry at position ${i}: idx must be integer`,
      );
    }
    if (typeof entry.when !== "number" || !Number.isFinite(entry.when)) {
      throw new Error(
        `Invalid journal entry ${entry.tag}: when must be number`,
      );
    }
    if (typeof entry.tag !== "string" || !entry.tag.trim()) {
      throw new Error(
        `Invalid journal entry at idx ${entry.idx}: tag must be non-empty string`,
      );
    }
    if (typeof entry.breakpoints !== "boolean") {
      throw new Error(
        `Invalid journal entry ${entry.tag}: breakpoints must be boolean`,
      );
    }
    // idx must match position and be sequential
    if (entry.idx !== i) {
      throw new Error(
        `Invalid journal ordering: entry at position ${i} has idx ${entry.idx}, expected ${i}. Journal order is authoritative.`,
      );
    }
    if (seenIdx.has(entry.idx)) {
      throw new Error(`Duplicate idx ${entry.idx} in journal`);
    }
    seenIdx.add(entry.idx);

    if (seenTag.has(entry.tag)) {
      throw new Error(`Duplicate tag ${entry.tag} in journal`);
    }
    seenTag.add(entry.tag);

    // Ensure file exists
    const filePath = join(MIGRATIONS_DIR, `${entry.tag}.sql`);
    if (!existsSync(filePath)) {
      throw new Error(
        `No file ${entry.tag}.sql found in ${MIGRATIONS_DIR} folder`,
      );
    }
  }

  // Check for gaps: idx should be 0..n-1
  for (let i = 0; i < journal.entries.length; i += 1) {
    if (!seenIdx.has(i)) {
      throw new Error(`Missing idx ${i} in journal`);
    }
  }

  return journal;
}

export function loadManifest(): ManifestEntry[] {
  const journal = loadJournal();
  const manifest: ManifestEntry[] = [];

  for (const entry of journal.entries) {
    const filePath = join(MIGRATIONS_DIR, `${entry.tag}.sql`);
    const sql = readFileSync(filePath, "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");

    manifest.push({
      idx: entry.idx,
      tag: entry.tag,
      when: entry.when,
      hash,
      filePath,
      sql,
    });
  }

  return manifest;
}

export function computeFileHash(filePath: string): string {
  const content = readFileSync(filePath, "utf8");
  return createHash("sha256").update(content).digest("hex");
}
