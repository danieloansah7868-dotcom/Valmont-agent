import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("docker-init bootstrap ledger", () => {
  it("derives 0000 SHA-256 and journal timestamp and confirms bootstrap SQL synchronized", () => {
    const migrationsDir = join(process.cwd(), "src/db/migrations");
    const sqlPath = join(migrationsDir, "0000_lazy_leopardon.sql");
    const journalPath = join(migrationsDir, "meta/_journal.json");
    const bootstrapPath = join(
      process.cwd(),
      "scripts/docker-init/0001_bootstrap_ledger.sql",
    );

    const sqlContent = readFileSync(sqlPath, "utf8");
    const hash = createHash("sha256").update(sqlContent).digest("hex");

    const journalRaw = readFileSync(journalPath, "utf8");
    const journal = JSON.parse(journalRaw) as {
      entries: Array<{ tag: string; when: number }>;
    };
    const entry0000 = journal.entries.find(
      (e) => e.tag === "0000_lazy_leopardon",
    );
    expect(entry0000).toBeDefined();
    const timestamp = entry0000!.when;

    // Expected values from prior review (derive/verify rather than blind trust)
    const expectedHash =
      "3bdd1e6fd184d9325d3db2b38b6ed7287fa7fde65c42bb87d15f96f176a7f249";
    const expectedTimestamp = 1786700718887;

    expect(hash).toBe(expectedHash);
    expect(timestamp).toBe(expectedTimestamp);

    const bootstrapContent = readFileSync(bootstrapPath, "utf8");
    expect(bootstrapContent).toContain(expectedHash);
    expect(bootstrapContent).toContain(String(expectedTimestamp));
  });

  it("journal order is authoritative over timestamp (0007 < 0006 regression)", () => {
    const journalPath = join(
      process.cwd(),
      "src/db/migrations/meta/_journal.json",
    );
    const journalRaw = readFileSync(journalPath, "utf8");
    const journal = JSON.parse(journalRaw) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };

    const entry0006 = journal.entries.find(
      (e) => e.tag === "0006_studio_settings",
    );
    const entry0007 = journal.entries.find(
      (e) => e.tag === "0007_studio_domains",
    );

    expect(entry0006).toBeDefined();
    expect(entry0007).toBeDefined();

    // Timestamp regression: 0007 earlier than 0006
    expect(entry0007!.when).toBeLessThan(entry0006!.when);

    // But journal idx ordering is authoritative: 0006 idx 6, 0007 idx 7
    expect(entry0006!.idx).toBe(6);
    expect(entry0007!.idx).toBe(7);
    expect(entry0006!.idx).toBeLessThan(entry0007!.idx);
  });
});
