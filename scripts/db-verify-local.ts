#!/usr/bin/env tsx
/**
 * db:verify:local — validates the checked-in journal and migration source hashes
 * without a PostgreSQL connection. Suitable for local development and static CI.
 */

import { loadManifest } from "@/lib/db/migration-manifest";

function main() {
  try {
    const manifest = loadManifest();

    // Additional checks: ensure hash is hex and non-empty
    for (const entry of manifest) {
      if (!/^[0-9a-f]{64}$/.test(entry.hash)) {
        console.error(`Invalid hash for ${entry.tag}: ${entry.hash}`);
        process.exit(1);
      }
      if (!entry.sql || entry.sql.trim().length === 0) {
        console.error(`Empty SQL file for ${entry.tag}`);
        process.exit(1);
      }
    }

    console.log(
      `✓ Migration manifest valid: ${manifest.length} entries, all SQL files present with SHA-256 hashes`,
    );
    for (const entry of manifest) {
      console.log(
        `  - ${String(entry.idx).padStart(4, "0")} ${entry.tag} when=${entry.when} hash=${entry.hash.slice(0, 12)}...`,
      );
    }

    // Regression check: 0007 timestamp earlier than 0006, journal order authoritative
    const idx6 = manifest.find((e) => e.tag === "0006_studio_settings");
    const idx7 = manifest.find((e) => e.tag === "0007_studio_domains");
    if (idx6 && idx7) {
      if (idx7.when >= idx6.when) {
        console.warn(
          `Note: 0007 when (${idx7.when}) is not earlier than 0006 when (${idx6.when}) — regression case not present in this journal snapshot`,
        );
      } else {
        console.log(
          `✓ Regression case confirmed: 0007 when (${idx7.when}) < 0006 when (${idx6.when}), journal order is authoritative (idx 6 -> 7)`,
        );
      }
      if (idx6.idx !== 6 || idx7.idx !== 7) {
        console.error("Journal idx mismatch for 0006/0007");
        process.exit(1);
      }
    }

    process.exit(0);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown manifest error";
    console.error(`✗ Migration manifest validation failed: ${message}`);
    process.exit(1);
  }
}

main();
