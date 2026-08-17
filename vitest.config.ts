import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: { reporter: ["text", "json", "html"] },
    // Test files must not share a process. The PostgreSQL suite sets
    // process.env.DATABASE_URL to point the shared store at PostgreSQL; with a
    // shared process that global could flip a concurrently-running SQLite suite
    // onto the wrong engine and make results depend on scheduling order.
    pool: "forks",
    isolate: true,
  },
  resolve: { alias: { "@": `${import.meta.dirname}/src` } },
});
