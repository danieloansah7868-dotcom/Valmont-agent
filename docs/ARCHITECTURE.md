# Valmont Agent architecture

## Goals

Valmont is an approval-first orchestration layer between an authorized GitHub repository, a model provider, and an isolated workspace. Its design keeps provider-specific code at the edges and makes unsafe capabilities absent rather than merely discouraged in prompts.

## Request flow

1. GitHub OAuth establishes a short-lived encrypted server session.
2. The user selects an authorized repository/base branch and submits a bounded task description.
3. `TaskWorkflowService` records `draft → planning` plus audit events.
4. Retrieval lists/searches/reads only filtered, bounded text. Model context is redacted.
5. A `ModelProvider` produces a structured plan; without credentials the deterministic planner is explicitly marked demo.
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
- capability/demo metadata

`OpenAICompatibleProvider` maps this contract to `/chat/completions`. API keys never enter React props, client bundles, API payloads, events, or the database. Anthropic/Gemini/self-hosted adapters can implement this interface without altering workflow state transitions.

### GitHub providers

`GitHubProvider` defines repository tree/file reads, bounded archive download, and branch/commit/PR writes. Planning retrieves ranked source directly through GitHub APIs. After plan approval, the authorized base-branch archive is filtered and copied into the generated workspace. `GitHubApiProvider`:

- validates owners, repositories, refs, and file paths;
- refuses non-`valmont/*` write branches;
- updates refs with `force: false`;
- has no merge, deployment, settings, or protected-branch method.

`DemoGitHubProvider` returns deterministic fictional data and is labelled throughout the UI.

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

`PostgresTaskStore` is selected automatically when `DATABASE_URL` is configured and enforces session ownership in every task query. It hydrates normalized event, approval, tool, and pull-request records. Raw repository content and prompts are not stored in these tables. Account token ciphertext is explicitly server-only. Demo mode uses `.data/demo-store.json`, atomic rename writes, and a process-local serialization queue.

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
