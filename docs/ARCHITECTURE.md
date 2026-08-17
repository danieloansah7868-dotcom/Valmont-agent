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
- repository connections
- coding tasks and task events
- approvals
- workspaces
- model/tool executions
- pull request records

`PostgresTaskStore` is selected automatically when `DATABASE_URL` is configured and enforces session ownership in every task query. It hydrates normalized event, approval, tool, and pull-request records. Raw repository content and assembled model prompts are not stored in these tables. Account token ciphertext is explicitly server-only. The task JSON fallback uses `.data/task-store.json`, atomic rename writes, and a process-local serialization queue; it starts empty and is never seeded with fixtures.

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

Phase 1 provides category/package/theme/template registries, SiteBrief v1 with Ghana defaults (country Ghana, currency GHS, timezone Africa/Accra, +233, regions, plannedPaymentMethods typed future-only), shared SQLite file (same as Chat, derived via deriveSqliteChatStorePath, assertDistinctStorePaths safety), PostgreSQL studio_drafts table via Drizzle migration 0002, atomic revision concurrency (WHERE revision RETURNING), Brief completeness derived, bounded body 1MB/25MB via stream, backup v2 {backupVersion:2, chat, studio} accepting legacy v1, one-handle transaction for Chat+Studio, wizard 4 steps with autosave and 409 handling. Deferred: Phases 2-6 (uploads, payments, repo generation, deploys). Tests: vitest + Playwright e2e with encrypted test session cookies, temp DBs, never .data.
