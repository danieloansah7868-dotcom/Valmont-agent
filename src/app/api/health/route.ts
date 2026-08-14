import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDatabase } from "@/db";
import { githubConfigured } from "@/lib/auth";
import { createModelProvider } from "@/lib/models";

export const dynamic = "force-dynamic";

export async function GET() {
  let database: "demo" | "connected" | "unavailable" = "demo";
  if (process.env.DATABASE_URL) {
    try {
      await getDatabase().execute(sql`select 1`);
      database = "connected";
    } catch {
      database = "unavailable";
    }
  }
  const model = createModelProvider();
  const ready = database !== "unavailable";
  return NextResponse.json(
    {
      status: ready ? "ready" : "degraded",
      mode: githubConfigured() && !model.demo ? "integrated" : "demo",
      dependencies: {
        database,
        github: githubConfigured() ? "configured" : "demo",
        model: model.demo ? "demo" : "configured",
      },
      timestamp: new Date().toISOString(),
    },
    { status: ready ? 200 : 503 },
  );
}
