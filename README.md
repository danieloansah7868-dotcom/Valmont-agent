# Valmont Agent

Valmont Agent is a private, web-based software assistant with reopenable conversations and explicit human approval before coding and again before a pull request. It can discuss general questions or read-only repository context, hand a reviewed conversation into a coding task, generate a context-grounded plan, apply model-generated file changes in a restricted workspace, run approved validations, and create a reviewed `valmont/*` pull request.

> **Safety boundary:** Valmont never merges, deploys, force-pushes, changes repository settings, or writes to protected/base branches. A pull request requires an explicit final approval.

## What works

- GitHub OAuth with encrypted, short-lived, `HttpOnly`, `SameSite=Lax` session data
- Authorized repository listing plus explicit GitHub repository creation with user-selected name and private/public visibility
- Bounded source-tree retrieval, archive download, branch/commit, and pull-request operations
- Actual model-generated file creation, modification, and deletion inside a generated task workspace
- Approved dependency/test/lint/type-check/build command execution with real output and diffs
- Persisted approval-first task state machine and visible audit timeline
- **Chat with Valmont** for normal, reopenable conversations, with optional read-only repository/branch context and an explicit conversation-to-task handoff
- Repository retrieval with sensitive/generated/binary path exclusions, bounded files, lexical/symbol search, and secret redaction
- Provider-neutral `ModelProvider` supporting chat, structured output, tools, streaming, usage, and normalized errors
- OpenAI-compatible server adapter configured only through server environment variables
- Restricted local `WorkspaceProvider` with traversal/symlink defenses, exact command allowlist, timeouts, output limits, and process-group termination
- Landing, dashboard, repositories, task creation/detail/result, diff, validation, tools, approvals, and settings interfaces
- Typed Drizzle ORM schema, migration, and session-scoped PostgreSQL task store for every required workflow entity
- CSRF double-submit protection, same-origin checks, basic rate limiting, security headers, input validation, and audit events

## Brand

The interface uses the Valmont Web visual identity from [valmontweb.com](https://valmontweb.com):

| Token        | Hex       | Usage                                     |
| ------------ | --------- | ----------------------------------------- |
| Navy blue    | `#0A1F44` | Strong backgrounds, sidebar, headings     |
| Orange       | `#E8822B` | Primary actions and approval boundaries   |
| Warm ivory   | `#ECE9DE` | Page backgrounds and inverse text         |
| Valmont blue | `#14446C` | Secondary navigation and informational UI |
| Slate        | `#606678` | Supporting body text                      |

Palette tokens live in the `@theme` block of `src/app/globals.css` and are consumed as Tailwind utilities (`bg-navy`, `text-copper`, `bg-ivory-50`, `text-brandblue`, `text-slate`). The `copper` token carries the orange ramp. Green and red are reserved exclusively for passed/failed validation status. Focus rings are orange and visible on every interactive element.

Primary buttons use navy text on orange (5.93:1) because white on this orange measures only 3.51:1 and fails WCAG AA. Orange on navy is 5.93:1, ivory on navy is 13.37:1.

### Live only

Valmont has a single runtime. It always runs against real GitHub repositories, your configured model provider, and real workspace execution. There is no demo mode, no sample-data flag, and no fixture fallback anywhere in the product, so the application can never invent repository data, plans, patches, validation output, diffs, branches, or pull-request results:

- unauthenticated visitors are redirected to connect GitHub instead of being given a fictional workspace;
- `createModelProvider()` throws when `MODEL_API_KEY` is missing rather than substituting a deterministic planner;
- the API returns `401` with a clear "connect GitHub" message, and the UI renders a connect prompt listing the exact server variables still required;
- `/api/health` reports `degraded` with a `missingConfiguration` list until every required variable is set.

Missing credentials fail loudly and name the unset variable. Nothing is fabricated to fill the gap.

The included local workspace adapter makes the complete flow usable on a trusted self-hosted machine. Before allowing untrusted repositories or users, replace it with an ephemeral container or external sandbox `WorkspaceProvider` as described below.

## Quick start

Requirements: Node.js 22.13+ (the container images pin 22.23) and npm. Chat memory uses the built-in local SQLite driver; no hosted database or paid vector service is required.

```bash
npm install
cp .env.example .env.local # set GitHub, model, and session values
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Configure `SESSION_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `MODEL_API_KEY` first — without them Valmont reports what is missing rather than showing sample data. Then connect GitHub, create or choose a repository, submit a task against a selected branch, approve the grounded plan, inspect the actual validation output and diff, and give final approval to create the real pull request.

## Environment configuration

Valmont requires `SESSION_SECRET`, the GitHub OAuth pair, and `MODEL_API_KEY`. Never prefix model or GitHub secrets with `NEXT_PUBLIC_`.

| Variable                     | Purpose                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `DATABASE_URL`               | PostgreSQL connection URL                                                                      |
| `CHAT_STORE_PATH`            | Legacy JSON chat-store input for migration (default `.data/chat-store.json`)                   |
| `CHAT_SQLITE_PATH`           | SQLite chat-store destination; defaults to a sibling `.sqlite` path next to `CHAT_STORE_PATH`  |
| `SESSION_SECRET`             | 32+ random characters for AES-GCM session encryption; short or placeholder values are refused  |
| `APP_URL`                    | Public origin, e.g. `http://localhost:3000`; every emailed link and payment return URL uses it |
| `TRUST_PROXY`                | `true` only behind a proxy that rewrites `X-Forwarded-For` (per-client rate limits)            |
| `VALMONT_WORKSPACE_PROVIDER` | `local` (default, restricted process) or `docker` (one throwaway container per task)           |
| `GITHUB_CLIENT_ID`           | GitHub OAuth App client ID                                                                     |
| `GITHUB_CLIENT_SECRET`       | GitHub OAuth App secret                                                                        |
| `MODEL_BASE_URL`             | OpenAI-compatible `/v1` base URL                                                               |
| `MODEL_API_KEY`              | Server-only model API key                                                                      |
| `MODEL_NAME`                 | Provider model identifier                                                                      |
| `VALMONT_COMMAND_TIMEOUT_MS` | Per-command validation timeout (default 180000)                                                |

See `.env.example` for placeholders and the optional Studio, payments,
custom-domain and notification variables.

`GET /api/health` is the readiness probe (503 until the required settings and
dependencies are usable); `GET /api/health?probe=live` is the liveness probe
used by the container `HEALTHCHECK`.

### GitHub OAuth

1. Create a GitHub OAuth App under **Settings → Developer settings → OAuth Apps**.
2. Set the homepage to `APP_URL` and callback URL to `${APP_URL}/api/auth/github/callback`.
3. Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and a strong `SESSION_SECRET`.
4. Restart the app and choose **Connect GitHub**.

The MVP requests `read:user user:email repo`. GitHub's OAuth `repo` scope is needed to create repositories and to read or create branches/PRs in private repositories; GitHub OAuth does not expose a narrower private-repository write scope. For a multi-tenant production deployment, prefer a GitHub App with carefully reviewed repository administration/creation behavior and repository-selected Contents/Pull requests permissions. Valmont's adapter additionally allows content writes only to `valmont/*` branches and has no merge method.

### GitHub repository creation

The protected **Repositories** page has an explicit creation form for a user-selected name, optional description, and `private` or `public` visibility. **Private is the client and server default.** Submitting the form calls GitHub's authenticated-user repository endpoint and initializes a README so a default branch exists immediately. The resulting repository can then be selected for a chat or approval-gated coding task.

Creation is a direct user action, not a model tool: it requires an authenticated session, same-origin CSRF token, validated bounded input, and a stricter per-IP rate limit. Valmont exposes no repository deletion or settings-editing operation. A public selection is visually explicit and is never inferred from a prompt.

### Model provider

Configure an OpenAI-compatible endpoint:

```env
MODEL_BASE_URL=https://api.openai.com/v1
MODEL_API_KEY=replace-me
MODEL_NAME=gpt-4.1-mini
```

Credentials are read only in server modules. Add another provider by implementing `ModelProvider` in `src/lib/models`; the workflow does not need to change.

### Chat with Valmont

Chat sessions are separate from coding tasks. A session can be general, or it can use bounded, redacted, read-only context from one authorized GitHub repository and branch. The chat model receives no workspace or GitHub write tools and cannot modify files. When a conversation is ready for implementation, **Create coding task** copies a redacted, editable transcript into the existing task form; the normal plan and final approval gates still apply.

Reopenable sessions, messages, FTS retrieval data, and long-term memories are stored locally in SQLite. `CHAT_STORE_PATH` remains the backward-compatible legacy JSON input (default `.data/chat-store.json`), while `CHAT_SQLITE_PATH` selects the SQLite destination. When `CHAT_SQLITE_PATH` is omitted, Valmont derives a distinct sibling destination by replacing the legacy path extension with `.sqlite` (for example `.data/chat-store.json` becomes `.data/chat-store.sqlite`), so a configured persistent legacy directory remains in use. Before migration, Valmont creates `<legacy path>.pre-sqlite-backup`, migrates transactionally, and records completion only with the migrated rows. Never point both variables at the same file; the legacy JSON source is never opened as SQLite or overwritten. High-confidence secret patterns are redacted before messages are sent or persisted, but chat history is still sensitive local data: do not paste credentials, restrict filesystem access, and include the store in an intentional backup/deletion policy. Retrieved repository files are not persisted in the chat store.

### PostgreSQL — controlled migrations, never automatic

```bash
createdb valmont
npm run db:verify:local   # no DB — validates full journal, SHA-256, ordering
npm run db:migrate        # requires DATABASE_URL — advisory lock, applies missing in journal order, re-verifies
npm run db:verify         # read-only — verifies ledger membership against journal
```

Migrations live in `src/db/migrations` with journal `meta/_journal.json`. The system validates the **complete** journal, not just the latest timestamp:

- structure (`version`/`dialect`), sequential `idx` 0..n-1 matching array position, unique `tag`/`idx`, numeric `when`, `breakpoints` boolean, SQL file existence, SHA-256 hash.
- journal order is authoritative — never timestamp ordering (regression: `0007_studio_domains` when `1787573273009` < `0006_studio_settings` when `1787616000000` but idx 7 > 6).
- ledger verification checks exact membership by hash + `created_at` against `drizzle.__drizzle_migrations`, failing closed on missing/altered/duplicate/unexpected rows.

**Fresh Docker volume:** `compose.yaml` mounts `0000_lazy_leopardon.sql` (base schema, lexical first) and `0001_bootstrap_ledger.sql` (inserts ledger row with hash `3bdd1e6fd184d9325d3db2b38b6ed7287fa7fde65c42bb87d15f96f176a7f249` timestamp `1786700718887` derived from source). This makes a new volume report `migrations.status: complete` for the historic base only.

**Existing volume without compatible ledger:** `/api/health` returns degraded 503 with `dependencies.migrations: { status: "incomplete", expected, applied }` until an operator runs `db:migrate`.

Valmont never runs prod migrations automatically. CI provides a throwaway PostgreSQL 16 service and runs `db:migrate` → `db:verify` → `npm test` → `build`.

When `DATABASE_URL` is set, Valmont selects the session-scoped PostgreSQL task store and persists tasks, events, approvals, tool executions, validations, diffs, and pull-request records. Without it, tasks fall back to an ignored local JSON store so the application remains runnable during setup.

### Customer email delivery (Resend)

Customer account emails (verification, password reset, order notifications) require **both** `RESEND_API_KEY` and `NOTIFY_EMAIL_FROM` — validated together, all-or-nothing:

- both unset → `not_configured` → dev returns clearly local-only one-time links, prod fails closed 503.
- one set / blank / malformed / CR-LF / angle-bracket injection → `invalid` → 503.
- both valid (plain `noreply@example.com` or `Valmont <noreply@example.com>`) → `configured`.

Delivery uses `fetch` with portable `AbortController` + 10s timeout (timer cleared in `finally`), provider failures normalized to typed 502 `CustomerEmailDeliveryError` with generic message (no bodies/keys leak). Config check runs **before** account lookup for anti-enumeration; `forgot-password`/`resend-verification` suppress only 502 after lookup, preserving neutral `ok:true`. See `src/lib/resend-config.ts` and `src/lib/customer-email.ts`.

### Strict typed API errors

`src/lib/api-errors.ts` defines explicit `ApiError` subclasses with intentional statuses: 400 `BadRequestError`, 401 `UnauthorizedError`/`NotConnectedError`, 403 `ForbiddenError`, 404 `NotFoundError`/`ChatNotFoundError`/`TaskNotFoundError`/etc, 409 `ConflictError`/`DraftConflictError`/`ImportInProgressError`/`OrderTransitionError`/`OnlinePaymentUnavailableError`, 413 `PayloadTooLargeError`, 429 `RateLimitError`, 502 `CustomerEmailDeliveryError`/`GitHubApiError`, 503 `CustomerEmailConfigurationError`/`WeakSessionSecretError`.

`safeApiError` in `src/lib/api.ts` trusts **only** `ApiError` instances. Zod errors → generic 400, JSON syntax → generic 400, arbitrary `Error("Task not found")`, plain objects with `status`, driver/network errors → opaque 500. No message-text heuristics. Tests preserve a single shared `ApiError` identity (no `vi.resetModules` with partial mocks).

## Scripts

```bash
npm run format         # format source and docs
npm run format:check   # verify formatting
npm run lint           # ESLint (Next.js core web vitals + TypeScript)
npm run typecheck      # strict TypeScript
npm test               # Vitest suite
npm run db:verify:local # validate journal + hashes, no DB
npm run db:migrate     # controlled migrate: advisory lock, apply missing in journal order, re-verify
npm run db:verify      # read-only ledger verification
npm run build          # production Next.js build
npm run validate       # all checks above plus build
npm run db:generate    # generate a migration from Drizzle schema
```

## Project map

- `src/app` — Next.js App Router pages and protected APIs
- `src/components` — application UI and approval controls
- `src/lib/workflow.ts` — persisted workflow orchestration and approval gates
- `src/lib/models` — provider-neutral model contract and adapters
- `src/lib/github` — GitHub contract and API adapter
- `src/lib/retrieval.ts` — repository filtering and lexical retrieval
- `src/lib/workspace.ts` — sandbox contract and restricted development adapter
- `src/db` — Drizzle schema and SQL migrations
- `docs/ARCHITECTURE.md` — design and extension points
- `docs/SECURITY.md` — threat model and controls
- `docs/PRODUCTION.md` — Docker deployment and production hardening checklist

## Important production note

The local workspace adapter is **not** represented as a secure production sandbox. Its checks reduce accidental host access, but repository scripts execute as a host process. Use an ephemeral container or external code sandbox with an unprivileged user, read-only base image, CPU/memory/PID limits, network egress controls, short TTL, and no host mounts. See the threat model for details.

## Website Studio Phase 1

The Website Studio collects everything needed to plan a website. It does **not**
build, deploy, or run one. Everything below describes what Phase 1 actually
does today.

### What Phase 1 can do

- **A four-step wizard** — website type (with an online-shop sub-type), package,
  look and layout, then business details. Steps can be revisited in any order.
- **Drafts you own** — create, edit, reopen, and delete. A draft is tied to your
  GitHub identity; nobody else can read or change it.
- **Autosave** — changes save automatically a moment after you stop typing.
  Saves are queued one after another, never overlapping, so a fast typist cannot
  race their own edits. The header always shows the current state ("All changes
  saved", "Saving…", "Not saved yet", or the reason a save failed).
- **Nothing is lost when you change your mind** — switching website type,
  package, theme, or layout keeps every business detail you have already
  entered. If a chosen layout does not suit a new website type, the closest
  suitable layout is selected instead.
- **Brief completeness** — a percentage plus a plain-language list of what is
  still needed. This measures how complete the _plan_ is, not whether a website
  is ready to launch.
- **A safe preview** — shows only what you typed. Missing details appear as
  "Not provided yet". Text is never treated as HTML, and only `https` links that
  pass a safety check become clickable.
- **Two people editing at once is handled honestly** — if the draft changed
  elsewhere while you were typing, Valmont refetches, reapplies your pending
  edit when the two changes do not overlap, and otherwise shows both options and
  asks which to keep. Neither person's work is silently discarded.
- **Products as well as services** — simple names and optional categories only.
- **Ghana-friendly defaults** — Ghana, GHS/GH₵, `Africa/Accra`, automatic +233
  phone formatting, the sixteen Ghana regions, WhatsApp, and service or delivery
  areas.
- **Backups** — download everything (chats, memories, and website drafts) as one
  JSON file, and restore it later.

### What Phase 1 cannot do

- No file or logo uploads. `assetStatus` is only a marker; there is no upload
  control and no arbitrary asset URL is ever stored.
- **No payments of any kind.** Payment preferences recorded in a draft are
  labelled future-planning information. Mobile money, Paystack, Valmont Pay,
  cards, checkout, and delivery calculation are **not connected and do not
  work.**
- No product catalogue, prices, stock, cart, or orders.
- No repository generation, no sandboxed build, and no deployment.
- No admin roles or team sharing.

Phases 2–6 (uploads and object storage, repository generation, sandboxed
builds, preview deployments, roles, e-commerce and payments) are deliberately
**not implemented.**

### Data Bundles website type

A **Data Bundles & Airtime Reseller** website type sells MTN, Telecel and AirtelTigo data bundles with instant delivery. Bundles are normal catalogue products with a structured `bundle: { network, dataMb, validity }` field (1 GB = 1024 MB, stored as whole MB so 0.5 GB → 512 MB). The wizard shows a dedicated **Bundles you sell** table with network, size (MB/GB display-only switch), price and validity, plus a _Load starter price list_ that merges 18 Ghana bundles (6 per network) by stable id. Readiness v2 requires at least one priced bundle with metadata and no missing fields. The public shop at `/s/[id]` renders network tabs, size+validity, Ghana-mobile-only checkout (02x/05x, 030 landline refused, normalized to 0xxxxxxxxx, single `validateGhanaMobile` source), and shows a network-mismatch warning only. Category switching strips bundle metadata when leaving data-bundles and enriches priced items when entering, keeping the brief valid so autosave never freezes. Stage 3 adds a required **recipient phone** (`recipient_phone` column, one number per order, every bundle in the basket goes to that number) plus an optional buyer contact number, and enforces **Valmont Pay only, no delivery** for bundle shops (superRefine + wizard + checkout route). The recipient must be a Ghana mobile; the buyer's own contact may be from any country, because many bundle buyers are in the diaspora paying for family in Ghana. Stale bundle configs saved before the online-only rule (cash on delivery, or delivery switched on) are repaired on read so autosave cannot freeze. The guest order-confirmation page prints no phone number except a masked recipient line (`024 ••• 0001`); full numbers appear only on the owner's Studio order page and the customer-account order page.

### Where drafts are stored

- **Without `DATABASE_URL`** — SQLite, in **exactly the same file as Chat**. One
  shared path resolver (`src/lib/sqlite-path.ts`) is used by both, so there is
  never a second database file and a legacy JSON store is never opened as
  SQLite.
- **With `DATABASE_URL`** — PostgreSQL, in the `studio_drafts` table.

### Not losing an edit (optimistic concurrency)

Every draft carries a `revision` number. A save sends the revision it was based
on, and the server applies it as a single atomic statement:

```sql
UPDATE studio_drafts
   SET brief = $1, revision = revision + 1, updated_at = now()
 WHERE id = $2 AND owner_id = $3 AND revision = $4
RETURNING ...
```

If no row comes back the save is rejected with `409 Conflict` — never a
misleading `200`. With two people saving the same revision at the same moment,
exactly one succeeds. A draft that does not exist and a draft belonging to
somebody else both return the same generic `404`, so the API never reveals
whether an ID exists.

### Backups

- `GET /api/backup/export` downloads a version 2 backup:
  `{ backupVersion: 2, exportedAt, chat: {...}, studio: {...}, customers: {...}, domains: {...} }`.
  Custom domains are exported without their verification tokens; on import
  they are re-attached as `pending` with a fresh token and must be verified
  again, and a hostname already claimed on the target machine is skipped and
  counted.
- `POST /api/backup/import` accepts a version 2 backup **and** a legacy
  version 1 chat-only file. An unknown version is rejected _before anything is
  written_.
- Owner IDs inside the file are never trusted. Everything is reassigned to the
  signed-in account.
- A draft ID that already exists is imported as a separate copy under a new ID
  rather than overwriting your work.
- The whole import is all-or-nothing. On SQLite, chat, memories and drafts
  share one database handle and one transaction, and the export reads both
  halves inside one read transaction so a backup file is a consistent snapshot.
  With `DATABASE_URL` set, chat stays in SQLite while drafts go to PostgreSQL;
  those two engines are **not** one atomic snapshot on export. A durable
  cross-store coordinator takes an owner-level **lease** (token, generation,
  heartbeat expiry) so a second import for the same account is refused with
  `409` before either store changes, then records the staged payload and a
  pre-import snapshot. A live lease is never treated as a crash. After a
  real crash the lease expires and the next import or startup claims recovery
  with a compare-and-swap. SQLite-only complete imports take the same lease.
  PostgreSQL Studio writes are additionally fenced inside PostgreSQL itself: a
  durable per-owner fence row (identity only, never exported) must pass a
  conditional check as the final statement of every Studio import/restore
  transaction, so a transaction whose lease was replaced mid-flight can never
  commit late writes over a finished recovery.
  Any failure — or a process killed mid-import — rolls both stores back to
  their exact previous state. Success is reported only after both halves committed; a rolled-back
  import is reported as a plain failure, never a partial success. After success
  or a successful rollback the journal keeps only non-sensitive metadata (id,
  owner, status, timestamps, counts) — the payload and snapshot are logically
  deleted. That is not a guarantee the bytes have been wiped from SQLite pages
  or filesystem backups. An unresolved rollback failure keeps the snapshot and
  the lock until recovery finishes.
- The older `/api/memories/export` and `/api/memories/import` endpoints keep
  their version 1 behaviour unchanged.

### Request size limits

Request bodies are read as a stream and counted byte by byte, stopping as soon
as the limit is passed and parsing only afterwards. This holds even when
`Content-Length` is missing, wrong, or the body is chunked.

| Endpoint                                    | Limit   |
| ------------------------------------------- | ------- |
| Draft create and update                     | 1 MB    |
| Backup import                               | 25 MB   |
| Payment webhook (raw body, HMAC-verified)   | 50 KB   |
| Tasks                                       | 64 KB   |
| Chat messages                               | 32 KB   |
| Chats, memories, repositories, task actions | 4–16 KB |

Errors never echo back what you submitted, so business details and private
values stay out of messages and logs.

### Testing

```bash
npm test                # unit and integration tests (Vitest)
npm run test:e2e        # browser tests (Playwright, Chromium)
```

The browser tests need a session secret and a browser:

```bash
npx playwright install --with-deps chromium
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") npm run test:e2e
```

They build and start a real production server on port 3200 (override with
`E2E_PORT`) against a throwaway SQLite database under `.e2e-data`. Your real
`.data` files are never touched. Sign-in uses a genuine encrypted session
cookie created with the same `SESSION_SECRET` the server was started with —
**there is no test-only authentication bypass in application code.**

The PostgreSQL draft tests only run when `STUDIO_TEST_DATABASE_URL` points at a
throwaway database; otherwise they are reported as skipped, never as passed. CI
provides a real PostgreSQL 16 service so they always run there. Playwright
schedules 11 tests across 2 projects (22 scheduled tests). Do not treat a
past test count as a permanent fact — use the latest CI run on the pull request.

The production Docker image does **not** install browser binaries.
