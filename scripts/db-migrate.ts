#!/usr/bin/env tsx
/**
 * db:migrate — controlled migration runner.
 * - Requires DATABASE_URL, fails with generic safe error if absent
 * - Takes PostgreSQL advisory transaction lock
 * - Validates manifest before applying
 * - Applies missing migrations in journal order
 * - Writes correct Drizzle ledger entries
 * - Re-verifies full ledger before succeeding
 * - Does not leak DATABASE_URL or driver details
 */

import { loadManifest, type ManifestEntry } from "@/lib/db/migration-manifest";
import { verifyLedger, type LedgerRow } from "@/lib/db/migration-verify";

const ADVISORY_LOCK_KEY = 72707369;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("Database configuration is not available");
    process.exit(1);
  }

  let manifest: ManifestEntry[];
  try {
    manifest = loadManifest();
  } catch (error) {
    console.error(
      `Migration manifest is invalid: ${error instanceof Error ? error.message : "unknown"}`,
    );
    process.exit(1);
  }

  const postgres = (await import("postgres")).default;
  const sql = postgres(process.env.DATABASE_URL, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });

  try {
    await sql.begin(async (tx) => {
      // Advisory transaction lock — prevents concurrent migrations
      await tx`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`;

      // Ensure drizzle schema and migrations table exist
      await tx`CREATE SCHEMA IF NOT EXISTS drizzle`;
      await tx`
        CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash TEXT NOT NULL,
          created_at BIGINT
        )
      `;

      // Read current ledger
      const rows = (await tx`
        SELECT hash, created_at FROM drizzle.__drizzle_migrations
      `) as unknown as LedgerRow[];

      // Verify existing ledger for duplicates/unexpected/altered before applying
      // Missing is okay (we will apply), but altered/duplicate/unexpected must fail closed
      const preCheck = verifyLedger(rows, manifest);

      // If ledger has unexpected, altered, or duplicate entries, fail closed
      // Even if some are missing, we must not proceed if there are incompatible rows
      if (
        preCheck.unexpected.length > 0 ||
        preCheck.altered.length > 0 ||
        preCheck.duplicateLedgerHashes.length > 0 ||
        preCheck.duplicateLedgerTimestamps.length > 0
      ) {
        console.error(
          "Migration failed: existing ledger contains incompatible entries",
        );
        if (preCheck.unexpected.length > 0) {
          console.error(`Unexpected rows: ${preCheck.unexpected.length}`);
        }
        if (preCheck.altered.length > 0) {
          console.error(
            `Altered rows: ${preCheck.altered.map((a) => a.manifest.tag).join(", ")}`,
          );
        }
        throw new Error("INCOMPATIBLE_LEDGER");
      }

      // Determine missing migrations in journal order
      const ledgerByHash = new Map<string, LedgerRow>();
      const ledgerByTimestamp = new Map<string, LedgerRow>();
      for (const row of rows) {
        ledgerByHash.set(row.hash, row);
        ledgerByTimestamp.set(String(row.created_at), row);
      }

      const missing = manifest.filter((entry) => {
        const byHash = ledgerByHash.get(entry.hash);
        const byTs = ledgerByTimestamp.get(String(entry.when));
        return !byHash || !byTs;
      });

      if (missing.length === 0) {
        console.log(
          `✓ No migrations to apply: ${rows.length}/${manifest.length} already applied`,
        );
        // Re-verify full ledger
        const finalCheck = verifyLedger(rows, manifest);
        if (!finalCheck.ok) {
          console.error("Migration verification failed after no-op");
          throw new Error("VERIFICATION_FAILED");
        }
        return;
      }

      console.log(
        `Applying ${missing.length} missing migration(s) in journal order...`,
      );

      for (const entry of missing) {
        console.log(`  → ${entry.tag} (when=${entry.when})`);
        // Split SQL by statement-breakpoint
        const statements = entry.sql
          .split("--> statement-breakpoint")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        for (const stmt of statements) {
          // Use unsafe to execute raw SQL
          await tx.unsafe(stmt);
        }

        // Insert ledger entry
        await tx`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES (${entry.hash}, ${entry.when})
        `;
      }

      // Re-query and re-verify full ledger before succeeding
      const finalRows = (await tx`
        SELECT hash, created_at FROM drizzle.__drizzle_migrations
      `) as unknown as LedgerRow[];

      const finalVerification = verifyLedger(finalRows, manifest);

      if (!finalVerification.ok) {
        console.error("Migration verification failed after applying");
        console.error(
          `Expected: ${finalVerification.expected}, Applied: ${finalVerification.applied}`,
        );
        if (finalVerification.missing.length > 0) {
          console.error(
            `Still missing: ${finalVerification.missing.map((m) => m.tag).join(", ")}`,
          );
        }
        throw new Error("VERIFICATION_FAILED");
      }

      console.log(
        `✓ Migrations applied successfully: ${finalRows.length}/${manifest.length} verified`,
      );
    });

    process.exit(0);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "INCOMPATIBLE_LEDGER" ||
        error.message === "VERIFICATION_FAILED")
    ) {
      process.exit(1);
    }
    // Do not leak DATABASE_URL or driver details
    console.error("Migration failed");
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

main();
