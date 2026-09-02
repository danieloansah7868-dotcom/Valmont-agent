import { NextResponse, type NextRequest } from "next/server";
import { githubConfigured } from "@/lib/auth";
import {
  customerEmailConfigured,
  missingCustomerEmailRequirements,
  missingLiveRequirements,
} from "@/lib/config";
import { tryCreateModelProvider } from "@/lib/models";
import { checkMigrationReadiness } from "@/lib/db/migration-readiness";
import { resolvePaymentConfig } from "@/lib/studio/payment-settings";

export const dynamic = "force-dynamic";

/**
 * Two probes on one route, selected by `?probe=`:
 *
 * - `live` (liveness): "is this process up and able to answer?" Always 200
 *   while the server runs. This is what the container HEALTHCHECK and an
 *   orchestrator's restart policy must watch — a missing e-mail API key is
 *   not a reason to kill and restart the container, and doing so would turn
 *   a configuration gap into an outage.
 * - `ready` (readiness, the default so existing monitors keep working): "can
 *   this deployment serve every customer-facing flow?" 503 `degraded` when
 *   the database is unreachable, migrations are incomplete or any required
 *   configuration is missing. Point external monitoring at this one.
 */
export async function GET(request: NextRequest) {
  const probe = request.nextUrl.searchParams.get("probe");
  if (probe === "live") {
    return NextResponse.json(
      { status: "alive", timestamp: new Date().toISOString() },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }

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

  // Live payments selected but not fully set up: online checkout is refused
  // until the merchant finishes the setup, so operators must be able to see it.
  let payments: "test" | "live" | "live_misconfigured" = "test";
  try {
    const config = await resolvePaymentConfig();
    payments =
      config.mode === "live"
        ? config.liveActive && config.webhookSecret
          ? "live"
          : "live_misconfigured"
        : "test";
  } catch {
    payments = "test";
  }

  // Degraded when database unavailable, migrations incomplete/unavailable, or missing config
  const migrationDegraded =
    migrations &&
    (migrations.status === "incomplete" || migrations.status === "unavailable");

  const ready =
    database !== "unavailable" &&
    !migrationDegraded &&
    missing.length === 0 &&
    payments !== "live_misconfigured";

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
        payments,
        ...(migrations ? { migrations } : {}),
      },
      missingConfiguration: missing,
      timestamp: new Date().toISOString(),
    },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
