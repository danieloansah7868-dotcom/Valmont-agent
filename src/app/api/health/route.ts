import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDatabase } from "@/db";
import { githubConfigured } from "@/lib/auth";
import { missingLiveRequirements } from "@/lib/config";
import { tryCreateModelProvider } from "@/lib/models";

export const dynamic = "force-dynamic";

export async function GET() {
  let database: "not_configured" | "connected" | "unavailable" =
    "not_configured";
  if (process.env.DATABASE_URL) {
    try {
      await getDatabase().execute(sql`select 1`);
      database = "connected";
    } catch {
      database = "unavailable";
    }
  }
  const model = tryCreateModelProvider();
  const modelReady = Boolean(model);
  const githubReady = githubConfigured();
  const missing = missingLiveRequirements();
  const ready = database !== "unavailable" && missing.length === 0;
  return NextResponse.json(
    {
      status: ready ? "ready" : "degraded",
      dependencies: {
        database,
        github: githubReady ? "configured" : "not_configured",
        model: modelReady ? "configured" : "not_configured",
      },
      missingConfiguration: missing,
      timestamp: new Date().toISOString(),
    },
    { status: ready ? 200 : 503 },
  );
}
