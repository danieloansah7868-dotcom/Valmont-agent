# Production deployment

## Supported deployment shape

Valmont's real workflow performs filesystem work and may run for several minutes. Deploy it to a persistent Node.js service or container host—not a short-timeout edge/serverless function. PostgreSQL is required for durable production state.

The included `Dockerfile` and `compose.yaml` provide a repeatable single-tenant deployment for trusted repositories. They run the web service as an unprivileged user, drop Linux capabilities, keep PostgreSQL separate, and persist `.data` workspaces.

```bash
cp .env.example .env
# Set APP_URL (the public https origin), POSTGRES_PASSWORD, SESSION_SECRET
# (32+ random characters — `openssl rand -base64 48`), GitHub, and model values.
docker compose up --build -d
curl https://your-domain.example/api/health            # readiness (503 until configured)
curl https://your-domain.example/api/health?probe=live # liveness (200 once the process answers)
```

`APP_URL` is not cosmetic: every link the server writes into an email
(customer verification, password reset, merchant order alerts) and the return
URL handed to Valmont Pay are built from it. The server never derives them
from the socket it listens on, which inside the container is `0.0.0.0:3000`.

`compose.yaml` passes every runtime setting the app reads through to the
container — `TRUST_PROXY` (defaults to `true` because the compose port is
reachable only through the reverse proxy), the Valmont Pay fallback
connection, `STUDIO_PAYMENT_ADMINS`, `STUDIO_PLATFORM_HOST`, the SMS/WhatsApp
providers and `VALMONT_WORKSPACE_PROVIDER`. `NEXT_PUBLIC_STUDIO_PLATFORM_HOST`
is inlined into the browser bundle at **build** time, so it is a `build.args`
entry in `compose.yaml` and an `ARG` in the Dockerfile; rebuild the image when
it changes.

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

**Migration `0010_order_payment_mode_domain_verification`** adds
`studio_orders.payment_mode` (`test` | `live`, default `live` for rows that
predate it — they were only ever created by real checkouts) and the
`verification_token` / `verified_at` / `last_checked_at` columns on
`studio_domains`.

**Migration `0011_order_recipient_phone`** (this release) adds
`studio_orders.recipient_phone` (`text`, nullable — old orders keep NULL).
It stores the Ghana-mobile number that should receive the data bundle, while
`customer_phone` remains the buyer's contact (or the recipient again when the
buyer field is blank). SQLite upgrades via `ensureColumn(..., "recipient_phone", "TEXT")`
so existing `.data/*.sqlite` files gain the column on next access. Until the
migration is applied, `/api/health` reports `migrations.status: incomplete`
and the app answers 503. Run `npm run db:verify:local && npm run db:migrate && npm run db:verify`
from a controlled job as described above.

**Why not timestamp ordering:**

- Drizzle's journal carries both `idx` and `when`. `when` is wall-clock and can regress (see `0007` earlier than `0006`). The system **never** uses timestamp ordering; journal `idx` order is authoritative. The regression test `src/lib/db/migration-bootstrap.test.ts` asserts this invariant and that the bootstrap ledger SQL contains the expected hash/timestamp derived from source.

**Health probe:**

- `GET /api/health?probe=live` is the **liveness** probe: `200 {"status":"live"}`
  whenever the process can answer, regardless of configuration. The Docker
  `HEALTHCHECK` uses it so a missing optional integration (email, payments)
  never restart-loops the container.
- `GET /api/health` (no parameter) is the **readiness** probe. Point the load
  balancer and uptime monitoring at this one. It uses `checkMigrationReadiness()` which probes without leaking driver details:
  - `not_configured` → `DATABASE_URL` unset → degraded 503 (or healthy in SQLite mode if applicable)
  - `unavailable` → cannot connect → degraded 503
  - `incomplete` → ledger missing/altered/unexpected → degraded 503
  - `complete` → ledger exactly matches journal → healthy 200
- Response includes `dependencies.migrations: { status, expected, applied }`, `dependencies.email` and `dependencies.payments` (`test`, `live`, or `live_misconfigured` — Live was selected on the Payments page but the connection is incomplete, which also degrades the probe to 503 because online checkout is refusing orders), plus `missingConfiguration` when relevant. A `SESSION_SECRET` that is shorter than 32 characters or a known placeholder is reported as missing. No internal error messages or connection strings are returned. Responses carry `cache-control: no-store`.

**CI verification:**

- `.github/workflows/ci.yml` provides a throwaway PostgreSQL 16 service (`compose.yaml` ships 17; aligning CI to `postgres:17` is a one-line workflow edit that needs the `workflows` permission, see NEXT-STEPS.md). It runs `db:migrate` → `db:verify` → `npm test` → `npm run build`. This proves the controlled runner works against a real engine and that the test suite runs only after migrations are verified.

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

- A public HTTPS `APP_URL` — the origin of every emailed link and payment return URL
- 32+ random characters in `SESSION_SECRET`. The app enforces this: a shorter value or a recognisable placeholder (the `.env.example` text, `changeme`, a repeated character, …) makes sign-in answer 503 and `/api/health` list `SESSION_SECRET` under `missingConfiguration`
- `TRUST_PROXY=true` only when clients can reach the app exclusively through a proxy that overwrites `X-Forwarded-For`; with it unset every client shares one rate-limit bucket behind a proxy, which turns the limiter into a denial-of-service lever
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

Dockerizing the Valmont web process is not the same as isolating each repository task. The default `RestrictedLocalWorkspaceProvider` (`VALMONT_WORKSPACE_PROVIDER=local`) is appropriate only for a private, single-tenant installation where every connected repository and user is trusted.

### Switching to the Docker workspace provider

`VALMONT_WORKSPACE_PROVIDER=docker` selects the bundled `DockerWorkspaceProvider`: one throwaway container per task built from `sandbox/Dockerfile`, no network, all capabilities dropped, an unprivileged uid, and CPU / memory / pid / storage / wall-clock quotas. Any other value fails at startup rather than silently falling back to the local provider.

```bash
docker build -t valmont-sandbox:local sandbox/     # the inert task image
VALMONT_WORKSPACE_PROVIDER=docker \
VALMONT_SANDBOX_IMAGE=valmont-sandbox:local \
npm run start
```

The app process needs the `docker` CLI and a reachable daemon (`DOCKER_HOST` is honoured). In `compose.yaml` that means either running the app outside compose with the provider pointed at the host daemon, or mounting a socket proxy into the app container — **never the raw `/var/run/docker.sock`**, which is root on the host. Tuning variables (`VALMONT_SANDBOX_CPUS`, `_MEMORY_BYTES`, `_PIDS_LIMIT`, `_STORAGE_BYTES`, `_TTL_MS`, `_UID`/`_GID`) are listed in `.env.example`; multi-process deployments sharing one daemon must also set `VALMONT_SANDBOX_LEASE_DIR` (shared POSIX volume) and a stable `VALMONT_SANDBOX_INSTANCE_ID` — see [docs/SANDBOX-SMOKE.md](SANDBOX-SMOKE.md) and run `npm run smoke:sandbox` against the real daemon before going live.

Whichever provider you pick, before exposing Valmont to customers, organizations you do not control, or public sign-up, the task sandbox must have:

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
6. Keep `/api/health` (readiness) on an internal monitoring check — it reports `degraded` 503 when migrations are incomplete/unavailable, email is half-configured, Live payments are selected without a complete connection, or `SESSION_SECRET` is weak. Container orchestration should use `/api/health?probe=live`.
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

The production image (`node:22.23-bookworm-slim`, Next.js standalone output,
running as `USER node`) installs **no Playwright browser binaries**. Browser
tests belong in CI, where `npx playwright install --with-deps chromium` runs as
an explicit step. Do not add that step to the Dockerfile.

### Custom domains: ownership proof

A merchant attaches a hostname on the website's **Domain** card. Studio issues
a per-website verification token and shows two DNS records:

| Type  | Name                         | Value                    |
| ----- | ---------------------------- | ------------------------ |
| TXT   | `_valmont-verify.<hostname>` | `valmont-verify=<token>` |
| CNAME | `<hostname>`                 | `STUDIO_PLATFORM_HOST`   |

The hostname is served only while **both** resolve: the TXT record proves
control of the zone (a dangling CNAME left behind by a previous owner is not
enough), and the CNAME must point exactly at the platform host — there is no
A-record / IP fallback. The proxy re-checks every active domain in the
background at most once per 24 hours and flips it back to `pending` when
either record disappears. Hostnames are validated against the DNS label
grammar and are unique across all tenants; a hostname already attached to
another website answers 409. Backups export domains **without** their tokens,
so a restore on another machine re-issues a token and starts the domain at
`pending` again.

### Payments: test and live orders

Every order is stamped with the payment mode it was created under
(`payment_mode`: `test` or `live`). Test-mode orders — placed through the
built-in simulator — carry a **Test** badge in Studio, are excluded from the
revenue analytics (the page shows how many were excluded) and are never
something to fulfil. If the Payments page has Live selected but the API URL,
key or webhook secret is missing, online checkout methods answer 409 with a
customer-facing message (no order row is created) rather than falling
back to the simulator; cash-on-delivery and other offline methods keep
working, and readiness reports `dependencies.payments = live_misconfigured`.

### Bundle delivery: simulator only until TechChief is connected

Paid data-bundle orders create one delivery row per purchased bundle unit
(`studio_deliveries`, migration `0012`) and dispatch a top-up through the
provider selected by `BUNDLE_DELIVERY_PROVIDER`. The default (and any
production value today) is `simulator`: it rehearses the full lifecycle with
no real data moving, so delivered-looking rows in a self-hosted test shop
move no data. `techchief` is a stub that fails every send with an
owner-visible reason until the Stage 5 integration document arrives — there
is no real-provider mode to enable before then. An unknown value fails
closed the same loud way, so a typo can never make the simulator record fake
deliveries for a live shop. Two money-safety rules hold while no live
provider exists: a data-bundles checkout in **live payment mode is refused
with 409** before any order row exists (a customer who paid real money is
never owed data nothing can deliver), and the engine itself refuses to
dispatch a live-money order through a non-live provider. Delivery failures
never affect payments: the webhook marks the order paid and answers 200
first, dispatches fire-and-forget, the merchant gets one aggregated alert
per failing pass, and the failed rows stay retryable from Studio → Orders.

### What Phase 1 does not do in production

No file uploads, no payment processing, no repository generation, and no
deployments. Nothing in the Studio can take an order or move money. Do not
describe a generated Brief to a customer as a working website.
