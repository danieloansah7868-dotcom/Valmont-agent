import { loadManifest } from "./migration-manifest";
import { verifyLedger, type LedgerRow } from "./migration-verify";

export type MigrationStatus =
  "not_configured" | "connected" | "unavailable" | "incomplete" | "complete";

export interface MigrationReadiness {
  status: MigrationStatus;
  expected?: number;
  applied?: number;
  details?: string;
}

/**
 * Safe PostgreSQL migration readiness probe.
 * Never leaks credentials, SQL, hostnames, or driver messages.
 */
export async function checkMigrationReadiness(): Promise<MigrationReadiness> {
  if (!process.env.DATABASE_URL) {
    return { status: "not_configured" };
  }

  let manifest;
  try {
    manifest = loadManifest();
  } catch {
    // Journal invalid — treat as incomplete, but don't leak details
    return {
      status: "incomplete",
      details: "Migration manifest is invalid",
    };
  }

  try {
    // Use postgres client directly to avoid leaking via drizzle
    const postgres = (await import("postgres")).default;
    const sql = postgres(process.env.DATABASE_URL, {
      max: 1,
      idle_timeout: 5,
      connect_timeout: 5,
      prepare: false,
    });

    try {
      // Try to read ledger
      const rows = (await sql`
        SELECT hash, created_at FROM drizzle.__drizzle_migrations
      `) as unknown as LedgerRow[];

      const verification = verifyLedger(rows, manifest);

      if (verification.ok) {
        return {
          status: "complete",
          expected: manifest.length,
          applied: rows.length,
        };
      }

      return {
        status: "incomplete",
        expected: manifest.length,
        applied: rows.length,
        details: "Ledger does not match expected journal",
      };
    } finally {
      await sql.end({ timeout: 2 }).catch(() => {});
    }
  } catch {
    // Any DB error becomes unavailable, without leaking details
    return {
      status: "unavailable",
      expected: manifest.length,
      details: "Database is unavailable",
    };
  }
}
