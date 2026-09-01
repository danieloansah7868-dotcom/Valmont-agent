# Production deployment

## Supported deployment shape

Valmont's real workflow performs filesystem work and may run for several minutes. Deploy it to a persistent Node.js service or container host—not a short-timeout edge/serverless function. PostgreSQL is required for durable production state.

The included `Dockerfile` and `compose.yaml` provide a repeatable single-tenant deployment for trusted repositories. They run the web service as an unprivileged user, drop Linux capabilities, keep PostgreSQL separate, and persist `.data` workspaces.

```bash
cp .env.example .env
# Set APP_URL, POSTGRES_PASSWORD, SESSION_SECRET, GitHub, and model values.
docker compose up --build -d
curl https://your-domain.example/api/health
```

### Database migrations — controlled, verified, never automatic

Valmont **never runs production migrations automatically**. There is no migration-runner service in Compose and the web container does not apply migrations on boot.

**Fresh volume behaviour (historic base only):**

- `compose.yaml` mounts two Docker-init scripts into `docker-entrypoint-initdb.d`:
  - `0000_lazy_leopardon.sql` — the immutable base schema (lexically first).
  - `0001_bootstrap_ledger.sql` — inserts the corresponding row into `drizzle.__drizzle_migrations` with the exact hash `3bdd1e6fd184d9325d3db2b38b6ed7287fa7fde65c42bb87d15f96f176a7f249` and journal timestamp `1786700718887` derived from `src/db/migrations/0000_lazy_leopardon.sql` and `meta/_journal.json`. This makes a brand-new volume report `migrations.status: complete` for the historic base without pretending later migrations are applied.
- The bootstrap is idempotent (`WHERE NOT EXISTS`) and runs only on first init of an empty data directory.

**Existing volume without compatible ledger:**

- If `DATABASE_URL` points at a volume that was initialized before the ledger bootstrap or was manually altered, the readiness probe reports `migrations.status: incomplete` and `/api/health` returns **degraded 503** with `dependencies.migrations: { status: "incomplete", expected, applied }`. The application does **not** hide the problem or silently rewrite history — it fails closed until an operator runs the controlled migration.

**Controlled release procedure (required for every deploy that adds migrations):**

```bash
# From a release job / operator machine, never from the app container:
npm run db:verify:local   # no DB — validates journal structure, ordering, SHA-256, file existence
npm run db:migrate        # requires DATABASE_URL — advisory lock, validates full journal, applies missing in journal order, re-verifies
npm run db:verify         # read-only — validates ledger membership against journal
```

- `db:verify:local` — validates the **complete** checked-in Drizzle journal `src/db/migrations/meta/_journal.json`: structure, `version`/`dialect`, sequential `idx` 0..n-1 matching array position, unique `tag`/`idx`, numeric `when`, `breakpoints` boolean, SQL file existence, SHA-256 hash non-empty, and regression check that journal order is authoritative (e.g. `0007_studio_domains` when `1787573273009` < `0006_studio_settings` when `1787616000000` but idx 7 > 6).
- `db:migrate` — controlled runner: requires `DATABASE_URL` with a generic safe error if missing (no leak), takes an advisory transaction lock (`72707369`), ensures `drizzle` schema and `__drizzle_migrations` table exist, loads manifest, validates journal, fetches ledger, **fails closed** on `unexpected` ledger rows (unknown hash), `altered` hashes/timestamps, or duplicate hashes/timestamps, applies **only missing** migrations in journal order splitting on `-->` statement-breakpoint, inserts ledger rows with hash and journal `when`, then re-verifies ledger.
- `db:verify` — read-only: attempts advisory lock (fails open for read), loads manifest, fetches ledger, verifies exact membership by hash+`created_at`, reports missing/unexpected/altered/duplicate.

**Why not timestamp ordering:**

- Drizzle's journal carries both `idx` and `when`. `when` is wall-clock and can regress (see `0007` earlier than `0006`). The system **never** uses timestamp ordering; journal `idx` order is authoritative. The regression test `src/lib/db/migration-bootstrap.test.ts` asserts this invariant and that the bootstrap ledger SQL contains the expected hash/timestamp derived from source.

**Health probe:**

- `GET /api/health` uses `checkMigrationReadiness()` which probes without leaking driver details:
  - `not_configured` → `DATABASE_URL` unset → degraded 503 (or healthy in SQLite mode if applicable)
  - `unavailable` → cannot connect → degraded 503
  - `incomplete` → ledger missing/altered/unexpected → degraded 503
  - `complete` → ledger exactly matches journal → healthy 200
- Response includes `dependencies.migrations: { status, expected, applied }` and `missingConfiguration` when relevant. No internal error messages or connection strings are returned.

**CI verification:**

- `.github/workflows/ci.yml` provides a throwaway PostgreSQL 16 service. It runs `db:migrate` → `db:verify` → `npm test` → `npm run build`. This proves the controlled runner works against a real engine and that the test suite runs only after migrations are verified.

The default persistent `/app/.data` volume also retains chat SQLite data. If `CHAT_STORE_PATH` or `CHAT_SQLITE_PATH` points outside that directory, mount the custom parent directory into the app container; leaving `CHAT_SQLITE_PATH` unset derives a sibling SQLite file next to the legacy JSON input.

The compose port binds only to `127.0.0.1`. Put Caddy on the host in front of it:

```caddyfile
agent.valmontweb.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
```

After the DNS record points to the server, Caddy obtains and renews HTTPS automatically. Add Cloudflare Access or another identity-aware proxy in front of the subdomain when it must be private over the public internet.

## Required configuration

- A public HTTPS `APP_URL`
- 32+ random bytes in `SESSION_SECRET`
- GitHub OAuth App callback `${APP_URL}/api/auth/github/callback`
- OpenAI-compatible model endpoint/key/name with structured JSON output support
- PostgreSQL with TLS and backups
- Reverse proxy with request-body limits, HTTPS, and execution-friendly timeouts

### Email delivery (Resend)

Customer account emails (verification, password reset) require **both**:

- `RESEND_API_KEY` — non-empty, no CR/LF, no surrounding whitespace only
- `NOTIFY_EMAIL_FROM` — valid sender, either plain `noreply@example.com` or display-name `Valmont <noreply@example.com>`, no CR/LF, no angle-bracket injection, must contain `@`

Validation is **all-or-nothing**:

- Both unset → `not_configured` → development returns clearly local-only one-time links, production fails closed with typed 503 `CustomerEmailConfigurationError`.
- One set, other unset/blank/malformed → `invalid` → same fail-closed 503.
- Malformed/injection (`\r`, `\n`, `<script>`, missing `@`) → `invalid` → 503.
- Both present and valid → `configured`.

Delivery:

- Uses `fetch` with `AbortController` + `setTimeout` 10s (portable, not runtime-specific helper), timer cleared in `finally` to avoid leaks.
- Provider non-ok responses (400/500 etc.) and fetch rejections/timeouts are normalized to typed 502 `CustomerEmailDeliveryError` with generic message `"Email delivery is temporarily unavailable. Please try again."` — **no** provider bodies, keys, or status texts leak.
- Anti-enumeration: `assertCustomerEmailDeliveryReady()` checks config **before** any account lookup. `forgot-password` and `resend-verification` routes suppress only `CustomerEmailDeliveryError` after lookup, preserving neutral `ok:true` responses. Configuration errors (503) are **not** suppressed, so misconfiguration is visible to operators but does not leak existence.
- Compose passes `RESEND_API_KEY` and `NOTIFY_EMAIL_FROM` through to the app container.

## Critical sandbox boundary

Dockerizing the Valmont web process is not the same as isolating each repository task. The bundled `RestrictedLocalWorkspaceProvider` is appropriate only for a private, single-tenant installation where every connected repository and user is trusted.

Before exposing Valmont to customers, organizations you do not control, or public sign-up, implement `WorkspaceProvider` using one ephemeral container or microVM per task. The task sandbox must have:

- no mount of the application container, Docker socket, host source, or cloud credentials;
- an unprivileged user, read-only base image, seccomp/AppArmor, and no added capabilities;
- CPU, memory, PID, disk, output, and wall-clock quotas;
- default-deny network and blocked cloud metadata;
- a task-specific writable volume destroyed on completion;
- narrowly proxied dependency access only when the approved plan includes installation;
- no GitHub/model/session credentials inside validation processes.

## Operations checklist

1. Replace OAuth with a repository-selected GitHub App when serving multiple tenants.
2. Move execution into a durable queue/worker before horizontal scaling.
3. Use managed session storage/KMS token encryption and distributed rate limiting.
4. Ship audit events to append-only centralized storage.
5. Add workspace TTL cleanup, storage quotas, alerts, and backup restoration tests.
6. Keep `/api/health` on an internal monitoring check — it now reports `degraded` 503 when migrations are incomplete/unavailable.
7. Review failed validations and diffs; never bypass final approval.
8. Keep branch protection and mandatory GitHub reviews enabled.
9. For every release with new migrations: run `db:migrate` and `db:verify` from a controlled job, not from the app.

Valmont intentionally has no merge or deployment method. Your existing reviewed CI/CD process should deploy only after a human merges the pull request in GitHub.

## Website Studio Storage

### Choosing a backend

Studio follows the same rule as the rest of Valmont:

- **`DATABASE_URL` set** — drafts go to PostgreSQL, in the `studio_drafts` table
  created by migration `0002_uneven_the_anarchist.sql`. Run `npm run db:migrate`
  before first use. This is the recommended production setup: it survives
  container replacement and supports more than one application instance.
- **`DATABASE_URL` unset** — drafts go to SQLite, in **exactly the same file as
  Chat**. Suitable for a single instance with a persistent volume only.

There is no Studio-specific environment variable. `CHAT_STORE_PATH` and
`CHAT_SQLITE_PATH` control both Chat and Studio through the shared resolver in
`src/lib/sqlite-path.ts`. Never point the two variables at the same file; the
resolver asserts they differ and will refuse to open a legacy `.json` store as
SQLite.

If you run SQLite in Docker, mount the directory holding the store as a named
volume. Without a volume every container restart starts from an empty database.

### Schema versions

The SQLite Studio schema is versioned in a dedicated `studio_meta` table and
upgraded through sequential, transactional migrations: the recorded version is
written only after every migration succeeds, a failure rolls schema and
metadata back together, a recorded version newer than the running build is
refused, and repeated restarts are a no-op. PostgreSQL rows carry
`schema_version`, managed by the Drizzle migrations. Both are `1`. The
legacy-JSON chat migration writes `<legacy path>.pre-sqlite-backup` first,
using `COPYFILE_EXCL` so an existing backup is never overwritten, and records a
`legacy-json-migrated` marker only after the migrated rows are committed.

PostgreSQL's authoritative migration ledger is `drizzle.__drizzle_migrations` with full journal verification as described above — not just most recent timestamp.

### Backups

- `GET /api/backup/export` — on SQLite, chat and drafts are read inside one
  read transaction on the single shared database handle, so the file is a
  consistent snapshot: a version 2 file containing chat sessions, memories, and
  Studio drafts. With `DATABASE_URL` set the two halves live in different
  engines; that export is **not** one atomic cross-engine snapshot.
- `POST /api/backup/import` — SQLite uses the single shared database handle, so
  a mid-import failure rolls chat, memories, and drafts back together. With
  `DATABASE_URL` set, chat stays in SQLite and drafts go to PostgreSQL; the
  durable cross-store coordinator takes an owner-level lease (token +
  generation + heartbeat) before any write so a second import for that owner
  is `409` while the lease is live. Recovery claims only expired leases, via
  compare-and-swap, and PostgreSQL Studio writes are transactionally fenced by
  a durable per-owner `studio_import_fences` row so an obsolete transaction
  can never commit late writes after its lease was replaced. A failure at any checkpoint — or a process killed
  mid-import, after the lease expires — rolls both stores back to their exact
  previous state. SQLite-only complete imports take the same owner lease. Success is reported only after both halves committed. After success
  or a successful rollback the journal payload and snapshot are logically
  deleted; an unresolved rollback failure keeps them until recovery finishes.
  That cleanup is not guaranteed physical erasure of SQLite pages. Legacy
  version 1 chat-only files are still accepted; unknown versions are rejected
  before anything is written. Authenticated Studio and backup routes rate-limit
  by owner id, not by client-supplied forwarding headers.

Backups contain the owner's business details. Treat a downloaded file as
sensitive: store it encrypted, and delete copies you no longer need. Regular
exports are the recommended backup mechanism for SQLite deployments; for
PostgreSQL use your normal database backups as well.

### Request limits

Draft mutations accept at most 1 MB and backup imports at most 25 MB, enforced
by counting real bytes while streaming. If a reverse proxy sits in front of
Valmont, set its own body limit to at least 25 MB or large restores will be
rejected before they reach the application.

### Browsers are not installed in production

The production image (`node:22.13-bookworm-slim`, Next.js standalone output,
running as `USER node`) installs **no Playwright browser binaries**. Browser
tests belong in CI, where `npx playwright install --with-deps chromium` runs as
an explicit step. Do not add that step to the Dockerfile.

### What Phase 1 does not do in production

No file uploads, no payment processing, no repository generation, and no
deployments. Nothing in the Studio can take an order or move money. Do not
describe a generated Brief to a customer as a working website.
