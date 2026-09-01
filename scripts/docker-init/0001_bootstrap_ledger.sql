-- Valmont docker-init bootstrap: record the immutable 0000 migration in drizzle.__drizzle_migrations
-- This allows controlled db:migrate to safely apply 0001 onward on a fresh volume.
-- Hash and timestamp derived from src/db/migrations/0000_lazy_leopardon.sql and meta/_journal.json
-- Expected values:
--   hash: 3bdd1e6fd184d9325d3db2b38b6ed7287fa7fde65c42bb87d15f96f176a7f249
--   timestamp: 1786700718887

CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id SERIAL PRIMARY KEY,
  hash TEXT NOT NULL,
  created_at BIGINT
);

INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT '3bdd1e6fd184d9325d3db2b38b6ed7287fa7fde65c42bb87d15f96f176a7f249', 1786700718887
WHERE NOT EXISTS (
  SELECT 1 FROM drizzle.__drizzle_migrations
  WHERE hash = '3bdd1e6fd184d9325d3db2b38b6ed7287fa7fde65c42bb87d15f96f176a7f249'
    AND created_at = 1786700718887
);
