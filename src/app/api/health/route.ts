import { NextResponse } from "next/server";
import { githubConfigured } from "@/lib/auth";
import {
  customerEmailConfigured,
  missingCustomerEmailRequirements,
  missingLiveRequirements,
} from "@/lib/config";
import { tryCreateModelProvider } from "@/lib/models";
import { checkMigrationReadiness } from "@/lib/db/migration-readiness";

export const dynamic = "force-dynamic";

export async function GET() {
  let database: "not_configured" | "connected" | "unavailable" =
    "not_configured";
  let migrations:
    { status: string; expected?: number; applied?: number } | undefined;

  if (process.env.DATABASE_URL) {
    try {
      const readiness = await checkMigrationReadiness();
      if (readiness.status === "complete") {
        database = "connected";
      } else if (readiness.status === "unavailable") {
        database = "unavailable";
      } else if (readiness.status === "incomplete") {
        database = "connected";
      } else {
        // not_configured should not happen when DATABASE_URL is set, but treat as connected
        database = "connected";
      }
      migrations = {
        status: readiness.status,
        ...(readiness.expected !== undefined
          ? { expected: readiness.expected }
          : {}),
        ...(readiness.applied !== undefined
          ? { applied: readiness.applied }
          : {}),
      };
    } catch {
      database = "unavailable";
      migrations = { status: "unavailable" };
    }
  }

  const model = tryCreateModelProvider();
  const modelReady = Boolean(model);
  const githubReady = githubConfigured();
  const missing = [
    ...missingLiveRequirements(),
    ...missingCustomerEmailRequirements(),
  ];

  // Degraded when database unavailable, migrations incomplete/unavailable, or missing config
  const migrationDegraded =
    migrations &&
    (migrations.status === "incomplete" || migrations.status === "unavailable");

  const ready =
    database !== "unavailable" && !migrationDegraded && missing.length === 0;

  return NextResponse.json(
    {
      status: ready ? "ready" : "degraded",
      dependencies: {
        database,
        github: githubReady ? "configured" : "not_configured",
        model: modelReady ? "configured" : "not_configured",
        customerEmail: customerEmailConfigured()
          ? "configured"
          : "not_configured",
        ...(migrations ? { migrations } : {}),
      },
      missingConfiguration: missing,
      timestamp: new Date().toISOString(),
    },
    { status: ready ? 200 : 503 },
  );
}
