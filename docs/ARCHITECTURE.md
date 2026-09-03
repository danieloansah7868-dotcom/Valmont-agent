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

`PostgresTaskStore` is selected automatically when `DATABASE_URL` is configured and enforces session ownership in every task query. It hydrates normalized event, approval, tool, and pull-request records. Raw repository content and assembled model prompts are not stored in these tables. Account token ciphertext is explicitly server-only. The task JSON fallback uses `.data/task-store.json`, atomic rename writes, and a process-local serialization queue; it starts empty and is never seeded with fixtures.

`CustomerAccountStore` uses the same automatic SQLite/PostgreSQL selection as Studio orders. Customer email addresses are normalized, passwords are stored as parameterized scrypt hashes, session/token values are stored only as SHA-256 hashes, and customer order queries always filter by the authenticated customer account id. The feature is an owner opt-in per website (`brief.features.customerAccounts`, default off): the storefront account link, checkout auto-linking, order claiming, and `/account` order visibility are all gated on it. The Studio backup v2 `customers` section exports these tables (hashes only — password scrypt envelopes and SHA-256 token digests, never plaintext or payment credentials), and the restore path inserts with or-ignore semantics inside the existing single-transaction (SQLite) or fenced-coordinator (PostgreSQL) import, so a restore never overwrites an existing account.

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
(`src/lib/studio/bundle-delivery.ts`) turns each bundle line of a **paid**
order into one delivery row and asks a provider to top up the recipient. Only
`data-bundles` websites are involved; every other website type is untouched.

### Flow

1. Checkout snapshots the line's bundle metadata (`network`, `dataMb`,
   `validity`) into `studio_orders.lines_json`, so a later catalogue edit can
   never change what a paid order owes the customer. Orders paid before
   Stage 4 have no snapshot and resolve against the live catalogue instead.
2. The payments webhook calls `dispatchBundleDeliveriesForOrder(orderId)`
   **fire-and-forget** right after it moves an order to `paid`: the payment
   answer is already committed, so a slow or broken provider can never delay
   or break the webhook's 200. Duplicate webhooks re-enter safely.
3. `recheckBundleDeliveriesForOrder(orderId)` runs on order-page loads
   (owner order page and guest confirmation page). It creates rows the
   webhook could not create (recovery after an outage), flushes rows stuck at
   `pending`, and polls the provider for rows at `processing`. It never
   throws, so a page renders with or without the engine.
4. The owner's `/studio/orders/[id]` page shows a **Bundle delivery** panel
   (full recipient, per-row status, attempts, provider reference, last
   error) with a **Retry** action for failed top-ups, routed to
   `POST /api/studio/orders/[id]/bundle-deliveries/retry`.
5. The unauthenticated confirmation page shows one **masked aggregate line**
   ("3GB of data to 024 ••• 0001 — …") — never a full number, provider
   reference, attempt count or error detail.

### Invariants (each has a dedicated test)

- **I1 paid-first** — no delivery row exists and the provider is never called
  before the order is paid.
- **I2 idempotent** — exactly one row per paid bundle line, enforced by the
  unique `(order_id, item_id)` index; replays and rechecks re-run safely.
- **I3 terminal success** — `delivered` is final; rechecks, retries and
  provider callbacks never move or double-send a delivered row.
- **I4 isolated failure** — provider failures land on the row (`failed` +
  owner-readable error) and are never thrown into the caller; only `failed`
  rows can be retried, and only by the owner.
- **I5 bundle-only** — deliveries exist only for data-bundles orders; other
  website types get no rows, no provider calls, no UI changes.
- **I6 guest privacy** — unauthenticated surfaces see only the masked
  aggregate line.

### Providers

`BundleDeliveryProvider` (`sendBundle` + `checkStatus`) is selected by
`BUNDLE_DELIVERY_PROVIDER`:

- `simulator` (default): accepts every top-up as `processing` and reports it
  `delivered` on the next status check — the offline rehearsal of the whole
  lifecycle, mirroring the payment simulator.
- `techchief`: a stub. The Stage 5 integration document (API spec, auth,
  pricing, callback format) has not landed, so every send fails fast with an
  owner-visible, retryable error instead of fabricating deliveries.
- any other value fails closed (`MisconfiguredDeliveryProvider`), so a typo
  can never silently activate the simulator in production.

### Persistence

`studio_deliveries` (migration `0012_studio_deliveries`, SQLite
`ensureBundleDeliveriesSchema` beside the orders schema) stores the snapshot
(item id/name, network, size, validity, quantity, full recipient — server
side only) plus engine state (`provider`, `status`, `attempts`,
`provider_ref`, `last_error`, `delivered_at`). Status transitions are guarded
at the statement level (`pending|failed → processing`, `→ failed`,
`pending|processing → delivered`), so an ill-timed callback or retry can
never resurrect or double-send a row.
