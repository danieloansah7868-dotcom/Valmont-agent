#!/usr/bin/env tsx
/**
 * db:verify — read-only verification against the database.
 * Verifies all expected journal entries and rejects unexpected/incompatible entries.
 * Never mutates production data.
 */

import { loadManifest } from "@/lib/db/migration-manifest";
import { verifyLedger, type LedgerRow } from "@/lib/db/migration-verify";

const ADVISORY_LOCK_KEY = 72707369;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("Database configuration is not available");
    process.exit(1);
  }

  let manifest;
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
    max: 2,
    idle_timeout: 10,
    connect_timeout: 10,
    prepare: false,
  });

  try {
    await sql.begin(async (tx) => {
      // Advisory transaction lock if compatible with read-only behavior.
      // This is safe and does not mutate data.
      try {
        await tx`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`;
      } catch {
        // If lock fails in read-only transaction, continue without it — still read-only verification.
      }

      let rows: LedgerRow[];
      try {
        rows = (await tx`
          SELECT hash, created_at FROM drizzle.__drizzle_migrations
        `) as unknown as LedgerRow[];
      } catch {
        console.error(
          "Migration verification failed: ledger is not accessible",
        );
        throw new Error("LEDGER_INACCESSIBLE");
      }

      const result = verifyLedger(rows, manifest);

      if (!result.ok) {
        console.error("Migration verification failed");
        console.error(
          `Expected: ${result.expected}, Applied: ${result.applied}`,
        );
        if (result.missing.length > 0) {
          console.error(
            `Missing migrations: ${result.missing.map((m) => m.tag).join(", ")}`,
          );
        }
        if (result.unexpected.length > 0) {
          console.error(`Unexpected ledger rows: ${result.unexpected.length}`);
        }
        if (result.altered.length > 0) {
          console.error(
            `Altered migrations: ${result.altered.map((a) => a.manifest.tag).join(", ")}`,
          );
        }
        if (result.duplicateLedgerHashes.length > 0) {
          console.error(
            `Duplicate ledger hashes detected: ${result.duplicateLedgerHashes.length}`,
          );
        }
        if (result.duplicateLedgerTimestamps.length > 0) {
          console.error(
            `Duplicate ledger timestamps detected: ${result.duplicateLedgerTimestamps.length}`,
          );
        }
        throw new Error("VERIFICATION_FAILED");
      }

      console.log(
        `✓ Migration ledger verified: ${result.applied}/${result.expected} migrations applied, exact journal membership confirmed`,
      );
    });

    process.exit(0);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "VERIFICATION_FAILED" ||
        error.message === "LEDGER_INACCESSIBLE")
    ) {
      process.exit(1);
    }
    // Do not leak driver details
    console.error("Migration verification failed");
    process.exit(1);
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

main();
