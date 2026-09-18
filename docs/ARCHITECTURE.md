# Valmont Agent architecture

## Goals

Valmont is an approval-first orchestration layer between an authorized GitHub repository, a model provider, and an isolated workspace. Its design keeps provider-specific code at the edges and makes unsafe capabilities absent rather than merely discouraged in prompts.

## Chat flow

1. GitHub OAuth establishes a short-lived encrypted server session.
2. The user creates a general chat or selects one authorized repository and branch for that session.
3. Each message is validated, rate-limited, and redacted. Repository-aware chats recheck authorization and retrieve only bounded, filtered, redacted text from the selected branch.
4. The ordinary `ModelProvider.chat()` interface receives conversation history and optional read-only context. No workspace or GitHub write capability is present in the chat route.
5. Redacted user and assistant turns are persisted in the user-owned local chat store so several sessions can be reopened independently. Retrieved repository files are never persisted with the chat.
6. **Create coding task** produces an editable transcript draft in the separate task form. It does not mutate the conversation or authorize any code operation.

## Repository creation flow

1. The authenticated user opens the protected repositories page and explicitly enters a repository name, optional description, and private/public visibility. Private is the client and server default.
2. The mutation passes same-origin and double-submit CSRF checks, a creation-specific rate limit, and bounded Zod validation.
3. `GitHubApiProvider.createRepository()` calls the fixed GitHub `/user/repos` endpoint with `auto_init: true`; the user input cannot select a host, owner, or arbitrary API path.
4. The created repository summary is returned to the UI and the authorized list is refreshed. No model participates, and no chat or task approval state is changed.
5. The provider exposes no repository deletion or settings-editing method. Subsequent file changes still require a separate coding task and both approvals.

## Coding task request flow

1. GitHub OAuth establishes a short-lived encrypted server session.
2. The user selects an authorized repository/base branch and submits a bounded task description.
3. `TaskWorkflowService` records `draft → planning` plus audit events.
4. Retrieval lists/searches/reads only filtered, bounded text. Model context is redacted.
5. A `ModelProvider` produces a structured plan. Without `MODEL_API_KEY` the provider factory throws instead of substituting sample output; no deterministic planner exists.
6. State becomes `awaiting_plan_approval`. No workspace mutation is available before explicit approval.
7. The workspace provider applies approved changes and runs only listed/allowlisted validation commands.
8. Diff, status, tools, and command output are persisted/redacted and shown for review.
9. State becomes `awaiting_final_approval`. GitHub write tools remain unavailable.
10. Explicit final approval allows creation of a `valmont/*` branch, commit, and pull request. No merge or deployment capability exists.

## Modules and boundaries

### Workflow/domain

`src/lib/task-machine.ts` is the single transition map. `assertCanExecute` and `assertCanCreatePullRequest` validate both state and latest approval. `TaskWorkflowService` adds an audit event for every meaningful transition/action and persists through the `TaskStore` interface.

States:

```text
draft → planning → awaiting_plan_approval → executing → testing
      → awaiting_final_approval → creating_pull_request → completed
```

Planning/execution/PR creation can fail; pending states can be cancelled. Terminal states have no outgoing transitions.

### Model providers

`ModelProvider` defines:

- `chat()` with normalized messages, tools, usage, errors, and finish reason
- `structured()` with JSON Schema plus caller validation
- `stream()` as an async iterable
- capability metadata

`OpenAICompatibleProvider` maps this contract to `/chat/completions`. API keys never enter React props, client bundles, API payloads, events, or the database. Anthropic/Gemini/self-hosted adapters can implement this interface without altering workflow state transitions.

### GitHub providers

`GitHubProvider` defines explicit authenticated-user repository creation, repository tree/file reads, bounded archive download, and branch/commit/PR writes. Planning retrieves ranked source directly through GitHub APIs. After plan approval, the authorized base-branch archive is filtered and copied into the generated workspace. `GitHubApiProvider`:

- creates an initialized repository only from a bounded name, description, and private/public choice supplied by the protected form;
- validates owners, repositories, refs, and file paths;
- refuses non-`valmont/*` write branches;
- updates refs with `force: false`;
- has no merge, deployment, settings, or protected-branch method.

### Retrieval

The first retriever is lexical and intentionally simple:

- recursively lists allowed regular files, skipping symlinks;
- blocks dependencies, generated outputs, `.git`, `.env*`, credentials, private keys, archives/databases/binaries, and sensitive path patterns;
- detects binary byte patterns and enforces per-file bounds;
- scores exact text, tokens, filenames, and symbol declarations;
- returns bounded excerpts after redaction.

`RepositoryRetriever` is an interface. Embedding/chunk/vector adapters can be added later, but should preserve the same path policy and minimization controls. Repository knowledge is retrieved per task; no fine-tuning is used.

### Workspaces/tools

`WorkspaceProvider` separates workflow from execution. `RestrictedLocalWorkspaceProvider` copies filtered files into a generated task directory, resolves every path under that root, rejects symlinks/escapes, and runs exact executable/argument tuples with `shell: false`, timeout, output cap, restricted environment, and process-group termination.

The initial tool surface is represented by provider/retriever methods: `list_files`, `search_code`, `read_file`, `write_file/apply_patch`, `git_diff`, `git_status`, and `run_validation_command`. There is no general shell tool. Deploy/publish/migration text is blocked even if accidentally configured.

The local adapter is development-only. Production uses a separate container/external sandbox implementation.

### Persistence

Drizzle/PostgreSQL entities:

- users, accounts, sessions
- optional customer accounts, hashed customer sessions, and one-time email tokens
- customer-owned Studio order links
- repository connections
- coding tasks and task events
- approvals
- workspaces
- model/tool executions
- pull request records
- owner ideas (`ideas` table — per-user private notebook, never fed to prompts)

`PostgresTaskStore` is selected automatically when `DATABASE_URL` is configured and enforces session ownership in every task query. It hydrates normalized event, approval, tool, and pull-request records. Raw repository content and assembled model prompts are not stored in these tables. Account token ciphertext is explicitly server-only. The task JSON fallback uses `.data/task-store.json`, atomic rename writes, and a process-local serialization queue; it starts empty and is never seeded with fixtures.

`CustomerAccountStore` uses the same automatic SQLite/PostgreSQL selection as Studio orders. Customer email addresses are normalized, passwords are stored as parameterized scrypt hashes, session/token values are stored only as SHA-256 hashes, and customer order queries always filter by the authenticated customer account id. The feature is an owner opt-in per website (`brief.features.customerAccounts`, default off): the storefront account link, checkout auto-linking, order claiming, and `/account` order visibility are all gated on it. The Studio backup v2 `customers` section exports these tables (hashes only — password scrypt envelopes and SHA-256 token digests, never plaintext or payment credentials), and the restore path inserts with or-ignore semantics inside the existing single-transaction (SQLite) or fenced-coordinator (PostgreSQL) import, so a restore never overwrites an existing account.

`IdeaStore` (`src/lib/idea-store.ts`, behind `getIdeaStore()` which picks SQLite or PostgreSQL exactly like `getOrdersStore()`) persists the owner's private idea notebook: `id`, `user_id` (the signed-in GitHub user id), `title` (≤500), `details` (≤100,000), `status` (`idea` / `planned` / `building` / `done` / `dropped`, default `idea`), `priority` (1 = Now, 2 = Soon, 3 = Later, default 2), and timestamps, with a `(user_id, status, updated_at DESC)` index. SQLite creates the table with `CREATE TABLE IF NOT EXISTS` on the shared `getSqliteChatStore()` connection (the same handle the Studio stores use); PostgreSQL gets it from Drizzle migration `0013_ideas.sql`. Every list/create/update/remove query filters by the authenticated user id, and an update or delete addressed at another user's id returns `null` / `false` (the API answers 404). Ideas are personal scratch space: they are **never** loaded into model prompts, context, memory capture, or any chat path — the Ideas page states this and the store has no importer into the chat pipeline. Write routes carry the same guards as `/api/memories` (CSRF, rate limit bucket `idea-write` at 30/min, 1 MB bounded body — the notebook holds long written-out plans, zod validation, and `redactSecrets` with a 400 "Ideas cannot contain secrets" when redaction fires). The complete backup file carries an optional `ideas` section (version 1, array capped at 10,000); old files without it still import, and restore upserts by id with the owner forced to the importing user.

`SqliteChatStore` persists user-owned session metadata, redacted message history, FTS retrieval rows, summaries, memories, and memory preferences in ignored local SQLite storage. `CHAT_STORE_PATH` is retained solely as the backwards-compatible legacy JSON input (default `.data/chat-store.json`). `CHAT_SQLITE_PATH` optionally selects the SQLite destination; when omitted, the destination is a distinct sibling `.sqlite` path next to the configured legacy source (for example `chat-store.json` becomes `chat-store.sqlite`). Startup validates that source and destination are distinct before opening SQLite, copies the source to an adjacent `.pre-sqlite-backup`, migrates rows and the completion marker in one immediate transaction, and rechecks the marker under the transaction lock to make restarts idempotent. The legacy JSON is never opened as SQLite or overwritten. Every get/list/delete operation includes the authenticated GitHub user ID. Repository context is deliberately absent from persisted messages; it is retrieved again after authorization checks for each repository-aware turn. This local-first store is intended for the trusted self-hosted runtime. A multi-instance production deployment must replace it with a transactional, encrypted, user-scoped store and retention/deletion controls.

### Web security

- OAuth `state` and encrypted session cookies
- HttpOnly/SameSite session; CSRF double-submit token for mutations
- same-origin mutation checks
- Zod validation and basic per-operation/IP rate limits
- CSP and standard response hardening headers
- redaction before events, tool output, context, and diffs
- no browser-facing provider credentials

## Production hardening roadmap

- Move long-running execution from request handlers to a durable queue/worker and add optimistic state versioning for multi-process execution.
- Use a GitHub App for narrower, repository-selected installation permissions.
- Add a production container sandbox, network policy, quotas, and cleanup worker.
- Add distributed rate limiting, managed envelope encryption, and centralized audit export.
- Stream model/activity events through SSE while preserving persisted events as source of truth.
- Add embedding retrieval behind `RepositoryRetriever` only when repository scale warrants it.

## Runtime

Valmont has one runtime: live. There is no mode flag, no demo provider, and no fixture data anywhere in the product. `src/lib/config.ts` centralizes readiness resolution through `githubCredentialsConfigured()`, `modelCredentialsConfigured()`, `databaseConfigured()`, and `runtimeReadiness()`.

Missing credentials fail loudly at every boundary rather than being papered over in the UI:

- `getSessionUser()` returns `null` when no encrypted session exists; `requireSessionUser()` redirects and `requireApiSessionUser()` raises a `NotConnectedError` mapped to HTTP 401.
- `getGitHubProvider()` throws unless a real GitHub session token is present; `tryGetGitHubProvider()` is the non-throwing variant used by status surfaces.
- `createModelProvider()` throws naming `MODEL_API_KEY`; `tryCreateModelProvider()` is the non-throwing variant.
- `TaskWorkflowService` requires a real `GitHubProvider` as a constructor argument and can only execute against a real workspace.
- `JsonTaskStore` starts empty; the PostgreSQL schema carries no demo columns.

`missingLiveRequirements()` drives the connect prompts, settings page, and `/api/health` `missingConfiguration` array so operators see exactly which variables remain unset.

## Website Studio Phase 1

Phase 1 is a **planning surface**. It captures a Site Brief and nothing more: no
build pipeline, no deployment, no payments. Phases 2–6 are deliberately absent
from the codebase.

### Modules

| Path                                     | Responsibility                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/lib/studio/categories.ts`           | 15 website types plus 11 online-shop sub-types.                                    |
| `src/lib/studio/packages.ts`             | Lite / Starter / Business / Empire, each with page and product limits.             |
| `src/lib/studio/themes.ts`               | 7 themes, exported as design tokens only — never forked layouts.                   |
| `src/lib/studio/templates.ts`            | Real template registry: manifests, per-category compatibility, and reconciliation. |
| `src/lib/studio/site-brief/schema.ts`    | `siteBriefSchemaV1` — Zod base object plus cross-field `superRefine`.              |
| `src/lib/studio/site-brief/defaults.ts`  | Ghana defaults, region list, `formatGhanaPhone`, planned-payment labels.           |
| `src/lib/studio/site-brief/readiness.ts` | `computeBriefCompleteness` and the preview placeholder helper.                     |
| `src/lib/studio/draft-store.ts`          | `SqliteStudioDraftStore` and `PostgresStudioDraftStore` behind one interface.      |
| `src/lib/idea-store.ts`                  | Owner's private idea notebook: `SqliteIdeaStore` / `PostgresIdeaStore`, per-user.  |
| `src/lib/studio/merge.ts`                | Field-level three-way merge used by the 409 recovery path.                         |
| `src/lib/studio/backup.ts`               | Backup v2 build, parse, and transactional import.                                  |
| `src/lib/sqlite-path.ts`                 | The single SQLite path resolver shared by Chat and Studio.                         |
| `src/lib/bounded-json.ts`                | Streaming, byte-counted request-body reader.                                       |

### Template registry

`SiteBriefV1` accepts `selectedTemplate`, so a registry must genuinely exist —
otherwise the field would be a lie. `templates.ts` holds a manifest per layout
(`id`, `label`, `description`, ordered `sections`, `compatibleCategories`).
`"*"` means the layout suits every website type, which guarantees the "Custom
Website" category can never have zero choices. The schema's `superRefine`
rejects a template that does not suit the chosen category, and the wizard calls
`reconcileTemplate(category, current)` when the category changes so a draft can
never point at an incompatible layout.

### Persistence

- **SQLite (no `DATABASE_URL`)** — `studio_drafts` lives inside the **same file
  and the same `DatabaseSync` handle** as Chat. `getStudioSqliteStore()` returns
  Chat's singleton store, so a complete-backup import can put chat sessions,
  memories, and drafts inside one real transaction. The Studio schema is
  versioned in a dedicated `studio_meta` table and upgraded through sequential,
  transactional migrations (`migrateStudioSchema` in `draft-store.ts`): the
  recorded version is written only after every migration succeeds, a failure
  rolls schema and metadata back together, a recorded version newer than this
  build supports is rejected, and repeated startup is a no-op. Databases
  created by earlier builds (version recorded in `chat_meta`) are detected and
  moved onto the dedicated table without re-running work.
- **PostgreSQL (`DATABASE_URL` set)** — the `studio_drafts` table from Drizzle
  migration `0002_uneven_the_anarchist.sql`: uuid primary key, `owner_id`
  referencing `users` with cascade delete, a `jsonb` brief, and the
  `studio_drafts_owner_updated_idx` index.

The owner's ideas follow the same two-engine pattern in
`src/lib/idea-store.ts`. On SQLite the `ideas` table is created with
`CREATE TABLE IF NOT EXISTS` on the shared chat-store connection (so it joins
the same single-transaction backup import as chat, memories and drafts). On
PostgreSQL it is created by Drizzle migration `0013_ideas.sql`: uuid primary
key, `user_id text not null` (the GitHub user id, matching the chat store's
text `user_id` rather than the Studio `owner_id` uuid), `title`, `details`,
`status`, `priority`, timestamps, and `ideas_user_status_updated_idx` on
`(user_id, status, updated_at DESC)`. Scope is per user in both engines:
every query filters by `user_id`, another user's idea answers update `null`
/ delete `false`, and backups force the importing user as the owner. Ideas
are never read by the chat or model-prompt paths.

`src/lib/user-identity.ts` maps a GitHub id to a canonical UUID with
`deterministicUuid("github:" + id)`, and `ensureStudioUser` upserts the row only
when PostgreSQL is in use.

### Shared SQLite path resolution

`src/lib/sqlite-path.ts` is the one place that answers "which file?". It exports
`DEFAULT_CHAT_STORE_PATH`, `deriveSqliteChatStorePath`,
`configuredLegacyChatStorePath`, `configuredSqliteChatStorePath`,
`legacyBackupPath`, `assertDistinctStorePaths`, and `resolveSqliteStorePaths`.
Chat and Studio both call it, so they cannot drift onto different files. The
legacy JSON path and the SQLite path are asserted to differ, and a `.json`
legacy source is never opened as a SQLite database. Studio adds no environment
variable of its own.

### Optimistic concurrency

Both stores perform a single atomic conditional update and inspect the returned
rows:

```sql
UPDATE studio_drafts
   SET brief_json = $1, revision = revision + 1, updated_at = $2
 WHERE id = $3 AND owner_id = $4 AND revision = $5
RETURNING *
```

Zero rows means either a stale revision or a draft that is not yours. The store
distinguishes the two with a follow-up owner-scoped existence check and raises
`DraftConflictError` (409) or `DraftNotFoundError` (404). A `200` on zero rows is
impossible. `DraftNotFoundError` carries an identical message for a foreign
draft and a made-up id, so existence is never disclosed.

Client-side, `wizard.tsx` serializes saves through a single in-flight promise
and debounces keystrokes. On a 409 it refetches the server copy and calls
`mergeBriefs(base, mine, theirs)`. When the two sides touched different fields
the pending edit is reapplied and retried once; when they touched the same field
with different values, `merged` is `null` and the conflict banner asks the owner
to keep their version or take the other. Autosave is frozen while the choice is
on screen, and “Keep what is on this screen” saves the **newest on-screen
state** — including anything typed after the warning appeared — not a stale
conflict snapshot, so no write is ever dropped silently.

### Backups

`buildBackup(user)` produces
`{ backupVersion: 2, exportedAt, chat: { version: 1, ... }, studio: { version: 1, schemaVersion: 1, drafts: [...] } }`.
On SQLite the chat and draft halves are read back to back inside **one read
transaction on the one shared `DatabaseSync` handle**, so the file can never
combine records from different points in time even if another writer commits
mid-export. `parseBackup(input)` checks the version **before** validating or
writing anything, and accepts a legacy v1 chat-only file by lifting it into the
v2 shape. `importBackup` reassigns every record to the authenticated canonical
owner — `ownerId` values in the file are always ignored — and remaps a colliding
draft id to a fresh `randomUUID()` rather than overwriting. Validation errors
report field _paths_ only (at most five), never submitted values.

SQLite runs the whole import inside `store.runInTransaction` on the single
shared handle, so a failure after any insert rolls chat, memories, and studio
back together. A `failAfterInsertForTests` hook lets the suite prove the
rollback rather than assume it.

With `DATABASE_URL` set, chat stays in SQLite while studio lives in PostgreSQL,
so there is no distributed transaction and a mixed-store **export** is two
separate reads, not one atomic snapshot. `import-coordinator.ts` is a durable
cross-store recovery coordinator instead: it first takes an owner-level
**lease** (owner id, job id, cryptographically random lock token, heartbeat
expiry, and a fencing generation). A second import for that owner inspects the
lease and is a `409` before either store changes or any recovery runs. Only
after the lock is held does it record a job in SQLite holding the staged
payload and a snapshot of both stores, then advance through durable
checkpoints. A running import renews the lease and checks the token before
every write. Recovery may claim a job only when the lease has expired, via an
atomic compare-and-swap on the token and generation; an obsolete token cannot
write, sanitize or release the replacement lock. Generations are issued from a
durable per-owner counter, so they never repeat — not after release, not after
a restart, not for a later import by the same owner.

The SQLite lease alone cannot stop an in-flight PostgreSQL transaction from
committing after the lease was replaced, so PostgreSQL Studio writes are
additionally fenced inside PostgreSQL itself. A durable
`studio_import_fences` row (owner id, job id, random lock token, monotonic
generation — identity only, never payload or credentials, never exported)
is installed for the lease before the pre-state capture. Every Studio
import/restore transaction verifies the fence when it starts and ends with a
conditional touch of that row — matching the exact held identity — as the
last statement before `COMMIT`; the touch takes the fence row's lock, so the
check and the commit are one serialized unit. Recovery advances the fence
inside the same transaction that restores the pre-import Studio snapshot.
Both orderings of the race are therefore safe: if recovery's fence advance
commits first, the obsolete transaction fails its final check and PostgreSQL
rolls back everything it wrote; if the obsolete transaction wins the fence
row-lock race and commits first, recovery serializes strictly after it and
overwrites the late writes with the exact snapshot. Once the replacement
fence is installed no obsolete transaction can commit at all. The fence row
persists after release so generations stay monotonic even if the SQLite file
is replaced.

A lease that has already expired is never resurrected: renewal and every
ownership assertion require an unexpired lease, and only a confirmed lost
lease stops the heartbeat — a transient database error is retried on the
next tick. A process killed mid-import
lets the lease expire; the next startup or import claims recovery and rolls
both stores back. A draft GET / startup scan skips unexpired live jobs.
Success is reported only after both halves committed; a rolled-back import is
a clean failure, and `PartialImportError` is reserved for the exceptional case
where the rollback itself could not complete. After success or a successful
rollback the payload and snapshot are logically deleted from the journal
(empty strings remain in those columns; this is not physical erasure of SQLite
pages). An unresolved rollback failure keeps the snapshot and the lease so a
new import cannot overwrite it. Different owners may import independently.
SQLite-only complete imports take the same owner lease. The PostgreSQL suite
injects failures at every checkpoint (`onCheckpoint`) and proves both stores
return to their exact previous state, including after a simulated crash and
restart.

### Request bodies

`readBoundedJson(request, limitBytes)` reads `Request.body` through
`getReader()`, adds up real chunk sizes, cancels the stream the moment the limit
is passed, and only parses once the whole body is safely buffered. It therefore
holds when `Content-Length` is absent, false, or the transfer is chunked.
Limits: `DRAFT_BODY_LIMIT_BYTES` 1 MB, `BACKUP_BODY_LIMIT_BYTES` 25 MB.

### Testing

Vitest covers the resolver, stores, merge, backup, bounded reader, schema
migrations, and the Site Brief. The PostgreSQL contract suite runs only when
`STUDIO_TEST_DATABASE_URL` is set and is otherwise reported as skipped, so
SQLite results are never presented as PostgreSQL parity; CI supplies a real
PostgreSQL 16 service. The coordinated-import suite injects a failure at every
checkpoint (`onCheckpoint`), proves both stores return to their exact previous
state, and covers interrupted-import recovery after a simulated restart. The
SQLite export test proves a backup cannot combine chat and drafts from
different points in time by committing a write from a second connection between
the two halves of an in-flight export.

Playwright (`playwright.config.ts`, `tests/e2e/studio-smoke.spec.ts`) drives a
real production build on a throwaway SQLite database, in a desktop Chromium
project and an iPhone 13 project. It signs in with a genuine encrypted session
cookie minted from the server's own `SESSION_SECRET`; no production code path is
weakened for tests. The production Dockerfile installs no browser binaries.

### Deferred

Uploads and object storage, repository generation, sandboxed builds, preview
deployments, admin roles, e-commerce, payments, and template versioning all
remain unimplemented.

## Data Bundles — Stage 4: bundle delivery engine

Stage 3 made a paid bundle order possible; Stage 4 delivers it. The engine
(`src/lib/studio/bundle-delivery.ts`) turns every purchased bundle UNIT of a
**paid** order into one delivery row and asks a provider to top up the
recipient. Only `data-bundles` websites are involved; every other website
type is untouched.

### Flow

1. Checkout snapshots the line's bundle metadata (`network`, `dataMb`,
   `validity`) into `studio_orders.lines_json`, so a later catalogue edit can
   never change what a paid order owes the customer. Orders paid before
   Stage 4 have no snapshot and resolve against the live catalogue instead.
2. **Live-money guard.** Checkout refuses a data-bundles order stamped `live`
   with 409 (`"This shop cannot send bundles automatically yet…"`) _before any
   order row exists_ while no live delivery provider is connected — a customer
   who paid real money must never be owed data the simulator only pretended
   to send. The engine keeps the same rule as a backstop: a live order with a
   non-live provider produces failed rows reading "No real delivery provider
   is connected; nothing was sent", with zero provider calls.
3. The payments webhook calls `dispatchBundleDeliveriesForOrder(orderId)`
   **fire-and-forget** right after it moves an order to `paid`: the payment
   answer is already committed, so a slow or broken provider can never delay
   or break the webhook's 200. Duplicate webhooks re-enter safely.
4. `recheckBundleDeliveriesForOrder(orderId)` runs on order-page loads
   (owner order page and guest confirmation page). It creates rows the
   webhook could not create (recovery after an outage), flushes rows stuck at
   `pending`, and polls the provider for rows at `processing`. It never
   throws, so a page renders with or without the engine.
5. The owner's `/studio/orders/[id]` page shows a **Bundle delivery** panel
   (full recipient, per-row status, unit numbers, attempts, provider
   reference, last error) with a **Retry** action for failed top-ups, routed
   to `POST /api/studio/orders/[id]/bundle-deliveries/retry`.
6. The unauthenticated confirmation page shows one **masked aggregate line**
   ("3GB of data to 024 ••• 0001 — …") — never a full number, provider
   reference, attempt count or error detail.
7. When at least one row **enters `failed` during an engine pass** (dispatch
   failure, provider-reported failure on recheck, or a failed retry), the
   merchant gets ONE aggregated alert
   (`notifyMerchantDeliveryFailed`, same discipline as the new-order alert):
   "n of total bundle top-ups failed for order <ref> (<network> <size> to
   <full recipient>). Retry from Studio → Orders." Rows that were already
   failed are never re-alerted.

### Invariants (each has a dedicated test)

- **I1 paid-first + live-money safety** — no delivery row exists and the
  provider is never called before the order is paid; a live-money order is
  only ever dispatched through a live provider (checkout 409, engine
  backstop).
- **I2 idempotent, also under concurrency** — exactly one row per purchased
  bundle unit via the unique `(order_id, line_index, unit_index)` index, and
  **claim-before-send**: `claimForDispatch` moves `pending|failed →
processing` atomically, so a webhook dispatch and a simultaneous page-load
  recheck (or two retries) can never send the same unit twice. Per-unit rows
  also mean partial delivery inside a line is trackable and a Retry never
  resends units that already went through.
- **I3 terminal success** — `delivered` is final; rechecks, retries, claims
  and provider callbacks never move or double-send a delivered row.
- **I4 isolated failure** — provider failures land on the row (`failed` +
  owner-readable error + one aggregated merchant alert) and are never thrown
  into the caller; only `failed` rows can be retried, and only by the owner.
- **I5 bundle-only** — deliveries exist only for data-bundles orders; other
  website types get no rows, no provider calls, no UI changes, no alerts.
- **I6 guest privacy** — unauthenticated surfaces see only the masked
  aggregate line.

### Providers

`BundleDeliveryProvider` (`sendBundle` + `checkStatus`) is selected by
`BUNDLE_DELIVERY_PROVIDER`:

- `simulator` (default): accepts every top-up as `processing` and reports it
  `delivered` on the next status check — the offline rehearsal of the whole
  lifecycle, mirroring the payment simulator. Rehearsal hooks: a recipient
  ending `0000` always fails (`"Simulated failure (test number ending
0000)"`), one ending `9999` stays `processing` for 60 s (the acceptance
  time travels inside the `sim-slow-<epochMs>-<uuid>` reference, so no
  in-memory state survives a restart).
- `techchief`: the real provider (Stage 5). It is **not** selected by the
  environment variable any more: it is constructed per order from the
  website's own stored connection (see the next section), because the key is
  the merchant's, not the server's.
- any other value fails closed (`MisconfiguredDeliveryProvider`), so a typo
  can never silently activate the simulator in production.

`bundleDeliveryAvailability()` reports the **server default** `{ provider,
live }` — every value it can return is `live: false`. Whether one particular
website may take real money for bundles is answered per draft by
`bundleDeliveryAvailabilityForDraft(draftId)`, which is `live: true` only when
that draft's own TechChief connection is `verified`. Checkout uses the
per-draft answer, never the server default.

### Persistence

`studio_deliveries` (migration `0012_studio_deliveries`, SQLite
`ensureBundleDeliveriesSchema` beside the orders schema) stores the snapshot
(`line_index`, `unit_index`, item id/name, network, size, validity, full
recipient — server side only) plus engine state (`provider`, `status`,
`attempts`, `provider_ref`, `last_error`, `delivered_at`). Every state change
is a guarded single statement: `claimForDispatch` (`pending|failed →
processing`, `attempts + 1`, atomic — returns true only for the one caller
that moved the row), `setProviderRef` (`processing` only), `markFailed`
(pending/processing/failed, error refreshed in place), `markDelivered`
(`pending|processing` only), so an ill-timed callback, recheck or retry can
never resurrect or double-send a row.

## Data Bundles — Stage 5: per-website TechChief connection

Stage 4 built the engine and deliberately left the real provider empty. Stage
5 fills it in, and the one design decision that shapes everything else is
**whose key it is**: the TechChief API key belongs to the merchant, is paid
for from the merchant's own wallet, and is therefore stored **per website**,
never as a server-wide setting. Two shops on one Valmont deployment send
through two different TechChief accounts and cannot see or spend each other's
float.

### Modules

- `src/lib/studio/techchief.ts` — the HTTP client and nothing else. Typed
  calls to `POST dev_order.php`, `GET dev_bundles.php`, `GET dev_status.php`
  and `GET dev_wallet.php` under `https://techchiefxdata.com/api/`, each with
  a 15 s `AbortController` timeout, `X-API-Key` auth, and a `TechChiefResult<T>`
  that classifies every failure (`rejected`, `unreachable`, `timeout`,
  `invalid`, `budget`) instead of throwing. Also owns the two mappings the
  rest of the code depends on: canonical network id → TechChief network name
  (`mtn → MTN`, `telecel → Telecel`, `airteltigo → AirtelTigo`) and phone
  normalization to Ghana `0xxxxxxxxx`, plus `matchTechChiefBundle`
  (`Math.round(sizeGb * 1024) === dataMb`, with a `* 1000` fallback).
- `src/lib/studio/integrations.ts` — the connection store and service layer:
  encryption, verification, the hourly request budget, the cached price list,
  and the owner-facing `TechChiefConnectionView`.
- `src/lib/studio/techchief-routes.ts` — the shared preamble for the four
  connection routes (authenticate → CSRF on mutations → owner rate limit →
  owner-scoped draft read), so a new route cannot forget one of them.
- `src/app/api/bundle-delivery/techchief/webhook/route.ts` — the callback.
- `src/components/studio/techchief-connection.tsx` — the **Bundle delivery**
  card on the draft page.

### Persistence

`studio_integrations` (migration `0014_studio_integrations`) holds one row per
`(draft_id, provider)` — a **unique index**, so "one connection per website" is
a database rule rather than an application hope. Columns: `api_key_enc` (the
AES-256-GCM envelope), `key_prefix` (nine characters, `TCHX-9F8E` — the only
part anybody ever sees again), `webhook_secret_enc`, `status`
(`unverified|verified|error`), `wallet_balance` `numeric(12,2)`, `low_balance`,
`account_status`, `last_error`, `bundles_json` (the cached wholesale price
list), `bundles_synced_at`, `poll_window_start` + `poll_count` (the hourly
budget), and timestamps. Foreign keys to `studio_drafts` and `users` are
`ON DELETE CASCADE`, so deleting a website takes its encrypted key with it; the
SQLite store has no foreign keys and therefore deletes integrations explicitly
in `SqliteStudioDraftStore.delete`. The same migration adds
`studio_deliveries_provider_ref_idx` — the webhook's lookup path.

### Connecting (PUT)

`connectTechChief` is **probe before store**: the key format is checked
(`^TCHX-`), the wallet endpoint is called, and the connection is only written
when TechChief answers `apiActivated: true` and `accountStatus: "active"`. A
rejected key, an unactivated key, a suspended account or an unreachable API all
leave **nothing stored** — so a typo can never produce a "connected" shop that
cannot actually send, and a previous good key is never overwritten by a bad
one. On success the price list is synced best-effort: a failed sync does not
downgrade a verified key, because the cached list is an optimisation and the
order call is authoritative.

### Provider selection

`resolveProviderForOrder(order)` decides per order, not per deployment:

| order                 | connection                   | provider                                                                                                   |
| --------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `paymentMode: "test"` | any, including verified      | `getBundleDeliveryProvider()` — **the simulator. TechChief is never called.**                              |
| `paymentMode: "live"` | `verified` + decryptable key | `TechChiefProvider` built from that website's own key                                                      |
| `paymentMode: "live"` | anything else                | `getBundleDeliveryProvider()`, whose `live: false` makes the engine's Stage 4 backstop fail the row loudly |

The first row is the invariant worth restating: **a test-mode order never
touches TechChief even when a real key is saved.** Test numbers keep rehearsing
against the simulator, and a merchant testing their shop cannot spend real
float by accident.

`TechChiefProvider` keeps its config in ECMAScript private fields (`#config`),
not TypeScript `private`: TypeScript's are still enumerable own properties, so
`JSON.stringify(provider)` in a debug log would have printed the key.
An unknown outcome — a timeout, a 5xx, a dropped connection — is reported as
`{ status: "unknown" }` and the row is marked `failed` with _"check your
TechChief dashboard before retrying"_. It is **never** resent automatically:
the top-up may already have been sent, and a guess that turns into a second
order spends the merchant's money twice.

### The hourly budget

TechChief allows 60 requests an hour per key. Polling is capped at
`TECHCHIEF_HOURLY_POLL_BUDGET = 50`, tracked in the database
(`poll_window_start`, `poll_count`) so it survives a restart and is shared by
every worker. Status polls, balance checks and price-list syncs stop at 50;
**orders use the remaining headroom and are never refused by the budget** —
spending the last of the allowance on a curiosity poll while a paying customer
waits would be the wrong trade. The budget is per connection, i.e. per website,
so one busy shop cannot starve another.

Polling is throttled per row as well: a `processing` row is asked about at most
once every 10 minutes (24 h-old rows, 6 h), gated on `updated_at`. Because a
throttled skip must not look like a fresh answer, `checkStatus` returns
`{ status, polled }` and the engine calls `touchProcessing()` only when a real
request was made — the heartbeat that keeps the throttle honest.

### The webhook

`POST /api/bundle-delivery/techchief/webhook?integration=<uuid>` is the only
unauthenticated write path in Stage 5, so it is narrow:

- With a stored signing secret, the body's hex HMAC-SHA256 must match
  `X-TechChiefX-Signature` (constant-time compare). A signature that matches is
  trusted for the status only — **all amounts, references and phone numbers are
  re-read from the database**, never from the payload.
- Without a secret, the callback is treated as a _hint_: the delivery is looked
  up by `provider_ref`, and the status is confirmed against `dev_status.php`
  inside a 6 s deadline before anything is written.
- Either way the row's order must belong to the integration that was called
  back, so a reference guessed for one shop cannot move another shop's row, and
  a `delivered` row never changes (I3). The route answers 200 quickly and does
  its database work only — no provider calls on the signed path.

### Owner-facing alerts

Two merchant emails: a delivery failure (Stage 4's aggregated alert) and a
**wallet too low** alert when TechChief answers 402 or reports
`lowBalance: true`. Both can legitimately fire for the same event, so tests
filter by subject rather than counting emails.

## Data Bundles — Stage 6a: commercial packages + manual delivery (Starter)

Stage 6 sells each data-bundles website under one of three **packages**
(`src/lib/studio/plans.ts`): Starter Shop, Auto-Dispatch Pro, Command Center.
The agency picks the package in the wizard; the owner never can; prices are
labels only. `plan` lives on the brief
(`z.enum(PLAN_IDS).default("auto_dispatch")`), so a brief saved before Stage 6
— or read raw from the database, where rows are normalised but never
re-parsed — resolves to Auto-Dispatch Pro through the defensive `planOf()`
reader. That default is the whole compatibility story: it is the exact
feature set pre-package shops already had, which is why no existing test
changes. `planAllows(plan, feature)` is the single server-side gate; the
refusal answer is 403 "Not included in your package." Every gate sits behind
`category === "data-bundles"` first: for every other website type the plan is
ignored everywhere it is read.

### The manual provider

A Starter package includes the shop and checkout but not the supplier API, so
`resolveProviderForOrder` gained a decision that runs **before the payment
mode and before any TechChief key**: a Starter website resolves to
`ManualProvider` for BOTH payment modes. The engine still creates one
delivery row per purchased bundle unit exactly as before — the customer sees
progress, the merchant alert fires — but rows are born `provider = "manual"`,
`status = "pending"`, with no provider reference and no external call. They
wait for a human (Stage 6c adds the marking buttons).

### The two engine guards

Two places in the engine would happily destroy manual rows if left unaware of
them; both read a `manual` flag on the provider contract:

- **Guard a — never claim a manual row.** `dispatchPendingRows` used to claim
  EVERY pending row (`claimForDispatch`: pending → processing) and send it
  through `ctx.provider`. A manual row must be skipped BEFORE the claim, or a
  dispatch pass would drag it to "processing" and then fail it through a
  provider that was never supposed to see it. The skip is on the row's
  provider id, so it also protects manual rows left behind after a package
  switch.
- **Guard b — the live-money block exempts manual.** `passContext` computes
  `liveBlocked` for live orders without a live provider; a ManualProvider is
  `live: false` (it moves no data) yet it is exactly what a live Starter order
  is supposed to dispatch through. Without the exemption every live Starter
  order would arrive with all rows failed as
  `NO_LIVE_DELIVERY_PROVIDER_MESSAGE` — the opposite of the package's promise.

`refreshProcessingRows` needed no change: manual rows are never claimed, so
they never sit at "processing" and hold no provider reference to poll.
`ManualProvider.sendBundle` always answers not-ok ("This shop sends bundles
by hand."), so even a stray Retry can never fabricate a send, and
`checkStatus` is never reached. Recheck passes therefore spend no TechChief
budget on Starter websites at all.

### What each surface shows

- **Checkout** asks `bundleDeliveryAvailabilityForDraft`, which reads the
  website's own brief: Starter answers `{ provider: "manual", live: false,
manual: true, plan: "starter" }` and the 409
  "This shop cannot send bundles automatically yet…" fires only when
  `!live && !manual`. The automatic branch keeps returning the exact two-field
  answer `{ provider, live }` it always did.
- **Readiness v2** (`bundleDeliveryDependency`) takes the plan as an optional
  third argument: a Starter bundle shop is satisfied with no connection —
  "Manual delivery (Starter Shop): you send bundles yourself." — while
  payments still block on their own.
- **The guest/customer line** for pending manual rows reads "The shop will
  send your bundle to 024 ••• 0001 by hand. Contact the shop if it does not
  arrive." (masked as always; delivered/failed wording unchanged).
  `guestBundleDeliverySummary`'s input Pick widened additively with
  `provider` to tell the two kinds apart.
- **Studio order panel** shows the package badge ("Starter Shop · Manual
  delivery") and labels pending manual rows "To send by hand"
  (`deliveryStatusLabel`).
- **The TechChief card** is hidden on Starter and replaced by a note pointing
  at the package; the connection is not even fetched, and a stored key is
  kept but never used while the package is Starter.

## Data Bundles — Stage 6b: the shop owner's login, team and read-only dashboard

Stage 6b adds a **third side** to the product. Until now there were two kinds
of signed-in person — the agency user in Studio (`valmont_session`, GitHub
OAuth, `src/lib/auth.ts`) and a buyer with a customer account on one
storefront (`valmont_customer_session`, `src/lib/customer-auth.ts`). The shop
owner is neither: they must see their own orders without ever entering Studio
and without the agency's rights. So the shop admin side is built as its own
thing, and the rule that the three sides never mix is structural, not
editorial:

| concern      | Studio              | customer account           | **shop admin**                                           |
| ------------ | ------------------- | -------------------------- | -------------------------------------------------------- |
| pages        | `/studio/*`         | `/account/*`               | `/manage/[id]/*`                                         |
| API          | `/api/studio/*`     | `/api/account/*`           | `/api/manage/[id]/*`                                     |
| tables       | `users`, `studio_*` | `studio_customer_*`        | `studio_shop_admins`, `_sessions`, `_tokens`             |
| cookie       | `valmont_session`   | `valmont_customer_session` | `valmont_shop_session`                                   |
| layout       | `AppShell` + nav    | storefront chrome          | own layout: shop name, package badge, Orders/Team/Logout |
| session code | `src/lib/auth.ts`   | `src/lib/customer-auth.ts` | `src/lib/shop-admin/auth.ts`                             |

`src/lib/shop-admin/boundary.test.ts` walks every file under the admin side
and fails if one imports `@/lib/auth`, `@/lib/customer-auth`, the customer
account store or `AppShell`, and if the storefront ever links to `/manage/`.
The only file in `src/lib/shop-admin/` allowed to touch the agency session is
`studio-routes.ts`, which is the guard for the **Studio-side** routes — it
belongs to the agency by design.

### Data (`0015_shop_admins`)

Three tables, all cascading from `studio_drafts` so deleting a website takes
its logins, sessions and links with it (the SQLite store deletes them
explicitly from `draft-store.ts`'s `delete`, via a dynamic import so the
draft store gains no static dependency on the module):

- `studio_shop_admins` — one row per login: `draft_id`, `email` (normalised,
  `UNIQUE (draft_id, email)` — the same address may own two different shops),
  `name`, `role` (`owner` | `member`), `permissions` (JSON array, allow-listed
  on write and on read), `password_hash` (scrypt, nullable until the invite is
  accepted), `status` (`invited` | `active` | `disabled`), `invited_by` (the
  agency user id for the owner, the owner's admin id for members),
  `last_login_at`.
- `studio_shop_admin_sessions` — `token_hash` (SHA-256 of the cookie value,
  primary key), `admin_id`, `draft_id` (denormalised so a session can be
  matched to a shop without a join), `expires_at`.
- `studio_shop_admin_tokens` — one-time links: `token_hash`, `admin_id`,
  `purpose` (`invite` | `reset`), `expires_at`, `used_at`.

Passwords and tokens reuse `src/lib/customer-password.ts` by import
(`hashCustomerPassword`, `verifyCustomerPassword`,
`DUMMY_CUSTOMER_PASSWORD_HASH`, `hashCustomerToken`, `createCustomerToken`,
`normalizeCustomerEmail`) — the file was not moved or renamed. The raw token
is returned exactly once from `createOwnerInvite` / `createMemberInvite` /
`createResetToken`; nothing but its hash is ever stored, so a database read
cannot mint a link. These tables are **not** in the backup export
(`buildBackup` has no generic table dump, so absence is by construction) and
a crafted `shopAdmins` section in an import file is ignored
(`backup-exclusion.test.ts`).

### `src/lib/shop-admin/`

- `permissions.ts` — the four boxes (`orders.fulfil`, `bundles.manage`,
  `supplier.manage`, `reports.view`), `parsePermissions` (drops anything not
  on the list, including the reserved `wallets.topup` that Stage 7 will
  add), `can(admin, permission)` (the owner passes everything),
  `MAX_SHOP_LOGINS_PER_WEBSITE = 10`.
- `store.ts` — `SqliteShopAdminStore` / `PostgresShopAdminStore` behind
  `getShopAdminStore()`. Invites are single-use and expire after 24 h, reset
  links after 1 h, sessions after 30 days; `verifyPassword` runs the dummy
  hash for an unknown email, a disabled login and a login with no password
  yet, so every failure costs the same time; `setStatus("disabled")` revokes
  every session in the same call; `purgeExpired` runs opportunistically
  (about once an hour, on `createSession` — `PURGE_INTERVAL_MS` is 60
  minutes) and removes expired and used tokens plus expired sessions.
- `auth.ts` — the cookie (`httpOnly`, `SameSite=Lax`, `Secure` outside
  development, `path=/`, 30 days) and three readers: `getShopAdminSession`
  (server components), `requireShopAdminSession` (redirects to
  `/manage/[id]/login?next=…`; `next` is accepted only when it stays inside
  this shop's own `/manage/[id]/` tree) and `requireShopAdminApi` (401 with
  no session, **404** when the session belongs to a different shop — the
  same answer an unknown shop gives, so an admin of A cannot enumerate B).
- `email.ts` — `deliverShopAdminLink`: sends through `sendCustomerEmail`
  when Resend is configured and returns `{ delivered: true }`; otherwise
  `{ delivered: false, link }`. Only the **Studio** routes ever put that
  `link` in a response; the shop-side team routes drop it and tell the owner
  to ask the agency.
- `rate-limit.ts` — `assertHourlyRateLimit`, a thin wrapper over the same
  `checkRateLimit` bucket store for the per-hour limits.
- `studio-routes.ts` — `requireShopAdminsDraftAccess`: CSRF, agency session,
  `canonicalUserId`, draft ownership (another agency user's draft is a 404),
  `assertOwnerRateLimit("shop-admins", ownerId, 30)`.

### Routes

**Studio side** (`/api/studio/drafts/[id]/shop-admins`, agency session):
`GET` lists logins (never hashes) plus `emailConfigured`; `POST` invites the
owner (409 once one exists); `[adminId]` `PATCH { status }`;
`[adminId]/resend` re-mints an invite (409 once accepted);
`[adminId]/reset-link` mints a reset link for an active login (409
otherwise). The card `src/components/studio/shop-logins.tsx` is mounted in
the wizard for every data-bundles website regardless of package, directly
under the TechChief card — a Starter owner needs the dashboard most, since
they deliver by hand.

**Shop side** (`/api/manage/[id]/…`, shop session): `auth/login` (identical
401 for every failure, `assertCustomerRateLimit(…, "shop-login", email, 10)`
plus 30/min per IP), `auth/logout`, `auth/accept-invite` and
`auth/reset-password` (10/min per IP; a reset revokes all sessions),
`auth/forgot-password` (always `200 "If that email exists, we sent a link."`,
5/h per email; never returns a link), `team` (`GET` any admin, `POST` owner
only, cap 10 ⇒ 409), `team/[adminId]` (`PATCH { permissions?, status? }`,
owner only, the owner row itself ⇒ 403 — no delete, a login is disabled
instead so its audit trail survives), `team/[adminId]/resend`. Every route:
`assertCsrf`, `readBoundedJson` (16 KB), zod, `safeApiError`, typed errors
from `src/lib/api-errors.ts` (`Shop*`).

### Pages (`src/app/manage/[id]/`)

`layout.tsx` resolves the website through `publicGetDraft` (unknown ⇒ 404),
prints the shop name and `PLAN_LABELS[planOf(brief)]` — with " · Manual
delivery" on Starter — and shows Orders / Team (owner only) / Logout when a
session exists; it renders no `AppShell` and no agency navigation. The orders
list reads `getOrdersStore().listForOwner(publicGetDraftOwnerId(id), {
draftId: id, filter, limit })` — `draftId` is **always** passed, because the
agency user usually owns several websites and the owner of one must never
see another's. The detail page uses `getForOwner(ownerId, orderId)` and then
checks `order.draftId === id`, so an order of a sibling website with the same
agency owner is a 404. The page shows the recipient number in full (unlike
the masked guest/customer views), every line through `bundleNetworkLabel` +
`formatDataMb`, `STATUS_LABELS`, and delivery rows through the same
`deliveryStatusLabel` Studio uses, plus the provider reference. It is
read-only: no transition buttons, no retry, no mark-as-sent — those are
Stage 6c. `team/page.tsx` calls `notFound()` for a member, so the page does
not exist as far as staff are concerned.

### What the owner can never see

The TechChief key beyond its nine-character prefix, the webhook secret, the
agency's payment settings, the package selector, other shops, and agency
user names. None of those flow into a shop-admin page or response; the layout
reads only `brief.businessName` and the plan.

## Data Bundles — Stage 6c: the shop admin's write actions

Stage 6b's dashboard was deliberately read-only; 6c adds the writes, each
behind the permission boxes that already existed in `permissions.ts` (the
owner always passes; a member without the box gets 403
`ShopPermissionError` — "Your login does not include this action. Ask the
shop owner.") and, where stated, behind the package
(`planAllows` → 403 `PACKAGE_NOT_INCLUDED_MESSAGE`).

### Route preamble (same order everywhere)

`assertCsrf` → `requireShopAdminApi` (401 / 404) → permission (403) →
`assertHourlyRateLimit` keyed on the **website id** → `readBoundedJson`
(16 KB) → the order pin → the write or the engine. The pin
(`pinShopOrder` in `src/lib/shop-admin/order-access.ts`) resolves the order
exactly the 6b pages do — `publicGetDraftOwnerId(draftId)`, then
`getForOwner(ownerId, orderId)`, then `order.draftId === draftId` — BEFORE
any engine call, because `retryBundleDeliveryFailures` and
`recheckBundleDeliveriesForOrder` are owner/order-scoped, not shop-scoped.
A sibling website's order is a 404.

### Mark by hand — POST `/api/manage/[id]/orders/[orderId]/deliveries/[deliveryId]/mark`

Permission `orders.fulfil`; 60/h per website. Body
`{ status: "delivered" | "failed", note? ≤ 200 chars }`. The row must belong
to that order (404 otherwise). Allowed transitions ONLY:

| from                         | to "delivered"                                                | to "failed"                                                              |
| ---------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| pending + provider `manual`  | ✓                                                             | ✓ (note becomes `last_error`, default "Marked as not sent by the shop.") |
| failed (any provider)        | ✓ (settled out of band; provider, ref and attempts untouched) | 409 "already marked as failed"                                           |
| delivered                    | 409 "already delivered" (terminal, I3)                        | 409 "already delivered"                                                  |
| processing                   | 409 "being sent automatically - use Check status."            | same                                                                     |
| pending + automatic provider | 409 "queued for automatic sending - use Check status."        | same                                                                     |

Both writes are ONE atomic UPDATE each with the guards inside the WHERE
clause — the `claimForDispatch` pattern — implemented in
`src/lib/studio/manual-delivery.ts` (SQLite and PostgreSQL; the
`BundleDeliveriesStore` interface is NOT widened, an existing test
hand-implements it). Zero rows changed → the row is re-read and the matching
409 above is answered. Marking delivered sets `delivered_at`, clears
`last_error`, and leaves provider, `provider_ref` and attempts alone. No
merchant alert fires for either mark — the shop did it itself.

### Retry and Check status — POST `…/deliveries/retry` and `…/deliveries/recheck`

Both: permission `orders.fulfil`, ONE shared hourly bucket
(`shop-order-delivery`, 40/h per website) because both can spend the
website's TechChief allowance. Both read and ignore the body (the client
always sends `{}`). Retry calls the same `retryBundleDeliveryFailures` the
Studio owner's button calls — but first reads
`bundleDeliveryAvailabilityForDraft(draftId)`: a Starter shop is answered
409 "This shop sends bundles by hand - mark the top-up delivered instead."
and the engine is never called. Recheck runs
`recheckBundleDeliveriesForOrder(order.id)` and answers
`{ deliveries, checkedAt }`. The shop order page stays read-only on load —
no recheck, ever; the buttons are the only way to spend the allowance from
the shop side.

Every delivery that leaves any of these routes is narrowed through
`shopDeliveryView` (`src/lib/shop-admin/order-view.ts`): id, line/unit,
network, size, validity, recipient, provider, status, attempts, provider
reference, last error, delivered/updated timestamps — never `ownerId` (an
agency identifier), never the order's catalogue bookkeeping.

### Bundle pause and price edit — PATCH `/api/manage/[id]/bundles/[itemId]`

Permission `bundles.manage`; 60/h per website; data-bundles websites only
(any other category is a 404 — the route does not exist for them). Body
`{ paused?: boolean, price?: number | string }` (at least one, else 400).
Price goes through the exported `priceAmount` schema and must be > 0 (400);
it is allowed on every package. `paused` additionally requires
`planAllows(plan, "bundle_pause")` — Starter gets 403
"Not included in your package."

The write is one new draft-store method,
`patchCatalogueItemAsShop(draftId, itemId, patch)` (SQLite + PostgreSQL): it
reads the stored brief (normalised, so a pre-Phase-3 brief is not wiped),
changes ONLY that item's `price` and/or `paused`, re-validates the whole
brief with `siteBriefSchemaV1`, and saves with a compare-and-set on
`revision` (revision + 1, up to three attempts on a lost race). No
`SessionUser` is involved — the draft id is the scope. The response is a
projection of the catalogue (`shopCatalogueView` in
`src/lib/shop-admin/bundle-view.ts`): per item `{ id, name, network, dataMb,
validity, price, paused }` — never the brief, never payments, never
`adminEmail`.

`paused` is optional on `catalogItemSchema` with NO default, so an omitted
key stays distinguishable from `false`. The wizard save path
(`PATCH /api/studio/drafts/[id]`) carries the stored item's `paused` value
over whenever the incoming item has no key (matched by id), so an agency
autosave can never silently unpause a bundle the shop paused; an explicit
key wins, and the existing `expectedRevision` optimistic concurrency is
untouched. The wizard's bundle table shows a small "Paused by shop" badge.

### Storefront, checkout, guest line

- The public bundle list (`groupBundlesByNetwork`) never lists a paused
  item, so the storefront plus button cannot add it.
- Checkout refuses a paused item with 400 "This bundle is currently
  unavailable." inside the re-pricing loop — the same place the unknown-item
  409 lives — BEFORE any order row exists. Existing orders keep their
  snapshot prices.
- `guestBundleDeliverySummary` gained one branch, placed before the
  all-pending manual branch: some rows delivered, none failed, a manual row
  still pending → "1 of 2 top-ups delivered to 024 ••• 0001; the shop will
  send the rest by hand." (numbers and mask computed; every pre-6c sentence
  byte-identical).
- The Studio order page never renders the Retry button for a Starter shop;
  it renders "This shop sends bundles by hand - the shop owner marks
  delivery in the shop admin." instead.

### Pages

- The order page renders `DeliveryRowActions` (mark delivered / mark failed,
  note optional) inside a delivery row and `DeliveryOrderActions` (Retry
  failed top-ups — only when the website is NOT Starter and a failed row
  exists; Check status now — only while a processing row exists) under the
  list, only for a login with `orders.fulfil`. A member without the box sees
  exactly the 6b page. Test ids: `shop-mark-delivered`, `shop-mark-failed`,
  `shop-retry-deliveries`, `shop-recheck-deliveries`.
- `/manage/[id]/bundles` lists the shop's bundles with a price input + Save
  and a Pause / Resume toggle; on Starter the toggle is replaced by "Pause
  is part of Auto-Dispatch Pro." Test ids: `shop-bundle-row`,
  `shop-bundle-price`, `shop-bundle-save`, `shop-bundle-pause`. The layout
  nav shows "Bundles" only for `can(admin, "bundles.manage")`; the page is a
  404 without the box.

### Stage 6c rate limits (per website, per hour)

| action                        | bucket                | limit |
| ----------------------------- | --------------------- | ----- |
| mark delivered / failed       | `shop-delivery-mark`  | 60    |
| retry + check status (shared) | `shop-order-delivery` | 40    |
| bundle price / pause          | `shop-bundle-edit`    | 60    |

## Data Bundles — Stage 6d: supplier page + sales & margin dashboard

Stage 6d gives the shop the two Command Center surfaces the price sheet
advertises, and starts recording what each top-up actually cost the shop.

### Migration `0016` — the per-row supplier cost

`ALTER TABLE studio_deliveries ADD api_price numeric(12,2)` (nullable, no
default). The Drizzle field is `apiPrice: numeric("api_price", {precision:
12, scale: 2})`. The SQLite schema upgrade lives in
`ensureBundleDeliveriesSchema`: after `CREATE TABLE IF NOT EXISTS`, a PRAGMA
`table_info` check adds `api_price REAL` when the column is missing — the
same idempotent pattern `ensureOrdersSchema` uses, so an old file is upgraded
on the next store access without touching existing rows.

**Who gets a cost.** `BundleDeliveryRecord.apiPrice?: number` (PG `numeric`
arrives as a string and is converted with `Number`; null/undefined →
undefined). The ok branch of `BundleDeliverySendResult` carries an optional
`apiPrice`, and `TechChiefProvider.sendBundle` forwards the `api_price` named
in the `dev_order.php` answer — a missing price stays undefined, never
invented. The engine passes it through the optional third argument of
`setProviderRef(id, ref, meta?: { apiPrice?: number })` at dispatch AND at
retry. The `BundleDeliveriesStore` interface gains NO method (and the extra
parameter is optional), so hand-written test stores stay type-compatible.
Both real stores write `api_price` only when `meta.apiPrice` is a finite
number and otherwise leave the column untouched. Consequences, each pinned
by `delivery-api-price.test.ts`:

- the simulator and manual rows never carry a cost — no provider ever
  reports a price for them;
- a retry that really sends again overwrites the previous charge;
- a failure never clears a recorded price (the row may still have been
  charged before the timeout);
- rows delivered before migration `0016` have no cost — the report treats a
  missing cost as _unknown_, never as zero.

`shopDeliveryView` is unchanged — the shop's per-row view does not show
costs; the number exists for the report.

### The Supplier page and the refresh route

`/manage/[id]/supplier` renders for exactly: a signed-in shop admin holding
the `supplier.manage` box (the owner always passes; a member without it gets
the same 404 as a stranger), on a data-bundles website whose package
includes `supplier_page` (Auto-Dispatch Pro and Command Center — Starter's
404 matches its package). The page NEVER calls TechChief; it renders the
last stored state read through the no-secret `getTechChiefIntegration(id)`.

**The projection is the boundary.** `src/lib/shop-admin/supplier.ts` owns
every constant the page and route share (the TechChief portal URL, the
refresh operation name `shop-supplier-refresh`, 6/hour, the 10-minute
interval, and the exact not-connected / too-soon / low-balance / API
not-connected sentences) and `shopSupplierView(integration)`, which returns
exactly: `connected, status, keyPrefix, walletBalance, lowBalance,
accountStatus, lastCheckedAt, lastError, bundleCount, bundlesSyncedAt,
requestsThisHour, requestsPerHour`. There is deliberately no `webhookUrl`,
no `webhookSecretSet`, no `unmatchedItems`, no `ownerId` and no `id` — the
projection has nowhere to put them — and the only key material is the stored
9-character prefix, rendered `TCHX-AB12•••`. `supplier-view.test.ts` pins
the key set and that a serialised view never contains a longer key slice.

**POST `/api/manage/[id]/supplier/refresh`** reuses the 6c preamble (CSRF →
shop session 401 / other-shop 404 → `ShopPermissionError` 403 → hourly rate
limit → 16 KB bounded body) and then, in order: a non-bundle website → 404;
a package without `supplier_page` → 403 `PACKAGE_NOT_INCLUDED_MESSAGE`; no
key saved → 404 `{ supplier: connected:false, error: "This website has no
TechChief key saved yet." }` with ZERO TechChief calls; a last check younger
than `SHOP_SUPPLIER_REFRESH_MIN_INTERVAL_MS` → 429
`SUPPLIER_REFRESH_TOO_SOON_MESSAGE`, also with ZERO TechChief calls. Only
then does it call `testTechChiefConnection(id)` — the same library call
Studio's "Check balance" uses, which spends exactly one of the website's
TechChief budget slots and refreshes balance / low flag / status on the
stored row — and maps the outcome: ok → 200, rejected → 400, budget → 429,
unreachable → 502. Every answer from the integration onwards carries
`{ supplier: shopSupplierView(...) }` and the error answers add `{ error }`.
The shop rate-limit bucket:

| action           | bucket                  | limit                    |
| ---------------- | ----------------------- | ------------------------ |
| supplier refresh | `shop-supplier-refresh` | 6 per hour + 10-min rule |

The layout adds a "Supplier" nav link (`shop-admin-supplier-link`) under the
same two gates (box AND package), so a Starter owner never sees a link to a
page that does not exist.

### Sales & margin report (Command Center)

`/manage/[id]/reports` exists only for a login with the `reports.view` box on
a package with the `reports` feature — Command Center only — on a
data-bundles website. Ranges `today / 7d / 30d / month` (default 30d) resolve
to `created_at >= <UTC boundary>`: Ghana is UTC, so "today" and "this month"
run on UTC midnight / month start. Orders come from
`listForOwner(ownerId, { limit: 2000, filter: "all", draftId, createdAfter })`
— owner AND website pinned, a sibling website can never leak in. Delivery
rows are read by the reports module's own query in chunks of 500 order ids
(PG `inArray`, SQLite `IN`), chosen by `DATABASE_URL` exactly like
`manual-delivery.ts`; the `BundleDeliveriesStore` interface is not widened.

**`aggregateShopReport(orders, deliveries)` is pure** and every definition
below is unit-tested in `reports.test.ts`:

- A **sale** is an order with `paidAt` set, status not "refunded" and not
  "cancelled", payment mode "live". `orders` = sales count;
  `moneyCollected` = Σ `total` over sales. Paid TEST-mode orders are counted
  as `testOrdersExcluded` and never in money.
- Top-up counts run over the delivery rows of sales: `deliveredTopUps`,
  `failedTopUps`, `inFlightTopUps` (pending or processing).
- A row's unit price is its order line's checkout-time snapshot price
  (`lines[row.lineIndex].price`); 0 when the line is missing.
- **Costed** rows = delivered rows with a finite `api_price`. `supplierCost`
  = Σ `api_price` over costed rows. `costedRevenue` = Σ unit price over
  costed rows. `margin` = `costedRevenue` − `supplierCost`. `marginPercent`
  = margin ÷ costedRevenue × 100 (0 when costedRevenue is 0). Coverage =
  { known: costed count, delivered: delivered count }.
- `perNetwork` (mtn, telecel, airteltigo — only networks that delivered) and
  `perBundle` (grouped by itemName + network + dataMb, top 10 by delivered
  units) carry the same money columns per group: `deliveredUnits`, `revenue`
  (Σ unit price over the group's delivered rows), `cost`, `margin` (the
  group's costed revenue minus its cost), `costedUnits`.
- Refunded and cancelled orders are excluded everywhere; failed rows never
  count in revenue or cost. Money is in major units (GHS), rounded to 2
  decimals at the end. An empty period is all zeros.

The page renders only totals and the two money tables — no customer name,
phone number, order id or access code anywhere — with server-rendered range
links (`?range=…`), the four tiles, the cost-coverage sentence and the
test-orders note; the layout adds a "Reports" nav link
(`shop-admin-reports-link`) under the same two gates.

## Website Studio — Stage B: Brand Kit (no-brand clients)

Stage B gives the Studio wizard a Brand Kit for a client who arrives with no
brand at all: name ideas, a tagline, a colour palette, a simple text logo and
a one-page brand sheet. Everything is a **suggestion**; the only write paths
into the brief are the apply and logo routes, and both use the same
validated, optimistic-concurrency `store.update()` the wizard PATCH uses.

### Files and data flow

```
wizard step (business details, under the business-name field)
  └─ src/components/studio/brand-kit.tsx  (pure client; type-only imports)
       ├─ POST /api/studio/drafts/[id]/brand-kit/suggest
       │    → requireBrandKitDraftAccess (session → CSRF → owner 404 →
       │      package gate 403) → hourly suggest budget (10/h/owner,
       │      model calls cost money) → tryCreateModelProvider (null → 503)
       │    → src/lib/studio/brand-kit.ts  suggestBrandKit(input, provider)
       │      zod input → ONE structured model call (temperature 0.8,
       │      maxTokens 1200, 20 s AbortSignal) → protected-brand filter +
       │      dedupe → ONE re-ask only when fewer than 3 names survive →
       │      WCAG contrast fix per palette → { names[], palettes[] }
       ├─ POST .../brand-kit/apply   { name?, tagline?, palette? }
       │    → patches exactly businessName / tagline / selectedTheme /
       │      preferredColours and re-validates the whole brief
       ├─ GET  .../brand-kit/logo.svg?layout&name&primary&accent&surface
       │    → src/lib/studio/brand-logo.ts renderBrandLogo (deterministic
       │      SVG, Inter/Arial/sans-serif, every text escaped) for preview
       ├─ POST .../brand-kit/logo    { layout, palette, name, initials? }
       │    → renders the same SVG, rasterises ≤600×600 PNG with next/og
       │      (the opengraph-image library), validates it with the EXISTING
       │      validateUploadedImage/checkAssetBudget helpers, saves into
       │      brief.assets.logo
       └─ GET  .../brand-kit/sheet   → 1200×1600 brand sheet PNG via
            src/lib/studio/brand-sheet.tsx, no-store, never stored
```

The shared preamble lives in `src/lib/studio/brand-kit-routes.ts`
(`requireBrandKitDraftAccess`), mirroring the TechChief route guards — one
place that cannot be forgotten: another agency user's draft is the same 404
as a made-up id, and the package gate (`brandKitAllowed` in
`src/lib/studio/plans.ts`, wired through `planAllows(plan, "brand_kit")` plus
the brief's `brandKitAddon` tick) answers the standard 403 "Not included in
your package." before any money is spent.

### What the model receives

Exactly the four answers — `whatTheySell` (≤300 chars), `town` (≤60),
`feeling` (trusted/friendly/premium/young), `mustInclude` (≤3 words of ≤20
chars), plus the website `category` and a `language` that defaults to
`"en"`. **Never** API keys, orders, or any other draft: the prompt is built
from the validated input object alone (`brandKitMessages`), and the route
holds nothing else. Output is constrained by a JSON schema and re-validated
with zod; then the server — not the model — drops names that copy protected
brands (word-based so "AT" never blocks "Data", squashed so "MyMTNShop" is
caught), drops duplicates, fixes any text/surface pair below WCAG AA 4.5 to
#111827 or #FFFFFF, and computes the white-on-primary header check
(`readableTextOn`). Domain and social availability are **not** checked
online: the response carries `domainCandidates` (slug.com / slug.com.gh) and
`checkLinks` URLs the agency opens by hand.

### The text logo and the brand sheet

`renderBrandLogo` is pure string SVG: wordmark (name + accent dot), badge
(initials, 1–3 letters, in a rounded square on primary, name beside it) and
stacked (badge above the name). Same renderer serves the live preview
(`logo.svg`, owner-only, `no-store`) and, wrapped in an `<img>` inside
next/og's `ImageResponse`, the stored PNG — what the agency previews is what
gets stored. The sheet composes name, tagline, the brief's current colours
(`preferredColours`, else the theme's), the saved logo when present, the font
stack and "Made with Valmont - valmontweb.com" on a 1200×1600 canvas.

## Stage 7a — agent logins and wallet ledger

Stage 7a adds a fourth login kind under `/a/[shop-id]`, separate from agency
GitHub sessions, shop-admin logins, and customer accounts. A Command Center
shop has `studio_shop_agents`, agent sessions, one-time agent tokens,
`studio_shop_wallet_entries`, and `studio_shop_agent_settings`. Agent
passwords and tokens are stored only as hashes.

The wallet is an append-only ledger. L1 says every balance change is exactly
one entry and the stored balance equals that entry's `balance_after`; L2 keeps
the balance non-negative; L3 exposes no entry update or delete operation; L4
allows only the shop owner to write credit or deduct entries; and L5 limits
entries to integer minor units from one pesewa through GH₵5,000. The gate is
`category === "data-bundles"` plus `planAllows(plan, "wallets")`.

## Stage 7b — agent wallet checkout, agent orders, refund to wallet

Stage 7b lets the agent spend from the wallet, offline from the public
checkout. `POST /api/a/[shop-id]/orders` follows the public checkout's
refusals in order, then: merges duplicate lines, re-prices from the server's
catalogue copy at the shop's agent discount (R1 — the browser only sends
item ids, quantities and the recipient number), applies the bundle caps,
re-reads the FRESH agent row for the balance (R2 — never the session), and
stamps `paymentMode` from `onlinePaymentAvailability()` with the same live
guard (needs `live` delivery or manual hand-delivery) as checkout. Every
refusal lands before any order row exists (R5).

Money moves only through two ledger methods added in Stage 7b:
`purchase({agentId, orderId, amountMinor, createdBy})` is THE way checkout
money leaves a wallet (R3): a single transaction checks the idempotency key
(a purchase entry already exists for this order → return it, change
nothing), debits with a conditional `balance_minor >= amount` UPDATE so a
race can never overdraw, and appends one `purchase` entry. `refund(...)` is
THE way money is returned (R8): same shape, positive amount, once per order
— a second refund raises `WalletAlreadyRefundedError` (409), and a raced one
loses to partial unique indexes on `studio_shop_wallet_entries(order_id)`
split by kind. Two new classes live in `src/lib/api-errors.ts`:
`WalletAlreadyRefundedError` and `AgentOrderNotRefundableError`.

The order carries `paymentMethod = "agent_wallet"` (deliberately NOT in
`PAYMENT_METHODS`, so it is never selectable in Studio → Payments or on the
public storefront, R7), a nullable `agent_id` text column (migration
`0018_agent_orders`, mirrored by `ensureColumn`/`ensureShopAgentSchema` for
SQLite), and a server-generated 32-hex access code the agent never sees (R9,
no payment link). It is marked paid — via `OrdersStore.markPaid` only, so
`paidAt` is set and the transitions stay honest (R4) — through
`settleAgentOrder(order)` in `src/lib/shop-agent/orders.ts`: when an order
is wallet-paid, still `pending`/`payment_failed`, and HAS its purchase
entry, the wallet demonstrably paid and the crash window between debit and
mark gets closed idempotently; the agent order page and the admin order page
call it on load, before the same `recheckBundleDeliveriesForOrder` pass the
guest confirmation uses. Dispatch is awaited inside a swallow (the real
engine: simulator in test mode; the shop's own verified TechChief key, or
manual rows on Starter) — a top-up problem never unsettles a paid order; the
owner's Retry and Refund cover it.

Agent surface: an **Orders** nav link, `/a/[shop-id]/orders` (newest first),
and `/a/[shop-id]/orders/[orderId]`, scoped by `agent_id` in the store
itself — another agent's order id is a plain 404 and no entry point returns
the access code (R9). The wallet statement reads `Purchase - Order
xxxxxxxx` / `Refund - Order xxxxxxxxx` with links into those pages.

Owner surface: an **Agent** badge on wallet-paid rows of `/manage/[id]`,
"Paid from agent wallet - name" with a link to the agent (owner-only, since
agents pages are owner-only), the method label `Agent wallet` from
`paymentMethodLabel` in `src/lib/shop-admin/order-view.ts` (used there, on
the agent statement page, and in the Studio order view), and **Refund to
wallet** (`POST /api/manage/[id]/orders/[orderId]/refund-wallet`): owner
role only — a member with every permission box ticked still gets
`ShopOwnerOnlyError` (403) — partial-unique once-per-order credit through
`refund(...)`, then `updateStatus → refunded`. The merchant alert e-mail
gains exactly one line, "Paid from agent wallet", only for these orders.
