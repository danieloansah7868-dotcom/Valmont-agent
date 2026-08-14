import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";

let client: ReturnType<typeof postgres> | undefined;

export function getDatabase() {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is not configured");
  client ??= postgres(process.env.DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
  return drizzle(client, { schema });
}

export async function closeDatabase(): Promise<void> {
  if (client) await client.end();
  client = undefined;
}
