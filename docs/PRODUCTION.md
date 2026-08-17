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

The compose migration mount initializes a new PostgreSQL volume. For an existing database, review and apply migrations manually with `npm run db:migrate` from a controlled release job. Valmont never runs production migrations from an agent task. The default persistent `/app/.data` volume also retains chat SQLite data. If `CHAT_STORE_PATH` or `CHAT_SQLITE_PATH` points outside that directory, mount the custom parent directory into the app container; leaving `CHAT_SQLITE_PATH` unset derives a sibling SQLite file next to the legacy JSON input.

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
6. Keep `/api/health` on an internal monitoring check.
7. Review failed validations and diffs; never bypass final approval.
8. Keep branch protection and mandatory GitHub reviews enabled.

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

The SQLite store records `studio-schema-version` in `chat_meta`, and PostgreSQL
rows carry `schema_version`. Both are `1`. Startup is idempotent: the tables are
created only if missing, and repeated restarts neither duplicate nor migrate
anything twice. The legacy-JSON migration writes
`<legacy path>.pre-sqlite-backup` first, using `COPYFILE_EXCL` so an existing
backup is never overwritten, and records a `legacy-json-migrated` marker only
after the migrated rows are committed.

### Backups

- `GET /api/backup/export` — one consistent read; a version 2 file containing
  chat sessions, memories, and Studio drafts.
- `POST /api/backup/import` — one transaction. SQLite uses the single shared
  database handle, so a mid-import failure rolls chat, memories, and drafts back
  together. Legacy version 1 chat-only files are still accepted; unknown
  versions are rejected before anything is written.

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
